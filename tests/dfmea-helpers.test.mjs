import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { CONVERSATION, NEXT_CONVERSATION, mcpService, rpcResult, toolResult, toolCalls } from "./mcp-fixture.mjs";
import { agentNodeService, nativeAgentMock } from "./agentnode-fixture.mjs";

const service = mcpService();
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => [{ action: "Test", type: "Detection", rationale: "Evidence" }]),
  WorkIqConnectorError: class extends Error {},
  WorkIqResponseError: class extends Error {},
};
globalThis.helperTestService = service;
globalThis.helperTestWorkiq = workiq;
globalThis.helperTestNative = nativeAgentMock(agentNodeService());
const source = await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{([^}]+)\} from "\.\/agentnode-transport";/, "const {$1} = globalThis.helperTestNative;")
  .replace(/import \{ DFMEASpecialistMCPService \} from "\.\.\/\.\.\/generated";/, "const DFMEASpecialistMCPService = globalThis.helperTestService;")
  .replace(/import \{([\s\S]*?)\} from "@\/connectors\/workiq-copilot-chat";/, "const {$1} = globalThis.helperTestWorkiq;");
const { DFMEA_HELPERS, HELPER_ENVIRONMENT, HelperSession, parseMcpResult, parseMcpReply, helperErrorMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis.helperTestService;
delete globalThis.helperTestWorkiq;
delete globalThis.helperTestNative;

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => {
  Object.assign(service, mcpService());
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  workiq.callWorkIqCopilotChatItems.mock.resetCalls();
  mock.timers.reset();
});

test("Work IQ remains default and keeps existing structured request path", async () => {
  const session = new HelperSession();
  assert.equal(await session.text("Question"), "Work IQ answer");
  assert.equal((await session.items("Actions", { action: "string", type: "string", rationale: "string" })).kind, "rows");
  for (const method of Object.values(service)) assert.equal(method.mock.callCount(), 0);
});

test("all three FRE specialists use separate generated operations and MCP initialization", async () => {
  assert.equal(HELPER_ENVIRONMENT, "75660de8-d408-e9ce-bc60-84d4f6a30d0b");
  assert.deepEqual(DFMEA_HELPERS.slice(1).map((helper) => helper.schemaName), [
    "Default_Failure_Mode_Identifier_20cdd7", "Default_Failure_Risk_Prioritizer_5a9a6a", "Default_Corrective_Action_Advisor_7867b1",
  ]);
  const session = new HelperSession();
  for (const [index, method] of Object.values(service).entries()) {
    session.select(DFMEA_HELPERS[index + 1].id);
    assert.equal(await session.text("Read-only DFMEA question"), "Specialist answer");
    const requests = method.mock.calls.map(({ arguments: [body] }) => body);
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "tools/list", "tools/call"]);
    assert.equal(requests[0].params.protocolVersion, "2025-03-26");
    assert.deepEqual(requests[2].params, { name: "send-message", arguments: { message: "Read-only DFMEA question" } });
    assert.equal(new Set(requests.filter((request) => request.id).map((request) => request.id)).size, 3);
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("conversation continues within a helper and never crosses a switch or reset", async () => {
  const session = new HelperSession();
  session.select("risk");
  await session.text("First");
  await session.text("Follow up");
  assert.equal(toolCalls(service.RiskMcp)[1].params.arguments.conversationId, CONVERSATION);
  assert.equal(service.RiskMcp.mock.callCount(), 4, "Initialize once, then two tool calls");
  session.select("actions");
  await session.text("Different helper");
  assert.equal(toolCalls(service.ActionMcp)[0].params.arguments.conversationId, undefined);
  session.select("actions");
  await session.text("New conversation");
  assert.equal(toolCalls(service.ActionMcp)[1].params.arguments.conversationId, undefined);
});

test("switch during handshake drops late results and never starts the old agent question", async () => {
  const pending = deferred();
  const session = new HelperSession();
  session.select("risk");
  service.RiskMcp = mock.fn(() => pending.promise);
  const old = session.text("Old");
  session.select("actions");
  await assert.rejects(session.text("New"), (error) => error.code === "busy");
  pending.resolve(rpcResult("old", {}));
  await assert.rejects(old, (error) => error.code === "stale");
  assert.equal(service.RiskMcp.mock.callCount(), 1);
  await session.text("New");
  assert.equal(toolCalls(service.ActionMcp)[0].params.arguments.conversationId, undefined);
});

test("switch during tool execution cannot save a late conversation or overlap requests", async () => {
  const pending = deferred();
  Object.assign(service, mcpService(() => pending.promise));
  const session = new HelperSession();
  session.select("risk");
  const old = session.text("Old");
  await new Promise(setImmediate);
  assert.equal(toolCalls(service.RiskMcp).length, 1);
  session.select("actions");
  await assert.rejects(session.text("New"), (error) => error.code === "busy");
  pending.resolve(toolResult("Late"));
  await assert.rejects(old, (error) => error.code === "stale");
  Object.assign(service, mcpService());
  await session.text("New");
  assert.equal(toolCalls(service.ActionMcp)[0].params.arguments.conversationId, undefined);
});

test("bounded timeout holds upstream gate until settlement and invalidates handshake", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const session = new HelperSession();
  session.select("failure-modes");
  service.FailureModeMcp = mock.fn(() => pending.promise);
  const request = session.text("Question");
  const rejected = assert.rejects(request, (error) => error.code === "timeout");
  mock.timers.tick(30_001);
  await rejected;
  await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
  pending.resolve(rpcResult("old", {}));
  await new Promise(setImmediate);
  Object.assign(service, mcpService());
  await session.text("Retry");
  assert.equal(toolCalls(service.FailureModeMcp)[0].params.arguments.conversationId, undefined);
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
    service.RiskMcp = mock.fn(response);
    await assert.rejects(session.text("Question"), (error) => error.code === "connection" && !helperErrorMessage(error).includes("private"));
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("HTTP200 tool and environment-policy failures are errors, never clarification or suggestions", async () => {
  const session = new HelperSession();
  session.select("actions");
  for (const [result, code] of [
    [{ isError: true, content: [{ type: "text", text: "private details" }] }, "connection"],
    [toolResult("EnvironmentGroupPolicyViolation: private details"), "policy"],
    [{ content: [{ type: "text", text: "EnvironmentGroupPolicyViolation" }] }, "policy"],
    [toolResult("This action doesn't support agents built with the GitHub Copilot harness. Learn more"), "unsupported"],
  ]) {
    Object.assign(service, mcpService(async () => result));
    await assert.rejects(session.items("Actions", { action: "string", type: "string", rationale: "string" }), (error) => error.code === code);
    assert.equal(toolCalls(service.ActionMcp)[0].params.arguments.conversationId, undefined);
  }
  assert.equal(workiq.callWorkIqCopilotChatItems.mock.callCount(), 0);
});

test("protocol/tool incompatibility stops before a specialist question", async () => {
  const session = new HelperSession();
  session.select("risk");
  service.RiskMcp = mock.fn(async (request) => rpcResult(request.id, { protocolVersion: "unsupported", capabilities: { tools: {} } }));
  await assert.rejects(session.text("Question"), (error) => error.code === "format");
  assert.equal(toolCalls(service.RiskMcp).length, 0);
  service.RiskMcp = mock.fn(async (request) => rpcResult(request.id,
    request.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } } : { tools: [] }));
  await assert.rejects(session.text("Question"), (error) => error.code === "unsupported");
  assert.equal(toolCalls(service.RiskMcp).length, 0);
});

test("only complete validated rows become suggestions; clarification stays non-applicable text", async () => {
  const session = new HelperSession();
  session.select("actions");
  const schema = { action: "string", type: "string", rationale: "string" };
  Object.assign(service, mcpService(async () => toolResult('```json\n[{"action":"Add test","type":"Detection","rationale":"Find faults","extra":"untrusted"}]\n```')));
  assert.deepEqual(await session.items("Suggest actions", schema), {
    kind: "rows", items: [{ action: "Add test", type: "Detection", rationale: "Find faults" }],
  });
  for (const text of ["What controls exist?", '[{"action":"Valid","type":"Detection","rationale":"Evidence"}, {"action":"Incomplete"}]', '[{"action":"","type":"Detection","rationale":"Evidence"}]', '[{"action":"Review design","type":"Mitigation","rationale":"Evidence"}]']) {
    Object.assign(service, mcpService(async () => toolResult(text)));
    assert.deepEqual(await session.items("Suggest actions", schema), { kind: "clarification", text });
  }
});
