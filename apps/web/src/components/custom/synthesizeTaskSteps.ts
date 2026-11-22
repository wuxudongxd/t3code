import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { classifyToolActivity, collectToolFilePaths } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import {
  workEntryDisplayIndicatesToolFailure,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import type { TimelineLatestRun } from "../chat/MessagesTimeline.logic";

export type TaskStepCategory =
  | "read"
  | "search"
  | "edit"
  | "terminal"
  | "delegate"
  | "web"
  | "other";

export type TaskStepStatus = "running" | "done" | "error";

export interface SynthesizedTaskStep {
  readonly id: string;
  readonly category: TaskStepCategory;
  readonly status: TaskStepStatus;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly durationMs: number | null;
  readonly touchedFiles: ReadonlyArray<string>;
  readonly outputCount: number;
}

interface SynthesizedTaskStepsSummary {
  readonly steps: ReadonlyArray<SynthesizedTaskStep>;
  readonly totalCount: number;
  readonly doneCount: number;
  readonly runningCount: number;
  readonly errorCount: number;
  readonly activeStep: SynthesizedTaskStep | null;
  readonly touchedFileCount: number;
  readonly outputCount: number;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly elapsedMs: number | null;
  readonly isRunning: boolean;
}

interface SynthesizeTaskStepsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly activeTurnStartedAt?: string | null | undefined;
  readonly latestRun?: TimelineLatestRun | null | undefined;
  readonly runningRunId?: RunId | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
  readonly nowMs?: number | undefined;
}

const SKIPPED_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "checkpoint",
  "notification",
  "system_notice",
  "compaction",
  "handoff",
  "fork",
  "thread_created",
  "run_interrupt_request",
  "run_interrupt_result",
  "approval_request",
  "user_input_request",
  "secret_request",
  "link_request",
  "error",
]);

function parseEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (DateTime.isDateTime(value)) {
    const ms = DateTime.toEpochMillis(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function truncateText(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeRelativePath(rawPath: string, workspaceRoot?: string | null): string | null {
  let candidate = rawPath.trim().replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return null;
  }
  candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/u, "").replace(/:\d+(?::\d+)?$/u, "");

  if (workspaceRoot) {
    const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (candidate === normalizedRoot) {
      return null;
    }
    if (candidate.startsWith(`${normalizedRoot}/`)) {
      candidate = candidate.slice(normalizedRoot.length + 1);
    }
  }

  candidate = candidate.replace(/^\.\//u, "").replace(/^\/+/u, "");
  if (!candidate || candidate.startsWith("..") || candidate.includes("/../")) {
    return null;
  }
  return candidate;
}

function fileBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function summarizeFileList(files: ReadonlyArray<string>): string | null {
  const first = files[0];
  if (!first) return null;
  const base = fileBasename(first);
  return files.length > 1 ? `${base} +${files.length - 1}` : base;
}

function summarizeCommand(rawCommand: string): string {
  const firstLine = rawCommand.split(/\r?\n/u)[0]?.trim() ?? "";
  // Strip common leading `cd <dir> && ` boilerplate to surface the real command.
  const stripped = firstLine.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/u, "");
  return truncateText(stripped || firstLine, 42);
}

function classifyByToolName(name: string | null | undefined): TaskStepCategory | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (
    lower.includes("read_file") ||
    lower.includes("view_file") ||
    lower.includes("list_dir") ||
    lower.includes("read") ||
    lower === "cat" ||
    lower === "ls"
  ) {
    return "read";
  }
  if (
    lower.includes("search") ||
    lower.includes("grep") ||
    lower.includes("ripgrep") ||
    lower.includes("find") ||
    lower.includes("glob")
  ) {
    return lower.includes("web") ? "web" : "search";
  }
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("patch") ||
    lower.includes("replace") ||
    lower.includes("create_file") ||
    lower.includes("delete_file")
  ) {
    return "edit";
  }
  if (
    lower.includes("command") ||
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower.includes("terminal") ||
    lower.includes("exec")
  ) {
    return "terminal";
  }
  if (
    lower.includes("web") ||
    lower.includes("fetch") ||
    lower.includes("browse") ||
    lower.includes("http") ||
    lower.includes("url")
  ) {
    return "web";
  }
  if (
    lower.includes("subagent") ||
    lower.includes("delegate") ||
    lower.includes("spawn") ||
    lower.includes("agent") ||
    lower.includes("swarm")
  ) {
    return "delegate";
  }
  return null;
}

function resolveStatusFromTurnItem(
  item: OrchestrationV2TurnItem,
  workEntry?: WorkLogEntry,
): TaskStepStatus {
  if (item.status === "running" || item.status === "pending" || item.status === "waiting") {
    return "running";
  }
  if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") {
    return "error";
  }
  if (
    item.type === "command_execution" &&
    (item.outputIndicatesFailure === true || (item.exitCode !== undefined && item.exitCode !== 0))
  ) {
    return "error";
  }
  if (workEntry && workEntryDisplayIndicatesToolFailure(workEntry)) {
    return "error";
  }
  return "done";
}

function resolveStatusFromWorkEntry(workEntry: WorkLogEntry): TaskStepStatus {
  if (workEntry.toolLifecycleStatus === "inProgress") {
    return "running";
  }
  if (
    workEntry.toolLifecycleStatus === "failed" ||
    workEntry.toolLifecycleStatus === "declined" ||
    workEntry.toolLifecycleStatus === "stopped" ||
    workEntry.tone === "error" ||
    workEntryDisplayIndicatesToolFailure(workEntry)
  ) {
    return "error";
  }
  return "done";
}

function collectNormalizedFiles(
  paths: ReadonlyArray<string>,
  workspaceRoot?: string | null,
): string[] {
  const unique = new Set<string>();
  for (const rawPath of paths) {
    const normalized = normalizeRelativePath(rawPath, workspaceRoot);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function stepFromTurnItem(
  id: string,
  item: OrchestrationV2TurnItem,
  fallbackCreatedAt: string,
  nowMs: number,
  workspaceRoot?: string | null,
  workEntry?: WorkLogEntry,
): SynthesizedTaskStep | null {
  if (SKIPPED_TURN_ITEM_TYPES.has(item.type)) {
    return null;
  }

  const startedAtMs = parseEpochMs(item.startedAt) ?? parseEpochMs(fallbackCreatedAt);
  const status = resolveStatusFromTurnItem(item, workEntry);
  const completedAtMs =
    status === "running" ? null : (parseEpochMs(item.completedAt) ?? parseEpochMs(item.updatedAt));
  const durationMs =
    startedAtMs !== null
      ? status === "running"
        ? Math.max(0, nowMs - startedAtMs)
        : completedAtMs !== null
          ? Math.max(0, completedAtMs - startedAtMs)
          : null
      : null;

  switch (item.type) {
    case "file_change": {
      const rawPaths = [
        item.fileName,
        ...(item.changes?.map((change) => change.path) ?? []),
        ...(workEntry?.changedFiles ?? []),
      ];
      const touchedFiles = collectNormalizedFiles(rawPaths, workspaceRoot);
      const title =
        summarizeFileList(touchedFiles) ??
        truncateText(item.title ?? fileBasename(item.fileName), 40);
      return {
        id,
        category: "edit",
        status,
        title,
        detail: touchedFiles[0],
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles,
        outputCount: Math.max(1, touchedFiles.length),
      };
    }

    case "command_execution": {
      const commandText = item.input || workEntry?.command || workEntry?.rawCommand || "";
      const title = commandText
        ? summarizeCommand(commandText)
        : truncateText(item.title ?? workEntry?.label ?? "command", 40);
      const hasOutput = Boolean(item.output?.trim()) || item.outputOmitted === true;
      return {
        id,
        category: "terminal",
        status,
        title,
        detail: commandText ? truncateText(commandText, 120) : undefined,
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles: [],
        outputCount: hasOutput ? 1 : 0,
      };
    }

    case "file_search": {
      const resultFiles = item.results?.map((result) => result.fileName) ?? [];
      const touchedFiles = collectNormalizedFiles(resultFiles, workspaceRoot);
      const title = truncateText(item.pattern ?? item.title ?? workEntry?.label ?? "search", 38);
      return {
        id,
        category: "search",
        status,
        title,
        detail: item.pattern ? truncateText(item.pattern, 100) : undefined,
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles,
        outputCount: item.results?.length ?? 0,
      };
    }

    case "web_search": {
      const query = item.patterns?.[0] ?? item.title ?? workEntry?.label ?? "web";
      return {
        id,
        category: "web",
        status,
        title: truncateText(query, 40),
        detail: item.patterns?.join(" · "),
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles: [],
        outputCount: item.results?.length ?? 0,
      };
    }

    case "subagent": {
      const rawLabel = item.title?.trim() || item.prompt.trim() || workEntry?.label || "subagent";
      return {
        id,
        category: "delegate",
        status,
        title: truncateText(rawLabel, 40),
        detail: item.progress ? truncateText(item.progress, 100) : undefined,
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles: [],
        outputCount: item.result ? 1 : 0,
      };
    }

    case "dynamic_tool": {
      const classified = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: item.toolName ?? undefined, input: item.input },
      });
      let category: TaskStepCategory = "other";
      if (classified === "read") category = "read";
      else if (classified === "search") category = "search";
      else if (classified === "file_change") category = "edit";
      else if (classified === "command") category = "terminal";
      else {
        category =
          classifyByToolName(item.toolName ?? item.title ?? workEntry?.toolTitle) ?? "other";
      }

      const rawPaths = [
        ...collectToolFilePaths({ input: item.input }),
        ...(item.viewedImagePath ? [item.viewedImagePath] : []),
        ...(workEntry?.changedFiles ?? []),
      ];
      const touchedFiles = collectNormalizedFiles(rawPaths, workspaceRoot);
      const fileSummary = summarizeFileList(touchedFiles);
      const fallbackTitle =
        item.title ?? workEntry?.toolTitle ?? item.toolName ?? workEntry?.label ?? "tool";
      const title =
        (category === "read" || category === "edit") && fileSummary
          ? fileSummary
          : truncateText(fallbackTitle, 40);
      const hasOutput =
        item.output !== undefined || item.outputOmitted === true || touchedFiles.length > 0;

      return {
        id,
        category,
        status,
        title,
        detail:
          touchedFiles[0] ?? (workEntry?.detail ? truncateText(workEntry.detail, 100) : undefined),
        startedAtMs,
        completedAtMs,
        durationMs,
        touchedFiles,
        outputCount: hasOutput ? Math.max(1, touchedFiles.length) : 0,
      };
    }

    default:
      return null;
  }
}

function stepFromLegacyWorkEntry(
  workEntry: WorkLogEntry,
  nowMs: number,
  workspaceRoot?: string | null,
): SynthesizedTaskStep | null {
  if (workEntry.tone === "thinking" || workEntry.itemType === "reasoning") {
    return null;
  }
  if (workEntry.itemType && SKIPPED_TURN_ITEM_TYPES.has(workEntry.itemType)) {
    return null;
  }
  if (
    workEntry.tone !== "tool" &&
    workEntry.command === undefined &&
    (workEntry.changedFiles === undefined || workEntry.changedFiles.length === 0)
  ) {
    return null;
  }

  const touchedFiles = collectNormalizedFiles(workEntry.changedFiles ?? [], workspaceRoot);
  let category: TaskStepCategory = "other";
  if (workEntry.command !== undefined || workEntry.rawCommand !== undefined) {
    category = "terminal";
  } else if (touchedFiles.length > 0) {
    category = "edit";
  } else {
    category =
      classifyByToolName(workEntry.toolTitle ?? workEntry.toolSurface ?? workEntry.label) ??
      "other";
  }

  const status = resolveStatusFromWorkEntry(workEntry);
  const startedAtMs = parseEpochMs(workEntry.createdAt);
  const durationMs =
    startedAtMs !== null && status === "running" ? Math.max(0, nowMs - startedAtMs) : null;

  const title =
    workEntry.command !== undefined
      ? summarizeCommand(workEntry.command)
      : (summarizeFileList(touchedFiles) ??
        truncateText(workEntry.toolTitle ?? workEntry.label, 40));

  return {
    id: workEntry.id,
    category,
    status,
    title,
    detail: touchedFiles[0] ?? (workEntry.detail ? truncateText(workEntry.detail, 100) : undefined),
    startedAtMs,
    completedAtMs: null,
    durationMs,
    touchedFiles,
    outputCount: Math.max(touchedFiles.length, status === "done" ? 1 : 0),
  };
}

function sliceLatestTurnEntries(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  targetRunId: RunId | null,
): ReadonlyArray<TimelineEntry> {
  if (timelineEntries.length === 0) return [];

  let lastUserIndex = -1;
  for (let i = timelineEntries.length - 1; i >= 0; i -= 1) {
    const entry = timelineEntries[i];
    if (entry?.kind === "message" && entry.message.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const afterLastUser =
    lastUserIndex >= 0 ? timelineEntries.slice(lastUserIndex + 1) : timelineEntries;

  if (targetRunId === null) {
    return afterLastUser;
  }

  // If the slice after the last user message contains entries for targetRunId, prefer those;
  // otherwise keep the whole post-user slice (handles ACP synthetic items without runId).
  const matchingRun = afterLastUser.filter((entry) => {
    const entryRunId =
      entry.kind === "work"
        ? (entry.entry.runId ?? entry.entry.projectedItem?.item.runId ?? entry.attempt?.runId)
        : entry.kind === "event"
          ? (entry.projectedItem.item.runId ?? entry.attempt?.runId)
          : entry.attempt?.runId;
    return entryRunId === targetRunId;
  });

  return matchingRun.length > 0 ? matchingRun : afterLastUser;
}

export function formatStepDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 1) {
    return "<1s";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function synthesizeTaskSteps(
  input: SynthesizeTaskStepsInput,
): SynthesizedTaskStepsSummary | null {
  const nowMs = input.nowMs ?? Date.now();
  const targetRunId = input.runningRunId ?? input.latestRun?.runId ?? null;
  const turnEntries = sliceLatestTurnEntries(input.timelineEntries, targetRunId);
  if (turnEntries.length === 0) {
    return null;
  }

  // Gracefully skip if this turn already renders a native todo_list.
  for (const entry of turnEntries) {
    if (entry.kind === "work") {
      if (
        entry.entry.itemType === "todo_list" ||
        entry.entry.projectedItem?.item.type === "todo_list"
      ) {
        return null;
      }
    } else if (entry.kind === "event" && entry.projectedItem.item.type === "todo_list") {
      return null;
    }
  }

  const steps: SynthesizedTaskStep[] = [];
  const seenIds = new Set<string>();
  const uniqueTouchedFiles = new Set<string>();
  let totalOutputCount = 0;

  for (const entry of turnEntries) {
    let step: SynthesizedTaskStep | null = null;
    if (entry.kind === "work") {
      const projected = entry.entry.projectedItem;
      step = projected
        ? stepFromTurnItem(
            entry.id,
            projected.item,
            entry.createdAt,
            nowMs,
            input.workspaceRoot,
            entry.entry,
          )
        : stepFromLegacyWorkEntry(entry.entry, nowMs, input.workspaceRoot);
    } else if (entry.kind === "event") {
      step = stepFromTurnItem(
        entry.id,
        entry.projectedItem.item,
        entry.createdAt,
        nowMs,
        input.workspaceRoot,
      );
    }

    if (!step || seenIds.has(step.id)) {
      continue;
    }
    seenIds.add(step.id);
    steps.push(step);
    for (const file of step.touchedFiles) {
      uniqueTouchedFiles.add(file);
    }
    totalOutputCount += step.outputCount;
  }

  if (steps.length === 0) {
    return null;
  }

  let doneCount = 0;
  let runningCount = 0;
  let errorCount = 0;
  let activeStep: SynthesizedTaskStep | null = null;
  let earliestStartMs: number | null = null;
  let latestEndMs: number | null = null;

  for (const step of steps) {
    if (step.status === "done") {
      doneCount += 1;
    } else if (step.status === "running") {
      runningCount += 1;
      activeStep = step;
    } else {
      errorCount += 1;
    }
    if (
      step.startedAtMs !== null &&
      (earliestStartMs === null || step.startedAtMs < earliestStartMs)
    ) {
      earliestStartMs = step.startedAtMs;
    }
    const candidateEnd = step.completedAtMs ?? step.startedAtMs;
    if (candidateEnd !== null && (latestEndMs === null || candidateEnd > latestEndMs)) {
      latestEndMs = candidateEnd;
    }
  }

  const isRunning = input.isWorking || runningCount > 0;
  const runStartedMs =
    parseEpochMs(input.activeTurnStartedAt) ?? parseEpochMs(input.latestRun?.startedAt);
  const startedAtMs =
    runStartedMs !== null && earliestStartMs !== null
      ? Math.min(runStartedMs, earliestStartMs)
      : (runStartedMs ?? earliestStartMs);

  const runCompletedMs = isRunning ? null : parseEpochMs(input.latestRun?.completedAt);
  const completedAtMs = isRunning
    ? null
    : runCompletedMs !== null && latestEndMs !== null
      ? Math.max(runCompletedMs, latestEndMs)
      : (runCompletedMs ?? latestEndMs);

  const elapsedMs =
    startedAtMs !== null
      ? isRunning
        ? Math.max(0, nowMs - startedAtMs)
        : completedAtMs !== null
          ? Math.max(0, completedAtMs - startedAtMs)
          : null
      : null;

  return {
    steps,
    totalCount: steps.length,
    doneCount,
    runningCount,
    errorCount,
    activeStep: activeStep ?? steps[steps.length - 1] ?? null,
    touchedFileCount: uniqueTouchedFiles.size,
    outputCount: totalOutputCount,
    startedAtMs,
    completedAtMs,
    elapsedMs,
    isRunning,
  };
}
