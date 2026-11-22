import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { paceOf, paceRemainingPercent, remainingPercent } from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";
import { memo, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { nextPoolReset, resolveThreadDetailsLimits } from "../chat/ThreadDetailsUsage.logic";
import { Popover, PopoverTrigger } from "../ui/popover";
import { QuotaFuelPopover, type QuotaFuelWindow } from "./QuotaFuelPopover";

const EMPTY_PROVIDERS: readonly ServerProvider[] = Object.freeze([]);
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = Object.freeze([]);

export interface HeaderQuotaCapsuleProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string;
}

export const HeaderQuotaCapsule = memo(function HeaderQuotaCapsule({
  environmentId,
  threadRef,
  className,
}: HeaderQuotaCapsuleProps) {
  const gt = useGT();
  const m = useMessages();
  const providersByEnvironment = useEnvironmentProviders();
  const serverConfigs = useServerConfigs();
  const threadShell = useQuietThreadShell(threadRef);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_PROVIDERS;
  const sources = serverConfigs.get(environmentId)?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;

  const providerInstanceId =
    threadShell?.runtime?.providerInstanceId ??
    threadShell?.modelSelection.instanceId ??
    providers.find((provider) => provider.enabled && provider.usageLimits !== undefined)
      ?.instanceId ??
    null;
  const model = threadShell?.modelSelection.model ?? null;
  const activeProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const providerLabel = activeProvider?.displayName?.trim() || null;

  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  if (!resolved) {
    return null;
  }

  let windows: QuotaFuelWindow[];
  if (resolved.kind === "pool") {
    windows = resolved.windows.map((window) => {
      const nextReset = nextPoolReset(window, now);
      return {
        id: window.id,
        label: window.label,
        left: window.remainingPercent,
        resetsAt: nextReset?.member.window.resetsAt ?? null,
        timeLeftPercent: nextReset ? paceRemainingPercent(nextReset.member.window, now) : null,
        pace: window.pace,
      };
    });
  } else {
    if (limitsNotice(resolved.limits, m) !== null) {
      return null;
    }
    windows = resolved.limits.windows.map((window) => ({
      id: window.id,
      label: window.label,
      left: remainingPercent(window),
      resetsAt: window.resetsAt ?? null,
      timeLeftPercent: paceRemainingPercent(window, now),
      pace: paceOf(window, now),
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

  const handleRefresh = () => {
    if (!canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshUsageLimits(
      environmentId,
      () => refreshProviders({ environmentId, input: {} }),
      false,
    ).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        openOnHover
        delay={180}
        closeDelay={180}
        render={
          <button
            type="button"
            data-custom-header-quota-capsule="true"
            aria-label={gt("{label}: {left}% left", {
              label: primary.label,
              left: primary.left,
            })}
            className={cn(
              "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-2xs font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:border-border hover:bg-muted/75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
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
      </PopoverTrigger>
      <QuotaFuelPopover
        providerLabel={providerLabel}
        windows={windows}
        now={now}
        canRefresh={canRefresh}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
        onClose={() => setPopoverOpen(false)}
      />
    </Popover>
  );
});
