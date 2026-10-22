/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 *
 * The event API of a connection (on/off/emit as provided by machina 4).
 * These tests pin it down so it stays compatible across a rewrite.
 */

const test = require('tape');
const {
  knx,
  delay,
  once,
  connected,
  close,
  forceState,
} = require('./harness.js');

const newConnection = () =>
  knx.Connection({ manualConnect: true, loglevel: 'error' });

test('events: emit passes multiple arguments', (t) => {
  const conn = newConnection();
  conn.on('custom', (...args) => {
    t.deepEqual(args, [1, 'two', { three: 3 }], 'passes all arguments');
    t.end();
  });
  conn.emit('custom', 1, 'two', { three: 3 });
});

test('events: on returns a subscription with off()', (t) => {
  const conn = newConnection();
  let calls = 0;
  const callback = () => calls++;
  const subscription = conn.on('custom', callback);
  t.equal(subscription.eventName, 'custom', 'has the event name');
  t.equal(subscription.callback, callback, 'has the callback');
  conn.emit('custom');
  subscription.off();
  conn.emit('custom');
  t.equal(calls, 1, 'off() unsubscribes');
  t.end();
});

test('events: off(eventName, callback) removes one listener', (t) => {
  const conn = newConnection();
  const calls = [];
  const a = () => calls.push('a');
  const b = () => calls.push('b');
  conn.on('custom', a);
  conn.on('custom', b);
  conn.off('custom', a);
  conn.emit('custom');
  t.deepEqual(calls, ['b'], 'only the given listener is removed');
  t.end();
});

test('events: off(eventName) removes all listeners of that event', (t) => {
  const conn = newConnection();
  const calls = [];
  conn.on('custom', () => calls.push('a'));
  conn.on('custom', () => calls.push('b'));
  conn.on('other', () => calls.push('other'));
  conn.off('custom');
  conn.emit('custom');
  conn.emit('other');
  t.deepEqual(calls, ['other'], 'other events are kept');
  t.end();
});

test('events: off() removes all listeners', (t) => {
  const conn = newConnection();
  const calls = [];
  conn.on('custom', () => calls.push('custom'));
  conn.on('other', () => calls.push('other'));
  conn.off();
  conn.emit('custom');
  conn.emit('other');
  t.deepEqual(calls, [], 'nothing is called');
  t.end();
});

test("events: '*' receives every event with its name first", (t) => {
  const conn = newConnection();
  const calls = [];
  conn.on('*', (...args) => calls.push(['*', ...args]));
  conn.on('custom', (...args) => calls.push(['custom', ...args]));
  conn.emit('custom', 1, 2);
  t.deepEqual(
    calls,
    [
      ['*', 'custom', 1, 2],
      ['custom', 1, 2],
    ],
    "'*' is called first, with the event name"
  );
  t.end();
});

test("events: 'error' without listener does not throw", (t) => {
  const conn = newConnection();
  t.doesNotThrow(() => conn.emit('error', 'boom'), 'is ignored');
  t.end();
});

test('events: many listeners do not trigger a warning', async (t) => {
  const conn = newConnection();
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  for (let i = 0; i < 50; i++) conn.on('connected', () => {});
  await delay(50);
  process.off('warning', onWarning);
  t.deepEqual(warnings, [], 'no MaxListenersExceededWarning');
});

test("events: 'transition' and 'transitioned' with fromState/toState", async (t) => {
  const { gw, conn } = await connected();
  const transitions = [];
  conn.on('transition', (data) =>
    transitions.push(['transition', data.fromState, data.toState])
  );
  conn.on('transitioned', (data) =>
    transitions.push(['transitioned', data.fromState, data.toState])
  );
  conn.write('1/2/3', 1, 'DPT1');
  await gw.next('TUNNELING_REQUEST');
  await delay(50);
  t.deepEqual(
    transitions,
    [
      ['transition', 'idle', 'sendDatagram'],
      ['transitioned', 'idle', 'sendDatagram'],
      ['transition', 'sendDatagram', 'sendTunnReq_waitACK'],
      ['transitioned', 'sendDatagram', 'sendTunnReq_waitACK'],
      ['transition', 'sendTunnReq_waitACK', 'idle'],
      ['transitioned', 'sendTunnReq_waitACK', 'idle'],
    ],
    'emits the state machine transitions'
  );
  close(gw, conn);
});

test('options are exposed as properties', (t) => {
  const conn = knx.Connection({
    manualConnect: true,
    loglevel: 'error',
    debug: true,
    minimumDelay: 50,
  });
  t.equal(conn.debug, true, 'debug');
  t.equal(conn.minimumDelay, 50, 'minimumDelay');
  t.equal(conn.options.minimumDelay, 50, 'and in options');
  t.end();
});

test('events: state reflects the current state', async (t) => {
  const conn = newConnection();
  t.equal(conn.state, 'uninitialized', 'starts uninitialized');
  const { gw, conn: live } = await connected();
  t.equal(live.state, 'idle', 'is idle once connected');
  close(gw, live);
});

test("events: 'error' from the state machine reaches listeners", async (t) => {
  const { gw, conn } = await connected();
  gw.autoAnswerConnState = false;
  const error = once(conn, 'error');
  forceState(conn, 'requestingConnState');
  const [msg] = await error;
  t.equal(msg, 'timed out waiting for CONNECTIONSTATE_RESPONSE', 'is delivered');
  close(gw, conn);
});

test("events: 'error' from the state machine without listener does not crash", async (t) => {
  const { gw, conn } = await connected();
  gw.autoAnswerConnState = false;
  forceState(conn, 'requestingConnState');
  await gw.next('CONNECT_REQUEST', 3000);
  t.pass('reconnects instead of crashing');
  close(gw, conn);
});
