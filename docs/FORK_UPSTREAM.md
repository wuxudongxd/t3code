# T3 Code 轻量 Fork 维护指南

本仓库是 [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) 的轻量级定制 Fork（主开发分支 `feat/zh-ui-polish`），旨在保留与上游几乎零冲突的 Rebase 体验，同时提供中文字体排版优化、精选主题、克制的实时上下文/额度指示，以及免费的 GitHub Actions macOS Apple Silicon (`.dmg`) 云端打包。

---

## 1. 轻量 Fork 架构（文件归属）

遵循**“新增独立文件为主、上游文件仅做最小钩子挂载”**原则，便于长期同步上游更新：

### 本 Fork 独立拥有的文件（上游几乎不会修改，冲突率极低）

- **样式与视觉**：`apps/web/src/styles/fork-polish.css` — 浅/深色自适应排版、CJK 行高节奏、输入框聚焦与侧边栏细节优化
- **遥测与额度组件**：
  - `apps/web/src/components/custom/ComposerTelemetryStrip.tsx` — 输入框底部实时上下文占用与缓存命中率状态条
  - `apps/web/src/components/custom/HeaderQuotaCapsule.tsx` — 顶部栏精简额度与重置倒计时胶囊
- **云端打包工作流**：`.github/workflows/build-macos.yml` — macOS `arm64` 免费云端 `.dmg` 构建与 Release 发布
- **维护文档**：`docs/FORK_UPSTREAM.md`（本文件）

### 上游文件的最小挂载点（Rebase 时只需留意这些极小改动）

- `apps/web/src/index.css`：仅新增 1 行 `@import "./styles/fork-polish.css";`
- `apps/web/src/appearanceFonts.ts`：在默认字体栈补充中文字体回退（`PingFang SC`、`Hiragino Sans GB`、`Noto Sans SC`、`Microsoft YaHei`）
- `packages/shared/src/themePalettes.ts`（及相关主题注册映射）：新增 `stardust`、`porcelain` 两套内置主题
- `apps/web/src/components/chat/ChatComposer.tsx`（或 `ComposerFooterControls.tsx`）与 `ChatHeader.tsx`：各仅引入并挂载对应自定义组件
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
pnpm --filter @t3tools/web typecheck
git push --force-with-lease origin feat/zh-ui-polish
```

---

## 3. 云端构建 macOS Apple Silicon (`.dmg`) 与本地安装

本仓库已配置 `.github/workflows/build-macos.yml`，运行在 GitHub Actions 公开仓库免费提供的 `macos-14`（Apple Silicon `arm64`）Runner 上，无需 Apple Developer 付费签名证书。

### 触发云端构建的三种方式

1. **手动触发**：打开 GitHub 仓库的 **Actions → Build macOS (arm64 DMG) → Run workflow**。
2. **分支推送**：向 `feat/zh-ui-polish` 或 `main` 推送提交后自动触发，产物可在该次 Workflow Run 页面底部的 **Artifacts (`t3code-macos-arm64-dmg`)** 下载（保留 30 天）。
3. **打 Tag 发布 Release**：推送 `v*` 标签会自动构建并将 `.dmg` 附件发布到 GitHub Releases：

```bash
git tag v0.1.0-zh.1
git push origin v0.1.0-zh.1
```

### 在 macOS 上安装未签名 `.dmg`

由于未经过 Apple 公证，首次打开时 macOS Gatekeeper 可能会提示“已损坏”或“无法验证开发者”。将应用拖入 `/Applications` 后，在终端执行以下命令清除隔离属性即可正常启动：

```bash
xattr -cr "/Applications/T3 Code (Beta).app"
```
