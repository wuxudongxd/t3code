// @effect-diagnostics nodeBuiltinImport:off - Integration test spins up local HTTP proxy and loopback servers.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect } from "vite-plus/test";

import {
  applyNetworkProxy,
  buildNoProxyValue,
  parseProxyUrl,
  resolveNetworkProxyConfig,
} from "./networkProxy.ts";

describe("networkProxy helpers", () => {
  it("always includes loopback hosts in NO_PROXY while preserving user entries", () => {
    expect(buildNoProxyValue({})).toBe("localhost,127.0.0.1,::1");
    expect(
      buildNoProxyValue({
        NO_PROXY: "internal.corp, LOCALHOST",
        no_proxy: ".svc.cluster.local,127.0.0.1",
      }),
    ).toBe("internal.corp,LOCALHOST,.svc.cluster.local,127.0.0.1,::1");
  });

  it("validates http and https proxy URLs", () => {
    expect(parseProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
    expect(parseProxyUrl(" https://proxy.example.com:8443 ")).toBe(
      "https://proxy.example.com:8443/",
    );
    expect(parseProxyUrl("")).toBeNull();
    expect(parseProxyUrl("   ")).toBeNull();
    expect(parseProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(parseProxyUrl("not a url")).toBeNull();
  });

  it("prefers explicit settings URL and falls back to HTTPS_PROXY / HTTP_PROXY when empty", () => {
    const fromSetting = resolveNetworkProxyConfig("http://127.0.0.1:7890", {
      HTTPS_PROXY: "http://127.0.0.1:9999",
    });
    expect(fromSetting).toEqual({
      mode: "proxy",
      source: "settings",
      httpProxy: "http://127.0.0.1:7890/",
      httpsProxy: "http://127.0.0.1:7890/",
      noProxy: "localhost,127.0.0.1,::1",
    });

    const fromEnv = resolveNetworkProxyConfig("", {
      HTTPS_PROXY: "http://127.0.0.1:8888",
    });
    expect(fromEnv).toEqual({
      mode: "proxy",
      source: "env",
      httpProxy: "http://127.0.0.1:8888/",
      httpsProxy: "http://127.0.0.1:8888/",
      noProxy: "localhost,127.0.0.1,::1",
    });

    const direct = resolveNetworkProxyConfig("", {});
    expect(direct).toEqual({ mode: "direct" });

    const invalid = resolveNetworkProxyConfig("not-a-proxy", {});
    expect(invalid).toEqual({ mode: "direct", invalidSettingUrl: "not-a-proxy" });
  });
});

describe("applyNetworkProxy routing with Effect FetchHttpClient", () => {
  const originalDispatcher = Undici.getGlobalDispatcher();
  const proxiedUrls: Array<string> = [];
  const loopbackPaths: Array<string> = [];

  const proxyServer = NodeHttp.createServer((request, response) => {
    proxiedUrls.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`via-proxy:${request.url ?? ""}`);
  });

  const loopbackServer = NodeHttp.createServer((request, response) => {
    loopbackPaths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`direct-loopback:${request.url ?? ""}`);
  });

  let proxyUrl = "";
  let loopbackPort = 0;

  beforeAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => loopbackServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const proxyPort = (proxyServer.address() as NodeNet.AddressInfo).port;
    proxyUrl = `http://127.0.0.1:${proxyPort}`;
    loopbackPort = (loopbackServer.address() as NodeNet.AddressInfo).port;
  });

  afterEach(() => {
    proxiedUrls.length = 0;
    loopbackPaths.length = 0;
    Undici.setGlobalDispatcher(originalDispatcher);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => proxyServer.close(() => resolve())),
      new Promise<void>((resolve) => loopbackServer.close(() => resolve())),
    ]);
  });

  it.effect("routes external URLs through proxy and bypasses 127.0.0.1 / localhost", () =>
    Effect.gen(function* () {
      const resolved = applyNetworkProxy(proxyUrl, {});
      expect(resolved.mode).toBe("proxy");

      const externalBody = yield* HttpClient.get("http://example.invalid/cloudcode-test").pipe(
        Effect.flatMap((response) => response.text),
      );
      expect(externalBody).toBe("via-proxy:http://example.invalid/cloudcode-test");
      expect(proxiedUrls).toEqual(["http://example.invalid/cloudcode-test"]);

      const loopbackIpBody = yield* HttpClient.get(
        `http://127.0.0.1:${loopbackPort}/magpie-health`,
      ).pipe(Effect.flatMap((response) => response.text));
      expect(loopbackIpBody).toBe("direct-loopback:/magpie-health");

      const localhostBody = yield* HttpClient.get(
        `http://localhost:${loopbackPort}/magpie-ping`,
      ).pipe(Effect.flatMap((response) => response.text));
      expect(localhostBody).toBe("direct-loopback:/magpie-ping");

      // Neither loopback call should ever touch the proxy.
      expect(proxiedUrls).toEqual(["http://example.invalid/cloudcode-test"]);
      expect(loopbackPaths).toEqual(["/magpie-health", "/magpie-ping"]);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
