// @effect-diagnostics nodeBuiltinImport:off - Unit test for standalone fork updater exercises filesystem persistence directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: {},
  dialog: {},
  Menu: {},
  MenuItem: vi.fn(),
  shell: {},
}));

import {
  buildMacDmgInstallScript,
  compareForkVersions,
  normalizeForkTag,
  parseForkVersion,
  parseSha256Text,
  readForkUpdaterState,
  resolveCurrentForkVersion,
  resolveMacAppBundlePath,
  selectMacDmgAsset,
  shouldOfferForkUpdate,
  writeForkUpdaterState,
  type ForkUpdaterState,
} from "./forkUpdater.ts";

describe("forkUpdater", () => {
  it("parses and compares semver and -fork.N suffix tags", () => {
    expect(parseForkVersion("v0.1.10-fork.2")).toEqual({
      major: 0,
      minor: 1,
      patch: 10,
      forkNumber: 2,
    });
    expect(parseForkVersion("0.1.10")).toEqual({
      major: 0,
      minor: 1,
      patch: 10,
      forkNumber: 0,
    });
    expect(parseForkVersion("invalid")).toBeNull();

    expect(compareForkVersions("v0.1.10-fork.1", "0.1.10")).toBe(1);
    expect(compareForkVersions("v0.1.10-fork.2", "0.1.10-fork.1")).toBe(1);
    expect(compareForkVersions("0.1.10-fork.2", "v0.1.10-fork.2")).toBe(0);
    expect(compareForkVersions("0.1.9-fork.5", "0.1.10")).toBe(-1);
    expect(compareForkVersions("v0.2.0", "0.1.10-fork.9")).toBe(1);
  });

  it("selects matching arm64 DMG and corresponding .sha256 asset", () => {
    const selected = selectMacDmgAsset(
      [
        {
          name: "T3-Code-0.1.10-fork.2-x64.dmg",
          browser_download_url: "https://example.com/x64.dmg",
        },
        {
          name: "T3-Code-0.1.10-fork.2-arm64.dmg",
          browser_download_url: "https://example.com/arm64.dmg",
        },
        {
          name: "T3-Code-0.1.10-fork.2-arm64.dmg.sha256",
          browser_download_url: "https://example.com/arm64.dmg.sha256",
        },
      ],
      "arm64",
    );

    expect(selected).toEqual({
      dmg: {
        name: "T3-Code-0.1.10-fork.2-arm64.dmg",
        browser_download_url: "https://example.com/arm64.dmg",
      },
      sha256: {
        name: "T3-Code-0.1.10-fork.2-arm64.dmg.sha256",
        browser_download_url: "https://example.com/arm64.dmg.sha256",
      },
    });
  });

  it("parses shasum -a 256 output and resolves .app bundle paths", () => {
    const hash = "a".repeat(64);
    expect(parseSha256Text(`${hash}  T3-Code-0.1.10-arm64.dmg\n`)).toBe(hash);
    expect(parseSha256Text("not a hash")).toBeNull();

    expect(
      resolveMacAppBundlePath("/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)"),
    ).toBe("/Applications/T3 Code (Beta).app");
    expect(resolveMacAppBundlePath("/usr/local/bin/electron")).toBeNull();
  });

  it("builds a safe POSIX install script using ditto, xattr -cr, and hdiutil", () => {
    const script = buildMacDmgInstallScript();
    expect(script).toContain("/usr/bin/hdiutil attach");
    expect(script).toContain("/usr/bin/ditto");
    expect(script).toContain("/usr/bin/xattr -cr");
    expect(script).toContain("/usr/bin/open");
  });

  it("normalizes fork tags and prefers embedded fork tag over appVersion", () => {
    expect(normalizeForkTag("v0.1.11-fork.2")).toBe("0.1.11-fork.2");
    expect(normalizeForkTag("  V0.1.11-FORK.2  ")).toBe("0.1.11-fork.2");
    expect(normalizeForkTag("")).toBeNull();
    expect(normalizeForkTag(null)).toBeNull();

    expect(resolveCurrentForkVersion("0.1.11", "v0.1.11-fork.2")).toBe("0.1.11-fork.2");
    expect(resolveCurrentForkVersion("0.1.11", "")).toBe("0.1.11");
    expect(resolveCurrentForkVersion("0.1.11", null)).toBe("0.1.11");
  });

  it("prevents repeat downloads for same embeddedTag, installedTag, and skippedTag", () => {
    const emptyState: ForkUpdaterState = {};

    // Regression: app.getVersion() is 0.1.11 while embedded release tag is v0.1.11-fork.2.
    expect(
      shouldOfferForkUpdate({
        appVersion: "0.1.11",
        embeddedTag: "v0.1.11-fork.2",
        latestTag: "v0.1.11-fork.2",
        state: emptyState,
      }),
    ).toEqual({
      shouldUpdate: false,
      currentDisplayVersion: "0.1.11-fork.2",
      latestDisplayVersion: "0.1.11-fork.2",
      reason: "same-embedded-tag",
    });

    // Persisted installedTag blocks re-prompting even if embeddedTag is absent.
    expect(
      shouldOfferForkUpdate({
        appVersion: "0.1.11",
        embeddedTag: null,
        latestTag: "v0.1.11-fork.2",
        state: { installedTag: "v0.1.11-fork.2" },
      }),
    ).toEqual({
      shouldUpdate: false,
      currentDisplayVersion: "0.1.11",
      latestDisplayVersion: "0.1.11-fork.2",
      reason: "already-installed-tag",
    });

    // Persisted skippedTag blocks prompting for the skipped release.
    expect(
      shouldOfferForkUpdate({
        appVersion: "0.1.11",
        embeddedTag: "v0.1.11-fork.1",
        latestTag: "v0.1.11-fork.2",
        state: { skippedTag: "v0.1.11-fork.2" },
      }),
    ).toEqual({
      shouldUpdate: false,
      currentDisplayVersion: "0.1.11-fork.1",
      latestDisplayVersion: "0.1.11-fork.2",
      reason: "skipped-tag",
    });

    // Genuine newer fork release offers an update.
    expect(
      shouldOfferForkUpdate({
        appVersion: "0.1.11",
        embeddedTag: "v0.1.11-fork.2",
        latestTag: "v0.1.11-fork.3",
        state: { installedTag: "v0.1.11-fork.2", skippedTag: "v0.1.11-fork.1" },
      }),
    ).toEqual({
      shouldUpdate: true,
      currentDisplayVersion: "0.1.11-fork.2",
      latestDisplayVersion: "0.1.11-fork.3",
      reason: "update-available",
    });
  });

  it("persists and reloads fork updater state cleanly", async () => {
    const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-updater-state-"));
    const stateFile = NodePath.join(tempDir, "nested", "fork-updater-state.json");
    try {
      expect(await readForkUpdaterState(stateFile)).toEqual({});

      await writeForkUpdaterState(stateFile, {
        installedTag: "v0.1.11-fork.2",
        skippedTag: "v0.1.11-fork.3",
        installedAt: "2026-11-22T19:30:00.000Z",
      });

      expect(await readForkUpdaterState(stateFile)).toEqual({
        installedTag: "v0.1.11-fork.2",
        skippedTag: "v0.1.11-fork.3",
        installedAt: "2026-11-22T19:30:00.000Z",
      });

      await NodeFSP.writeFile(stateFile, "{corrupt json", "utf8");
      expect(await readForkUpdaterState(stateFile)).toEqual({});
    } finally {
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  });
});
