/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 *
 * Shared helpers for the connection state machine tests.
 */

const test = require('tape');
const knx = require('../..');
const FakeGateway = require('./fake-gateway.js');

// connections keep timers (reconnect, idle) alive, so end the process once
// all tests ran - with a non-zero exit code if any of them failed
let failed = false;
test.onFailure(() => {
  failed = true;
});
test.onFinish(() => process.exit(failed ? 1 : 0));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// resolve with the arguments of the next emission of `event`
// (only on/off: the connection has no once() today)
const once = (emitter, event, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const listener = (...args) => {
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(args);
    };
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error('timed out waiting for event ' + event));
    }, timeout);
    emitter.on(event, listener);
  });

// record every emission of the given events, in order
const record = (conn, events) => {
  const log = [];
  for (const event of events) {
    conn.on(event, (...args) => log.push({ event, args }));
  }
  return log;
};

// start a fake gateway and a connection to it; resolves once connected
const connected = async (gatewaySetup, connOptions) => {
  const gw = await new FakeGateway().start();
  if (gatewaySetup) gatewaySetup(gw);
  const conn = knx.Connection(gw.connectionOptions(connOptions));
  const ready = once(conn, 'connected');
  conn.Connect();
  await ready;
  return { gw, conn };
};

const close = (gw, conn) => {
  try {
    conn.socket.close();
  } catch (e) {}
  gw.stop();
};

// The only place where the tests reach into the state machine directly:
// the idle timeout before a connection state check is 60s, too long to wait.
const forceState = (conn, state) => conn.transition(state);

module.exports = {
  knx,
  FakeGateway,
  delay,
  once,
  record,
  connected,
  close,
  forceState,
};
