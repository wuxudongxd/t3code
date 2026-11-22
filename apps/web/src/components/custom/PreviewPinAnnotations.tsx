import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  MapPin,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, memo, useEffect, useRef, useState } from "react";

import {
  type ComposerImageAttachment,
  readComposerDraftPrompt,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { dataUrlToFile } from "../../lib/imageCompression";
import { cn } from "../../lib/utils";
import { readComposerImageBytes } from "../chat/composerAttachmentFiles";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EMPTY_PREVIEW_PINS,
  makePreviewPinScopeKey,
  type PreviewPin,
  type PreviewPinFilter,
  usePreviewPinStore,
} from "./previewPinStore";

function capturePinCrop(
  canvas: HTMLCanvasElement | null,
  xPct: number,
  yPct: number,
  pinIndex: number,
): string | undefined {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return undefined;
  try {
    const cx = (xPct / 100) * canvas.width;
    const cy = (yPct / 100) * canvas.height;
    const cropW = Math.min(canvas.width, Math.max(240, Math.round(canvas.width * 0.36)));
    const cropH = Math.min(canvas.height, Math.max(180, Math.round(canvas.height * 0.36)));
    const sx = Math.max(0, Math.min(canvas.width - cropW, Math.round(cx - cropW / 2)));
    const sy = Math.max(0, Math.min(canvas.height - cropH, Math.round(cy - cropH / 2)));

    const offscreen = document.createElement("canvas");
    offscreen.width = cropW;
    offscreen.height = cropH;
    const ctx = offscreen.getContext("2d");
    if (!ctx) return undefined;

    ctx.drawImage(canvas, sx, sy, cropW, cropH, 0, 0, cropW, cropH);

    // Draw a crisp numbered marker at the exact clicked location inside the crop.
    const px = cx - sx;
    const py = cy - sy;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, 12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(245, 158, 11, 0.92)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#111827";
    ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(pinIndex), px, py + 0.5);
    ctx.restore();

    return offscreen.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

interface InsertLabels {
  readonly open: string;
  readonly resolved: string;
  readonly toastTitle: string;
}

async function insertPinsIntoComposer(
  threadRef: ScopedThreadRef,
  pins: ReadonlyArray<PreviewPin>,
  url: string,
  labels: InsertLabels,
): Promise<void> {
  if (pins.length === 0) return;

  const lines = pins.map((pin) => {
    const statusText = pin.status === "resolved" ? labels.resolved : labels.open;
    const suffix = pin.note.length > 0 ? `: ${pin.note}` : "";
    return `- #${pin.index} [${statusText}] (${pin.xPct.toFixed(1)}%, ${pin.yPct.toFixed(1)}%)${suffix}`;
  });
  const header = url.trim().length > 0 ? `[Preview Pins] ${url.trim()}` : "[Preview Pins]";
  const block = `${header}\n${lines.join("\n")}`;

  const store = useComposerDraftStore.getState();
  const existingPrompt = readComposerDraftPrompt(threadRef) ?? "";
  const nextPrompt =
    existingPrompt.trim().length > 0 ? `${existingPrompt.trimEnd()}\n\n${block}` : block;
  store.setPrompt(threadRef, nextPrompt);

  for (const pin of pins) {
    if (!pin.cropDataUrl) continue;
    try {
      const file = dataUrlToFile(pin.cropDataUrl, `preview-pin-${pin.index}.png`, "image/png");
      if (file.size <= 0) continue;
      await readComposerImageBytes(file);
      const image: ComposerImageAttachment = {
        type: "image",
        id: `preview-pin-${pin.id}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: pin.cropDataUrl,
        file,
      };
      store.addImage(threadRef, image);
    } catch {
      // Gracefully keep text coordinates + note when crop attachment fails.
    }
  }

  toastManager.add({
    type: "success",
    title: labels.toastTitle,
  });
}

interface PreviewPinToolbarButtonProps {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly disabled?: boolean;
}

export const PreviewPinToolbarButton = memo(function PreviewPinToolbarButton({
  threadRef,
  url,
  disabled = false,
}: PreviewPinToolbarButtonProps) {
  const gt = useGT();
  const threadKey = scopedThreadKey(threadRef);
  const scopeKey = makePreviewPinScopeKey(threadKey, url);

  const pinMode = usePreviewPinStore((state) => state.pinModeByThreadKey[threadKey] ?? false);
  const pins = usePreviewPinStore((state) => state.pinsByScopeKey[scopeKey] ?? EMPTY_PREVIEW_PINS);
  const togglePinMode = usePreviewPinStore((state) => state.togglePinMode);

  const openCount = pins.filter((pin) => pin.status === "open").length;
  const badgeCount = openCount > 0 ? openCount : pins.length;
  const isDisabled = disabled || url.trim().length === 0;
  const label = pinMode ? gt("Cancel annotation (Esc)") : gt("Annotate preview");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={pinMode ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => togglePinMode(threadKey)}
            disabled={isDisabled}
            aria-label={label}
            aria-pressed={pinMode ? "true" : "false"}
            type="button"
            className="relative"
            data-custom-preview-pin-toggle="true"
          />
        }
      >
        <MapPin className={cn(pinMode && "text-warning")} />
        {badgeCount > 0 ? (
          <span
            className={cn(
              "pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-3xs font-semibold leading-none tabular-nums",
              openCount > 0
                ? "bg-warning text-warning-foreground"
                : "bg-success text-success-foreground",
            )}
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
});

interface DraftPin {
  readonly xPct: number;
  readonly yPct: number;
  readonly cropDataUrl?: string;
}

interface PreviewPinOverlayLayerProps {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly disabled?: boolean;
  readonly captureCanvas?: () => HTMLCanvasElement | null;
}

export const PreviewPinOverlayLayer = memo(function PreviewPinOverlayLayer({
  threadRef,
  url,
  disabled = false,
  captureCanvas,
}: PreviewPinOverlayLayerProps) {
  const gt = useGT();
  const threadKey = scopedThreadKey(threadRef);
  const scopeKey = makePreviewPinScopeKey(threadKey, url);

  const pinMode = usePreviewPinStore((state) => state.pinModeByThreadKey[threadKey] ?? false);
  const drawerOpen = usePreviewPinStore((state) => state.drawerOpenByThreadKey[threadKey] ?? false);
  const filter = usePreviewPinStore((state) => state.filterByThreadKey[threadKey] ?? "all");
  const pins = usePreviewPinStore((state) => state.pinsByScopeKey[scopeKey] ?? EMPTY_PREVIEW_PINS);
  const activePinId = usePreviewPinStore((state) => state.activePinId);
  const hoveredPinId = usePreviewPinStore((state) => state.hoveredPinId);

  const addPin = usePreviewPinStore((state) => state.addPin);
  const updatePinNote = usePreviewPinStore((state) => state.updatePinNote);
  const togglePinStatus = usePreviewPinStore((state) => state.togglePinStatus);
  const removePin = usePreviewPinStore((state) => state.removePin);
  const clearPins = usePreviewPinStore((state) => state.clearPins);
  const setPinMode = usePreviewPinStore((state) => state.setPinMode);
  const setDrawerOpen = usePreviewPinStore((state) => state.setDrawerOpen);
  const setFilter = usePreviewPinStore((state) => state.setFilter);
  const setActivePinId = usePreviewPinStore((state) => state.setActivePinId);
  const setHoveredPinId = usePreviewPinStore((state) => state.setHoveredPinId);

  const [draftPin, setDraftPin] = useState<DraftPin | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const draftInputRef = useRef<HTMLInputElement | null>(null);

  const isActiveSurface = !disabled && url.trim().length > 0;
  const openCount = pins.filter((pin) => pin.status === "open").length;
  const resolvedCount = pins.length - openCount;
  const filteredPins = filter === "all" ? pins : pins.filter((pin) => pin.status === filter);
  const nextIndex = pins.reduce((max, pin) => Math.max(max, pin.index), 0) + 1;

  const allLabel = gt("All", { $context: "select all files" });
  const openLabel = gt("Open", { $context: "review thread state" });
  const resolvedLabel = gt("Resolved", { $context: "review thread state" });
  const addToChatLabel = gt("Add to chat");
  const commentPlaceholder = gt("Add a comment…");
  const saveLabel = gt("Save");
  const cancelLabel = gt("Cancel");
  const clearLabel = gt("Clear", { $context: "clears the selection of machines" });
  const collapseLabel = gt("Collapse", {
    $context: "button: folds a group of machines back into one card",
  });
  const deleteLabel = gt("Delete comment");
  const previewAnnotationLabel = gt("Preview annotation");
  const insertLabels: InsertLabels = {
    open: openLabel,
    resolved: resolvedLabel,
    toastTitle: addToChatLabel,
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape key exits draft popover or Pin mode
  useEffect(() => {
    if (!isActiveSurface || !pinMode) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (draftPin) {
        event.preventDefault();
        setDraftPin(null);
        setDraftNote("");
        return;
      }
      event.preventDefault();
      setPinMode(threadKey, false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draftPin, isActiveSurface, pinMode, setPinMode, threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses inline note input when a new draft pin is dropped
  useEffect(() => {
    if (!draftPin) return;
    draftInputRef.current?.focus();
  }, [draftPin]);

  if (!isActiveSurface) return null;

  const showMarkers = pinMode || drawerOpen;
  const showDrawer = pinMode || drawerOpen;
  const showFloatingChip = !showDrawer && pins.length > 0;

  if (!showMarkers && !showFloatingChip) {
    return null;
  }

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!pinMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xPct = Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 10;
    const yPct = Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 10;
    const cropDataUrl = capturePinCrop(captureCanvas?.() ?? null, xPct, yPct, nextIndex);
    setDraftPin({ xPct, yPct, ...(cropDataUrl ? { cropDataUrl } : {}) });
    setDraftNote("");
  };

  const commitDraftPin = () => {
    if (!draftPin) return;
    const created = addPin(scopeKey, {
      xPct: draftPin.xPct,
      yPct: draftPin.yPct,
      note: draftNote,
      url,
      ...(draftPin.cropDataUrl ? { cropDataUrl: draftPin.cropDataUrl } : {}),
    });
    setDraftPin(null);
    setDraftNote("");
    setDrawerOpen(threadKey, true);
    if (filter === "resolved") {
      setFilter(threadKey, "all");
    }
    queueMicrotask(() => {
      rowRefs.current.get(created.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitDraftPin();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraftPin(null);
      setDraftNote("");
    }
  };

  const handleSelectCanvasPin = (pin: PreviewPin) => {
    setActivePinId(pin.id);
    setDrawerOpen(threadKey, true);
    if (filter !== "all" && pin.status !== filter) {
      setFilter(threadKey, "all");
    }
    queueMicrotask(() => {
      rowRefs.current.get(pin.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const handleStartEdit = (pin: PreviewPin) => {
    setEditingPinId(pin.id);
    setEditingNote(pin.note);
  };

  const handleCommitEdit = (pinId: string) => {
    updatePinNote(scopeKey, pinId, editingNote);
    setEditingPinId(null);
    setEditingNote("");
  };

  const pinsToInsert =
    filteredPins.length > 0 ? filteredPins : pins.filter((pin) => pin.status === "open");

  return (
    <>
      {showMarkers ? (
        <div
          className={cn(
            "absolute inset-0 z-20 select-none",
            pinMode ? "cursor-crosshair pointer-events-auto" : "pointer-events-none",
          )}
          onClick={handleCanvasClick}
          data-custom-preview-pin-overlay="true"
        >
          {pinMode && !draftPin ? (
            <div className="pointer-events-none absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-warning/40 bg-background/90 px-2.5 py-0.5 text-2xs font-medium text-foreground shadow-sm backdrop-blur-sm">
              <span className="inline-block size-1.5 rounded-full bg-warning" />
              <span>{previewAnnotationLabel}</span>
            </div>
          ) : null}

          {filteredPins.map((pin) => {
            const isHighlighted = activePinId === pin.id || hoveredPinId === pin.id;
            const isResolved = pin.status === "resolved";
            return (
              <button
                key={pin.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleSelectCanvasPin(pin);
                }}
                onMouseEnter={() => setHoveredPinId(pin.id)}
                onMouseLeave={() => setHoveredPinId(null)}
                style={{ left: `${pin.xPct}%`, top: `${pin.yPct}%` }}
                className={cn(
                  "pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background text-2xs font-bold tabular-nums shadow-md transition-transform duration-150",
                  isResolved
                    ? "bg-success text-success-foreground"
                    : "bg-warning text-warning-foreground",
                  isHighlighted ? "z-20 scale-125 ring-4 ring-warning/45" : "z-10 hover:scale-110",
                )}
                aria-label={`#${pin.index} ${pin.note || previewAnnotationLabel}`}
                data-custom-preview-pin-marker={pin.index}
              >
                {pin.index}
                {isHighlighted && pin.note.length > 0 ? (
                  <span className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 max-w-44 -translate-x-1/2 truncate rounded-md border border-border bg-popover px-2 py-0.5 text-2xs font-normal text-popover-foreground shadow-md">
                    {pin.note}
                  </span>
                ) : null}
              </button>
            );
          })}

          {draftPin ? (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{ left: `${draftPin.xPct}%`, top: `${draftPin.yPct}%` }}
              className="pointer-events-auto absolute z-30"
            >
              <span className="flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background bg-warning text-2xs font-bold text-warning-foreground shadow-md ring-4 ring-warning/40">
                {nextIndex}
              </span>
              <div
                className={cn(
                  "absolute w-64 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg",
                  draftPin.xPct > 55 ? "right-2" : "left-2",
                  draftPin.yPct > 60 ? "bottom-4" : "top-4",
                )}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
                  <span className="font-medium text-foreground">#{nextIndex}</span>
                  <span>
                    {draftPin.xPct.toFixed(1)}%, {draftPin.yPct.toFixed(1)}%
                  </span>
                </div>
                {draftPin.cropDataUrl ? (
                  <img
                    src={draftPin.cropDataUrl}
                    alt={`#${nextIndex}`}
                    className="mb-1.5 max-h-20 w-full rounded border border-border/60 object-cover"
                  />
                ) : null}
                <input
                  ref={draftInputRef}
                  type="text"
                  value={draftNote}
                  onChange={(event) => setDraftNote(event.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  placeholder={commentPlaceholder}
                  className="mb-2 h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setDraftPin(null);
                      setDraftNote("");
                    }}
                  >
                    {cancelLabel}
                  </Button>
                  <Button type="button" variant="default" size="xs" onClick={commitDraftPin}>
                    {saveLabel}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {showFloatingChip ? (
        <button
          type="button"
          onClick={() => setDrawerOpen(threadKey, true)}
          className="absolute right-3 bottom-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-2xs font-medium text-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-accent"
          data-custom-preview-pin-chip="true"
        >
          <MapPin className="size-3 text-warning" />
          <span className="tabular-nums">
            {openCount > 0 ? `${openCount}/${pins.length}` : pins.length}
          </span>
          <ChevronUp className="size-3 text-muted-foreground" />
        </button>
      ) : null}

      {showDrawer ? (
        <div
          className="absolute inset-x-2 bottom-2 z-30 flex max-h-56 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/95 shadow-lg backdrop-blur-md"
          data-custom-preview-pin-drawer="true"
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-border/60 px-2.5 py-1.5">
            <div className="flex items-center gap-1">
              {(
                [
                  { id: "all", label: allLabel, count: pins.length },
                  { id: "open", label: openLabel, count: openCount },
                  { id: "resolved", label: resolvedLabel, count: resolvedCount },
                ] as const
              ).map((tab) => {
                const selected = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFilter(threadKey, tab.id as PreviewPinFilter)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium transition-colors",
                      selected
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <span>{tab.label}</span>
                    <span className="tabular-nums opacity-75">{tab.count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1">
              {resolvedCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="xs"
                  onClick={() => clearPins(scopeKey, "resolved")}
                >
                  {clearLabel}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={pinsToInsert.length === 0}
                onClick={() =>
                  void insertPinsIntoComposer(threadRef, pinsToInsert, url, insertLabels)
                }
                data-custom-preview-pin-insert-all="true"
              >
                <Send className="size-3" />
                <span>
                  {addToChatLabel}
                  {pinsToInsert.length > 0 ? ` (${pinsToInsert.length})` : ""}
                </span>
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={collapseLabel}
                      onClick={() => {
                        setDrawerOpen(threadKey, false);
                        setPinMode(threadKey, false);
                      }}
                    />
                  }
                >
                  {pins.length > 0 ? <ChevronDown /> : <X />}
                </TooltipTrigger>
                <TooltipPopup>{collapseLabel}</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {filteredPins.length === 0 ? (
              <div className="py-4 text-center text-2xs text-muted-foreground">
                {commentPlaceholder}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {filteredPins.map((pin) => {
                  const isActive = activePinId === pin.id;
                  const isHovered = hoveredPinId === pin.id;
                  const isResolved = pin.status === "resolved";
                  const isEditing = editingPinId === pin.id;
                  const statusLabel = isResolved ? resolvedLabel : openLabel;
                  return (
                    <div
                      key={pin.id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(pin.id, node);
                        else rowRefs.current.delete(pin.id);
                      }}
                      onClick={() => setActivePinId(pin.id)}
                      onMouseEnter={() => setHoveredPinId(pin.id)}
                      onMouseLeave={() => setHoveredPinId(null)}
                      className={cn(
                        "group flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
                        isActive
                          ? "border-warning/60 bg-warning-surface"
                          : isHovered
                            ? "border-border bg-muted/60"
                            : "border-transparent bg-muted/30 hover:bg-muted/50",
                      )}
                      data-custom-preview-pin-row={pin.index}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-3xs font-bold tabular-nums",
                          isResolved
                            ? "bg-success/15 text-success"
                            : "bg-warning text-warning-foreground",
                        )}
                      >
                        {pin.index}
                      </span>

                      {pin.cropDataUrl ? (
                        <img
                          src={pin.cropDataUrl}
                          alt={`#${pin.index}`}
                          className="size-9 shrink-0 rounded border border-border/60 object-cover"
                        />
                      ) : null}

                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingNote}
                            onChange={(event) => setEditingNote(event.target.value)}
                            onBlur={() => handleCommitEdit(pin.id)}
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                              if (event.key === "Enter") {
                                event.preventDefault();
                                handleCommitEdit(pin.id);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                setEditingPinId(null);
                              }
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="h-6 w-full rounded border border-ring bg-background px-1.5 text-xs text-foreground outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActivePinId(pin.id);
                              handleStartEdit(pin);
                            }}
                            className={cn(
                              "block w-full truncate text-left text-xs",
                              isResolved && "text-muted-foreground line-through",
                            )}
                          >
                            {pin.note.length > 0 ? pin.note : `#${pin.index}`}
                          </button>
                        )}
                        <div className="mt-0.5 flex items-center gap-2 text-3xs text-muted-foreground tabular-nums">
                          <span>
                            ({pin.xPct.toFixed(1)}%, {pin.yPct.toFixed(1)}%)
                          </span>
                          <span>{statusLabel}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={isResolved ? openLabel : resolvedLabel}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  togglePinStatus(scopeKey, pin.id);
                                }}
                              />
                            }
                          >
                            {isResolved ? (
                              <CheckCircle2 className="text-success" />
                            ) : (
                              <Circle className="text-muted-foreground" />
                            )}
                          </TooltipTrigger>
                          <TooltipPopup>{isResolved ? openLabel : resolvedLabel}</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={addToChatLabel}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void insertPinsIntoComposer(threadRef, [pin], url, insertLabels);
                                }}
                              />
                            }
                          >
                            <Send />
                          </TooltipTrigger>
                          <TooltipPopup>{addToChatLabel}</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={deleteLabel}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removePin(scopeKey, pin.id);
                                }}
                              />
                            }
                          >
                            <Trash2 className="text-muted-foreground hover:text-destructive" />
                          </TooltipTrigger>
                          <TooltipPopup>{deleteLabel}</TooltipPopup>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
});
