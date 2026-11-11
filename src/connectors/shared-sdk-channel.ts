import { MessagePortChannel } from "@microsoft/managed-apps-common/communication";
import type { Channel, ChannelReceiver, PlatformBridge, SdkConnectOptions } from "@microsoft/managed-apps-common/communication";

declare global {
  interface Window {
    __platformBridge?: PlatformBridge;
  }
}

const CHANNEL_FAILURES = {
  missing: "Channel diagnostic [bridge-missing]: the public SDK bridge was absent at app initialization. No native request was sent.",
  protected: "Channel diagnostic [bridge-protected]: the SDK bridge's connect method could not be observed safely. No native request was sent.",
  missed: "Channel diagnostic [connect-not-captured]: the bridge was present, but the SDK connection call was not captured. No native request was sent.",
  restore: "Channel diagnostic [bridge-restore-failed]: the original bridge method could not be restored safely. No native request was sent.",
  handshake: "Channel diagnostic [handshake-failed]: the existing SDK channel handshake failed. No native request was sent.",
  fallbackProtected: "Channel diagnostic [fallback-protected]: the bridge was absent and the SDK fallback channel's connect method could not be observed safely. No native request was sent.",
  fallbackMissed: "Channel diagnostic [fallback-not-captured]: the bridge was absent at app initialization and the SDK fallback channel connection was not captured. No native request was sent.",
} as const;

type ChannelFailure = keyof typeof CHANNEL_FAILURES;
/** The exported shared class the SDK uses for its authoring/preview fallback channel. */
export type FallbackChannelClass = { prototype: object };
const SDK_COMPONENT = "app-sdk";

export class SharedSdkChannelError extends Error {
  constructor(readonly reason: ChannelFailure) {
    super(CHANNEL_FAILURES[reason]);
    this.name = "SharedSdkChannelError";
  }
}

/** Bound on how long the prototype observer may stay installed if the SDK never creates its fallback channel. */
export const FALLBACK_OBSERVATION_MS = 30_000;

/**
 * Without a bridge the SDK creates exactly one `MessagePortChannel` with component "app-sdk" and calls its
 * `connect()`. Observe only that call on the exported shared class and reuse the same instance. The observer
 * retires on capture, on the first lookup or after a bounded window (a late public bridge means no fallback),
 * and only restores the prototype while it is still ours: a later replacement by another party is left intact
 * and our wrapper just forwards. Never construct a channel, touch its port or alter the SDK's call or result.
 */
function observeFallbackConnection(channelClass: FallbackChannelClass, observationMs: number): () => Promise<Channel> {
  let captured: Promise<Channel> | undefined;
  let failure: ChannelFailure | undefined;
  let retire = (): void => undefined;
  try {
    const prototype = channelClass.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "connect");
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== "function" || !descriptor.writable || !descriptor.configurable) {
      failure = "fallbackProtected";
    } else {
      let retired = false;
      const observed = function (this: object, ...args: unknown[]): unknown {
        let sdk = false;
        if (!retired) {
          try {
            sdk = Reflect.get(this, "component") === SDK_COMPONENT;
          } catch {
            sdk = false;
          }
        }
        if (sdk) retire();
        let result: unknown;
        try {
          result = Reflect.apply(original, this, args);
        } catch (error) {
          if (sdk) failure ??= "handshake";
          throw error;
        }
        if (sdk) {
          const channel = this as Channel;
          captured = Promise.resolve(result).then(() => channel, () => {
            throw new SharedSdkChannelError("handshake");
          });
          captured.catch(() => undefined);
        }
        return result;
      };
      const timer = setTimeout(() => retire(), observationMs);
      retire = () => {
        if (retired) return;
        retired = true;
        clearTimeout(timer);
        try {
          if (Object.getOwnPropertyDescriptor(prototype, "connect")?.value === observed) {
            Object.defineProperty(prototype, "connect", descriptor);
          }
        } catch {
          failure ??= "restore";
        }
      };
      Object.defineProperty(prototype, "connect", { ...descriptor, value: observed });
    }
  } catch {
    failure = "fallbackProtected";
  }
  return () => {
    retire();
    if (failure || !captured) {
      return Promise.reject(new SharedSdkChannelError(failure ?? "fallbackMissed"));
    }
    return captured;
  };
}

/** Observe the SDK's own single connection; never create a channel or replace its receiver. */
export function observeSdkConnection(
  bridge: PlatformBridge | undefined,
  fallback?: FallbackChannelClass,
  observationMs = FALLBACK_OBSERVATION_MS,
): () => Promise<Channel> {
  if (!bridge && fallback) return observeFallbackConnection(fallback, observationMs);
  let captured: Promise<Channel> | undefined;
  let failure: ChannelFailure | undefined = bridge ? undefined : "missing";
  if (bridge) {
    try {
      const original = bridge.connect;
      const descriptor = Object.getOwnPropertyDescriptor(bridge, "connect");
      const observed = function (this: PlatformBridge, receiver: ChannelReceiver, options?: SdkConnectOptions) {
        try {
          if (descriptor) Object.defineProperty(bridge, "connect", descriptor);
          else if (!Reflect.deleteProperty(bridge, "connect")) failure = "restore";
        } catch {
          failure = "restore";
        }
        try {
          captured = original.call(this, receiver, options);
          return captured;
        } catch (error) {
          failure ??= "handshake";
          throw error;
        }
      };
      if (typeof original !== "function" || (descriptor && (!("value" in descriptor) || !descriptor.writable))) failure = "protected";
      else Object.defineProperty(bridge, "connect", {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        writable: true,
        value: observed,
      });
    } catch {
      failure = "protected";
    }
  }
  return () => {
    if (failure || !captured) {
      return Promise.reject(new SharedSdkChannelError(failure ?? "missed"));
    }
    return captured;
  };
}

export const getSharedSdkChannel = typeof window === "undefined"
  ? observeSdkConnection(undefined)
  : observeSdkConnection(window.__platformBridge, MessagePortChannel);
