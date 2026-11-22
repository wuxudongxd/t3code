# T3 Code 轻量 Fork 维护指南

本仓库是 [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) 的轻量级定制 Fork（主开发分支 `feat/zh-ui-polish`），旨在保留与上游几乎零冲突的 Rebase 体验，同时提供中文字体排版优化、精选主题、实时上下文与多维额度监控、可读任务步骤胶囊、产物墙、内嵌预览标点批注、本地代理/Magpie 额度自动发现，以及免费的 GitHub Actions macOS Apple Silicon (`.dmg`) 云端打包与免证书自动更新。

---

## 1. 轻量 Fork 架构（文件归属）

遵循**“新增独立文件为主、上游文件仅做最小钩子挂载”**原则，便于长期同步上游更新：

### 本 Fork 独立拥有的文件（上游几乎不会修改，冲突率极低）

- **服务端增强（`apps/server/src/custom/`）**：
  - `apps/server/src/custom/networkProxy.ts`（+ `networkProxy.test.ts`）— 自动读取环境变量/macOS 系统代理并注入服务端网络代理，启动时打印 `NetworkProxy.applyAndLog`
  - `apps/server/src/custom/magpieQuotaSource.ts`（+ `magpieQuotaSource.test.ts`）— 本地 Magpie 额度服务自动发现与强制刷新（`forceRefresh` 支持 `/api/quotas?kept=1`）
- **桌面端自动更新（`apps/desktop/src/custom/`）**：
  - `apps/desktop/src/custom/forkUpdater.ts`（+ `forkUpdater.test.ts`）— 基于 `wuxudongxd/t3code` GitHub Releases 的免签名 macOS 自动更新器（含 `.dmg.sha256` 校验、原子替换回滚、`xattr -cr` 与菜单栏手动检查入口）
- **前端样式与视觉**：
  - `apps/web/src/styles/fork-polish.css` — 浅/深色自适应排版、CJK 行高节奏、输入框聚焦与侧边栏细节优化
- **前端定制组件（`apps/web/src/components/custom/`）**：
  - `ComposerTelemetryStrip.tsx` + `ContextBreakdownPopover.tsx` — 输入框底部实时上下文占用、缓存命中率、实时/回合 `tok/s` 速率，以及悬浮分段拆解与一键 `/compact` 压缩
  - `HeaderQuotaCapsule.tsx` + `QuotaFuelPopover.tsx` — 顶部栏精简额度胶囊、悬浮 20 格 LED 燃料矩阵、重置进度时间线与一键强制刷新
  - `StepCapsule.tsx` + `synthesizeTaskSteps.ts` — 将工具调用合成可读的阶段任务步骤胶囊（`read` / `search` / `edit` / `terminal` / `delegate` / `web`）
  - `ArtifactsWallPanel.tsx` + `extractThreadArtifacts.ts` — 会话产物墙面板，聚合展示本线程生成/修改的文件、图片与代码产物
  - `PreviewPinAnnotations.tsx` + `previewPinStore.ts` — 内嵌预览画面点击标点批注、局部截图裁切、状态筛选（全部/未解决/已解决）与一键插入输入框
- **云端打包工作流**：`.github/workflows/build-macos.yml` — macOS `arm64` 免费云端 `.dmg` + `.dmg.sha256` 构建与 Release 发布
- **维护文档**：`docs/FORK_UPSTREAM.md`（本文件）

### 上游文件的最小挂载点（Rebase 时只需留意这些极小改动）

- `apps/server/src/usage/UsageLimitSources.ts` & `apps/server/src/ws.ts`：挂载 `magpieQuotaSource` 自动发现与 `forceRefresh` 触发路径
- `apps/desktop/src/main.ts`：仅新增 3 行 `registerForkUpdater()` 启动钩子
- `apps/web/src/index.css`：仅新增 1 行 `@import "./styles/fork-polish.css";`
- `apps/web/src/appearanceFonts.ts`：在默认字体栈补充中文字体回退（`PingFang SC`、`Hiragino Sans GB`、`Noto Sans SC`、`Microsoft YaHei`）
- `packages/shared/src/themePalettes.ts`（及相关主题注册映射）：新增 `stardust`、`porcelain` 两套内置主题
- `apps/web/src/components/chat/ChatComposer.tsx`（或 `ComposerFooterControls.tsx`）、`ChatHeader.tsx`、`MessagesTimeline.tsx`、`apps/web/src/components/preview/PreviewView.tsx`：各仅引入并挂载对应自定义组件
- `apps/web/src/i18n/translations/zh.json` & `apps/desktop/src/i18n/translations/zh.json`：极少量高频中文文案微调（不增删任何 key）

---

## 2. 同步上游更新（Upstream Sync）

确认已配置 `upstream` 远程地址：

```bash
git remote -v
# 若尚未添加 upstream：
# git remote add upstream https://github.com/pingdotgg/t3code.git
```

拉取上游最新 `main` 并变基当前定制分支：

```bash
git fetch upstream
git checkout feat/zh-ui-polish
git rebase upstream/main
```

若遇到少量冲突（通常仅限于上述最小挂载点），解决后执行：

```bash
git add <已解决的文件>
git rebase --continue
```

同步完成后建议执行快速校验再强推到自己的 Fork：

```bash
pnpm install --frozen-lockfile
pnpm i18n:check
pnpm exec vp run --filter @t3tools/web typecheck
git push --force-with-lease origin feat/zh-ui-polish
```

---

## 3. 云端构建 macOS Apple Silicon (`.dmg`)

本仓库已配置 `.github/workflows/build-macos.yml`，运行在 GitHub Actions 公开仓库免费提供的 `macos-14`（Apple Silicon `arm64`）Runner 上，无需 Apple Developer 付费签名证书，且会自动生成 `.dmg` 与对应的 `.dmg.sha256` 校验文件。

### 触发云端构建的三种方式

1. **手动触发**：打开 GitHub 仓库的 **Actions → Build macOS (arm64 DMG) → Run workflow**。
2. **分支推送**：向 `feat/zh-ui-polish` 或 `main` 推送提交后自动触发，产物可在该次 Workflow Run 页面底部的 **Artifacts (`t3code-macos-arm64-dmg`)** 下载（保留 30 天）。
3. **打 Tag 发布 Release**：推送 `v*` 标签会自动构建并将 `.dmg` 与 `.dmg.sha256` 附件一并发布到 GitHub Releases：

```bash
git tag -a v0.1.11-fork.1 -m "T3 Code Fork v0.1.11-fork.1"
git push origin v0.1.11-fork.1
```

---

## 4. 在另一台 Mac 安装 / 自动更新

### 首次在另一台 Apple Silicon Mac 上安装

1. 前往本仓库的 [GitHub Releases 最新版本](https://github.com/wuxudongxd/t3code/releases/latest) 下载 `T3-Code-*.dmg`（以及可选的同名 `.dmg.sha256` 校验文件）。
2. （可选）在终端校验下载完整性：

```bash
shasum -a 256 -c T3-Code-*.dmg.sha256
```

3. 双击 `.dmg` 并将 `T3 Code (Beta).app` 拖入 `/Applications`。
4. 由于未经过 Apple 公证，首次打开时 macOS Gatekeeper 可能会提示“已损坏”或“无法验证开发者”。在终端执行以下命令清除隔离属性即可正常启动：

```bash
xattr -cr "/Applications/T3 Code (Beta).app"
```

### 后续免证书自动更新（Built-in Fork Auto-Updater）

安装完成后，后续无需再手动下载 `.dmg`：

- **自动检查**：应用启动 15 秒后及之后每 6 小时会自动查询 `wuxudongxd/t3code` 的 `releases/latest`（支持语义化版本及 `-fork.N` 后缀对比）。
- **手动检查**：点击顶部 macOS 应用菜单栏的 **`检查 Fork 更新 / Check for Fork Updates…`** 可立即检查。
- **一键更新流程**：发现新版本并点击 **“立即下载并更新”** 后，桌面端会自动下载 `.dmg` 并校验 `.dmg.sha256`，随后由独立后台脚本完成挂载、原子替换 `/Applications/T3 Code (Beta).app`（失败自动回滚）、自动执行 `xattr -cr` 清除隔离属性并重新启动应用。
