// overlay-store.ts — Derived atoms for overlay data parsed from code.
// Includes overlay editing mode state.

import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
// Read from stable mirror so overlay re-parse doesn't fire on every reparent
// during drag (the OverlayTool isn't being interacted with mid-drag).
import { stableCodeAtom as codeAtom } from './store';
import { parseOverlayCalls, parseOverlayTriggerCalls, type OverlayCall, type OverlayTriggerCall } from '@/code/parsing/overlay-parser';
import { trace } from '@/shared/debug-trace';
import { deepEqualPlain } from '@/shared/deep-equal';

/** When non-null, we're in overlay editing mode — value is the overlay node ID being edited */
export const overlayEditingIdAtom = atom<string | null>(null);

// The parses below re-run on every code commit (cheap regex scans) but emit a
// FRESH array each time — without equality gating, every subscriber (Canvas,
// OverlayTool, Renderer sync…) re-rendered per commit even when the page has
// zero overlays. selectAtom + deepEqualPlain notifies only when the parsed
// result actually changed (overlay added/moved/removed).

const overlayCallsRawAtom = atom<OverlayCall[]>((get) => {
  const code = get(codeAtom);
  const calls = parseOverlayCalls(code);
  trace.fn('overlay-store:overlayCallsAtom', { count: calls.length });
  return calls;
});

/** All overlay declarations parsed from code (equality-gated). */
export const overlayCallsAtom = selectAtom(overlayCallsRawAtom, (v) => v, deepEqualPlain);

const overlayTriggerCallsRawAtom = atom<OverlayTriggerCall[]>((get) => {
  const code = get(codeAtom);
  const triggers = parseOverlayTriggerCalls(code);
  trace.fn('overlay-store:overlayTriggerCallsAtom', { count: triggers.length });
  return triggers;
});

/** All overlay trigger declarations parsed from code (equality-gated). */
export const overlayTriggerCallsAtom = selectAtom(overlayTriggerCallsRawAtom, (v) => v, deepEqualPlain);
