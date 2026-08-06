// useTextStyles.ts — Selection-aware hook for reading / writing text styles.
//
// Two modes:
//   1. Non-edit mode (no TipTap session active): reads from the selected
//      node's inline styles, writes via updateStyle (the regular control
//      provider path that pushes into JSX).
//   2. Edit mode (TipTap session running inside the sandbox iframe): reads
//      from the latest selection snapshot the sandbox emitted; writes via
//      bridge.editorCommand which RPCs into the iframe-side TipTap host.
//
// Pre-iframe-migration this hook walked `activeEditor.state.doc` directly to
// detect mixed values across selection. That's not possible across origins,
// so the iframe precomputes the mixed/uniform state per property and ships
// it to the parent on every transaction (TextEditSnapshot).

import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  isTextEditingAtom,
  textEditSnapshotAtom,
} from '@/code/stores/editor-store';
import type { TextEditSnapshot, TextEditValue } from '@/canvas-sandbox/protocol';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { selectedIdsAtom, getNodesSnapshot } from '@/code/stores/store';
import { isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { queueMutation, setForceRender } from '@/code/mutation/mutation-queue';
import { TEXT_MARK_SPAN_PROPS, getInlineSpanPropertyState } from '@/code/generation/generator-crud';
import { useControl } from '../controls/ControlProvider';
import { trace } from '@/shared/debug-trace';

/** Matches an inline span run in rich textContent — plain `<span` OR the
 *  motionized `<motion.span` a design-component variant pass produces. The
 *  literal `'<span'` probe was blind to motion.span, so inside variant
 *  components the flatten below never fired and a span's baked color beat
 *  every variant color forever ("button text won't change color", 2026-08-05).
 *  Twin of the AST-level isInlineSpanElement, which always handled both. */
const INLINE_SPAN_RE = /<(?:motion\.)?span\b/;

/** Cheap guard: does this node's rich content actually carry an inline `<span>`
 *  override for `property`? Inline-style keys in our JSX are camelCase
 *  identifiers (`color:` / `fontWeight:`), so a word-boundary key probe avoids
 *  queuing a no-op strip (and an unnecessary re-parse) when no span has it. */
function spanContentCarriesProp(textContent: string, property: string): boolean {
  if (!INLINE_SPAN_RE.test(textContent)) return false;
  return new RegExp(`\\b${property}\\s*:`).test(textContent);
}

interface TextStyleValue {
  /** The style value, or '' if not set / mixed. */
  value: string;
  /** True when the selection spans multiple distinct values. */
  isMixed: boolean;
  /** When isMixed, the unique non-empty values found (used for multi-stop
   *  gradient previews and similar). */
  mixedValues?: string[];
}

export interface UseTextStylesReturn {
  /** Read the current value for a text-style property. */
  get: (property: string) => TextStyleValue;
  /** Write a text-style property. Routes to TipTap (in iframe) when editing,
   *  to node-style updates otherwise. */
  set: (property: string, value: string) => void;
  /** Live (per-frame) write for a draggable control (e.g. a color picker).
   *  In NODE mode this is a DOM-only patch (`updateStyleLive`) — no source
   *  re-parse — so the canvas stays at 60fps; commit once on release via
   *  `set`. In EDIT mode it delegates to `set` (TipTap marks already apply
   *  live without a code re-parse). */
  setLive: (property: string, value: string) => void;
  /** Whether a text-edit session is currently active. */
  isEditing: boolean;
}

const PARAGRAPH_PROPS = new Set([
  'textAlign',
  'lineHeight',
  'textDecoration',
  'textTransform',
]);

/** Convert a snapshot's TextEditValue (always present) into the hook's
 *  TextStyleValue (may have mixedValues). */
function fromSnapshotValue(v: TextEditValue | undefined): TextStyleValue {
  if (!v) return { value: '', isMixed: false };
  if (v.isMixed) {
    return { value: '', isMixed: true, mixedValues: v.mixedValues };
  }
  return { value: v.value, isMixed: false };
}

/** Read the most relevant value from a snapshot for a given property,
 *  falling back to cursor-mode attrs when no range value is present.
 *  Exported (pure) so popup panels can live-derive the SELECTION's mark state
 *  by subscribing to textEditSnapshotAtom directly — a pushed popup's props
 *  are frozen at push time, so it can't rely on the parent re-rendering
 *  (TextColorControl's Solid/Gradient tab sync). */
export function readFromSnapshot(
  snap: TextEditSnapshot,
  property: string,
): TextStyleValue {
  // Highlight (background) lives in its own slot.
  if (property === 'backgroundColor') {
    const fromRange = fromSnapshotValue(snap.highlight);
    if (fromRange.isMixed || fromRange.value) return fromRange;
    if (snap.cursorMode && snap.cursorHighlightAttr) {
      return { value: snap.cursorHighlightAttr, isMixed: false };
    }
    return { value: '', isMixed: false };
  }

  // Paragraph attributes vs textStyle marks.
  const isPara = PARAGRAPH_PROPS.has(property);
  const range = isPara ? snap.paragraph[property] : snap.marks[property];
  const fromRange = fromSnapshotValue(range);
  if (fromRange.isMixed || fromRange.value) return fromRange;

  // Cursor-mode fallback (no range, range walk turned up nothing).
  if (snap.cursorMode) {
    const cursorAttr = isPara
      ? snap.cursorParagraphAttrs[property]
      : snap.cursorMarkAttrs[property];
    if (cursorAttr) return { value: cursorAttr, isMixed: false };
  }
  return { value: '', isMixed: false };
}

/**
 * Decide what a whole-node TEXT-MARK write should do about the node's inner
 * `<span style>` runs.
 *
 * A rich-text node keeps per-portion formatting as inline spans, and a span's
 * own value always beats the `<p>`'s (CSS compares declarations per element,
 * not across ancestors). So setting the property on the node is invisible
 * unless the spans give it up — that's the FLATTEN.
 *
 * The wrinkle is a SCOPED write. On a page replica (or a component variant) the
 * value lands in an `@media` rule / variant object for that viewport ALONE,
 * while stripping the span removes it from EVERY viewport. Sizing a 48px
 * heading on mobile therefore dropped the span's 48px and left primary + tablet
 * showing the `<p>`'s own 16px (user report 2026-07-26). Fix: HOIST the span's
 * value onto the node's base style first — primary paints identically (the span
 * was what painted it) and the scoped override now has a base to override.
 *
 * Genuinely mixed runs (two colours in one paragraph) have no single base value,
 * so nothing is stripped: per-run formatting is preserved and the scoped
 * override simply doesn't reach the spans.
 *
 * Exported for unit tests; `set` mirrors it exactly.
 */
export function planSpanFlatten(args: {
  property: string;
  hasMixedContent: boolean;
  textContent: string;
  /** Write goes to a viewport `@media` rule / variant object, not the base. */
  isScopedWrite: boolean;
}): { strip: boolean; hoistValue?: string } {
  const { property, hasMixedContent, textContent, isScopedWrite } = args;
  if (!TEXT_MARK_SPAN_PROPS.has(property)) return { strip: false };
  if (!hasMixedContent || !spanContentCarriesProp(textContent, property)) return { strip: false };
  if (!isScopedWrite) return { strip: true };
  const spanState = getInlineSpanPropertyState(textContent, property, '');
  if (spanState.isMixed || !spanState.value) return { strip: false };
  return { strip: true, hoistValue: spanState.value };
}

/** Which VARIANT entries a span-hoist must ALSO be written to. Framer applies
 *  variant entries INLINE over the base style, so hoisting the span's value
 *  onto the base alone is not enough when variant entries carry the same
 *  property: those entries were visually DEAD while the span shadowed them,
 *  and the strip resurrects their stale values — editing variant-3's color
 *  flipped every other tile to the entries' old white ("all the other variant
 *  text went white", 2026-08-05). Every non-edited entry that carries the
 *  property gets re-pointed at the hoisted value, so all tiles keep painting
 *  exactly what the span painted. Exported for unit tests. */
export function planVariantHoistFanout(
  motionVariants: Record<string, Record<string, string>> | null | undefined,
  property: string,
  editedVariant: string | null,
): string[] {
  if (!motionVariants) return [];
  return Object.entries(motionVariants)
    .filter(([name, entry]) => name !== editedVariant && entry?.[property] != null && entry[property] !== '')
    .map(([name]) => name);
}

export function useTextStyles(): UseTextStylesReturn {
  const isEditing = useAtomValue(isTextEditingAtom);
  const snapshot = useAtomValue(textEditSnapshotAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const isComponentVariantViewport = useAtomValue(isComponentVariantViewportAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);
  const { styles, updateStyle, updateStyleLive, isReplica } = useControl();
  // A write that lands in a viewport-scoped `@media` rule (page replica) or a
  // variant object — NOT on the node's own base style. Drives the span-hoist
  // below: a scoped write must not delete a value the OTHER viewports rely on.
  const isScopedWrite = isReplica || isComponentVariantViewport;

  const get = useCallback(
    (property: string): TextStyleValue => {
      if (!isEditing || !snapshot) {
        // Non-edit mode: read from node styles via control provider.
        const v = styles[property] ?? '';

        // Rich-text MIXED read (design-tool parity): when the whole node is selected
        // out of text-edit mode, its per-portion `<span style>` runs can carry a
        // different mark than the `<p>`'s own style. Inspect the spans so the
        // control reports "Mixed" instead of the base value — mirroring the
        // snapshot path used in edit mode. Scoped to TEXT-MARK props (paragraph
        // props aren't span-overridable). Plain (non-rich) nodes fall through.
        if (TEXT_MARK_SPAN_PROPS.has(property)) {
          const node = selectedIds.length > 0 ? getNodesSnapshot().get(selectedIds[0]) : undefined;
          if (node?.hasMixedContent && INLINE_SPAN_RE.test(node.textContent)) {
            const state = getInlineSpanPropertyState(node.textContent, property, v);
            trace.fn('useTextStyles.get', {
              property, mode: 'node-rich', value: state.value, isMixed: state.isMixed,
            });
            return state;
          }
        }

        trace.fn('useTextStyles.get', { property, mode: 'node', value: v });
        return { value: v, isMixed: false };
      }

      const fromSnap = readFromSnapshot(snapshot, property);
      // If the snapshot had no value at all, fall back to node styles —
      // mirrors the pre-migration behavior where a property with no editor
      // mark inherited from the element's own styles.
      if (!fromSnap.value && !fromSnap.isMixed) {
        const fallback = styles[property] ?? '';
        if (fallback) {
          trace.fn('useTextStyles.get', { property, mode: 'snapshot-node-fallback', value: fallback });
          return { value: fallback, isMixed: false };
        }
      }
      trace.fn('useTextStyles.get', {
        property,
        mode: 'snapshot',
        value: fromSnap.value,
        isMixed: fromSnap.isMixed,
      });
      return fromSnap;
    },
    [isEditing, snapshot, styles, selectedIds],
  );

  const set = useCallback(
    (property: string, value: string) => {
      trace.action('text-styles:set', {
        property,
        value,
        mode: isEditing ? 'iframe-tiptap' : 'node',
      });

      if (!isEditing) {
        // Non-edit mode: write via the regular control provider (variant /
        // replica routing handled there) — this sets the property on the node's
        // own `<p>` style.
        trace.fn('useTextStyles.set', { property, value, routing: 'updateStyle' });
        updateStyle(property, value);

        // Rich-text FLATTEN (design-tool parity): a rich-text node stores per-portion
        // formatting as inline `<span style={{…}}>` runs (created by selecting
        // text in edit mode and styling it). Those inline marks override the
        // `<p>`'s style, so the `updateStyle` above alone would be invisible.
        // When a TEXT-MARK property (color / font* / letterSpacing / decoration /
        // gradient-fill — NOT paragraph props, which aren't span-overridable) is
        // changed on the WHOLE node out of edit mode, ALSO strip that one prop
        // from every inner span so the node's new value wins everywhere. Empty
        // spans unwrap; other per-span formatting is preserved.
        {
          const nodes = getNodesSnapshot();
          for (const id of selectedIds) {
            const node = nodes.get(id);
            const plan = planSpanFlatten({
              property,
              hasMixedContent: !!node?.hasMixedContent,
              textContent: node?.textContent ?? '',
              isScopedWrite,
            });
            if (plan.strip) {
              // Scoped write → carry the span's value onto the base first, so
              // the OTHER viewports keep rendering it. See planSpanFlatten.
              if (plan.hoistValue) {
                trace.action('useTextStyles:hoist-span-to-base', {
                  property, nodeId: id, value: plan.hoistValue,
                });
                queueMutation({ type: 'updateStyles', nodeId: id, styles: { [property]: plan.hoistValue } });
                // Variant entries carrying this prop were shadowed by the span
                // and hold STALE values — see planVariantHoistFanout. Re-point
                // every non-edited entry at the hoisted value or the strip
                // resurrects the stale ones over the hoisted base.
                for (const vName of planVariantHoistFanout(node?.motionVariants, property, activeComponentVariant ?? null)) {
                  trace.action('useTextStyles:hoist-span-to-variant', { property, nodeId: id, variantName: vName, value: plan.hoistValue });
                  queueMutation({ type: 'updateVariantStyle', nodeId: id, variantName: vName, styles: { [property]: plan.hoistValue } });
                }
              }
              trace.fn('useTextStyles.set', { property, nodeId: id, routing: 'flatten-spans' });
              queueMutation({ type: 'stripInlineSpanStyle', nodeId: id, property });
              // A solid run inside gradient text carries `-webkit-text-fill-color`
              // alongside `color` (TextFillColorMark — fill-color is what paints
              // glyphs there). The two travel together: flattening color while
              // leaving the fill-color would keep shadowing the node's new value.
              if (property === 'color') {
                queueMutation({ type: 'stripInlineSpanStyle', nodeId: id, property: 'WebkitTextFillColor' });
              }
              // The strip flips the node rich→plain (hasMixedContent true→false:
              // its content goes from inner <span> runs to bare text). The
              // Renderer's diff-patch keeps the stale span DOM on that transition,
              // so the canvas would stay the old per-span color even though the
              // code/live site are correct. Force a full rebuild on this flush so
              // the node re-renders as flat text in the node's new color.
              setForceRender();
            }
          }
        }
        return;
      }

      // Edit mode: dispatch a high-level command into the sandbox-side editor.
      // Call as a method on the bridge so `this` stays bound — extracting
      // `bridge.editorCommand` to a local variable loses the binding and
      // crashes inside PostMessageBridge when it tries to read `this.remote`.
      const bridge = getCanvasBridge() as any;
      if (typeof bridge?.editorCommand !== 'function') {
        // No editor RPC available (DirectBridge without sandbox) — fall back
        // to writing the node style directly. Better than dropping the
        // command entirely.
        trace.fn('useTextStyles.set', {
          property,
          value,
          routing: 'no-bridge-fallback-to-node',
        });
        updateStyle(property, value);
        return;
      }

      if (PARAGRAPH_PROPS.has(property)) {
        trace.fn('useTextStyles.set', { property, value, routing: 'iframe paragraph' });
        bridge.editorCommand({ kind: 'paragraph', property, value });
        return;
      }

      if (property === 'backgroundColor') {
        trace.fn('useTextStyles.set', { property, value, routing: 'iframe highlight' });
        bridge.editorCommand({ kind: 'highlight', value: value || null });
        return;
      }

      if (property === 'backgroundGradient') {
        trace.fn('useTextStyles.set', {
          property,
          value: value.slice(0, 60),
          routing: 'iframe gradient',
        });
        bridge.editorCommand({ kind: 'gradient', value: value || null });
        return;
      }

      trace.fn('useTextStyles.set', { property, value, routing: 'iframe mark' });
      bridge.editorCommand({ kind: 'mark', property, value });
    },
    [isEditing, updateStyle, selectedIds, isScopedWrite, activeComponentVariant],
  );

  // Live (per-frame) twin of `set`. NODE mode: DOM-only patch via
  // `updateStyleLive` (no source re-parse → 60fps); the source write lands on
  // release via `set`. EDIT mode: delegate to `set` — TipTap marks apply live
  // through the iframe editor RPC, there is no per-frame code re-parse to
  // avoid, so the live and commit paths are the same.
  //
  // NOTE: the rich-text span FLATTEN (see `set`, node mode) is intentionally
  // NOT mirrored here. Inner spans carry no data-id, so the bridge can't target
  // them for a DOM-only patch; during a live drag the colored runs keep their
  // old value and the `<p>` previews the new one. They snap correct on release
  // when `set` queues the `stripInlineSpanStyle` mutation. The commit is the
  // path that matters for the "it doesn't update" bug.
  const setLive = useCallback(
    (property: string, value: string) => {
      if (!isEditing) {
        updateStyleLive(property, value);
        return;
      }
      set(property, value);
    },
    [isEditing, updateStyleLive, set],
  );

  return { get, set, setLive, isEditing };
}
