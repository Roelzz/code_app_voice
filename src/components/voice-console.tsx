import { useState } from "react";
import { AudioLines, ArrowUpRight, Mic, ShieldCheck, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { RealtimeVoiceActivity, RealtimeVoiceStatus } from "@/hooks/use-realtime-voice";

const ACTIVITY: Record<RealtimeVoiceActivity, { title: string; detail: string }> = {
  listening: { title: "Listening", detail: "Ask a question about the current workshop focus." },
  hearing: { title: "Hearing you", detail: "Finish your question naturally. No need to press anything." },
  processing: { title: "Processing your question", detail: "Preparing your question for the selected helper." },
  consulting: { title: "Consulting helper", detail: "The selected helper is answering. The app waits up to 30 seconds." },
  speaking: { title: "Voice playback active", detail: "Azure Realtime is playing speech from the selected helper's answer." },
};

interface VoiceConsoleProps {
  status: RealtimeVoiceStatus;
  activity: RealtimeVoiceActivity;
  error: string | null;
  focus: string;
  step: string;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  helperName?: string;
}

export function VoiceConsole({ status, activity, error, focus, step, disabled, onStart, onStop, helperName = "Microsoft 365 Copilot" }: VoiceConsoleProps) {
  const [open, setOpen] = useState(false);
  const active = status !== "idle";
  const state = status === "idle" ? (error ? "error" : "idle") : status === "connecting" ? "connecting" : activity;
  const copy = status === "idle"
    ? error
      ? { title: "Session interrupted", detail: "Review the message below, then start a new session." }
      : { title: "Ready when you are", detail: "Start a voice session to explore this DFMEA with Copilot." }
    : status === "connecting"
      ? { title: "Establishing voice link", detail: "Allow microphone access if prompted. You can stop at any time." }
      : ACTIVITY[activity];

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) onStop();
      setOpen(next);
    }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between border-primary/30 bg-primary/5" disabled={disabled && !active}>
          <span className="flex items-center gap-2"><AudioLines aria-hidden="true" />Talk to Copilot</span>
          <ArrowUpRight aria-hidden="true" className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="voice-console gap-0 overflow-x-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5 text-left">
          <p className="font-mono text-[0.65rem] font-semibold tracking-[0.2em] text-primary">WORKSHOP / VOICE CONSOLE</p>
          <DialogTitle className="text-xl">Talk to Copilot</DialogTitle>
          <DialogDescription>Think out loud. Keep the team in control.</DialogDescription>
          <p className="text-xs font-medium text-primary">Answer source: {helperName}</p>
        </DialogHeader>

        <div className="px-6 pt-5">
          <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/40 px-4 py-3 text-xs">
            <div className="min-w-0">
              <p className="mb-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">Current focus</p>
              <p className="break-words font-medium">{focus}</p>
            </div>
            <p className="max-w-[45%] text-right text-muted-foreground">{step}</p>
          </div>
        </div>

        <div className="voice-console-stage" data-voice-state={state}>
          <div className="voice-core" aria-hidden="true">
            <div className="voice-orbit voice-orbit-outer" />
            <div className="voice-orbit voice-orbit-middle" />
            <div className="voice-orbit voice-orbit-inner" />
            <div className="voice-core-center"><AudioLines className="size-10" strokeWidth={1.25} /></div>
            <span className="voice-core-cross voice-core-cross-top" />
            <span className="voice-core-cross voice-core-cross-bottom" />
          </div>
          <div role="status" aria-live="polite" aria-atomic="true" className="relative min-h-20 px-4 text-center">
            <p className="text-xl font-semibold tracking-tight">{copy.title}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{copy.detail}</p>
          </div>
        </div>

        <div className="space-y-4 px-6 pb-6">
          {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
          <Button
            type="button"
            className="h-12 w-full text-sm"
            variant={active ? "outline" : "default"}
            disabled={!active && disabled}
            onClick={active ? onStop : onStart}
          >
            {active ? <Square aria-hidden="true" className="size-4" /> : <Mic aria-hidden="true" className="size-4" />}
            {active ? (status === "connecting" ? "Stop connecting" : "End voice session") : "Start voice session"}
          </Button>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>{helperName} provides the answers. Azure Realtime provides the voice. Closing this console stops the microphone. Nothing changes in the DFMEA automatically.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
