import { useRef } from "react";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDictation, type DictationError } from "@/hooks/use-voice";
import { isPreviewMount } from "@/lib/app-view-serializer";
import { cn } from "@/lib/utils";

function dictationMessage(error: DictationError): string {
  switch (error) {
    case "unsupported":
      return "Voice input isn't supported in this browser. Use Microsoft Edge or Google Chrome.";
    case "blocked":
      return isPreviewMount(import.meta.env.BASE_URL)
        ? "Voice input is unavailable in the preview."
        : "Microphone access is blocked. Allow the microphone for this app in your browser, then try again.";
    case "no-microphone":
      return "No microphone was found.";
    case "no-speech":
      return "No speech was detected. Try again.";
    case "network":
      return "The speech service couldn't be reached. Try again.";
    case "failed":
      return "Voice input couldn't start. Try again.";
  }
}

/** Microphone toggle that dictates into a text field, appending to what is already typed. */
export function DictationButton({
  label,
  value,
  onChange,
  size = "icon",
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  size?: "icon" | "icon-sm";
  disabled?: boolean;
  className?: string;
}) {
  const baseRef = useRef("");
  const { listening, start, stop } = useDictation({
    onTranscript: (text) => {
      const base = baseRef.current;
      onChange(base && text ? `${base} ${text}` : base || text);
    },
    onError: (error) => {
      if (error === "no-speech") toast(dictationMessage(error));
      else toast.error(dictationMessage(error));
    },
  });

  return (
    <Button
      type="button"
      variant={listening ? "default" : "outline"}
      size={size}
      aria-label={`Dictate ${label}`}
      aria-pressed={listening}
      title={listening ? "Stop dictating" : "Dictate"}
      disabled={disabled}
      onClick={() => {
        if (listening) {
          stop();
          return;
        }
        baseRef.current = value.trim();
        start();
      }}
      className={cn("shrink-0", listening && "motion-safe:animate-pulse", className)}
    >
      <Mic aria-hidden="true" />
    </Button>
  );
}
