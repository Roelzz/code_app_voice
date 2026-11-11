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

async function loadVoiceHook(path, imports = {}) {
  const source = await readFile(new URL(`../src/hooks/${path}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from "([^"]+)"/g, (_match, name) =>
    `from ${JSON.stringify(imports[name] ?? import.meta.resolve(name))}`);
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const speechHook = await loadVoiceHook("use-voice");
const { useRealtimeVoice: realUseRealtimeVoice } = await import(await loadVoiceHook("use-realtime-voice", {
  "@/hooks/use-voice": speechHook,
}));

const service = agentNodeService();
const mcp = mcpService();
let nativeReadiness;
const nativeBoundary = nativeAgentMock(service);
const invokeNative = nativeBoundary.invokeAgentNode;
nativeBoundary.invokeAgentNode = async (...args) => {
  if (nativeReadiness) await nativeReadiness.promise;
  args[3]?.();
  return invokeNative(...args);
};
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => []),
};
let voiceOptions;
let liveVoice;
const stopVoice = mock.fn();
const stopSpeaking = mock.fn();
const speak = mock.fn();
globalThis.dualTransportIntegration = {
  mcp, native: nativeBoundary, workiq, stopSpeaking, speak,
  useVoice: (options) => {
    voiceOptions = options;
    const voice = realUseRealtimeVoice(options);
    liveVoice = voice;
    return { ...voice, stop: () => { stopVoice(); voice.stop(); } };
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
  nativeReadiness = undefined;
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
      onAddFailureChain: addChain, onAddAction: addAction, requestRealtimeToken: async () => ({
        value: "ephemeral-test-value",
        callsUrl: "https://dfmea-voice-fy27.openai.azure.com/openai/v1/realtime/calls",
        model: "gpt-realtime-2.1",
      }),
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
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function installRealtimeBoundaries() {
  const peers = [];
  function boundary(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  boundary("RTCPeerConnection", class {
    constructor() {
      this.connectionState = "new";
      this.channel = {
        readyState: "open", sent: [],
        send(data) { this.sent.push(JSON.parse(data)); },
        close() { this.readyState = "closed"; },
      };
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() { return this.channel; }
    async createOffer() { return { type: "offer", sdp: "test-offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { this.connectionState = "closed"; }
  });
  boundary("Audio", class {
    play = async () => {};
    pause() {}
  });
  boundary("fetch", mock.fn(async () => ({ ok: true, text: async () => "test-answer" })));
  const microphoneStop = mock.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: {
      getUserMedia: mock.fn(async () => ({
        getAudioTracks: () => [{ stop: microphoneStop }],
        getTracks: () => [{ stop: microphoneStop }],
      })),
    },
  });
  return { peers, microphoneStop };
}

async function startMountedVoice(peers) {
  await act(async () => {
    button("Start voice session").click();
    await new Promise(setImmediate);
  });
  const channel = peers.at(-1)?.channel;
  assert.ok(channel, "The mounted facilitator starts its real WebRTC hook");
  await act(async () => {
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({ type: "session.updated" }) });
  });
  return channel;
}

async function askMountedVoice(channel, id = "one", responseDone = true) {
  await act(async () => {
    channel.onmessage({ data: JSON.stringify({
      type: "response.function_call_arguments.done", name: "ask_copilot", call_id: id, response_id: `response-${id}`,
      arguments: JSON.stringify({ question: "What fails?" }),
    }) });
    if (responseDone) channel.onmessage({ data: JSON.stringify({ type: "response.done", response: { id: `response-${id}` } }) });
    await new Promise(setImmediate);
  });
}

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

test("actual facilitator wires route-specific voice consulting limits and delivers a native answer after 30 seconds", async () => {
  const { peers, microphoneStop } = installRealtimeBoundaries();
  for (const route of [
    { helper: "Microsoft 365 Copilot", transport: null, seconds: 30, kind: "workiq" },
    { helper: "Failure Risk Prioritizer", transport: "MCP", seconds: 30, kind: "mcp" },
    { helper: "Failure Risk Prioritizer", transport: "Agent connector", seconds: 180, kind: "native" },
    { helper: "Microsoft 365 Copilot", transport: null, seconds: 30, kind: "workiq" },
  ]) {
    await select(route.helper);
    if (route.transport && button(route.transport).getAttribute("aria-checked") !== "true") await click(route.transport);
    const pending = deferred();
    const answerText = `${route.kind} routed voice answer`;
    const answer = route.kind === "workiq" ? answerText : route.kind === "mcp" ? toolResult(answerText) : agentNodeReply(answerText);
    if (route.kind === "workiq") workiq.callWorkIqCopilotChatText.mock.mockImplementation(() => pending.promise);
    else if (route.kind === "mcp") Object.assign(mcp, mcpService(() => pending.promise));
    else service.InvokeAgent = mock.fn(() => pending.promise);
    await click("Talk to Copilot");
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
    try {
      const channel = await startMountedVoice(peers);
      assert.match(channel.sent[0].session.instructions, new RegExp(`Selected helper: ${route.helper}`));
      await askMountedVoice(channel);
      const dialog = document.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, new RegExp(`The app waits up to ${route.seconds} seconds\\.`));
      assert.equal(dialog.querySelector("[data-voice-state]").getAttribute("data-voice-state"), "consulting");
      await act(async () => {
        mock.timers.tick(route.kind === "native" ? 45_000 : 15_000);
        await new Promise(setImmediate);
      });
      assert.equal(channel.readyState, "open", `${route.kind} uses the helper deadline, not a hardcoded voice limit`);
      assert.equal(dialog.querySelector("[data-voice-state]").getAttribute("data-voice-state"), "consulting");
      await act(async () => {
        pending.resolve(answer);
        await new Promise(setImmediate);
        mock.timers.tick(0);
      });
      assert.equal(channel.sent[1].item.type, "function_call_output");
      assert.equal(channel.sent[1].item.output, answerText);
      assert.equal(channel.sent[2].response.tool_choice, "none");
      if (route.kind === "native") {
        assert.equal(service.InvokeAgent.mock.callCount(), 1);
        assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
      } else if (route.kind === "mcp") assert.equal(toolCalls(mcp.RiskMcp).length, 1);
      await act(async () => button("Close").click());
      assert.equal(channel.readyState, "closed");
    } finally {
      await act(async () => {
        liveVoice?.stop();
        pending.resolve(answer);
        await new Promise(setImmediate);
      });
      mock.timers.reset();
    }
  }
  assert.equal(peers.length, 4);
  assert.equal(globalThis.fetch.mock.callCount(), 4);
  assert.equal(microphoneStop.mock.callCount(), 4);
});

test("mounted native voice failure preserves sanitized reset recovery in the UI and tool output without retry or fallback", async () => {
  const { peers } = installRealtimeBoundaries();
  await selectNative("Failure Risk Prioritizer");
  const pending = deferred();
  service.InvokeAgent = mock.fn(() => pending.promise);
  await click("Talk to Copilot");
  try {
    const channel = await startMountedVoice(peers);
    await askMountedVoice(channel);
    assert.equal(service.InvokeAgent.mock.callCount(), 1);
    await act(async () => {
      pending.reject(new Error("PRIVATE_NATIVE_NETWORK_SENTINEL"));
      await new Promise(setImmediate);
    });
    await flush();
    assert.match(document.body.textContent, /upstream run may still be active/);
    assert.match(document.body.textContent, /Start a new conversation before sending another request/);
    const output = channel.sent.find((event) => event.item?.type === "function_call_output")?.item.output;
    assert.ok(output);
    assert.match(output, /Start a new conversation before sending another request/);
    assert.match(output, /upstream run may still be active/);
    assert.doesNotMatch(output, /try again|PRIVATE_NATIVE_NETWORK_SENTINEL/i);
    assert.doesNotMatch(channel.sent[0].session.instructions, /ask them to try again/i);
    assert.match(channel.sent[0].session.instructions, /recovery/i);
    assert.doesNotMatch(document.body.textContent, /PRIVATE_NATIVE_NETWORK_SENTINEL/);
    assert.equal(button("Facilitation questions").disabled, true);
    assert.equal(button("Try again"), undefined);
    assert.equal(button("Regenerate"), undefined);
    await act(async () => button("Facilitation questions").click());
    await act(async () => assert.rejects(voiceOptions.askCopilot("Cannot silently retry"), (error) => error.requiresNewConversation === true));
    assert.equal(service.InvokeAgent.mock.callCount(), 1);
    for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
    assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
    await click("Close");
    await click("New conversation");
    assert.doesNotMatch(document.body.textContent, /upstream run may still be active/);
    Object.assign(service, agentNodeService());
    await click("Talk to Copilot");
    const freshChannel = await startMountedVoice(peers);
    await askMountedVoice(freshChannel, "fresh");
    assert.equal(freshChannel.sent[1].item.output, "Specialist answer");
    assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
  } finally {
    await act(async () => {
      liveVoice?.stop();
      pending.resolve(agentNodeReply());
      await new Promise(setImmediate);
    });
  }
});

test("mounted voice preserves an actionable channel error when response.done is missing until the tool deadline", async () => {
  const { peers } = installRealtimeBoundaries();
  await selectNative("Failure Risk Prioritizer");
  const safeError = "The protected native channel is unavailable. No native request was sent.";
  nativeBoundary.channelError = new nativeBoundary.AgentNodeTransportError("connection", safeError, "protected");
  await click("Talk to Copilot");
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
  try {
    const channel = await startMountedVoice(peers);
    await askMountedVoice(channel, "one", false);
    await act(async () => mock.timers.tick(0));
    assert.match(document.body.textContent, /The protected native channel is unavailable\. No native request was sent\./);
    assert.equal(channel.sent.length, 1, "The helper error cannot be spoken until its response completes");
    await act(async () => {
      mock.timers.tick(180_000);
      await new Promise(setImmediate);
    });
    assert.equal(channel.readyState, "closed");
    assert.equal(document.querySelector('[role="alert"]').textContent, safeError);
    assert.doesNotMatch(document.body.textContent, /180-second limit|upstream run may still be active|Start a new conversation/);
    assert.equal(service.InvokeAgent.mock.callCount(), 0);
    assert.equal(channel.sent.length, 1);
    assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
    for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
  } finally {
    await act(async () => liveVoice?.stop());
    mock.timers.reset();
  }
});

for (const ending of ["stop", "restart", "reset and restart"]) {
  test(`mounted voice ignores a late rejected helper after ${ending} without leaking errors or output`, async () => {
    const { peers } = installRealtimeBoundaries();
    const native = ending !== "restart";
    if (native) await selectNative("Failure Risk Prioritizer");
    else await select("Failure Risk Prioritizer");
    const pending = deferred();
    if (native) service.InvokeAgent = mock.fn(() => pending.promise);
    else Object.assign(mcp, mcpService(() => pending.promise));
    await click("Talk to Copilot");
    try {
      const oldChannel = await startMountedVoice(peers);
      await askMountedVoice(oldChannel);
      await click("End voice session");
      assert.equal(oldChannel.readyState, "closed");
      let freshChannel;
      if (ending === "reset and restart") {
        await click("Close");
        await click("New conversation");
        await click("Talk to Copilot");
        freshChannel = await startMountedVoice(peers);
      } else if (ending === "restart") freshChannel = await startMountedVoice(peers);
      assert.equal(button("Agent connector").disabled, true, "Stopping or resetting voice does not cancel the underlying request");
      await act(async () => button(native ? "MCP" : "Agent connector").click());
      assert.equal(button(native ? "Agent connector" : "MCP").getAttribute("aria-checked"), "true");
      await act(async () => {
        pending.reject(new Error("PRIVATE_LATE_REJECTION_SENTINEL"));
        await new Promise(setImmediate);
      });
      await flush();
      assert.equal(oldChannel.sent.length, 1);
      if (freshChannel) {
        assert.equal(freshChannel.readyState, "open");
        assert.equal(freshChannel.sent.length, 1, "The new session must not publish the previous session's failure");
      }
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.doesNotMatch(document.body.textContent, /could not answer|could not be confirmed|upstream run may still be active|PRIVATE_LATE_REJECTION_SENTINEL/);
      assert.doesNotMatch(JSON.stringify(peers.map((peer) => peer.channel.sent)), /PRIVATE_LATE_REJECTION_SENTINEL/);
      assert.equal(native ? service.InvokeAgent.mock.callCount() : toolCalls(mcp.RiskMcp).length, 1);
      assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
      if (freshChannel) {
        if (native) Object.assign(service, agentNodeService());
        else Object.assign(mcp, mcpService());
        await askMountedVoice(freshChannel, "fresh");
        assert.equal(freshChannel.sent[1].item.output, "Specialist answer");
        assert.equal(native ? service.InvokeAgent.mock.calls[0].arguments[1] :
          toolCalls(mcp.RiskMcp)[0].params.arguments.conversationId, undefined);
      }
    } finally {
      await act(async () => {
        liveVoice?.stop();
        pending.resolve(native ? agentNodeReply() : toolResult());
        await new Promise(setImmediate);
      });
    }
  });
}

for (const dispatched of [true, false]) {
  test(`mounted native voice timeout ${dispatched ? "preserves dispatched reset recovery" : "does not claim dispatch or require reset before submission"}`, async () => {
    const { peers } = installRealtimeBoundaries();
    await selectNative("Failure Risk Prioritizer");
    const pending = deferred();
    const readiness = deferred();
    if (!dispatched) nativeReadiness = readiness;
    service.InvokeAgent = mock.fn(() => pending.promise);
    await click("Talk to Copilot");
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
    try {
      const channel = await startMountedVoice(peers);
      await askMountedVoice(channel);
      assert.equal(service.InvokeAgent.mock.callCount(), dispatched ? 1 : 0);
      await act(async () => mock.timers.tick(179_999));
      assert.equal(channel.readyState, "open");
      await act(async () => {
        mock.timers.tick(1);
        await new Promise(setImmediate);
        mock.timers.tick(0);
      });
      assert.equal(channel.readyState, "closed");
      assert.equal(channel.sent.length, 1);
      const error = document.querySelector('[role="alert"]')?.textContent;
      assert.ok(error);
      assert.match(error, /180-second limit/);
      if (dispatched) {
        assert.match(error, /upstream run may still be active/);
        assert.match(error, /Start a new conversation before sending another request/);
        assert.equal(button("Facilitation questions").disabled, true);
        assert.equal(button("Start voice session").disabled, true);
      } else {
        assert.doesNotMatch(error, /upstream run|new conversation|request was sent|request has been sent|request was dispatched/i);
        assert.equal(button("Facilitation questions").disabled, false);
        assert.equal(button("Start voice session").disabled, false);
      }
      assert.equal(button("MCP").disabled, true, "The underlying transport still owns the gate after voice timeout");
      await act(async () => {
        readiness.resolve();
        pending.resolve(agentNodeReply("PRIVATE_LATE_TIMEOUT_SENTINEL"));
        await new Promise(setImmediate);
        mock.timers.tick(0);
      });
      assert.equal(button("MCP").disabled, false);
      assert.equal(service.InvokeAgent.mock.callCount(), dispatched ? 1 : 0);
      assert.equal(document.querySelector('[role="alert"]').textContent, error, "Late settlement must not replace the timeout's recovery instruction");
      assert.doesNotMatch(document.body.textContent, /PRIVATE_LATE_TIMEOUT_SENTINEL/);
      assert.equal(button("Try again"), undefined);
      assert.equal(button("Regenerate"), undefined);
      for (const method of Object.values(mcp)) assert.equal(method.mock.callCount(), 0);
      assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
      if (!dispatched) {
        nativeReadiness = undefined;
        Object.assign(service, agentNodeService());
        const freshChannel = await startMountedVoice(peers);
        await askMountedVoice(freshChannel, "fresh");
        assert.equal(freshChannel.sent[1].item.output, "Specialist answer");
        assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined);
      }
    } finally {
      await act(async () => {
        liveVoice?.stop();
        readiness.resolve();
        pending.resolve(agentNodeReply());
        await new Promise(setImmediate);
      });
      nativeReadiness = undefined;
      mock.timers.reset();
    }
  });
}

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

test("late MCP settlement reactively unlocks transport switching after the timeout without overlapping requests", async () => {
  await select("Failure Risk Prioritizer");
  const pending = deferred();
  Object.assign(mcp, mcpService(() => pending.promise));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await act(async () => {
      button("Facilitation questions").click();
      await new Promise(setImmediate);
    });
    assert.equal(toolCalls(mcp.RiskMcp).length, 1);
    await act(async () => {
      mock.timers.tick(30_000);
      await new Promise(setImmediate);
      mock.timers.tick(0);
    });
    assert.match(document.body.textContent, /30-second/);
    assert.equal(document.querySelector('[aria-label="Facilitator output"]').getAttribute("aria-busy"), "false");
    assert.equal(button("MCP").disabled, true, "The timed-out upstream operation still owns the gate");
    assert.equal(button("Agent connector").disabled, true);
    await act(async () => {
      button("Agent connector").click();
      await assert.rejects(voiceOptions.askCopilot("Must not overlap"), (error) => error.code === "busy");
      await new Promise(setImmediate);
      mock.timers.tick(0);
    });
    assert.equal(button("MCP").getAttribute("aria-checked"), "true");
    assert.equal(toolCalls(mcp.RiskMcp).length, 1);
    assert.equal(service.InvokeAgent.mock.callCount(), 0);

    await act(async () => {
      pending.resolve(toolResult("Late MCP answer"));
      await new Promise(setImmediate);
    });
    assert.equal(button("MCP").disabled, false, "Late settlement must unlock MCP without user or incidental updates");
    assert.equal(button("Agent connector").disabled, false, "Late settlement must unlock Agent connector reactively");
    assert.doesNotMatch(document.body.textContent, /Late MCP answer/);
    await act(async () => button("Agent connector").click());
    assert.equal(button("Agent connector").getAttribute("aria-checked"), "true");
    await act(async () => {
      button("Facilitation questions").click();
      await new Promise(setImmediate);
      mock.timers.tick(0);
    });
    assert.equal(service.InvokeAgent.mock.callCount(), 1);
    assert.equal(service.InvokeAgent.mock.calls[0].arguments[1], undefined, "Transport changes start a fresh conversation");
    assert.equal(toolCalls(mcp.RiskMcp).length, 1);
  } finally {
    pending.resolve(toolResult("Late MCP answer"));
    await act(async () => new Promise(setImmediate));
    mock.timers.reset();
  }
});

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
