import { createDataClient } from "@microsoft/managed-apps-common/dataClient";
import { Methods, type HttpSendParams, type HttpSendResult } from "@microsoft/managed-apps-common/communication";
import dataSources from "../../generated/dataSources";
import { getSharedSdkChannel, SharedSdkChannelError } from "./shared-sdk-channel";

export const NATIVE_AGENT_TIMEOUT_MS = 180_000;
const MAX_REPLY_LENGTH = 524288;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentNodeTransportError extends Error {
  constructor(
    readonly code: "connection" | "format" | "policy" | "timeout", message: string,
    readonly channelReason?: SharedSdkChannelError["reason"],
  ) {
    super(message);
    this.name = "AgentNodeTransportError";
  }
}

function malformed(): never {
  throw new AgentNodeTransportError("format", "The native agent returned an invalid completion response. No request was retried.");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function header(response: HttpSendResult, name: string): string | undefined {
  const entries = Object.entries(response.headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length > 1) return malformed();
  return entries[0]?.[1];
}

function replyBody(response: HttpSendResult): Record<string, unknown> {
  if (response.body.length > MAX_REPLY_LENGTH || response.bodyEncoding === "base64") return malformed();
  let data: unknown;
  try { data = JSON.parse(response.body); } catch { return malformed(); }
  if (!record(data) || "error" in data) return malformed();
  return data;
}

export function completionUrl(location: string, requestUrl: string, environmentId: string, previous?: string): string {
  if (location.length > 8192 ||
      [...location].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
      location.includes("#") || location.includes("\\")) return malformed();
  let target: URL;
  let initial: URL;
  let previousPath: string | undefined;
  let absolute = true;
  try { new URL(location); } catch { absolute = false; }
  // An absolute Location is sent verbatim, so validate exactly its standalone parse; reject scheme forms without "//".
  if (absolute && !/^https:\/\//i.test(location)) return malformed();
  try {
    target = absolute ? new URL(location) : new URL(location, requestUrl);
    initial = new URL(requestUrl);
    previousPath = previous === undefined ? undefined : new URL(previous).pathname;
  } catch { return malformed(); }
  const handle = target.pathname.slice(initial.pathname.length + 1);
  if (initial.protocol !== "https:" || !initial.pathname.endsWith("/powerautomate/agentnodes/conversations") ||
      target.protocol !== "https:" || target.origin !== initial.origin || target.username || target.password || target.hash ||
      !target.pathname.startsWith(`${initial.pathname}/`) || !/^[a-z0-9._~-]+$/i.test(handle) ||
      (previousPath !== undefined && target.pathname !== previousPath) ||
      [...target.searchParams.keys()].filter((key) => key.toLowerCase() === "environmentid").length !== 1 ||
      target.searchParams.get("environmentId") !== environmentId) return malformed();
  const rawPath = location.slice(0, location.indexOf("?") >>> 0);
  // URL parsing normalizes dot segments, so reject them in the raw text for absolute and relative forms alike.
  if (rawPath.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return malformed();
  // Validate using URL, but send the original opaque query without re-encoding it.
  if (absolute) return location;
  const query = location.indexOf("?");
  return `${target.origin}${target.pathname}${location.slice(query)}`;
}

export function retryDelay(response: HttpSendResult, now: number): number {
  const value = header(response, "retry-after");
  if (value === undefined) return 15_000;
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  const delay = seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  if (!Number.isFinite(delay) || (seconds !== undefined && !Number.isSafeInteger(seconds))) return malformed();
  return Math.max(1000, delay);
}

function checkStatus(response: HttpSendResult): void {
  if (response.status === 442) {
    throw new AgentNodeTransportError("policy", "The native agent request was blocked by the organization's connector policy.");
  }
  if (![200, 201, 202].includes(response.status)) {
    throw new AgentNodeTransportError("connection", "The native agent request failed. Check sign-in, agent access and availability.");
  }
}

export async function invokeAgentNode(
  body: Record<string, unknown>, conversationId: string | undefined, environmentId: string,
  assertCurrent: () => void, deadline: number, onDispatch?: () => void,
): Promise<unknown> {
  const active = () => {
    assertCurrent();
    if (Date.now() >= deadline) {
      throw new AgentNodeTransportError("timeout", "The native agent did not complete within three minutes.");
    }
  };
  const remaining = () => { active(); return Math.max(1, deadline - Date.now()); };
  active();
  let channel;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    channel = await Promise.race([
      getSharedSdkChannel(),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new AgentNodeTransportError("timeout",
          "The existing SDK channel was not ready within the request deadline. No native request was sent.")), remaining());
      }),
    ]);
  } catch (error) {
    if (error instanceof AgentNodeTransportError) throw error;
    const diagnostic = error instanceof SharedSdkChannelError ? error : new SharedSdkChannelError("handshake");
    throw new AgentNodeTransportError("connection", diagnostic.message, diagnostic.reason);
  } finally {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
  }
  active();
  const submitted: { request?: HttpSendParams; response?: HttpSendResult } = {};
  const client = createDataClient({
    dataSourcesInfo: dataSources,
    host: {
      async getAppConnections() {
        active();
        const connections = await channel.send(Methods.Data.getAppConnections, undefined, { timeout: Math.min(30_000, remaining()) });
        active();
        const normalized = Object.fromEntries(Object.entries(connections).map(([key, value]) => [key.toLowerCase(), value]));
        if (normalized.agentnode?.apiId !== "/providers/Microsoft.PowerApps/apis/shared_agentnode") return malformed();
        return normalized;
      },
      async sendHttpRequest(request) {
        active();
        if (submitted.request || request.method !== "POST" || request.context?.connection?.dataSourceName !== "agentnode") return malformed();
        const timeout = remaining();
        submitted.request = request;
        onDispatch?.();
        const response = await channel.send(Methods.Http.send, request, { timeout });
        submitted.response = response;
        active();
        if (response.body.length > MAX_REPLY_LENGTH) return malformed();
        return response;
      },
      trackEvent(eventName, properties) {
        channel.notify(Methods.Telemetry.trackEvent, { eventName, properties });
      },
    },
  });
  await client.executeAsync({
    connectorOperation: {
      tableName: "agentnode", operationName: "InvokeAgent",
      parameters: { body, "x-ms-conversation-id": conversationId, environmentId },
    },
  });
  active();
  const { request, response: initial } = submitted;
  if (!request) {
    throw new AgentNodeTransportError("connection", "The native agent request could not be sent through its existing connection.");
  }
  if (!initial) {
    throw new AgentNodeTransportError("connection", "The native host did not confirm the invocation outcome.");
  }
  checkStatus(initial);
  if (initial.status !== 202) return replyBody(initial);
  const acknowledgement = replyBody(initial);
  const id = acknowledgement.conversationId;
  if (typeof id !== "string" || !GUID.test(id) || (conversationId !== undefined && conversationId !== id)) return malformed();
  const location = header(initial, "location");
  if (!location) return malformed();
  let nextUrl = completionUrl(location, request.url, environmentId);
  const pollHeaders: Record<string, string> = { Accept: "application/json" };
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (["x-ms-protocol-semantics", "servicenamespace", "x-ms-enable-selects"].includes(name.toLowerCase())) {
      pollHeaders[name] = value;
    }
  }
  let response = initial;
  for (;;) {
    active();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryDelay(response, Date.now()), deadline - Date.now())));
    active();
    try {
      response = await channel.send(Methods.Http.send, {
        url: nextUrl, method: "GET", headers: pollHeaders,
        context: { ...request.context, operationName: "connectorDataOperation.GetConversationStatus" },
      }, { timeout: remaining() });
    } catch {
      active();
      throw new AgentNodeTransportError("connection", "The native agent completion request failed. No invocation was retried.");
    }
    active();
    checkStatus(response);
    if (response.status !== 202) {
      const completed = replyBody(response);
      if (completed.conversationId !== id) return malformed();
      return completed;
    }
    if (response.body.trim()) {
      const pending = replyBody(response);
      if (pending.conversationId !== undefined && pending.conversationId !== id) return malformed();
    }
    const updated = header(response, "location");
    if (updated) nextUrl = completionUrl(updated, request.url, environmentId, nextUrl);
  }
}
