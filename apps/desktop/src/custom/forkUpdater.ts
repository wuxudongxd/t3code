// @effect-diagnostics nodeBuiltinImport:off - Standalone macOS Electron fork updater runs outside Effect services.
// @effect-diagnostics globalFetch:off - Standalone macOS Electron fork updater uses native fetch for GitHub Releases.
// @effect-diagnostics globalTimers:off - Standalone macOS Electron fork updater uses unref'd timers outside Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as Electron from "electron";

const FORK_RELEASES_API_URL = "https://api.github.com/repos/wuxudongxd/t3code/releases/latest";
const STARTUP_CHECK_DELAY_MS = 15_000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FORK_MENU_ITEM_ID = "t3code-fork-check-updates";

interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size?: number;
}

interface GitHubLatestRelease {
  readonly tag_name: string;
  readonly name?: string;
  readonly body?: string;
  readonly html_url?: string;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

interface ParsedForkVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly forkNumber: number;
}

/**
 * Parses a version or git tag such as `v0.1.10-fork.2`, `0.1.10-fork.1`, or `0.1.10`.
 * Returns `null` when the string does not start with a valid `major.minor.patch` triple.
 */
export function parseForkVersion(raw: string): ParsedForkVersion | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-fork\.(\d+))?/i.exec(cleaned);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const forkNumber = match[4] !== undefined ? Number(match[4]) : 0;
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch) ||
    !Number.isFinite(forkNumber)
  ) {
    return null;
  }
  return { major, minor, patch, forkNumber };
}

/**
 * Compares two fork versions. Returns `1` if `a > b`, `-1` if `a < b`, or `0` if equal.
 * Fork suffix ordering treats `0.1.10-fork.2 > 0.1.10-fork.1 > 0.1.10 > 0.1.9-fork.5`.
 */
export function compareForkVersions(a: string, b: string): number {
  const pa = parseForkVersion(a);
  const pb = parseForkVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.forkNumber !== pb.forkNumber) return pa.forkNumber > pb.forkNumber ? 1 : -1;
  return 0;
}

/** Selects the best matching macOS `.dmg` asset and optional `.dmg.sha256` checksum asset. */
export function selectMacDmgAsset(
  assets: ReadonlyArray<GitHubReleaseAsset>,
  arch: string,
): {
  readonly dmg: GitHubReleaseAsset;
  readonly sha256: GitHubReleaseAsset | null;
} | null {
  const dmgAssets = assets.filter((asset) => asset.name.toLowerCase().endsWith(".dmg"));
  if (dmgAssets.length === 0) return null;

  const preferredTokens = arch === "arm64" ? ["arm64", "universal"] : [arch, "universal"];
  let selected: GitHubReleaseAsset | undefined;
  for (const token of preferredTokens) {
    selected = dmgAssets.find((asset) => asset.name.toLowerCase().includes(token));
    if (selected) break;
  }
  selected ??= dmgAssets[0];
  if (!selected) return null;

  const exactShaName = `${selected.name}.sha256`.toLowerCase();
  const sha256 =
    assets.find((asset) => asset.name.toLowerCase() === exactShaName) ??
    assets.find((asset) => asset.name.toLowerCase().endsWith(".dmg.sha256")) ??
    null;

  return { dmg: selected, sha256 };
}

/** Extracts a 64-character lowercase SHA-256 hex digest from a `shasum -a 256` file. */
export function parseSha256Text(raw: string): string | null {
  const match = /\b([0-9a-f]{64})\b/i.exec(raw.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Extracts the enclosing `.app` bundle path from a macOS executable path such as
 * `/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)`.
 */
export function resolveMacAppBundlePath(execPath: string): string | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath.trim());
  return match?.[1] ?? null;
}

/**
 * POSIX `/bin/sh` helper spawned detached right before `app.quit()`.
 * Positional arguments `$1`..`$5` safely preserve spaces and parentheses in `.app` bundle names.
 */
export function buildMacDmgInstallScript(): string {
  return [
    "set -u",
    'PID="$1"',
    'TARGET_APP="$2"',
    'DMG_PATH="$3"',
    'WORK_DIR="$4"',
    'LOG_FILE="$5"',
    'MOUNT_DIR="${WORK_DIR}/mnt"',
    'TARGET_DIR="$(dirname "$TARGET_APP")"',
    'TARGET_NAME="$(basename "$TARGET_APP")"',
    'STAGED_APP="${TARGET_DIR}/.${TARGET_NAME}.t3-fork-staged-${PID}"',
    'BACKUP_APP="${TARGET_APP}.t3-fork-backup-${PID}"',
    'mkdir -p "$(dirname "$LOG_FILE")" "$MOUNT_DIR"',
    'exec >>"$LOG_FILE" 2>&1',
    'echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting fork DMG install pid=${PID} target=${TARGET_APP}"',
    "WAITED=0",
    'while kill -0 "$PID" 2>/dev/null; do',
    '  if [ "$WAITED" -ge 150 ]; then',
    '    echo "Timed out waiting for app pid ${PID} to exit."',
    "    exit 1",
    "  fi",
    "  sleep 0.2",
    "  WAITED=$((WAITED + 1))",
    "done",
    "cleanup() {",
    '  /usr/bin/hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true',
    '  rm -rf "$STAGED_APP" "$WORK_DIR" >/dev/null 2>&1 || true',
    "}",
    "trap cleanup EXIT",
    'if ! /usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH"; then',
    '  echo "Failed to mount DMG: ${DMG_PATH}"',
    "  exit 1",
    "fi",
    'SOURCE_APP=""',
    'if [ -d "${MOUNT_DIR}/${TARGET_NAME}" ]; then',
    '  SOURCE_APP="${MOUNT_DIR}/${TARGET_NAME}"',
    "else",
    '  for candidate in "$MOUNT_DIR"/*.app; do',
    '    if [ -d "$candidate" ]; then',
    '      SOURCE_APP="$candidate"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [ -z "$SOURCE_APP" ]; then',
    '  echo "No .app bundle found inside mounted DMG."',
    "  exit 1",
    "fi",
    'rm -rf "$STAGED_APP"',
    'if ! /usr/bin/ditto "$SOURCE_APP" "$STAGED_APP"; then',
    '  echo "ditto copy failed from ${SOURCE_APP} to ${STAGED_APP}"',
    "  exit 1",
    "fi",
    '/usr/bin/hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true',
    'rm -rf "$BACKUP_APP"',
    'if [ -e "$TARGET_APP" ]; then',
    '  if ! mv "$TARGET_APP" "$BACKUP_APP"; then',
    '    echo "Failed to move existing app to backup."',
    "    exit 1",
    "  fi",
    "fi",
    'if ! mv "$STAGED_APP" "$TARGET_APP"; then',
    '  echo "Failed to swap staged app into place; restoring backup."',
    '  if [ -e "$BACKUP_APP" ]; then mv "$BACKUP_APP" "$TARGET_APP" || true; fi',
    "  exit 1",
    "fi",
    'rm -rf "$BACKUP_APP"',
    '/usr/bin/xattr -cr "$TARGET_APP" >/dev/null 2>&1 || true',
    '/usr/bin/touch "$TARGET_APP" >/dev/null 2>&1 || true',
    '/usr/bin/open "$TARGET_APP"',
    'echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Fork update completed and relaunched."',
  ].join("\n");
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const stream = NodeFS.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex").toLowerCase();
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "t3code-fork-updater" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  const readable = NodeStream.Readable.fromWeb(
    response.body as unknown as Parameters<typeof NodeStream.Readable.fromWeb>[0],
  );
  await NodeStreamPromises.pipeline(readable, NodeFS.createWriteStream(destinationPath));
}

async function fetchLatestRelease(): Promise<GitHubLatestRelease> {
  const response = await fetch(FORK_RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-fork-updater",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned HTTP ${response.status}`);
  }
  const json = (await response.json()) as Partial<GitHubLatestRelease>;
  if (typeof json.tag_name !== "string" || !Array.isArray(json.assets)) {
    throw new Error("GitHub Releases API returned an unexpected payload.");
  }
  return {
    tag_name: json.tag_name,
    ...(typeof json.name === "string" ? { name: json.name } : {}),
    ...(typeof json.body === "string" ? { body: json.body } : {}),
    ...(typeof json.html_url === "string" ? { html_url: json.html_url } : {}),
    assets: json.assets,
  };
}

let activeCheckPromise: Promise<void> | null = null;
let lastPromptedTag: string | null = null;

async function downloadAndInstallDmg(
  dmgAsset: GitHubReleaseAsset,
  sha256Asset: GitHubReleaseAsset | null,
): Promise<void> {
  const targetAppPath = resolveMacAppBundlePath(process.execPath);
  if (!targetAppPath) {
    await Electron.dialog
      .showMessageBox({
        type: "info",
        title: "无法自动替换应用",
        message: "当前未从 .app 包启动，无法执行自动替换。",
        detail: `请手动下载安装包：${dmgAsset.browser_download_url}`,
        buttons: ["在浏览器中打开", "取消"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          void Electron.shell.openExternal(dmgAsset.browser_download_url);
        }
      });
    return;
  }

  const workDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-fork-update-"));
  const dmgPath = NodePath.join(workDir, dmgAsset.name);
  try {
    await downloadFile(dmgAsset.browser_download_url, dmgPath);

    if (sha256Asset) {
      const shaResponse = await fetch(sha256Asset.browser_download_url, {
        redirect: "follow",
        headers: { "User-Agent": "t3code-fork-updater" },
      });
      if (shaResponse.ok) {
        const expected = parseSha256Text(await shaResponse.text());
        if (expected) {
          const actual = await computeFileSha256(dmgPath);
          if (actual !== expected) {
            throw new Error(
              `SHA-256 校验失败（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
            );
          }
        }
      }
    }

    const logFilePath = NodePath.join(
      NodeOS.homedir(),
      "Library",
      "Logs",
      "t3code-fork-updater.log",
    );
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      [
        "-c",
        buildMacDmgInstallScript(),
        "t3code-fork-updater",
        String(process.pid),
        targetAppPath,
        dmgPath,
        workDir,
        logFilePath,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    Electron.app.quit();
  } catch (error) {
    await NodeFSP.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function checkForForkUpdates(interactive: boolean): Promise<void> {
  if (activeCheckPromise) return activeCheckPromise;
  activeCheckPromise = (async () => {
    try {
      const currentVersion = Electron.app.getVersion();
      const release = await fetchLatestRelease();
      const latestVersion = release.tag_name.replace(/^v/i, "");

      if (compareForkVersions(latestVersion, currentVersion) <= 0) {
        if (interactive) {
          await Electron.dialog.showMessageBox({
            type: "info",
            title: "已是最新版本",
            message: `当前版本 ${currentVersion} 已是最新 Fork 版本。`,
            buttons: ["确定"],
          });
        }
        return;
      }

      const arch =
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Electron updater outside Effect services.
        Electron.app.runningUnderARM64Translation === true ? "arm64" : NodeOS.arch();
      const selected = selectMacDmgAsset(release.assets, arch);
      if (!selected) {
        if (interactive) {
          await Electron.dialog
            .showMessageBox({
              type: "info",
              title: "发现新版本",
              message: `发现新版本 ${latestVersion}，但未找到对应的 macOS DMG 安装包。`,
              buttons: ["查看 Release 页面", "关闭"],
              defaultId: 0,
              cancelId: 1,
            })
            .then(({ response }) => {
              if (response === 0 && release.html_url) {
                void Electron.shell.openExternal(release.html_url);
              }
            });
        }
        return;
      }

      if (!interactive && lastPromptedTag === release.tag_name) {
        return;
      }
      lastPromptedTag = release.tag_name;

      const notesPreview = release.body?.trim()
        ? release.body.trim().slice(0, 800)
        : "包含最新功能与修复。";

      const { response } = await Electron.dialog.showMessageBox({
        type: "info",
        title: "发现 Fork 新版本",
        message: `T3 Code ${latestVersion} 已发布（当前版本 ${currentVersion}）`,
        detail: `${notesPreview}\n\n点击「立即下载并更新」将自动下载 DMG、校验并替换当前应用后重启。`,
        buttons: ["立即下载并更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        try {
          await downloadAndInstallDmg(selected.dmg, selected.sha256);
        } catch (installError) {
          await Electron.dialog
            .showMessageBox({
              type: "error",
              title: "自动更新失败",
              message: "下载或安装更新时出错。",
              detail: installError instanceof Error ? installError.message : String(installError),
              buttons: ["打开 Release 页面", "关闭"],
              defaultId: 0,
              cancelId: 1,
            })
            .then(({ response: errBtn }) => {
              if (errBtn === 0 && release.html_url) {
                void Electron.shell.openExternal(release.html_url);
              }
            });
        }
      }
    } catch (error) {
      if (interactive) {
        await Electron.dialog.showMessageBox({
          type: "warning",
          title: "检查 Fork 更新失败",
          message: "无法连接到 GitHub Releases。",
          detail: error instanceof Error ? error.message : String(error),
          buttons: ["确定"],
        });
      }
    } finally {
      activeCheckPromise = null;
    }
  })();
  return activeCheckPromise;
}

function injectForkUpdaterMenuItem(menu: Electron.Menu | null): void {
  if (!menu) return;
  const appSubmenu = menu.items[0]?.submenu;
  if (!appSubmenu) return;
  if (appSubmenu.items.some((item) => item.id === FORK_MENU_ITEM_ID)) return;

  const insertIndex = Math.min(2, appSubmenu.items.length);
  appSubmenu.insert(
    insertIndex,
    new Electron.MenuItem({
      id: FORK_MENU_ITEM_ID,
      label: "检查 Fork 更新 / Check for Fork Updates…",
      click: () => {
        void checkForForkUpdates(true);
      },
    }),
  );
}

let registered = false;

/**
 * Registers the certificate-free macOS GitHub Release auto-updater (`wuxudongxd/t3code`).
 * Safe to call once at startup in `apps/desktop/src/main.ts`; no-op on non-macOS platforms.
 */
export function registerForkUpdater(): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Electron updater outside Effect services.
  if (registered || NodeOS.platform() !== "darwin") return;
  registered = true;

  try {
    const originalSetApplicationMenu = Electron.Menu.setApplicationMenu.bind(Electron.Menu);
    Electron.Menu.setApplicationMenu = (menu: Electron.Menu | null) => {
      injectForkUpdaterMenuItem(menu);
      originalSetApplicationMenu(menu);
    };
  } catch {
    // Non-fatal if Electron.Menu.setApplicationMenu is non-writable in a future Electron version.
  }

  void Electron.app.whenReady().then(() => {
    const existingMenu = Electron.Menu.getApplicationMenu();
    if (existingMenu) {
      injectForkUpdaterMenuItem(existingMenu);
      Electron.Menu.setApplicationMenu(existingMenu);
    }

    if (!Electron.app.isPackaged) return;

    const startupTimer = setTimeout(() => {
      void checkForForkUpdates(false);
    }, STARTUP_CHECK_DELAY_MS);
    startupTimer.unref();

    const periodicTimer = setInterval(() => {
      void checkForForkUpdates(false);
    }, PERIODIC_CHECK_INTERVAL_MS);
    periodicTimer.unref();
  });
}
