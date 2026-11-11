import { useCallback, useEffect, useRef, useState } from "react";
import { claimRealtimeAudio } from "@/hooks/use-voice";

export interface RealtimeVoiceToken {
  value: string;
  callsUrl: string;
  model: string;
}

export type RealtimeVoiceStatus = "idle" | "connecting" | "connected";
export type RealtimeVoiceActivity = "listening" | "hearing" | "processing" | "consulting" | "speaking";

interface RealtimeEvent {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  [key: string]: unknown;
}

const VOICE_TOOL = {
  type: "function",
  name: "ask_copilot",
  description:
    "Ask the selected DFMEA helper. Use this for every question; do not answer from model knowledge.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The user's question, preserving its intent." },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

const SESSION_INSTRUCTIONS =
  "You are the voice interface for a DFMEA workshop. The selected helper is the only source of answers. For every user question, call ask_copilot and wait for its result. Do not answer from your own knowledge, invent details, or claim to have searched files. Briefly acknowledge while waiting. After the tool returns, speak a concise version of its answer. If the tool reports an error, explain its supplied recovery instructions; do not retry, switch helpers or invent an answer.";

const SETUP_TIMEOUT_MS = 30_000;
const CALLS_URL = "https://dfmea-voice-fy27.openai.azure.com/openai/v1/realtime/calls";

interface VoiceRun {
  controller: AbortController;
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  stream: MediaStream | null;
  audio: HTMLAudioElement | null;
  timer: ReturnType<typeof setTimeout> | null;
  toolTimer: ReturnType<typeof setTimeout> | null;
  releaseAudio: (() => void) | null;
}

interface VoiceToolCall {
  callId: string;
  responseId: string;
  output: string | null;
  error: string | null;
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function parseQuestion(args: string | undefined): string | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null || !("question" in parsed)) return null;
    const question = parsed.question;
    return typeof question === "string" && question.trim() ? question.trim() : null;
  } catch {
    return null;
  }
}

export function useRealtimeVoice({
  requestToken,
  askCopilot,
  onError,
  helperTimeoutMs,
  formatHelperError,
  getHelperTimeoutHint,
  helperName = "Microsoft 365 Copilot",
}: {
  requestToken: () => Promise<RealtimeVoiceToken>;
  askCopilot: (question: string) => Promise<string>;
  onError: (message: string) => void;
  helperTimeoutMs: number;
  formatHelperError?: (error: unknown) => string;
  getHelperTimeoutHint?: () => string | undefined;
  helperName?: string;
}) {
  const [status, setStatus] = useState<RealtimeVoiceStatus>("idle");
  const [activity, setActivity] = useState<RealtimeVoiceActivity>("listening");
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<VoiceRun | null>(null);
  const askCopilotRef = useRef(askCopilot);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    askCopilotRef.current = askCopilot;
    onErrorRef.current = onError;
  }, [askCopilot, onError]);

  const cleanup = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    run.controller.abort();
    if (run.timer !== null) clearTimeout(run.timer);
    if (run.toolTimer !== null) clearTimeout(run.toolTimer);
    if (run.channel) {
      run.channel.onopen = null;
      run.channel.onmessage = null;
      run.channel.onerror = null;
      run.channel.onclose = null;
      run.channel.close();
    }
    if (run.peer) {
      run.peer.ontrack = null;
      run.peer.onconnectionstatechange = null;
      run.peer.close();
    }
    run.stream?.getTracks().forEach((track) => track.stop());
    if (run.audio) {
      run.audio.pause();
      run.audio.srcObject = null;
    }
    run.releaseAudio?.();
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setStatus("idle");
    setActivity("listening");
  }, [cleanup]);

  const start = useCallback(async () => {
    if (runRef.current) return;
    const askQuestion = askCopilotRef.current;
    const run: VoiceRun = {
      controller: new AbortController(), peer: null, channel: null, stream: null,
      audio: null, timer: null, toolTimer: null, releaseAudio: null,
    };
    run.releaseAudio = claimRealtimeAudio(stop);
    runRef.current = run;
    const current = () => runRef.current === run;
    const fail = (message: string) => {
      if (!current()) return;
      setError(message);
      onErrorRef.current(message);
      stop();
    };
    run.timer = setTimeout(() => {
      fail("Realtime voice setup timed out after 30 seconds. Check permissions and the connection, then try again.");
    }, SETUP_TIMEOUT_MS);
    setError(null);
    setStatus("connecting");
    let stage: "microphone" | "token" | "connection" = "microphone";

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
        throw new Error("unsupported");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      run.stream = stream;
      stage = "token";
      const token = await requestToken();
      if (!current()) return;
      if (!token.value || token.callsUrl !== CALLS_URL || !token.model) {
        throw new Error("invalid-token");
      }

      const peer = new RTCPeerConnection();
      run.peer = peer;
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      run.audio = remoteAudio;
      peer.ontrack = (event) => {
        if (!current()) return;
        remoteAudio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void remoteAudio.play().catch(() => {
          fail("Audio playback was blocked. Allow audio for this app, then start voice again.");
        });
      };

      const channel = peer.createDataChannel("oai-events");
      run.channel = channel;
      const send = (event: object) => {
        if (!current()) return false;
        try {
          channel.send(JSON.stringify(event));
          return true;
        } catch {
          fail("The realtime voice data channel could not send the request. Start voice again.");
          return false;
        }
      };
      channel.onopen = () => {
        if (!current()) return;
        send({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: `${SESSION_INSTRUCTIONS} Selected helper: ${helperName}.`,
              tools: [VOICE_TOOL],
              tool_choice: "required",
            },
        });
      };
      const calls = new Set<string>();
      let finishedResponseId: string | null = null;
      let pending: VoiceToolCall | null = null;
      const speakResult = () => {
        if (!current() || !pending || pending.output === null || pending.responseId !== finishedResponseId) return;
        if (run.toolTimer !== null) clearTimeout(run.toolTimer);
        run.toolTimer = null;
        if (!send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: pending.callId, output: pending.output },
        })) return;
        pending = null;
        send({ type: "response.create", response: { tool_choice: "none" } });
      };
      channel.onmessage = (message) => {
        if (!current()) return;
        let event: unknown;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          fail("The realtime voice connection returned an unreadable event.");
          return;
        }
        if (!isRealtimeEvent(event)) {
          fail("The realtime voice connection returned an invalid event.");
          return;
        }
        if (event.type === "error") {
          fail("The realtime voice service rejected the session or request. Try again.");
          return;
        }
        if (event.type === "session.updated") {
          if (run.timer !== null) clearTimeout(run.timer);
          run.timer = null;
          setStatus("connected");
          setActivity("listening");
          return;
        }
        if (event.type === "input_audio_buffer.speech_started") {
          setActivity("hearing");
          return;
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          setActivity("processing");
          return;
        }
        if (event.type === "output_audio_buffer.started") {
          setActivity("speaking");
          return;
        }
        if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
          setActivity(pending ? "consulting" : "listening");
          return;
        }
        if (event.type === "response.done") {
          const response = event.response;
          if (typeof response === "object" && response !== null && "id" in response && typeof response.id === "string") {
            finishedResponseId = response.id;
            speakResult();
          }
          return;
        }
        if (event.type !== "response.function_call_arguments.done") return;
        if (event.name !== "ask_copilot" || typeof event.call_id !== "string" || typeof event.response_id !== "string") {
          fail("The voice model requested an unsupported action.");
          return;
        }

        const question = parseQuestion(event.arguments);
        const callId = event.call_id;
        if (calls.has(callId)) return;
        calls.add(callId);
        if (pending) {
          fail("The helper is already answering a voice question. Start voice again after the request finishes.");
          return;
        }
        const request: VoiceToolCall = { callId, responseId: event.response_id, output: null, error: null };
        pending = request;
        setActivity("consulting");
        run.toolTimer = setTimeout(() => {
          if (!current()) return;
          const hint = getHelperTimeoutHint?.() ?? "Try a shorter question.";
          fail(request.error ?? `The helper did not answer within the app's ${helperTimeoutMs / 1000}-second limit. ${hint}`);
        }, helperTimeoutMs);
        void (async () => {
          let output: string;
          try {
            if (!question) throw new Error("The voice model did not provide a valid question.");
            output = await askQuestion(question);
          } catch (error) {
            if (!current()) return;
            const message = formatHelperError?.(error) ?? "The selected helper could not answer the voice question. Check the connection or try again.";
            request.error = message;
            output = `The selected helper could not answer this request. ${message} Explain this error to the user; do not retry or make up an answer.`;
            onErrorRef.current(message);
          }
          if (!current()) return;
          request.output = output;
          speakResult();
        })();
      };
      channel.onerror = () => fail("The realtime voice data channel failed. Try again.");
      channel.onclose = () => fail("The realtime voice connection closed. Start voice again.");
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          fail("The realtime voice connection failed. Check the app's network policy and try again.");
        }
      };

      stage = "connection";
      const offer = await peer.createOffer();
      if (!current()) return;
      await peer.setLocalDescription(offer);
      if (!current()) return;
      const response = await fetch(token.callsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
        signal: run.controller.signal,
      });
      if (!current()) return;
      if (!response.ok) {
        throw new Error(`Realtime service returned HTTP ${response.status}.`);
      }
      const answer = await response.text();
      if (!current()) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (caught) {
      if (!current()) return;
      const message = stage === "microphone"
        ? caught instanceof Error && caught.message === "unsupported"
          ? "Realtime voice isn't supported in this browser. Use Microsoft Edge or Google Chrome."
          : caught instanceof DOMException && caught.name === "NotAllowedError"
            ? "Microphone access was denied. Allow microphone access for this app and try again."
            : caught instanceof DOMException && caught.name === "NotFoundError"
              ? "No microphone was found."
              : "Microphone access failed. Check the browser permission and try again."
        : stage === "token"
          ? caught instanceof Error && caught.message === "invalid-token"
            ? "The voice token connector returned an invalid response."
            : "Couldn't get a realtime voice token. Check the broker connection and try again."
          : caught instanceof Error && caught.message.startsWith("Realtime service returned HTTP ")
            ? caught.message
            : "Realtime voice couldn't connect. Check the app network policy and try again.";
      fail(message);
    }
  }, [requestToken, stop, helperName, helperTimeoutMs, formatHelperError, getHelperTimeoutHint]);

  useEffect(() => cleanup, [cleanup]);

  return { status, activity, error, start, stop };
}
