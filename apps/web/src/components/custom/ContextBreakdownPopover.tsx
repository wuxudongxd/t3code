import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale, useMessages } from "gt-react";
import { GaugeIcon, Minimize2Icon, ZapIcon } from "lucide-react";
import { memo } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatContextWindowCompactionMessage } from "../chat/compaction.logic";
import { Button } from "../ui/button";
import { PopoverPopup } from "../ui/popover";

interface ContextBreakdownPopoverProps {
  readonly usage: ContextWindowSnapshot;
  readonly usedPercent: number | null;
  readonly maxTokens: number | null;
  readonly threshold: number | null;
  readonly thresholdTick: number | null;
  readonly tone: "error" | "warning" | "neutral";
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly cacheHitPercent: number | null;
  readonly tokensPerSecond: number | null;
  readonly isStreamingRate: boolean;
  readonly canCompact: boolean;
  readonly isCompacting: boolean;
  readonly onCompact: () => void;
}

interface BreakdownSegment {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly dotClassName: string;
  readonly barClassName: string;
  readonly badge?: string | null;
}

function formatRate(rate: number): string {
  return rate < 10 ? rate.toFixed(1) : Math.round(rate).toString();
}

export const ContextBreakdownPopover = memo(function ContextBreakdownPopover({
  usage,
  usedPercent,
  maxTokens,
  threshold,
  thresholdTick,
  tone,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens,
  cacheHitPercent,
  tokensPerSecond,
  isStreamingRate,
  canCompact,
  isCompacting,
  onCompact,
}: ContextBreakdownPopoverProps) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();

  const usedTokensLabel = formatContextWindowTokens(usage.usedTokens);
  const uncachedInputTokens =
    inputTokens !== null && inputTokens > 0
      ? cachedInputTokens !== null && cachedInputTokens > 0 && cachedInputTokens <= inputTokens
        ? inputTokens - cachedInputTokens
        : inputTokens
      : null;

  const segments: BreakdownSegment[] = [];
  if (uncachedInputTokens !== null && uncachedInputTokens > 0) {
    segments.push({
      key: "input",
      label: gt("Input"),
      tokens: uncachedInputTokens,
      dotClassName: "bg-info",
      barClassName: "bg-info/85",
    });
  }
  if (cachedInputTokens !== null && cachedInputTokens > 0) {
    segments.push({
      key: "cached",
      label: gt("Cached input"),
      tokens: cachedInputTokens,
      dotClassName: "bg-success",
      barClassName: "bg-success/80",
      badge: cacheHitPercent !== null ? `${cacheHitPercent}%` : null,
    });
  }
  if (outputTokens !== null && outputTokens > 0) {
    const nonReasoningOutput =
      reasoningOutputTokens !== null &&
      reasoningOutputTokens > 0 &&
      reasoningOutputTokens <= outputTokens
        ? outputTokens - reasoningOutputTokens
        : outputTokens;
    if (nonReasoningOutput > 0) {
      segments.push({
        key: "output",
        label: gt("Output", { $context: "output tokens" }),
        tokens: nonReasoningOutput,
        dotClassName: "bg-warning",
        barClassName: "bg-warning/85",
      });
    }
  }
  if (reasoningOutputTokens !== null && reasoningOutputTokens > 0) {
    segments.push({
      key: "reasoning",
      label: gt("Reasoning", { $context: "model option name" }),
      tokens: reasoningOutputTokens,
      dotClassName: "bg-guest",
      barClassName: "bg-guest/85",
    });
  }

  const segmentTotal = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const barDenominator =
    maxTokens !== null && maxTokens > 0
      ? Math.max(maxTokens, segmentTotal)
      : Math.max(usage.usedTokens, segmentTotal, 1);

  return (
    <PopoverPopup side="top" align="start" sideOffset={8} padding="compact" width="sm">
      <div className="flex flex-col gap-2.5 text-xs tabular-nums">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-foreground">{gt("Context window")}</span>
            <span className="text-2xs text-muted-foreground">
              {maxTokens !== null
                ? gt("{used} of {max} tokens", {
                    used: usage.usedTokens.toLocaleString(locale),
                    max: maxTokens.toLocaleString(locale),
                  })
                : gt("Context: {usedTokens} tokens used", { usedTokens: usedTokensLabel })}
            </span>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium",
              tone === "error"
                ? "border-error/35 bg-error/10 text-error-foreground"
                : tone === "warning"
                  ? "border-warning/35 bg-warning/10 text-warning-foreground"
                  : "border-border/60 bg-muted/50 text-foreground/85",
            )}
          >
            {usedPercent !== null ? `${usedPercent}%` : usedTokensLabel}
          </span>
        </div>

        <div className="relative flex h-2 w-full overflow-visible rounded-full bg-muted-foreground/15">
          <div className="flex h-full w-full overflow-hidden rounded-full">
            {segments.length > 0 ? (
              segments.map((segment) => {
                const widthPercent = Math.max(
                  0,
                  Math.min(100, (segment.tokens / barDenominator) * 100),
                );
                if (widthPercent <= 0) return null;
                return (
                  <span
                    key={segment.key}
                    className={cn("h-full transition-[width] duration-300", segment.barClassName)}
                    style={{ width: `${widthPercent}%` }}
                  />
                );
              })
            ) : usedPercent !== null && usedPercent > 0 ? (
              <span
                className={cn(
                  "h-full transition-[width] duration-300",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : "bg-foreground/65",
                )}
                style={{ width: `max(${usedPercent}%, 4px)` }}
              />
            ) : null}
          </div>
          {thresholdTick !== null ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-0.5 h-3 w-0.5 -translate-x-1/2 rounded-full bg-foreground/65"
              style={{ left: `clamp(1px, ${thresholdTick}%, calc(100% - 1px))` }}
            />
          ) : null}
        </div>

        {segments.length > 0 ? (
          <div className="flex flex-col gap-1">
            {segments.map((segment) => (
              <div
                key={segment.key}
                className="flex items-center justify-between gap-2 text-2xs leading-4"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={cn("size-1.5 shrink-0 rounded-full", segment.dotClassName)}
                  />
                  <span className="truncate">{segment.label}</span>
                  {segment.badge ? (
                    <span className="inline-flex items-center gap-0.5 rounded-xs bg-success/15 px-1 text-3xs font-medium text-success-foreground">
                      <ZapIcon aria-hidden="true" className="size-2.5" />
                      {segment.badge}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-medium text-foreground/85">
                  {segment.tokens.toLocaleString(locale)}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {tokensPerSecond !== null ? (
          <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2 text-2xs leading-4">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <GaugeIcon aria-hidden="true" className="size-3 opacity-75" />
              <span>{gt("Output", { $context: "output tokens" })}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground/90">
              {isStreamingRate ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
                />
              ) : null}
              <span>{`${formatRate(tokensPerSecond)} tok/s`}</span>
            </span>
          </div>
        ) : null}

        {threshold !== null && threshold > 0 ? (
          <p className="text-2xs leading-4 text-muted-foreground">
            {formatContextWindowCompactionMessage(threshold, m)}
          </p>
        ) : null}

        {canCompact ? (
          <div className="border-t border-border/50 pt-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={isCompacting}
              onClick={onCompact}
              className="w-full justify-between"
            >
              <span className="inline-flex items-center gap-1.5">
                <Minimize2Icon aria-hidden="true" className="size-3" />
                <span>
                  {isCompacting
                    ? gt("Compacting…")
                    : gt("Compact", { $context: "verb, compact history before sending" })}
                </span>
              </span>
              <span className="font-mono text-3xs text-muted-foreground">/compact</span>
            </Button>
          </div>
        ) : null}
      </div>
    </PopoverPopup>
  );
});
