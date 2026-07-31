// animation-clipboard.ts — "Copy Style / Paste Style" for ANIMATION entries.
//
// The generic style clipboard (editor/controls/style-clipboard.ts) snapshots the
// CSS `styles` map — but animations don't live there (they're framer-motion props
// / `data-text-anim` configs in the JSX), so copying an animation row through it
// captured nothing and Paste no-op'd. This is the parallel clipboard for animation
// ENTRIES: copy one entry (e.g. an Appear reveal) from a node, paste it onto another.
//
// Same-kind only (a hover pastes onto a hover), so the result is always predictable.
// A row only exposes the Copy/Paste menu when `buildCopiedAnimation` returns non-null
// for it — so pasting is inherently limited to portable rows on BOTH ends: the
// instance-fx / combined-fx / scroll-triggered / overlay variants (which need their
// own write paths) return null here, so they never show the menu and can't be a
// clobbering paste target. Extend the gates below to add more kinds.
//
// Responsive: Paste re-applies through the SAME scoped `updateMotionProp` the
// popups use (`scope: getActiveAnimationScope()`), so pasting onto a replica /
// non-default variant writes a per-viewport / per-variant override branch instead
// of clobbering the base — matching the per-tile responsive-animation model.

import { atom } from 'jotai';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import type { AnimEntryType } from './shared';
import type { TextAnimConfig } from './motion/text-anim-presets';
import { getActiveAnimationScope } from './animation-scope-source';
import { appearReveal, appearUnionKeys } from './appear-utils';

/** A single copied animation entry (separate from the CSS-style clipboard and the OS clipboard). */
export interface CopiedAnimation {
  kind: AnimEntryType;
  /** Human label of the source row — for the menu / trace. */
  label: string;
  /** The kind-specific config snapshot (deep-cloned so the clipboard is independent). */
  config: unknown;
}

/** Deep clone so the clipboard is fully independent of the live node. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Non-marker, non-empty keys in a motion prop object (drops `_scope`/`_base`/…). */
function realKeys(o: any): string[] {
  return Object.keys(o || {}).filter((k) => !k.startsWith('_') && o[k] !== '');
}

/** The single in-memory animation clipboard slot. */
export const copiedAnimationAtom = atom<CopiedAnimation | null>(null);

/** Entry kinds that support animation copy/paste today. */
const SUPPORTED: ReadonlySet<AnimEntryType> = new Set<AnimEntryType>([
  'textEffect', 'appear', 'hover', 'tap',
]);

const KIND_LABEL: Partial<Record<AnimEntryType, string>> = {
  textEffect: 'Text',
  appear: 'Appear',
  hover: 'Hover',
  tap: 'Tap',
};

/** Can this entry kind be copied? (drives whether the row shows the menu) */
export function isAnimCopyable(kind: AnimEntryType): boolean {
  return SUPPORTED.has(kind);
}

/**
 * Build a clipboard snapshot from a detected entry's `data`. Returns null for
 * unsupported kinds — OR for the non-portable variants of a supported kind
 * (instance-fx / combined-fx / scroll-triggered / overlay) whose write path
 * differs — so the row simply shows no copy/paste menu rather than copying (and
 * later pasting) something that can't be reproduced via `updateMotionProp`.
 */
export function buildCopiedAnimation(kind: AnimEntryType, data: any): CopiedAnimation | null {
  if (!SUPPORTED.has(kind)) return null;
  const label = KIND_LABEL[kind] ?? kind;

  if (kind === 'textEffect') {
    const config = data?.config;
    if (!config) return null;
    return { kind, label, config: clone(config) };
  }

  if (kind === 'appear') {
    // Only the plain motion-props Appear (initial → whileInView) is portable via
    // updateMotionProp. Skip scroll-triggered (trigger:'scroll'), overlay
    // (initial→animate→exit inside AnimatePresence), and instance-fx / combined-fx
    // appears — each writes through a different generator.
    if (data?.trigger !== 'appear') return null;
    if (data?.isOverlay) return null;
    if (data?.fxKind || data?.instanceFx || data?.fxSpec) return null;
    const initialProps = data?.initialProps;
    if (!initialProps || realKeys(initialProps).length === 0) return null;
    return { kind, label, config: clone({ initialProps, transition: data?.transition || {} }) };
  }

  if (kind === 'hover' || kind === 'tap') {
    // Only the live framer-motion gesture (engine:'motion', no fx spec) is portable
    // as whileHover / whileTap. The combined-node (fxSpec) and instance-fx variants
    // are skipped — they carry the gesture in a spec and write via setFxValueScoped.
    if (data?.engine !== 'motion') return null;
    if (data?.fxKind || data?.instanceFx || data?.fxSpec) return null;
    const props = data?.payload?.props;
    if (!props || realKeys(props).length === 0) return null;
    // The gesture's TIMING is the node's tag-level `transition` prop (what the
    // popup's Transition row edits) — copy it with the gesture, or a pasted
    // hover lands with the target's old spring (the reported half-paste).
    return { kind, label, config: clone({ props, transition: data?.transition || {} }) };
  }

  return null;
}

/** Is the copied animation pasteable onto a row of `targetKind`? Same-kind only. */
export function canPasteAnimation(copied: CopiedAnimation | null, targetKind: AnimEntryType): boolean {
  return !!copied && copied.kind === targetKind;
}

/**
 * Apply the copied animation to `nodeId` via the kind's own mutation.
 *
 * `node` is the TARGET node (optional) — used only to derive the Appear reveal
 * over the union of the target's existing enter keys + its authored styles, so
 * layout keys (height/width/…) reveal to their real value instead of collapsing.
 *
 * The motion-props kinds write with `scope: getActiveAnimationScope()`, so pasting
 * on a replica / non-default variant lands in that tile's override branch (and on a
 * primary / base tile it writes the base) — never clobbering the base blindly.
 */
export function applyCopiedAnimation(copied: CopiedAnimation, nodeId: string, node?: any): void {
  trace.action('anim-clipboard:paste', { kind: copied.kind, nodeId, hasNode: !!node });
  switch (copied.kind) {
    case 'textEffect':
      // The target row exists only because the node already carries a text anim,
      // so updateTextAnim re-applies the copied config (regenerating the split).
      queueMutation({ type: 'updateTextAnim', nodeId, config: copied.config as TextAnimConfig });
      break;

    case 'appear': {
      // Mirror AppearPopup.writeEnter: scoped `initial` (the responsive enter) +
      // a DERIVED, non-scoped `whileInView` reveal over the union of the target's
      // enter keys, + the copied transition.
      const cfg = copied.config as { initialProps: Record<string, string>; transition?: Record<string, string> };
      const scope = getActiveAnimationScope();
      queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: cfg.initialProps, scope });
      queueMutation({
        type: 'updateMotionProp', nodeId, propName: 'whileInView',
        props: appearReveal(appearUnionKeys(node?.motionProps?.initial, cfg.initialProps), node?.styles),
      });
      if (cfg.transition && Object.keys(cfg.transition).length) {
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'transition', props: cfg.transition });
      }
      break;
    }

    case 'hover':
    case 'tap': {
      // Mirror HoverPopup / TapPopup: scoped whileHover / whileTap gesture props,
      // PLUS the copied transition — written exactly like the popup's Transition
      // row (unscoped tag-level `transition`), so the pasted gesture carries its
      // timing instead of inheriting the target's old spring.
      const cfg = copied.config as { props: Record<string, string>; transition?: Record<string, string> };
      const propName = copied.kind === 'hover' ? 'whileHover' : 'whileTap';
      queueMutation({ type: 'updateMotionProp', nodeId, propName, props: cfg.props, scope: getActiveAnimationScope() });
      if (cfg.transition && Object.keys(cfg.transition).length) {
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'transition', props: cfg.transition });
      }
      break;
    }

    default:
      break;
  }
}
