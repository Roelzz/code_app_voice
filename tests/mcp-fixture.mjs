import { mock } from "node:test";

export const CONVERSATION = "943c4eb2-d923-417a-b696-33709c6bbf47";
export const NEXT_CONVERSATION = "fe84a472-b930-463b-ad62-089e1fb881c4";
export const rpcResult = (id, result) => ({
  success: true,
  data: { events: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n` },
});
export const toolResult = (text = "Specialist answer", conversationId = CONVERSATION) => ({
  content: [{ type: "text", text: JSON.stringify({ conversationId, response: [text] }) }],
});

export function mcpService(answer = async () => toolResult()) {
  return Object.fromEntries(["FailureModeMcp", "RiskMcp", "ActionMcp"].map((operation) => [
    operation, mock.fn(async (request) => {
      if (request.method === "initialize") return rpcResult(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} } });
      if (request.method === "notifications/initialized") return { success: true, data: { events: "" } };
      if (request.method === "tools/list") return rpcResult(request.id, { tools: [{ name: "send-message" }] });
      return rpcResult(request.id, await answer(request, operation));
    }),
  ]));
}

export const toolCalls = (method) => method.mock.calls
  .map(({ arguments: [request] }) => request).filter((request) => request.method === "tools/call");
