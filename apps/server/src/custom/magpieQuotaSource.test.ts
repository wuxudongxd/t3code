import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import {
  collectLocalMagpieCandidateOrigins,
  magpieQuotasToSourceAccounts,
  makeMagpieQuotaSource,
  resolveMagpieQuotasUrl,
  resolveMagpieRefreshUrl,
} from "./magpieQuotaSource.ts";

describe("magpieQuotaSource", () => {
  it("resolves quotas and refresh URLs cleanly from various base URLs", () => {
    expect(resolveMagpieQuotasUrl("http://127.0.0.1:3425")).toBe(
      "http://127.0.0.1:3425/v1/magpie/quotas?kept=1",
    );
    expect(resolveMagpieQuotasUrl("http://127.0.0.1:3425/v1")).toBe(
      "http://127.0.0.1:3425/v1/magpie/quotas?kept=1",
    );
    expect(resolveMagpieRefreshUrl("http://127.0.0.1:3425/v1/magpie/quotas")).toBe(
      "http://127.0.0.1:3425/v1/magpie/quotas/refresh",
    );
    expect(resolveMagpieQuotasUrl("ftp://127.0.0.1:3425")).toBeNull();
    expect(resolveMagpieRefreshUrl("not-a-url")).toBeNull();
  });

  it("collects loopback candidate origins and skips explicitly configured origins", () => {
    const origins = collectLocalMagpieCandidateOrigins(null, new Set());
    expect(origins).toEqual(["http://127.0.0.1:3425"]);

    const filtered = collectLocalMagpieCandidateOrigins(null, new Set(["http://127.0.0.1:3425"]));
    expect(filtered).toEqual([]);
  });

  it("maps Magpie quota cards into UsageLimitSourceAccount entries and skips empty/text spans", () => {
    const accounts = magpieQuotasToSourceAccounts(
      [
        {
          provider: "codex",
          name: "Codex",
          plan: "plus",
          user: "user@example.com",
          readAt: "2026-11-23T00:52:09.375Z",
          windows: [
            { name: "5 hours", used: 22, resetsAt: "2026-11-23T05:00:00Z" },
            { name: "7 days", remaining: 60, resetsAt: "2026-11-29T00:00:00Z" },
            { name: "Image generation", used: 0, text: true },
          ],
        },
        {
          provider: "antigravity",
          name: "Antigravity",
          plan: "Google AI Pro",
          windows: [
            { name: "Gemini 4 Argon (High)", used: 18, pool: "Gemini 4 Argon" },
            {
              name: "Gemini 4 Argon · 7 days",
              used: 41,
              pool: "Gemini 4 Argon",
              resetsAt: "2026-11-28T09:00:00Z",
            },
            { name: "Claude / GPT · 5 hours", used: 12, resetsAt: "2026-11-23T05:00:00Z" },
          ],
        },
        {
          provider: "deepseek",
          name: "DeepSeek",
          balance: "¥1.97",
          windows: [],
        },
      ],
      "2026-11-23T00:00:00.000Z",
    );

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      id: "codex:0",
      driver: "codex",
      email: "user@example.com",
      plan: "ChatGPT Plus",
    });
    expect(accounts[0]?.usageLimits.windows).toEqual([
      {
        id: "codex-5h",
        kind: "session",
        label: "5h Session",
        providerIds: ["codex"],
        usedPercent: 22,
        resetsAt: "2026-11-23T05:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "codex-weekly",
        kind: "weekly",
        label: "Weekly",
        providerIds: ["codex"],
        usedPercent: 40,
        resetsAt: "2026-11-29T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);

    expect(accounts[1]?.driver).toBe("antigravity");
    expect(accounts[1]?.usageLimits.windows.map((w) => w.id)).toEqual([
      "3p-5h",
      "gemini-argon-weekly",
    ]);
  });

  it.effect("triggers POST /v1/magpie/quotas/refresh before GET when forceRefresh is true", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string }> = [];
      const mockClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ method: request.method, url: request.url });
          if (request.method === "POST") {
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                data: [
                  {
                    provider: "codex",
                    name: "Codex",
                    plan: "pro",
                    user: "dev@example.com",
                    windows: [{ name: "30 days", used: 7, resetsAt: "2026-12-18T09:04:49Z" }],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );

      const source = yield* makeMagpieQuotaSource.pipe(
        Effect.provideService(HttpClient.HttpClient, mockClient),
      );
      const snapshots = yield* source.discoverLocalSnapshots(null, new Set(), true);

      expect(requests).toEqual([
        { method: "POST", url: "http://127.0.0.1:3425/v1/magpie/quotas/refresh" },
        { method: "GET", url: "http://127.0.0.1:3425/v1/magpie/quotas?kept=1" },
      ]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "magpie-local",
        kind: "cliproxy",
        label: "Magpie",
        origin: "http://127.0.0.1:3425",
      });
      expect(snapshots[0]?.accounts[0]?.plan).toBe("ChatGPT Pro");
    }),
  );
});
