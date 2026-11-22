import type { RunId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FileCode2Icon,
  FileTextIcon,
  GlobeIcon,
  LayersIcon,
  Loader2Icon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useState, useSyncExternalStore } from "react";

import { cn } from "../../lib/utils";
import type { TimelineEntry } from "../../session-logic";
import type { TimelineLatestRun } from "../chat/MessagesTimeline.logic";
import {
  formatStepDuration,
  synthesizeTaskSteps,
  type SynthesizedTaskStep,
  type TaskStepCategory,
  type TaskStepStatus,
} from "./synthesizeTaskSteps";

const COMPACT_CHIP_LIMIT = 8;

const secondListeners = new Set<() => void>();
let secondInterval: ReturnType<typeof setInterval> | null = null;
let currentSecondMs = Math.floor(Date.now() / 1000) * 1000;

function subscribeSecondTick(listener: () => void): () => void {
  secondListeners.add(listener);
  if (secondInterval === null) {
    currentSecondMs = Math.floor(Date.now() / 1000) * 1000;
    secondInterval = setInterval(() => {
      currentSecondMs = Math.floor(Date.now() / 1000) * 1000;
      for (const notify of secondListeners) {
        notify();
      }
    }, 1000);
  }
  return () => {
    secondListeners.delete(listener);
    if (secondListeners.size === 0 && secondInterval !== null) {
      clearInterval(secondInterval);
      secondInterval = null;
    }
  };
}

function noopSubscribe(): () => void {
  return () => {};
}

function getSecondSnapshot(): number {
  return currentSecondMs;
}

function useLiveSecondMs(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeSecondTick : noopSubscribe,
    getSecondSnapshot,
    getSecondSnapshot,
  );
}

function CategoryIcon({
  category,
  className,
}: {
  readonly category: TaskStepCategory;
  readonly className?: string;
}) {
  switch (category) {
    case "read":
      return <FileCode2Icon aria-hidden="true" className={className} />;
    case "search":
      return <SearchIcon aria-hidden="true" className={className} />;
    case "edit":
      return <PencilIcon aria-hidden="true" className={className} />;
    case "terminal":
      return <TerminalIcon aria-hidden="true" className={className} />;
    case "delegate":
      return <BotIcon aria-hidden="true" className={className} />;
    case "web":
      return <GlobeIcon aria-hidden="true" className={className} />;
    case "other":
      return <WrenchIcon aria-hidden="true" className={className} />;
  }
}

function StatusIcon({
  status,
  className,
}: {
  readonly status: TaskStepStatus;
  readonly className?: string;
}) {
  if (status === "running") {
    return (
      <Loader2Icon
        aria-hidden="true"
        className={cn("animate-spin text-foreground/80", className)}
      />
    );
  }
  if (status === "error") {
    return <AlertCircleIcon aria-hidden="true" className={cn("text-destructive", className)} />;
  }
  return <CheckCircle2Icon aria-hidden="true" className={cn("text-success", className)} />;
}

function useCategoryLabel(category: TaskStepCategory): string {
  const gt = useGT();
  switch (category) {
    case "read":
      return gt("Read");
    case "search":
      return gt("Search");
    case "edit":
      return gt("Write files");
    case "terminal":
      return gt("Terminal");
    case "delegate":
      return gt("subagent", { $context: "kind of background work" });
    case "web":
      return gt("Web");
    case "other":
      return gt("Tool", { $context: "noun, a tool title" });
  }
}

const ExpandedStepRow = memo(function ExpandedStepRow({
  step,
  index,
}: {
  readonly step: SynthesizedTaskStep;
  readonly index: number;
}) {
  const categoryLabel = useCategoryLabel(step.category);
  const durationLabel = formatStepDuration(step.durationMs);
  const showDetail =
    step.detail !== undefined && step.detail.length > 0 && step.detail !== step.title;

  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs leading-4">
      <span className="w-4 shrink-0 text-right text-3xs tabular-nums text-muted-foreground/60">
        {index + 1}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 bg-background/70 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
        <CategoryIcon category={step.category} className="size-2.5 shrink-0" />
        <span>{categoryLabel}</span>
      </span>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-foreground/90",
            step.status === "error" && "text-destructive",
          )}
        >
          {step.title}
        </span>
        {showDetail ? (
          <span className="block truncate text-3xs text-muted-foreground/75">{step.detail}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 tabular-nums text-3xs text-muted-foreground">
        {durationLabel ? <span>{durationLabel}</span> : null}
        <StatusIcon status={step.status} className="size-3 shrink-0" />
      </div>
    </li>
  );
});

interface StepCapsuleProps {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly activeTurnStartedAt?: string | null | undefined;
  readonly latestRun?: TimelineLatestRun | null | undefined;
  readonly runningRunId?: RunId | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
  readonly className?: string;
}

export const StepCapsule = memo(function StepCapsule({
  timelineEntries,
  isWorking,
  activeTurnStartedAt,
  latestRun,
  runningRunId,
  workspaceRoot,
  className,
}: StepCapsuleProps) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);

  // First pass checks whether any step is still active so the 1s clock only ticks while running.
  const liveNowMs = useLiveSecondMs(isWorking);
  const summary = synthesizeTaskSteps({
    timelineEntries,
    isWorking,
    activeTurnStartedAt,
    latestRun,
    runningRunId,
    workspaceRoot,
    nowMs: isWorking ? liveNowMs : undefined,
  });

  if (!summary) {
    return null;
  }

  const elapsedLabel = formatStepDuration(summary.elapsedMs);
  const compactSteps =
    summary.steps.length > COMPACT_CHIP_LIMIT
      ? summary.steps.slice(summary.steps.length - COMPACT_CHIP_LIMIT)
      : summary.steps;
  const hiddenChipCount = summary.steps.length - compactSteps.length;
  const headerStatus: TaskStepStatus = summary.isRunning
    ? "running"
    : summary.errorCount > 0
      ? "error"
      : "done";

  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane overflow-x-clip">
        <section
          aria-label={gt("Activity")}
          data-custom-step-capsule="true"
          className={cn(
            "my-2 overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-muted-foreground transition-colors",
            className,
          )}
        >
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <div className="flex min-w-0 items-center gap-2">
              <StatusIcon status={headerStatus} className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium tabular-nums text-foreground/90">
                {gt("Tasks {done}/{total}", {
                  done: summary.doneCount,
                  total: summary.totalCount,
                })}
              </span>
              {!expanded && summary.activeStep ? (
                <span className="hidden min-w-0 items-center gap-1 truncate text-muted-foreground sm:inline-flex">
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                  <CategoryIcon
                    category={summary.activeStep.category}
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">{summary.activeStep.title}</span>
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-muted-foreground">
              {summary.touchedFileCount > 0 ? (
                <span
                  className="inline-flex items-center gap-1"
                  aria-label={`${gt("Files")}: ${summary.touchedFileCount}`}
                >
                  <FileTextIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground/75"
                  />
                  <span>{summary.touchedFileCount}</span>
                </span>
              ) : null}
              {summary.outputCount > 0 && summary.outputCount !== summary.touchedFileCount ? (
                <span className="inline-flex items-center gap-1">
                  <LayersIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground/75"
                  />
                  <span>{summary.outputCount}</span>
                </span>
              ) : null}
              {summary.errorCount > 0 ? (
                <span className="font-medium text-destructive">
                  {gt("{count} failed", { count: summary.errorCount })}
                </span>
              ) : null}
              {elapsedLabel ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground/85">
                  <ClockIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground/70"
                  />
                  <span>{elapsedLabel}</span>
                </span>
              ) : null}
              {expanded ? (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground/75"
                />
              ) : (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground/75"
                />
              )}
            </div>
          </button>

          {!expanded ? (
            <div className="flex items-center gap-1.5 overflow-x-auto border-t border-border/40 px-2.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {hiddenChipCount > 0 ? (
                <span className="shrink-0 rounded-full border border-border/50 bg-background/50 px-1.5 py-0.5 text-3xs tabular-nums text-muted-foreground/80">
                  {`+${hiddenChipCount}`}
                </span>
              ) : null}
              {compactSteps.map((step) => (
                <span
                  key={step.id}
                  className={cn(
                    "inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-2xs leading-4 text-muted-foreground",
                    step.status === "running" &&
                      "border-foreground/25 bg-background text-foreground",
                    step.status === "error" &&
                      "border-destructive/30 bg-destructive/5 text-destructive",
                  )}
                >
                  <CategoryIcon category={step.category} className="size-3 shrink-0 opacity-80" />
                  <span className="truncate">{step.title}</span>
                  <StatusIcon status={step.status} className="size-2.5 shrink-0" />
                </span>
              ))}
            </div>
          ) : (
            <ol className="max-h-60 divide-y divide-border/30 overflow-y-auto border-t border-border/40 bg-background/40">
              {summary.steps.map((step, index) => (
                <ExpandedStepRow key={step.id} step={step} index={index} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
});
