import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import ts from "typescript";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONVERSATION, NEXT_CONVERSATION, mcpService, toolCalls, toolResult } from "./mcp-fixture.mjs";
import { agentNodeReply, agentNodeService, nativeAgentMock } from "./agentnode-fixture.mjs";

const service = agentNodeService();
const mcp = mcpService();
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => []),
};
let voiceOptions;
const stopVoice = mock.fn();
const stopSpeaking = mock.fn();
const speak = mock.fn();
globalThis.dualTransportIntegration = {
  mcp, native: nativeAgentMock(service), workiq, stopSpeaking, speak,
  useVoice: (options) => {
    voiceOptions = options;
    return { status: "idle", activity: "listening", error: null, start: mock.fn(), stop: stopVoice };
  },
};
const modules = new Map();
const encode = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function load(path) {
  if (modules.has(path)) return modules.get(path);
  if (path === "lib/connector-policy-monitor") return encode("export const CONNECTOR_POLICY_STATUS=442;");
  if (path === "connectors/workiq-copilot-chat") {
    const url = encode(`export const {callWorkIqCopilotChatText,callWorkIqCopilotChatItems}=globalThis.dualTransportIntegration.workiq;
      export const WORKIQ_HOST_TIMEOUT_MS=30000;
      export class WorkIqResponseError extends Error {}
      export class WorkIqConnectorError extends WorkIqResponseError {}
      export class WorkIqTimeoutError extends WorkIqConnectorError {}
      export class WorkIqToolError extends WorkIqResponseError {}`);
    modules.set(path, url);
    return url;
  }
  if (path === "hooks/use-realtime-voice") return encode("export const useRealtimeVoice=globalThis.dualTransportIntegration.useVoice;");
  if (path === "hooks/use-voice") return encode(`
    export const speechOutputSupported=()=>true;
    export const useSpeechReader=()=>({speaking:false,speak:globalThis.dualTransportIntegration.speak,stop:globalThis.dualTransportIntegration.stopSpeaking});
    export const useDictation=()=>({listening:false,start:()=>{},stop:()=>{}});
  `);
  let source;
  try { source = await readFile(new URL(`../src/${path}.tsx`, import.meta.url), "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    source = await readFile(new URL(`../src/${path}.ts`, import.meta.url), "utf8");
  }
  source = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  for (const [, name] of [...source.matchAll(/from "(@\/[^"]+)"/g)]) {
    source = source.replaceAll(`"${name}"`, JSON.stringify(await load(name.slice(2))));
  }
  source = source
    .replace(/import \{ DFMEASpecialistMCPService \} from "\.\.\/\.\.\/generated";/,
      "const DFMEASpecialistMCPService=globalThis.dualTransportIntegration.mcp;")
    .replace(/import \{([^}]+)\} from "\.\/agentnode-transport";/,
      "const {$1}=globalThis.dualTransportIntegration.native;");
  for (const [, name] of [...source.matchAll(/from "(\.[^"]+)"/g)]) {
    source = source.replaceAll(`"${name}"`, JSON.stringify(await load(posix.normalize(posix.join(posix.dirname(path), name)))));
  }
  source = source.replace(/from "([^"]+)"/g, (match, name) => name.startsWith("data:") ? match : `from ${JSON.stringify(import.meta.resolve(name))}`);
  if (!/import \* as React/.test(source)) source = `import React from ${JSON.stringify(import.meta.resolve("react"))};\n${source}`;
  const url = encode(source);
  modules.set(path, url);
  return url;
}

let window, saved, root, client, addChain, addAction;
beforeEach(async () => {
  window = new Window({ url: "http://localhost:5173" });
  saved = new Map();
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "window" ? window : name === "getComputedStyle" ? window[name].bind(window) : window[name];
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  Object.assign(service, agentNodeService());
  Object.assign(mcp, mcpService());
  delete globalThis.dualTransportIntegration.native.channelError;
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  workiq.callWorkIqCopilotChatText.mock.mockImplementation(async () => "Work IQ answer");
  stopVoice.mock.resetCalls();
  stopSpeaking.mock.resetCalls();
  speak.mock.resetCalls();
  const { AiFacilitator } = await import(await load("components/ai-facilitator"));
  const { SAMPLE_DFMEA } = await import(await load("data/dfmea"));
  const data = structuredClone(SAMPLE_DFMEA);
  addChain = mock.fn();
  addAction = mock.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(AiFacilitator, {
      data, elementId: data.elements[0].id, causeId: data.causes[0].id,
      onAddFailureChain: addChain, onAddAction: addAction, requestRealtimeToken: async () => ({}),
    }))));
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  await window.happyDOM.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const button = (label) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}
async function click(label) {
  const target = button(label);
  assert.ok(target, `Button ${label} exists`);
  await act(async () => { target.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
  await flush();
}
async function select(name) {
  const trigger = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("Selected helper"));
  assert.equal(trigger.disabled, false);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('[aria-pressed]')].find((item) => item.textContent.startsWith(name));
  assert.ok(option);
  await act(async () => option.click());
  assert.match(document.activeElement.textContent, /Selected helper/);
}
async function selectNative(name) {
  await select(name);
  if (button("Agent connector").getAttribute("aria-checked") !== "true") await click("Agent connector");
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("transport controls are specialist-only, default to MCP and route typed and voice through the explicit native selection", async () => {
  assert.equal(button("MCP"), undefined);
  assert.equal(button("Agent connector"), undefined);
  await click("Facilitation questions");
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 1);
  for (const [index, name] of ["Failure Mode Identifier", "Failure Risk Prioritizer", "Corrective Action Advisor"].entries()) {
    await select(name);
    if (index === 0) {
      assert.equal(button("MCP").getAttribute("aria-checked"), "true");
      assert.equal(button("Agent connector").getAttribute("aria-checked"), "false");
      assert.match(document.body.textContent, /Wait limit: 30 seconds/);
      await click("Agent connector");
    }
    assert.equal(document.querySelector("#ai-search-files"), null);
    assert.doesNotMatch(document.body.textContent, /Work IQ answer|Specialist answer/);
    await click("Facilitation questions");
    const typed = service.InvokeAgent.mock.calls.at(-1).arguments;
    assert.equal(typed[0].agentId, [
      "Default_Failure_Mode_Identifier_20cdd7", "Default_Failure_Risk_Prioritizer_5a9a6a", "Default_Corrective_Action_Advisor_7867b1",
    ][index]);
    assert.equal(typed[1], undefined);
    assert.equal(voiceOptions.helperName, name);
    await act(async () => assert.equal(await voiceOptions.askCopilot("Read-only voice question"), "Specialist answer"));
    const voice = service.InvokeAgent.mock.calls.at(-1).arguments;
    assert.match(voice[0].prompt, /Read-only voice question/);
    assert.equal(voice[1], CONVERSATION);
    assert.equal(service.InvokeAgent.mock.callCount(), (index + 1) * 2);
  }
  for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
  await select("Microsoft 365 Copilot");
  assert.equal(button("MCP"), undefined);
  assert.equal(button("Agent connector"), undefined);
  await click("Facilitation questions");
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 2);
  assert.equal(service.InvokeAgent.mock.callCount(), 6);
});

test("changing either transport stops voice/read-aloud and remounts output, read-aloud choice and conversation", async () => {
  await select("Failure Risk Prioritizer");
  await click("Facilitation questions");
  assert.equal(toolCalls(mcp.RiskMcp).length, 1);
  const readAloud = document.querySelector("#ai-read-aloud");
  assert.ok(readAloud);
  await act(async () => readAloud.click());
  assert.equal(readAloud.getAttribute("aria-checked"), "true");
  const voiceStops = stopVoice.mock.callCount();
  const readerStops = stopSpeaking.mock.callCount();
  await click("Agent connector");
  assert.ok(stopVoice.mock.callCount() > voiceStops);
  assert.ok(stopSpeaking.mock.callCount() > readerStops);
  assert.equal(document.querySelector("#ai-read-aloud").getAttribute("aria-checked"), "false");
  assert.doesNotMatch(document.body.textContent, /Specialist answer/);
  await click("Facilitation questions");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  const nativeVoiceStops = stopVoice.mock.callCount();
  const nativeReaderStops = stopSpeaking.mock.callCount();
  await click("MCP");
  assert.ok(stopVoice.mock.callCount() > nativeVoiceStops);
  assert.ok(stopSpeaking.mock.callCount() > nativeReaderStops);
  assert.doesNotMatch(document.body.textContent, /Specialist answer/);
  await click("Facilitation questions");
  assert.deepEqual(mcp.RiskMcp.mock.calls.slice(-3).map(({ arguments: [body] }) => body.method),
    ["initialize", "tools/list", "tools/call"]);
  assert.equal(toolCalls(mcp.RiskMcp).at(-1).params.arguments.conversationId, undefined);
});

for (const transport of ["mcp", "agentnode"]) {
  test(`${transport} disables transport changes during typed and voice questions and shows the correct wait limit`, async () => {
    await select("Corrective Action Advisor");
    if (transport === "agentnode") await click("Agent connector");
    for (const channel of ["typed", "voice"]) {
      const pending = deferred();
      if (transport === "agentnode") service.InvokeAgent = mock.fn(() => pending.promise);
      else Object.assign(mcp, mcpService(() => pending.promise));
      let voiceRequest;
      if (channel === "typed") await click("Facilitation questions");
      else {
        await act(async () => { voiceRequest = voiceOptions.askCopilot("Voice pending"); });
        await flush();
      }
      try {
        assert.equal(button("MCP").disabled, true);
        assert.equal(button("Agent connector").disabled, true);
        const current = transport === "mcp" ? "MCP" : "Agent connector";
        await act(async () => button(transport === "mcp" ? "Agent connector" : "MCP").click());
        assert.equal(button(current).getAttribute("aria-checked"), "true");
        if (channel === "typed") {
          assert.match(document.body.textContent, transport === "mcp" ? /This can take up to 30 seconds/ : /This can take up to three minutes/);
        }
      } finally {
        await act(async () => {
          pending.resolve(transport === "agentnode" ? agentNodeReply() : toolResult());
          if (voiceRequest) assert.equal(await voiceRequest, "Specialist answer");
        });
      }
      await flush();
      assert.equal(button("MCP").disabled, false);
      assert.equal(button("Agent connector").disabled, false);
    }
  });
}

test("native new conversation resets history/output and clarification never becomes an applicable row", async () => {
  await selectNative("Failure Mode Identifier");
  await click("Suggest failure modes");
  assert.match(document.body.textContent, /not validated suggestions/);
  assert.equal(addChain.mock.callCount(), 0);
  await click("New conversation");
  assert.doesNotMatch(document.body.textContent, /Specialist answer/);
  service.InvokeAgent = mock.fn(async () => agentNodeReply(
    '[{"failureMode":"Signal lost","effect":"Monitoring delayed","cause":"Contact fault","rationale":"Review contact design"}]', NEXT_CONVERSATION));
  await click("Suggest failure modes");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  const apply = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("Add to failure network"));
  assert.ok(apply);
  await act(async () => apply.click());
  assert.equal(addChain.mock.callCount(), 1);
  assert.equal(addChain.mock.calls[0].arguments[1].failureMode, "Signal lost");
});

test("native failure stays visible and never invokes MCP or Work IQ fallback", async () => {
  await selectNative("Failure Risk Prioritizer");
  service.InvokeAgent = mock.fn(async () => ({ success: false, error: "private details" }));
  await click("Challenge ratings");
  assert.match(document.body.textContent, /New conversation required/);
  assert.doesNotMatch(document.body.textContent, /private details/);
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
  for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
});

test("fixed native channel reason is visible in the error title and code", async () => {
  await selectNative("Corrective Action Advisor");
  for (const reason of ["missing", "protected", "missed", "restore", "handshake"]) {
    globalThis.dualTransportIntegration.native.channelError =
      new globalThis.dualTransportIntegration.native.AgentNodeTransportError("connection", "A fixed safe channel diagnostic.", reason);
    await click("Facilitation questions");
    const title = [...document.querySelectorAll("p")].find((node) => node.textContent === `Native channel unavailable [${reason}]`);
    assert.ok(title);
    assert.equal(title.classList.contains("font-medium"), true);
    assert.match(document.body.textContent, new RegExp(`Code: channel/${reason}`));
    await click("New conversation");
  }
});

test("ambiguous native turn blocks retry, regenerate and cached refetch until explicit reset", async () => {
  await selectNative("Corrective Action Advisor");
  await click("Facilitation questions");
  service.InvokeAgent = mock.fn(async () => { throw new Error("private upstream failure"); });
  await click("Regenerate");
  assert.match(document.body.textContent, /New conversation required/);
  assert.match(document.body.textContent, /upstream run may still be active/);
  assert.doesNotMatch(document.body.textContent, /private upstream failure/);
  assert.equal(button("Try again"), undefined);
  assert.equal(button("Regenerate"), undefined);
  assert.equal(button("Facilitation questions").disabled, true);
  await act(async () => { await client.refetchQueries({ type: "active" }); });
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  await click("New conversation");
  Object.assign(service, agentNodeService());
  await click("Facilitation questions");
  assert.match(document.body.textContent, /Specialist answer/);
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("switching away from an ambiguous native turn clears the error and permits fresh MCP and native questions", async () => {
  await selectNative("Corrective Action Advisor");
  service.InvokeAgent = mock.fn(async () => { throw new Error("private upstream failure"); });
  await click("Facilitation questions");
  assert.match(document.body.textContent, /New conversation required/);
  assert.equal(button("MCP").disabled, false);
  await click("MCP");
  assert.doesNotMatch(document.body.textContent, /New conversation required|Specialist answer/);
  await click("Facilitation questions");
  assert.match(document.body.textContent, /Specialist answer/);
  assert.equal(toolCalls(mcp.ActionMcp)[0].params.arguments.conversationId, undefined);
  await click("Agent connector");
  Object.assign(service, agentNodeService());
  await click("Facilitation questions");
  assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
});

test("proven pre-submit native errors keep Try again and the same turn can succeed", async () => {
  await selectNative("Corrective Action Advisor");
  globalThis.dualTransportIntegration.native.channelError =
    new globalThis.dualTransportIntegration.native.AgentNodeTransportError("connection", "No native request was sent.", "missing");
  await click("Facilitation questions");
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
  delete globalThis.dualTransportIntegration.native.channelError;
  await click("Try again");
  assert.match(document.body.textContent, /Specialist answer/);
  assert.equal(service.InvokeAgent.mock.callCount(), 1);
});

test("Work IQ retains Try again after failure even while the stored specialist transport is native", async () => {
  await selectNative("Corrective Action Advisor");
  await select("Microsoft 365 Copilot");
  workiq.callWorkIqCopilotChatText.mock.mockImplementationOnce(async () => { throw new Error("private Work IQ failure"); });
  await click("Facilitation questions");
  assert.doesNotMatch(document.body.textContent, /private Work IQ failure|New conversation required/);
  await click("Try again");
  assert.match(document.body.textContent, /Work IQ answer/);
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 2);
  assert.equal(service.InvokeAgent.mock.callCount(), 0);
});
