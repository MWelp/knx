/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 */

const util = require('util');
const { createFsm } = require('machina');
const KnxConstants = require('./KnxConstants.js');
const KnxLog = require('./KnxLog.js');

/*
 * The connection state machine. It only holds the states; all connection
 * data and helpers live on the connection object, which every handler
 * receives as `ctx` (the machine itself is `ctx.fsm`).
 *
 * Inputs a state cannot handle yet are deferred until the machine is idle
 * again. The queue lives on the connection (ctx.deferredInputs) instead of
 * machina's own, because it must be cleared on a DISCONNECT_REQUEST and
 * replayed without nesting one transition per input (machina limits nested
 * transitions to 20).
 */

// enter a state that needs the datagram which led to it
const transitionWith = (ctx, state, datagram) => {
  ctx.fsmDatagram = datagram;
  ctx.fsm.transition(state);
};

const deferUntilIdle = (ctx, inputName, args) => {
  ctx.deferredInputs.push({ inputName, args });
};

const processQueue = (ctx) => {
  // replaying an input may pass through idle again (e.g. via
  // recvTunnReqIndication); the outer loop picks up the rest
  if (ctx.processingQueue) return;
  ctx.processingQueue = true;
  try {
    while (ctx.deferredInputs.length > 0 && ctx.fsm.currentState() === 'idle') {
      const { inputName, args } = ctx.deferredInputs.shift();
      ctx.fsm.handle(inputName, ...args);
    }
  } finally {
    ctx.processingQueue = false;
  }
};

const createKnxFsm = (connection) =>
  createFsm({
    id: 'knxnet',

    initialState: 'uninitialized',

    context: connection,

    states: {
      uninitialized: {
        ['*']({ ctx }) {
          ctx.fsm.transition('connecting');
        },
      },

      jumptoconnecting: {
        _onEnter({ ctx }) {
          ctx.fsm.transition('connecting');
        },
      },

      connecting: {
        _onEnter({ ctx }) {
          // tell listeners that we disconnected
          // putting this here will result in a correct state for our listeners
          ctx.emit('disconnected');
          ctx.log.debug(util.format('useTunneling=%j', ctx.useTunneling));
          if (ctx.useTunneling) {
            let connection_attempts = 0;
            if (!ctx.localAddress)
              throw 'Not bound to an IPv4 non-loopback interface';
            ctx.log.debug(util.format('Connecting via %s...', ctx.localAddress));
            // we retry 3 times, then restart the whole cycle using a slower and slower rate (max delay is 5 minutes)
            ctx.connecttimer = setInterval(() => {
              connection_attempts += 1;
              if (connection_attempts >= 3) {
                clearInterval(ctx.connecttimer);
                // quite a few KNXnet/IP devices drop any tunneling packets received via multicast
                if (ctx.remoteEndpoint.addr.range() == 'multicast') {
                  ctx.log.warn(
                    'connection timed out, falling back to pure routing mode...'
                  );
                  ctx.usingMulticastTunneling = true;
                  ctx.fsm.transition('connected');
                } else {
                  // we restart the connection cycle with a growing delay (max 5 minutes)
                  ctx.reconnection_cycles += 1;
                  const delay = Math.min(ctx.reconnection_cycles * 3, 300);
                  ctx.log.debug(
                    'reattempting connection in ' + delay + ' seconds'
                  );
                  setTimeout(
                    // restart connecting cycle (cannot jump straight to 'connecting' so we use an intermediate state)
                    () => ctx.fsm.transition('jumptoconnecting'),
                    delay * 1000
                  );
                }
              } else {
                ctx.log.warn('connection timed out, retrying...');
                ctx.send(
                  ctx.prepareDatagram(KnxConstants.SERVICE_TYPE.CONNECT_REQUEST)
                );
              }
            }, 3000);
            delete ctx.channel_id;
            delete ctx.conntime;
            delete ctx.lastSentTime;
            // send connect request directly
            ctx.send(
              ctx.prepareDatagram(KnxConstants.SERVICE_TYPE.CONNECT_REQUEST)
            );
          } else {
            // no connection sequence needed in pure multicast routing
            ctx.fsm.transition('connected');
          }
        },
        _onExit({ ctx }) {
          clearInterval(ctx.connecttimer);
        },
        inbound_CONNECT_RESPONSE({ ctx }, datagram) {
          ctx.log.debug(util.format('got connect response'));
          if (
            datagram.hasOwnProperty('connstate') &&
            datagram.connstate.status ===
              KnxConstants.RESPONSECODE.E_NO_MORE_CONNECTIONS
          ) {
            try {
              ctx.socket.close();
            } catch (error) {}
            ctx.fsm.transition('uninitialized');
            ctx.emit('disconnected');
            ctx.log.debug(
              'The KNXnet/IP server rejected the data connection (Maximum connections reached). Waiting 1 minute before retrying...'
            );
            setTimeout(() => {
              ctx.Connect();
            }, 60000);
          } else {
            // store channel ID into the Connection object
            ctx.channel_id = datagram.connstate.channel_id;
            // send connectionstate request directly
            ctx.send(
              ctx.prepareDatagram(
                KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST
              )
            );
            // TODO: handle send err
          }
        },
        inbound_CONNECTIONSTATE_RESPONSE({ ctx }, datagram) {
          if (ctx.useTunneling) {
            const str = KnxConstants.keyText(
              'RESPONSECODE',
              datagram.connstate.status
            );
            ctx.log.debug(
              util.format(
                'Got connection state response, connstate: %s, channel ID: %d',
                str,
                datagram.connstate.channel_id
              )
            );
            ctx.fsm.transition('connected');
          }
        },
        ['*']({ ctx, inputName }, ...args) {
          ctx.log.debug(
            util.format('*** deferring %s until transition to idle', inputName)
          );
          deferUntilIdle(ctx, inputName, args);
        },
      },

      connected: {
        _onEnter({ ctx }) {
          // Reset connection reattempts cycle counter for next disconnect
          ctx.reconnection_cycles = 0;
          // Reset outgoing sequence counter..
          ctx.seqnum = -1;
          /* important note: the sequence counter is SEPARATE for incoming and
            outgoing datagrams. We only keep track of the OUTGOING L_Data.req
            and we simply acknowledge the incoming datagrams with their own seqnum */
          ctx.lastSentTime = ctx.conntime = Date.now();
          ctx.log.debug(
            util.format(
              '--- Connected in %s mode ---',
              ctx.useTunneling ? 'TUNNELING' : 'ROUTING'
            )
          );
          ctx.fsm.transition('idle');
          ctx.emit('connected');
        },
      },

      disconnecting: {
        // TODO: skip on pure routing
        _onEnter({ ctx }) {
          if (ctx.useTunneling) {
            const aliveFor = ctx.conntime ? Date.now() - ctx.conntime : 0;
            KnxLog.get().debug(
              '(%s):\tconnection alive for %d seconds',
              ctx.fsm.compositeState(),
              aliveFor / 1000
            );
            ctx.disconnecttimer = setTimeout(() => {
              KnxLog.get().debug(
                '(%s):\tconnection timed out',
                ctx.fsm.compositeState()
              );
              try {
                ctx.socket.close();
              } catch (error) {}
              ctx.fsm.transition('uninitialized');
              ctx.emit('disconnected');
            }, 3000);
            //
            ctx.send(
              ctx.prepareDatagram(KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST),
              (err) => {
                // TODO: handle send err
                KnxLog.get().debug(
                  '(%s):\tsent DISCONNECT_REQUEST',
                  ctx.fsm.compositeState()
                );
              }
            );
          }
        },
        _onExit({ ctx }) {
          clearTimeout(ctx.disconnecttimer);
        },
        inbound_DISCONNECT_RESPONSE({ ctx }, datagram) {
          if (ctx.useTunneling) {
            KnxLog.get().debug(
              '(%s):\tgot disconnect response',
              ctx.fsm.compositeState()
            );
            try {
              ctx.socket.close();
            } catch (error) {}
            ctx.fsm.transition('uninitialized');
            ctx.emit('disconnected');
          }
        },
      },

      idle: {
        _onEnter({ ctx }) {
          if (ctx.useTunneling) {
            if (ctx.idletimer == null) {
              // set one
              // time out on inactivity...
              ctx.idletimer = setTimeout(() => {
                ctx.fsm.transition('requestingConnState');
                clearTimeout(ctx.idletimer);
                ctx.idletimer = null;
              }, 60000);
            }
          }
          // debuglog the current FSM state plus a custom message
          KnxLog.get().debug('(%s):\t%s', ctx.fsm.compositeState(), ' zzzz...');
          // process any deferred items from the FSM internal queue
          processQueue(ctx);
        },
        // while idle we can either...

        // 1) queue an OUTGOING routing indication...
        outbound_ROUTING_INDICATION({ ctx }, datagram) {
          const elapsed = Date.now() - ctx.lastSentTime;
          // if no miminum delay set OR the last sent datagram was long ago...
          if (
            !ctx.options.minimumDelay ||
            elapsed >= ctx.options.minimumDelay
          ) {
            // ... send now
            transitionWith(ctx, 'sendDatagram', datagram);
          } else {
            // .. or else, let the FSM handle it later
            setTimeout(
              () => ctx.fsm.handle('outbound_ROUTING_INDICATION', datagram),
              ctx.minimumDelay - elapsed
            );
          }
        },

        // 2) queue an OUTGOING tunelling request...
        outbound_TUNNELING_REQUEST({ ctx }, datagram) {
          if (ctx.useTunneling) {
            const elapsed = Date.now() - ctx.lastSentTime;
            // if no miminum delay set OR the last sent datagram was long ago...
            if (
              !ctx.options.minimumDelay ||
              elapsed >= ctx.options.minimumDelay
            ) {
              // ... send now
              transitionWith(ctx, 'sendDatagram', datagram);
            } else {
              // .. or else, let the FSM handle it later
              setTimeout(
                () => ctx.fsm.handle('outbound_TUNNELING_REQUEST', datagram),
                ctx.minimumDelay - elapsed
              );
            }
          } else {
            KnxLog.get().debug(
              "(%s):\tdropping outbound TUNNELING_REQUEST, we're in routing mode",
              ctx.fsm.compositeState()
            );
          }
        },

        // 3) receive an INBOUND tunneling request INDICATION (L_Data.ind)
        ['inbound_TUNNELING_REQUEST_L_Data.ind']({ ctx }, datagram) {
          if (ctx.useTunneling) {
            transitionWith(ctx, 'recvTunnReqIndication', datagram);
          }
        },

        /* 4) receive an INBOUND tunneling request CONFIRMATION (L_Data.con) to one of our sent tunnreq's
         * We don't need to explicitly wait for a L_Data.con confirmation that the datagram has in fact
         *  reached its intended destination. This usually requires setting the 'Sending' flag
         *  in ETS, usually on the 'primary' device that contains the actuator endpoint
         */
        ['inbound_TUNNELING_REQUEST_L_Data.con']({ ctx }, datagram) {
          if (ctx.useTunneling) {
            const confirmed = ctx.sentTunnRequests[datagram.cemi.dest_addr];
            if (confirmed) {
              delete ctx.sentTunnRequests[datagram.cemi.dest_addr];
              ctx.emit('confirmed', confirmed);
            }
            KnxLog.get().trace(
              '(%s): %s %s',
              ctx.fsm.compositeState(),
              datagram.cemi.dest_addr,
              confirmed
                ? 'delivery confirmation (L_Data.con) received'
                : 'unknown dest addr'
            );
            ctx.acknowledge(datagram);
          }
        },

        // 5) receive an INBOUND ROUTING_INDICATION (L_Data.ind)
        ['inbound_ROUTING_INDICATION_L_Data.ind']({ ctx }, datagram) {
          ctx.emitEvent(datagram);
        },

        inbound_DISCONNECT_REQUEST({ ctx }, datagram) {
          if (ctx.useTunneling) {
            ctx.fsm.transition('connecting');
          }
        },
      },

      // if idle for too long, request connection state from the KNX IP router
      requestingConnState: {
        _onEnter({ ctx }) {
          // added to note sending connectionstate_request
          KnxLog.get().debug('Requesting Connection State');
          KnxLog.get().trace(
            '(%s): Requesting Connection State',
            ctx.fsm.compositeState()
          );
          ctx.send(
            ctx.prepareDatagram(
              KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST
            )
          );
          // TODO: handle send err
          //
          ctx.connstatetimer = setTimeout(() => {
            const msg = 'timed out waiting for CONNECTIONSTATE_RESPONSE';
            KnxLog.get().trace('(%s): %s', ctx.fsm.compositeState(), msg);
            ctx.fsm.transition('connecting');
            ctx.emit('error', msg);
          }, 1000);
        },
        _onExit({ ctx }) {
          clearTimeout(ctx.connstatetimer);
        },
        inbound_CONNECTIONSTATE_RESPONSE({ ctx }, datagram) {
          const state = KnxConstants.keyText(
            'RESPONSECODE',
            datagram.connstate.status
          );
          switch (datagram.connstate.status) {
            case 0:
              ctx.fsm.transition('idle');
              break;
            default:
              ctx.log.debug(
                util.format(
                  '*** error: %s *** (connstate.code: %d)',
                  state,
                  datagram.connstate.status
                )
              );
              ctx.fsm.transition('connecting');
              ctx.emit('error', state);
          }
        },
        ['*']({ ctx, inputName }, ...args) {
          ctx.log.debug(
            util.format(
              '*** deferring %s until transition from requestingConnState => idle',
              inputName
            )
          );
          deferUntilIdle(ctx, inputName, args);
        },
      },

      /*
       * 1) OUTBOUND DATAGRAM (ROUTING_INDICATION or TUNNELING_REQUEST)
       */
      sendDatagram: {
        _onEnter({ ctx }) {
          const datagram = ctx.fsmDatagram;
          // send the telegram on the wire
          ctx.seqnum += 1;
          if (ctx.useTunneling) datagram.tunnstate.seqnum = ctx.seqnum & 0xff;
          ctx.send(datagram, (err) => {
            if (err) {
              //console.trace('error sending datagram, going idle');
              ctx.seqnum -= 1;
              ctx.fsm.transition('idle');
            } else {
              // successfully sent the datagram
              if (ctx.useTunneling)
                ctx.sentTunnRequests[datagram.cemi.dest_addr] = datagram;
              ctx.lastSentTime = Date.now();
              ctx.log.debug(
                '(%s):\t>>>>>>> successfully sent seqnum: %d',
                ctx.fsm.compositeState(),
                ctx.seqnum
              );
              if (ctx.useTunneling) {
                // and then wait for the acknowledgement
                transitionWith(ctx, 'sendTunnReq_waitACK', datagram);
              } else {
                ctx.fsm.transition('idle');
              }
            }
            // 14/03/2020 Supergiovane: In multicast mode, other node-red nodes receives the echo of the telegram sent (the groupaddress_write event). If in tunneling, force the emit of the echo datagram (so other node-red nodes can receive the echo), because in tunneling, there is no echo.
            // ########################
            //if (ctx.useTunneling) ctx.sentTunnRequests[datagram.cemi.dest_addr] = datagram;
            if (ctx.useTunneling) {
              ctx.sentTunnRequests[datagram.cemi.dest_addr] = datagram;
              if (
                typeof ctx.localEchoInTunneling !== 'undefined' &&
                ctx.localEchoInTunneling
              ) {
                try {
                  ctx.emitEvent(datagram);
                  ctx.log.debug(
                    '(%s):\t>>>>>>> localEchoInTunneling: echoing by emitting %d',
                    ctx.fsm.compositeState(),
                    ctx.seqnum
                  );
                } catch (error) {
                  ctx.log.debug(
                    '(%s):\t>>>>>>> localEchoInTunneling: error echoing by emitting %d ' +
                      error,
                    ctx.fsm.compositeState(),
                    ctx.seqnum
                  );
                }
              }
            }
            // ########################
          });
        },
        ['*']({ ctx, inputName }, ...args) {
          ctx.log.debug(
            util.format(
              '*** deferring %s until transition sendDatagram => idle',
              inputName
            )
          );
          deferUntilIdle(ctx, inputName, args);
        },
      },
      /*
       * Wait for tunneling acknowledgement by the IP router; this means the sent UDP packet
       * reached the IP router and NOT that the datagram reached its final destination
       */
      sendTunnReq_waitACK: {
        _onEnter({ ctx }) {
          const datagram = ctx.fsmDatagram;
          //ctx.log.debug('setting up tunnreq timeout for %j', datagram);
          ctx.tunnelingAckTimer = setTimeout(() => {
            ctx.log.debug('timed out waiting for TUNNELING_ACK');
            // TODO: resend datagram, up to 3 times
            ctx.fsm.transition('idle');
            ctx.emit('tunnelreqfailed', datagram);
          }, 2000);
        },
        _onExit({ ctx }) {
          clearTimeout(ctx.tunnelingAckTimer);
        },
        inbound_TUNNELING_ACK({ ctx }, datagram) {
          ctx.log.debug(
            util.format(
              '===== datagram %d acknowledged by IP router',
              datagram.tunnstate.seqnum
            )
          );
          ctx.fsm.transition('idle');
        },
        ['*']({ ctx, inputName }, ...args) {
          ctx.log.debug(
            util.format(
              '*** deferring %s until transition sendTunnReq_waitACK => idle',
              inputName
            )
          );
          deferUntilIdle(ctx, inputName, args);
        },
      },

      /*
       * 2) INBOUND tunneling request (L_Data.ind) - only in tunnelling mode
       */
      recvTunnReqIndication: {
        _onEnter({ ctx }) {
          const datagram = ctx.fsmDatagram;
          ctx.seqnumRecv = datagram.tunnstate.seqnum;
          ctx.acknowledge(datagram);
          ctx.fsm.transition('idle');
          ctx.emitEvent(datagram);
        },
        ['*']({ ctx, inputName }, ...args) {
          ctx.log.debug(
            util.format('*** deferring %s until transition to idle', inputName)
          );
          deferUntilIdle(ctx, inputName, args);
        },
      },
    },
  });

module.exports = createKnxFsm;
