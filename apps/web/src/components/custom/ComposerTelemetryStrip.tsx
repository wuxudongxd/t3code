import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ProviderTurn,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import * as DateTime from "effect/DateTime";
import { useGT, useLocale } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, GaugeIcon, ZapIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn, newMessageId } from "../../lib/utils";
import { useQuietThreadProjection, useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { Popover, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextBreakdownPopover } from "./ContextBreakdownPopover";

export interface ComposerTelemetryStripProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string;
}

const MIN_OUTPUT_TOKENS_FOR_RATE = 5;
const MIN_ELAPSED_MS_FOR_RATE = 400;
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 2_000;

function computeCacheHitPercent(
  inputTokens: number | null,
  cachedInputTokens: number | null,
): number | null {
  if (cachedInputTokens === null || cachedInputTokens <= 0) return null;
  if (inputTokens === null || inputTokens < 0) return null;
  const totalInput =
    cachedInputTokens <= inputTokens && inputTokens > 0
      ? inputTokens
      : inputTokens + cachedInputTokens;
  if (totalInput <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (cachedInputTokens / totalInput) * 100)));
}

function deriveTokensPerSecond(
  turns: readonly OrchestrationV2ProviderTurn[],
  activeProviderThreadId: string | null,
  fallbackOutputTokens: number | null,
  fallbackDurationMs: number | null,
): { readonly rate: number; readonly streaming: boolean } | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    if (activeProviderThreadId !== null && turn.providerThreadId !== activeProviderThreadId) {
      continue;
    }
    if (turn.startedAt === null) continue;
    const outputTokens = turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens ?? null;
    if (outputTokens === null || outputTokens < MIN_OUTPUT_TOKENS_FOR_RATE) continue;

    const startedAtMs = DateTime.toEpochMillis(turn.startedAt);
    const endedAtMs =
      turn.status === "running"
        ? Date.parse(turn.tokenUsage?.updatedAt ?? "")
        : turn.completedAt !== null
          ? DateTime.toEpochMillis(turn.completedAt)
          : Date.parse(turn.tokenUsage?.updatedAt ?? "");

    if (!Number.isFinite(endedAtMs)) continue;
    const elapsedMs = endedAtMs - startedAtMs;
    if (elapsedMs < MIN_ELAPSED_MS_FOR_RATE) continue;

    const rate = outputTokens / (elapsedMs / 1_000);
    if (Number.isFinite(rate) && rate > 0 && rate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND) {
      return { rate, streaming: turn.status === "running" };
    }
  }

  if (
    fallbackOutputTokens !== null &&
    fallbackOutputTokens >= MIN_OUTPUT_TOKENS_FOR_RATE &&
    fallbackDurationMs !== null &&
    fallbackDurationMs >= MIN_ELAPSED_MS_FOR_RATE
  ) {
    const rate = fallbackOutputTokens / (fallbackDurationMs / 1_000);
    if (Number.isFinite(rate) && rate > 0 && rate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND) {
      return { rate, streaming: false };
    }
  }

  return null;
}

function formatRateCompact(rate: number): string {
  return rate < 10 ? rate.toFixed(1) : Math.round(rate).toString();
}

export const ComposerTelemetryStrip = memo(function ComposerTelemetryStrip({
  threadRef,
  className,
}: ComposerTelemetryStripProps) {
  const gt = useGT();
  const locale = useLocale();
  const quietThread = useQuietThreadProjection(threadRef);
  const visibleTurnItems = useQuietThreadVisibleTurnItems(threadRef);
  const providersByEnvironment = useEnvironmentProviders();
  const canOperateThread = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const compactingRef = useRef(false);

  const projection = quietThread?.projection ?? null;
  const activeProviderThread = projection?.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const liveUsage = latestProviderTurnTokenUsage(
    projection?.providerTurns ?? [],
    projection,
    activeProviderThread,
  );
  const usage = deriveLatestContextWindowSnapshot(
    visibleTurnItems,
    liveUsage,
    activeProviderThread,
  );

  if (!usage || usage.usedTokens <= 0) {
    return null;
  }

  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const usedPercent =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const thresholdTick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;

  const tone: "error" | "warning" | "neutral" =
    usedPercent !== null && usedPercent > 85
      ? "error"
      : usedPercent !== null && usedPercent >= 70
        ? "warning"
        : "neutral";

  const usedTokensLabel = formatContextWindowTokens(usage.usedTokens);
  const inputTokens = usage.lastInputTokens ?? usage.inputTokens ?? null;
  const cachedInputTokens = usage.lastCachedInputTokens ?? usage.cachedInputTokens ?? null;
  const outputTokens = usage.lastOutputTokens ?? usage.outputTokens ?? null;
  const reasoningOutputTokens =
    usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens ?? null;
  const cacheHitPercent = computeCacheHitPercent(inputTokens, cachedInputTokens);
  const throughput = deriveTokensPerSecond(
    projection?.providerTurns ?? [],
    activeProviderThread?.id ?? null,
    outputTokens,
    usage.durationMs ?? null,
  );
  const hasTokenSummary =
    (inputTokens !== null && inputTokens > 0) ||
    (outputTokens !== null && outputTokens > 0) ||
    throughput !== null;

  const providers = threadRef ? (providersByEnvironment.get(threadRef.environmentId) ?? []) : [];
  const activeProvider = projection
    ? providers.find(
        (provider) => provider.instanceId === projection.thread.modelSelection.instanceId,
      )
    : undefined;
  const providerSupportsCompact =
    activeProvider?.slashCommands.some((command) => command.name === "compact") ?? false;
  const isTurnRunning =
    projection?.providerTurns.some((turn) => turn.status === "running") ?? false;
  const hasPendingRequests =
    projection?.runtimeRequests.some((request) => request.status === "pending") ?? false;
  const canCompact =
    threadRef !== null &&
    projection !== null &&
    canOperateThread &&
    providerSupportsCompact &&
    !isTurnRunning &&
    !hasPendingRequests;

  const handleCompact = () => {
    if (!canCompact || compactingRef.current || !threadRef || !projection) return;
    compactingRef.current = true;
    setIsCompacting(true);
    void (async () => {
      const result = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "/compact",
            attachments: [],
          },
          modelSelection: projection.thread.modelSelection,
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: DEFAULT_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
        },
      });
      compactingRef.current = false;
      setIsCompacting(false);
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: gt("Failed to compact context."),
        });
      } else {
        setPopoverOpen(false);
      }
    })();
  };

  return (
    <div
      data-custom-composer-telemetry="true"
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 border-t border-border/40 px-3.5 py-1 text-2xs leading-4 text-muted-foreground tabular-nums select-none",
        className,
      )}
    >
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          openOnHover
          delay={160}
          closeDelay={180}
          render={
            <button
              type="button"
              className="inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={
                usedPercent !== null
                  ? gt("Context: {used}% used", { used: usedPercent })
                  : gt("Context: {usedTokens} tokens used", { usedTokens: usedTokensLabel })
              }
            />
          }
        >
          <span className="shrink-0 text-muted-foreground/80">
            {gt("Context", { $context: "context window row label" })}
          </span>
          {usedPercent !== null ? (
            <span className="relative h-[3px] w-14 shrink-0 overflow-visible rounded-full bg-muted-foreground/20">
              {usedPercent > 0 ? (
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300",
                    tone === "error"
                      ? "bg-error"
                      : tone === "warning"
                        ? "bg-warning"
                        : "bg-foreground/60",
                  )}
                  style={{ width: `max(${usedPercent}%, 4px)` }}
                />
              ) : null}
              {thresholdTick !== null ? (
                <span
                  aria-hidden
                  className="absolute -top-[2px] h-[7px] w-px -translate-x-1/2 bg-foreground/55"
                  style={{ left: `clamp(0.5px, ${thresholdTick}%, calc(100% - 0.5px))` }}
                />
              ) : null}
            </span>
          ) : null}
          <span
            className={cn(
              "font-medium",
              tone === "error"
                ? "text-error-foreground"
                : tone === "warning"
                  ? "text-warning-foreground"
                  : "text-foreground/75",
            )}
          >
            {usedPercent !== null ? `${usedPercent}%` : usedTokensLabel}
          </span>
        </PopoverTrigger>
        <ContextBreakdownPopover
          usage={usage}
          usedPercent={usedPercent}
          maxTokens={maxTokens}
          threshold={threshold}
          thresholdTick={thresholdTick}
          tone={tone}
          inputTokens={inputTokens}
          cachedInputTokens={cachedInputTokens}
          outputTokens={outputTokens}
          reasoningOutputTokens={reasoningOutputTokens}
          cacheHitPercent={cacheHitPercent}
          tokensPerSecond={throughput?.rate ?? null}
          isStreamingRate={throughput?.streaming ?? false}
          canCompact={canCompact}
          isCompacting={isCompacting}
          onCompact={handleCompact}
        />
      </Popover>

      {hasTokenSummary || cacheHitPercent !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                tabIndex={0}
                className="inline-flex min-w-0 shrink-0 cursor-default items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {throughput !== null ? (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  throughput.streaming ? "text-foreground/90" : "text-muted-foreground/85",
                )}
              >
                <GaugeIcon
                  aria-hidden="true"
                  className={cn(
                    "size-2.5",
                    throughput.streaming ? "text-success motion-safe:animate-pulse" : "opacity-70",
                  )}
                />
                {`${formatRateCompact(throughput.rate)} tok/s`}
              </span>
            ) : null}
            {inputTokens !== null && inputTokens > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground/85">
                <ArrowDownIcon aria-hidden="true" className="size-2.5 opacity-70" />
                {formatContextWindowTokens(inputTokens)}
              </span>
            ) : null}
            {outputTokens !== null && outputTokens > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground/85">
                <ArrowUpIcon aria-hidden="true" className="size-2.5 opacity-70" />
                {formatContextWindowTokens(outputTokens)}
              </span>
            ) : null}
            {cacheHitPercent !== null ? (
              <span className="inline-flex items-center gap-0.5 font-medium text-foreground/75">
                <ZapIcon aria-hidden="true" className="size-2.5 text-success" />
                {`${cacheHitPercent}%`}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top" sideOffset={8}>
            <div className="flex flex-col gap-0.5 tabular-nums">
              {inputTokens !== null && inputTokens > 0 ? (
                <span className="text-foreground">
                  {`${gt("Input")}: ${inputTokens.toLocaleString(locale)}`}
                </span>
              ) : null}
              {cachedInputTokens !== null && cachedInputTokens > 0 ? (
                <span className="text-muted-foreground">
                  {`${gt("Cached input")}: ${cachedInputTokens.toLocaleString(locale)}`}
                </span>
              ) : null}
              {outputTokens !== null && outputTokens > 0 ? (
                <span className="text-muted-foreground">
                  {`${gt("Output", { $context: "output tokens" })}: ${outputTokens.toLocaleString(locale)}`}
                </span>
              ) : null}
              {reasoningOutputTokens !== null && reasoningOutputTokens > 0 ? (
                <span className="text-muted-foreground">
                  {`${gt("Reasoning", { $context: "model option name" })}: ${reasoningOutputTokens.toLocaleString(locale)}`}
                </span>
              ) : null}
              {cacheHitPercent !== null ? (
                <span className="text-muted-foreground">
                  {`${gt("Cache hit")}: ${cacheHitPercent}%`}
                </span>
              ) : null}
              {throughput !== null ? (
                <span className="text-muted-foreground">
                  {`${formatRateCompact(throughput.rate)} tok/s`}
                </span>
              ) : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
