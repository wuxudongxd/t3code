import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { useGT, useMessages } from "gt-react";
import {
  ChevronRightIcon,
  Code2Icon,
  FileCode2Icon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  LayersIcon,
  ListChecksIcon,
  Loader2Icon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { useAssetUrlRefresh } from "../../assets/assetUrls";
import { useLongLivedAssetUrl } from "../../assets/longLivedAssetUrls";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadVisibleTurnItems } from "../../state/entities";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { HtmlRenderDialog } from "../chat/HtmlRenderDialog";
import { ProposedPlanCard } from "../chat/ProposedPlanCard";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  countArtifactsByKind,
  extractThreadArtifacts,
  type FileThreadArtifact,
  type HtmlThreadArtifact,
  type ImageThreadArtifact,
  type PlanThreadArtifact,
  type ThreadArtifact,
  type ThreadArtifactKind,
} from "./extractThreadArtifacts";

type FilterKind = "all" | ThreadArtifactKind;

const HTML_BADGE_LABEL = "HTML";

function isMarkdownOrDocExtension(ext: string | null): boolean {
  if (!ext) return false;
  return ext === "md" || ext === "mdx" || ext === "txt" || ext === "pdf" || ext === "rst";
}

function planSnippet(markdown: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return lines.slice(0, 2).join(" ");
}

export interface ArtifactsWallTriggerProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot?: string | null | undefined;
  readonly className?: string;
}

/**
 * Compact header capsule + on-demand right-side Artifacts Wall sheet.
 * Keeps zero heavy DOM mounted when closed.
 */
export const ArtifactsWallTrigger = memo(function ArtifactsWallTrigger({
  environmentId,
  threadRef,
  workspaceRoot,
  className,
}: ArtifactsWallTriggerProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);

  const quietThread = useQuietThreadProjection(threadRef);
  const visibleTurnItems = useQuietThreadVisibleTurnItems(threadRef);
  const plans = quietThread?.projection?.plans;

  const artifacts =
    threadRef === null
      ? []
      : extractThreadArtifacts({
          visibleTurnItems,
          plans,
          workspaceRoot,
        });

  if (threadRef === null) {
    return null;
  }

  const label = gt("Files");

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-custom-artifacts-wall-trigger="true"
              aria-label={label}
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-2xs font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:border-border hover:bg-muted/75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
                open && "border-border bg-muted text-foreground",
                className,
              )}
            />
          }
        >
          <LayersIcon aria-hidden="true" className="size-3 shrink-0 opacity-80" />
          <span className="hidden sm:inline">{label}</span>
          {artifacts.length > 0 ? (
            <span className="rounded-full bg-foreground/10 px-1.5 py-px text-3xs leading-3.5 font-semibold text-foreground/85">
              {artifacts.length}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom" sideOffset={8}>
          <span>{label}</span>
        </TooltipPopup>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup
          side="right"
          showCloseButton={false}
          className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{label}</SheetTitle>
          </SheetHeader>
          {open ? (
            <ArtifactsWallPanel
              environmentId={environmentId}
              threadRef={threadRef}
              workspaceRoot={workspaceRoot ?? undefined}
              artifacts={artifacts}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </SheetPopup>
      </Sheet>
    </>
  );
});

interface ArtifactsWallPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot?: string | undefined;
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly onClose: () => void;
}

const ArtifactsWallPanel = memo(function ArtifactsWallPanel({
  environmentId,
  threadRef,
  workspaceRoot,
  artifacts,
  onClose,
}: ArtifactsWallPanelProps) {
  const gt = useGT();
  const messages = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  const [activeFilter, setActiveFilter] = useState<FilterKind>("all");
  const [activeHtmlDialog, setActiveHtmlDialog] = useState<{
    readonly src: string;
    readonly artifact: HtmlThreadArtifact;
  } | null>(null);
  const [activePlanDialog, setActivePlanDialog] = useState<PlanThreadArtifact | null>(null);

  const counts = countArtifactsByKind(artifacts);
  const filteredArtifacts =
    activeFilter === "all"
      ? artifacts
      : artifacts.filter((artifact) => artifact.kind === activeFilter);

  const filterPills: ReadonlyArray<{
    readonly id: FilterKind;
    readonly label: string;
    readonly count: number;
  }> = [
    { id: "all", label: gt("All", { $context: "select all files" }), count: counts.all },
    { id: "html", label: HTML_BADGE_LABEL, count: counts.html },
    { id: "plan", label: gt("Plan", { $context: "badge, noun" }), count: counts.plan },
    { id: "image", label: gt("Media"), count: counts.image },
    { id: "file", label: gt("Files"), count: counts.file },
  ];

  const handleOpenFile = (artifact: FileThreadArtifact) => {
    const store = useRightPanelStore.getState();
    if (artifact.relativePath) {
      store.openFile(threadRef, artifact.relativePath);
      onClose();
      return;
    }
    if (artifact.attachment) {
      store.openAttachment(threadRef, artifact.attachment);
      onClose();
    }
  };

  return (
    <div
      data-custom-artifacts-wall-panel="true"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {/* Apple-minimal frosted header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-foreground/80">
            <LayersIcon aria-hidden="true" className="size-3.5" />
          </div>
          <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {gt("Files")}
          </h2>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-2xs font-medium tabular-nums text-muted-foreground">
            {counts.all}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Close")}
          onClick={onClose}
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {/* Segmented category filter pills */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-4 py-2.5">
        {filterPills.map((pill) => {
          const isActive = activeFilter === pill.id;
          return (
            <button
              key={pill.id}
              type="button"
              onClick={() => setActiveFilter(pill.id)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isActive
                  ? "bg-foreground text-background shadow-xs"
                  : "bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <span>{pill.label}</span>
              {pill.count > 0 ? (
                <span
                  className={cn(
                    "text-3xs tabular-nums",
                    isActive ? "text-background/80" : "text-muted-foreground/75",
                  )}
                >
                  {pill.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Main scrollable gallery/list */}
      <ScrollArea className="min-h-0 flex-1">
        {filteredArtifacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/40 text-muted-foreground/80">
              <LayersIcon aria-hidden="true" className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {counts.all === 0 ? gt("Nothing detected yet") : gt("Nothing under these filters")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3.5">
            {filteredArtifacts.map((artifact) => {
              const formattedTime = artifact.createdAt
                ? formatDayAwareTimestamp(
                    artifact.createdAt,
                    timestampFormat,
                    undefined,
                    undefined,
                    messages,
                  )
                : "";
              const turnBadge = `#${artifact.turnIndex}`;

              switch (artifact.kind) {
                case "html":
                  return (
                    <HtmlArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      environmentId={environmentId}
                      turnBadge={turnBadge}
                      formattedTime={formattedTime}
                      onOpen={(src) => setActiveHtmlDialog({ src, artifact })}
                    />
                  );
                case "plan":
                  return (
                    <PlanArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      turnBadge={turnBadge}
                      formattedTime={formattedTime}
                      onOpen={() => setActivePlanDialog(artifact)}
                    />
                  );
                case "image":
                  return (
                    <ImageArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      environmentId={environmentId}
                      threadRef={threadRef}
                      turnBadge={turnBadge}
                      formattedTime={formattedTime}
                    />
                  );
                case "file":
                  return (
                    <FileArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      turnBadge={turnBadge}
                      formattedTime={formattedTime}
                      onOpen={() => handleOpenFile(artifact)}
                    />
                  );
              }
            })}
          </div>
        )}
      </ScrollArea>

      {/* Native HTML full-screen preview dialog */}
      {activeHtmlDialog !== null ? (
        <HtmlRenderDialog
          src={activeHtmlDialog.src}
          htmlRender={activeHtmlDialog.artifact.htmlRender}
          threadRef={threadRef}
          onClose={() => setActiveHtmlDialog(null)}
        />
      ) : null}

      {/* Native Plan inspector dialog reusing ProposedPlanCard */}
      <Dialog
        open={activePlanDialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setActivePlanDialog(null);
        }}
      >
        <DialogPopup className="max-w-2xl overflow-hidden">
          <DialogTitle className="sr-only">
            {activePlanDialog?.title || gt("Proposed plan")}
          </DialogTitle>
          {activePlanDialog !== null ? (
            <div className="max-h-[82vh] overflow-y-auto p-2">
              <ProposedPlanCard
                planMarkdown={activePlanDialog.planMarkdown}
                environmentId={environmentId}
                threadRef={threadRef}
                cwd={workspaceRoot}
                workspaceRoot={workspaceRoot}
              />
            </div>
          ) : null}
        </DialogPopup>
      </Dialog>
    </div>
  );
});

function HtmlArtifactRow({
  artifact,
  environmentId,
  turnBadge,
  formattedTime,
  onOpen,
}: {
  readonly artifact: HtmlThreadArtifact;
  readonly environmentId: EnvironmentId;
  readonly turnBadge: string;
  readonly formattedTime: string;
  readonly onOpen: (src: string) => void;
}) {
  const gt = useGT();
  const [loading, setLoading] = useState(false);
  const resource = {
    _tag: "attachment" as const,
    attachmentId: artifact.htmlRender.attachmentId,
    fileName: htmlRenderFileName(artifact.htmlRender.title),
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const refresh = useAssetUrlRefresh(environmentId, resource);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const url = await refresh();
      if (url) {
        onOpen(url);
      } else {
        toastManager.add({
          type: "error",
          title: gt("Page unavailable"),
          description: gt("Reconnect to the environment and try again."),
        });
      }
    } catch {
      toastManager.add({
        type: "error",
        title: gt("Page unavailable"),
        description: gt("Reconnect to the environment and try again."),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={loading}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3 text-left transition-all hover:border-border hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground/80 shadow-2xs">
        {loading ? (
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <GlobeIcon aria-hidden="true" className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {artifact.title || HTML_BADGE_LABEL}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
          <span className="rounded bg-muted px-1 py-px font-mono text-3xs text-foreground/75">
            {HTML_BADGE_LABEL}
          </span>
          <span>{turnBadge}</span>
          {formattedTime ? <span>{formattedTime}</span> : null}
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        <span>{gt("Open", { $context: "verb, opens a file" })}</span>
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </span>
    </button>
  );
}

function PlanArtifactRow({
  artifact,
  turnBadge,
  formattedTime,
  onOpen,
}: {
  readonly artifact: PlanThreadArtifact;
  readonly turnBadge: string;
  readonly formattedTime: string;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const preview = planSnippet(artifact.planMarkdown);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-2 rounded-xl border border-border/60 bg-card/60 p-3 text-left transition-all hover:border-border hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
    >
      <div className="flex w-full items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground/80 shadow-2xs">
          <ListChecksIcon aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {artifact.title || gt("Proposed plan")}
          </p>
          <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
            <span className="rounded bg-muted px-1 py-px text-3xs text-foreground/75">
              {gt("Plan", { $context: "badge, noun" })}
            </span>
            <span>{turnBadge}</span>
            {formattedTime ? <span>{formattedTime}</span> : null}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          <span>{gt("Inspect")}</span>
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </span>
      </div>
      {preview ? (
        <p className="line-clamp-2 text-2xs leading-relaxed text-muted-foreground/90">{preview}</p>
      ) : null}
    </button>
  );
}

function ImageArtifactRow({
  artifact,
  environmentId,
  threadRef,
  turnBadge,
  formattedTime,
}: {
  readonly artifact: ImageThreadArtifact;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly turnBadge: string;
  readonly formattedTime: string;
}) {
  const gt = useGT();
  const displayName = artifact.title || gt("Media");
  const resource = {
    _tag: "attachment" as const,
    attachmentId: artifact.attachment.id,
    fileName: artifact.attachment.name,
    mimeType: artifact.mimeType,
  };
  const assetUrl = useLongLivedAssetUrl(
    artifact.attachment.previewUrl ? null : environmentId,
    resource,
  );
  const resolvedSrc =
    artifact.attachment.previewUrl ?? (assetUrl._tag === "Success" ? assetUrl.url : null);

  const handleClick = () => {
    if (!resolvedSrc) {
      toastManager.add({
        type: "error",
        title: gt("Page unavailable"),
        description: gt("Reconnect to the environment and try again."),
      });
      return;
    }
    openExpandedImagePreview(scopedThreadKey(threadRef), {
      images: [
        {
          src: resolvedSrc,
          name: displayName,
          mimeType: artifact.mimeType,
          actionsSource: {
            kind: "image",
            name: displayName,
            src: resolvedSrc,
            asset: { environmentId, resource },
          },
        },
      ],
      index: 0,
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card/60 text-left transition-all hover:border-border hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
    >
      <div className="relative flex aspect-[16/9] w-full items-center justify-center overflow-hidden bg-muted/40">
        {resolvedSrc ? (
          <img
            src={resolvedSrc}
            alt={displayName}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <ImageIcon aria-hidden="true" className="size-6 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{displayName}</p>
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
            <span>{turnBadge}</span>
            {formattedTime ? <span>{formattedTime}</span> : null}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          <span>{gt("Open", { $context: "verb, opens a file" })}</span>
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </span>
      </div>
    </button>
  );
}

function FileArtifactRow({
  artifact,
  turnBadge,
  formattedTime,
  onOpen,
}: {
  readonly artifact: FileThreadArtifact;
  readonly turnBadge: string;
  readonly formattedTime: string;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const sourceBadge =
    artifact.source === "changed"
      ? gt("Changed", { $context: "file changed since viewed" })
      : artifact.source === "attachment"
        ? gt("Attachment")
        : gt("File", { $context: "label for a file opened from the workspace" });

  const FileIcon =
    artifact.source === "attachment"
      ? PaperclipIcon
      : isMarkdownOrDocExtension(artifact.extension)
        ? FileTextIcon
        : artifact.extension
          ? FileCode2Icon
          : Code2Icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 text-left transition-all hover:border-border hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground transition-colors group-hover:text-foreground">
        <FileIcon aria-hidden="true" className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{artifact.title}</span>
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-3xs",
              artifact.source === "changed"
                ? "bg-success/15 text-success-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {sourceBadge}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
          {artifact.subtitle ? (
            <span className="truncate font-mono text-3xs opacity-80">{artifact.subtitle}</span>
          ) : null}
          <span className="shrink-0">{turnBadge}</span>
          {formattedTime ? <span className="shrink-0">{formattedTime}</span> : null}
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <span>{gt("Open", { $context: "verb, opens a file" })}</span>
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </span>
    </button>
  );
}
