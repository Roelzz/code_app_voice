import { DFMEASpecialistMCPService } from "../../generated";
import type { McpRequest } from "../../generated/models/DFMEASpecialistMCPModel";
import {
  callWorkIqCopilotChatItems, callWorkIqCopilotChatText,
  WorkIqConnectorError, WorkIqResponseError,
  type WorkIqResponseSchema, type WorkIqSchemaItem,
} from "@/connectors/workiq-copilot-chat";

export const DFMEA_HELPERS = [
  { id: "workiq", name: "Microsoft 365 Copilot", description: "General workshop facilitation, with optional Microsoft 365 file search.", schemaName: null },
  { id: "failure-modes", name: "Failure Mode Identifier", description: "Explore how a component or function can fail, with effects and causes.", schemaName: "Default_Failure_Mode_Identifier_20cdd7" },
  { id: "risk", name: "Failure Risk Prioritizer", description: "Discuss severity, occurrence, detection and risk prioritization.", schemaName: "Default_Failure_Risk_Prioritizer_5a9a6a" },
  { id: "actions", name: "Corrective Action Advisor", description: "Explore practical design, prevention and detection improvements.", schemaName: "Default_Corrective_Action_Advisor_7867b1" },
] as const;

export type HelperId = typeof DFMEA_HELPERS[number]["id"];
export const HELPER_ENVIRONMENT = "75660de8-d408-e9ce-bc60-84d4f6a30d0b";

export function getHelper(id: HelperId) {
  return DFMEA_HELPERS.find((helper) => helper.id === id)!;
}

export class HelperError extends Error {
  constructor(readonly code: "busy" | "stale" | "connection" | "format" | "timeout" | "unsupported" | "policy", message: string) {
    super(message);
    this.name = "HelperError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidReply(): never {
  throw new HelperError("format", "The helper returned an unreadable MCP response. Try a new conversation.");
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return invalidReply(); }
}

/** Custom connector code wraps the bounded SSE stream; only the matching final RPC result is accepted. */
export function parseMcpResult(data: unknown, id: string): Record<string, unknown> {
  if (!record(data) || typeof data.events !== "string" || !data.events.trim() || data.events.length > 524288) return invalidReply();
  const raw = data.events.trim();
  const messages = raw.startsWith("{") ? [parseJson(raw)] :
    raw.replace(/\r\n/g, "\n").split(/\n\n+/).flatMap((event) => {
      const payload = event.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      return payload ? [parseJson(payload)] : [];
    });
  let final: Record<string, unknown> | undefined;
  for (const message of messages) {
    if (!record(message) || message.jsonrpc !== "2.0") return invalidReply();
    if (!("id" in message) && typeof message.method === "string" && !("result" in message) && !("error" in message)) continue;
    if (message.id !== id || final || ("result" in message) === ("error" in message)) return invalidReply();
    if ("error" in message) {
      throw new HelperError("connection", "The specialist MCP service could not complete the request. Check agent access and availability.");
    }
    if (!record(message.result)) return invalidReply();
    final = message.result;
  }
  return final ?? invalidReply();
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMcpReply(result: Record<string, unknown>, expectedConversation?: string): { text: string; conversationId: string } {
  if (result.isError === true) {
    throw new HelperError("connection", "The selected specialist could not answer. Check agent access and availability.");
  }
  let envelope: unknown = result.structuredContent;
  if (envelope === undefined) {
    if (!Array.isArray(result.content) || result.content.length !== 1 ||
        !record(result.content[0]) || result.content[0].type !== "text" || typeof result.content[0].text !== "string") return invalidReply();
    if (/EnvironmentGroupPolicyViolation/i.test(result.content[0].text)) {
      throw new HelperError("policy", "The specialist was blocked by its environment policy. Ask the environment administrator to review the agent; retrying will not fix this.");
    }
    envelope = parseJson(result.content[0].text);
  }
  if (!record(envelope)) return invalidReply();
  const { conversationId, response, result_type } = envelope;
  if (result_type !== undefined && result_type !== "success") {
    throw new HelperError("connection", "The selected specialist could not complete its response.");
  }
  if (typeof conversationId !== "string" || !GUID.test(conversationId) ||
      (expectedConversation !== undefined && conversationId !== expectedConversation) ||
      !Array.isArray(response) || response.some((part) => typeof part !== "string")) return invalidReply();
  const text = response.filter((part: string) => part.trim()).join("\n\n");
  if (!text) return invalidReply();
  if (/EnvironmentGroupPolicyViolation/i.test(text)) {
    throw new HelperError("policy", "The specialist was blocked by its environment policy. Ask the environment administrator to review the agent; retrying will not fix this.");
  }
  if (/^This action (?:doesn't|does not) support agents built with the GitHub Copilot harness[.\s]/i.test(text.trim())) {
    throw new HelperError("unsupported", "This action cannot invoke the selected specialist. Its supported MCP publishing channel is required.");
  }
  return { text, conversationId };
}

export type HelperRows<T extends WorkIqResponseSchema> =
  | { kind: "rows"; items: WorkIqSchemaItem<T>[] }
  | { kind: "clarification"; text: string };

function helperRows<T extends WorkIqResponseSchema>(text: string, schema: T): HelperRows<T> {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return { kind: "clarification", text };
  }
  if (!Array.isArray(value) || !value.every((row: unknown) =>
    row !== null && typeof row === "object" && Object.entries(schema).every(([key, type]) =>
      key in row && typeof row[key as keyof typeof row] === type &&
      (type !== "string" || String(row[key as keyof typeof row]).trim().length > 0)))) {
    return { kind: "clarification", text };
  }
  if ("action" in schema && "type" in schema &&
    value.some((row: Record<string, unknown>) => row.type !== "Prevention" && row.type !== "Detection")) {
    return { kind: "clarification", text };
  }
  // Every required field is checked above; extra untrusted properties are discarded.
  const items = value.map((row: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(schema).map((key) => [key, row[key]])) as WorkIqSchemaItem<T>);
  return { kind: "rows", items };
}

/** One session-wide gate also covers a helper switch while an upstream request is still running. */
export class HelperSession {
  private generation = 0;
  private conversationId: string | undefined;
  private busy = false;
  private helperId: HelperId = "workiq";
  private initialized = false;

  select(id: HelperId) {
    this.helperId = id;
    this.conversationId = undefined;
    this.initialized = false;
    this.generation += 1;
  }

  private async run<T>(request: (helper: ReturnType<typeof getHelper>) => Promise<T>): Promise<T> {
    if (this.busy) throw new HelperError("busy", "The previous helper request is still finishing. Wait before sending another question.");
    this.busy = true;
    const generation = this.generation;
    const operation = request(getHelper(this.helperId)).finally(() => { this.busy = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (generation === this.generation) {
          this.generation += 1;
          this.conversationId = undefined;
          this.initialized = false;
        }
        reject(new HelperError("timeout", "The helper did not answer within the app's 30-second limit. The upstream request may still be finishing; wait before trying again."));
      }, 30_000);
    });
    try {
      const result = await Promise.race([operation, timeout]);
      if (generation !== this.generation) throw new HelperError("stale", "This answer belongs to an ended conversation.");
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async specialistText(helper: ReturnType<typeof getHelper>, prompt: string): Promise<string> {
    const generation = this.generation;
    const ensureCurrent = () => {
      if (generation !== this.generation) throw new HelperError("stale", "This answer belongs to an ended conversation.");
    };
    const rpc = async (method: McpRequest["method"], params: McpRequest["params"]) => {
      ensureCurrent();
      const body: McpRequest = { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
      const result = helper.id === "failure-modes" ? await DFMEASpecialistMCPService.FailureModeMcp(body) :
        helper.id === "risk" ? await DFMEASpecialistMCPService.RiskMcp(body) :
          await DFMEASpecialistMCPService.ActionMcp(body);
      ensureCurrent();
      if (!result.success) throw new HelperError("connection", "The selected agent connection needs attention. Check sign-in, agent access and availability.");
      return parseMcpResult(result.data, body.id);
    };
    try {
      if (!this.initialized) {
        const info = await rpc("initialize", {
          protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "DFMEA Workshop Studio", version: "1.0" },
        });
        if (info.protocolVersion !== "2025-03-26" || !record(info.capabilities) || !record(info.capabilities.tools)) return invalidReply();
        const list = await rpc("tools/list", {});
        if (!Array.isArray(list.tools) || !list.tools.some((tool) => record(tool) && tool.name === "send-message")) {
          throw new HelperError("unsupported", "The selected specialist does not expose the supported send-message tool.");
        }
        this.initialized = true;
      }
      const result = await rpc("tools/call", {
        name: "send-message",
        arguments: { message: prompt, ...(this.conversationId ? { conversationId: this.conversationId } : {}) },
      });
      const reply = parseMcpReply(result, this.conversationId);
      ensureCurrent();
      this.conversationId = reply.conversationId;
      return reply.text;
    } catch (error) {
      if (generation === this.generation) {
        this.conversationId = undefined;
        this.initialized = false;
      }
      if (error instanceof HelperError) throw error;
      throw new HelperError("connection", "The selected agent could not be reached. Check the connection and agent access.");
    }
  }

  text(prompt: string): Promise<string> {
    return this.run((helper) => helper.schemaName === null
      ? callWorkIqCopilotChatText(prompt)
      : this.specialistText(helper, prompt));
  }

  items<T extends WorkIqResponseSchema>(prompt: string, schema: T): Promise<HelperRows<T>> {
    return this.run(async (helper) => {
      if (helper.schemaName === null) return { kind: "rows", items: await callWorkIqCopilotChatItems(prompt, schema) };
      const shape = Object.entries(schema).map(([field, type]) => `${field}:${type}`).join(", ");
      const text = await this.specialistText(helper,
        `${prompt} When ready to offer suggestions, return only a JSON array with ${shape}. If you need clarification, ask it instead; do not invent facts to fill the schema.`);
      return helperRows(text, schema);
    });
  }
}

export function helperErrorMessage(error: unknown): string {
  if (error instanceof HelperError) return error.message;
  if (error instanceof WorkIqConnectorError) return "Microsoft 365 Copilot could not answer. Check the connection or try a shorter question.";
  if (error instanceof WorkIqResponseError) return "Microsoft 365 Copilot returned an unreadable answer. Try again.";
  return "The selected helper could not answer. Try again.";
}
