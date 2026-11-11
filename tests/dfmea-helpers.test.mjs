import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { CONVERSATION, NEXT_CONVERSATION, rpcResult, toolResult } from "./mcp-fixture.mjs";
import { agentNodeReply, agentNodeService, nativeAgentMock } from "./agentnode-fixture.mjs";

const service = agentNodeService();
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => [{ action: "Test", type: "Detection", rationale: "Evidence" }]),
  WorkIqConnectorError: class extends Error {},
  WorkIqResponseError: class extends Error {},
};
globalThis.helperTestNative = nativeAgentMock(service);
globalThis.helperTestWorkiq = workiq;
const source = await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{([^}]+)\} from "\.\/agentnode-preview";/, "const {$1} = globalThis.helperTestNative;")
  .replace(/import \{([\s\S]*?)\} from "@\/connectors\/workiq-copilot-chat";/, "const {$1} = globalThis.helperTestWorkiq;");
const { DFMEA_HELPERS, HELPER_ENVIRONMENT, HelperSession, parseMcpResult, parseMcpReply, parseAgentNodeReply, helperErrorMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis.helperTestNative;
delete globalThis.helperTestWorkiq;

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => {
  Object.assign(service, agentNodeService());
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  workiq.callWorkIqCopilotChatText.mock.mockImplementation(async () => "Work IQ answer");
  workiq.callWorkIqCopilotChatItems.mock.resetCalls();
  mock.timers.reset();
});

test("Work IQ remains default and keeps existing structured request path", async () => {
  const session = new HelperSession();
  assert.equal(await session.text("Question"), "Work IQ answer");
  assert.equal((await session.items("Actions", { action: "string", type: "string", rationale: "string" })).kind, "rows");
  for (const method of Object.values(service)) assert.equal(method.mock.callCount(), 0);
});

test("all three FRE specialists use the generated native operation with the exact environment and no email escalation", async () => {
  assert.equal(HELPER_ENVIRONMENT, "75660de8-d408-e9ce-bc60-84d4f6a30d0b");
  assert.deepEqual(DFMEA_HELPERS.slice(1).map((helper) => helper.schemaName), [
    "Default_Failure_Mode_Identifier_20cdd7", "Default_Failure_Risk_Prioritizer_5a9a6a", "Default_Corrective_Action_Advisor_7867b1",
  ]);
  const session = new HelperSession();
  for (const helper of DFMEA_HELPERS.slice(1)) {
    session.select(helper.id);
    assert.equal(await session.text("Read-only DFMEA question"), "Specialist answer");
    assert.deepEqual(service.InvokeAgent.mock.calls.at(-1).arguments, [{
      agentId: helper.schemaName, prompt: "Read-only DFMEA question", isHitlEscalationEnabled: false,
    }, undefined, HELPER_ENVIRONMENT]);
  }
  assert.equal(service.InvokeAgent.mock.callCount(), 3);
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("conversation continues within a helper and never crosses a switch or reset", async () => {
  const session = new HelperSession();
  session.select("risk");
  await session.text("First");
  await session.text("Follow up");
  assert.equal(service.InvokeAgent.mock.calls[1].arguments[1], CONVERSATION);
  assert.equal(service.InvokeAgent.mock.callCount(), 2);
  session.select("actions");
  await session.text("Different helper");
  assert.equal(service.InvokeAgent.mock.calls[2].arguments[1], undefined);
  session.select("actions");
  await session.text("New conversation");
  assert.equal(service.InvokeAgent.mock.calls[3].arguments[1], undefined);
});

test("switch during native invocation drops late results and retains the single-flight gate", async () => {
  const pending = deferred();
  const session = new HelperSession();
  session.select("risk");
  service.InvokeAgent = mock.fn(() => pending.promise);
  const old = session.text("Old");
  session.select("actions");
  await assert.rejects(session.text("New"), (error) => error.code === "busy");
  pending.resolve(agentNodeReply("Old answer"));
  await assert.rejects(old, (error) => error.code === "stale");
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  Object.assign(service, agentNodeService());
  await session.text("New");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("reset during native invocation cannot save a late conversation or overlap requests", async () => {
  const pending = deferred();
  service.InvokeAgent = mock.fn(() => pending.promise);
  const session = new HelperSession();
  session.select("risk");
  const old = session.text("Old");
  await new Promise(setImmediate);
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  session.select("risk");
  await assert.rejects(session.text("New"), (error) => error.code === "busy");
  pending.resolve(agentNodeReply("Late"));
  await assert.rejects(old, (error) => error.code === "stale");
  Object.assign(service, agentNodeService());
  await session.text("New");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("native timeout fires at three minutes, retains upstream gate until settlement and drops late conversation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const session = new HelperSession();
  session.select("failure-modes");
  service.InvokeAgent = mock.fn(() => pending.promise);
  const request = session.text("Question");
  let settled = false;
  void request.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(request, (error) => error.code === "timeout");
  mock.timers.tick(179_999);
  await new Promise(setImmediate);
  assert.equal(settled, false, "The native request must remain pending before the three-minute limit");
  mock.timers.tick(1);
  await rejected;
  await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
  pending.resolve(agentNodeReply("Late"));
  await new Promise(setImmediate);
  await assert.rejects(session.text("Retry without reset"), (error) => error.requiresNewConversation === true);
  session.select("failure-modes");
  Object.assign(service, agentNodeService());
  await session.text("Retry");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("Work IQ retains its existing 30-second ceiling instead of adopting native polling's limit", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  workiq.callWorkIqCopilotChatText.mock.mockImplementation(() => pending.promise);
  const session = new HelperSession();
  const request = session.text("Question");
  let settled = false;
  void request.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(request, (error) => error.code === "timeout" && /30-second/.test(error.message));
  mock.timers.tick(29_999);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  mock.timers.tick(1);
  await rejected;
  await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
  pending.resolve("Late answer");
  await new Promise(setImmediate);
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
});

test("a dispatched native timeout stays ambiguous across selection without locking the next Work IQ conversation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  service.InvokeAgent = mock.fn(() => pending.promise);
  const session = new HelperSession();
  session.select("risk");
  const request = session.text("Question");
  const rejected = assert.rejects(request, (error) =>
    error.requiresNewConversation === true && /upstream run may still be active/.test(error.message) &&
    !/No native request was sent/.test(error.message));
  session.select("workiq");
  mock.timers.tick(180_000);
  await rejected;
  pending.resolve(agentNodeReply("Late native reply"));
  await new Promise(setImmediate);
  assert.equal(await session.text("Work IQ question"), "Work IQ answer");
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
});

test("MCP parser accepts SSE notifications/CRLF and JSON, preserves text once and validates conversation", () => {
  const result = toolResult("First\nSecond");
  const event = rpcResult("id", result).data.events;
  const notification = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n';
  assert.equal(parseMcpReply(parseMcpResult({ events: (notification + event).replaceAll("\n", "\r\n") }, "id")).text, "First\nSecond");
  assert.deepEqual(parseMcpReply({ structuredContent: { conversationId: CONVERSATION, response: ["First", "", "Second"] } }),
    { conversationId: CONVERSATION, text: "First\n\nSecond" });
  assert.equal(parseMcpReply(parseMcpResult({ events: JSON.stringify({ jsonrpc: "2.0", id: "id", result }) }, "id"), CONVERSATION).text, "First\nSecond");
  assert.throws(() => parseMcpReply(result, NEXT_CONVERSATION), (error) => error.code === "format");
});

test("MCP parser rejects oversized, malformed, missing, duplicate and wrong-id final responses", () => {
  const event = rpcResult("id", toolResult()).data.events;
  for (const data of [null, {}, { events: "" }, { events: "x".repeat(524289) }, { events: "data: invalid\n\n" },
    { events: event + event }, { events: rpcResult("other", {}).data.events }, { events: '{"jsonrpc":"2.0","id":"id","result":{},"error":{}}' },
    { events: '{"jsonrpc":"2.0","method":"notifications/message"}' }]) {
    assert.throws(() => parseMcpResult(data, "id"), (error) => error.code === "format");
  }
  for (const result of [{}, { content: [] }, toolResult("", CONVERSATION), toolResult("Answer", "not-a-guid"),
    { structuredContent: { conversationId: CONVERSATION, response: [42] } }]) {
    assert.throws(() => parseMcpReply(result), (error) => error.code === "format");
  }
  assert.throws(() => parseMcpResult({ events: '{"jsonrpc":"2.0","id":"id","error":{"message":"private"}}' }, "id"),
    (error) => error.code === "connection" && !error.message.includes("private"));
});

test("agent failures never fall back to Work IQ or leak upstream details", async () => {
  const session = new HelperSession();
  session.select("risk");
  for (const response of [async () => ({ success: false, error: "private token" }), async () => { throw new Error("private token"); }]) {
    session.select("risk");
    service.InvokeAgent = mock.fn(response);
    await assert.rejects(session.text("Question"), (error) => error.code === "connection" && !helperErrorMessage(error).includes("private"));
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("native environment-policy and unsupported-harness replies are errors, never suggestions", async () => {
  const session = new HelperSession();
  session.select("actions");
  for (const [result, code] of [
    [agentNodeReply("EnvironmentGroupPolicyViolation: private details"), "policy"],
    [agentNodeReply("This action doesn't support agents built with the GitHub Copilot harness. Learn more"), "unsupported"],
  ]) {
    session.select("actions");
    service.InvokeAgent = mock.fn(async () => result);
    await assert.rejects(session.items("Actions", { action: "string", type: "string", rationale: "string" }), (error) => error.code === code);
    assert.equal(service.InvokeAgent.mock.calls.at(-1).arguments[1], undefined);
  }
  assert.equal(workiq.callWorkIqCopilotChatItems.mock.callCount(), 0);
});

test("native parser accepts only a complete bounded 201 result and matching GUID continuity", () => {
  assert.deepEqual(parseAgentNodeReply(agentNodeReply(" Answer ").data),
    { text: "Answer", conversationId: CONVERSATION });
  assert.equal(parseAgentNodeReply(agentNodeReply().data, CONVERSATION).conversationId, CONVERSATION);
  assert.equal(parseAgentNodeReply({ ...agentNodeReply().data, status: "Completed" }).conversationId, CONVERSATION);
  for (const status of ["Running", "Failed", "Cancelled", "completed", null, 200]) {
    assert.throws(() => parseAgentNodeReply({ ...agentNodeReply().data, status }), (error) => error.code === "format");
  }
  for (const data of [undefined, null, {}, { conversationId: CONVERSATION }, agentNodeReply("").data,
    agentNodeReply("x".repeat(524289)).data, agentNodeReply("Answer", "invalid").data,
    { conversationId: CONVERSATION, result: 42 }, { conversationId: CONVERSATION, message: "Wrong envelope" }]) {
    assert.throws(() => parseAgentNodeReply(data), (error) => error.code === "format");
  }
  assert.throws(() => parseAgentNodeReply(agentNodeReply().data, NEXT_CONVERSATION), (error) => error.code === "format");
});

test("incomplete native turns require explicit reset instead of silently clearing conversation continuity", async () => {
  const session = new HelperSession();
  session.select("risk");
  await session.text("First");
  service.InvokeAgent = mock.fn(async () => ({ success: true, data: { conversationId: CONVERSATION } }));
  await assert.rejects(session.items("Question", { action: "string" }), (error) => error.code === "format");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], CONVERSATION);
  await assert.rejects(session.text("No implicit reset"), (error) => error.requiresNewConversation === true);
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  session.select("risk");
  Object.assign(service, agentNodeService());
  await session.text("New");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("Work IQ failures remain retryable without a native new-conversation gate", async () => {
  const session = new HelperSession();
  workiq.callWorkIqCopilotChatText.mock.mockImplementationOnce(async () => { throw new Error("Synthetic Work IQ failure"); });
  await assert.rejects(session.text("Question"), /Synthetic Work IQ failure/);
  assert.equal(session.requiresNewConversation, false);
  assert.equal(await session.text("Question"), "Work IQ answer");
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 2);
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
});

test("only complete validated rows become suggestions; clarification stays non-applicable text", async () => {
  const session = new HelperSession();
  session.select("actions");
  const schema = { action: "string", type: "string", rationale: "string" };
  service.InvokeAgent = mock.fn(async () => agentNodeReply('```json\n[{"action":"Add test","type":"Detection","rationale":"Find faults","extra":"untrusted"}]\n```'));
  assert.deepEqual(await session.items("Suggest actions", schema), {
    kind: "rows", items: [{ action: "Add test", type: "Detection", rationale: "Find faults" }],
  });
  for (const text of ["What controls exist?", '[{"action":"Valid","type":"Detection","rationale":"Evidence"}, {"action":"Incomplete"}]', '[{"action":"","type":"Detection","rationale":"Evidence"}]', '[{"action":"Review design","type":"Mitigation","rationale":"Evidence"}]']) {
    service.InvokeAgent = mock.fn(async () => agentNodeReply(text));
    assert.deepEqual(await session.items("Suggest actions", schema), { kind: "clarification", text });
  }
});
