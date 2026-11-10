import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const service = { ExecuteCopilotAsyncV2: mock.fn() };
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => [{ action: "Test", type: "Detection", rationale: "Evidence" }]),
  WorkIqConnectorError: class extends Error {},
  WorkIqResponseError: class extends Error {},
};
globalThis.helperTestService = service;
globalThis.helperTestWorkiq = workiq;
const source = await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{ MicrosoftCopilotStudioService \} from "\.\.\/\.\.\/generated";/, "const MicrosoftCopilotStudioService = globalThis.helperTestService;")
  .replace(/import \{([\s\S]*?)\} from "@\/connectors\/workiq-copilot-chat";/, "const {$1} = globalThis.helperTestWorkiq;");
const { DFMEA_HELPERS, HELPER_ENVIRONMENT, HelperSession, parseStudioReply, helperErrorMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis.helperTestService;
delete globalThis.helperTestWorkiq;

const reply = (text = "Agent answer", id = "conversation-one") => ({ success: true, data: { responses: [text], lastResponse: text, conversationId: id } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => {
  service.ExecuteCopilotAsyncV2 = mock.fn();
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  workiq.callWorkIqCopilotChatItems.mock.resetCalls();
  mock.timers.reset();
});

test("Work IQ remains default and keeps existing structured request path", async () => {
  const session = new HelperSession();
  assert.equal(await session.text("Question"), "Work IQ answer");
  assert.equal((await session.items("Actions", { action: "string", type: "string", rationale: "string" })).kind, "rows");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.callCount(), 0);
});

test("all three specialists use exact discovered schema names and the target environment", async () => {
  const session = new HelperSession();
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply());
  for (const helper of DFMEA_HELPERS.slice(1)) {
    session.select(helper.id);
    assert.equal(await session.text("Read-only DFMEA question"), "Agent answer");
    const args = service.ExecuteCopilotAsyncV2.mock.calls.at(-1).arguments;
    assert.deepEqual(args, [helper.schemaName, { message: "Read-only DFMEA question" }, undefined, HELPER_ENVIRONMENT]);
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("conversation continues within a helper and never crosses a switch or reset", async () => {
  const session = new HelperSession();
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply());
  session.select("risk");
  await session.text("First");
  await session.text("Follow up");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[1].arguments[2], "conversation-one");
  session.select("actions");
  await session.text("Different helper");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[2].arguments[2], undefined);
  session.select("actions");
  await session.text("New conversation");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[3].arguments[2], undefined);
});

test("switch ignores late results and prevents overlapping upstream calls", async () => {
  const pending = deferred();
  const session = new HelperSession();
  session.select("risk");
  service.ExecuteCopilotAsyncV2 = mock.fn(() => pending.promise);
  const old = session.text("Old");
  session.select("actions");
  await assert.rejects(session.text("New"), (error) => error.code === "busy");
  pending.resolve(reply("Old answer", "old-conversation"));
  await assert.rejects(old, (error) => error.code === "stale");
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply());
  await session.text("New");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[0].arguments[2], undefined);
});

test("bounded timeout does not pretend the upstream operation was cancelled", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const session = new HelperSession();
  session.select("failure-modes");
  service.ExecuteCopilotAsyncV2 = mock.fn(() => pending.promise);
  const request = session.text("Question");
  const rejected = assert.rejects(request, (error) => error.code === "timeout");
  mock.timers.tick(30_001);
  await rejected;
  await assert.rejects(session.text("Too soon"), (error) => error.code === "busy");
  pending.resolve(reply());
  await Promise.resolve();
  await Promise.resolve();
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply());
  await session.text("Retry");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[0].arguments[2], undefined);
});

test("response parsing preserves ordered messages without duplicating lastResponse", () => {
  assert.equal(parseStudioReply({ responses: ["First", "", "Second"], lastResponse: "Second", conversationId: "c" }).text, "First\n\nSecond");
  assert.equal(parseStudioReply({ lastResponse: "Only", conversationId: "c" }).text, "Only");
  for (const data of [null, {}, { responses: [42], conversationId: "c" }, { responses: [], conversationId: "c" }, { lastResponse: "Answer", conversationId: "" }]) {
    assert.throws(() => parseStudioReply(data), (error) => error.code === "format");
  }
});

test("agent failures never fall back to Work IQ or leak upstream details", async () => {
  const session = new HelperSession();
  session.select("risk");
  for (const response of [async () => ({ success: false, error: "private token" }), async () => { throw new Error("private token"); }]) {
    service.ExecuteCopilotAsyncV2 = mock.fn(response);
    await assert.rejects(session.text("Question"), (error) => error.code === "connection" && !helperErrorMessage(error).includes("private"));
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});

test("only complete validated rows become suggestions; clarification stays non-applicable text", async () => {
  const session = new HelperSession();
  session.select("actions");
  const schema = { action: "string", type: "string", rationale: "string" };
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply('```json\n[{"action":"Add test","type":"Detection","rationale":"Find faults","extra":"untrusted"}]\n```'));
  assert.deepEqual(await session.items("Suggest actions", schema), {
    kind: "rows", items: [{ action: "Add test", type: "Detection", rationale: "Find faults" }],
  });
  for (const text of ["What controls exist?", '[{"action":"Valid","type":"Detection","rationale":"Evidence"}, {"action":"Incomplete"}]', '[{"action":"","type":"Detection","rationale":"Evidence"}]', '[{"action":"Review design","type":"Mitigation","rationale":"Evidence"}]']) {
    service.ExecuteCopilotAsyncV2 = mock.fn(async () => reply(text));
    assert.deepEqual(await session.items("Suggest actions", schema), { kind: "clarification", text });
  }
});
