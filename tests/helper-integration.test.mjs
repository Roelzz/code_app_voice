import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import ts from "typescript";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const service = { ExecuteCopilotAsyncV2: mock.fn() };
const workiq = {
  callWorkIqCopilotChatText: mock.fn(async () => "Work IQ answer"),
  callWorkIqCopilotChatItems: mock.fn(async () => []),
};
let voiceOptions;
const stopVoice = mock.fn();
globalThis.helperIntegration = { service, workiq, useVoice: (options) => {
  voiceOptions = options;
  return { status: "idle", activity: "listening", error: null, start: mock.fn(), stop: stopVoice };
} };
const modules = new Map();
const encode = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function load(path) {
  if (modules.has(path)) return modules.get(path);
  if (path === "lib/connector-policy-monitor") return encode("export const CONNECTOR_POLICY_STATUS=442;");
  if (path === "connectors/workiq-copilot-chat") {
    const url = encode(`export const {callWorkIqCopilotChatText,callWorkIqCopilotChatItems}=globalThis.helperIntegration.workiq;
      export const WORKIQ_HOST_TIMEOUT_MS=30000;
      export class WorkIqResponseError extends Error {}
      export class WorkIqConnectorError extends WorkIqResponseError {}
      export class WorkIqTimeoutError extends WorkIqConnectorError {}
      export class WorkIqToolError extends WorkIqResponseError {}`);
    modules.set(path, url);
    return url;
  }
  if (path === "hooks/use-realtime-voice") return encode("export const useRealtimeVoice=globalThis.helperIntegration.useVoice;");
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
  source = source.replace(/import \{ MicrosoftCopilotStudioService \} from "\.\.\/\.\.\/generated";/,
    "const MicrosoftCopilotStudioService=globalThis.helperIntegration.service;");
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
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => ({ success: true, data: { responses: ["Specialist answer"], conversationId: "conversation-one" } }));
  workiq.callWorkIqCopilotChatText.mock.resetCalls();
  stopVoice.mock.resetCalls();
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

async function click(label) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  assert.ok(button, `Button ${label} exists`);
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}
async function select(name) {
  const trigger = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("Selected helper"));
  assert.equal(trigger.disabled, false, "Helper can be changed after current request settles");
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('[aria-pressed]')].find((item) => item.textContent.startsWith(name));
  assert.ok(option);
  await act(async () => option.click());
  assert.match(document.activeElement.textContent, /Selected helper/);
  assert.ok(document.activeElement.textContent.includes(name));
}

test("manual chooser has four helpers, defaults to Work IQ, routes typed and voice to the same selection", async () => {
  assert.match(document.body.textContent, /Selected helper · ChangeMicrosoft 365 Copilot/);
  await click("Facilitation questions");
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 1);
  for (const [name, schema] of [
    ["Failure Mode Identifier", "Default_Failure_Mode_Identifier_c24230"],
    ["Failure Risk Prioritizer", "Default_Failure_Risk_Prioritizer_b311df"],
    ["Corrective Action Advisor", "Default_Corrective_Action_Advisor_8765ed"],
  ]) {
    await select(name);
    assert.equal(document.querySelector("#ai-search-files"), null);
    assert.doesNotMatch(document.body.textContent, /Work IQ answer/);
    await click("Facilitation questions");
    const typed = service.ExecuteCopilotAsyncV2.mock.calls.at(-1).arguments;
    assert.equal(typed[0], schema);
    assert.equal(typed[2], undefined);
    assert.match(document.body.textContent, /Specialist answer/);
    assert.equal(voiceOptions.helperName, name);
    await act(async () => assert.equal(await voiceOptions.askCopilot("Read-only voice question"), "Specialist answer"));
    const voice = service.ExecuteCopilotAsyncV2.mock.calls.at(-1).arguments;
    assert.equal(voice[0], schema);
    assert.equal(voice[2], "conversation-one");
  }
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 1);
  assert.equal(stopVoice.mock.callCount(), 7); // Four typed starts plus three switches.
});

test("new conversation resets history/output and clarification never becomes an applicable row", async () => {
  await select("Failure Mode Identifier");
  await click("Suggest failure modes");
  assert.match(document.body.textContent, /not validated suggestions/);
  assert.equal(addChain.mock.callCount(), 0);
  await click("New conversation");
  assert.doesNotMatch(document.body.textContent, /Specialist answer/);
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => ({
    success: true, data: { conversationId: "new-conversation", responses: ['[{"failureMode":"Signal lost","effect":"Monitoring delayed","cause":"Contact fault","rationale":"Review contact design"}]'] },
  }));
  await click("Suggest failure modes");
  assert.equal(service.ExecuteCopilotAsyncV2.mock.calls[0].arguments[2], undefined);
  const apply = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("Add to failure network"));
  assert.ok(apply);
  await act(async () => apply.click());
  assert.equal(addChain.mock.callCount(), 1);
  assert.equal(addChain.mock.calls[0].arguments[1].failureMode, "Signal lost");
});

test("specialist failure stays visible and never invokes Work IQ fallback", async () => {
  await select("Failure Risk Prioritizer");
  service.ExecuteCopilotAsyncV2 = mock.fn(async () => ({ success: false, error: "private details" }));
  await click("Challenge ratings");
  assert.match(document.body.textContent, /selected helper couldn't complete/i);
  assert.doesNotMatch(document.body.textContent, /private details/);
  assert.equal(workiq.callWorkIqCopilotChatText.mock.callCount(), 0);
});
