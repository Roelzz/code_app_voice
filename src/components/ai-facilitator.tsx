import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Plus,
  RotateCcw,
  Square,
  Scale,
  SendHorizontal,
  Sparkles,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ConnectorErrorState, ErrorState } from "@/components/states";
import { DictationButton } from "@/components/dictation-button";
import { VoiceConsole } from "@/components/voice-console";
import { HelperChooser } from "@/components/helper-chooser";
import { getHelper, HelperError, HelperSession, helperErrorMessage, type HelperId } from "@/connectors/dfmea-helpers";
import { speechOutputSupported, useSpeechReader } from "@/hooks/use-voice";
import { useRealtimeVoice, type RealtimeVoiceToken } from "@/hooks/use-realtime-voice";
import {
  WORKIQ_HOST_TIMEOUT_MS,
  WorkIqConnectorError,
  WorkIqResponseError,
  WorkIqTimeoutError,
  WorkIqToolError,
  type WorkIqResponseSchema,
} from "@/connectors/workiq-copilot-chat";
import { isConnectorPolicyBlock } from "@/lib/connector-error";
import {
  STEPS,
  elementPath,
  subtreeIds,
  type ActionKind,
  type DfmeaDataset,
  type FailureCause,
  type FailureMode,
} from "@/data/dfmea";
import { cn } from "@/lib/utils";

type MoveId = "questions" | "failureModes" | "challenge" | "actions" | "summary" | "ask";

// Moves whose output can be added to the DFMEA return validated rows; the
// conversational moves (questions, challenge, summary, ask) return Copilot's
// answer text, which is shown as text and never turned into data.
const SCHEMAS = {
  failureModes: { failureMode: "string", effect: "string", cause: "string", rationale: "string" },
  actions: { action: "string", type: "string", rationale: "string" },
} as const satisfies Record<"failureModes" | "actions", WorkIqResponseSchema>;

const MOVES: { id: Exclude<MoveId, "ask">; label: string; icon: LucideIcon; needsChain: boolean }[] = [
  { id: "questions", label: "Facilitation questions", icon: MessagesSquare, needsChain: false },
  { id: "failureModes", label: "Suggest failure modes", icon: Lightbulb, needsChain: false },
  { id: "challenge", label: "Challenge ratings", icon: Scale, needsChain: true },
  { id: "actions", label: "Suggest actions", icon: ListChecks, needsChain: true },
  { id: "summary", label: "Summarize workshop", icon: NotebookPen, needsChain: false },
];

const RESULT_TITLES: Record<MoveId, string> = {
  questions: "Questions for the team",
  failureModes: "Failure-mode ideas",
  challenge: "Rating challenge",
  actions: "Action ideas",
  summary: "Workshop summary",
  ask: "Answer",
};

// Short prompts and short answers keep Copilot well inside the connection's
// response window; searching Microsoft 365 files is opt-in because it is slower.
const BREVITY = "Keep each field under 25 words.";
const PLAIN = "Use plain text without tables or headings.";
const SEARCH_FILES =
  "Search my Microsoft 365 files, such as earlier FMEAs, test reports and complaint trends, for relevant evidence and name the source. Never invent sources, data or test results.";
const NO_SEARCH = "Answer from general engineering and medical-device knowledge without searching files.";
const SUMMARY_CHAIN_LIMIT = 10;

interface AiRequest {
  seq: number;
  move: MoveId;
  prompt: string;
  scopeLabel: string;
  elementId: string;
  causeId: string | null;
}

type ApplyTarget =
  | { kind: "failureChain"; failureMode: string; effect: string; cause: string }
  | { kind: "action"; description: string; actionKind: ActionKind };

interface AiItem {
  heading: string;
  body: string;
  tag?: string;
  details?: [string, string][];
  apply?: ApplyTarget;
}

interface AnswerLine {
  text: string;
  bullet: boolean;
}

type AiResult = { kind: "items"; items: AiItem[] } | { kind: "text"; lines: AnswerLine[]; notice?: string };

/** Copilot's answer as readable lines: links reduced to their labels, markup and citation markers removed. */
function toAnswerLines(text: string): AnswerLine[] {
  return text
    .replace(/\[\^?\d+\^?\](\([^)]*\))?/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*|__|`/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .map((line) => {
      const bullet = /^[-*•]\s+/.test(line);
      return { text: bullet ? line.replace(/^[-*•]\s+/, "") : line, bullet };
    });
}

function hasContent(result: AiResult | undefined): result is AiResult {
  return !!result && (result.kind === "text" ? result.lines.length > 0 : result.items.length > 0);
}

function rating(value: number | null): string {
  return value === null ? "?" : String(value);
}

function toActionKind(value: string): ActionKind {
  return /detect/i.test(value) ? "Detection" : "Prevention";
}

function describeChain(mode: FailureMode, cause: FailureCause): string {
  return [
    `failure mode "${mode.description}"`,
    `effect "${mode.effect}" (S ${rating(mode.severity)})`,
    `cause "${cause.description}" (O ${rating(cause.occurrence)})`,
    `prevention "${cause.preventionControl || "none"}"`,
    `detection "${cause.detectionControl || "none"}" (D ${rating(cause.detection)})`,
    `priority ${cause.priority ?? "not set"}`,
  ].join(", ");
}

function buildPrompt(
  data: DfmeaDataset,
  move: MoveId,
  elementId: string,
  chain: { mode: FailureMode; cause: FailureCause } | null,
  question: string,
  searchFiles: boolean,
  specialist = false,
): string {
  const { project } = data;
  const step = STEPS.find((s) => s.id === project.currentStep) ?? STEPS[0];
  const path = elementPath(data.elements, elementId);
  const element = path[path.length - 1];
  const scope = subtreeIds(data.elements, elementId);
  const functions = data.functions
    .filter((f) => f.elementId === elementId)
    .map((f) => f.description)
    .join("; ");
  const modes = data.failureModes.filter((m) => scope.has(m.elementId));
  const noSearch = specialist ? "Use your configured knowledge and tools as appropriate; never invent evidence." : NO_SEARCH;
  const source = specialist ? noSearch : searchFiles ? SEARCH_FILES : NO_SEARCH;
  const preamble = `${specialist ? "Help the team within your configured specialist role." : "You are a DFMEA facilitator (AIAG-VDA method, 1-10 rating scales) for a design team at a health-technology company."} Product: ${project.product}. Workshop step ${step.number}: ${step.title}.`;
  const focus = `Focus element: ${path.map((e) => e.name).join(" > ")} (${element?.level ?? "element"}). Functions: ${functions || "none recorded"}.`;
  const selected = chain ? describeChain(chain.mode, chain.cause) : "";

  switch (move) {
    case "questions": {
      const roles = project.participants.map((p) => p.role).join(", ");
      const captured = modes.slice(0, 8).map((m) => m.description).join("; ");
      return `${preamble} ${focus} Team roles: ${roles}. Failure modes captured: ${captured || "none yet"}. Give 3 numbered questions the facilitator should ask the team now for this step, each followed by its purpose in one short sentence. ${noSearch} ${PLAIN} Keep the whole answer under 120 words.`;
    }
    case "failureModes": {
      const captured = modes.slice(0, 10).map((m) => m.description).join("; ");
      return `${preamble} ${focus} Already captured: ${captured || "none"}. Suggest 3 additional, distinct failure modes of the focus element, each with its effect on the patient or system, one likely design cause and a one-sentence rationale. ${source} ${BREVITY}`;
    }
    case "challenge":
      return `${preamble} Review this failure chain: ${selected}. In up to 3 numbered points, say where severity, occurrence or detection may be mis-rated or where evidence or controls are missing, and what the team should do about it. ${source} ${PLAIN} Keep the whole answer under 120 words.`;
    case "actions": {
      const existing = chain
        ? data.actions.filter((a) => a.causeId === chain.cause.id).map((a) => `${a.description} (${a.status})`)
        : [];
      return `${preamble} Failure chain: ${selected}. Existing actions: ${existing.join("; ") || "none"}. Suggest 3 design actions that lower occurrence or improve detection. type must be Prevention or Detection. ${source} ${BREVITY}`;
    }
    case "summary": {
      // Only the highest-RPN chains travel in the prompt so Copilot answers inside the 30-second window.
      const rpn = (s: number | null, o: number | null, d: number | null) =>
        s !== null && o !== null && d !== null ? s * o * d : -1;
      const allChains = data.failureModes.flatMap((m) =>
        data.causes
          .filter((c) => c.failureModeId === m.id)
          .map((c) => ({
            score: rpn(m.severity, c.occurrence, c.detection),
            text: `${m.description} / ${c.description} (S ${rating(m.severity)}, O ${rating(c.occurrence)}, D ${rating(c.detection)}, priority ${c.priority ?? "not set"})`,
          })),
      );
      const ranked = [...allChains].sort((a, b) => b.score - a.score);
      const chains = ranked.slice(0, SUMMARY_CHAIN_LIMIT).map((c) => c.text);
      const unrated = allChains.filter((c) => c.score < 0).length;
      const omitted = Math.max(0, allChains.length - chains.length);
      const open = data.actions
        .filter((a) => a.status !== "Done")
        .slice(0, SUMMARY_CHAIN_LIMIT)
        .map((a) => `${a.description} (${a.owner || "unassigned"}, ${a.status})`);
      return `${preamble} Summarize this DFMEA for the workshop minutes in up to 5 bullet points covering the highest-risk chains, unrated chains, open actions and next steps. Chains by RPN: ${chains.join("; ")}.${omitted ? ` ${omitted} lower-ranked chains omitted.` : ""} Unrated chains: ${unrated}. Open actions: ${open.join("; ") || "none"}. ${noSearch} ${PLAIN} Keep the whole answer under 150 words.`;
    }
    case "ask":
      return `${preamble} ${focus} ${selected ? `Selected failure chain: ${selected}.` : ""} Question from the team: ${question} Answer in up to 5 short bullet points. ${source} ${PLAIN} Keep the whole answer under 150 words.`;
  }
}

/** Spoken version of a result set: the title, then each numbered item. */
function speechParts(title: string, result: AiResult): string[] {
  if (result.kind === "text") return [`${title}.`, ...result.lines.map((line) => line.text)];
  return [
    `${title}.`,
    ...result.items.map((item, index) =>
      [`${index + 1}. ${item.heading}`, ...(item.details ?? []).map(([label, value]) => `${label}: ${value}`), item.body]
        .filter(Boolean)
        .join(". "),
    ),
  ];
}

/** User-safe explanation of a failed facilitator request; never shows upstream text. */
function describeAiError(error: unknown): { title: string; description: string; code: string } {
  if (error instanceof HelperError) {
    return {
      title: error.channelReason ? `Native channel unavailable [${error.channelReason}]`
        : error.requiresNewConversation ? "New conversation required" : "The selected helper couldn't complete this request",
      description: error.message,
      code: error.channelReason ? `channel/${error.channelReason}` : error.code,
    };
  }
  if (error instanceof WorkIqTimeoutError) {
    return {
      title: `Copilot needed more than ${WORKIQ_HOST_TIMEOUT_MS / 1000} seconds`,
      description:
        "The app stops waiting for Copilot after 30 seconds. Try again, ask a narrower question, or turn off Microsoft 365 file search.",
      code: "timeout",
    };
  }
  if (error instanceof WorkIqConnectorError) {
    const status = error.status;
    const text = error.message.toLowerCase();
    const code = status ? `HTTP ${status}` : "";
    if (
      status === 401 ||
      status === 403 ||
      /unauthori[sz]ed|unauthenticated|forbidden|consent|login|sign.?in|connection reference|connection not found/.test(text)
    ) {
      return {
        title: "The Copilot connection needs attention",
        description: "Sign in to the Copilot connection again, or check that your account has Microsoft 365 Copilot access.",
        code: code || "sign-in",
      };
    }
    if (status === 429) {
      return { title: "Copilot is busy right now", description: "Wait a moment, then try again.", code };
    }
    if (status !== undefined && status >= 500) {
      return { title: "Copilot is temporarily unavailable", description: "Try again in a moment.", code };
    }
    return { title: "Couldn't reach Copilot", description: "Try again in a moment.", code: code || "connection" };
  }
  if (error instanceof WorkIqToolError) {
    return {
      title: "Copilot couldn't complete this request",
      description: "Try again, or rephrase the request.",
      code: error.code !== undefined ? `tool ${error.code}` : "tool",
    };
  }
  if (error instanceof WorkIqResponseError) {
    return {
      title: "Copilot's answer couldn't be read",
      description: "It replied in an unexpected format. Try again.",
      code: `format · ${error.stage}`,
    };
  }
  return { title: "Couldn't reach Copilot", description: "Try again in a moment.", code: "unexpected" };
}

function readableAnswer(text: string, notice?: string): AiResult {
  const lines = toAnswerLines(text);
  if (lines.length === 0) {
    throw new WorkIqResponseError("Copilot's answer had no readable text.", "assistant-text");
  }
  return { kind: "text", lines, notice };
}

async function runMove(request: AiRequest, session: HelperSession): Promise<AiResult> {
  switch (request.move) {
    case "failureModes": {
      const result = await session.items(request.prompt, SCHEMAS.failureModes);
      if (result.kind === "clarification") return readableAnswer(result.text, "The helper replied with text or a clarification, not validated suggestions. Nothing here can be applied automatically.");
      const items = result.items;
      return {
        kind: "items",
        items: items.map((i) => ({
          heading: i.failureMode,
          body: i.rationale,
          details: [
            ["Effect", i.effect],
            ["Cause", i.cause],
          ],
          apply: { kind: "failureChain", failureMode: i.failureMode, effect: i.effect, cause: i.cause },
        })),
      };
    }
    case "actions": {
      const result = await session.items(request.prompt, SCHEMAS.actions);
      if (result.kind === "clarification") return readableAnswer(result.text, "The helper replied with text or a clarification, not validated suggestions. Nothing here can be applied automatically.");
      const items = result.items;
      return {
        kind: "items",
        items: items.map((i) => {
          const actionKind = toActionKind(i.type);
          return {
            heading: i.action,
            body: i.rationale,
            tag: actionKind,
            apply: { kind: "action", description: i.action, actionKind },
          };
        }),
      };
    }
    case "questions":
    case "challenge":
    case "summary":
    case "ask":
      return readableAnswer(await session.text(request.prompt));
  }
}

interface AiFacilitatorProps {
  data: DfmeaDataset;
  elementId: string;
  causeId: string | null;
  onAddFailureChain: (
    elementId: string,
    suggestion: { failureMode: string; effect: string; cause: string },
  ) => void;
  onAddAction: (causeId: string, suggestion: { description: string; kind: ActionKind }) => void;
  requestRealtimeToken?: () => Promise<RealtimeVoiceToken>;
  className?: string;
}

export function AiFacilitator(props: AiFacilitatorProps) {
  const [helperId, setHelperId] = useState<HelperId>("workiq");
  const [conversation, setConversation] = useState(0);
  const [session] = useState(() => new HelperSession());
  function select(id: HelperId) {
    session.select(id);
    setHelperId(id);
    setConversation((value) => value + 1);
  }
  useEffect(() => () => session.select("workiq"), [session]);
  return <FacilitatorPanel key={conversation} {...props} helperId={helperId} conversation={conversation} session={session} onSelect={select} />;
}

function FacilitatorPanel({
  data,
  elementId,
  causeId,
  onAddFailureChain,
  onAddAction,
  requestRealtimeToken,
  className,
  helperId,
  conversation,
  session,
  onSelect,
}: AiFacilitatorProps & { helperId: HelperId; conversation: number; session: HelperSession; onSelect: (id: HelperId) => void }) {
  const helper = getHelper(helperId);
  const specialist = helperId !== "workiq";
  const [request, setRequest] = useState<AiRequest | null>(null);
  const [seq, setSeq] = useState(0);
  const [question, setQuestion] = useState("");
  const [searchFiles, setSearchFiles] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const reader = useSpeechReader();
  const { speak, stop: stopSpeaking } = reader;
  const canSpeak = speechOutputSupported();
  const spokenRef = useRef(0);
  const [applied, setApplied] = useState<string[]>([]);
  const [slowSeq, setSlowSeq] = useState<number | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);

  const element = data.elements.find((e) => e.id === elementId);
  const cause = causeId ? data.causes.find((c) => c.id === causeId) : undefined;
  const mode = cause ? data.failureModes.find((m) => m.id === cause.failureModeId) : undefined;
  const chain = cause && mode ? { mode, cause } : null;
  const step = STEPS.find((s) => s.id === data.project.currentStep) ?? STEPS[0];
  const voiceQuestion = useMutation({
    mutationFn: (text: string) => session.text(buildPrompt(data, "ask", elementId, chain, text, searchFiles, specialist)),
    retry: false,
    gcTime: 0,
  });
  const realtimeVoice = useRealtimeVoice({
    helperName: helper.name,
    requestToken:
      requestRealtimeToken ??
      (() => Promise.reject(new WorkIqConnectorError("Realtime voice connector is not configured.", undefined, undefined))),
    askCopilot: async (text) => {
      try {
        return await voiceQuestion.mutateAsync(text);
      } catch (error) {
        setVoiceMessage(helperErrorMessage(error));
        throw error;
      } finally {
        voiceQuestion.reset();
      }
    },
    onError: setVoiceMessage,
  });

  const query = useQuery({
    queryKey: ["ai-facilitator", helperId, conversation, request?.seq, request?.move, request?.prompt],
    queryFn: () => runMove(request as AiRequest, session),
    enabled: request !== null,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const busy = query.isFetching;
  const newConversationRequired = specialist && session.requiresNewConversation;

  useEffect(() => {
    if (!busy || request === null) return;
    const currentSeq = request.seq;
    const timer = window.setTimeout(() => setSlowSeq(currentSeq), 10_000);
    return () => window.clearTimeout(timer);
  }, [busy, request]);
  const slow = busy && request !== null && slowSeq === request.seq;

  useEffect(() => {
    if (realtimeVoice.status !== "idle" || !readAloud || !request || busy || !query.isSuccess || !hasContent(query.data)) return;
    if (spokenRef.current === query.dataUpdatedAt) return;
    spokenRef.current = query.dataUpdatedAt;
    speak(speechParts(RESULT_TITLES[request.move], query.data));
  }, [realtimeVoice.status, readAloud, request, busy, query.isSuccess, query.data, query.dataUpdatedAt, speak]);

  function start(move: MoveId, text = "") {
    if (busy || voiceQuestion.isPending || session.requiresNewConversation) return;
    realtimeVoice.stop();
    stopSpeaking();
    const next = seq + 1;
    setSeq(next);
    const scopeLabel =
      move === "challenge" || move === "actions"
        ? (cause?.description ?? "")
        : move === "summary"
          ? data.project.product
          : (element?.name ?? "");
    setRequest({
      seq: next,
      move,
      prompt: buildPrompt(data, move, elementId, chain, text, searchFiles, specialist),
      scopeLabel,
      elementId,
      causeId: chain?.cause.id ?? null,
    });
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    start("ask", text);
  }

  function apply(item: AiItem, key: string) {
    if (!request || !item.apply || busy) return;
    if (item.apply.kind === "failureChain") {
      onAddFailureChain(request.elementId, item.apply);
    } else if (request.causeId) {
      onAddAction(request.causeId, { description: item.apply.description, kind: item.apply.actionKind });
    }
    setApplied((prev) => [...prev, key]);
  }

  const targetExists = (target: ApplyTarget | undefined) => {
    if (!request || !target) return false;
    if (target.kind === "failureChain") return data.elements.some((e) => e.id === request.elementId);
    return request.causeId !== null && data.causes.some((c) => c.id === request.causeId);
  };

  return (
    <aside
      aria-labelledby="ai-facilitator-title"
      className={cn("flex min-w-0 flex-col gap-4 bg-card p-4", className)}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <h2 id="ai-facilitator-title" className="text-base font-semibold tracking-tight">
            AI facilitator
          </h2>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Step</dt>
          <dd className="truncate font-medium">
            {step.number} · {step.label}
          </dd>
          <dt className="text-muted-foreground">Focus</dt>
          <dd className="truncate font-medium">{element?.name ?? "—"}</dd>
          <dt className="text-muted-foreground">Chain</dt>
          <dd className="truncate font-medium">{chain ? chain.cause.description : "None selected"}</dd>
        </dl>
      </div>

      <HelperChooser selected={helperId} disabled={busy} restoreFocus={conversation > 0} onSelect={(id) => {
        realtimeVoice.stop();
        stopSpeaking();
        onSelect(id);
      }} onReset={() => {
        realtimeVoice.stop();
        stopSpeaking();
        onSelect(helperId);
      }} />

      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Facilitator moves">
        {MOVES.map((move) => {
          const Icon = move.icon;
          const disabled = busy || voiceQuestion.isPending || newConversationRequired || (move.needsChain && !chain);
          return (
            <Button
              key={move.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => start(move.id)}
              className={cn(
                "h-auto justify-start whitespace-normal py-2 text-left leading-snug",
                move.id === "summary" && "col-span-2",
              )}
            >
              <Icon aria-hidden="true" />
              {move.label}
            </Button>
          );
        })}
      </div>

      <form onSubmit={submitQuestion} className="flex gap-2">
        <label htmlFor="ai-question" className="sr-only">
          Ask the facilitator
        </label>
        <Input
          id="ai-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about this element or chain"
          maxLength={400}
          autoComplete="off"
        />
        <DictationButton label="a question for the facilitator" value={question} onChange={setQuestion} disabled={busy} />
        <Button type="submit" size="icon" disabled={busy || voiceQuestion.isPending || newConversationRequired || !question.trim()} aria-label="Ask the facilitator">
          <SendHorizontal aria-hidden="true" />
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {!specialist && <div className="flex items-center gap-2">
          <Switch id="ai-search-files" checked={searchFiles} onCheckedChange={setSearchFiles} disabled={busy} />
          <Label htmlFor="ai-search-files" className="text-xs font-normal">
            Use my Microsoft 365 files (slower)
          </Label>
        </div>}
        {canSpeak && (
          <div className="flex items-center gap-2">
            <Switch
              id="ai-read-aloud"
              checked={readAloud}
              onCheckedChange={(on) => {
                spokenRef.current = query.dataUpdatedAt;
                if (!on) stopSpeaking();
                setReadAloud(on);
              }}
            />
            <Label htmlFor="ai-read-aloud" className="text-xs font-normal">
              Read answers aloud
            </Label>
          </div>
        )}
        {requestRealtimeToken && (
          <VoiceConsole
            helperName={helper.name}
            status={realtimeVoice.status}
            activity={realtimeVoice.activity}
            error={realtimeVoice.error || voiceMessage}
            focus={element?.name ?? data.project.product}
            step={`Step ${step.number}: ${step.title}`}
            disabled={busy}
            onStart={() => {
              setVoiceMessage(null);
              stopSpeaking();
              setReadAloud(false);
              void realtimeVoice.start();
            }}
            onStop={realtimeVoice.stop}
          />
        )}
      </div>
      {(realtimeVoice.error || voiceMessage) && (
        <p role="status" aria-live="polite" className="text-xs text-destructive">
          {realtimeVoice.error || voiceMessage}
        </p>
      )}

      <section aria-label="Facilitator output" aria-busy={busy} className="min-h-0 flex-1 space-y-3">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {busy
            ? slow
              ? `Still working with ${helper.name}. The app waits up to ${helper.id === "workiq" ? "30 seconds" : "three minutes"}.`
              : `Asking ${helper.name}. This can take up to ${helper.id === "workiq" ? "30 seconds" : "three minutes"}.`
            : ""}
        </p>

        {request === null ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center">
            <Sparkles className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">No facilitator output yet</p>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="min-w-0 text-sm font-semibold">
                <span className="block text-xs font-normal text-muted-foreground">{helper.name}</span>
                {RESULT_TITLES[request.move]}
                {request.scopeLabel && (
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {request.scopeLabel}
                  </span>
                )}
              </h3>
              {query.data && !busy && (
                <div className="flex shrink-0 items-center gap-1">
                  {canSpeak && hasContent(query.data) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        reader.speaking
                          ? stopSpeaking()
                          : hasContent(query.data) && speak(speechParts(RESULT_TITLES[request.move], query.data))
                      }
                    >
                      {reader.speaking ? <Square aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                      {reader.speaking ? "Stop reading" : "Read aloud"}
                    </Button>
                  )}
                  {!newConversationRequired && <Button type="button" variant="ghost" size="xs" onClick={() => query.refetch()}>
                    <RotateCcw aria-hidden="true" />
                    Regenerate
                  </Button>}
                </div>
              )}
            </div>

            {busy && !query.data ? (
              <div className="space-y-2" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2 rounded-md border p-3">
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ))}
              </div>
            ) : query.isError ? (
              isConnectorPolicyBlock(query.error) ? (
                <ConnectorErrorState error={query.error} connector={helper.name} className="py-6" />
              ) : (
                (() => {
                  const info = describeAiError(query.error);
                  return (
                    <ErrorState
                      title={info.title}
                      description={info.description}
                      className="py-6"
                      action={
                        <div className="flex flex-col items-center gap-2">
                          {!newConversationRequired && <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
                            <RotateCcw aria-hidden="true" />
                            Try again
                          </Button>}
                          <span className="text-xs text-muted-foreground">Code: {info.code}</span>
                        </div>
                      }
                    />
                  );
                })()
              )
            ) : query.data?.kind === "text" ? (
              <div className="space-y-1.5 rounded-md border bg-background p-3 text-sm leading-relaxed">
                {query.data.notice && <p role="status" className="rounded border bg-muted p-2 text-xs">{query.data.notice}</p>}
                {query.data.lines.map((line, index) => (
                  <p
                    key={index}
                    className={cn(line.bullet && "relative pl-4 before:absolute before:left-1 before:content-['•']")}
                  >
                    {line.text}
                  </p>
                ))}
              </div>
            ) : query.data && query.data.items.length === 0 ? (
              <p className="rounded-md border px-3 py-4 text-sm">{helper.name} returned no suggestions.</p>
            ) : (
              <ol className="space-y-2">
                {(query.data?.items ?? []).map((item, index) => {
                  const key = `${request.seq}-${index}`;
                  const isApplied = applied.includes(key);
                  return (
                    <li key={key} className="space-y-1.5 rounded-md border bg-background p-3">
                      {item.tag && (
                        <span className="inline-flex rounded border px-1.5 text-[11px] font-medium">
                          {item.tag}
                        </span>
                      )}
                      <p className="text-sm font-medium leading-snug">{item.heading}</p>
                      {item.details && (
                        <dl className="space-y-0.5 text-xs">
                          {item.details.map(([label, value]) => (
                            <div key={label} className="flex gap-1.5">
                              <dt className="shrink-0 text-muted-foreground">{label}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {item.body && <p className="text-xs leading-relaxed text-muted-foreground">{item.body}</p>}
                      {item.apply && (
                        <Button
                          type="button"
                          variant={isApplied ? "ghost" : "secondary"}
                          size="xs"
                          disabled={isApplied || !targetExists(item.apply)}
                          onClick={() => apply(item, key)}
                        >
                          {isApplied ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                          {isApplied
                            ? "Added"
                            : item.apply.kind === "failureChain"
                              ? "Add to failure network"
                              : "Add as action"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
