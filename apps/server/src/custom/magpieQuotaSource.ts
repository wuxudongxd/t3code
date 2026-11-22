import {
  ProviderDriverKind,
  UsageLimitSourceError,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type ServerSettings,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const DEFAULT_LOCAL_MAGPIE_ORIGIN = "http://127.0.0.1:3425";

interface MagpieHub {
  readonly url: string;
  readonly managementKey: string;
  readonly timeoutMs?: number;
  readonly forceRefresh?: boolean;
}

const MagpieQuotaSpan = Schema.Struct({
  unlimited: Schema.optional(Schema.Boolean),
  name: Schema.String,
  used: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
  display: Schema.optional(Schema.String),
  text: Schema.optional(Schema.Boolean),
  lane: Schema.optional(Schema.String),
  pool: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.String),
});
type MagpieQuotaSpan = typeof MagpieQuotaSpan.Type;

const MagpieQuotaCard = Schema.Struct({
  provider: Schema.String,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  alias: Schema.optional(Schema.String),
  seat: Schema.optional(Schema.String),
  balance: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  readAt: Schema.optional(Schema.NullOr(Schema.String)),
  asOf: Schema.optional(Schema.NullOr(Schema.String)),
  windows: Schema.optional(Schema.NullOr(Schema.Array(MagpieQuotaSpan))),
});
type MagpieQuotaCard = typeof MagpieQuotaCard.Type;

const MagpieQuotasEnvelope = Schema.Union([
  Schema.Array(MagpieQuotaCard),
  Schema.Struct({ data: Schema.Array(MagpieQuotaCard) }),
  Schema.Struct({ quotas: Schema.Array(MagpieQuotaCard) }),
]);

const decodeMagpieQuotasEnvelope = Schema.decodeUnknownEffect(MagpieQuotasEnvelope);

function extractMagpieQuotaCards(
  decoded: typeof MagpieQuotasEnvelope.Type,
): ReadonlyArray<MagpieQuotaCard> {
  if ("data" in decoded) return decoded.data;
  if ("quotas" in decoded) return decoded.quotas;
  return decoded;
}

function isLoopbackUrl(url: URL | null): boolean {
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Collects candidate loopback origins where a local Magpie daemon might be running:
 * any loopback provider instance baseUrl/endpoint plus `http://127.0.0.1:3425`.
 */
export function collectLocalMagpieCandidateOrigins(
  settings: ServerSettings | null,
  explicitOrigins: ReadonlySet<string>,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  for (const instance of Object.values(settings?.providerInstances ?? {})) {
    const config = instance?.config;
    if (!config || typeof config !== "object") continue;
    const record = config as Record<string, unknown>;
    const env =
      record.env && typeof record.env === "object" ? (record.env as Record<string, unknown>) : null;
    for (const raw of [
      record.baseUrl,
      record.endpoint,
      env?.ANTHROPIC_BASE_URL,
      env?.OPENAI_BASE_URL,
    ]) {
      if (typeof raw !== "string") continue;
      const parsed = URL.parse(raw.trim());
      if (parsed && isLoopbackUrl(parsed)) {
        candidates.add(parsed.origin);
      }
    }
  }
  candidates.add(DEFAULT_LOCAL_MAGPIE_ORIGIN);
  return [...candidates].filter((origin) => !explicitOrigins.has(origin));
}

function normalizeIsoTimestamp(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = DateTime.make(value.trim());
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function mapMagpieProviderToDriver(providerId: string): ProviderDriverKind {
  switch (providerId.toLowerCase()) {
    case "codex":
    case "openai":
      return ProviderDriverKind.make("codex");
    case "antigravity":
      return ProviderDriverKind.make("antigravity");
    case "cursor":
      return ProviderDriverKind.make("cursor");
    case "grok":
    case "xai":
      return ProviderDriverKind.make("grok");
    case "opencode":
    case "opencode-go":
      return ProviderDriverKind.make("opencode");
    default:
      // Claude accounts and Magpie third-party coding plans route via Anthropic-compatible endpoints;
      // per-window `providerIds` keeps each vendor isolated at model granularity.
      return ProviderDriverKind.make("claudeAgent");
  }
}

function classifyMagpieSpan(name: string): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins?: number;
  readonly suffix: string;
} {
  const lower = name.toLowerCase();
  if (/\b5\s*(?:h|hr|hour|hours)\b/.test(lower) || /\bsession\b/.test(lower)) {
    return { kind: "session", windowDurationMins: 300, suffix: "5h" };
  }
  if (/\b7\s*(?:d|day|days)\b/.test(lower) || /\bweek(?:ly)?\b/.test(lower)) {
    return { kind: "weekly", windowDurationMins: 10_080, suffix: "weekly" };
  }
  if (/\b30\s*(?:d|day|days)\b/.test(lower) || /\bmonth(?:ly)?\b/.test(lower)) {
    return { kind: "monthly", windowDurationMins: 43_200, suffix: "monthly" };
  }
  const hourMatch = lower.match(/\b(\d+)\s*(?:h|hr|hour|hours)\b/);
  if (hourMatch?.[1]) {
    const hours = Number(hourMatch[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "session", windowDurationMins: Math.round(hours * 60), suffix: `${hours}h` };
    }
  }
  const dayMatch = lower.match(/\b(\d+)\s*(?:d|day|days)\b/);
  if (dayMatch?.[1]) {
    const days = Number(dayMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return {
        kind: days === 7 ? "weekly" : "other",
        windowDurationMins: Math.round(days * 1_440),
        suffix: `${days}d`,
      };
    }
  }
  const slug =
    lower
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "window";
  return { kind: "other", suffix: slug };
}

function formatMagpieWindowLabel(
  name: string,
  kind: ServerProviderUsageWindow["kind"],
  windowDurationMins: number | undefined,
): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "5 hours" || lower === "5-hour" || lower === "5h") return "5h Session";
  if (lower === "7 days" || lower === "weekly" || lower === "week") return "Weekly";
  const normalized = trimmed.replace(/\b5\s*hours?\b/gi, "5h").replace(/\b7\s*days?\b/gi, "Weekly");
  if (normalized.length > 0) return normalized;
  if (kind === "session" && windowDurationMins === 300) return "5h Session";
  if (kind === "weekly") return "Weekly";
  return "Quota";
}

function buildMagpieWindowId(providerId: string, span: MagpieQuotaSpan, suffix: string): string {
  if (providerId === "antigravity") {
    const poolText = `${span.pool ?? ""} ${span.name}`.toLowerCase();
    if (poolText.includes("argon")) return `gemini-argon-${suffix}`;
    if (poolText.includes("carbon")) return `gemini-carbon-${suffix}`;
    if (poolText.includes("claude") || poolText.includes("gpt") || poolText.includes("3p")) {
      return `3p-${suffix}`;
    }
    if (poolText.includes("gemini")) return `gemini-${suffix}`;
  }
  return `${providerId}-${suffix}`;
}

function formatMagpiePlan(providerId: string, rawPlan: string | undefined): string | undefined {
  const trimmed = rawPlan?.trim();
  if (!trimmed) return undefined;
  if (providerId === "codex") {
    const lower = trimmed.toLowerCase();
    if (lower === "plus") return "ChatGPT Plus";
    if (lower === "pro") return "ChatGPT Pro";
    if (lower === "team") return "ChatGPT Team";
    if (lower === "enterprise") return "ChatGPT Enterprise";
  }
  return trimmed;
}

/** Converts Magpie's `/v1/magpie/quotas` response cards into T3 usage limit source accounts. */
export function magpieQuotasToSourceAccounts(
  cards: ReadonlyArray<MagpieQuotaCard>,
  fallbackCheckedAt: string,
): ReadonlyArray<UsageLimitSourceAccount> {
  const countByProvider = new Map<string, number>();
  const accounts: UsageLimitSourceAccount[] = [];

  for (const card of cards) {
    const providerId = card.provider.trim().toLowerCase();
    if (!providerId) continue;
    const rawSpans = card.windows ?? [];
    if (rawSpans.length === 0) continue;

    // Collect pools that already have a timed cadence window so duplicate effort-level rows
    // (e.g. "Gemini 4 Argon (High)/(Low)/(Medium)" alongside "Gemini 4 Argon · 7 days") are dropped.
    const timedPools = new Set<string>();
    const classified = rawSpans.flatMap((span) => {
      if (span.text || span.unlimited) return [];
      const used =
        typeof span.used === "number" && Number.isFinite(span.used)
          ? clampPercent(span.used)
          : typeof span.remaining === "number" && Number.isFinite(span.remaining)
            ? clampPercent(100 - span.remaining)
            : null;
      if (used === null) return [];
      const meta = classifyMagpieSpan(span.name);
      const poolKey = span.pool?.trim().toLowerCase() ?? "";
      if (poolKey && meta.kind !== "other") {
        timedPools.add(poolKey);
      }
      return [{ span, used, meta, poolKey }];
    });

    const seenIds = new Set<string>();
    const windows: ServerProviderUsageWindow[] = [];
    for (const { span, used, meta, poolKey } of classified) {
      if (meta.kind === "other" && poolKey && timedPools.has(poolKey)) {
        continue;
      }
      const baseId = buildMagpieWindowId(providerId, span, meta.suffix);
      let id = baseId;
      let duplicateIndex = 2;
      while (seenIds.has(id)) {
        id = `${baseId}-${duplicateIndex}`;
        duplicateIndex += 1;
      }
      seenIds.add(id);

      const resetsAt = normalizeIsoTimestamp(span.resetsAt);
      windows.push({
        id,
        kind: meta.kind,
        label: formatMagpieWindowLabel(span.name, meta.kind, meta.windowDurationMins),
        providerIds: [providerId],
        usedPercent: used,
        ...(resetsAt ? { resetsAt } : {}),
        ...(meta.windowDurationMins !== undefined
          ? { windowDurationMins: meta.windowDurationMins }
          : {}),
      });
    }

    if (windows.length === 0) continue;

    const ordinal = countByProvider.get(providerId) ?? 0;
    countByProvider.set(providerId, ordinal + 1);
    const checkedAt =
      normalizeIsoTimestamp(card.readAt) ?? normalizeIsoTimestamp(card.asOf) ?? fallbackCheckedAt;
    const plan = formatMagpiePlan(providerId, card.plan);
    const email = card.user?.trim().includes("@") ? card.user.trim() : undefined;

    accounts.push({
      id: `${providerId}:${ordinal}`,
      driver: mapMagpieProviderToDriver(providerId),
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
      usageLimits: makeUsageLimits({ checkedAt, windows }),
    });
  }

  return accounts;
}

function resolveMagpieEndpointUrl(baseUrl: string, relativePath: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.pathname = parsed.pathname.replace(
      /(\/v1\/magpie\/quotas(?:\/refresh)?|\/v1|\/management\.html)?\/?$/i,
      "/",
    );
    parsed.search = "";
    parsed.hash = "";
    return new URL(relativePath, parsed).toString();
  } catch {
    return null;
  }
}

export function resolveMagpieQuotasUrl(baseUrl: string): string | null {
  return resolveMagpieEndpointUrl(baseUrl, "v1/magpie/quotas?kept=1");
}

export function resolveMagpieRefreshUrl(baseUrl: string): string | null {
  return resolveMagpieEndpointUrl(baseUrl, "v1/magpie/quotas/refresh");
}

function describeMagpieFailure(error: unknown): string {
  if (Cause.isTimeoutError(error)) return "Magpie did not answer in time.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `Magpie answered with HTTP ${reason.response.status}.`;
    }
  }
  return "Could not read quotas from Magpie.";
}

export const makeMagpieQuotaSource = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("MagpieQuotaSource.readAccounts")(function* (
    hub: MagpieHub,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const url = resolveMagpieQuotasUrl(hub.url);
    if (url === null) {
      return yield* new UsageLimitSourceError({ detail: "The Magpie URL is not valid." });
    }
    const authHeader = hub.managementKey.trim();
    const withHeaders = (request: HttpClientRequest.HttpClientRequest) => {
      const accepted = request.pipe(HttpClientRequest.setHeader("Accept", "application/json"));
      return authHeader.length > 0
        ? accepted.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${authHeader}`))
        : accepted;
    };

    if (hub.forceRefresh === true) {
      const refreshUrl = resolveMagpieRefreshUrl(hub.url);
      if (refreshUrl !== null) {
        // Trigger Magpie's live provider probe, then read `/v1/magpie/quotas?kept=1` so kept pool labels stay consistent.
        yield* client
          .execute(withHeaders(HttpClientRequest.post(refreshUrl)))
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.timeout(hub.timeoutMs ?? 12_000),
            Effect.ignore,
          );
      }
    }

    const request = withHeaders(HttpClientRequest.get(url));

    const raw = yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(hub.timeoutMs ?? 10_000),
      Effect.mapError(
        (error) => new UsageLimitSourceError({ detail: describeMagpieFailure(error) }),
      ),
    );
    const decoded = yield* decodeMagpieQuotasEnvelope(raw).pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "Magpie returned an unexpected quota payload." }),
      ),
    );
    const cards = extractMagpieQuotaCards(decoded);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return magpieQuotasToSourceAccounts(cards, checkedAt);
  });

  const discoverLocalSnapshots = Effect.fn("MagpieQuotaSource.discoverLocalSnapshots")(function* (
    settings: ServerSettings | null,
    explicitOrigins: ReadonlySet<string>,
    forceRefresh: boolean,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceSnapshot>> {
    const candidates = collectLocalMagpieCandidateOrigins(settings, explicitOrigins);
    const probed = yield* Effect.forEach(
      candidates,
      (origin, index) =>
        Effect.gen(function* () {
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const accounts = yield* readAccounts({
            url: origin,
            managementKey: "",
            timeoutMs: forceRefresh ? 12_000 : 2_000,
            forceRefresh,
          }).pipe(Effect.result);
          if (accounts._tag === "Failure" || accounts.success.length === 0) {
            return null;
          }
          const snapshot: UsageLimitSourceSnapshot = {
            id: UsageLimitSourceId.make(index === 0 ? "magpie-local" : `magpie-local-${index + 1}`),
            kind: "cliproxy",
            label: "Magpie",
            origin,
            endpoint: origin,
            checkedAt,
            accounts: accounts.success,
          };
          return snapshot;
        }),
      { concurrency: 2 },
    );
    return probed.filter((snapshot): snapshot is UsageLimitSourceSnapshot => snapshot !== null);
  });

  return { readAccounts, discoverLocalSnapshots };
});
