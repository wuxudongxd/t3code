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
  parseForkVersion,
  parseSha256Text,
  resolveMacAppBundlePath,
  selectMacDmgAsset,
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
});
