import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Boxes,
  Component as ComponentIcon,
  GitBranch,
  Layers,
  Plus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState } from "@/components/states";
import { AiFacilitator } from "@/components/ai-facilitator";
import { acquireRealtimeToken } from "@/connectors/realtime-token";
import {
  AddFailureModeDialog,
  AiBadge,
  ChainEditor,
  PriorityBadge,
  RatingChip,
  ToneBadge,
  type ChainInput,
} from "@/components/dfmea-ui";
import { useConfirm } from "@/hooks/use-confirm";
import { cn } from "@/lib/utils";
import {
  SAMPLE_DFMEA,
  STEPS,
  elementPath,
  isChainRated,
  newId,
  riskPriorityNumber,
  subtreeIds,
  type ActionKind,
  type DfmeaDataset,
  type ElementLevel,
  type FailureCause,
  type FailureMode,
  type ImprovementAction,
  type Origin,
  type StepId,
} from "@/data/dfmea";

const LEVEL_ICON: Record<ElementLevel, LucideIcon> = {
  System: Layers,
  Subsystem: Boxes,
  Component: ComponentIcon,
};
const TREE_INDENT = ["pl-2", "pl-6", "pl-10", "pl-14"];

type ChainFilter = "all" | "unrated" | "high";

function bracketClasses(index: number, total: number): string {
  const tick = "@2xl:before:absolute @2xl:before:-left-3 @2xl:before:top-1/2 @2xl:before:h-px @2xl:before:w-3 @2xl:before:bg-foreground/25";
  if (total < 2) return tick;
  const vertical = "@2xl:after:absolute @2xl:after:-left-3 @2xl:after:w-px @2xl:after:bg-foreground/25";
  if (index === 0) return cn(tick, vertical, "@2xl:after:top-1/2 @2xl:after:-bottom-1");
  if (index === total - 1) return cn(tick, vertical, "@2xl:after:-top-1 @2xl:after:bottom-1/2");
  return cn(tick, vertical, "@2xl:after:-top-1 @2xl:after:-bottom-1");
}

function Connector() {
  return (
    <div aria-hidden="true" className="hidden @2xl:flex @2xl:items-center">
      <span data-connector className="h-px w-full bg-foreground/25" />
    </div>
  );
}

export function HomePage() {
  const confirm = useConfirm();
  const { mutateAsync: acquireToken, reset: resetToken } = useMutation({
    mutationFn: acquireRealtimeToken,
    retry: false,
    gcTime: 0,
  });
  const requestRealtimeToken = useCallback(async () => {
    try {
      return await acquireToken();
    } finally {
      resetToken();
    }
  }, [acquireToken, resetToken]);
  const [data, setData] = useState<DfmeaDataset>(SAMPLE_DFMEA);
  const [elementId, setElementId] = useState("E-00");
  const [causeId, setCauseId] = useState<string | null>("C-01");
  const [filter, setFilter] = useState<ChainFilter>("all");
  const [addOpen, setAddOpen] = useState(false);

  const { project, elements, functions, failureModes, causes, actions } = data;
  const element = elements.find((e) => e.id === elementId) ?? elements[0];
  const path = elementPath(elements, element.id);
  const elementFunctions = functions.filter((f) => f.elementId === element.id);
  const currentStep = STEPS.find((s) => s.id === project.currentStep) ?? STEPS[0];
  const currentIndex = STEPS.indexOf(currentStep);

  const modeById = useMemo(() => new Map(failureModes.map((m) => [m.id, m])), [failureModes]);
  const elementOrder = useMemo(() => new Map(elements.map((e, i) => [e.id, i])), [elements]);

  const chainCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of elements) {
      const ids = subtreeIds(elements, e.id);
      counts.set(e.id, causes.filter((c) => ids.has(modeById.get(c.failureModeId)?.elementId ?? "")).length);
    }
    return counts;
  }, [elements, causes, modeById]);

  const scopedGroups = useMemo(() => {
    const scope = subtreeIds(elements, element.id);
    return failureModes
      .filter((m) => scope.has(m.elementId))
      .sort((a, b) => (elementOrder.get(a.elementId) ?? 0) - (elementOrder.get(b.elementId) ?? 0))
      .map((mode) => ({ mode, causes: causes.filter((c) => c.failureModeId === mode.id) }));
  }, [elements, element.id, failureModes, causes, elementOrder]);

  const matches = (mode: FailureMode, cause: FailureCause, which: ChainFilter) =>
    which === "all" || (which === "unrated" ? !isChainRated(mode, cause) : cause.priority === "High");
  const filterCount = (which: ChainFilter) =>
    scopedGroups.reduce((n, g) => n + g.causes.filter((c) => matches(g.mode, c, which)).length, 0);
  const visibleGroups = scopedGroups
    .map((g) => ({ mode: g.mode, causes: g.causes.filter((c) => matches(g.mode, c, filter)) }))
    .filter((g) => g.causes.length > 0);

  const ratedCount = causes.filter((c) => {
    const mode = modeById.get(c.failureModeId);
    return mode ? isChainRated(mode, c) : false;
  }).length;
  const stepFacts: Record<StepId, string> = {
    planning: `${project.participants.length} participants`,
    structure: `${elements.length} elements`,
    function: `${functions.length} functions`,
    failure: `${failureModes.length} modes · ${causes.length} causes`,
    risk: `${ratedCount} of ${causes.length} rated`,
    optimization: `${actions.length} actions · ${actions.filter((a) => a.status !== "Done").length} open`,
    documentation: `Revision ${project.revision}`,
  };

  // ── Mutations on the unified model ──
  const updateMode = (id: string, patch: Partial<FailureMode>) =>
    setData((d) => ({ ...d, failureModes: d.failureModes.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const updateCause = (id: string, patch: Partial<FailureCause>) =>
    setData((d) => ({ ...d, causes: d.causes.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const updateAction = (id: string, patch: Partial<ImprovementAction>) =>
    setData((d) => ({ ...d, actions: d.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const removeAction = (id: string) => setData((d) => ({ ...d, actions: d.actions.filter((a) => a.id !== id) }));
  const addAction = (
    targetCauseId: string,
    input: { description: string; kind: ActionKind; owner: string; due: string | null },
    origin: Origin,
  ) =>
    setData((d) => ({
      ...d,
      actions: [...d.actions, { id: newId("A"), causeId: targetCauseId, ...input, status: "Open", origin }],
    }));

  function addChain(targetElementId: string, input: ChainInput): string {
    const modeId = newId("FM");
    const newCauseId = newId("C");
    const reviewed = input.origin === "team";
    setData((d) => ({
      ...d,
      failureModes: [
        ...d.failureModes,
        {
          id: modeId,
          elementId: targetElementId,
          functionId: input.functionId,
          description: input.failureMode,
          effect: input.effect,
          severity: null,
          hazardRef: input.hazardRef,
          origin: input.origin,
          reviewed,
        },
      ],
      causes: [
        ...d.causes,
        {
          id: newCauseId,
          failureModeId: modeId,
          description: input.cause,
          preventionControl: "",
          occurrence: null,
          detectionControl: "",
          detection: null,
          priority: null,
          origin: input.origin,
          reviewed,
        },
      ],
    }));
    setFilter("all");
    return newCauseId;
  }

  async function deleteChain(cause: FailureCause) {
    const ok = await confirm({
      title: "Delete this failure chain?",
      description: `"${cause.description}" and its actions will be removed from the DFMEA.`,
      confirmLabel: "Delete chain",
      destructive: true,
    });
    if (!ok) return;
    setData((d) => {
      const remaining = d.causes.filter((c) => c.id !== cause.id);
      const modeInUse = remaining.some((c) => c.failureModeId === cause.failureModeId);
      return {
        ...d,
        causes: remaining,
        failureModes: modeInUse ? d.failureModes : d.failureModes.filter((m) => m.id !== cause.failureModeId),
        actions: d.actions.filter((a) => a.causeId !== cause.id),
      };
    });
    setCauseId(null);
    toast.success("Failure chain deleted");
  }

  function selectElement(id: string) {
    setElementId(id);
    const selectedMode = causeId ? modeById.get(causes.find((c) => c.id === causeId)?.failureModeId ?? "") : undefined;
    if (!selectedMode || !subtreeIds(elements, id).has(selectedMode.elementId)) setCauseId(null);
  }

  const children = (parentId: string | null) => elements.filter((e) => e.parentId === parentId);
  const renderTree = (parentId: string | null, depth: number): ReactNode => (
    <ul className="space-y-0.5">
      {children(parentId).map((node) => {
        const Icon = LEVEL_ICON[node.level];
        const selected = node.id === element.id;
        return (
          <li key={node.id}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => selectElement(node.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors",
                TREE_INDENT[Math.min(depth, TREE_INDENT.length - 1)],
                selected ? "bg-primary/10 font-semibold shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-accent",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {chainCount.get(node.id) ?? 0}
                <span className="sr-only"> failure chains</span>
              </span>
            </button>
            {children(node.id).length > 0 && renderTree(node.id, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  const selectedCause = causeId ? causes.find((c) => c.id === causeId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-3 border-b px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{project.product}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {project.id} · Rev {project.revision}
          </span>
          <span className="text-sm text-muted-foreground">{project.productLine}</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
                <Users aria-hidden="true" />
                {project.participants.length} participants
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              <p className="mb-2 text-sm font-semibold">Workshop team</p>
              <ul className="space-y-1.5 text-sm">
                {project.participants.map((p) => (
                  <li key={p.name} className="flex justify-between gap-3">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-right text-muted-foreground">{p.role}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>

        <nav aria-label="DFMEA steps">
          <ol className="flex gap-1.5 overflow-x-auto pb-1">
            {STEPS.map((step, index) => {
              const current = step.id === project.currentStep;
              return (
                <li key={step.id} className="min-w-[8.5rem] flex-1">
                  <button
                    type="button"
                    aria-current={current ? "step" : undefined}
                    onClick={() => setData((d) => ({ ...d, project: { ...d.project, currentStep: step.id } }))}
                    className={cn(
                      "flex h-full w-full flex-col items-start gap-0.5 rounded-md border-t-4 px-2.5 pt-1.5 pb-2 text-left transition-colors",
                      current
                        ? "border-t-primary bg-primary/10 hover:bg-primary/15"
                        : index < currentIndex
                          ? "border-t-foreground/40 hover:bg-accent"
                          : "border-t-border hover:bg-accent",
                    )}
                  >
                    <span className="text-xs font-medium tabular-nums text-muted-foreground">Step {step.number}</span>
                    <span className="text-sm font-semibold">{step.label}</span>
                    <span className="text-xs text-muted-foreground">{stepFacts[step.id]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <p className="text-sm">
          <span className="font-semibold">{currentStep.title}.</span> {currentStep.goal}
        </p>
      </header>

      <div className="grid flex-1 lg:grid-cols-[232px_minmax(0,1fr)_340px] xl:grid-cols-[248px_minmax(0,1fr)_380px]">
        <nav
          aria-label="Product structure"
          className="border-b p-3 lg:sticky lg:top-12 lg:h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <p className="mb-2 px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Structure</p>
          {renderTree(null, 0)}
        </nav>

        <section
          id="failure-network"
          tabIndex={-1}
          aria-labelledby="network-title"
          className="@container min-w-0 space-y-4 p-4 outline-none lg:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Element path">
                {path.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-1">
                    {i > 0 && <span aria-hidden="true">/</span>}
                    {p.id === element.id ? (
                      <span aria-current="location">{p.level}</span>
                    ) : (
                      <button type="button" className="hover:text-foreground hover:underline" onClick={() => selectElement(p.id)}>
                        {p.name}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <h2 id="network-title" className="text-lg font-semibold tracking-tight">
                {element.name}
              </h2>
              {elementFunctions.length > 0 && (
                <ul className="space-y-0.5 text-sm">
                  {elementFunctions.map((fn) => (
                    <li key={fn.id}>
                      <span className="mr-1.5 font-mono text-xs text-muted-foreground">{fn.requirementRef}</span>
                      {fn.description}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" />
              Add failure mode
            </Button>
          </div>

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={filter}
            onValueChange={(next) => next && setFilter(next as ChainFilter)}
            aria-label="Filter failure chains"
            className="flex-wrap"
          >
            {(
              [
                ["all", "All chains"],
                ["unrated", "Needs rating"],
                ["high", "High priority"],
              ] as const
            ).map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="px-3 data-[state=on]:bg-primary/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
              >
                {label} <span className="tabular-nums text-muted-foreground">{filterCount(value)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {visibleGroups.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title={
                filter === "all"
                  ? "No failure modes for this element"
                  : filter === "unrated"
                    ? "Every chain here is rated"
                    : "No high-priority chains here"
              }
              action={
                filter === "all" ? (
                  <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                    <Plus aria-hidden="true" />
                    Add failure mode
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              <div
                aria-hidden="true"
                className="hidden px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase @2xl:grid @2xl:grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_1.25rem_minmax(0,1.3fr)]"
              >
                <span>Failure effect</span>
                <span />
                <span>Failure mode</span>
                <span />
                <span className="pl-3">Failure cause</span>
              </div>
              <ol className="space-y-3" aria-label="Failure chains">
                {visibleGroups.map(({ mode, causes: groupCauses }) => {
                  const fn = functions.find((f) => f.id === mode.functionId);
                  const modeElement = elements.find((e) => e.id === mode.elementId);
                  const editing = groupCauses.find((c) => c.id === causeId);
                  return (
                    <li key={mode.id} className="rounded-lg border bg-card p-3">
                      <div className="grid gap-2 @2xl:grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_1.25rem_minmax(0,1.3fr)] @2xl:items-center @2xl:gap-0">
                        <div className="space-y-1.5 rounded-md bg-muted/60 p-2.5">
                          <p className="text-xs font-medium text-muted-foreground @2xl:sr-only">Failure effect</p>
                          <p className="text-sm">{mode.effect}</p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <RatingChip letter="S" name="Severity" value={mode.severity} />
                            {mode.hazardRef && (
                              <span className="font-mono text-xs text-muted-foreground">{mode.hazardRef}</span>
                            )}
                          </div>
                        </div>
                        <Connector />
                        <div className="space-y-1.5 rounded-md border border-foreground/20 p-2.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            <span className="@2xl:sr-only">Failure mode · </span>
                            {modeElement?.name}
                          </p>
                          <p className="text-sm font-semibold leading-snug">{mode.description}</p>
                          {fn && (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-mono">{fn.requirementRef}</span> · {fn.description}
                            </p>
                          )}
                          {mode.origin === "ai" && !mode.reviewed && <AiBadge />}
                        </div>
                        <Connector />
                        <ul className="flex flex-col gap-2 @2xl:pl-3" aria-label="Failure causes">
                          {groupCauses.map((cause, index) => {
                            const selected = cause.id === causeId;
                            const rated = isChainRated(mode, cause);
                            const rpn = riskPriorityNumber(mode.severity, cause.occurrence, cause.detection);
                            const actionCount = actions.filter((a) => a.causeId === cause.id).length;
                            return (
                              <li key={cause.id} data-bracket className={cn("relative", bracketClasses(index, groupCauses.length))}>
                                <button
                                  type="button"
                                  data-chain-card
                                  aria-expanded={selected}
                                  aria-controls={selected ? "chain-editor" : undefined}
                                  onClick={() => setCauseId(selected ? null : cause.id)}
                                  className={cn(
                                    "w-full space-y-1.5 rounded-md border bg-background p-2.5 text-left transition-colors",
                                    selected ? "border-primary shadow-[0_0_0_1px_var(--primary)]" : "hover:border-foreground/40",
                                  )}
                                >
                                  <span className="block text-xs font-medium text-muted-foreground @2xl:sr-only">Failure cause</span>
                                  <span className="block text-sm leading-snug">{cause.description}</span>
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    <RatingChip letter="O" name="Occurrence" value={cause.occurrence} />
                                    <RatingChip letter="D" name="Detection" value={cause.detection} />
                                    {rpn !== null && (
                                      <span className="text-xs tabular-nums text-muted-foreground">
                                        RPN <span className="font-semibold text-foreground">{rpn}</span>
                                      </span>
                                    )}
                                    {!rated && <ToneBadge tone="gray">Not rated</ToneBadge>}
                                    {cause.priority ? (
                                      <PriorityBadge priority={cause.priority} />
                                    ) : (
                                      rated && <ToneBadge tone="gray">Priority not set</ToneBadge>
                                    )}
                                    {actionCount > 0 && (
                                      <span className="text-xs text-muted-foreground">
                                        {actionCount} {actionCount === 1 ? "action" : "actions"}
                                      </span>
                                    )}
                                    {cause.origin === "ai" && !cause.reviewed && <AiBadge />}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                      {editing && (
                        <ChainEditor
                          mode={mode}
                          cause={editing}
                          actions={actions.filter((a) => a.causeId === editing.id)}
                          onMode={(patch) => updateMode(mode.id, patch)}
                          onCause={(patch) => updateCause(editing.id, patch)}
                          onAddAction={(input) => {
                            addAction(editing.id, input, "team");
                            toast.success("Action added");
                          }}
                          onUpdateAction={updateAction}
                          onRemoveAction={removeAction}
                          onConfirmReview={() => {
                            updateMode(mode.id, { reviewed: true });
                            updateCause(editing.id, { reviewed: true });
                          }}
                          onDelete={() => deleteChain(editing)}
                          onClose={() => setCauseId(null)}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>

        <AiFacilitator
          data={data}
          requestRealtimeToken={requestRealtimeToken}
          elementId={element.id}
          causeId={selectedCause ? selectedCause.id : null}
          onAddFailureChain={(targetElementId, suggestion) => {
            const fn = functions.find((f) => f.elementId === targetElementId);
            addChain(targetElementId, { ...suggestion, functionId: fn?.id ?? null, hazardRef: "", origin: "ai" });
            toast.success("Added to the failure network as an AI suggestion");
          }}
          onAddAction={(targetCauseId, suggestion) => {
            addAction(targetCauseId, { ...suggestion, owner: "", due: null }, "ai");
            toast.success("Action added as an AI suggestion");
          }}
          className="border-t lg:sticky lg:top-12 lg:h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:border-t-0 lg:border-l"
        />
      </div>

      <AddFailureModeDialog
        key={`${element.id}-${addOpen}`}
        open={addOpen}
        onOpenChange={setAddOpen}
        element={element}
        functions={elementFunctions}
        onAdd={(input) => {
          const newCauseId = addChain(element.id, { ...input, origin: "team" });
          setCauseId(newCauseId);
          setAddOpen(false);
          toast.success("Failure mode added");
        }}
      />
    </div>
  );
}
