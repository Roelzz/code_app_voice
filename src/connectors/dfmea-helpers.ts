import { MicrosoftCopilotStudioService } from "../../generated";
import {
  callWorkIqCopilotChatItems, callWorkIqCopilotChatText,
  WorkIqConnectorError, WorkIqResponseError,
  type WorkIqResponseSchema, type WorkIqSchemaItem,
} from "@/connectors/workiq-copilot-chat";

export const DFMEA_HELPERS = [
  { id: "workiq", name: "Microsoft 365 Copilot", description: "General workshop facilitation, with optional Microsoft 365 file search.", schemaName: null },
  { id: "failure-modes", name: "Failure Mode Identifier", description: "Explore how a component or function can fail, with effects and causes.", schemaName: "Default_Failure_Mode_Identifier_c24230" },
  { id: "risk", name: "Failure Risk Prioritizer", description: "Discuss severity, occurrence, detection and risk prioritization.", schemaName: "Default_Failure_Risk_Prioritizer_b311df" },
  { id: "actions", name: "Corrective Action Advisor", description: "Explore practical design, prevention and detection improvements.", schemaName: "Default_Corrective_Action_Advisor_8765ed" },
] as const;

export type HelperId = typeof DFMEA_HELPERS[number]["id"];
export const HELPER_ENVIRONMENT = "28207d24-1fb8-e2ed-ba6e-180550d63611";

export function getHelper(id: HelperId) {
  return DFMEA_HELPERS.find((helper) => helper.id === id)!;
}

export class HelperError extends Error {
  constructor(readonly code: "busy" | "stale" | "connection" | "format" | "timeout", message: string) {
    super(message);
    this.name = "HelperError";
  }
}

export function parseStudioReply(data: unknown): { text: string; conversationId: string } {
  if (!data || typeof data !== "object") throw new HelperError("format", "The helper returned no readable response.");
  const { responses, lastResponse, conversationId } = data as Record<string, unknown>;
  if (typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 2048) {
    throw new HelperError("format", "The helper returned an invalid conversation identifier.");
  }
  if (responses !== undefined && (!Array.isArray(responses) || responses.some((item) => typeof item !== "string"))) {
    throw new HelperError("format", "The helper returned unsupported response content.");
  }
  if (lastResponse !== undefined && typeof lastResponse !== "string") {
    throw new HelperError("format", "The helper returned unsupported response content.");
  }
  const parts = Array.isArray(responses) ? responses.filter((text: string) => text.trim()) : [];
  const text = parts.length ? parts.join("\n\n") : typeof lastResponse === "string" ? lastResponse.trim() : "";
  if (!text) throw new HelperError("format", "The helper returned no text. Interactive cards and sign-in actions are not supported here.");
  return { text, conversationId };
}

export type HelperRows<T extends WorkIqResponseSchema> =
  | { kind: "rows"; items: WorkIqSchemaItem<T>[] }
  | { kind: "clarification"; text: string };

function studioRows<T extends WorkIqResponseSchema>(text: string, schema: T): HelperRows<T> {
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

  select(id: HelperId) {
    this.helperId = id;
    this.conversationId = undefined;
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

  private async studioText(schemaName: string, prompt: string): Promise<string> {
    const generation = this.generation;
    let response: unknown;
    try {
      const result = await MicrosoftCopilotStudioService.ExecuteCopilotAsyncV2(
        schemaName, { message: prompt }, this.conversationId, HELPER_ENVIRONMENT,
      );
      if (!result.success) throw new HelperError("connection", "The selected agent connection needs attention. Check sign-in, agent access and availability.");
      // The generated operation currently declares void; validate its actual payload without modifying codegen.
      response = result.data;
    } catch (error) {
      if (error instanceof HelperError) throw error;
      throw new HelperError("connection", "The selected agent could not be reached. Check the connection and agent access.");
    }
    const reply = parseStudioReply(response);
    if (generation === this.generation) this.conversationId = reply.conversationId;
    return reply.text;
  }

  text(prompt: string): Promise<string> {
    return this.run((helper) => helper.schemaName === null
      ? callWorkIqCopilotChatText(prompt)
      : this.studioText(helper.schemaName, prompt));
  }

  items<T extends WorkIqResponseSchema>(prompt: string, schema: T): Promise<HelperRows<T>> {
    return this.run(async (helper) => {
      if (helper.schemaName === null) return { kind: "rows", items: await callWorkIqCopilotChatItems(prompt, schema) };
      const shape = Object.entries(schema).map(([field, type]) => `${field}:${type}`).join(", ");
      const text = await this.studioText(helper.schemaName,
        `${prompt} When ready to offer suggestions, return only a JSON array with ${shape}. If you need clarification, ask it instead; do not invent facts to fill the schema.`);
      return studioRows(text, schema);
    });
  }
}

export function helperErrorMessage(error: unknown): string {
  if (error instanceof HelperError) return error.message;
  if (error instanceof WorkIqConnectorError) return "Microsoft 365 Copilot could not answer. Check the connection or try a shorter question.";
  if (error instanceof WorkIqResponseError) return "Microsoft 365 Copilot returned an unreadable answer. Try again.";
  return "The selected helper could not answer. Try again.";
}
