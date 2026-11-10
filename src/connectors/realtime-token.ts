import { DFMEARealtimeVoiceBrokerService } from "../../generated";
import type { RealtimeVoiceToken } from "@/hooks/use-realtime-voice";

export async function acquireRealtimeToken(): Promise<RealtimeVoiceToken> {
  const result = await DFMEARealtimeVoiceBrokerService.RequestRealtimeToken({});
  if (!result.success) throw new Error("The realtime voice token connector failed.");
  const token: unknown = result.data;
  if (
    typeof token !== "object" || token === null ||
    !("value" in token) || typeof token.value !== "string" || !token.value.trim() ||
    !("callsUrl" in token) || token.callsUrl !== "https://dfmea-voice-fy27.openai.azure.com/openai/v1/realtime/calls" ||
    !("model" in token) || token.model !== "gpt-realtime-2.1" ||
    !("expiresAt" in token) || typeof token.expiresAt !== "number" || !Number.isFinite(token.expiresAt) ||
    token.expiresAt <= Date.now() / 1000
  ) {
    throw new Error("The realtime voice token connector returned an invalid or expired response.");
  }
  return { value: token.value, callsUrl: token.callsUrl, model: token.model };
}
