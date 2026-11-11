import { mock } from "node:test";
import { CONVERSATION } from "./mcp-fixture.mjs";

export function agentNodeReply(result = "Specialist answer", conversationId = CONVERSATION) {
  return { success: true, data: { conversationId, result } };
}

export function agentNodeService() {
  return { InvokeAgent: mock.fn(async () => agentNodeReply()) };
}

export function nativeAgentMock(service) {
  class AgentNodeTransportError extends Error {
    constructor(code, message, channelReason) {
      super(message);
      this.code = code;
      this.channelReason = channelReason;
    }
  }
  const native = {
    AgentNodeTransportError,
    NATIVE_AGENT_TIMEOUT_MS: 180_000,
    async invokeAgentNode(body, conversationId, environmentId, _assertCurrent, _deadline, onDispatch) {
      if (native.channelError) throw native.channelError;
      onDispatch?.();
      const response = await service.InvokeAgent(body, conversationId, environmentId);
      if (!response.success) throw new Error("The agent connection failed.");
      return response.data;
    },
  };
  return native;
}
