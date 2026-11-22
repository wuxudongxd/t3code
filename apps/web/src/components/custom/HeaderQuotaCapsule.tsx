import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { nextPoolReset, resolveThreadDetailsLimits } from "../chat/ThreadDetailsUsage.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EMPTY_PROVIDERS: readonly ServerProvider[] = Object.freeze([]);
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = Object.freeze([]);

export interface HeaderQuotaCapsuleProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string;
}

interface QuotaWindowSummary {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly resetsAt: string | null;
}

export const HeaderQuotaCapsule = memo(function HeaderQuotaCapsule({
  environmentId,
  threadRef,
  className,
}: HeaderQuotaCapsuleProps) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const providersByEnvironment = useEnvironmentProviders();
  const serverConfigs = useServerConfigs();
  const threadShell = useQuietThreadShell(threadRef);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_PROVIDERS;
  const sources = serverConfigs.get(environmentId)?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;

  const providerInstanceId =
    threadShell?.runtime?.providerInstanceId ??
    threadShell?.modelSelection.instanceId ??
    providers.find((provider) => provider.enabled && provider.usageLimits !== undefined)
      ?.instanceId ??
    null;
  const model = threadShell?.modelSelection.model ?? null;

  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  if (!resolved) {
    return null;
  }

  let windows: QuotaWindowSummary[];
  if (resolved.kind === "pool") {
    windows = resolved.windows.map((window) => ({
      id: window.id,
      label: window.label,
      left: window.remainingPercent,
      resetsAt: nextPoolReset(window, now)?.member.window.resetsAt ?? null,
    }));
  } else {
    if (limitsNotice(resolved.limits, m) !== null) {
      return null;
    }
    windows = resolved.limits.windows.map((window) => ({
      id: window.id,
      label: window.label,
      left: remainingPercent(window),
      resetsAt: window.resetsAt ?? null,
    }));
  }

  if (windows.length === 0) {
    return null;
  }

  const primary = windows.reduce((lowest, candidate) =>
    candidate.left < lowest.left ? candidate : lowest,
  );
  const primaryResetsAtMs = primary.resetsAt ? Date.parse(primary.resetsAt) : Number.NaN;
  const resetCountdown =
    primary.resetsAt && Number.isFinite(primaryResetsAtMs) && primaryResetsAtMs > now
      ? formatDuration(primaryResetsAtMs - now, m)
      : null;

  const tone: "error" | "warning" | "ok" =
    primary.left <= 10 ? "error" : primary.left <= 20 ? "warning" : "ok";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/usage"
            data-custom-header-quota-capsule="true"
            aria-label={gt("{label}: {left}% left", {
              label: primary.label,
              left: primary.left,
            })}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-2xs font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:border-border hover:bg-muted/75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
              tone === "error" &&
                "border-error/35 bg-error/10 text-error-foreground hover:bg-error/15",
              tone === "warning" &&
                "border-warning/35 bg-warning/10 text-warning-foreground hover:bg-warning/15",
              className,
            )}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "error" ? "bg-error" : tone === "warning" ? "bg-warning" : "bg-success",
          )}
        />
        <span>{`${primary.left}%`}</span>
        {resetCountdown ? (
          <span className="hidden text-muted-foreground/80 sm:inline">{`· ${resetCountdown}`}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={8}>
        <div className="flex flex-col gap-1 tabular-nums">
          <span className="font-medium text-foreground">{gt("Usage limits")}</span>
          {windows.map((window) => {
            const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
            return (
              <div key={window.id} className="flex flex-col">
                <span className="text-foreground">
                  {gt("{label}: {left}% left", { label: window.label, left: window.left })}
                </span>
                {window.resetsAt && Number.isFinite(resetsAtMs) && resetsAtMs > now ? (
                  <span className="text-muted-foreground">
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
                ) : null}
              </div>
            );
          })}
          <span className="text-muted-foreground">{gt("Open usage")}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
