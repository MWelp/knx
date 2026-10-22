/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 *
 * A minimal simulated KNXnet/IP tunneling gateway on localhost, used to test
 * the connection state machine without real KNX hardware.
 * Outgoing (gateway -> client) packets are assembled byte by byte so the tests
 * do not depend on the protocol writer they are meant to exercise.
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const KnxProtocol = require('../../src/KnxProtocol.js');
const KnxConstants = require('../../src/KnxConstants.js');

const ST = KnxConstants.SERVICE_TYPE;

const header = (serviceType, body) => {
  const buf = Buffer.alloc(6 + body.length);
  buf.writeUInt8(0x06, 0);
  buf.writeUInt8(0x10, 1);
  buf.writeUInt16BE(serviceType, 2);
  buf.writeUInt16BE(buf.length, 4);
  body.copy(buf, 6);
  return buf;
};

// "1.2.3" -> 0x1203, "1/2/3" -> 0x0a03
const encodeAddress = (addr) => {
  if (addr.includes('/')) {
    const [main, middle, sub] = addr.split('/').map(Number);
    return (main << 11) | (middle << 8) | sub;
  }
  const [area, line, device] = addr.split('.').map(Number);
  return (area << 12) | (line << 8) | device;
};

// cEMI frame for a group telegram; apci: 0x00 read, 0x40 response, 0x80 write
const cemi = ({ msgcode, src, dest, apci, value }) => {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(msgcode, 0);
  buf.writeUInt8(0x00, 1); // no additional info
  buf.writeUInt8(0xbc, 2); // standard frame, no repeat, broadcast, low prio
  buf.writeUInt8(0xe0, 3); // group address, hop count 6
  buf.writeUInt16BE(encodeAddress(src), 4);
  buf.writeUInt16BE(encodeAddress(dest), 6);
  buf.writeUInt8(0x01, 8); // npdu length (6-bit value fits into the apci byte)
  buf.writeUInt8(0x00, 9);
  buf.writeUInt8(apci | ((value || 0) & 0x3f), 10);
  return buf;
};

class FakeGateway extends EventEmitter {
  constructor(options = {}) {
    super();
    this.channelId = options.channelId || 0x15;
    // behaviour switches, may be changed by the tests at any time
    this.connectStatus = 0x00;
    this.autoConnect = true;
    this.autoAckTunneling = true;
    this.ackDelay = 0;
    this.autoAnswerConnState = true;
    this.autoAnswerDisconnect = true;
    this.autoConfirm = false;
    this.readResponses = {}; // dest group address -> 6-bit value
    this.seqnumOut = 0;
    this.received = [];
    this.client = null;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
  }

  start() {
    return new Promise((resolve) => {
      this.socket.bind(0, '127.0.0.1', () => {
        this.port = this.socket.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    this.stopped = true;
    try {
      this.socket.close();
    } catch (e) {}
  }

  connectionOptions(extra) {
    return Object.assign(
      {
        ipAddr: '127.0.0.1',
        ipPort: this.port,
        manualConnect: true,
        loglevel: 'error',
      },
      extra
    );
  }

  // wait for the next packet of the given service type (by name)
  next(type, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('packet', listener);
        reject(new Error('timed out waiting for ' + type));
      }, timeout);
      const listener = (name, dg) => {
        if (name !== type) return;
        clearTimeout(timer);
        this.off('packet', listener);
        resolve(dg);
      };
      this.on('packet', listener);
    });
  }

  onMessage(msg, rinfo) {
    this.client = rinfo;
    const reader = KnxProtocol.createReader(msg);
    reader.KNXNetHeader('dg');
    const dg = reader.next().dg;
    const name = KnxConstants.keyText('SERVICE_TYPE', dg.service_type);
    dg.receivedAt = Date.now();
    this.received.push({ name, dg });
    this.emit('packet', name, dg);
    switch (dg.service_type) {
      case ST.CONNECT_REQUEST:
        if (this.autoConnect) this.sendConnectResponse(this.connectStatus);
        break;
      case ST.CONNECTIONSTATE_REQUEST:
        if (this.autoAnswerConnState) this.sendConnStateResponse(0x00);
        break;
      case ST.DISCONNECT_REQUEST:
        if (this.autoAnswerDisconnect) this.sendDisconnectResponse();
        break;
      case ST.TUNNELING_REQUEST:
        this.onTunnelingRequest(dg);
        break;
    }
  }

  onTunnelingRequest(dg) {
    const seqnum = dg.tunnstate.seqnum;
    const afterAck = () => {
      const apci = dg.cemi.apdu.apci;
      const dest = dg.cemi.dest_addr;
      if (this.autoConfirm) {
        this.sendTunnelingRequest({
          msgcode: KnxConstants.MESSAGECODES['L_Data.con'],
          src: '15.15.15',
          dest,
          apci: 0x80,
          value: 0,
        });
      }
      if (apci === 'GroupValue_Read' && dest in this.readResponses) {
        this.sendGroupValue('1.1.10', dest, 0x40, this.readResponses[dest]);
      }
    };
    if (!this.autoAckTunneling) return;
    setTimeout(() => {
      this.sendTunnelingAck(seqnum);
      afterAck();
    }, this.ackDelay);
  }

  send(buf) {
    // delayed replies may still fire after the test stopped the gateway
    if (this.stopped) return;
    this.socket.send(buf, this.client.port, this.client.address);
  }

  sendConnectResponse(status) {
    if (status !== 0x00) {
      this.send(header(ST.CONNECT_RESPONSE, Buffer.from([0x00, status])));
      return;
    }
    const body = Buffer.alloc(16);
    body.writeUInt8(this.channelId, 0);
    body.writeUInt8(status, 1);
    // data endpoint HPAI: UDP 127.0.0.1:<gateway port>
    Buffer.from([0x08, 0x01, 127, 0, 0, 1]).copy(body, 2);
    body.writeUInt16BE(this.port, 8);
    // CRD: tunnel connection, assigned individual address 1.1.250
    Buffer.from([0x04, 0x04]).copy(body, 10);
    body.writeUInt16BE(encodeAddress('1.1.250'), 12);
    this.send(header(ST.CONNECT_RESPONSE, body.subarray(0, 14)));
  }

  sendConnStateResponse(status, channelId = this.channelId) {
    this.send(
      header(ST.CONNECTIONSTATE_RESPONSE, Buffer.from([channelId, status]))
    );
  }

  sendDisconnectResponse() {
    this.send(
      header(ST.DISCONNECT_RESPONSE, Buffer.from([this.channelId, 0x00]))
    );
  }

  sendDisconnectRequest() {
    const body = Buffer.alloc(10);
    body.writeUInt8(this.channelId, 0);
    Buffer.from([0x08, 0x01, 127, 0, 0, 1]).copy(body, 2);
    body.writeUInt16BE(this.port, 8);
    this.send(header(ST.DISCONNECT_REQUEST, body));
  }

  sendTunnelingAck(seqnum, channelId = this.channelId) {
    this.send(
      header(ST.TUNNELING_ACK, Buffer.from([0x04, channelId, seqnum, 0x00]))
    );
  }

  sendTunnelingRequest(frame, channelId = this.channelId) {
    const seqnum = this.seqnumOut;
    this.seqnumOut = (this.seqnumOut + 1) & 0xff;
    const body = Buffer.concat([
      Buffer.from([0x04, channelId, seqnum, 0x00]),
      cemi(frame),
    ]);
    this.send(header(ST.TUNNELING_REQUEST, body));
    return seqnum;
  }

  // an L_Data.ind group telegram from the bus
  sendGroupValue(src, dest, apci, value, channelId) {
    return this.sendTunnelingRequest(
      {
        msgcode: KnxConstants.MESSAGECODES['L_Data.ind'],
        src,
        dest,
        apci,
        value,
      },
      channelId
    );
  }
}

FakeGateway.cemi = cemi;
FakeGateway.header = header;
FakeGateway.APCI = { READ: 0x00, RESPONSE: 0x40, WRITE: 0x80 };

module.exports = FakeGateway;
