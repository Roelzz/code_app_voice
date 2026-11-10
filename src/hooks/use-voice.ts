import { useCallback, useEffect, useRef, useState } from "react";

// Voice input (browser speech recognition) and voice output (speech synthesis).
// Audio and transcripts stay in the browser session; nothing is stored or logged.

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultList {
  readonly length: number;
  [index: number]: RecognitionResult;
}
interface RecognitionEvent {
  readonly results: RecognitionResultList;
}
interface RecognitionErrorEvent {
  readonly error: string;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export type DictationError = "unsupported" | "blocked" | "no-microphone" | "no-speech" | "network" | "failed";

const ERROR_CODES: Record<string, DictationError | null> = {
  "not-allowed": "blocked",
  "service-not-allowed": "blocked",
  "audio-capture": "no-microphone",
  "no-speech": "no-speech",
  network: "network",
  aborted: null,
};

// Only one microphone session runs at a time across the app.
let activeRecognition: Recognition | null = null;
let stopRealtimeAudio: (() => void) | null = null;

export function claimRealtimeAudio(stop: () => void): () => void {
  stopRealtimeAudio?.();
  activeRecognition?.abort();
  if (speechOutputSupported()) window.speechSynthesis.cancel();
  stopRealtimeAudio = stop;
  return () => {
    if (stopRealtimeAudio === stop) stopRealtimeAudio = null;
  };
}

/** Live dictation: reports the running transcript, then the final one. */
export function useDictation(handlers: {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (error: DictationError) => void;
}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    stopRealtimeAudio?.();
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      handlersRef.current.onError("unsupported");
      return;
    }
    activeRecognition?.abort();
    const recognition = new Constructor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let text = "";
      let isFinal = true;
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        text += result[0]?.transcript ?? "";
        if (!result.isFinal) isFinal = false;
      }
      handlersRef.current.onTranscript(text.trim(), isFinal);
    };
    recognition.onerror = (event) => {
      const code = event.error in ERROR_CODES ? ERROR_CODES[event.error] : "failed";
      if (code) handlersRef.current.onError(code);
    };
    recognition.onend = () => {
      if (activeRecognition === recognition) activeRecognition = null;
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    activeRecognition = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      activeRecognition = null;
      handlersRef.current.onError("failed");
    }
  }, []);

  return { listening, start, stop };
}

export function speechOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/** Reads text aloud with the browser's built-in voice, one utterance per part. */
export function useSpeechReader() {
  const [speaking, setSpeaking] = useState(false);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (speechOutputSupported()) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((parts: string[]) => {
    if (!speechOutputSupported()) return;
    stopRealtimeAudio?.();
    const synth = window.speechSynthesis;
    synth.cancel();
    runRef.current += 1;
    const run = runRef.current;
    const chunks = parts.map((part) => part.trim()).filter(Boolean);
    chunks.forEach((text, index) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = document.documentElement.lang || "en-US";
      if (index === 0) {
        utterance.onstart = () => {
          if (runRef.current === run) setSpeaking(true);
        };
      }
      if (index === chunks.length - 1) {
        utterance.onend = () => {
          if (runRef.current === run) setSpeaking(false);
        };
      }
      utterance.onerror = () => {
        if (runRef.current === run) setSpeaking(false);
      };
      synth.speak(utterance);
    });
  }, []);

  useEffect(
    () => () => {
      if (speechOutputSupported()) window.speechSynthesis.cancel();
    },
    [],
  );

  return { speaking, speak, stop };
}
