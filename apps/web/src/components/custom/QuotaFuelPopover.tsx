import type { LimitPace } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useMessages } from "gt-react";
import { ArrowUpRightIcon } from "lucide-react";
import { memo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { PopoverPopup } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";

const LED_CELL_COUNT = 20;
const LED_CELL_INDICES = Array.from({ length: LED_CELL_COUNT }, (_, index) => index);

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

export interface QuotaFuelWindow {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly resetsAt: string | null;
  readonly timeLeftPercent: number | null;
  readonly pace: LimitPace | null;
}

interface QuotaFuelPopoverProps {
  readonly providerLabel: string | null;
  readonly windows: readonly QuotaFuelWindow[];
  readonly now: number;
  readonly canRefresh: boolean;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}

function windowTone(left: number): "rose" | "amber" | "green" {
  if (left <= 10) return "rose";
  if (left <= 20) return "amber";
  return "green";
}

function QuotaFuelInstrument({
  left,
  tone,
}: {
  readonly left: number;
  readonly tone: "rose" | "amber" | "green";
}) {
  const clampedLeft = Math.max(0, Math.min(100, left));
  const litCells =
    clampedLeft <= 0 ? 0 : Math.max(1, Math.round((clampedLeft / 100) * LED_CELL_COUNT));

  const litClassName =
    tone === "rose" ? "bg-error/90" : tone === "amber" ? "bg-warning/90" : "bg-success/85";

  return (
    <div
      aria-hidden="true"
      data-custom-quota-fuel-matrix="true"
      className="flex h-2.5 w-full items-stretch gap-0.5"
    >
      {LED_CELL_INDICES.map((index) => {
        const isLit = index < litCells;
        const isEdge = isLit && index === litCells - 1;
        return (
          <span
            key={index}
            className={cn(
              "flex-1 rounded-xs transition-colors duration-200",
              isLit ? litClassName : "bg-muted-foreground/15",
              isEdge && "brightness-110",
            )}
          />
        );
      })}
    </div>
  );
}

export const QuotaFuelPopover = memo(function QuotaFuelPopover({
  providerLabel,
  windows,
  now,
  canRefresh,
  isRefreshing,
  onRefresh,
  onClose,
}: QuotaFuelPopoverProps) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  return (
    <PopoverPopup side="bottom" align="end" sideOffset={8} padding="compact" width="md">
      <div className="flex flex-col gap-3 text-xs tabular-nums">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-foreground">{gt("Usage limits")}</span>
            {providerLabel ? (
              <span className="truncate rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                {providerLabel}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={isRefreshing}
                onClick={onRefresh}
                aria-label={gt("Refresh limits")}
                title={gt("Refresh limits")}
              >
                <RefreshIcon size="xs" refreshing={isRefreshing} />
              </Button>
            ) : null}
            <Link
              to="/usage"
              onClick={onClose}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted/75 hover:text-foreground"
            >
              <span>{gt("Open usage")}</span>
              <ArrowUpRightIcon aria-hidden="true" className="size-3" />
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {windows.map((window) => {
            const tone = windowTone(window.left);
            const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
            const hasUpcomingReset =
              window.resetsAt !== null && Number.isFinite(resetsAtMs) && resetsAtMs > now;
            const elapsedPercent =
              window.timeLeftPercent !== null
                ? Math.max(0, Math.min(100, 100 - window.timeLeftPercent))
                : null;

            return (
              <div
                key={window.id}
                className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-muted/25 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium text-foreground">{window.label}</span>
                    {window.pace ? (
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        {m(PACE_LABEL[window.pace])}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 font-semibold",
                      tone === "rose"
                        ? "text-error-foreground"
                        : tone === "amber"
                          ? "text-warning-foreground"
                          : "text-success-foreground",
                    )}
                  >
                    {`${window.left}%`}
                  </span>
                </div>

                <QuotaFuelInstrument left={window.left} tone={tone} />

                {hasUpcomingReset && window.resetsAt !== null ? (
                  <div className="flex flex-col gap-1 pt-0.5">
                    {elapsedPercent !== null ? (
                      <div
                        aria-hidden="true"
                        className="relative h-1 w-full overflow-hidden rounded-full bg-muted-foreground/15"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-foreground/35 transition-[width] duration-300"
                          style={{ width: `${elapsedPercent}%` }}
                        />
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 text-3xs leading-3.5 text-muted-foreground">
                      <span className="truncate">
                        {gt("Resets in {duration} · {time}", {
                          duration: formatDuration(resetsAtMs - now, m),
                          time: formatUpcomingTimestamp(
                            window.resetsAt,
                            timestampFormat,
                            now,
                            undefined,
                            m,
                          ),
                        })}
                      </span>
                      {window.timeLeftPercent !== null ? (
                        <span className="shrink-0">
                          {gt("{timeLeft}% of the window left", {
                            timeLeft: window.timeLeftPercent,
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </PopoverPopup>
  );
});
