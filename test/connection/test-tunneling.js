/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 *
 * Tunneling connection against a simulated KNXnet/IP gateway on localhost.
 * These tests describe the observable behaviour of the connection state
 * machine and must keep passing across a rewrite of src/FSM.js.
 */

const test = require('tape');
const {
  knx,
  FakeGateway,
  delay,
  once,
  record,
  connected,
  close,
  forceState,
} = require('./harness.js');

const { APCI } = FakeGateway;

test('tunneling: connect handshake', async (t) => {
  const gw = await new FakeGateway().start();
  const conn = knx.Connection(gw.connectionOptions());
  const log = record(conn, ['connected', 'disconnected']);
  const ready = once(conn, 'connected');
  conn.Connect();
  await ready;
  t.deepEqual(
    gw.received.map((p) => p.name),
    ['CONNECT_REQUEST', 'CONNECTIONSTATE_REQUEST'],
    'sends CONNECT_REQUEST, then CONNECTIONSTATE_REQUEST'
  );
  t.equal(
    gw.received[1].dg.connstate.channel_id,
    gw.channelId,
    'uses the channel id assigned by the gateway'
  );
  t.deepEqual(
    log.map((e) => e.event),
    ['disconnected', 'connected'],
    "emits 'disconnected' on entering connecting, then 'connected'"
  );
  t.ok(conn.conntime > 0, 'sets conntime once connected');
  close(gw, conn);
});

test('tunneling: options.handlers are registered as event listeners', async (t) => {
  const gw = await new FakeGateway().start();
  await new Promise((resolve) => {
    const conn = knx.Connection(
      gw.connectionOptions({
        manualConnect: false,
        handlers: {
          connected() {
            t.pass("handlers.connected called");
            close(gw, conn);
            resolve();
          },
        },
      })
    );
  });
});

test('tunneling: retries CONNECT_REQUEST when the gateway does not answer', async (t) => {
  const gw = await new FakeGateway().start();
  gw.autoConnect = false;
  const conn = knx.Connection(gw.connectionOptions());
  conn.Connect();
  const first = await gw.next('CONNECT_REQUEST');
  const second = await gw.next('CONNECT_REQUEST', 4000);
  const gap = second.receivedAt - first.receivedAt;
  t.ok(gap >= 2500 && gap < 4000, `retries after ~3s (${gap}ms)`);
  close(gw, conn);
});

test('tunneling: E_NO_MORE_CONNECTIONS', async (t) => {
  const gw = await new FakeGateway().start();
  gw.connectStatus = 0x24; // E_NO_MORE_CONNECTIONS
  const conn = knx.Connection(gw.connectionOptions());
  const log = record(conn, ['connected', 'disconnected']);
  conn.Connect();
  await gw.next('CONNECT_REQUEST');
  await delay(300);
  t.deepEqual(
    log.map((e) => e.event),
    ['disconnected', 'disconnected'],
    "emits 'disconnected' again and does not connect"
  );
  t.equal(
    gw.received.filter((p) => p.name === 'CONNECTIONSTATE_REQUEST').length,
    0,
    'sends no CONNECTIONSTATE_REQUEST'
  );
  gw.stop();
});

test('tunneling: write sends a TUNNELING_REQUEST', async (t) => {
  const { gw, conn } = await connected();
  let callbackCalled = false;
  conn.write('1/2/3', 1, 'DPT1', () => (callbackCalled = true));
  const dg = await gw.next('TUNNELING_REQUEST');
  t.ok(callbackCalled, 'calls the write callback');
  t.equal(dg.tunnstate.channel_id, gw.channelId, 'uses the channel id');
  t.equal(dg.tunnstate.seqnum, 0, 'first request has seqnum 0');
  t.equal(dg.cemi.apdu.apci, 'GroupValue_Write', 'is a GroupValue_Write');
  t.equal(dg.cemi.dest_addr, '1/2/3', 'targets the group address');
  t.deepEqual([...dg.cemi.apdu.data], [1], 'carries the value');
  close(gw, conn);
});

test('tunneling: writeRaw and respond', async (t) => {
  const { gw, conn } = await connected();
  conn.writeRaw('1/2/5', Buffer.from([0x12, 0x34]));
  const raw = await gw.next('TUNNELING_REQUEST');
  t.equal(raw.cemi.dest_addr, '1/2/5', 'writeRaw targets the group address');
  t.deepEqual([...raw.cemi.apdu.data], [0x12, 0x34], 'writeRaw sends the raw bytes');
  conn.respond('1/2/6', 0, 'DPT1');
  const response = await gw.next('TUNNELING_REQUEST');
  t.equal(response.cemi.apdu.apci, 'GroupValue_Response', 'respond sends a GroupValue_Response');
  t.equal(response.tunnstate.seqnum, 1, 'seqnum is incremented');
  close(gw, conn);
});

test('tunneling: outbound requests are sent one at a time', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.ackDelay = 100));
  conn.write('1/1/1', 1, 'DPT1');
  conn.write('1/1/2', 1, 'DPT1');
  conn.write('1/1/3', 1, 'DPT1');
  const requests = [];
  for (let i = 0; i < 3; i++) requests.push(await gw.next('TUNNELING_REQUEST'));
  t.deepEqual(
    requests.map((dg) => dg.cemi.dest_addr),
    ['1/1/1', '1/1/2', '1/1/3'],
    'keeps the order'
  );
  t.deepEqual(
    requests.map((dg) => dg.tunnstate.seqnum),
    [0, 1, 2],
    'increments the seqnum'
  );
  const gaps = [1, 2].map((i) => requests[i].receivedAt - requests[i - 1].receivedAt);
  t.ok(
    gaps.every((gap) => gap >= 90),
    `waits for the TUNNELING_ACK before the next request (${gaps.join('ms, ')}ms)`
  );
  close(gw, conn);
});

test('tunneling: missing TUNNELING_ACK', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.autoAckTunneling = false));
  const failed = once(conn, 'tunnelreqfailed', 4000);
  conn.write('1/2/3', 1, 'DPT1');
  const sent = await gw.next('TUNNELING_REQUEST');
  const [dg] = await failed;
  const elapsed = Date.now() - sent.receivedAt;
  t.ok(elapsed >= 1900, `emits 'tunnelreqfailed' after ~2s (${elapsed}ms)`);
  t.equal(dg.cemi.dest_addr, '1/2/3', 'passes the failed datagram');
  gw.autoAckTunneling = true;
  conn.write('1/2/4', 1, 'DPT1');
  const next = await gw.next('TUNNELING_REQUEST');
  t.equal(next.cemi.dest_addr, '1/2/4', 'later requests are still sent');
  t.equal(next.tunnstate.seqnum, 1, 'seqnum is not reused');
  close(gw, conn);
});

test('tunneling: read', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.readResponses['1/2/4'] = 1));
  const result = new Promise((resolve) =>
    conn.read({ ga: '1/2/4' }, (...args) => resolve(args))
  );
  const request = await gw.next('TUNNELING_REQUEST');
  t.equal(request.cemi.apdu.apci, 'GroupValue_Read', 'sends a GroupValue_Read');
  t.equal(request.cemi.dest_addr, '1/2/4', 'targets the group address');
  const [err, src, data] = await result;
  t.equal(err, null, 'no error');
  t.equal(src, '1.1.10', 'passes the source address');
  t.deepEqual([...data], [1], 'passes the response value');
  close(gw, conn);
});

test('tunneling: read timeout', async (t) => {
  const { gw, conn } = await connected();
  const started = Date.now();
  const [err, src, data] = await new Promise((resolve) =>
    conn.read({ ga: '1/2/4', readReqTimeout: 200 }, (...args) => resolve(args))
  );
  const elapsed = Date.now() - started;
  t.ok(err instanceof Error, 'passes an error');
  t.ok(elapsed >= 190 && elapsed < 1000, `honours readReqTimeout (${elapsed}ms)`);
  t.equal(src, null, 'no source address');
  t.equal(data, null, 'no data');
  close(gw, conn);
});

test('tunneling: inbound L_Data.ind is acknowledged and emitted', async (t) => {
  const { gw, conn } = await connected();
  const log = [];
  conn.on('event', (...args) => log.push(['event', ...args]));
  conn.on('GroupValue_Write', (...args) => log.push(['GroupValue_Write', ...args]));
  conn.on('event_2/3/4', (...args) => log.push(['event_2/3/4', ...args]));
  conn.on('GroupValue_Write_2/3/4', (...args) => log.push(['GroupValue_Write_2/3/4', ...args]));
  const emitted = once(conn, 'event');
  gw.seqnumOut = 7;
  gw.sendGroupValue('1.1.20', '2/3/4', APCI.WRITE, 1);
  const ack = await gw.next('TUNNELING_ACK');
  await emitted;
  t.equal(ack.tunnstate.seqnum, 7, 'acknowledges with the inbound seqnum');
  t.equal(ack.tunnstate.channel_id, gw.channelId, 'acknowledges on the channel');
  const plain = log.map(([name, ...args]) => [
    name,
    ...args.map((a) => (Buffer.isBuffer(a) ? [...a] : a)),
  ]);
  t.deepEqual(
    plain,
    [
      ['event_2/3/4', 'GroupValue_Write', '1.1.20', [1]],
      ['GroupValue_Write_2/3/4', null, '1.1.20', [1]],
      ['GroupValue_Write', '1.1.20', '2/3/4', [1]],
      ['event', 'GroupValue_Write', '1.1.20', '2/3/4', [1]],
    ],
    'emits the four events in order, with multiple arguments'
  );
  close(gw, conn);
});

test('tunneling: a burst of inbound telegrams while waiting for an ACK', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.autoAckTunneling = false));
  const count = 30;
  const received = [];
  conn.on('event', (evt, src, dest) => received.push(dest));
  conn.write('1/2/3', 1, 'DPT1');
  const request = await gw.next('TUNNELING_REQUEST');
  for (let i = 0; i < count; i++) {
    gw.sendGroupValue('1.1.20', `3/0/${i}`, APCI.WRITE, 1);
  }
  await delay(100);
  t.equal(received.length, 0, 'holds them back until the ACK arrives');
  gw.sendTunnelingAck(request.tunnstate.seqnum);
  await delay(300);
  t.deepEqual(
    received,
    Array.from({ length: count }, (_, i) => `3/0/${i}`),
    'then emits all of them, in order'
  );
  t.equal(
    gw.received.filter((p) => p.name === 'TUNNELING_ACK').length,
    count,
    'and acknowledges each one'
  );
  close(gw, conn);
});

test('tunneling: telegrams for another channel are ignored', async (t) => {
  const { gw, conn } = await connected();
  let events = 0;
  conn.on('event', () => events++);
  gw.sendGroupValue('1.1.20', '2/3/4', APCI.WRITE, 1, gw.channelId + 1);
  await delay(200);
  t.equal(events, 0, 'emits no event');
  t.equal(
    gw.received.filter((p) => p.name === 'TUNNELING_ACK').length,
    0,
    'sends no TUNNELING_ACK'
  );
  close(gw, conn);
});

test("tunneling: L_Data.con emits 'confirmed'", async (t) => {
  const { gw, conn } = await connected((gw) => (gw.autoConfirm = true));
  const confirmed = once(conn, 'confirmed');
  conn.write('1/2/3', 1, 'DPT1');
  const [dg] = await confirmed;
  t.equal(dg.cemi.dest_addr, '1/2/3', 'passes the sent datagram');
  const ack = await gw.next('TUNNELING_ACK');
  t.equal(ack.tunnstate.seqnum, 0, 'acknowledges the L_Data.con');
  close(gw, conn);
});

test('tunneling: localEchoInTunneling', async (t) => {
  const { gw, conn } = await connected(null, { localEchoInTunneling: true });
  const echoed = once(conn, 'event');
  conn.write('1/2/3', 1, 'DPT1');
  const [evt, src, dest, data] = await echoed;
  t.equal(evt, 'GroupValue_Write', 'echoes the sent telegram');
  t.equal(src, '15.15.15', 'with the own physical address as source');
  t.equal(dest, '1/2/3', 'with the destination');
  t.deepEqual([...data], [1], 'with the value');
  close(gw, conn);
});

test('tunneling: minimumDelay between outbound requests', async (t) => {
  const { gw, conn } = await connected(null, { minimumDelay: 150 });
  conn.write('1/1/1', 1, 'DPT1');
  conn.write('1/1/2', 1, 'DPT1');
  const first = await gw.next('TUNNELING_REQUEST');
  const second = await gw.next('TUNNELING_REQUEST');
  const gap = second.receivedAt - first.receivedAt;
  t.ok(gap >= 140, `keeps at least minimumDelay between requests (${gap}ms)`);
  t.equal(second.cemi.dest_addr, '1/1/2', 'sends the second request');
  close(gw, conn);
});

test('tunneling: requests issued while connecting are sent once connected', async (t) => {
  const gw = await new FakeGateway().start();
  gw.autoConnect = false;
  const conn = knx.Connection(gw.connectionOptions());
  conn.Connect();
  await gw.next('CONNECT_REQUEST');
  conn.write('1/2/3', 1, 'DPT1');
  await delay(100);
  t.equal(
    gw.received.filter((p) => p.name === 'TUNNELING_REQUEST').length,
    0,
    'holds the request back'
  );
  gw.sendConnectResponse(0x00);
  const dg = await gw.next('TUNNELING_REQUEST');
  t.equal(dg.cemi.dest_addr, '1/2/3', 'sends it after connecting');
  close(gw, conn);
});

test('tunneling: Disconnect', async (t) => {
  const { gw, conn } = await connected();
  const disconnected = once(conn, 'disconnected');
  await new Promise((resolve) => conn.Disconnect(resolve));
  t.pass('calls the Disconnect callback');
  await disconnected;
  t.pass("emits 'disconnected'");
  const request = gw.received.find((p) => p.name === 'DISCONNECT_REQUEST');
  t.ok(request, 'sends a DISCONNECT_REQUEST');
  t.equal(request.dg.connstate.channel_id, gw.channelId, 'for the channel');
  gw.stop();
});

test('tunneling: Connect again after Disconnect', async (t) => {
  const { gw, conn } = await connected();
  let firstCallback = 0;
  await new Promise((resolve) =>
    conn.Disconnect(() => {
      firstCallback++;
      resolve();
    })
  );
  const reconnected = once(conn, 'connected');
  conn.Connect();
  await reconnected;
  await delay(300);
  t.equal(conn.state, 'idle', 'stays connected');
  t.equal(
    gw.received.filter((p) => p.name === 'DISCONNECT_REQUEST').length,
    1,
    'sends no further DISCONNECT_REQUEST'
  );
  await new Promise((resolve) => conn.Disconnect(resolve));
  t.equal(firstCallback, 1, 'an earlier Disconnect callback is not called again');
  gw.stop();
});

test('tunneling: Connect again after a Disconnect issued while busy', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.ackDelay = 100));
  conn.write('1/2/3', 1, 'DPT1');
  await gw.next('TUNNELING_REQUEST');
  // still waiting for the TUNNELING_ACK
  await new Promise((resolve) => conn.Disconnect(resolve));
  t.pass('disconnects once idle');
  const reconnected = once(conn, 'connected');
  conn.Connect();
  await reconnected;
  await delay(300);
  t.equal(conn.state, 'idle', 'stays connected');
  t.equal(
    gw.received.filter((p) => p.name === 'DISCONNECT_REQUEST').length,
    1,
    'sends no further DISCONNECT_REQUEST'
  );
  close(gw, conn);
});

test('tunneling: Disconnect without DISCONNECT_RESPONSE', async (t) => {
  const { gw, conn } = await connected((gw) => (gw.autoAnswerDisconnect = false));
  const started = Date.now();
  await new Promise((resolve) => conn.Disconnect(resolve));
  const elapsed = Date.now() - started;
  t.ok(elapsed >= 2900, `gives up after ~3s (${elapsed}ms)`);
  gw.stop();
});

test('tunneling: Disconnect while connecting', async (t) => {
  const gw = await new FakeGateway().start();
  gw.autoConnect = false;
  const conn = knx.Connection(gw.connectionOptions());
  conn.Connect();
  await gw.next('CONNECT_REQUEST');
  await new Promise((resolve) => conn.Disconnect(resolve));
  t.pass('calls the Disconnect callback right away');
  t.equal(
    gw.received.filter((p) => p.name === 'DISCONNECT_REQUEST').length,
    0,
    'sends no DISCONNECT_REQUEST'
  );
  close(gw, conn);
});

test('tunneling: DISCONNECT_REQUEST from the gateway triggers a reconnect', async (t) => {
  const { gw, conn } = await connected();
  const log = record(conn, ['connected', 'disconnected']);
  const reconnected = once(conn, 'connected');
  gw.sendDisconnectRequest();
  await gw.next('CONNECT_REQUEST');
  await reconnected;
  t.deepEqual(
    log.map((e) => e.event),
    ['disconnected', 'connected'],
    "emits 'disconnected', then 'connected'"
  );
  close(gw, conn);
});

test('tunneling: connection state check', async (t) => {
  const { gw, conn } = await connected();
  const log = record(conn, ['error', 'disconnected']);
  forceState(conn, 'requestingConnState');
  const request = await gw.next('CONNECTIONSTATE_REQUEST');
  t.equal(request.connstate.channel_id, gw.channelId, 'asks for the channel state');
  await delay(1200);
  t.deepEqual(log, [], 'stays connected when the gateway answers');
  conn.write('1/2/3', 1, 'DPT1');
  const dg = await gw.next('TUNNELING_REQUEST');
  t.equal(dg.cemi.dest_addr, '1/2/3', 'requests are still sent');
  close(gw, conn);
});

test('tunneling: connection state check without response', async (t) => {
  const { gw, conn } = await connected();
  gw.autoAnswerConnState = false;
  const error = once(conn, 'error');
  forceState(conn, 'requestingConnState');
  const [msg] = await error;
  t.equal(msg, 'timed out waiting for CONNECTIONSTATE_RESPONSE', "emits 'error'");
  gw.autoAnswerConnState = true;
  await gw.next('CONNECT_REQUEST');
  await once(conn, 'connected');
  t.pass('reconnects');
  close(gw, conn);
});

test('tunneling: connection state check with error status', async (t) => {
  const { gw, conn } = await connected();
  gw.autoAnswerConnState = false;
  const error = once(conn, 'error');
  forceState(conn, 'requestingConnState');
  await gw.next('CONNECTIONSTATE_REQUEST');
  gw.sendConnStateResponse(0x21); // E_CONNECTION_ID
  const [msg] = await error;
  t.equal(msg, 'E_CONNECTION_ID', "emits 'error' with the status name");
  gw.autoAnswerConnState = true;
  await gw.next('CONNECT_REQUEST');
  await once(conn, 'connected');
  t.pass('reconnects');
  close(gw, conn);
});
