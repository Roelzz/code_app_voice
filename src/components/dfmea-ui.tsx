import { useId, useState, type FormEvent, type ReactNode } from "react";
import { format, parseISO } from "date-fns";
import { CalendarDays, Check, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DictationButton } from "@/components/dictation-button";
import { cn } from "@/lib/utils";
import {
  ACTION_STATUSES,
  PRIORITIES,
  RATINGS,
  riskPriorityNumber,
  type ActionKind,
  type ActionPriority,
  type ActionStatus,
  type DesignFunction,
  type FailureCause,
  type FailureMode,
  type ImprovementAction,
  type Origin,
  type StructureElement,
} from "@/data/dfmea";

// Shared DFMEA building blocks: the state-tone map, rating chips, the
// risk-analysis editor for one failure chain, and the add-failure-mode dialog.

// ── State-tone map: one source for every status / priority badge and dot ──
type Tone = "red" | "amber" | "green" | "blue" | "gray";
const TONE_BADGE: Record<Tone, string> = {
  red: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  amber: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  green: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  blue: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  gray: "border-border bg-muted text-foreground",
};
const TONE_DOT: Record<Tone, string> = {
  red: "bg-red-600 dark:bg-red-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  green: "bg-emerald-600 dark:bg-emerald-400",
  blue: "bg-sky-600 dark:bg-sky-400",
  gray: "bg-zinc-400 dark:bg-zinc-500",
};
const PRIORITY_TONE: Record<ActionPriority, Tone> = { High: "red", Medium: "amber", Low: "green" };
const STATUS_TONE: Record<ActionStatus, Tone> = { Open: "blue", "In progress": "amber", Done: "green" };
export type ChainInput = {
  failureMode: string;
  effect: string;
  cause: string;
  functionId: string | null;
  hazardRef: string;
  origin: Origin;
};

function ToneDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />;
}

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_BADGE[tone],
      )}
    >
      <ToneDot tone={tone} />
      {children}
    </span>
  );
}

export function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-foreground/40 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap">
      <Sparkles className="size-3" aria-hidden="true" />
      AI suggestion
    </span>
  );
}

export function RatingChip({ letter, name, value }: { letter: string; name: string; value: number | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-xs tabular-nums">
      <span aria-hidden="true" className="font-semibold text-muted-foreground">
        {letter}
      </span>
      <span className="sr-only">{name}</span>
      <span className="font-semibold">{value ?? "–"}</span>
      {value === null && <span className="sr-only">not rated</span>}
    </span>
  );
}

function formatDate(value: string | null): string {
  return value ? format(parseISO(value), "d MMM yyyy") : "No date";
}

function DueDatePicker({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? parseISO(value) : undefined;
  const text = formatDate(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${label}: ${text}`}
          className="w-36 justify-start font-normal"
        >
          <CalendarDays aria-hidden="true" />
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          onSelect={(next) => {
            onChange(next ? format(next, "yyyy-MM-dd") : null);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function RatingControl({
  label,
  basis,
  value,
  onChange,
}: {
  label: string;
  basis: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span id={id} className="w-40 text-sm font-medium">
        {label} <span className="font-normal text-muted-foreground">· {basis}</span>
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-labelledby={id}
        value={value === null ? "" : String(value)}
        onValueChange={(next) => onChange(next ? Number(next) : null)}
      >
        {RATINGS.map((rating) => (
          <ToggleGroupItem
            key={rating}
            value={String(rating)}
            aria-label={`${label} ${rating}`}
            className="w-7 min-w-7 px-0 tabular-nums data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90"
          >
            {rating}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function AddActionForm({
  onAdd,
}: {
  onAdd: (input: { description: string; kind: ActionKind; owner: string; due: string | null }) => void;
}) {
  const id = useId();
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ActionKind>("Prevention");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!description.trim()) return;
    onAdd({ description: description.trim(), kind, owner: owner.trim(), due });
    setDescription("");
    setOwner("");
    setDue(null);
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-2.5">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <Label htmlFor={`${id}-desc`} className="text-xs">
          New action
        </Label>
        <div className="flex gap-1.5">
          <Input
            id={`${id}-desc`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="h-8"
          />
          <DictationButton label="the new action" value={description} onChange={setDescription} size="icon-sm" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-kind`} className="text-xs">
          Type
        </Label>
        <Select value={kind} onValueChange={(next) => setKind(next as ActionKind)}>
          <SelectTrigger id={`${id}-kind`} size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Prevention">Prevention</SelectItem>
            <SelectItem value="Detection">Detection</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-owner`} className="text-xs">
          Owner
        </Label>
        <Input
          id={`${id}-owner`}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          className="h-8 w-36"
        />
      </div>
      <div className="space-y-1">
        <span className="block text-xs font-medium">Due</span>
        <DueDatePicker value={due} onChange={setDue} label="New action due date" />
      </div>
      <Button type="submit" size="sm" disabled={!description.trim()}>
        <Plus aria-hidden="true" />
        Add action
      </Button>
    </form>
  );
}

export function ChainEditor({
  mode,
  cause,
  actions,
  onMode,
  onCause,
  onAddAction,
  onUpdateAction,
  onRemoveAction,
  onConfirmReview,
  onDelete,
  onClose,
}: {
  mode: FailureMode;
  cause: FailureCause;
  actions: ImprovementAction[];
  onMode: (patch: Partial<FailureMode>) => void;
  onCause: (patch: Partial<FailureCause>) => void;
  onAddAction: (input: { description: string; kind: ActionKind; owner: string; due: string | null }) => void;
  onUpdateAction: (id: string, patch: Partial<ImprovementAction>) => void;
  onRemoveAction: (id: string) => void;
  onConfirmReview: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const rpn = riskPriorityNumber(mode.severity, cause.occurrence, cause.detection);
  const needsReview = (mode.origin === "ai" && !mode.reviewed) || (cause.origin === "ai" && !cause.reviewed);

  return (
    <section id="chain-editor" aria-labelledby={`${id}-title`} className="mt-3 space-y-4 border-t pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            Risk analysis and actions
          </h3>
          <p className="truncate text-xs text-muted-foreground">{cause.description}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close chain details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      {needsReview && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-foreground/40 px-3 py-2">
          <p className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4 shrink-0" aria-hidden="true" />
            AI suggestion, not yet reviewed by the team
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onConfirmReview}>
            <Check aria-hidden="true" />
            Confirm as team content
          </Button>
        </div>
      )}

      <div className="space-y-2.5">
        <RatingControl label="Severity" basis="effect" value={mode.severity} onChange={(v) => onMode({ severity: v })} />
        <RatingControl label="Occurrence" basis="cause" value={cause.occurrence} onChange={(v) => onCause({ occurrence: v })} />
        <RatingControl label="Detection" basis="controls" value={cause.detection} onChange={(v) => onCause({ detection: v })} />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-medium">RPN</span>
          <span className="text-lg font-semibold tabular-nums">{rpn ?? "–"}</span>
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-priority`}>Action priority</Label>
          <Select
            value={cause.priority ?? "none"}
            onValueChange={(next) => onCause({ priority: next === "none" ? null : (next as ActionPriority) })}
          >
            <SelectTrigger id={`${id}-priority`} size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={priority}>
                  <ToneDot tone={PRIORITY_TONE[priority]} />
                  {priority}
                </SelectItem>
              ))}
              <SelectItem value="none">
                <ToneDot tone="gray" />
                Not set
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 @xl:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-prevention`}>Prevention control</Label>
          <Input
            id={`${id}-prevention`}
            value={cause.preventionControl}
            onChange={(event) => onCause({ preventionControl: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-detection`}>Detection control</Label>
          <Input
            id={`${id}-detection`}
            value={cause.detectionControl}
            onChange={(event) => onCause({ detectionControl: event.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">
          Actions <span className="font-normal text-muted-foreground">({actions.length})</span>
        </h4>
        {actions.length > 0 && (
          <ul className="divide-y rounded-md border">
            {actions.map((action) => (
              <li key={action.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <span className="rounded border px-1.5 py-0.5 text-xs font-medium">{action.kind}</span>
                <p className="min-w-0 flex-1 basis-56 text-sm">
                  {action.description}
                  {action.origin === "ai" && (
                    <span className="ml-2 align-middle">
                      <AiBadge />
                    </span>
                  )}
                </p>
                <Input
                  aria-label={`Owner of ${action.description}`}
                  placeholder="Owner"
                  value={action.owner}
                  onChange={(event) => onUpdateAction(action.id, { owner: event.target.value })}
                  className="h-8 w-36"
                />
                <DueDatePicker
                  value={action.due}
                  onChange={(due) => onUpdateAction(action.id, { due })}
                  label={`Due date of ${action.description}`}
                />
                <Select
                  value={action.status}
                  onValueChange={(next) => onUpdateAction(action.id, { status: next as ActionStatus })}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={`Status of ${action.description}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTION_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        <ToneDot tone={STATUS_TONE[status]} />
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove action: ${action.description}`}
                  onClick={() => onRemoveAction(action.id)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AddActionForm onAdd={onAddAction} />
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onDelete} className="text-destructive">
          <Trash2 aria-hidden="true" />
          Delete chain
        </Button>
      </div>
    </section>
  );
}

type ChainField = "failureMode" | "effect" | "cause" | "hazardRef";
const CHAIN_FIELDS: { name: ChainField; label: string; required: boolean; dictate: boolean }[] = [
  { name: "failureMode", label: "Failure mode", required: true, dictate: true },
  { name: "effect", label: "Effect on patient or system", required: true, dictate: true },
  { name: "cause", label: "Cause", required: true, dictate: true },
  { name: "hazardRef", label: "Hazard reference", required: false, dictate: false },
];

export function AddFailureModeDialog({
  open,
  onOpenChange,
  element,
  functions,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  element: StructureElement;
  functions: DesignFunction[];
  onAdd: (input: Omit<ChainInput, "origin">) => void;
}) {
  const id = useId();
  const [functionId, setFunctionId] = useState(functions[0]?.id ?? "none");
  const [values, setValues] = useState<Record<ChainField, string>>({
    failureMode: "",
    effect: "",
    cause: "",
    hazardRef: "",
  });
  const setField = (name: ChainField, value: string) => setValues((prev) => ({ ...prev, [name]: value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const failureMode = values.failureMode.trim();
    const effect = values.effect.trim();
    const cause = values.cause.trim();
    if (!failureMode || !effect || !cause) return;
    onAdd({
      failureMode,
      effect,
      cause,
      functionId: functionId !== "none" ? functionId : null,
      hazardRef: values.hazardRef.trim(),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add failure mode</DialogTitle>
          <DialogDescription>{element.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {functions.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-function`}>Function</Label>
              <Select value={functionId} onValueChange={setFunctionId}>
                <SelectTrigger id={`${id}-function`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {functions.map((fn) => (
                    <SelectItem key={fn.id} value={fn.id}>
                      {fn.requirementRef} · {fn.description}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">No linked function</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {CHAIN_FIELDS.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
              <div className="flex gap-1.5">
                <Input
                  id={`${id}-${field.name}`}
                  value={values[field.name]}
                  onChange={(event) => setField(field.name, event.target.value)}
                  required={field.required}
                  maxLength={200}
                  autoComplete="off"
                />
                {field.dictate && (
                  <DictationButton
                    label={field.label.toLowerCase()}
                    value={values[field.name]}
                    onChange={(next) => setField(field.name, next.slice(0, 200))}
                  />
                )}
              </div>
            </div>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Add failure mode</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PriorityBadge({ priority }: { priority: ActionPriority }) {
  return <ToneBadge tone={PRIORITY_TONE[priority]}>{priority} priority</ToneBadge>;
}
