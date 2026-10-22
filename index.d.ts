/// <reference types="node" />

import * as events from "events";

type HandlersSpec = {
  connected?: () => void;
  disconnected?: () => void;
  event?: (
    evt: string,
    src: KnxDeviceAddress,
    dest: KnxGroupAddress,
    value: Buffer
  ) => void;
  error?: (connstatus: any) => void;
};

type ConnectionSpec = {
  /** ip address of the KNX router or interface */
  ipAddr?: string;
  /** port of the KNX router or interface */
  ipPort?: number;
  /**  in case you need to specify the multicast interface (say if you have more than one) */
  interface?: string;
  /**  the KNX physical address we'd like to use */
  physAddr?: string;
  /**  set the log level for messsages printed on the console. This can be 'error', 'warn', 'info' (default), 'debug', or 'trace'. */
  loglevel?: string;
  /**  do not automatically connect, but use connection.Connect() to establish connection */
  manualConnect?: boolean;
  /** use tunneling with multicast (router) - this is NOT supported by all routers! See README-resilience.md */
  forceTunneling?: boolean;
  /**  wait at least 10 millisec between each datagram */
  minimumDelay?: number;
  /**  enable this option to suppress the acknowledge flag with outgoing L_Data.req requests. LoxOne needs this */
  suppress_ack_ldatareq?: boolean;
  /** 14/03/2020 In tunneling mode, echoes the sent message by emitting a new emitEvent, so other object with same group address, can receive the sent message. Default is false. */
  localEchoInTunneling?: boolean;
  /**  event handlers. You can also bind them later with connection.on(event, fn) */
  handlers?: HandlersSpec;
};

type KnxDeviceAddress = string;

type KnxGroupAddress = string;

/** The type of the KnxValue depends on the DPT that it is associated with */
type KnxValue = number | string | boolean | Date;

/** Possible formats "X" or "X.Y", i.e. "1" or "1.001" */
type DPT = string;

type DatapointOptions = {
  ga: KnxGroupAddress;
  dpt?: DPT;
  autoread?: boolean;
  readReqTimeout?: number;
};

interface DatapointEvent {
  on(
    event: "change",
    listener: (old_value: KnxValue, new_value: KnxValue) => void
  ): this;
  on(event: string, listener: (event: string, value: any) => void): this;
}

declare module "knx" {
  type ConnectionEventCallback = (...args: any[]) => void;

  interface ConnectionEventSubscription {
    eventName: string;
    callback: ConnectionEventCallback;
    off: () => void;
  }

  /**
   * The event API of a connection. It works like Node's EventEmitter, except
   * that on() returns a subscription, off() without a callback removes all
   * listeners (of an event), '*' listeners receive every event with its name
   * first, and an 'error' event without listener is ignored.
   */
  class ConnectionEvents {
    emit(eventName: string, ...args: any[]): boolean;
    on(eventName: string, callback: ConnectionEventCallback): ConnectionEventSubscription;
    once(eventName: string, callback: ConnectionEventCallback): this;
    off(eventName?: string, callback?: ConnectionEventCallback): this;
    removeListener(eventName: string, callback: ConnectionEventCallback): this;
    removeAllListeners(eventName?: string): this;
    listenerCount(eventName: string): number;
  }

  /** @deprecated use ConnectionEventCallback */
  type MachinaEventsCallback = ConnectionEventCallback;
  /** @deprecated use ConnectionEventSubscription */
  type MachinaEventsReturn = ConnectionEventSubscription;
  /** @deprecated use ConnectionEvents */
  type MachinaEvents = ConnectionEvents;

  type ReadOptions = {
    ga: KnxGroupAddress;
    /** milliseconds to wait for the response, default 3000 */
    readReqTimeout?: number;
  };

  export interface IConnection extends ConnectionEvents {
    debug: boolean;
    /** the current state of the connection state machine, e.g. 'idle' */
    readonly state: string;
    Connect(): void;
    Disconnect(cb?: () => void): void;
    read(options: ReadOptions, cb?: (err: Error, src: KnxDeviceAddress, value: Buffer) => void): void;
    write(ga: KnxGroupAddress, value: KnxValue | Buffer, dpt: DPT, cb?: () => void): void;
  }

  export class Connection extends ConnectionEvents implements IConnection {
    public debug: boolean;
    readonly state: string;
    constructor(conf: ConnectionSpec);
    Connect(): void;
    Disconnect(cb?: () => void): void;
    read(options: ReadOptions, cb?: (err: Error, src: KnxDeviceAddress, value: Buffer) => void): void;
    write(ga: KnxGroupAddress, value: KnxValue | Buffer, dpt: DPT, cb?: () => void): void;
    writeRaw(
      ga: KnxGroupAddress,
      value: Buffer,
      bitlength?: number,
      cb?: () => void
    ): void;
    respond(ga: KnxGroupAddress, value: KnxValue | Buffer, dpt: DPT): void;
  }

  export class Datapoint extends events.EventEmitter implements DatapointEvent {
    readonly current_value: KnxValue;
    readonly dptid: DPT;

    constructor(options: DatapointOptions, conn?: IConnection);
    bind(conn: Connection): void;
    write(value: KnxValue): void;
    read(callback?: (err: Error, src: KnxDeviceAddress, value: KnxValue) => void): void;
  }
}
