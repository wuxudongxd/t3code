import { create } from "zustand";

import { randomUUID } from "../../lib/utils";

type PreviewPinStatus = "open" | "resolved";
export type PreviewPinFilter = "all" | PreviewPinStatus;

export interface PreviewPin {
  readonly id: string;
  readonly index: number;
  readonly xPct: number;
  readonly yPct: number;
  readonly note: string;
  readonly status: PreviewPinStatus;
  readonly url: string;
  readonly cropDataUrl?: string;
  readonly createdAt: number;
}

interface AddPreviewPinInput {
  readonly xPct: number;
  readonly yPct: number;
  readonly note: string;
  readonly url: string;
  readonly cropDataUrl?: string;
}

interface PreviewPinStoreState {
  readonly pinsByScopeKey: Readonly<Record<string, ReadonlyArray<PreviewPin>>>;
  readonly pinModeByThreadKey: Readonly<Record<string, boolean>>;
  readonly drawerOpenByThreadKey: Readonly<Record<string, boolean>>;
  readonly filterByThreadKey: Readonly<Record<string, PreviewPinFilter>>;
  readonly activePinId: string | null;
  readonly hoveredPinId: string | null;
  readonly addPin: (scopeKey: string, input: AddPreviewPinInput) => PreviewPin;
  readonly updatePinNote: (scopeKey: string, pinId: string, note: string) => void;
  readonly togglePinStatus: (scopeKey: string, pinId: string) => void;
  readonly removePin: (scopeKey: string, pinId: string) => void;
  readonly clearPins: (scopeKey: string, status?: PreviewPinStatus) => void;
  readonly togglePinMode: (threadKey: string) => void;
  readonly setPinMode: (threadKey: string, active: boolean) => void;
  readonly setDrawerOpen: (threadKey: string, open: boolean) => void;
  readonly setFilter: (threadKey: string, filter: PreviewPinFilter) => void;
  readonly setActivePinId: (pinId: string | null) => void;
  readonly setHoveredPinId: (pinId: string | null) => void;
}

export const EMPTY_PREVIEW_PINS: ReadonlyArray<PreviewPin> = [];

function normalizePinUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function clampPct(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 10) / 10;
}

export function makePreviewPinScopeKey(threadKey: string, url: string): string {
  return `${threadKey}\0${normalizePinUrl(url)}`;
}

export const usePreviewPinStore = create<PreviewPinStoreState>((set, get) => ({
  pinsByScopeKey: {},
  pinModeByThreadKey: {},
  drawerOpenByThreadKey: {},
  filterByThreadKey: {},
  activePinId: null,
  hoveredPinId: null,

  addPin: (scopeKey, input) => {
    const existing = get().pinsByScopeKey[scopeKey] ?? EMPTY_PREVIEW_PINS;
    const nextIndex = existing.reduce((max, pin) => Math.max(max, pin.index), 0) + 1;
    const created: PreviewPin = {
      id: randomUUID(),
      index: nextIndex,
      xPct: clampPct(input.xPct),
      yPct: clampPct(input.yPct),
      note: input.note.trim(),
      status: "open",
      url: input.url.trim(),
      ...(input.cropDataUrl ? { cropDataUrl: input.cropDataUrl } : {}),
      createdAt: Date.now(),
    };
    set((state) => ({
      pinsByScopeKey: {
        ...state.pinsByScopeKey,
        [scopeKey]: [...(state.pinsByScopeKey[scopeKey] ?? EMPTY_PREVIEW_PINS), created],
      },
      activePinId: created.id,
    }));
    return created;
  },

  updatePinNote: (scopeKey, pinId, note) => {
    const trimmed = note.trim();
    set((state) => {
      const existing = state.pinsByScopeKey[scopeKey];
      if (!existing) return state;
      let changed = false;
      const next = existing.map((pin) => {
        if (pin.id !== pinId || pin.note === trimmed) return pin;
        changed = true;
        return { ...pin, note: trimmed };
      });
      if (!changed) return state;
      return {
        pinsByScopeKey: {
          ...state.pinsByScopeKey,
          [scopeKey]: next,
        },
      };
    });
  },

  togglePinStatus: (scopeKey, pinId) => {
    set((state) => {
      const existing = state.pinsByScopeKey[scopeKey];
      if (!existing) return state;
      let changed = false;
      const next = existing.map((pin) => {
        if (pin.id !== pinId) return pin;
        changed = true;
        const status: PreviewPinStatus = pin.status === "open" ? "resolved" : "open";
        return { ...pin, status };
      });
      if (!changed) return state;
      return {
        pinsByScopeKey: {
          ...state.pinsByScopeKey,
          [scopeKey]: next,
        },
      };
    });
  },

  removePin: (scopeKey, pinId) => {
    set((state) => {
      const existing = state.pinsByScopeKey[scopeKey];
      if (!existing) return state;
      const next = existing.filter((pin) => pin.id !== pinId);
      if (next.length === existing.length) return state;
      const nextPinsByScopeKey = { ...state.pinsByScopeKey };
      if (next.length === 0) {
        delete nextPinsByScopeKey[scopeKey];
      } else {
        nextPinsByScopeKey[scopeKey] = next;
      }
      return {
        pinsByScopeKey: nextPinsByScopeKey,
        activePinId: state.activePinId === pinId ? null : state.activePinId,
        hoveredPinId: state.hoveredPinId === pinId ? null : state.hoveredPinId,
      };
    });
  },

  clearPins: (scopeKey, status) => {
    set((state) => {
      const existing = state.pinsByScopeKey[scopeKey];
      if (!existing || existing.length === 0) return state;
      const next = status ? existing.filter((pin) => pin.status !== status) : [];
      if (next.length === existing.length) return state;
      const nextPinsByScopeKey = { ...state.pinsByScopeKey };
      if (next.length === 0) {
        delete nextPinsByScopeKey[scopeKey];
      } else {
        nextPinsByScopeKey[scopeKey] = next;
      }
      const remainingIds = new Set(next.map((pin) => pin.id));
      return {
        pinsByScopeKey: nextPinsByScopeKey,
        activePinId:
          state.activePinId && remainingIds.has(state.activePinId) ? state.activePinId : null,
        hoveredPinId:
          state.hoveredPinId && remainingIds.has(state.hoveredPinId) ? state.hoveredPinId : null,
      };
    });
  },

  togglePinMode: (threadKey) => {
    set((state) => {
      const nextActive = !(state.pinModeByThreadKey[threadKey] ?? false);
      return {
        pinModeByThreadKey: {
          ...state.pinModeByThreadKey,
          [threadKey]: nextActive,
        },
        drawerOpenByThreadKey: nextActive
          ? { ...state.drawerOpenByThreadKey, [threadKey]: true }
          : state.drawerOpenByThreadKey,
      };
    });
  },

  setPinMode: (threadKey, active) => {
    set((state) => {
      if ((state.pinModeByThreadKey[threadKey] ?? false) === active) return state;
      return {
        pinModeByThreadKey: {
          ...state.pinModeByThreadKey,
          [threadKey]: active,
        },
      };
    });
  },

  setDrawerOpen: (threadKey, open) => {
    set((state) => {
      if ((state.drawerOpenByThreadKey[threadKey] ?? false) === open) return state;
      return {
        drawerOpenByThreadKey: {
          ...state.drawerOpenByThreadKey,
          [threadKey]: open,
        },
      };
    });
  },

  setFilter: (threadKey, filter) => {
    set((state) => {
      if ((state.filterByThreadKey[threadKey] ?? "all") === filter) return state;
      return {
        filterByThreadKey: {
          ...state.filterByThreadKey,
          [threadKey]: filter,
        },
      };
    });
  },

  setActivePinId: (pinId) => {
    set((state) => (state.activePinId === pinId ? state : { activePinId: pinId }));
  },

  setHoveredPinId: (pinId) => {
    set((state) => (state.hoveredPinId === pinId ? state : { hoveredPinId: pinId }));
  },
}));
