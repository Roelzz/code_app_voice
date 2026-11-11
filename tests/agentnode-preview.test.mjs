import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createChannelReceiver, MessagePortChannel, Methods } from "@microsoft/managed-apps-common/communication";

const encode = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const publicImports = (source) => source.replace(/from (["'])([^"']+)\1/g,
  (match, quote, name) => name.startsWith(".") || name.startsWith("data:") || name.startsWith("file:")
    ? match : `from ${JSON.stringify(import.meta.resolve(name))}`);
const observerSource = await readFile(new URL("../src/connectors/shared-sdk-channel.ts", import.meta.url), "utf8");
const observerUrl = encode(publicImports(compile(observerSource)));
const { observeSdkConnection, SharedSdkChannelError, FALLBACK_OBSERVATION_MS } = await import(observerUrl);
const dsi = encode(compile(await readFile(new URL("../generated/dataSources.ts", import.meta.url), "utf8")));
const nativeSource = await readFile(new URL("../src/connectors/agentnode-preview.ts", import.meta.url), "utf8");
globalThis.nativePreviewHarness = { get: undefined };
const nativeModule = publicImports(compile(nativeSource))
  .replace(/from "\.\.\/\.\.\/generated\/dataSources"/, `from ${JSON.stringify(dsi)}`)
  .replace('from "./shared-sdk-channel"', `from ${JSON.stringify(observerUrl)}`)
  .replace("getSharedSdkChannel()", "globalThis.nativePreviewHarness.get()");
const nativeUrl = encode(nativeModule);
const { invokeAgentNode, completionUrl, retryDelay } = await import(nativeUrl);

const ENV = "75660de8-d408-e9ce-bc60-84d4f6a30d0b";
const ID = "9d93d392-b151-4a4a-bbe5-f19e36883665";
const OTHER = "11111111-2222-4333-8444-555555555555";
const RUNTIME = "https://native.example.invalid/apim/agentnode";
const CONNECTION = "610a8f57443d4664902d7d6f80a02176";
const POST_URL = `${RUNTIME}/${CONNECTION}/powerautomate/agentnodes/conversations`;
const LOCATION = `${POST_URL}/${ID}?environmentId=${ENV}&goodUntil=opaque%2Bv%2f%3D&x=1&x=2`;
const BODY = { agentId: "Default_Failure_Mode_Identifier_20cdd7", prompt: "Fictional DFMEA question", isHitlEscalationEnabled: false };
const result = (status, data, headers = {}) => ({ status, headers, body: JSON.stringify(data) });
const accepted = (headers = {}) => result(202, { conversationId: ID },
  { Location: LOCATION, "Retry-After": "15", ...headers });
const completed = () => result(200, { conversationId: ID, result: "A completed native answer" });
const flush = () => new Promise(setImmediate);
let channel, responses, httpCalls, current, rejectCurrent;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  responses = [accepted(), completed()];
  httpCalls = [];
  current = true;
  rejectCurrent = () => { if (!current) throw new Error("Ended conversation"); };
  channel = {
    send: mock.fn(async (method, params) => {
      if (method === Methods.Data.getAppConnections) {
        return { AgentNode: { apiId: "/providers/Microsoft.PowerApps/apis/shared_agentnode", connectionId: CONNECTION, runtimeUrl: RUNTIME } };
      }
      assert.equal(method, Methods.Http.send);
      httpCalls.push(params);
      const response = responses.shift();
      assert.ok(response, "No unexpected request");
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(params) : response;
    }),
    notify: mock.fn(),
  };
  globalThis.nativePreviewHarness.get = async () => channel;
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});
const invoke = (conversation = undefined) => invokeAgentNode(BODY, conversation, ENV, rejectCurrent, Date.now() + 180_000);

test("one generated-metadata POST, respect Retry-After, then GET the exact opaque URL on the same host channel", async () => {
  const pending = invoke();
  await flush();
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, "POST");
  assert.deepEqual(JSON.parse(httpCalls[0].body), BODY);
  mock.timers.tick(14_999);
  await flush();
  assert.equal(httpCalls.length, 1, "Do not poll early");
  mock.timers.tick(1);
  assert.deepEqual(await pending, { conversationId: ID, result: "A completed native answer" });
  assert.deepEqual(httpCalls.map((call) => call.method), ["POST", "GET"]);
  assert.equal(httpCalls[1].url, LOCATION);
  assert.equal(httpCalls[1].context.connection, httpCalls[0].context.connection);
  assert.equal(httpCalls[1].context.operationName, "connectorDataOperation.GetConversationStatus");
  assert.equal(httpCalls[1].headers.Accept, "application/json");
  assert.ok(Object.keys(httpCalls[1].headers).every((name) =>
    ["accept", "x-ms-protocol-semantics", "servicenamespace", "x-ms-enable-selects"].includes(name.toLowerCase())));
  assert.equal(httpCalls[1].body, undefined);
  assert.equal(Object.keys(httpCalls[1].headers).some((key) => /authorization|cookie/i.test(key)), false);
});

test("follow-up header survives submission; immediate 201 answer does not poll", async () => {
  responses = [result(201, { conversationId: ID, result: "Follow-up answer" })];
  assert.equal((await invoke(ID)).result, "Follow-up answer");
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].headers["x-ms-conversation-id"], ID);
});

test("follow-up polling handle can differ from stable conversation ID while its opaque query changes", async () => {
  const handle = LOCATION.replace(`/conversations/${ID}`, "/conversations/run-handle_42.v1~");
  const next = `${handle}&next=%2b%2F%3d`;
  responses = [accepted({ Location: handle }), result(202, { conversationId: ID },
    { Location: next, "Retry-After": "1" }), completed()];
  const pending = invoke(ID);
  await flush();
  mock.timers.tick(15_000);
  await flush();
  mock.timers.tick(1000);
  assert.equal((await pending).conversationId, ID);
  assert.equal(httpCalls[0].headers["x-ms-conversation-id"], ID);
  assert.deepEqual(httpCalls.slice(1).map((call) => call.url), [handle, next]);
  assert.equal(httpCalls.filter((call) => call.method === "POST").length, 1);
});

test("subsequent Location cannot change an already accepted polling handle", async () => {
  responses = [accepted(), result(202, { conversationId: ID }, { Location: LOCATION.replace(ID, OTHER) })];
  const pending = invoke();
  const rejected = assert.rejects(pending, (error) => error.code === "format");
  await flush();
  mock.timers.tick(15_000);
  await rejected;
  assert.equal(httpCalls.length, 2);
});

test("poll GET uses only Accept and allowed protocol headers, and defaults missing Retry-After to fifteen seconds", async () => {
  const send = channel.send;
  channel.send = mock.fn((method, params) => {
    if (method === Methods.Http.send && params.method === "POST") {
      params.headers = {
        Accept: "text/plain", "Content-Type": "application/json", "x-ms-conversation-id": ID,
        Authorization: "synthetic-not-a-credential", Cookie: "synthetic",
        "X-MS-PROTOCOL-SEMANTICS": "cds", ServiceNamespace: "native", "x-ms-enable-selects": "true",
      };
    }
    return send(method, params);
  });
  responses = [result(202, { conversationId: ID }, { Location: LOCATION }), completed()];
  const pending = invoke(ID);
  await flush();
  mock.timers.tick(14_999);
  await flush();
  assert.equal(httpCalls.length, 1);
  mock.timers.tick(1);
  await pending;
  assert.deepEqual(httpCalls[1].headers, {
    Accept: "application/json", "X-MS-PROTOCOL-SEMANTICS": "cds", ServiceNamespace: "native", "x-ms-enable-selects": "true",
  });
  assert.deepEqual(httpCalls[1].context, {
    ...httpCalls[0].context, operationName: "connectorDataOperation.GetConversationStatus",
  });
  assert.equal(httpCalls[1].context.connection, httpCalls[0].context.connection);
});

test("pending GET responses preserve opaque replacement Location and honor updated retry delay", async () => {
  const replacement = `${LOCATION}&next=%2b%2F%3d`;
  responses = [accepted(), result(202, {}, { location: replacement, "retry-after": "2" }), completed()];
  const pending = invoke();
  await flush();
  mock.timers.tick(15_000);
  await flush();
  assert.equal(httpCalls.length, 2);
  mock.timers.tick(1999);
  await flush();
  assert.equal(httpCalls.length, 2);
  mock.timers.tick(1);
  await pending;
  assert.equal(httpCalls[2].url, replacement);
  assert.equal(httpCalls.filter((call) => call.method === "POST").length, 1);
});

test("completion URL must match HTTPS origin, exact connector/connection path, bounded handle and environment", () => {
  assert.equal(completionUrl(LOCATION, POST_URL, ENV), LOCATION);
  for (const invalid of [
    LOCATION.replace("https:", "http:"),
    LOCATION.replace("native.example.invalid", "evil.example.invalid"),
    LOCATION.replace(CONNECTION, "other-connection"),
    LOCATION.replace(`/conversations/${ID}`, "/conversations/other/handle"),
    LOCATION.replace(`/conversations/${ID}`, "/conversations/encoded%2fhandle"),
    LOCATION.replace("/apim/agentnode/", "/apim/other/"),
    LOCATION.replace(ENV, OTHER),
    `${LOCATION}&environmentId=${ENV}`,
    `${LOCATION}#fragment`,
    LOCATION.replace("https://", "https://user:password@"),
    `${LOCATION}\n`,
    `/relative/${ID}`,
  ]) {
    assert.throws(() => completionUrl(invalid, POST_URL, ENV), (error) =>
      error.code === "format" && !error.message.includes("goodUntil"));
  }
});

test("same-origin relative Location resolves against the request URL and preserves its encoded query", async () => {
  const path = new URL(POST_URL).pathname;
  const query = `?environmentId=${ENV}&goodUntil=opaque%2Bv%2f%3D&x=1&x=2`;
  assert.equal(completionUrl(`${path}/${ID}${query}`, POST_URL, ENV), LOCATION);
  assert.equal(completionUrl(`conversations/${ID}${query}`, POST_URL, ENV), LOCATION);
  assert.equal(completionUrl(`//native.example.invalid${path}/${ID}${query}`, POST_URL, ENV), LOCATION);
  responses = [accepted({ Location: `${path}/${ID}${query}` }), completed()];
  const pending = invoke();
  await flush();
  mock.timers.tick(15_000);
  await pending;
  assert.equal(httpCalls[1].url, LOCATION);
  for (const invalid of [
    `/relative/${ID}${query}`,
    `${path.replace("/conversations", "/other")}/${ID}${query}`,
    `${path}/../conversations/${ID}${query}`,
    `${path}/%2e%2e/conversations/${ID}${query}`,
    `${path}/./${ID}${query}`,
    `//evil.example.invalid${path}/${ID}${query}`,
    `\\\\evil.example.invalid${path}/${ID}${query}`,
    `${path}/${ID}?environmentId=${OTHER}`,
    `${path}/${ID}${query}#`,
  ]) {
    assert.throws(() => completionUrl(invalid, POST_URL, ENV), (error) => error.code === "format", invalid);
  }
});

test("ambiguous scheme-without-authority Location is rejected and never polled", async () => {
  const path = new URL(POST_URL).pathname;
  const query = `?environmentId=${ENV}&goodUntil=opaque%2Bv%2f%3D`;
  for (const ambiguous of [
    `https:conversations/${ID}${query}`,
    `https:${path}/${ID}${query}`,
    `HTTPS:conversations/${ID}${query}`,
    `https:/${path}/${ID}${query}`,
    `https:untrusted.example.invalid/../conversations/${ID}${query}`,
  ]) {
    assert.throws(() => completionUrl(ambiguous, POST_URL, ENV), (error) => error.code === "format", ambiguous);
  }
  responses = [accepted({ Location: `https:conversations/${ID}${query}` })];
  await assert.rejects(invoke(), (error) => error.code === "format");
  assert.deepEqual(httpCalls.map((call) => call.method), ["POST"]);
});

test("absolute Location with literal or encoded dot segments is rejected and never polled", async () => {
  const query = `?environmentId=${ENV}&goodUntil=opaque%2Bv%2f%3D`;
  for (const traversal of [
    `${POST_URL}/../conversations/${ID}${query}`,
    `${POST_URL}/%2e%2e/conversations/${ID}${query}`,
    `${POST_URL}/%2E%2E/conversations/${ID}${query}`,
    `${POST_URL}/.%2e/conversations/${ID}${query}`,
    `${POST_URL}/./${ID}${query}`,
    `${POST_URL}/%2e/${ID}${query}`,
    `${POST_URL}/${ID}/..${query}`.replace(`${ID}/..`, `${ID}/../${ID}`),
  ]) {
    assert.throws(() => completionUrl(traversal, POST_URL, ENV), (error) => error.code === "format", traversal);
  }
  assert.equal(completionUrl(`${POST_URL}/${ID}${query}`, POST_URL, ENV), `${POST_URL}/${ID}${query}`);
  assert.equal(completionUrl(`${POST_URL}/run.v2..x${query}`, POST_URL, ENV), `${POST_URL}/run.v2..x${query}`);
  responses = [accepted({ Location: `${POST_URL}/%2e%2e/conversations/${ID}${query}` })];
  await assert.rejects(invoke(), (error) => error.code === "format");
  assert.deepEqual(httpCalls.map((call) => call.method), ["POST"]);
});

test("case-insensitive duplicate environment-ID keys are rejected and never polled", async () => {
  const base = `${POST_URL}/${ID}?environmentId=${ENV}&goodUntil=opaque%2Bv%2f%3D`;
  for (const duplicate of [`${base}&EnvironmentId=${OTHER}`, `${base}&ENVIRONMENTID=${ENV}`,
    `${POST_URL}/${ID}?environmentid=${OTHER}&environmentId=${ENV}`, `${base}&environment%49d=${OTHER}`]) {
    assert.throws(() => completionUrl(duplicate, POST_URL, ENV), (error) => error.code === "format", duplicate);
  }
  assert.equal(completionUrl(LOCATION, POST_URL, ENV), LOCATION);
  responses = [accepted({ Location: `${base}&EnvironmentId=${OTHER}` })];
  await assert.rejects(invoke(), (error) => error.code === "format");
  assert.deepEqual(httpCalls.map((call) => call.method), ["POST"]);
});

test("three-minute maximum stops polling exactly at the deadline, never submits again", async () => {
  responses = Array.from({ length: 13 }, () => accepted());
  const pending = invoke();
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error.code === "timeout");
  await flush();
  for (let turn = 0; turn < 11; turn++) {
    mock.timers.tick(15_000);
    await flush();
  }
  mock.timers.tick(14_999);
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(1);
  await rejected;
  assert.equal(httpCalls.filter((call) => call.method === "POST").length, 1);
  assert.equal(httpCalls.filter((call) => call.method === "GET").length, 11);
});

for (const stage of ["connections", "POST", "GET"]) {
  test(`a silent host during ${stage} is bounded without retrying the invocation`, async () => {
    const send = channel.send;
    channel.send = mock.fn((method, params, options) => {
      const hung = stage === "connections" ? method === Methods.Data.getAppConnections :
        method === Methods.Http.send && params.method === stage;
      if (!hung) return send(method, params, options);
      assert.equal(options.timeout, stage === "connections" ? 30_000 : stage === "GET" ? 165_000 : 180_000);
      return new Promise((_, reject) => setTimeout(() => reject(new Error("Synthetic host timeout")), options.timeout));
    });
    const pending = invoke();
    const rejected = assert.rejects(pending, (error) => error.code === (stage === "connections" ? "connection" : "timeout"));
    await flush();
    if (stage === "GET") {
      mock.timers.tick(15_000);
      await flush();
    }
    mock.timers.tick(stage === "connections" ? 30_000 : stage === "GET" ? 165_000 : 180_000);
    await rejected;
    const posts = channel.send.mock.calls.filter((call) =>
      call.arguments[0] === Methods.Http.send && call.arguments[1].method === "POST");
    assert.equal(posts.length, stage === "connections" ? 0 : 1);
  });
}

async function createHelperSession() {
  const workiqUrl = encode(`
    export const callWorkIqCopilotChatText = async () => "Work IQ recovered";
    export const callWorkIqCopilotChatItems = async () => [];
    export class WorkIqConnectorError extends Error {}
    export class WorkIqResponseError extends Error {}
  `);
  const source = compile(await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8"))
    .replace('"./agentnode-preview"', JSON.stringify(nativeUrl))
    .replace('"@/connectors/workiq-copilot-chat"', JSON.stringify(workiqUrl));
  const { HelperSession } = await import(encode(source));
  return new HelperSession();
}

for (const stage of ["POST", "GET"]) {
  test(`an in-flight ${stage} failure requires an explicit new conversation before another native POST`, async () => {
    let fail;
    const inflight = () => new Promise((_, reject) => { fail = reject; });
    responses = stage === "POST" ? [inflight] : [accepted(), inflight];
    const session = await createHelperSession();
    session.select("actions");
    const pending = session.text("Question");
    const rejected = assert.rejects(pending, (error) =>
      error.requiresNewConversation === true && /upstream run may still be active/.test(error.message) &&
      !/could not be sent|private/.test(error.message));
    await flush();
    if (stage === "GET") {
      mock.timers.tick(15_000);
      await flush();
    }
    assert.equal(typeof fail, "function");
    fail(new Error("private host failure"));
    await rejected;
    await assert.rejects(session.text("Same turn"), (error) => error.requiresNewConversation === true);
    await assert.rejects(session.items("Another move", { action: "string" }),
      (error) => error.requiresNewConversation === true);
    assert.equal(httpCalls.filter((call) => call.method === "POST").length, 1);
    session.select("actions");
    responses = [completed()];
    assert.equal(await session.text("Explicit new conversation"), "A completed native answer");
    assert.equal(httpCalls.filter((call) => call.method === "POST").length, 2);
    assert.equal(httpCalls.at(-1).headers["x-ms-conversation-id"], undefined);
  });
}

test("a proven pre-submit failure is retryable without silently clearing the prior conversation", async () => {
  responses = [completed()];
  const session = await createHelperSession();
  session.select("actions");
  await session.text("First");
  globalThis.nativePreviewHarness.get = () => { throw new SharedSdkChannelError("missing"); };
  await assert.rejects(session.text("Follow up"), (error) =>
    error.channelReason === "missing" && error.requiresNewConversation === false);
  assert.equal(httpCalls.length, 1);
  globalThis.nativePreviewHarness.get = async () => channel;
  responses = [completed()];
  assert.equal(await session.text("Follow up"), "A completed native answer");
  assert.equal(httpCalls.at(-1).headers["x-ms-conversation-id"], ID);
});

test("the actual native transport settles a hung POST so the helper gate can recover for Work IQ", async () => {
  const send = channel.send;
  channel.send = mock.fn((method, params, options) => method === Methods.Http.send
    ? new Promise((_, reject) => setTimeout(() => reject(new Error("Synthetic host timeout")), options.timeout))
    : send(method, params, options));
  const session = await createHelperSession();
  session.select("actions");
  const pending = session.text("Question");
  const rejected = assert.rejects(pending, (error) => error.code === "timeout");
  await flush();
  await assert.rejects(session.text("No overlap"), (error) => error.code === "busy");
  mock.timers.tick(180_000);
  await rejected;
  await flush();
  await assert.rejects(session.text("No replay after timeout"), (error) => error.requiresNewConversation === true);
  session.select("workiq");
  assert.equal(await session.text("Next question"), "Work IQ recovered");
  assert.equal(channel.send.mock.calls.filter((call) => call.arguments[0] === Methods.Http.send).length, 1);
});

test("a never-settling shared bridge releases the helper gate at three minutes and ignores late readiness", async () => {
  let ready;
  const bridge = new Promise((resolve) => { ready = resolve; });
  globalThis.nativePreviewHarness.get = () => bridge;
  const session = await createHelperSession();
  session.select("actions");
  try {
    const pending = session.text("Question");
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, (error) => error.code === "timeout");
    await flush();
    mock.timers.tick(179_999);
    await flush();
    assert.equal(settled, false);
    await assert.rejects(session.text("No overlap"), (error) => error.code === "busy");
    mock.timers.tick(1);
    await rejected;
    await flush();
    session.select("workiq");
    assert.equal(await session.text("Next question"), "Work IQ recovered");
    assert.equal(channel.send.mock.callCount(), 0);
  } finally {
    ready(channel);
    await flush();
  }
  assert.equal(channel.send.mock.callCount(), 0);
});

test("the channel readiness wait uses the caller's remaining deadline, not a fresh three minutes", async () => {
  globalThis.nativePreviewHarness.get = () => new Promise(() => {});
  const pending = invokeAgentNode(BODY, undefined, ENV, rejectCurrent, Date.now() + 250);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error.code === "timeout" && /SDK channel/.test(error.message));
  await flush();
  mock.timers.tick(249);
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(1);
  await rejected;
  assert.equal(channel.send.mock.callCount(), 0);
});

test("switch/reset while waiting stops the poll loop without another GET or POST", async () => {
  const pending = invoke();
  await flush();
  current = false;
  const rejected = assert.rejects(pending, /Ended conversation/);
  mock.timers.tick(15_000);
  await rejected;
  assert.equal(httpCalls.length, 1);
});

test("switch/reset during GET rejects its late answer and sends no further requests", async () => {
  let finish;
  responses = [accepted(), () => new Promise((resolve) => { finish = resolve; })];
  const pending = invoke();
  await flush();
  mock.timers.tick(15_000);
  await flush();
  current = false;
  const rejected = assert.rejects(pending, /Ended conversation/);
  finish(completed());
  await rejected;
  assert.equal(httpCalls.length, 2);
});

test("HTTP errors, host exceptions, malformed acknowledgements and lost GUID continuity are safe failures", async () => {
  for (const response of [
    result(500, { error: "private details" }),
    result(202, { conversationId: ID }, { "Retry-After": "15" }),
    accepted({ Location: "https://evil.example.invalid/private?goodUntil=secret" }),
    new Error("private auth failure"),
  ]) {
    httpCalls = [];
    responses = [response];
    await assert.rejects(invoke(), (error) =>
      ["format", "connection"].includes(error.code) && !/private|goodUntil|secret|auth failure/.test(error.message));
    assert.equal(httpCalls.filter((call) => call.method === "POST").length, 1);
  }
  for (const response of [result(442, {}), result(200, { conversationId: OTHER, result: "wrong conversation" }),
    new Error(`private ${LOCATION}`), { status: 200, headers: {}, body: "invalid JSON" },
    result(200, { conversationId: ID, result: "x".repeat(524289) })]) {
    responses = [accepted(), response];
    const pending = invoke();
    const rejected = assert.rejects(pending, (error) =>
      ["format", "connection", "policy"].includes(error.code) && !error.message.includes("goodUntil"));
    await flush();
    mock.timers.tick(15_000);
    await rejected;
  }
});

test("Retry-After supports seconds and HTTP-date; missing value is bounded and invalid value is explicit", () => {
  assert.equal(retryDelay(accepted(), Date.now()), 15_000);
  assert.equal(retryDelay(accepted({ "Retry-After": new Date(Date.now() + 20_000).toUTCString() }), Date.now()), 20_000);
  assert.equal(retryDelay(result(202, {}), Date.now()), 15_000);
  assert.equal(retryDelay(accepted({ "Retry-After": "0" }), Date.now()), 1000);
  assert.throws(() => retryDelay(accepted({ "Retry-After": "invalid" }), Date.now()), (error) => error.code === "format");
});

test("observer does not connect; SDK keeps its exact receiver/options/promise and original bridge method", async () => {
  const receiver = {};
  const options = { componentVersion: "0.5.11" };
  const promise = Promise.resolve(channel);
  const original = mock.fn(function (received, supplied) {
    assert.equal(this, bridge);
    assert.equal(received, receiver);
    assert.equal(supplied, options);
    return promise;
  });
  const bridge = { connect: original };
  const descriptor = Object.getOwnPropertyDescriptor(bridge, "connect");
  const shared = observeSdkConnection(bridge);
  assert.equal(original.mock.callCount(), 0);
  const sdkPromise = bridge.connect(receiver, options);
  assert.equal(sdkPromise, promise);
  assert.equal(shared(), sdkPromise);
  assert.equal(await shared(), channel);
  assert.equal(original.mock.callCount(), 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(bridge, "connect"), descriptor);
});

test("unavailable/late/frozen bridge fails closed without opening a second connection or disrupting original SDK call", async () => {
  await assert.rejects(observeSdkConnection(undefined)(), (error) => error.reason === "missing");
  const connect = mock.fn(async () => channel);
  const frozen = Object.freeze({ connect });
  await assert.rejects(observeSdkConnection(frozen)(), (error) => error.reason === "protected");
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(await frozen.connect({}), channel);
  const bridge = { connect };
  await bridge.connect({});
  const late = observeSdkConnection(bridge);
  await assert.rejects(late(), (error) => error.reason === "missed");
  assert.equal(connect.mock.callCount(), 2, "The observer never tries another connection");
});

test("safe channel diagnostics reach the app without sending a request or exposing handshake details", async () => {
  for (const [shared, label] of [
    [observeSdkConnection(undefined), "bridge-missing"],
    [observeSdkConnection(Object.freeze({ connect: async () => channel })), "bridge-protected"],
    [observeSdkConnection({ connect: async () => channel }), "connect-not-captured"],
    [async () => { throw new Error(`private token ${LOCATION}`); }, "handshake-failed"],
  ]) {
    globalThis.nativePreviewHarness.get = shared;
    await assert.rejects(invoke(), (error) => error.code === "connection" &&
      error.message.includes(`[${label}]`) && !/private|token|goodUntil/.test(error.message));
    assert.equal(channel.send.mock.callCount(), 0);
  }
});

test("failed bridge restoration and synchronous handshake failure stay distinct without altering the SDK exception", async () => {
  const connect = mock.fn(async () => channel);
  const bridge = { connect };
  const shared = observeSdkConnection(bridge);
  Object.defineProperty(bridge, "connect", { configurable: false, writable: false });
  assert.equal(await bridge.connect({}), channel);
  await assert.rejects(shared(), (error) => error instanceof SharedSdkChannelError && error.reason === "restore");
  assert.equal(connect.mock.callCount(), 1);
  const originalError = new Error("private handshake failure");
  const throwing = { connect: () => { throw originalError; } };
  const failed = observeSdkConnection(throwing);
  assert.throws(() => throwing.connect({}), (error) => error === originalError);
  await assert.rejects(failed(), (error) => error.reason === "handshake" && !error.message.includes("private"));
});

test("actual SDK singleton and existing metric subscription use the observed channel; policy monitoring stays active", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = { connect: mock.fn(async () => channel) };
  globalThis.window = { __platformBridge: bridge };
  let metricReady;
  const metric = new Promise((resolve) => { metricReady = resolve; });
  channel.stream = mock.fn(async function* (method) {
    assert.equal(method, Methods.Telemetry.subscribeMetrics);
    yield await metric;
  });
  const loggerError = mock.method(console, "error", () => {});
  const shared = observeSdkConnection(bridge);
  try {
    // Load the installed implementations in memory with Node-resolvable imports; never edit SDK files.
    const sdkSource = publicImports(await readFile(new URL("../node_modules/@microsoft/managed-apps/dist/internal/sdkChannel.js", import.meta.url), "utf8"))
      .replace(/import \{ APP_SDK_VERSION \} from '\.\.\/version';/, 'const APP_SDK_VERSION = "0.5.11";');
    const sdkUrl = encode(sdkSource);
    const sdk = await import(sdkUrl);
    const loggerSource = publicImports(await readFile(new URL("../node_modules/@microsoft/managed-apps/dist/telemetry/LoggerManager.js", import.meta.url), "utf8"))
      .replace("'../internal/sdkChannel'", JSON.stringify(sdkUrl));
    const loggerUrl = encode(loggerSource);
    const monitorSource = publicImports(compile(await readFile(new URL("../src/lib/connector-policy-monitor.ts", import.meta.url), "utf8"))
      .replace('"@microsoft/managed-apps/telemetry"', JSON.stringify(loggerUrl)));
    const monitor = await import(encode(monitorSource));
    monitor.startConnectorPolicyMonitor();
    await flush();
    const sdkPromise = sdk.getSdkChannel();
    assert.equal(sdk.getSdkChannel(), sdkPromise);
    assert.equal(await shared(), await sdkPromise);
    globalThis.nativePreviewHarness.get = shared;
    const pending = invoke();
    await flush();
    mock.timers.tick(15_000);
    await pending;
    assert.equal(bridge.connect.mock.callCount(), 1);
    assert.equal(channel.stream.mock.callCount(), 1);
    metricReady({ type: "networkRequest", data: { statusCode: 442, url: `${RUNTIME}/connection` } });
    await flush();
    assert.equal(monitor.getConnectorPolicyBlock().blocked, true);
    assert.deepEqual(monitor.getConnectorPolicyBlock().connectors, ["agentnode"]);
    assert.equal(loggerError.mock.callCount(), 1);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete globalThis.window;
  }
});

const fallbackClass = (connect = async function () { this.connected = (this.connected ?? 0) + 1; }) => {
  class Fallback {
    constructor(component) { this.component = component; }
  }
  Object.defineProperty(Fallback.prototype, "connect", { configurable: true, writable: true, enumerable: false, value: connect });
  return Fallback;
};
const connectDescriptor = (Class) => Object.getOwnPropertyDescriptor(Class.prototype, "connect");

test("bridgeless fallback reuses only the SDK's app-sdk channel, restores the prototype and passes other channels through", async () => {
  const Fallback = fallbackClass();
  const original = connectDescriptor(Fallback);
  const bridged = observeSdkConnection({ connect: async () => channel }, Fallback);
  assert.deepEqual(connectDescriptor(Fallback), original, "A present bridge never patches the fallback class");
  assert.ok(bridged);
  const shared = observeSdkConnection(undefined, Fallback);
  assert.notEqual(Fallback.prototype.connect, original.value);
  const host = new Fallback("host");
  await host.connect();
  assert.notEqual(Fallback.prototype.connect, original.value, "Non-SDK channels neither capture nor retire the observer");
  const sdk = new Fallback("app-sdk");
  const sdkPromise = sdk.connect();
  assert.deepEqual(connectDescriptor(Fallback), original, "Restored before the SDK call proceeds");
  assert.equal(await sdkPromise, undefined, "SDK result unchanged");
  assert.equal(await shared(), sdk);
  assert.equal(await shared(), sdk);
  await new Fallback("app-sdk").connect();
  assert.equal(await shared(), sdk, "Only the first SDK channel is captured");
  assert.deepEqual([host.connected, sdk.connected], [1, 1], "Never connects again");
});

test("bridgeless fallback fails safely when protected and keeps SDK connect errors unchanged", async () => {
  const Frozen = fallbackClass();
  Object.freeze(Frozen.prototype);
  const frozen = observeSdkConnection(undefined, Frozen);
  await assert.rejects(frozen(), (error) => error.reason === "fallbackProtected" && error.message.includes("[fallback-protected]"));
  const instance = new Frozen("app-sdk");
  await instance.connect();
  assert.equal(instance.connected, 1);
  const syncError = new Error("private sync handshake");
  const Throwing = fallbackClass(() => { throw syncError; });
  const thrown = observeSdkConnection(undefined, Throwing);
  assert.throws(() => new Throwing("app-sdk").connect(), (error) => error === syncError);
  await assert.rejects(thrown(), (error) => error.reason === "handshake" && !error.message.includes("private"));
  const asyncError = new Error("private async handshake");
  const Rejecting = fallbackClass(async () => { throw asyncError; });
  const rejected = observeSdkConnection(undefined, Rejecting);
  await assert.rejects(new Rejecting("app-sdk").connect(), (error) => error === asyncError);
  globalThis.nativePreviewHarness.get = rejected;
  await assert.rejects(invoke(), (error) => error.code === "connection" && error.message.includes("[handshake-failed]"));
  assert.equal(channel.send.mock.callCount(), 0);
});

test("fallback handshake rejection before any native request: no unhandled rejection, SDK error unchanged, later diagnostic", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const sdkError = new Error("private fallback handshake");
    const Rejecting = fallbackClass(() => Promise.reject(sdkError));
    const shared = observeSdkConnection(undefined, Rejecting);
    const sdkCall = new Rejecting("app-sdk").connect();
    await assert.rejects(sdkCall, (error) => error === sdkError, "SDK caller sees its own error");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    globalThis.nativePreviewHarness.get = shared;
    await assert.rejects(invoke(), (error) => error.code === "connection" &&
      error.message.includes("[handshake-failed]") && !error.message.includes("private"));
    assert.equal(channel.send.mock.callCount(), 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("bridgeless observer retires after its bounded window (late bridge / no fallback) and on first lookup", async () => {
  const Fallback = fallbackClass();
  const original = connectDescriptor(Fallback);
  const shared = observeSdkConnection(undefined, Fallback);
  mock.timers.tick(FALLBACK_OBSERVATION_MS - 1);
  assert.notEqual(Fallback.prototype.connect, original.value);
  mock.timers.tick(1);
  assert.deepEqual(connectDescriptor(Fallback), original, "Never stays installed indefinitely");
  await new Fallback("app-sdk").connect();
  await assert.rejects(shared(), (error) => error.reason === "fallbackMissed" && error.message.includes("[fallback-not-captured]"));
  const Looked = fallbackClass();
  const lookedOriginal = connectDescriptor(Looked);
  const looked = observeSdkConnection(undefined, Looked);
  await assert.rejects(looked(), (error) => error.reason === "fallbackMissed");
  assert.deepEqual(connectDescriptor(Looked), lookedOriginal, "A lookup before capture retires the observer");
  await new Looked("app-sdk").connect();
  await assert.rejects(looked(), (error) => error.reason === "fallbackMissed");
});

test("bridgeless observer never overwrites another party's later replacement when it retires", async () => {
  for (const retireBy of ["timeout", "capture"]) {
    const Fallback = fallbackClass();
    const shared = observeSdkConnection(undefined, Fallback);
    const ours = Fallback.prototype.connect;
    const replacement = mock.fn(function (...args) { return ours.apply(this, args); });
    Fallback.prototype.connect = replacement;
    const sdk = new Fallback("app-sdk");
    if (retireBy === "timeout") mock.timers.tick(FALLBACK_OBSERVATION_MS);
    else await sdk.connect();
    assert.equal(Fallback.prototype.connect, replacement, `${retireBy}: replacement left intact`);
    if (retireBy === "timeout") {
      await sdk.connect();
      await assert.rejects(shared(), (error) => error.reason === "fallbackMissed", "Retired wrapper only forwards");
    } else {
      assert.equal(await shared(), sdk);
      await new Fallback("app-sdk").connect();
      assert.equal(await shared(), sdk);
    }
    assert.ok(replacement.mock.callCount() >= 1);
  }
});

test("real SDK MessageChannel fallback: one connection reused for policy monitoring and one POST plus polling", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const original = connectDescriptor(MessagePortChannel);
  const transfers = [];
  let host;
  let sdkChannel;
  let metricReady;
  const metric = new Promise((resolve) => { metricReady = resolve; });
  const receiver = createChannelReceiver();
  receiver.onRequest(Methods.Data.getAppConnections, async () => () => channel.send(Methods.Data.getAppConnections));
  receiver.onRequest(Methods.Http.send, async () => (params) => channel.send(Methods.Http.send, params));
  receiver.onStream(Methods.Telemetry.subscribeMetrics, async () => async function* () { yield await metric; });
  globalThis.window = {
    parent: {
      postMessage(message, targetOrigin, ports) {
        transfers.push({ type: message.type, targetOrigin, ports: ports.length });
        host = new MessagePortChannel(ports[0], { receiver, component: "synthetic-host" });
      },
    },
  };
  const loggerError = mock.method(console, "error", () => {});
  const shared = observeSdkConnection(undefined, MessagePortChannel);
  try {
    const sdkSource = publicImports(await readFile(new URL("../node_modules/@microsoft/managed-apps/dist/internal/sdkChannel.js", import.meta.url), "utf8"))
      .replace(/import \{ APP_SDK_VERSION \} from '\.\.\/version';/, 'const APP_SDK_VERSION = "0.5.11";');
    const sdkUrl = encode(`${sdkSource}\n// fallback`);
    const sdk = await import(sdkUrl);
    const loggerSource = publicImports(await readFile(new URL("../node_modules/@microsoft/managed-apps/dist/telemetry/LoggerManager.js", import.meta.url), "utf8"))
      .replace("'../internal/sdkChannel'", JSON.stringify(sdkUrl));
    const loggerUrl = encode(`${loggerSource}\n// fallback`);
    const monitorSource = publicImports(compile(await readFile(new URL("../src/lib/connector-policy-monitor.ts", import.meta.url), "utf8"))
      .replace('"@microsoft/managed-apps/telemetry"', JSON.stringify(loggerUrl)));
    const monitor = await import(encode(`${monitorSource}\n// fallback`));
    monitor.startConnectorPolicyMonitor();
    sdkChannel = await sdk.getSdkChannel();
    assert.ok(sdkChannel instanceof MessagePortChannel);
    assert.deepEqual(connectDescriptor(MessagePortChannel), original, "Prototype restored after the SDK's connect");
    assert.equal(await shared(), sdkChannel);
    assert.equal(await sdk.getSdkChannel(), sdkChannel);
    assert.deepEqual(transfers, [{ type: transfers[0].type, targetOrigin: "*", ports: 1 }], "Exactly one SDK port transfer");
    globalThis.nativePreviewHarness.get = shared;
    const pending = invoke();
    for (let i = 0; i < 20 && httpCalls.length < 1; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(httpCalls.length, 1);
    // Responses cross a real MessagePort, so advance fake time only after the poll delay is scheduled.
    for (let i = 0; i < 100 && httpCalls.length < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1000);
    }
    assert.deepEqual(await pending, { conversationId: ID, result: "A completed native answer" });
    assert.deepEqual(httpCalls.map((call) => call.method), ["POST", "GET"]);
    assert.equal(httpCalls[1].url, LOCATION);
    assert.equal(transfers.length, 1, "No second channel");
    metricReady({ type: "networkRequest", data: { statusCode: 442, url: `${RUNTIME}/connection` } });
    for (let i = 0; i < 20 && !monitor.getConnectorPolicyBlock().blocked; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(monitor.getConnectorPolicyBlock().blocked, true);
    assert.deepEqual(monitor.getConnectorPolicyBlock().connectors, ["agentnode"]);
    assert.ok(loggerError.mock.callCount() >= 1);
  } finally {
    Object.defineProperty(MessagePortChannel.prototype, "connect", original);
    sdkChannel?.close?.();
    host?.close?.();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete globalThis.window;
  }
});
