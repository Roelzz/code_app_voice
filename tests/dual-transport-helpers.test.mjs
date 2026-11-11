import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { CONVERSATION, NEXT_CONVERSATION, mcpService, rpcResult, toolCalls } from "./mcp-fixture.mjs";
import { agentNodeReply, agentNodeService, nativeAgentMock } from "./agentnode-fixture.mjs";

const service = agentNodeService();
const mcp = mcpService();
const workiq = {
  WORKIQ_HOST_TIMEOUT_MS: 30_000,
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => [{ action: "Test", type: "Detection", rationale: "Evidence" }]),
  WorkIqConnectorError: class extends Error {},
  WorkIqResponseError: class extends Error {},
};
const native = nativeAgentMock(service);
globalThis.dualTransportHelpers = { native, mcp, workiq };
const source = await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{ DFMEASpecialistMCPService \} from "\.\.\/\.\.\/generated";/, "const DFMEASpecialistMCPService = globalThis.dualTransportHelpers.mcp;")
  .replace(/import \{([^}]+)\} from "\.\/agentnode-transport";/, "const {$1} = globalThis.dualTransportHelpers.native;")
  .replace(/import \{([\s\S]*?)\} from "@\/connectors\/workiq-copilot-chat";/, "const {$1} = globalThis.dualTransportHelpers.workiq;");
const { DFMEA_HELPERS, HELPER_ENVIRONMENT, HelperSession, HelperError, parseAgentNodeReply, helperErrorMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis.dualTransportHelpers;

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => {
  Object.assign(service, agentNodeService());
  Object.assign(mcp, mcpService());
  delete native.channelError;
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  workiq.callWorkIqCopilotChatText.mock.mockImplementation(async () => "Work IQ answer");
  workiq.callWorkIqCopilotChatItems.mock.resetCalls();
  mock.timers.reset();
});

test("MCP is the specialist default and all native specialists require explicit transport selection", async () => {
  const session = new HelperSession();
  assert.equal(session.transport, "mcp");
  session.select("risk");
  await session.text("Default specialist");
  assert.equal(toolCalls(mcp.RiskMcp).length, 1);
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
  session.setTransport("agentnode");
  assert.equal(session.transport, "agentnode");
  assert.equal(HELPER_ENVIRONMENT, "75660de8-d408-e9ce-bc60-84d4f6a30d0b");
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

test("native conversation continues within a helper and never crosses a helper switch or reset", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
  session.select("risk");
  await session.text("First");
  await session.text("Follow up");
  assert.equal(service.InvokeAgent.mock.calls[1].arguments[1], CONVERSATION);
  session.select("actions");
  await session.text("Different helper");
  assert.equal(service.InvokeAgent.mock.calls[2].arguments[1], undefined);
  session.select("actions");
  await session.text("New conversation");
  assert.equal(service.InvokeAgent.mock.calls[3].arguments[1], undefined);
});

test("bidirectional transport changes reset conversation and MCP initialization; selecting the current transport does not", async () => {
  const session = new HelperSession();
  session.select("risk");
  await session.text("MCP first");
  session.setTransport("mcp");
  await session.text("MCP follow up");
  assert.equal(mcp.RiskMcp.mock.callCount(), 4);
  assert.equal(toolCalls(mcp.RiskMcp)[1].params.arguments.conversationId, CONVERSATION);
  session.setTransport("agentnode");
  await session.text("Native first");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  session.setTransport("agentnode");
  await session.text("Native follow up");
  assert.equal(service.InvokeAgent.mock.calls[1].arguments[1], CONVERSATION);
  session.setTransport("mcp");
  await session.text("MCP fresh");
  assert.deepEqual(mcp.RiskMcp.mock.calls.slice(-3).map(({ arguments: [body] }) => body.method),
    ["initialize", "tools/list", "tools/call"]);
  assert.equal(toolCalls(mcp.RiskMcp).at(-1).params.arguments.conversationId, undefined);
  session.setTransport("agentnode");
  await session.text("Native fresh");
  assert.equal(service.InvokeAgent.mock.calls.at(-1).arguments[1], undefined);
});

test("setTransport synchronously refuses busy MCP, native and Work IQ requests without resetting their state", async () => {
  for (const transport of ["mcp", "agentnode", "workiq"]) {
    const pending = deferred();
    const session = new HelperSession();
    if (transport === "workiq") {
      workiq.callWorkIqCopilotChatText.mock.mockImplementationOnce(() => pending.promise);
    } else {
      session.select("risk");
      session.setTransport(transport);
      if (transport === "mcp") Object.assign(mcp, mcpService(() => pending.promise));
      else service.InvokeAgent = mock.fn(() => pending.promise);
    }
    const request = session.text("Pending");
    await new Promise(setImmediate);
    assert.equal(session.isBusy, true);
    const current = session.transport;
    for (const value of ["mcp", "agentnode"]) {
      assert.throws(() => session.setTransport(value), (error) => error instanceof HelperError && error.code === "busy");
      assert.equal(session.transport, current);
    }
    pending.resolve(transport === "mcp" ? {
      structuredContent: { conversationId: CONVERSATION, response: ["Completed"] },
    } : transport === "agentnode" ? agentNodeReply("Completed") : "Completed");
    assert.equal(await request, "Completed");
    assert.equal(session.isBusy, false);
    Object.assign(mcp, mcpService());
    Object.assign(service, agentNodeService());
    if (transport !== "workiq") {
      await session.text("Continue after refusal");
      assert.equal(transport === "mcp" ? toolCalls(mcp.RiskMcp)[0].params.arguments.conversationId :
        service.InvokeAgent.mock.calls[0].arguments[1], CONVERSATION);
    }
  }
});

for (const reset of ["switch", "reset"]) {
  test(`${reset} during native invocation drops late replies and retains the shared single-flight gate`, async () => {
    const pending = deferred();
    service.InvokeAgent = mock.fn(() => pending.promise);
    const session = new HelperSession();
    session.setTransport("agentnode");
    session.select("risk");
    const old = session.text("Old");
    session.select(reset === "switch" ? "actions" : "risk");
    await assert.rejects(session.text("New"), (error) => error.code === "busy");
    pending.resolve(agentNodeReply("Late"));
    await assert.rejects(old, (error) => error.code === "stale");
    Object.assign(service, agentNodeService());
    await session.text("New");
    assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  });
}

for (const transport of ["mcp", "agentnode"]) {
  test(`${transport} uses its exact wait ceiling and retains the upstream gate until settlement`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    const session = new HelperSession();
    session.select("failure-modes");
    session.setTransport(transport);
    if (transport === "mcp") mcp.FailureModeMcp = mock.fn(() => pending.promise);
    else service.InvokeAgent = mock.fn(() => pending.promise);
    const request = session.text("Question");
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(request, (error) => error.code === "timeout");
    mock.timers.tick(180_000 - 1);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    mock.timers.tick(1);
    await rejected;
    assert.equal(session.isBusy, true);
    assert.throws(() => session.setTransport(transport === "mcp" ? "agentnode" : "mcp"), (error) => error.code === "busy");
    await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
    pending.resolve(transport === "mcp" ? rpcResult("old", {}) : agentNodeReply("Late"));
    await new Promise(setImmediate);
    assert.equal(session.isBusy, false);
    if (transport === "agentnode") {
      await assert.rejects(session.text("Retry without reset"), (error) => error.requiresNewConversation === true);
      session.select("failure-modes");
    }
    Object.assign(mcp, mcpService());
    Object.assign(service, agentNodeService());
    await session.text("Retry");
    assert.equal(transport === "mcp" ? toolCalls(mcp.FailureModeMcp)[0].params.arguments.conversationId :
      service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  });
}

for (const transport of ["mcp", "agentnode"]) {
  test(`Work IQ always keeps its 30-second ceiling with ${transport} selected`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    workiq.callWorkIqCopilotChatText.mock.mockImplementationOnce(() => pending.promise);
    const session = new HelperSession();
    session.setTransport(transport);
    const request = session.text("Question");
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(request, (error) => error.code === "timeout" && /30-second/.test(error.message));
    mock.timers.tick(29_999);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    mock.timers.tick(1);
    await rejected;
    assert.equal(session.requiresNewConversation, false);
    await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
    pending.resolve("Late answer");
    await new Promise(setImmediate);
    assert.equal(await session.text("Retry"), "Work IQ answer");
    assert.equal(service.InvokeAgent.mock.callCount(), 0);
    for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
  });
}

test("a dispatched native timeout stays ambiguous across selection without locking the next Work IQ conversation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  service.InvokeAgent = mock.fn(() => pending.promise);
  const session = new HelperSession();
  session.setTransport("agentnode");
  session.select("risk");
  const request = session.text("Question");
  const rejected = assert.rejects(request, (error) => error.requiresNewConversation === true &&
    /upstream run may still be active/.test(error.message) && !/No native request was sent/.test(error.message));
  session.select("workiq");
  mock.timers.tick(180_000);
  await rejected;
  pending.resolve(agentNodeReply("Late native reply"));
  await new Promise(setImmediate);
  assert.equal(session.requiresNewConversation, false);
  assert.equal(await session.text("Work IQ question"), "Work IQ answer");
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
});

test("incomplete native turns require reset but ambiguity never bleeds into MCP or Work IQ", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
  session.select("risk");
  await session.text("First");
  service.InvokeAgent = mock.fn(async () => ({ success: true, data: { conversationId: CONVERSATION } }));
  await assert.rejects(session.items("Question", { action: "string" }), (error) => error.code === "format");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], CONVERSATION);
  assert.equal(session.requiresNewConversation, true);
  await assert.rejects(session.text("No implicit reset"), (error) => error.requiresNewConversation === true);
  session.setTransport("agentnode");
  assert.equal(session.requiresNewConversation, true, "No-op selection must not bypass the native reset gate");
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  session.setTransport("mcp");
  assert.equal(session.requiresNewConversation, false);
  assert.equal(await session.text("MCP"), "Specialist answer");
  assert.equal(toolCalls(mcp.RiskMcp)[0].params.arguments.conversationId, undefined);
  session.select("workiq");
  assert.equal(await session.text("Work IQ"), "Work IQ answer");
  session.setTransport("agentnode");
  session.select("risk");
  Object.assign(service, agentNodeService());
  await session.text("New native");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("native failures never fall back to Work IQ or leak upstream details", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
  for (const response of [async () => ({ success: false, error: "private token" }),
    async () => { throw new Error("private token"); }]) {
    session.select("risk");
    service.InvokeAgent = mock.fn(response);
    await assert.rejects(session.text("Question"), (error) => error.code === "connection" && !helperErrorMessage(error).includes("private"));
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
  for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
});

test("native policy and unsupported-harness replies are errors, never suggestions", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
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

test("native parser accepts only complete bounded results and matching GUID continuity", () => {
  assert.deepEqual(parseAgentNodeReply(agentNodeReply(" Answer ").data), { text: "Answer", conversationId: CONVERSATION });
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

test("Work IQ structured path and failures stay retryable even with native transport selected", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
  workiq.callWorkIqCopilotChatText.mock.mockImplementationOnce(async () => { throw new Error("Synthetic Work IQ failure"); });
  await assert.rejects(session.text("Question"), /Synthetic Work IQ failure/);
  assert.equal(session.requiresNewConversation, false);
  assert.equal(await session.text("Question"), "Work IQ answer");
  assert.equal((await session.items("Actions", { action: "string", type: "string", rationale: "string" })).kind, "rows");
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
});

test("only complete native rows become suggestions; clarification stays non-applicable text", async () => {
  const session = new HelperSession();
  session.setTransport("agentnode");
  session.select("actions");
  const schema = { action: "string", type: "string", rationale: "string" };
  service.InvokeAgent = mock.fn(async () => agentNodeReply('```json\n[{"action":"Add test","type":"Detection","rationale":"Find faults","extra":"untrusted"}]\n```'));
  assert.deepEqual(await session.items("Suggest actions", schema), {
    kind: "rows", items: [{ action: "Add test", type: "Detection", rationale: "Find faults" }],
  });
  for (const text of ["What controls exist?", '[{"action":"Valid","type":"Detection","rationale":"Evidence"}, {"action":"Incomplete"}]',
    '[{"action":"","type":"Detection","rationale":"Evidence"}]', '[{"action":"Review design","type":"Mitigation","rationale":"Evidence"}]']) {
    service.InvokeAgent = mock.fn(async () => agentNodeReply(text));
    assert.deepEqual(await session.items("Suggest actions", schema), { kind: "clarification", text });
  }
});
