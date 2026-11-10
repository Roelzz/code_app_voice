// Work IQ Copilot MCP client for a GENERATED App Builder app.
//
// Scope: this file is copied into an app's src/connectors/ and runs inside that
// app, in the user's browser, under the user's own Power Platform sign-in. It
// wraps exactly one certified Power Platform connector (shared_a365copilotchatmcp)
// and exactly one of its tools (copilot_chat). It is not an agent tool: the App
// Builder agent that copies it never executes it on its own behalf and sees its
// output only as untrusted evidence while validating the rendered app. Keep it
// that way — do not add a server-side or agent-side caller, and do not widen it
// to other MCP servers.
import { WorkIQCopilotMCPService } from "../../generated";
import type { QueryRequest } from "../../generated/models/WorkIQCopilotMCPModel";

export class WorkIqResponseError extends Error {
  /** Which layer of the reply failed (json, jsonrpc, content, envelope, assistant-text, not-json, schema, request). */
  readonly stage: string;

  constructor(message: string, stage = "response") {
    super(message);
    this.name = "WorkIqResponseError";
    this.stage = stage;
  }
}

export class WorkIqToolError extends WorkIqResponseError {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message, "tool");
    this.name = "WorkIqToolError";
    this.code = code;
  }
}

/** The connector call itself failed (sign-in, permission, timeout, service). */
export class WorkIqConnectorError extends WorkIqResponseError {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined, cause: unknown) {
    super(message, "connector");
    this.name = "WorkIqConnectorError";
    this.status = status;
    this.cause = cause;
  }
}

/**
 * The managed-app host aborts every connector request after 30 seconds and the
 * app cannot raise that limit (`http/send` carries no timeout field).
 */
export const WORKIQ_HOST_TIMEOUT_MS = 30_000;

/** The host stopped waiting for Copilot; the call did not fail upstream. */
export class WorkIqTimeoutError extends WorkIqConnectorError {
  readonly elapsedMs: number;

  constructor(elapsedMs: number, cause: unknown) {
    super("Work IQ call exceeded the host request time limit.", undefined, cause);
    this.name = "WorkIqTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export type WorkIqFieldType = "string" | "number" | "boolean";
export type WorkIqResponseSchema = Record<string, WorkIqFieldType>;

export type WorkIqSchemaItem<TSchema extends WorkIqResponseSchema> = {
  [TKey in keyof TSchema]:
    TSchema[TKey] extends "string" ? string
      : TSchema[TKey] extends "number" ? number
        : boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(text: string, layer: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkIqResponseError(`Invalid JSON in ${layer}.`, "json");
  }
}

function collectJsonRpcResponses(raw: unknown): JsonRpcResponse[] {
  const responses: JsonRpcResponse[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) {
      throw new WorkIqResponseError("Work IQ response nesting is too deep.", "jsonrpc");
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (/^data:/m.test(text)) {
        for (const event of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data || data === "[DONE]") continue;
          // Keep-alives, comments and plain-text heartbeats are not
          // JSON-RPC frames; skipping them must not abandon the response
          // that follows.
          let frame: unknown;
          try {
            frame = JSON.parse(data);
          } catch {
            continue;
          }
          visit(frame, depth + 1);
        }
        return;
      }
      visit(parseJson(text, "connector data"), depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if ("result" in value || "error" in value) {
      responses.push(value);
      return;
    }
    if ("data" in value) visit(value.data, depth + 1);
  };

  visit(raw, 0);
  return responses;
}

function requireJsonRpcResponse(
  raw: unknown,
  expectedId: string | number,
): JsonRpcResponse {
  const responses = collectJsonRpcResponses(raw);
  // Servers may echo the id as a number even though it was sent as a string.
  const response = responses.find(
    (candidate) =>
      (typeof candidate.id === "string" || typeof candidate.id === "number") &&
      String(candidate.id) === String(expectedId),
  );
  if (!response) {
    // A JSON-RPC protocol error (parse error, invalid request) legitimately
    // carries id: null because the server could not read the request id.
    // Surface it rather than reporting "no response"; a successful result
    // under another id is never adopted.
    const protocolError = responses.find(
      (candidate) =>
        (candidate.id === null || candidate.id === undefined) &&
        isRecord(candidate.error),
    );
    if (protocolError && isRecord(protocolError.error)) {
      throw toolError(protocolError.error);
    }
    throw new WorkIqResponseError(
      `Work IQ returned no JSON-RPC response for request ${expectedId}.`,
      "jsonrpc",
    );
  }
  if (isRecord(response.error)) throw toolError(response.error);
  return response;
}

function toolError(error: Record<string, unknown>): WorkIqToolError {
  const code = typeof error.code === "number" ? error.code : undefined;
  const message =
    typeof error.message === "string"
      ? error.message
      : "Work IQ returned a JSON-RPC error.";
  return new WorkIqToolError(message, code);
}

function textBlocks(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.content)) {
    throw new WorkIqResponseError("Work IQ result.content was not an array.", "content");
  }
  return result.content.flatMap((entry) =>
    isRecord(entry) &&
    entry.type === "text" &&
    typeof entry.text === "string" &&
    entry.text.trim()
      ? [entry.text]
      : [],
  );
}

function requireCopilotEnvelope(
  result: Record<string, unknown>,
): Record<string, unknown> {
  for (const text of textBlocks(result)) {
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed) && ("reply" in parsed || "rawResponse" in parsed)) {
        return parsed;
      }
    } catch {
      // Diagnostic text blocks are not answer envelopes.
    }
  }
  throw new WorkIqResponseError(
    "Work IQ content did not contain a Copilot answer envelope.",
    "envelope",
  );
}

function requireAssistantText(
  envelope: Record<string, unknown>,
  requestText: string,
): string {
  const trimmedRequest = requestText.trim();
  if (typeof envelope.reply === "string" && envelope.reply.trim()) {
    const reply = envelope.reply.trim();
    if (reply !== trimmedRequest) return reply;
  }
  if (typeof envelope.rawResponse === "string") {
    const rawResponse = parseJson(envelope.rawResponse, "Copilot rawResponse");
    if (!isRecord(rawResponse) || !Array.isArray(rawResponse.messages)) {
      throw new WorkIqResponseError(
        "Work IQ rawResponse did not contain a messages array.",
        "envelope",
      );
    }
    for (let index = rawResponse.messages.length - 1; index >= 0; index -= 1) {
      const message = rawResponse.messages[index];
      if (!isRecord(message) || typeof message.text !== "string") continue;
      const text = message.text.trim();
      if (!text) continue;
      // The transmitted request is never an answer, whatever the transcript
      // labels it: an "assistant" echo of a prompt that carries a fenced JSON
      // example would otherwise be parsed as connector data.
      if (text === trimmedRequest) break;
      const author =
        typeof message.role === "string"
          ? message.role.toLowerCase()
          : typeof message.author === "string"
            ? message.author.toLowerCase()
            : undefined;
      if (author === "user") break;
      if (
        author === "assistant" ||
        author === "copilot" ||
        author === "bot" ||
        author === undefined
      ) {
        return text;
      }
    }
  }
  throw new WorkIqResponseError(
    "Work IQ response did not contain assistant text.",
    "assistant-text",
  );
}

function arrayFrom(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const base = [(fenced?.[1] ?? text).trim()];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) base.push(text.slice(start, end + 1));
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) base.push(text.slice(objectStart, objectEnd + 1));
  // Also try each candidate with trailing commas removed (a common model slip).
  const candidates = base.flatMap((candidate) => [candidate, candidate.replace(/,\s*([\]}])/g, "$1")]);
  for (const candidate of candidates) {
    const parsed = arrayFrom(tryParse(candidate));
    if (parsed) return parsed;
  }
  throw new WorkIqResponseError("Work IQ Copilot reply was not a JSON array.", "not-json");
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function projectSchemaFields<TSchema extends WorkIqResponseSchema>(
  value: unknown,
  schema: TSchema,
): WorkIqSchemaItem<TSchema> | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const byKey = new Map(Object.entries(value).map(([key, entry]) => [normalizeKey(key), entry]));
  const projected: Record<string, string | number | boolean> = {};
  for (const [field, type] of Object.entries(schema)) {
    const fieldValue = field in value ? value[field] : byKey.get(normalizeKey(field));
    if (
      type === "string" &&
      (typeof fieldValue === "number" || typeof fieldValue === "boolean")
    ) {
      projected[field] = String(fieldValue);
      continue;
    }
    if (typeof fieldValue !== type) return undefined;
    if (type === "string" && !(fieldValue as string).trim()) return undefined;
    projected[field] = fieldValue as string | number | boolean;
  }
  return projected as WorkIqSchemaItem<TSchema>;
}

function structuredPrompt(
  message: string,
  schema: WorkIqResponseSchema,
): string {
  const fields = Object.entries(schema);
  if (fields.length === 0) {
    throw new WorkIqResponseError(
      "Work IQ requires at least one response field.",
      "request",
    );
  }
  const shape = fields.map(([field, type]) => `${field}:${type}`).join(", ");
  const separator = /[.!?]$/.test(message) ? " " : ". ";
  return `${message}${separator}Return only a JSON array with ${shape}.`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "Work IQ connector call failed.";
}

function assistantTextFrom(
  raw: unknown,
  expectedId: string | number,
  requestText: string,
): string {
  const response = requireJsonRpcResponse(raw, expectedId);
  if (!isRecord(response.result)) {
    throw new WorkIqResponseError("Work IQ JSON-RPC result was missing.", "jsonrpc");
  }
  if (response.result.isError === true) {
    const message = textBlocks(response.result).join(" ") ||
      "Work IQ reported an MCP tool error.";
    throw new WorkIqToolError(message);
  }
  return requireAssistantText(requireCopilotEnvelope(response.result), requestText);
}

function parseWorkIqCopilotItems<TSchema extends WorkIqResponseSchema>(
  text: string,
  schema: TSchema,
): WorkIqSchemaItem<TSchema>[] {
  const items = parseArray(text);
  const fields = Object.keys(schema);
  const valid = items.flatMap((item) => {
    const candidate =
      typeof item === "string" && fields.length === 1 ? { [fields[0]]: item } : item;
    const projected = projectSchemaFields(candidate, schema);
    return projected ? [projected] : [];
  });
  if (items.length > 0 && valid.length === 0) {
    throw new WorkIqResponseError(
      "No Work IQ Copilot reply item passed schema validation.",
      "schema",
    );
  }
  return valid;
}

let requestId = 0;
let queue: Promise<unknown> = Promise.resolve();

function isHostTimeout(error: unknown, status: number | undefined, elapsedMs: number): boolean {
  if (status === 408 || status === 504) return true;
  if (status !== undefined && status !== 0) return false;
  // Thrown host errors arrive without a status; a failure at the time limit is the limit.
  if (elapsedMs >= WORKIQ_HOST_TIMEOUT_MS - 1_000) return true;
  return /time ?out|timed out|abort/i.test(errorMessage(error));
}

/** Copilot calls run one at a time so concurrent callers never compete for the 30-second window. */
function callCopilotChat(requestText: string): Promise<string> {
  const run = queue.then(
    () => sendCopilotChat(requestText),
    () => sendCopilotChat(requestText),
  );
  queue = run.catch(() => undefined);
  return run;
}

/** One copilot_chat tools/call through the bound connector; returns the validated assistant text. */
async function sendCopilotChat(requestText: string): Promise<string> {
  requestId += 1;
  // The generated QueryRequest types the JSON-RPC id as a string.
  const currentRequestId = String(requestId);
  const request: QueryRequest = {
    jsonrpc: "2.0",
    id: currentRequestId,
    method: "tools/call",
    params: {
      name: "copilot_chat",
      arguments: { message: requestText },
    },
  };

  const startedAt = Date.now();
  let operation: Awaited<ReturnType<typeof WorkIQCopilotMCPService.mcp_m365copilot>>;
  try {
    operation = await WorkIQCopilotMCPService.mcp_m365copilot(undefined, request);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (isHostTimeout(error, undefined, elapsedMs)) throw new WorkIqTimeoutError(elapsedMs, error);
    throw new WorkIqConnectorError(errorMessage(error), undefined, error);
  }
  if (!operation.success) {
    const elapsedMs = Date.now() - startedAt;
    const status =
      isRecord(operation.error) && typeof operation.error.status === "number"
        ? operation.error.status
        : undefined;
    if (isHostTimeout(operation.error, status, elapsedMs)) {
      throw new WorkIqTimeoutError(elapsedMs, operation.error);
    }
    throw new WorkIqConnectorError(errorMessage(operation.error), status, operation.error);
  }
  return assistantTextFrom(operation.data, currentRequestId, requestText);
}

/** Structured rows validated against a flat schema (for content the app adds to its data). */
export async function callWorkIqCopilotChatItems<
  TSchema extends WorkIqResponseSchema,
>(
  message: string,
  schema: TSchema,
): Promise<WorkIqSchemaItem<TSchema>[]> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new WorkIqResponseError("Work IQ requires a non-empty prompt.", "request");
  }
  const requestText = structuredPrompt(trimmedMessage, schema);
  return parseWorkIqCopilotItems(await callCopilotChat(requestText), schema);
}

/** Copilot's validated answer text for conversational requests; never parsed into data rows. */
export async function callWorkIqCopilotChatText(message: string): Promise<string> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new WorkIqResponseError("Work IQ requires a non-empty prompt.", "request");
  }
  return callCopilotChat(trimmedMessage);
}
