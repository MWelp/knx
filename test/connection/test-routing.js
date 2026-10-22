/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 *
 * Routing connection over multicast on the local machine. A second UDP socket
 * joined to the KNX multicast group plays the part of the bus.
 * These tests describe the observable behaviour of the connection state
 * machine and must keep passing across a rewrite of src/FSM.js.
 */

const dgram = require('dgram');
const os = require('os');
const test = require('tape');
const KnxProtocol = require('../../src/KnxProtocol.js');
const KnxConstants = require('../../src/KnxConstants.js');
const { knx, FakeGateway, delay, once, record } = require('./harness.js');

const GROUP = '224.0.23.12';
const PORT = 3671;

// the "bus": a socket in the multicast group, collecting ROUTING_INDICATIONs
const startBus = (localAddress) =>
  new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const bus = { socket, received: [] };
    socket.on('message', (msg) => {
      const reader = KnxProtocol.createReader(msg);
      reader.KNXNetHeader('dg');
      const dg = reader.next().dg;
      dg.receivedAt = Date.now();
      bus.received.push(dg);
    });
    socket.bind(PORT, () => {
      // the connection joins the group on one interface but sends through
      // whatever the OS routes multicast to, so listen on all of them
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs) {
          if ([4, 'IPv4'].includes(addr.family) && !addr.internal) {
            try {
              socket.addMembership(GROUP, addr.address);
            } catch (e) {}
          }
        }
      }
      socket.setMulticastInterface(localAddress);
      resolve(bus);
    });
  });

const routingIndication = (src, dest, apci, value) =>
  FakeGateway.header(
    KnxConstants.SERVICE_TYPE.ROUTING_INDICATION,
    FakeGateway.cemi({
      msgcode: KnxConstants.MESSAGECODES['L_Data.ind'],
      src,
      dest,
      apci,
      value,
    })
  );

const waitFor = async (predicate, timeout = 2000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = predicate();
    if (found) return found;
    await delay(10);
  }
  throw new Error('timed out');
};

let conn, bus;

test('routing: connect', async (t) => {
  conn = knx.Connection({ manualConnect: true, loglevel: 'error' });
  const log = record(conn, ['connected', 'disconnected']);
  const ready = once(conn, 'connected');
  conn.Connect();
  await ready;
  t.notOk(conn.useTunneling, 'uses routing mode for a multicast address');
  t.deepEqual(
    log.map((e) => e.event),
    ['disconnected', 'connected'],
    "emits 'disconnected' on entering connecting, then 'connected'"
  );
  bus = await startBus(conn.localAddress);
});

test('routing: write sends a ROUTING_INDICATION', async (t) => {
  conn.write('1/2/3', 1, 'DPT1');
  const dg = await waitFor(() =>
    bus.received.find((d) => d.cemi.dest_addr === '1/2/3')
  );
  t.equal(
    dg.service_type,
    KnxConstants.SERVICE_TYPE.ROUTING_INDICATION,
    'is a ROUTING_INDICATION'
  );
  t.equal(
    dg.cemi.msgcode,
    KnxConstants.MESSAGECODES['L_Data.ind'],
    'carries an L_Data.ind'
  );
  t.equal(dg.cemi.apdu.apci, 'GroupValue_Write', 'is a GroupValue_Write');
  t.deepEqual([...dg.cemi.apdu.data], [1], 'carries the value');
});

test('routing: minimumDelay between outbound requests', async (t) => {
  const delayed = knx.Connection({
    manualConnect: true,
    loglevel: 'error',
    minimumDelay: 150,
  });
  const ready = once(delayed, 'connected');
  delayed.Connect();
  await ready;
  delayed.write('1/3/1', 1, 'DPT1');
  delayed.write('1/3/2', 1, 'DPT1');
  const first = await waitFor(() =>
    bus.received.find((d) => d.cemi.dest_addr === '1/3/1')
  );
  const second = await waitFor(() =>
    bus.received.find((d) => d.cemi.dest_addr === '1/3/2')
  );
  const gap = second.receivedAt - first.receivedAt;
  t.ok(gap >= 140, `keeps at least minimumDelay between requests (${gap}ms)`);
  delayed.socket.close();
});

test('routing: inbound ROUTING_INDICATION is emitted', async (t) => {
  const log = [];
  conn.on('event', (...args) => log.push(['event', ...args]));
  conn.on('GroupValue_Write', (...args) => log.push(['GroupValue_Write', ...args]));
  conn.on('event_4/5/6', (...args) => log.push(['event_4/5/6', ...args]));
  conn.on('GroupValue_Write_4/5/6', (...args) => log.push(['GroupValue_Write_4/5/6', ...args]));
  const emitted = once(conn, 'event');
  const msg = routingIndication('1.1.30', '4/5/6', FakeGateway.APCI.WRITE, 1);
  bus.socket.send(msg, PORT, GROUP);
  await emitted;
  const plain = log.map(([name, ...args]) => [
    name,
    ...args.map((a) => (Buffer.isBuffer(a) ? [...a] : a)),
  ]);
  t.deepEqual(
    plain,
    [
      ['event_4/5/6', 'GroupValue_Write', '1.1.30', [1]],
      ['GroupValue_Write_4/5/6', null, '1.1.30', [1]],
      ['GroupValue_Write', '1.1.30', '4/5/6', [1]],
      ['event', 'GroupValue_Write', '1.1.30', '4/5/6', [1]],
    ],
    'emits the four events in order, with multiple arguments'
  );
});

test('routing: read', async (t) => {
  const result = new Promise((resolve) =>
    conn.read({ ga: '4/5/7' }, (...args) => resolve(args))
  );
  await waitFor(() => bus.received.find((d) => d.cemi.dest_addr === '4/5/7'));
  bus.socket.send(
    routingIndication('1.1.31', '4/5/7', FakeGateway.APCI.RESPONSE, 1),
    PORT,
    GROUP
  );
  const [err, src, data] = await result;
  t.equal(err, null, 'no error');
  t.equal(src, '1.1.31', 'passes the source address');
  t.deepEqual([...data], [1], 'passes the response value');
});

test('routing: Disconnect', async (t) => {
  const disconnected = once(conn, 'disconnected');
  const called = await Promise.race([
    new Promise((resolve) => conn.Disconnect(() => resolve(true))),
    delay(1000).then(() => false),
  ]);
  t.ok(called, 'calls the Disconnect callback');
  await disconnected;
  t.pass("emits 'disconnected'");
  t.equal(conn.state, 'uninitialized', 'is uninitialized afterwards');
  t.throws(() => conn.socket.address(), 'closes the socket');
  t.equal(
    bus.received.filter(
      (d) => d.service_type === KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST
    ).length,
    0,
    'sends no DISCONNECT_REQUEST'
  );
  bus.socket.close();
});
