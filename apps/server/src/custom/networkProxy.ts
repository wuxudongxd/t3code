import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Undici from "undici";

import * as ServerSettings from "../serverSettings.ts";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);

const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export type NetworkProxyEnv = Readonly<Record<string, string | undefined>>;

export type ResolvedNetworkProxyConfig =
  | {
      readonly mode: "proxy";
      readonly source: "settings" | "env";
      readonly httpProxy: string | undefined;
      readonly httpsProxy: string | undefined;
      readonly noProxy: string;
      readonly invalidSettingUrl?: string;
    }
  | {
      readonly mode: "direct";
      readonly invalidSettingUrl?: string;
    };

/** Always ensures localhost, 127.0.0.1, and ::1 bypass the proxy while preserving user NO_PROXY entries. */
export function buildNoProxyValue(env: NetworkProxyEnv): string {
  const rawEntries = [
    ...(env.NO_PROXY ?? "").split(","),
    ...(env.no_proxy ?? "").split(","),
    ...LOOPBACK_NO_PROXY_HOSTS,
  ];
  const seen = new Set<string>();
  const result: Array<string> = [];
  for (const entry of rawEntries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.join(",");
}

/** Validates and normalizes an HTTP/HTTPS proxy URL. Returns null for empty or invalid values. */
export function parseProxyUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveNetworkProxyConfig(
  networkProxyUrl: string,
  env: NetworkProxyEnv = process.env,
): ResolvedNetworkProxyConfig {
  const trimmedSetting = networkProxyUrl.trim();
  const noProxy = buildNoProxyValue(env);

  if (trimmedSetting.length > 0) {
    const parsedSetting = parseProxyUrl(trimmedSetting);
    if (parsedSetting !== null) {
      return {
        mode: "proxy",
        source: "settings",
        httpProxy: parsedSetting,
        httpsProxy: parsedSetting,
        noProxy,
      };
    }
    // Invalid setting value: fall back to environment proxy if present, otherwise direct.
    const envFallback = resolveEnvProxy(env, noProxy);
    return {
      ...envFallback,
      invalidSettingUrl: trimmedSetting,
    };
  }

  return resolveEnvProxy(env, noProxy);
}

function resolveEnvProxy(env: NetworkProxyEnv, noProxy: string): ResolvedNetworkProxyConfig {
  const httpsProxy =
    parseProxyUrl(env.HTTPS_PROXY) ??
    parseProxyUrl(env.https_proxy) ??
    parseProxyUrl(env.HTTP_PROXY) ??
    parseProxyUrl(env.http_proxy);
  const httpProxy =
    parseProxyUrl(env.HTTP_PROXY) ??
    parseProxyUrl(env.http_proxy) ??
    parseProxyUrl(env.HTTPS_PROXY) ??
    parseProxyUrl(env.https_proxy);

  if (httpProxy !== null || httpsProxy !== null) {
    return {
      mode: "proxy",
      source: "env",
      httpProxy: httpProxy ?? undefined,
      httpsProxy: httpsProxy ?? undefined,
      noProxy,
    };
  }

  return { mode: "direct" };
}

let activeManagedDispatcher: Undici.Dispatcher | null = null;

/**
 * Installs a global undici dispatcher (used by Node's built-in `fetch` and Effect's `FetchHttpClient`)
 * configured with the resolved proxy and mandatory loopback bypass, while keeping HTTP/1.1 (`allowH2: false`)
 * to match `keepOutboundFetchOnHttp1`.
 */
export function applyNetworkProxy(
  networkProxyUrl: string,
  env: NetworkProxyEnv = process.env,
): ResolvedNetworkProxyConfig {
  const undici = requireUndici("undici") as typeof Undici;
  const resolved = resolveNetworkProxyConfig(networkProxyUrl, env);

  const nextDispatcher: Undici.Dispatcher =
    resolved.mode === "proxy"
      ? new undici.EnvHttpProxyAgent({
          ...(resolved.httpProxy !== undefined ? { httpProxy: resolved.httpProxy } : {}),
          ...(resolved.httpsProxy !== undefined ? { httpsProxy: resolved.httpsProxy } : {}),
          noProxy: resolved.noProxy,
          allowH2: false,
          // ProxyAgent's connector forces h2 and ignores allowH2; replace it for HTTPS proxies.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false });

  const previous = activeManagedDispatcher;
  activeManagedDispatcher = nextDispatcher;
  undici.setGlobalDispatcher(nextDispatcher);

  if (previous !== null && previous !== nextDispatcher) {
    void previous.close().catch(() => {});
  }

  return resolved;
}

const applyAndLog = Effect.fn("NetworkProxy.applyAndLog")(function* (networkProxyUrl: string) {
  const resolved = yield* Effect.sync(() => applyNetworkProxy(networkProxyUrl));
  if (resolved.invalidSettingUrl !== undefined) {
    yield* Effect.logWarning(
      "Ignoring invalid networkProxyUrl setting (expected http:// or https:// URL)",
      { networkProxyUrl: resolved.invalidSettingUrl },
    );
  }
  if (resolved.mode === "proxy") {
    yield* Effect.logInfo("Outbound network proxy active", {
      source: resolved.source,
      httpProxy: resolved.httpProxy ?? null,
      httpsProxy: resolved.httpsProxy ?? null,
      noProxy: resolved.noProxy,
    });
  } else {
    yield* Effect.logDebug("Outbound network proxy disabled (direct connection)");
  }
});

/**
 * Applies `networkProxyUrl` on server startup and updates the global undici dispatcher
 * immediately whenever `ServerSettingsService` changes.
 */
export const layer: Layer.Layer<never, never, ServerSettings.ServerSettingsService> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* serverSettings.subscribeChanges;
      const initial = yield* serverSettings.getSettings.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to read initial server settings for network proxy", {
            cause: error,
          }).pipe(Effect.as({ networkProxyUrl: "" })),
        ),
      );
      let lastAppliedUrl = initial.networkProxyUrl;
      yield* applyAndLog(lastAppliedUrl);

      yield* changes.pipe(
        Stream.runForEach((next) => {
          if (next.networkProxyUrl === lastAppliedUrl) {
            return Effect.void;
          }
          lastAppliedUrl = next.networkProxyUrl;
          return applyAndLog(lastAppliedUrl);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Network proxy settings watcher stopped", { cause }),
        ),
        Effect.forkScoped,
      );
    }),
  );
