import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProjectedTurnItem,
  PlanId,
  RunId,
} from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { collectToolFilePaths } from "@t3tools/shared/toolActivity";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

import {
  isFileAttachment,
  isImageAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
} from "../../types";

export type ThreadArtifactKind = "html" | "plan" | "image" | "file";

export interface ThreadArtifactBase {
  readonly id: string;
  readonly kind: ThreadArtifactKind;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly createdAt: string;
  readonly turnIndex: number;
  readonly runId: RunId | null;
}

export interface HtmlThreadArtifact extends ThreadArtifactBase {
  readonly kind: "html";
  readonly htmlRender: HtmlRenderReference;
}

export interface PlanThreadArtifact extends ThreadArtifactBase {
  readonly kind: "plan";
  readonly planId: PlanId;
  readonly planMarkdown: string;
  readonly status: OrchestrationV2PlanArtifact["status"];
  readonly lineCount: number;
}

export interface ImageThreadArtifact extends ThreadArtifactBase {
  readonly kind: "image";
  readonly attachment: ChatImageAttachment;
  readonly mimeType: string;
}

export interface FileThreadArtifact extends ThreadArtifactBase {
  readonly kind: "file";
  readonly relativePath?: string | undefined;
  readonly attachment?: ChatFileAttachment | undefined;
  readonly source: "changed" | "attachment" | "referenced";
  readonly extension: string | null;
}

export type ThreadArtifact =
  | HtmlThreadArtifact
  | PlanThreadArtifact
  | ImageThreadArtifact
  | FileThreadArtifact;

export interface ThreadArtifactCounts {
  readonly all: number;
  readonly html: number;
  readonly plan: number;
  readonly image: number;
  readonly file: number;
}

export type ArtifactSourceTurnItem =
  | ThreadStructureVisibleTurnItem
  | OrchestrationV2ProjectedTurnItem;

export interface ExtractThreadArtifactsInput {
  readonly visibleTurnItems: ReadonlyArray<ArtifactSourceTurnItem>;
  readonly plans?: ReadonlyArray<OrchestrationV2PlanArtifact> | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

const MARKDOWN_INLINE_FILE_RE =
  /(?:^|[\s(])(?:\.\/)?([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]{1,10})(?=$|[\s),:;])/g;

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

function fileParentDir(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : undefined;
}

function fileExtension(name: string): string | null {
  const base = fileBasename(name);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === base.length - 1) return null;
  return base.slice(dotIndex + 1).toLowerCase();
}

function itemTimestampIso(row: ArtifactSourceTurnItem): string {
  const timestamp =
    row.item.startedAt ?? ("updatedAt" in row.item ? row.item.updatedAt : undefined);
  return timestamp ? DateTime.formatIso(timestamp) : "";
}

function extractInlineMarkdownPaths(text: string): ReadonlyArray<string> {
  if (!text) return [];
  const results: string[] = [];
  for (const match of text.matchAll(MARKDOWN_INLINE_FILE_RE)) {
    const matchedPath = match[1];
    if (matchedPath) results.push(matchedPath);
  }
  return results;
}

/**
 * Pure selector extracting deduplicated thread artifacts (HTML previews, plans,
 * images, and modified/attached/referenced files) from already-loaded turn items.
 */
export function extractThreadArtifacts(
  input: ExtractThreadArtifactsInput,
): ReadonlyArray<ThreadArtifact> {
  const planById = new Map<PlanId, OrchestrationV2PlanArtifact>();
  for (const plan of input.plans ?? []) {
    planById.set(plan.id, plan);
  }

  const htmlByAttachmentId = new Map<string, HtmlThreadArtifact>();
  const planArtifactsById = new Map<string, PlanThreadArtifact>();
  const imageByAttachmentId = new Map<string, ImageThreadArtifact>();
  const fileByKey = new Map<string, FileThreadArtifact>();

  const recordFile = (entry: {
    readonly key: string;
    readonly relativePath?: string | undefined;
    readonly attachment?: ChatFileAttachment | undefined;
    readonly title: string;
    readonly subtitle?: string | undefined;
    readonly source: FileThreadArtifact["source"];
    readonly createdAt: string;
    readonly turnIndex: number;
    readonly runId: RunId | null;
  }) => {
    const existing = fileByKey.get(entry.key);
    if (existing) {
      const rank = (source: FileThreadArtifact["source"]) =>
        source === "changed" ? 3 : source === "attachment" ? 2 : 1;
      const nextSource =
        rank(entry.source) >= rank(existing.source) ? entry.source : existing.source;
      fileByKey.set(entry.key, {
        ...existing,
        source: nextSource,
        createdAt: entry.createdAt >= existing.createdAt ? entry.createdAt : existing.createdAt,
        turnIndex: Math.max(existing.turnIndex, entry.turnIndex),
        ...(entry.attachment && !existing.attachment ? { attachment: entry.attachment } : {}),
      });
      return;
    }

    fileByKey.set(entry.key, {
      id: `file:${entry.key}`,
      kind: "file",
      title: entry.title,
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      createdAt: entry.createdAt,
      turnIndex: entry.turnIndex,
      runId: entry.runId,
      ...(entry.relativePath ? { relativePath: entry.relativePath } : {}),
      ...(entry.attachment ? { attachment: entry.attachment } : {}),
      source: entry.source,
      extension: fileExtension(entry.title),
    });
  };

  let turnIndex = 0;
  let lastRunId: RunId | null = null;

  for (const row of input.visibleTurnItems) {
    const { item } = row;
    if (item.type === "user_message") {
      turnIndex += 1;
      lastRunId = item.runId;
    } else if (item.runId !== null && item.runId !== lastRunId) {
      if (turnIndex === 0) turnIndex = 1;
      lastRunId = item.runId;
    }
    const effectiveTurnIndex = Math.max(1, turnIndex);
    const createdAt = itemTimestampIso(row);

    // 1. HTML / Interactive previews
    if (item.type === "dynamic_tool" && item.status === "completed") {
      const htmlRender = htmlRenderFromToolItem(item);
      if (htmlRender !== undefined) {
        htmlByAttachmentId.set(htmlRender.attachmentId, {
          id: `html:${htmlRender.attachmentId}`,
          kind: "html",
          title: htmlRender.title,
          createdAt,
          turnIndex: effectiveTurnIndex,
          runId: item.runId,
          htmlRender,
        });
      }

      const toolPaths = collectToolFilePaths(item.input);
      for (const rawPath of toolPaths) {
        const normalized = normalizeRelativePath(rawPath, input.workspaceRoot);
        if (!normalized) continue;
        recordFile({
          key: `path:${normalized}`,
          relativePath: normalized,
          title: fileBasename(normalized),
          subtitle: fileParentDir(normalized),
          source: "referenced",
          createdAt,
          turnIndex: effectiveTurnIndex,
          runId: item.runId,
        });
      }
      continue;
    }

    // 2. Proposed plans
    if (item.type === "proposed_plan") {
      const plan = planById.get(item.planId);
      const status: OrchestrationV2PlanArtifact["status"] =
        plan?.kind === "proposed_plan" ? plan.status : "active";
      const title = proposedPlanTitle(item.markdown) ?? "";
      const lineCount = item.markdown.split("\n").length;
      planArtifactsById.set(item.planId, {
        id: `plan:${item.planId}`,
        kind: "plan",
        title,
        createdAt,
        turnIndex: effectiveTurnIndex,
        runId: item.runId,
        planId: item.planId,
        planMarkdown: item.markdown,
        status,
        lineCount,
      });
      continue;
    }

    // 3. Images & File attachments on messages (+ assistant inline file paths)
    if (item.type === "user_message" || item.type === "assistant_message") {
      for (const attachment of item.attachments ?? []) {
        if (isImageAttachment(attachment)) {
          imageByAttachmentId.set(attachment.id, {
            id: `image:${attachment.id}`,
            kind: "image",
            title: attachment.name,
            mimeType: attachment.mimeType,
            createdAt,
            turnIndex: effectiveTurnIndex,
            runId: item.runId,
            attachment,
          });
        } else if (isFileAttachment(attachment)) {
          recordFile({
            key: `attachment:${attachment.id}`,
            attachment,
            title: attachment.name,
            subtitle: attachment.mimeType,
            source: "attachment",
            createdAt,
            turnIndex: effectiveTurnIndex,
            runId: item.runId,
          });
        }
      }

      if (item.type === "assistant_message" && "text" in item && typeof item.text === "string") {
        for (const inlinePath of extractInlineMarkdownPaths(item.text)) {
          const normalized = normalizeRelativePath(inlinePath, input.workspaceRoot);
          if (!normalized) continue;
          recordFile({
            key: `path:${normalized}`,
            relativePath: normalized,
            title: fileBasename(normalized),
            subtitle: fileParentDir(normalized),
            source: "referenced",
            createdAt,
            turnIndex: effectiveTurnIndex,
            runId: item.runId,
          });
        }
      }
      continue;
    }

    // 4. Changed files from file_change & checkpoint items
    if (item.type === "file_change") {
      const paths = item.changes?.length
        ? item.changes.map((change) => change.path)
        : [item.fileName];
      for (const rawPath of paths) {
        const normalized = normalizeRelativePath(rawPath, input.workspaceRoot);
        if (!normalized) continue;
        recordFile({
          key: `path:${normalized}`,
          relativePath: normalized,
          title: fileBasename(normalized),
          subtitle: fileParentDir(normalized),
          source: "changed",
          createdAt,
          turnIndex: effectiveTurnIndex,
          runId: item.runId,
        });
      }
      continue;
    }

    if (item.type === "checkpoint") {
      for (const file of item.files) {
        const normalized = normalizeRelativePath(file.path, input.workspaceRoot);
        if (!normalized) continue;
        recordFile({
          key: `path:${normalized}`,
          relativePath: normalized,
          title: fileBasename(normalized),
          subtitle: fileParentDir(normalized),
          source: "changed",
          createdAt,
          turnIndex: effectiveTurnIndex,
          runId: item.runId,
        });
      }
    }
  }

  const combined: ThreadArtifact[] = [
    ...htmlByAttachmentId.values(),
    ...planArtifactsById.values(),
    ...imageByAttachmentId.values(),
    ...fileByKey.values(),
  ];

  combined.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return right.createdAt.localeCompare(left.createdAt);
    }
    return right.turnIndex - left.turnIndex;
  });

  return combined;
}

export function countArtifactsByKind(
  artifacts: ReadonlyArray<ThreadArtifact>,
): ThreadArtifactCounts {
  let html = 0;
  let plan = 0;
  let image = 0;
  let file = 0;
  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "html":
        html += 1;
        break;
      case "plan":
        plan += 1;
        break;
      case "image":
        image += 1;
        break;
      case "file":
        file += 1;
        break;
    }
  }
  return {
    all: artifacts.length,
    html,
    plan,
    image,
    file,
  };
}
