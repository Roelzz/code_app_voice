import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import ts from "typescript";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CONVERSATION, mcpService, toolCalls, toolResult } from "./mcp-fixture.mjs";
import { agentNodeReply, agentNodeService, nativeAgentMock } from "./agentnode-fixture.mjs";

async function loadHook(path, imports = {}) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  source = source.replace(/from "([^"]+)"/g, (match, name) =>
    `from ${JSON.stringify(imports[name] ?? import.meta.resolve(name))}`);
  return `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText).toString("base64")}`;
}

const voiceModule = await loadHook("../src/hooks/use-voice.ts");
const { useRealtimeVoice } = await import(await loadHook("../src/hooks/use-realtime-voice.ts", {
  "@/hooks/use-voice": voiceModule,
}));
const { useDictation, useSpeechReader } = await import(voiceModule);
const helperMcp = mcpService();
const helperNativeService = agentNodeService();
const helperWorkiq = {
  WORKIQ_HOST_TIMEOUT_MS: 30_000,
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => []),
  WorkIqConnectorError: class extends Error {},
  WorkIqResponseError: class extends Error {},
};
globalThis.realtimeHelperBoundaries = {
  mcp: helperMcp, native: nativeAgentMock(helperNativeService), workiq: helperWorkiq,
};
const helperSource = await readFile(new URL("../src/connectors/dfmea-helpers.ts", import.meta.url), "utf8");
const helperCompiled = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{ DFMEASpecialistMCPService \} from "\.\.\/\.\.\/generated";/,
    "const DFMEASpecialistMCPService=globalThis.realtimeHelperBoundaries.mcp;")
  .replace(/import \{([^}]+)\} from "\.\/agentnode-transport";/,
    "const {$1}=globalThis.realtimeHelperBoundaries.native;")
  .replace(/import \{([\s\S]*?)\} from "@\/connectors\/workiq-copilot-chat";/,
    "const {$1}=globalThis.realtimeHelperBoundaries.workiq;");
const { HelperSession } = await import(`data:text/javascript;base64,${Buffer.from(helperCompiled).toString("base64")}`);
delete globalThis.realtimeHelperBoundaries;
const token = {
  value: "ephemeral-test-value",
  callsUrl: "https://dfmea-voice-fy27.openai.azure.com/openai/v1/realtime/calls",
  model: "gpt-realtime-2.1",
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let root;
let current;
let dictation;
let reader;
let peers;
let streams;
let errors;
let ask;
let requestToken;
let getMicrophone;
let audio;
let fetchSignal;
let recognition;
let window;
let saved;
let helperName;
let helperTimeoutMs;
let renderHarness;

class Peer {
  constructor() {
    this.connectionState = "new";
    this.channel = {
      readyState: "open",
      sent: [],
      send(data) { this.sent.push(JSON.parse(data)); },
      close() { this.readyState = "closed"; },
    };
    peers.push(this);
  }
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.connectionState = "closed"; }
}

function stream() {
  const track = { stop: mock.fn() };
  const value = { getTracks: () => [track], getAudioTracks: () => [track] };
  streams.push(value);
  return value;
}

beforeEach(async () => {
  window = new Window();
  peers = [];
  streams = [];
  errors = [];
  audio = [];
  helperName = "Microsoft 365 Copilot";
  helperTimeoutMs = 30_000;
  Object.assign(helperMcp, mcpService());
  Object.assign(helperNativeService, agentNodeService());
  helperWorkiq.callWorkIqCopilotChatText.mock.mockImplementation(async () => "Work IQ answer");
  helperWorkiq.callWorkIqCopilotChatText.mock.resetCalls();
  ask = mock.fn(async () => "Work IQ answer");
  requestToken = mock.fn(async () => token);
  getMicrophone = mock.fn(async () => stream());
  saved = new Map();
  function setGlobal(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("navigator", { language: "en", mediaDevices: { getUserMedia: (...args) => getMicrophone(...args) } });
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("RTCPeerConnection", Peer);
  setGlobal("Audio", class {
    constructor() { audio.push(this); }
    play = mock.fn(async () => {});
    pause = mock.fn();
  });
  setGlobal("fetch", mock.fn(async (_url, options) => {
    fetchSignal = options.signal;
    return { ok: true, text: async () => "answer" };
  }));
  window.SpeechRecognition = function () {
    recognition = {
      start() {},
      stop() { this.onend?.(); },
      abort() { this.onend?.(); },
    };
    return recognition;
  };
  function Harness() {
    current = useRealtimeVoice({
      helperName,
      helperTimeoutMs,
      requestToken: () => requestToken(),
      askCopilot: (question) => ask(question),
      onError: (message) => errors.push(message),
    });
    dictation = useDictation({ onTranscript() {}, onError() {} });
    reader = useSpeechReader();
    return null;
  }
  root = createRoot(document.createElement("div"));
  renderHarness = () => root.render(React.createElement(Harness));
  await act(async () => root.render(React.createElement(Harness)));
});

test("voice session names its selected specialist and returns that helper's result exactly once", async () => {
  helperName = "Failure Risk Prioritizer";
  ask = mock.fn(async () => "Specialist risk assessment");
  await act(async () => renderHarness());
  const channel = await connect();
  assert.match(channel.sent[0].session.instructions, /Selected helper: Failure Risk Prioritizer/);
  assert.doesNotMatch(channel.sent[0].session.instructions, /Work IQ is the only/);
  await emit(channel, questionEvent());
  await emit(channel, questionEvent());
  await emit(channel, { type: "response.done", response: { id: "response-one" } });
  assert.equal(ask.mock.callCount(), 1);
  assert.equal(channel.sent[1].item.output, "Specialist risk assessment");
  assert.equal(channel.sent[2].response.tool_choice, "none");
});

test("real native helper answer after 30 seconds still reaches voice before the 180-second ceiling", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
  const reply = deferred();
  const session = new HelperSession();
  session.select("risk");
  session.setTransport("agentnode");
  helperName = "Failure Risk Prioritizer";
  helperTimeoutMs = session.timeoutMs;
  ask = mock.fn((question) => session.text(question));
  helperNativeService.InvokeAgent = mock.fn(() => reply.promise);
  try {
    await act(async () => renderHarness());
    const channel = await connect();
    await emit(channel, questionEvent());
    await emit(channel, { type: "response.done", response: { id: "response-one" } });
    await act(async () => mock.timers.tick(45_000));
    assert.equal(current.status, "connected", "Native voice must remain connected while the real helper is answering after 30 seconds");
    assert.equal(current.activity, "consulting");
    assert.equal(session.isBusy, true);
    await act(async () => reply.resolve(agentNodeReply("Native answer after 45 seconds")));
    assert.equal(channel.sent[1].item.type, "function_call_output");
    assert.equal(channel.sent[1].item.output, "Native answer after 45 seconds");
    assert.equal(channel.sent[2].response.tool_choice, "none");
    assert.equal(helperNativeService.InvokeAgent.mock.callCount(), 1);
    assert.equal(errors.length, 0);
  } finally {
    await act(async () => {
      current.stop();
      reply.resolve(agentNodeReply("Late native reply"));
      await new Promise(setImmediate);
    });
  }
});

for (const route of [
  { name: "Work IQ", helper: "workiq", transport: "agentnode", timeout: 30_000 },
  { name: "MCP specialist", helper: "risk", transport: "mcp", timeout: 180_000 },
  { name: "native specialist", helper: "risk", transport: "agentnode", timeout: 180_000 },
]) {
  test(`real ${route.name} voice times out at ${route.timeout / 1000} seconds and keeps its upstream gate until settlement`, async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
    const reply = deferred();
    const session = new HelperSession();
    session.select(route.helper);
    session.setTransport(route.transport);
    helperName = route.name;
    helperTimeoutMs = session.timeoutMs;
    ask = mock.fn((question) => session.text(question));
    if (route.helper === "workiq") helperWorkiq.callWorkIqCopilotChatText.mock.mockImplementation(() => reply.promise);
    else if (route.transport === "mcp") Object.assign(helperMcp, mcpService(() => reply.promise));
    else helperNativeService.InvokeAgent = mock.fn(() => reply.promise);
    const upstreamCount = () => route.helper === "workiq" ? helperWorkiq.callWorkIqCopilotChatText.mock.callCount()
      : route.transport === "mcp" ? toolCalls(helperMcp.RiskMcp).length : helperNativeService.InvokeAgent.mock.callCount();
    const answer = route.helper === "workiq" ? "Late Work IQ answer"
      : route.transport === "mcp" ? toolResult("Late MCP answer") : agentNodeReply("Late native answer");
    try {
      await act(async () => renderHarness());
      const channel = await connect();
      await emit(channel, questionEvent());
      await emit(channel, { type: "response.done", response: { id: "response-one" } });
      assert.equal(upstreamCount(), 1);
      await act(async () => mock.timers.tick(route.timeout - 1));
      assert.equal(current.status, "connected");
      assert.equal(current.activity, "consulting");
      assert.equal(session.isBusy, true);
      await act(async () => mock.timers.tick(1));
      assert.equal(current.status, "idle");
      assert.match(errors[0], new RegExp(`app's ${route.timeout / 1000}-second limit`));
      assert.equal(session.isBusy, true, "Voice timeout cannot cancel an upstream helper operation");
      await assert.rejects(session.text("No overlapping request"), (error) => error.code === "busy");
      assert.throws(() => session.setTransport(route.transport === "mcp" ? "agentnode" : "mcp"), (error) => error.code === "busy");
      assert.equal(upstreamCount(), 1);
      await act(async () => {
        reply.resolve(answer);
        await new Promise(setImmediate);
      });
      assert.equal(session.isBusy, false);
      assert.equal(channel.sent.length, 1, "The timed-out voice channel cannot publish a late helper reply");
      assert.equal(channel.readyState, "closed");
      assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
    } finally {
      await act(async () => {
        current.stop();
        reply.resolve(answer);
        await new Promise(setImmediate);
      });
    }
  });
}

for (const ending of ["stop", "helper switch"]) {
  test(`real native helper preserves no-overlap after ${ending} and cannot inject a late reply into restarted voice`, async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-11T12:00:00Z") });
    const reply = deferred();
    const session = new HelperSession();
    session.select("risk");
    session.setTransport("agentnode");
    helperName = "Failure Risk Prioritizer";
    helperTimeoutMs = session.timeoutMs;
    ask = mock.fn((question) => session.text(question));
    const oldInvocation = mock.fn(() => reply.promise);
    helperNativeService.InvokeAgent = oldInvocation;
    try {
      await act(async () => renderHarness());
      const oldChannel = await connect();
      await emit(oldChannel, questionEvent());
      const oldEvent = oldChannel.onmessage;
      await act(async () => current.stop());
      if (ending === "helper switch") {
        session.select("actions");
        helperName = "Corrective Action Advisor";
        helperTimeoutMs = session.timeoutMs;
      }
      await act(async () => renderHarness());
      const newChannel = await connect();
      await emit(newChannel, questionEvent("overlap"));
      await emit(newChannel, { type: "response.done", response: { id: "response-overlap" } });
      assert.match(newChannel.sent[1].item.output, /could not answer/);
      assert.equal(oldInvocation.mock.callCount(), 1, "Restarting voice cannot dispatch while the previous helper is pending");
      assert.equal(session.isBusy, true);
      assert.throws(() => session.setTransport("mcp"), (error) => error.code === "busy");
      await act(async () => {
        reply.resolve(agentNodeReply("Late old-session answer"));
        await new Promise(setImmediate);
        oldEvent({ data: JSON.stringify({ type: "response.done", response: { id: "response-one" } }) });
      });
      assert.equal(session.isBusy, false);
      assert.equal(oldChannel.sent.length, 1);
      assert.equal(newChannel.sent.length, 3);
      assert.doesNotMatch(JSON.stringify(newChannel.sent), /Late old-session answer/);
      helperNativeService.InvokeAgent = mock.fn(async () => agentNodeReply("Fresh current-session answer"));
      await emit(newChannel, questionEvent("fresh"));
      await emit(newChannel, { type: "response.done", response: { id: "response-fresh" } });
      assert.equal(newChannel.sent.at(-2).item.type, "function_call_output");
      assert.equal(newChannel.sent.at(-2).item.output, "Fresh current-session answer");
      assert.equal(helperNativeService.InvokeAgent.mock.callCount(), 1);
      const [body, conversationId] = helperNativeService.InvokeAgent.mock.calls[0].arguments;
      assert.equal(body.agentId, ending === "helper switch" ? "Default_Corrective_Action_Advisor_7867b1" : "Default_Failure_Risk_Prioritizer_5a9a6a");
      assert.equal(conversationId, ending === "helper switch" ? undefined : CONVERSATION);
    } finally {
      await act(async () => {
        current.stop();
        reply.resolve(agentNodeReply("Late old-session answer"));
        await new Promise(setImmediate);
      });
    }
  });
}

afterEach(async () => {
  await act(async () => root.unmount());
  mock.timers.reset();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await window.happyDOM.close();
});

async function connect() {
  await act(async () => current.start());
  const channel = peers.at(-1).channel;
  await act(async () => {
    channel.onopen();
    channel.onmessage({ data: JSON.stringify({ type: "session.updated" }) });
  });
  return channel;
}

async function emit(channel, event) {
  await act(async () => channel.onmessage({ data: JSON.stringify(event) }));
}

const questionEvent = (id = "one") => ({
  type: "response.function_call_arguments.done",
  name: "ask_copilot",
  call_id: id,
  response_id: `response-${id}`,
  arguments: JSON.stringify({ question: "What fails?" }),
});

test("requires Work IQ, deduplicates calls, then explicitly allows speech without another tool", async () => {
  const channel = await connect();
  assert.equal(current.status, "connected");
  assert.equal(channel.sent[0].session.type, "realtime");
  assert.equal(channel.sent[0].session.tool_choice, "required");
  await emit(channel, questionEvent());
  await emit(channel, questionEvent());
  assert.equal(channel.sent.length, 1);
  await emit(channel, { type: "response.done", response: { id: "response-one" } });
  assert.equal(ask.mock.callCount(), 1);
  assert.equal(ask.mock.calls[0].arguments[0], "What fails?");
  assert.equal(channel.sent[1].item.output, "Work IQ answer");
  assert.deepEqual(channel.sent[2], { type: "response.create", response: { tool_choice: "none" } });
  await emit(channel, questionEvent("two"));
  assert.equal(ask.mock.callCount(), 2);
  await act(async () => current.stop());
  assert.equal(current.status, "idle");
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
  assert.equal(peers[0].connectionState, "closed");
  assert.equal(channel.readyState, "closed");
  assert.equal(audio[0].srcObject, null);
  assert.equal(fetchSignal.aborted, true);
});

test("voice activity follows real speech, tool and audio-buffer events and resets on Stop", async () => {
  const answer = deferred();
  ask = mock.fn(() => answer.promise);
  const channel = await connect();
  assert.equal(current.activity, "listening");
  await emit(channel, { type: "input_audio_buffer.speech_started" });
  assert.equal(current.activity, "hearing");
  await emit(channel, { type: "input_audio_buffer.speech_stopped" });
  assert.equal(current.activity, "processing");
  await emit(channel, questionEvent());
  assert.equal(current.activity, "consulting");
  await emit(channel, { type: "output_audio_buffer.started" });
  assert.equal(current.activity, "speaking");
  await emit(channel, { type: "output_audio_buffer.stopped" });
  assert.equal(current.activity, "consulting");
  await act(async () => answer.resolve("Work IQ answer"));
  await emit(channel, { type: "response.done", response: { id: "response-one" } });
  await emit(channel, { type: "output_audio_buffer.started" });
  assert.equal(current.activity, "speaking");
  await emit(channel, { type: "output_audio_buffer.cleared" });
  assert.equal(current.activity, "listening");
  const lateEvent = channel.onmessage;
  await act(async () => current.stop());
  await act(async () => lateEvent({ data: JSON.stringify({ type: "output_audio_buffer.started" }) }));
  assert.equal(current.status, "idle");
  assert.equal(current.activity, "listening");
});

test("stop during microphone permission releases the late stream without requesting a token", async () => {
  const permission = deferred();
  getMicrophone = () => permission.promise;
  let starting;
  await act(async () => { starting = current.start(); });
  await act(async () => current.stop());
  const late = stream();
  await act(async () => { permission.resolve(late); await starting; });
  assert.equal(late.getTracks()[0].stop.mock.callCount(), 1);
  assert.equal(requestToken.mock.callCount(), 0);
  assert.equal(peers.length, 0);
});

test("a stopped token request cannot resurrect an old session after restart", async () => {
  const first = deferred();
  requestToken = mock.fn(async () => token);
  requestToken.mock.mockImplementationOnce(() => first.promise);
  let starting;
  await act(async () => { starting = current.start(); });
  await act(async () => current.stop());
  await connect();
  await act(async () => { first.resolve(token); await starting; });
  assert.equal(peers.length, 1);
  assert.equal(current.status, "connected");
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
});

test("unmount cancels setup and releases a late permission result", async () => {
  const permission = deferred();
  getMicrophone = () => permission.promise;
  let starting;
  await act(async () => { starting = current.start(); root.unmount(); });
  const late = stream();
  permission.resolve(late);
  await starting;
  assert.equal(late.getTracks()[0].stop.mock.callCount(), 1);
  assert.equal(peers.length, 0);
});

test("setup timeout cancels token completion and releases microphone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  helperTimeoutMs = 180_000;
  await act(async () => renderHarness());
  const pendingToken = deferred();
  requestToken = () => pendingToken.promise;
  let starting;
  await act(async () => { starting = current.start(); });
  await act(async () => mock.timers.tick(30_000));
  assert.equal(current.status, "idle");
  assert.match(errors[0], /timed out/);
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
  await act(async () => { pendingToken.resolve(token); await starting; });
  assert.equal(peers.length, 0);
});

test("token failure is safe and releases microphone", async () => {
  requestToken = async () => { throw new Error("private upstream error"); };
  await act(async () => current.start());
  assert.equal(current.status, "idle");
  assert.match(errors[0], /Couldn't get/);
  assert.ok(!errors.join().includes("private"));
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
});

test("rejects unexpected signaling endpoints before sending a bearer token", async () => {
  requestToken = async () => ({ ...token, callsUrl: "https://untrusted.example/calls" });
  await act(async () => current.start());
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.match(errors[0], /invalid response/);
});

test("Work IQ failure produces a safe spoken failure, not a model answer", async () => {
  ask = async () => { throw new Error("private error"); };
  const channel = await connect();
  await emit(channel, questionEvent());
  await emit(channel, { type: "response.done", response: { id: "response-one" } });
  assert.match(channel.sent[1].item.output, /could not answer/);
  assert.ok(!JSON.stringify(channel.sent).includes("private"));
  assert.equal(channel.sent[2].response.tool_choice, "none");
});

test("Stop drops pending Work IQ results and prevents audio resurrection", async () => {
  const reply = deferred();
  ask = () => reply.promise;
  const channel = await connect();
  await emit(channel, questionEvent());
  await act(async () => current.stop());
  await act(async () => reply.resolve("late answer"));
  assert.equal(channel.sent.length, 1);
});

test("service errors and playback failure close all resources", async () => {
  const channel = await connect();
  audio[0].play = async () => { throw new Error("blocked"); };
  await act(async () => peers[0].ontrack({ streams: [stream()] }));
  assert.equal(current.status, "idle");
  assert.match(errors[0], /playback was blocked/);
  assert.equal(channel.readyState, "closed");
  await connect();
  await emit(peers[1].channel, { type: "error", error: { message: "private details" } });
  assert.equal(current.status, "idle");
  assert.ok(!errors.join().includes("private"));
});

test("realtime and existing dictation take turns using the microphone", async () => {
  await act(async () => dictation.start());
  const firstRecognition = recognition;
  firstRecognition.abort = mock.fn(firstRecognition.abort.bind(firstRecognition));
  await connect();
  assert.equal(firstRecognition.abort.mock.callCount(), 1);
  assert.equal(dictation.listening, false);
  await act(async () => dictation.start());
  assert.equal(current.status, "idle");
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
  assert.equal(typeof reader.speak, "function");
});

test("Work IQ timeout closes voice and ignores a late result", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const reply = deferred();
  ask = () => reply.promise;
  const channel = await connect();
  await emit(channel, questionEvent());
  await act(async () => mock.timers.tick(30_000));
  assert.match(errors[0], /app's 30-second limit/);
  assert.equal(current.status, "idle");
  await act(async () => reply.resolve("late answer"));
  assert.equal(channel.sent.length, 1);
});

test("stopping an in-flight SDP request aborts fetch and prevents remote setup", async () => {
  const response = deferred();
  globalThis.fetch = mock.fn((_url, options) => {
    fetchSignal = options.signal;
    return response.promise;
  });
  let starting;
  await act(async () => { starting = current.start(); });
  peers[0].setRemoteDescription = mock.fn();
  await act(async () => current.stop());
  assert.equal(fetchSignal.aborted, true);
  await act(async () => {
    response.resolve({ ok: true, text: async () => "late sdp" });
    await starting;
  });
  assert.equal(peers[0].setRemoteDescription.mock.callCount(), 0);
});

test("a data-channel send failure is visible and cleans up instead of rejecting an event handler", async () => {
  const channel = await connect();
  channel.send = () => { throw new Error("private RTC details"); };
  await emit(channel, { type: "response.done", response: { id: "response-one" } });
  await emit(channel, questionEvent());
  assert.equal(current.status, "idle");
  assert.match(errors[0], /could not send/);
  assert.equal(streams[0].getTracks()[0].stop.mock.callCount(), 1);
});
