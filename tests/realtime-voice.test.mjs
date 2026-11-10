import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import ts from "typescript";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

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
      requestToken: () => requestToken(),
      askCopilot: (question) => ask(question),
      onError: (message) => errors.push(message),
    });
    dictation = useDictation({ onTranscript() {}, onError() {} });
    reader = useSpeechReader();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Harness)));
});

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
  assert.match(errors[0], /30-second host limit/);
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
