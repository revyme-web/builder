// animation-store.ts — Derived atoms for animation data parsed from code.
// Parses @keyframes from the <style> block CSS.
// No separate storage — code is the source of truth.

import { atom } from 'jotai';
// Animation parsers run during drag-end + idle, never during the drag itself
// (no live animation editor open mid-reparent), so they read the STABLE code
// mirror to skip the per-reparent re-parse. See Canvas.tsx sync effect.
import { stableCodeAtom as codeAtom } from './store';
import { parseKeyframes, type KeyframeAnimation } from '@/shared/animation-utils';
import { projectFS } from '../project/project-fs';
import { parseScrollHooks, type ScrollAnimData } from '@/code/parsing/scroll-parser';
import { parseHoverRules } from '@/code/parsing/hover-parser';
import { extractStyleCSS } from '@/code/parsing/parser';
import { parseTextAnimCalls, type TextAnimCall } from '@/code/parsing/text-anim-parser';
import { trace } from '@/shared/debug-trace';

/**
 * Bump atom — increment this to force keyframesAtom to re-read tokens.css.
 * Set after any updateKeyframes / removeKeyframes mutation is flushed.
 */
export const keyframesBumpAtom = atom(0);

/**
 * Derived atom: all @keyframes defined in app/globals.css (global file).
 * Re-reads whenever keyframesBumpAtom is incremented.
 * Keyframes are global (available across all pages) — not per-page style blocks.
 */
export const keyframesAtom = atom<KeyframeAnimation[]>((get) => {
  get(keyframesBumpAtom); // subscribe for reactivity
  const css = projectFS.readFile('app/globals.css') ?? '';
  const keyframes = parseKeyframes(css);
  trace.fn('animation-store:keyframesAtom', { count: keyframes.length, names: keyframes.map(k => k.name) });
  return keyframes;
});

/**
 * Derived atom: just the keyframe names (for dropdown options).
 */
export const keyframeNamesAtom = atom<string[]>((get) => {
  return get(keyframesAtom).map(k => k.name);
});

/**
 * Derived atom: all text animations (data-text-anim) parsed from code.
 */
export const textAnimCallsAtom = atom<TextAnimCall[]>((get) => {
  const code = get(codeAtom);
  const calls = parseTextAnimCalls(code);
  trace.fn('animation-store:textAnimCallsAtom', { count: calls.length });
  return calls;
});

/**
 * True while the user is in "pick animation target" mode (Add Target panel open).
 * SelectionOverlay hides itself when this is true to reduce visual noise.
 */
export const isPickingAnimTargetAtom = atom<boolean>(false);

/**
 * Active keyframe sheet: which @keyframes animation is open in the bottom sheet.
 * null = sheet closed. { name, nodeId } = specific keyframe + owning element.
 */
export const activeKeyframeSheetAtom = atom<{ name: string; nodeId: string } | null>(null);

/**
 * Selected stop index within the active keyframe sheet (for highlighting + editing).
 * null = no stop selected.
 */
export const selectedKeyframeStopAtom = atom<number | null>(null);

/**
 * Derived atom: all scroll-linked animations parsed from useScroll/useTransform hooks.
 */
export const scrollAnimDataAtom = atom<ScrollAnimData>((get) => {
  const code = get(codeAtom);
  const data = parseScrollHooks(code);
  trace.fn('animation-store:scrollAnimDataAtom', {
    refs: data.refs.length, sources: data.sources.length,
    transforms: data.transforms.length, bindings: data.bindings.length,
  });
  return data;
});

/** Parsed CSS :hover rules per node from the page's <style> block */
export const cssHoverStylesAtom = atom<Map<string, Record<string, string>>>((get) => {
  const code = get(codeAtom);
  if (!code) return new Map();
  const css = extractStyleCSS(code);
  if (!css) return new Map();
  const result = parseHoverRules(css);
  trace.fn('animation-store:cssHoverStylesAtom', { ruleCount: result.size });
  return result;
});
