import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale, useMessages } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, ZapIcon } from "lucide-react";
import { memo } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection, useQuietThreadVisibleTurnItems } from "../../state/entities";
import { formatContextWindowCompactionMessage } from "../chat/compaction.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerTelemetryStripProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string;
}

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

export const ComposerTelemetryStrip = memo(function ComposerTelemetryStrip({
  threadRef,
  className,
}: ComposerTelemetryStripProps) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const quietThread = useQuietThreadProjection(threadRef);
  const visibleTurnItems = useQuietThreadVisibleTurnItems(threadRef);

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
  const cacheHitPercent = computeCacheHitPercent(inputTokens, cachedInputTokens);
  const hasTokenSummary =
    (inputTokens !== null && inputTokens > 0) || (outputTokens !== null && outputTokens > 0);

  return (
    <div
      data-custom-composer-telemetry="true"
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 border-t border-border/40 px-3.5 py-1 text-2xs leading-4 text-muted-foreground tabular-nums select-none",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              className="inline-flex min-w-0 cursor-default items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
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
        </TooltipTrigger>
        <TooltipPopup side="top" sideOffset={8}>
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground">
              {usedPercent !== null
                ? gt("Context: {used}% used", { used: usedPercent })
                : gt("Context: {usedTokens} tokens used", { usedTokens: usedTokensLabel })}
            </span>
            {maxTokens !== null ? (
              <span className="text-muted-foreground">
                {gt("{used} of {max} tokens", {
                  used: usage.usedTokens.toLocaleString(locale),
                  max: maxTokens.toLocaleString(locale),
                })}
              </span>
            ) : null}
            {threshold !== null && threshold > 0 ? (
              <span className="text-muted-foreground">
                {formatContextWindowCompactionMessage(threshold, m)}
              </span>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>

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
              {cacheHitPercent !== null ? (
                <span className="text-muted-foreground">
                  {`${gt("Cache hit")}: ${cacheHitPercent}%`}
                </span>
              ) : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
