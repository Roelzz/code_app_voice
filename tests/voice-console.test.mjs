import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const modules = new Map();
async function load(path) {
  if (modules.has(path)) return modules.get(path);
  let source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const dependencies = [...source.matchAll(/from "(@\/[^"]+)"/g)];
  for (const [, name] of dependencies) {
    if (name.includes("/hooks/")) continue;
    const relative = name.slice(2);
    const url = await load(`${relative}.${relative === "lib/utils" ? "ts" : "tsx"}`);
    source = source.replaceAll(`"${name}"`, JSON.stringify(url));
  }
  source = source.replace(/from "([^"]+)"/g, (match, name) =>
    name.startsWith("data:") || name.startsWith("@/") ? match : `from ${JSON.stringify(import.meta.resolve(name))}`);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  // Classic JSX is used to keep the runtime import resolvable inside a data URL.
  const withReact = /import \* as React/.test(output) ? output : `import React from ${JSON.stringify(import.meta.resolve("react"))};\n${output}`;
  const url = `data:text/javascript;base64,${Buffer.from(withReact).toString("base64")}`;
  modules.set(path, url);
  return url;
}

let window;
let saved;
let root;
let VoiceConsole;
let start;
let stop;
let props;

beforeEach(async () => {
  window = new Window({ url: "http://localhost:5173" });
  saved = new Map();
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle"]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = typeof window[name] === "function" && name === "getComputedStyle" ? window[name].bind(window) : name === "window" ? window : window[name];
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  saved.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ VoiceConsole } = await import(await load("components/voice-console.tsx")));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  start = mock.fn();
  stop = mock.fn();
  props = { status: "idle", activity: "listening", error: null, focus: "Sensor assembly", step: "Step 4: Failure analysis", disabled: false, onStart: start, onStop: stop };
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  await window.happyDOM.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(next = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(React.createElement(VoiceConsole, props)));
}

async function click(label) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  assert.ok(button, `Button ${label} exists`);
  await act(async () => button.click());
}

test("opening does not start the mic; Start is explicit and closing stops then restores focus", async () => {
  await click("Talk to Copilot");
  assert.equal(start.mock.callCount(), 0);
  assert.match(document.body.textContent, /Sensor assembly/);
  assert.match(document.body.textContent, /Ready when you are/);
  await click("Start voice session");
  assert.equal(start.mock.callCount(), 1);
  await render({ status: "connecting" });
  await click("Stop connecting");
  assert.equal(stop.mock.callCount(), 1);
  await click("Close");
  assert.equal(stop.mock.callCount(), 2);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement.textContent, "Talk to Copilot");
  await render({ status: "idle" });
  await click("Talk to Copilot");
  assert.equal(start.mock.callCount(), 1);
});

test("connected console exposes actual activity and Escape ends the session", async () => {
  await click("Talk to Copilot");
  await render({ status: "connected", activity: "consulting" });
  assert.match(document.body.textContent, /Consulting helper/);
  assert.equal(document.querySelector("[data-voice-state]").getAttribute("data-voice-state"), "consulting");
  await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test("voice console names the selected specialist instead of claiming Work IQ", async () => {
  await render({ helperName: "Failure Risk Prioritizer" });
  await click("Talk to Copilot");
  assert.match(document.body.textContent, /Answer source: Failure Risk Prioritizer/);
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /Work IQ|Microsoft 365 Copilot/);
});

test("safe errors are visible in the dialog and busy state prevents starting", async () => {
  await click("Talk to Copilot");
  await render({ error: "Microphone access was denied.", disabled: true });
  assert.equal(document.querySelector('[role="alert"]').textContent, "Microphone access was denied.");
  assert.equal([...document.querySelectorAll("button")].find((item) => item.textContent === "Start voice session").disabled, true);
});

test("clicking outside the console stops a connecting session", async () => {
  await click("Talk to Copilot");
  await render({ status: "connecting" });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  await act(async () => {
    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    document.body.click();
  });
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
});
