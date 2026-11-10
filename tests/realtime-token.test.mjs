import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import ts from "typescript";

const service = { RequestRealtimeToken: async () => ({ success: false }) };
globalThis.dfmeaTokenTestService = service;
const source = await readFile(new URL("../src/connectors/realtime-token.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
  /import \{ DFMEARealtimeVoiceBrokerService \} from "\.\.\/\.\.\/generated";/,
  "const DFMEARealtimeVoiceBrokerService = globalThis.dfmeaTokenTestService;",
);
const { acquireRealtimeToken } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis.dfmeaTokenTestService;

const valid = {
  value: "short-lived-test-token",
  callsUrl: "https://dfmea-voice-fy27.openai.azure.com/openai/v1/realtime/calls",
  model: "gpt-realtime-2.1",
  expiresAt: Date.now() / 1000 + 60,
};

test("validates the generated operation result and returns only ephemeral voice fields", async () => {
  let received;
  service.RequestRealtimeToken = async (body) => {
    received = body;
    return { success: true, data: valid };
  };
  assert.deepEqual(await acquireRealtimeToken(), {
    value: valid.value, callsUrl: valid.callsUrl, model: valid.model,
  });
  assert.deepEqual(received, {});
});

test("rejects unsuccessful connector responses without exposing upstream details", async () => {
  service.RequestRealtimeToken = async () => ({ success: false, error: "private details", data: valid });
  await assert.rejects(acquireRealtimeToken, { message: "The realtime voice token connector failed." });
});

test("rejects malformed, expired or unexpected endpoint/model responses", async () => {
  for (const data of [
    null, {}, { ...valid, value: "" }, { ...valid, value: "   " },
    { ...valid, expiresAt: Date.now() / 1000 - 1 },
    { ...valid, expiresAt: Number.NaN },
    { ...valid, expiresAt: "future" },
    { ...valid, callsUrl: "https://untrusted.example/calls" },
    { ...valid, model: "different-model" },
  ]) {
    service.RequestRealtimeToken = async () => ({ success: true, data });
    await assert.rejects(acquireRealtimeToken, /invalid or expired/);
  }
});
