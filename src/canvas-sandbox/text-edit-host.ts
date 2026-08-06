// text-edit-host.ts — Sandbox-side TipTap lifecycle.
//
// Why this lives in the sandbox: the editor mounts directly on the actual
// canvas element being edited. That means wrap behavior, font sizing, line
// height, and overall layout are pixel-identical to non-edit mode (since the
// editor IS the rendered element, not a separate overlay). All the
// coordinate translation / camera-scale / RAF-position-tracking that used to
// live in the parent goes away.
//
// Communication with the parent:
//   - Commands in: parent calls startEdit / commit / cancel / runCommand via
//     Comlink (see SandboxApi).
//   - Events out: every TipTap transaction emits textEditSelectionChanged
//     with a precomputed TextEditSnapshot. The parent's toolbar reads from
//     that snapshot instead of walking editor state directly (which it
//     can't, across origins).

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { FontFamily } from '@tiptap/extension-font-family';
import Highlight from '@tiptap/extension-highlight';
import {
  FontSize,
  FontWeight,
  LetterSpacing,
  LineHeight,
  TextDecoration,
  TextTransform,
  EnterHardBreak,
  TextDecorationMark,
  GradientTextMark,
  TextFillColorMark,
  TextStrokeMark,
} from '@/canvas/tiptap-extensions';

import type { SandboxEvent, TextEditFitResult, TextEditSnapshot, TextEditValue } from './protocol';
import type { TextEditCommand } from './sandbox-api';
import { wrapEvent } from './protocol';
import { getScreenCorners } from '@/canvas/resize/geometry-utils';
import { findElByNodeId, nodeIdSelector } from './sandbox-dom-utils';
import { measureFitRefit } from '@/shared/fit-measure';
import { trace } from '@/shared/debug-trace';

// Properties tracked at the textStyle (per-portion, mark-level) layer.
const MARK_PROPS = [
  'fontSize',
  'fontWeight',
  'fontFamily',
  'color',
  'letterSpacing',
  'backgroundGradient',
  'textDecorationLine',
  'textDecorationColor',
  'textDecorationStyle',
  'textDecorationThickness',
  'textUnderlineOffset',
  'webkitTextStroke',
];

// Properties tracked at the paragraph layer (line/block scope).
const PARAGRAPH_PROPS = ['textAlign', 'lineHeight', 'textDecoration', 'textTransform'];

// ─── Module state ────────────────────────────────────────────────────────

let activeEditor: Editor | null = null;
let activeNodeId: string | null = null;
let activeVpPrefix: string = '';
let activeElement: HTMLElement | null = null;
let savedInlineStyles: { color: string; textShadow: string } | null = null;
let outsideClickListener: ((e: MouseEvent) => void) | null = null;
let escapeListener: ((e: KeyboardEvent) => void) | null = null;
let elementMousedownStopper: ((e: MouseEvent) => void) | null = null;
let intentionalSelectionMouseupListener: (() => void) | null = null;
let intentionalSelectionKeyupListener: (() => void) | null = null;
let contentRoot: HTMLElement | null = null;
/** Style element that paints the edit-time outline directly on the iframe
 *  element. Keeping it iframe-side means the highlight grows / wraps
 *  exactly with the contentEditable as the user types — the parent-frame
 *  selection overlay can't track that without a frame-by-frame measure. */
let editOutlineStyleEl: HTMLStyleElement | null = null;
/** The user's most recent intentional selection — captured at mouseup /
 *  keyup AFTER they finalize a drag-select or shift-arrow expansion. When
 *  the iframe loses focus (e.g., user clicks a parent toolbar input),
 *  ProseMirror may collapse the visible selection; this remembered range
 *  is restored before applying any toolbar command so styles land where
 *  the user expected. */
let intentionalSelection: { from: number; to: number } | null = null;
// ResizeObserver attached to the live editing element. Emits rectUpdate +
// cornersUpdate every time TipTap mutates content and the contentEditable
// reflows — so the parent's rectCache / cornersCache stay current with the
// in-progress edit. Without this, the parent only learns the new size on
// renderComplete (after commit), producing a ~300ms gap where SelectionOverlay
// stays hidden post-edit while the iframe re-emits allRects.
let liveSizeObserver: ResizeObserver | null = null;

/** Initialize the host with the sandbox's content root so it can find elements. */
export function initTextEditHost(root: HTMLElement): void {
  contentRoot = root;
  trace.action('text-edit-host:init');
}

/** Send an event to the parent. Mirrors the helper in bridge-sandbox.ts. */
function emit(event: SandboxEvent): void {
  parent.postMessage(wrapEvent(event), '*');
}

/**
 * Push live TipTap HTML into every replica of the active node.
 *
 * Replicas have `data-node-id="${vpPrefix}${nodeId}"` (e.g. `tablet-myText`,
 * `mobile-myText`) while the primary is just `nodeId`. We query every element
 * whose data-node-id ends with the active id, then double-check that it
 * either matches exactly OR has the form `<prefix>-<nodeId>` so we don't
 * accidentally match unrelated ids that happen to share a suffix
 * (`submyText` would match the bare endsWith but fails the dash check).
 *
 * The `activeElement` (where TipTap is mounted) is skipped — its DOM is
 * owned by ProseMirror and replacing innerHTML would break the editor.
 */
/**
 * Push live TipTap HTML into every replica of the active node.
 *
 * Only fires for primary-viewport edits on plain (non-responsive) text
 * elements. The sync writes the editor's HTML into every other viewport's
 * matching `[data-node-id]` element so tablet/mobile previews update
 * keystroke-by-keystroke instead of waiting for commit.
 *
 * Skipped when:
 *   - The user is editing on a non-primary viewport: only that viewport
 *     should reflect their typing because the edit is going to land as a
 *     per-viewport override at commit time. Other viewports keep their own
 *     committed text.
 *   - The element uses `useResponsiveText` (detected by editing on a node
 *     whose JSX wraps text in the hook): each viewport's React subtree
 *     resolves the hook independently, so syncing DOM here would fight
 *     React's reconciler. Cleaner to let commit + flush refresh from JSX.
 */
function syncReplicaHtml(html: string): void {
  if (!contentRoot || !activeNodeId || !activeElement) return;
  if (activeVpPrefix !== '') return;
  // Skip when the active node is responsive — see function comment.
  if (responsiveActiveNode) return;

  // Walk up to find the active viewport root, then iterate all viewports
  // and write to each one's matching node element. Replicas are addressed
  // by exact data-node-id (`${vpId}-${nodeId}` non-primary, just `${nodeId}`
  // primary) — no prefix-pattern guessing.
  let activeVpEl: Element | null = activeElement.parentElement;
  while (activeVpEl && activeVpEl !== contentRoot && !activeVpEl.hasAttribute('data-viewport')) {
    activeVpEl = activeVpEl.parentElement;
  }

  const viewports = contentRoot.querySelectorAll('[data-viewport]');
  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i];
    if (vp === activeVpEl) continue;
    const vpId = vp.getAttribute('data-viewport');
    if (!vpId) continue;
    const isPrimary = vp.hasAttribute('data-viewport-primary');
    // A tile whose variant has its OWN text override keeps its committed
    // content — mirroring the primary's keystrokes into it would show the
    // wrong text for the whole session (see syncExcludeVpIds).
    if (syncExcludeVpIds.has(vpId)) continue;
    const targetId = isPrimary ? activeNodeId : `${vpId}-${activeNodeId}`;
    const target = findElByNodeId<Element>(vp, '', targetId);
    if (!target || target === activeElement) continue;
    (target as HTMLElement).innerHTML = html;
  }
}

/** Tracks whether the currently-edited node uses `useResponsiveText` so the
 *  live-sync logic can short-circuit. Set at startTextEdit, cleared on
 *  cancel/commit. Detected structurally — see startTextEdit. */
let responsiveActiveNode = false;

/** Tile vpIds whose VARIANT carries its own text override (conditionalText /
 *  a per-variant text variable) — passed by the parent at startTextEdit.
 *  The live keystroke mirror (syncReplicaHtml) skips these: typing on the
 *  primary was overwriting every tile INCLUDING ones with their own content
 *  (restored only at commit — the mid-typing "all variants sync" report,
 *  2026-08-05; the same mirror also fired for panel font-size edits during
 *  an active session, since a TipTap mark transaction is a content change). */
let syncExcludeVpIds = new Set<string>();

// ─── FIT text live re-fit (while typing) ─────────────────────────────────
// When the edited element sits inside a FIT wrapper (`<svg data-node-id=…-svg>`
// + foreignObject), every keystroke must re-solve the fit — keep the box
// WIDTH, shrink/grow the font so the longest line fits, adjust the viewBox
// height — so the user always sees the FINAL fitted result as they type.
// DOM-only (no code writes); the parent controller persists the same numbers
// at commit. Measured in THIS document (the iframe), where the page's fonts
// are guaranteed loaded.
let fitSvgEl: SVGSVGElement | null = null;
/** Font styles frozen at edit start — fontSize changes per re-fit, so it's
 *  intentionally NOT captured (the measure solves for it). lineHeight is the
 *  AUTHORED inline value when present (verbatim: unitless scales with the
 *  solved size, px stays fixed — both render-correct); else the computed
 *  px→ratio so it survives the size solve. */
let fitBaseStyles: { fontFamily: string; fontWeight: string; letterSpacing: string; lineHeight: string } | null = null;

/** The frozen viewBox WIDTH of the active FIT wrapper, or 0. */
function fitViewBoxWidth(): number {
  if (!fitSvgEl) return 0;
  const vb = (fitSvgEl.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  return vb.length === 4 && Number.isFinite(vb[2]) ? vb[2] : 0;
}

/** Apply re-fit values to the LIVE DOM: the edited copy + (for primary edits
 *  on non-responsive nodes) every other viewport's copy — same guard +
 *  viewport walk as syncReplicaHtml. */
function applyFitDom(viewBox: string, fontSize: number, marginTop: number): void {
  if (!fitSvgEl || !activeElement || !activeNodeId) return;
  fitSvgEl.setAttribute('viewBox', viewBox);
  // FIT contract: height AUTO (the viewBox owns the aspect). A fixed px height
  // (left over from a canvas drag round-trip) freezes the box while the aspect
  // changes per keystroke → mangled/stretched text. Self-heal live.
  const svgStyle = (fitSvgEl as unknown as HTMLElement).style;
  if (svgStyle.height && svgStyle.height !== 'auto') svgStyle.height = 'auto';
  activeElement.style.fontSize = `${fontSize}px`;
  activeElement.style.marginTop = `${marginTop}px`;
  if (!contentRoot || activeVpPrefix !== '' || responsiveActiveNode) return;
  const svgBareId = `${activeNodeId}-svg`;
  let activeVpEl: Element | null = activeElement.parentElement;
  while (activeVpEl && activeVpEl !== contentRoot && !activeVpEl.hasAttribute('data-viewport')) {
    activeVpEl = activeVpEl.parentElement;
  }
  const viewports = contentRoot.querySelectorAll('[data-viewport]');
  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i];
    if (vp === activeVpEl) continue;
    const vpId = vp.getAttribute('data-viewport');
    if (!vpId) continue;
    const isPrimary = vp.hasAttribute('data-viewport-primary');
    const svgTarget = findElByNodeId<Element>(vp, '', isPrimary ? svgBareId : `${vpId}-${svgBareId}`);
    if (svgTarget && svgTarget !== (fitSvgEl as unknown as Element)) {
      svgTarget.setAttribute('viewBox', viewBox);
    }
    const textTarget = findElByNodeId<Element>(vp, '', isPrimary ? activeNodeId : `${vpId}-${activeNodeId}`);
    if (textTarget && textTarget !== activeElement) {
      (textTarget as HTMLElement).style.fontSize = `${fontSize}px`;
      (textTarget as HTMLElement).style.marginTop = `${marginTop}px`;
    }
  }
}

/** Zero out any scroll the browser's caret-into-view induced on the edited
 *  chain. A FIT re-fit reflows the text mid-keystroke; if that momentarily
 *  pushes the caret outside an `overflow: hidden` ancestor (the typical FIT
 *  container), the browser SCROLLS that ancestor internally (scrollTop moves
 *  even on hidden overflow) — and never scrolls it back. Every child of that
 *  ancestor then renders shifted, the sandbox emits the shifted client rects,
 *  and ALL parent overlays / viewport headers go offset until reload (live
 *  find 2026-07-03). The canvas camera is transform-based — nothing inside
 *  the sandbox should EVER be scrolled — so resetting to 0 is always safe.
 *  Runs sync (cleans this keystroke) + rAF (wins over ProseMirror's own
 *  post-dispatch scrollIntoView, which fires after onUpdate returns). */
function resetInducedScroll(): void {
  const zero = () => {
    let cur: HTMLElement | null = activeElement;
    while (cur) {
      if (cur.scrollTop !== 0 || cur.scrollLeft !== 0) {
        trace.action('text-edit-host:fit-scroll-reset', { el: cur.getAttribute('data-node-id') || cur.tagName, top: cur.scrollTop, left: cur.scrollLeft });
        cur.scrollTop = 0;
        cur.scrollLeft = 0;
      }
      cur = cur.parentElement;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  zero();
  requestAnimationFrame(zero);
}

function liveRefitFitText(html: string): void {
  if (!fitSvgEl || !fitBaseStyles || !activeElement || !activeNodeId) return;
  const vbWidth = fitViewBoxWidth();
  if (!vbWidth) return;
  const refit = measureFitRefit(html, fitBaseStyles, vbWidth, document);
  if (!refit) return;
  applyFitDom(`0 0 ${vbWidth} ${refit.height}`, refit.fontSize, refit.marginTop);
  resetInducedScroll();
  trace.action('text-edit-host:fit-live-refit', { nodeId: activeNodeId, vbWidth, ...refit });
}

/** Final authoritative re-fit for the COMMIT payload. Runs one more measure on
 *  the committed html (covers paste / no-typing edits the live path may have
 *  missed), applies it to the DOM (no flash before the Renderer rebuild), and
 *  returns the numbers for the parent to persist to CODE. The parent cannot
 *  measure or touch this document (cross-origin iframe) — this is the ONLY
 *  source of the committed fit values. */
function computeFinalFit(html: string): TextEditFitResult | undefined {
  if (!fitSvgEl || !fitBaseStyles || !activeElement || !activeNodeId) return undefined;
  const vbWidth = fitViewBoxWidth();
  if (!vbWidth) return undefined;
  const svgNodeId = fitSvgEl.getAttribute('data-id') || `${activeNodeId}-svg`;
  const refit = measureFitRefit(html, fitBaseStyles, vbWidth, document);
  if (!refit) return undefined;
  const viewBox = `0 0 ${vbWidth} ${refit.height}`;
  applyFitDom(viewBox, refit.fontSize, refit.marginTop);
  resetInducedScroll();
  trace.action('text-edit-host:fit-final', { nodeId: activeNodeId, svgNodeId, viewBox, fontSize: refit.fontSize, marginTop: refit.marginTop });
  return { svgNodeId, viewBox, fontSize: refit.fontSize, marginTop: refit.marginTop };
}

// ─── Public API (called by bridge-sandbox.ts) ────────────────────────────

export function startTextEdit(
  nodeId: string,
  vpPrefix: string,
  initialHtml?: string,
  isResponsive?: boolean,
  /** Tile vpIds (variant names on a component master) whose variant carries
   *  its OWN text override — the live keystroke mirror must not touch them.
   *  See syncReplicaHtml. */
  syncExcludeVpIdList?: string[],
): void {
  if (activeEditor) {
    // Already editing — clean up before starting a new one.
    cancelTextEdit();
  }
  if (!contentRoot) return;

  const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
  if (!el) {
    emit({
      type: 'error',
      message: `text-edit-host: element not found for ${vpPrefix}${nodeId}`,
    });
    return;
  }

  activeNodeId = nodeId;
  activeVpPrefix = vpPrefix;
  activeElement = el;

  // FIT wrapper detection: the edited text lives inside
  // `<svg data-node-id="…-svg"><foreignObject>` → enable the live per-keystroke
  // re-fit (see liveRefitFitText). Base font styles are read COMPUTED from the
  // element in this document (fonts loaded here), frozen for the session.
  fitSvgEl = null;
  fitBaseStyles = null;
  const svgAncestor = el.closest('svg');
  if (svgAncestor && (svgAncestor.getAttribute('data-node-id') || '').endsWith('-svg')) {
    fitSvgEl = svgAncestor as unknown as SVGSVGElement;
    const cs = getComputedStyle(el);
    const lhAuthored = el.style.lineHeight;
    const lhComputed = (cs.lineHeight !== 'normal' && parseFloat(cs.fontSize) > 0)
      ? String(Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 10000) / 10000)
      : '';
    fitBaseStyles = {
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      letterSpacing: cs.letterSpacing === 'normal' ? '' : cs.letterSpacing,
      lineHeight: lhAuthored || lhComputed,
    };
    trace.action('text-edit-host:fit-detected', { nodeId, svgNodeId: svgAncestor.getAttribute('data-node-id') });
  }

  // Live size sync: every reflow of the editable element pushes a fresh
  // rectUpdate + cornersUpdate to the parent. This keeps cornersCache aligned
  // with what the user sees as they type, so when they exit text-edit mode
  // the SelectionOverlay can re-mount instantly at the right size — no wait
  // for the post-commit allRects round-trip.
  if (liveSizeObserver) liveSizeObserver.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    liveSizeObserver = new ResizeObserver(() => {
      if (!activeElement || !activeNodeId) return;
      try {
        const r = activeElement.getBoundingClientRect();
        emit({
          type: 'rectUpdate',
          nodeId: activeNodeId,
          vpPrefix: activeVpPrefix,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        });
        emit({
          type: 'cornersUpdate',
          nodeId: activeNodeId,
          vpPrefix: activeVpPrefix,
          corners: getScreenCorners(activeElement),
        });
      } catch { /* element detached mid-observe */ }
    });
    liveSizeObserver.observe(el);
  }
  // Parent sets this when the node uses `useResponsiveText`. With the hook,
  // each viewport's React subtree resolves its own variant — DOM-mirroring
  // the editor's HTML to other replicas would briefly overwrite their
  // hook-resolved values until the next render. Skip sync entirely for
  // responsive nodes; commit-time JSX update propagates to all viewports.
  responsiveActiveNode = !!isResponsive;
  syncExcludeVpIds = new Set(syncExcludeVpIdList ?? []);
  trace.action('text-edit-host:session-config', {
    nodeId, vpPrefix, isResponsive: !!isResponsive, syncExcludeVpIds: [...syncExcludeVpIds],
  });

  // Mark the element so the renderer's diff loop skips it (data-editing guard
  // already exists in patchElement). Also so CSS reset / other systems can
  // know an element is in edit mode.
  el.setAttribute('data-editing', 'true');

  // Paint the edit-time accent outline directly on the iframe element. The
  // selector matches by node id so any later re-render that rebuilds the
  // element keeps the outline. Width is scaled relative to viewport so the
  // outline reads at a consistent thickness across zoom levels.
  injectEditOutline(nodeId, vpPrefix);

  // Capture current HTML BEFORE clearing — TipTap's `new Editor({ element })`
  // APPENDS its prosemirror DOM as a sibling rather than replacing children.
  // Without clearing first the user sees the original text on top AND the
  // editable copy underneath (the duplicate-text bug).
  //
  // Prefer the iframe element's live innerHTML over any caller-supplied
  // initialHtml. The parent passes empty for re-edits because its
  // node.textContent is RAW JSX for mixed-content nodes (style={{...}}),
  // which TipTap can't parse — falling back to live HTML preserves
  // per-portion marks (font sizes, colors, etc.). Caller-supplied content
  // is only honored when the live element is empty (e.g. brand-new node).
  const liveHtml = el.innerHTML;
  const html = liveHtml || initialHtml || '';
  el.innerHTML = '';

  activeEditor = new Editor({
    element: el,
    // TipTap will replace the element's children with its own ProseMirror
    // structure on init. That's fine — the wrapping element keeps all its
    // styles (fontSize, fontWeight, etc.) so visuals don't change.
    extensions: [
      StarterKit.configure({
        paragraph: { HTMLAttributes: {} },
        hardBreak: { keepMarks: true, HTMLAttributes: {} },
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      FontWeight,
      LetterSpacing,
      LineHeight,
      TextDecoration,
      TextTransform,
      TextDecorationMark,
      GradientTextMark,
      TextFillColorMark,
      TextStrokeMark,
      Highlight.configure({ multicolor: true }),
      EnterHardBreak,
    ],
    content: html,
    // ProseMirror's DOM parser COLLAPSES leading/trailing whitespace by
    // default when seeding from HTML — so double-clicking a text that was
    // committed with a meaningful edge space (`Time - `) re-entered edit mode
    // already TRIMMED, and the next commit persisted the loss. 'full'
    // preserves the element's whitespace exactly as rendered (the element
    // shows it via white-space: pre-wrap; the editor's own .ProseMirror rule
    // is pre-wrap too, so visuals stay identical).
    parseOptions: { preserveWhitespace: 'full' },
    autofocus: 'all',
    editorProps: {
      // Match the non-edit wrap behavior: don't override word-wrap /
      // overflow-wrap / white-space / word-break. The element's own inline
      // styles (e.g. `overflow-wrap: break-word` from TextCreator) decide
      // how long unspaced strings break. Forcing `overflow-wrap: normal`
      // here previously made the editor render long words on one
      // overflowing line while the committed `<p>` wrapped them — a
      // visible jump on commit.
      //
      // ProseMirror's default stylesheet sets `white-space: pre-wrap` on
      // the `.ProseMirror` selector, which is fine: whitespace handling
      // during editing preserves typed spaces, and combined with the
      // element's `overflow-wrap: break-word` long words still break at
      // the box edge — matching non-edit appearance.
      attributes: {
        style: 'outline: none; cursor: text; margin: 0; padding: 0;',
      },
    },
    onTransaction: ({ editor }) => {
      try {
        emit({ type: 'textEditSelectionChanged', snapshot: buildSnapshot(editor) });
      } catch (err) {
        emit({
          type: 'error',
          message: `text-edit-host: snapshot failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Stream live HTML for any parent-side preview that needs it. The
      // canvas element itself already shows the latest content because the
      // editor mounts on it directly.
      emit({ type: 'textEditContentChanged', html });
      // Live replica sync — push the same HTML into every replica of this
      // node so tablet/mobile viewports update on each keystroke instead of
      // waiting for commit. The editor's own element (primary or whichever
      // viewport the user double-clicked from) is owned by TipTap; setting
      // innerHTML there would tear down ProseMirror's tree and lose the
      // selection/cursor. We skip it explicitly via the activeElement
      // identity check.
      syncReplicaHtml(html);
      // FIT text: re-solve the fit per keystroke (viewBox height + font size,
      // box width fixed) so the user always sees the final fitted layout.
      liveRefitFitText(html);
    },
  });

  // ─── Outside-click and Escape handlers ───────────────────────────────
  outsideClickListener = (e: MouseEvent) => {
    if (!activeElement) return;
    const target = e.target as Node | null;
    if (target && activeElement.contains(target)) return;
    // User clicked outside the editing element — commit.
    const { html, fit } = captureAndDestroy();
    emit({ type: 'textEditCommitted', html, fit });
  };
  escapeListener = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const { html, fit } = captureAndDestroy();
    emit({ type: 'textEditCommitted', html, fit });
  };
  // mousedown rather than click — so we commit before the click triggers a
  // selection change in the canvas.
  document.addEventListener('mousedown', outsideClickListener, true);
  document.addEventListener('keydown', escapeListener, true);

  // Bubble-phase stopPropagation on the editing element. Order during a
  // mousedown inside the editor:
  //   1. Capture: document (outsideClickListener — checks inside/outside)
  //   2. Target + bubble starts at the actual click point (e.g. <p>)
  //   3. Bubble reaches ProseMirror's .ProseMirror div → its handler fires
  //      and positions the cursor / starts text-range selection
  //   4. Bubble reaches our editing element → THIS listener stops propagation
  //   5. canvas-dnd's mousedown listener on adapterRoot never sees the event
  //
  // Without this, canvas-dnd calls `e.preventDefault()` on bubble at the
  // iframe root, which cancels the contentEditable cursor placement and
  // forwards a "clicked an element" message to the parent — exiting edit
  // mode every time the user tries to position the cursor.
  elementMousedownStopper = (e: MouseEvent) => {
    e.stopPropagation();
  };
  el.addEventListener('mousedown', elementMousedownStopper);

  // Track the user's intentional selection. Mouseup fires after a click /
  // drag-select inside the editor has fully resolved; keyup fires after
  // shift-arrow expansion. Both moments mark "this is the selection the
  // user wants" — we snapshot it so toolbar commands can restore it after
  // any iframe-blur-induced collapse.
  intentionalSelectionMouseupListener = () => {
    if (!activeEditor) return;
    const { from, to } = activeEditor.state.selection;
    intentionalSelection = { from, to };
  };
  intentionalSelectionKeyupListener = () => {
    if (!activeEditor) return;
    const { from, to } = activeEditor.state.selection;
    intentionalSelection = { from, to };
  };
  // DOCUMENT-level, not element-level: a drag-selection frequently RELEASES
  // outside the text element (sweeping to a word at the edge), so an
  // element-scoped mouseup never recorded the range — the next toolbar
  // command then found no intentional selection, hit the collapsed-cursor
  // fallback and applied to the WHOLE text (the "color/font applies to all
  // instead of the selected portion" find, 2026-07-23).
  document.addEventListener('mouseup', intentionalSelectionMouseupListener);
  document.addEventListener('keyup', intentionalSelectionKeyupListener);
}

export function commitTextEdit(): { html: string; fit?: TextEditFitResult } {
  if (!activeEditor) return { html: '' };
  return captureAndDestroy();
}

export function cancelTextEdit(): void {
  if (!activeEditor) return;
  destroyEditor();
  emit({ type: 'textEditCancelled' });
}

export function runEditorCommand(command: TextEditCommand): void {
  trace.action('text-edit-host:runEditorCommand', { command, hasEditor: !!activeEditor });
  if (!activeEditor) {
    trace.error('text-edit-host:runEditorCommand:no-editor', { command });
    return;
  }
  const editor = activeEditor;

  // Toolbar clicks happen in the parent frame; the iframe's contenteditable
  // loses focus during the click, which can cause ProseMirror to collapse
  // its visible selection. Restore the user's most recent intentional
  // selection (captured at mouseup / keyup) so the command applies to the
  // range they selected, not whatever cursor position the blur left behind.
  if (intentionalSelection) {
    const { from: iFrom, to: iTo } = intentionalSelection;
    const live = editor.state.selection;
    if (live.from !== iFrom || live.to !== iTo) {
      // Bound the saved range to the current doc size in case content
      // changed since capture (extremely rare while editing, but safe).
      const docSize = editor.state.doc.content.size;
      const safeFrom = Math.max(0, Math.min(iFrom, docSize));
      const safeTo = Math.max(0, Math.min(iTo, docSize));
      editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
    }
  }

  const sel = editor.state.selection;
  const { from, to } = sel;
  const cursor = from === to;
  trace.action('text-edit-host:runEditorCommand', {
    command,
    selection: { from, to, cursor },
    intentional: intentionalSelection,
    isFocused: editor.isFocused,
    docSize: editor.state.doc.content.size,
  });

  switch (command.kind) {
    case 'mark': {
      const { property, value } = command;
      // Empty / null value → unset the attribute on the textStyle mark by
      // setting it to null. TipTap's setMark with null clears.
      if (cursor) {
        // Cursor-only: select all so the mark applies to the whole element,
        // then restore cursor position. Matches existing useTextStyles
        // behavior for cursor-mode writes.
        editor
          .chain()
          .focus()
          .selectAll()
          .setMark('textStyle', { [property]: value || null })
          .setTextSelection(from)
          .run();
      } else {
        editor.chain().focus().setMark('textStyle', { [property]: value || null }).run();
      }
      return;
    }
    case 'paragraph': {
      const { property, value } = command;
      editor.chain().focus().updateAttributes('paragraph', { [property]: value || null }).run();
      return;
    }
    case 'highlight': {
      const { value } = command;
      const isClear = !value || value === 'transparent' || value === 'none';
      if (cursor) {
        if (isClear) {
          editor
            .chain()
            .focus()
            .selectAll()
            .unsetHighlight()
            .setTextSelection(from)
            .run();
        } else {
          editor
            .chain()
            .focus()
            .selectAll()
            .setHighlight({ color: value })
            .setTextSelection(from)
            .run();
        }
      } else {
        if (isClear) editor.chain().focus().unsetHighlight().run();
        else editor.chain().focus().setHighlight({ color: value }).run();
      }
      return;
    }
    case 'gradient': {
      const { value } = command;
      if (cursor) {
        if (!value) {
          editor
            .chain()
            .focus()
            .selectAll()
            .setMark('textStyle', { backgroundGradient: null })
            .setTextSelection(from)
            .run();
        } else {
          // textFillColor: null — a run that was previously made SOLID carries
          // an opaque `-webkit-text-fill-color` mark (TextFillColorMark), and
          // fill-color paints glyphs OVER the clipped gradient background: the
          // gradient would apply but stay invisible ("switch back to gradient
          // doesn't switch in the DOM", 2026-08-07). Applying a gradient claims
          // the run's whole glyph-paint channel.
          editor
            .chain()
            .focus()
            .selectAll()
            .setMark('textStyle', { backgroundGradient: value, color: 'transparent', textFillColor: null })
            .setTextSelection(from)
            .run();
        }
      } else {
        if (!value) {
          editor.chain().focus().setMark('textStyle', { backgroundGradient: null }).run();
        } else {
          editor
            .chain()
            .focus()
            .setMark('textStyle', { backgroundGradient: value, color: 'transparent', textFillColor: null })
            .run();
        }
      }
      return;
    }
  }
}

// ─── Internals ───────────────────────────────────────────────────────────

function captureAndDestroy(): { html: string; fit?: TextEditFitResult } {
  if (!activeEditor) return { html: '' };
  const html = activeEditor.getHTML();
  const el = activeElement; // capture before destroyEditor nulls it
  // FIT text: one final authoritative re-fit for the commit payload — must run
  // BEFORE destroyEditor (it reads fitSvgEl / activeElement module state).
  const fit = computeFinalFit(html);
  destroyEditor();
  // After destroy, TipTap leaves its prosemirror wrapper DOM inside the
  // element. Reset to the canonical HTML so the canvas element matches
  // what we're about to persist into code. The Renderer's next patch will
  // overwrite anyway, but in the meantime the user keeps seeing the
  // correct content (no flash of nested wrappers).
  if (el) {
    try {
      el.innerHTML = html;
    } catch {
      /* element gone — ignore */
    }
  }
  return { html, fit };
}

function destroyEditor(): void {
  if (liveSizeObserver) {
    // Emit one final rect/corners snapshot before tearing down so the parent
    // has fresh values cached for the moment SelectionOverlay re-mounts.
    if (activeElement && activeNodeId) {
      try {
        const r = activeElement.getBoundingClientRect();
        emit({
          type: 'rectUpdate',
          nodeId: activeNodeId,
          vpPrefix: activeVpPrefix,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        });
        emit({
          type: 'cornersUpdate',
          nodeId: activeNodeId,
          vpPrefix: activeVpPrefix,
          corners: getScreenCorners(activeElement),
        });
      } catch { /* ignore */ }
    }
    liveSizeObserver.disconnect();
    liveSizeObserver = null;
  }
  if (outsideClickListener) {
    document.removeEventListener('mousedown', outsideClickListener, true);
    outsideClickListener = null;
  }
  if (escapeListener) {
    document.removeEventListener('keydown', escapeListener, true);
    escapeListener = null;
  }
  if (elementMousedownStopper && activeElement) {
    activeElement.removeEventListener('mousedown', elementMousedownStopper);
  }
  elementMousedownStopper = null;
  if (intentionalSelectionMouseupListener) {
    document.removeEventListener('mouseup', intentionalSelectionMouseupListener);
  }
  intentionalSelectionMouseupListener = null;
  if (intentionalSelectionKeyupListener) {
    document.removeEventListener('keyup', intentionalSelectionKeyupListener);
  }
  intentionalSelectionKeyupListener = null;
  intentionalSelection = null;
  if (activeElement) {
    activeElement.removeAttribute('data-editing');
  }
  removeEditOutline();
  if (activeEditor) {
    try {
      activeEditor.destroy();
    } catch {
      /* ignore — already torn down */
    }
  }
  activeEditor = null;
  activeNodeId = null;
  activeVpPrefix = '';
  activeElement = null;
  savedInlineStyles = null;
  responsiveActiveNode = false;
  syncExcludeVpIds = new Set();
  fitSvgEl = null;
  fitBaseStyles = null;
}

/** Add an outline to the editing element so the highlight grows / wraps
 *  with the live contentEditable. Idempotent — replaces any previous rule.
 *
 *  Visual target: match the parent-frame `SelectionBorder` component as
 *  closely as possible — same color (#3b82f6 = SELECTION_COLOR), thin
 *  weight, tight to the text. Selection border is 1.5px in SCREEN space;
 *  this outline is in IFRAME space (subject to canvas zoom). 1px reads
 *  thinner than 2px and gives a much tighter feel; outline-offset:0
 *  removes the padding gap that made the edit border look totally
 *  different from the selection border the user sees pre-edit.
 *
 *  Also hides canvas-dnd's hover / selection overlays during edit. While
 *  the user is typing, every mousemove inside the iframe would otherwise
 *  flash a hover highlight on whatever element is under the cursor — the
 *  editing element should be the only thing visually "active" until commit. */
function injectEditOutline(nodeId: string, vpPrefix: string): void {
  if (!editOutlineStyleEl) {
    editOutlineStyleEl = document.createElement('style');
    editOutlineStyleEl.setAttribute('data-text-edit-outline', 'true');
    document.head.appendChild(editOutlineStyleEl);
  }
  const sel = `${nodeIdSelector(vpPrefix, nodeId)}[data-editing]`;
  editOutlineStyleEl.textContent = `
    ${sel} {
      outline: 1px solid #3b82f6 !important;
      outline-offset: 0 !important;
      border-radius: 0 !important;
    }
    /* Hide canvas-dnd's hover/select/handle overlays during text edit so
       moving the mouse over other elements doesn't flash a hover ring. */
    #dnd-overlay { display: none !important; }
  `;
}

function removeEditOutline(): void {
  if (editOutlineStyleEl) {
    editOutlineStyleEl.remove();
    editOutlineStyleEl = null;
  }
}

/**
 * Walk the current selection and compute per-property mixed/uniform values.
 * Mirrors what useTextStyles.get used to do locally with editor.state, only
 * now produced at transaction time inside the iframe and shipped to parent.
 */
function buildSnapshot(editor: Editor): TextEditSnapshot {
  const { from, to } = editor.state.selection;
  const cursorMode = from === to;

  const marks: Record<string, TextEditValue> = {};
  const paragraph: Record<string, TextEditValue> = {};

  // Initialize collectors.
  const markValues: Record<string, Set<string>> = {};
  const paraValues: Record<string, Set<string>> = {};
  const highlightValues = new Set<string>();
  for (const p of MARK_PROPS) markValues[p] = new Set();
  for (const p of PARAGRAPH_PROPS) paraValues[p] = new Set();

  if (!cursorMode) {
    editor.state.doc.nodesBetween(from, to, (node: any) => {
      if (node.type?.name === 'paragraph') {
        for (const p of PARAGRAPH_PROPS) {
          paraValues[p].add(node.attrs?.[p] || '');
        }
      }
      if (node.isText && Array.isArray(node.marks)) {
        const textStyleMark = node.marks.find((m: any) => m.type?.name === 'textStyle');
        for (const p of MARK_PROPS) {
          markValues[p].add(textStyleMark?.attrs?.[p] || '');
        }
        const highlightMark = node.marks.find((m: any) => m.type?.name === 'highlight');
        highlightValues.add(highlightMark?.attrs?.color || '');
      }
    });
  }

  for (const p of MARK_PROPS) marks[p] = collapse(markValues[p]);
  for (const p of PARAGRAPH_PROPS) paragraph[p] = collapse(paraValues[p]);
  const highlight = collapse(highlightValues);

  // Cursor-mode fallbacks.
  const cursorMarkAttrs: Record<string, string> = {};
  const cursorParagraphAttrs: Record<string, string> = {};
  let cursorHighlightAttr = '';
  if (cursorMode) {
    const ts = editor.getAttributes('textStyle');
    for (const p of MARK_PROPS) {
      if (ts[p]) cursorMarkAttrs[p] = ts[p];
    }
    const para = editor.getAttributes('paragraph');
    for (const p of PARAGRAPH_PROPS) {
      if (para[p]) cursorParagraphAttrs[p] = para[p];
    }
    const hl = editor.getAttributes('highlight');
    if (hl?.color) cursorHighlightAttr = hl.color;
  }

  return {
    cursorMode,
    from,
    to,
    marks,
    paragraph,
    highlight,
    cursorMarkAttrs,
    cursorParagraphAttrs,
    cursorHighlightAttr,
  };
}

function collapse(values: Set<string>): TextEditValue {
  // Drop the empty placeholder value used to mark "this text node had no
  // such attribute". Empties don't count as a distinct mixed value.
  const nonEmpty = [...values].filter(Boolean);
  const distinct = new Set(nonEmpty);
  if (distinct.size > 1) {
    return { value: '', mixedValues: [...distinct], isMixed: true };
  }
  if (distinct.size === 1) {
    return { value: nonEmpty[0], mixedValues: [], isMixed: false };
  }
  return { value: '', mixedValues: [], isMixed: false };
}

/** True if the host currently has an active editor. Used by sandbox-side
 *  systems that need to skip patching while editing. */
export function isTextEditing(): boolean {
  return activeEditor !== null;
}

/** The currently editing node id (for diagnostic / matching). */
export function getActiveTextEditNodeId(): string | null {
  return activeNodeId;
}
