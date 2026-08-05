// src/canvas/text-edit/CanvasTextEditController.ts
//
// Owns the text-edit commit pipeline extracted from Canvas.tsx.
// Manages refs that were previously in the Canvas component:
//   editingNodeId, editingVpId, emptyFrameScaffold
//
// Constructor: { jotaiStore, bridge, iframeRef, renderer, getInteractingVpId }

import type { useStore } from 'jotai';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import type { CanvasRenderer } from '../CanvasRenderer';
import type { TextEditFitResult } from '@/canvas-sandbox/protocol';
import {
  nodesAtom,
  selectedIdsAtom,
  hoveredIdAtom,
  hoveredNodeIdAtom,
  mapContextAtom,
  mapItemIndexAtom,
} from '@/code/stores/store';
import {
  activeFilePathAtom,
  filePathToSlug,
  isComponentFilePath,
} from '@/code/project/active-file-store';
import {
  selectionStylesAtom,
  isTextEditingAtom,
  textEditSnapshotAtom,
} from '@/code/stores/editor-store';
import {
  activeLocaleAtom,
  isDefaultLocaleAtom,
  localeOverridesAtom,
  i18nConfigAtom,
} from '@/code/stores/locale-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import {
  transformTextToTranslation,
  setMessageValue,
  getMessageValue,
  nodeHasTranslationCall,
} from '@/code/generation/i18n-gen';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { propagateToGhosts } from '@/code/generation/map-ghost-propagate';
import { removeNode, getContentRoot, getViewportPrefix } from '../node-ops';
import { isEmptyTextEditHtml } from '@/shared/dom-utils';
import { stripGhostSuffix } from '@/shared/ghost-id';
import { toCamel } from '@/shared/css-utils';
import { foldFitParagraphsToBr } from '@/shared/fit-measure';
import { trace } from '@/shared/debug-trace';
import { holdHistoryCoalescing, releaseHistoryCoalescing } from '@/code/mutation/history';

type JotaiStore = ReturnType<typeof useStore>;

export interface CanvasTextEditControllerOptions {
  jotaiStore: JotaiStore;
  bridge: PostMessageBridge;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  renderer: CanvasRenderer;
  /** Returns the current interacting-viewport ID (mirrors interactingVpIdRef in Canvas). */
  getInteractingVpId: () => string;
}

export class CanvasTextEditController {
  private editingNodeId: string | null = null;
  private editingVpId: string = 'desktop';
  private emptyFrameScaffold: { frameId: string; textId: string } | null = null;

  private readonly store: JotaiStore;
  private readonly bridge: PostMessageBridge;
  private readonly iframeRef: React.RefObject<HTMLIFrameElement | null>;
  private readonly renderer: CanvasRenderer;
  private readonly getInteractingVpId: () => string;

  constructor(opts: CanvasTextEditControllerOptions) {
    this.store = opts.jotaiStore;
    this.bridge = opts.bridge;
    this.iframeRef = opts.iframeRef;
    this.renderer = opts.renderer;
    this.getInteractingVpId = opts.getInteractingVpId;
    trace.fn('CanvasTextEditController.constructor', {});
  }

  // ─── Public getters ────────────────────────────────────────────────────────

  isEditing(): boolean {
    return this.editingNodeId !== null;
  }

  getEditingNodeId(): string | null {
    return this.editingNodeId;
  }

  getEditingVpId(): string {
    return this.editingVpId;
  }

  /** Set / clear the empty-frame scaffold that should be reverted on empty commit or cancel. */
  setEmptyFrameScaffold(scaffold: { frameId: string; textId: string } | null): void {
    trace.action('canvas:empty-frame-scaffold-set', { scaffold });
    this.emptyFrameScaffold = scaffold;
  }

  // ─── Revert empty-frame dblclick scaffold ─────────────────────────────────

  /** Undo the empty-frame quick-text scaffold: remove the inserted text node
   *  AND clear the centered-flex styles we wrote on the frame. Called when
   *  the user dismisses the editor (commit-with-empty-content or cancel)
   *  before typing anything. No-op if no empty-frame dblclick is pending. */
  revertEmptyFrameDblclickIfPending(): void {
    const pending = this.emptyFrameScaffold;
    if (!pending) return;
    this.emptyFrameScaffold = null;
    const contentEl = getContentRoot();
    if (!contentEl) return;
    // 1. Remove the throwaway text node (DOM + cache + queued removeNode).
    removeNode({ id: pending.textId, contentEl });
    // 2. Clear the layout we applied to the frame. Empty-string values
    //    delete the property in the generator + cache + DOM.
    queueMutation({
      type: 'updateStyles',
      nodeId: pending.frameId,
      styles: {
        display: '', flexDirection: '', alignItems: '', justifyContent: '',
      },
    });
    // 3. Flush so the revert lands in code in the same frame the user
    //    dismissed the editor — same instant-feedback rationale as the
    //    initial empty-frame insertion's flushNow().
    flushNow();
    // 4. Reset selection — but DEFER to a RAF so any racing `dndSelect`
    //    message from the same outside-click (canvas-dnd in the iframe
    //    sees the click bubble AFTER the outsideClickListener already
    //    fired textEditCommitted, and emits its own selection event)
    //    can't overwrite us with the stale text-node id. The two
    //    iframe→parent messages process as separate tasks; deferring
    //    one task ensures we land last.
    requestAnimationFrame(() => {
      this.store.set(selectedIdsAtom, [pending.frameId]);
      this.store.set(hoveredIdAtom, null);
      this.store.set(hoveredNodeIdAtom, null);
    });
    trace.action('canvas:empty-frame-dblclick-revert', pending);
  }

  // ─── commitEditWithHtml ────────────────────────────────────────────────────

  /**
   * Persist a committed text edit. `html` comes from the sandbox-hosted
   * editor: either an explicit commit RPC (Esc shortcut, page switch) or the
   * `textEditCommitted` event (user clicked outside).
   *
   * Mirrors the original commitTextEditWithHtml's strip-p / locale / map / FIT logic;
   * only the editor-instance reads were replaced with the html parameter +
   * editingNodeId.
   */
  commitEditWithHtml(html: string, fit?: TextEditFitResult): void {
    // Every commit path funnels here (explicit RPC, outside-click push) —
    // reclaim keyboard focus up front so early returns are covered too.
    this.reclaimKeyboardFocus();
    releaseHistoryCoalescing();
    try {
      const editTargetId = this.editingNodeId;
      if (!editTargetId) return;
      // For .map() ghost edits the editing target carries a `__N` suffix on
      // its id (so TipTap mounted on the ghost element). Downstream commit
      // logic — nodes.get(nodeId), updateStyles, map binding lookup —
      // operates on the canonical (template) node id.
      const nodeId = stripGhostSuffix(editTargetId);

      // Empty-frame quick-text revert: if this commit is for the throwaway
      // text we inserted on a double-click of an empty frame AND the user
      // didn't actually type anything, undo the whole scaffold (text node
      // + flex layout) and skip the regular commit pipeline. Emptiness
      // detection is centralized in `isEmptyTextEditHtml` (shared/dom-
      // utils) so the same TipTap empty-shapes are recognized everywhere.
      const pendingScaffold = this.emptyFrameScaffold;
      if (pendingScaffold && pendingScaffold.textId === nodeId) {
        const isEmpty = isEmptyTextEditHtml(html);
        trace.action('canvas:empty-frame-dblclick-commit-check', {
          textId: pendingScaffold.textId, frameId: pendingScaffold.frameId,
          html: (html || '').slice(0, 80), isEmpty,
        });
        if (isEmpty) {
          this.editingNodeId = null;
          if (this.iframeRef.current) this.iframeRef.current.style.pointerEvents = 'none';
          this.store.set(isTextEditingAtom, false);
          this.store.set(textEditSnapshotAtom, null);
          this.store.set(selectionStylesAtom, {});
          // CRITICAL: reset the renderer's text-editing gate. `startTextEdit`
          // turned it on to suppress mid-edit re-renders that
          // would tear down TipTap's DOM. The regular commit path resets it
          // via the post-mutation rAF after `queueMutation`. This branch
          // skips that mutation entirely, so without this reset the
          // renderer stays stuck "editing" and every subsequent canvas
          // change (frame creation, dblclick, anything) is silently
          // skipped — that was the "everything stale after cancel" bug.
          this.renderer.setTextEditing(false);
          this.revertEmptyFrameDblclickIfPending();
          return;
        }
        // User typed something — keep the scaffold, fall through to the
        // normal commit. Clear the ref so a subsequent edit of this same
        // text node (where emptiness is the user's actual choice) doesn't
        // false-trigger the revert.
        this.emptyFrameScaffold = null;
      }
      // Strip <p> wrappers — TipTap wraps all content in <p> tags.
      // For single paragraph: extract inner content, move paragraph styles to parent node.
      // For multi paragraph: keep <p> tags as mixed content.
      // Count paragraphs
      const pCount = (html.match(/<\/p>/g) || []).length;
      let inner: string;

      if (pCount <= 1) {
        // Single paragraph — strip the <p> wrapper entirely
        // Extract any paragraph-level styles and apply them to the node
        const pMatch = html.match(/^<p([^>]*)>([\s\S]*)<\/p>$/);
        if (pMatch) {
          inner = pMatch[2]; // just the content
          // Extract styles from <p> attributes and apply to node
          const styleMatch = pMatch[1].match(/style="([^"]*)"/);
          if (styleMatch && nodeId) {
            const styleStr = styleMatch[1];
            const pairs = styleStr.split(';').map(s => s.trim()).filter(Boolean);
            for (const pair of pairs) {
              const colonIdx = pair.indexOf(':');
              if (colonIdx === -1) continue;
              const prop = pair.slice(0, colonIdx).trim();
              const val = pair.slice(colonIdx + 1).trim();
              // Convert kebab to camel and apply to node
              const camelProp = toCamel(prop);
              queueMutation({ type: 'updateStyles', nodeId, styles: { [camelProp]: val } });
            }
          }
        } else {
          inner = html;
        }
      } else {
        // Multi paragraph — keep <p> tags for per-paragraph styles
        inner = html;
      }

      // Editor lives in the iframe — it's already torn down by the time we
      // get here (the textEditCommitted event fires AFTER captureAndDestroy
      // in text-edit-host). Just clear local refs.
      this.editingNodeId = null;
      // Restore the iframe's pointer-events: none so the parent's selection
      // / drag coordinator regains control of canvas clicks. We flipped it
      // to 'auto' in startEdit so ProseMirror could receive cursor /
      // selection events.
      if (this.iframeRef.current) {
        this.iframeRef.current.style.pointerEvents = 'none';
      }

      // Re-show selection overlay immediately. The sandbox's text-edit-host
      // ran a ResizeObserver on the contentEditable while the user was typing
      // and pushed `rectUpdate` + `cornersUpdate` on every reflow, so
      // cornersCache already holds the post-edit corners by the time we get
      // here. SelectionOverlay can re-mount this frame at the right size.
      this.store.set(isTextEditingAtom, false);
      this.store.set(textEditSnapshotAtom, null);
      this.store.set(selectionStylesAtom, {});
      // Defensive clear — if anything restored hoveredId during the session
      // (e.g. iframe-bridge late event), we don't want it driving overlays
      // against a stale rectCache once the edit ends.
      this.store.set(hoveredIdAtom, null);
      this.store.set(hoveredNodeIdAtom, null);

      // Locale-aware text commit (next-intl integration):
      //   - Rewrite the JSX so `<p>Hello</p>` becomes `<p>{t('id')}</p>`.
      //     Auto-injects `import { useTranslations } from 'next-intl'` and
      //     `const t = useTranslations('<pageSlug>')` if missing — the user
      //     never edits the actual code. Idempotent: subsequent edits skip
      //     the rewrite because the JSX already has a `t(...)` call.
      //   - Write the original text to `messages/{defaultLocale}.json` so the
      //     live Next.js site has the EN fallback (only first time we see
      //     this key — never overwrite an existing default-locale value).
      //   - Write the new translation to `messages/{activeLocale}.json`.
      //   - Keep the in-memory `localeOverridesAtom` update so the canvas
      //     editor's imperative Renderer reflects the change immediately.
      //   - messages/ files are the single persisted source of truth; the
      //     legacy i18n/{locale}.json dual-write was removed (Phase 1 of the
      //     localization overhaul).
      const isDefaultLocale = this.store.get(isDefaultLocaleAtom);
      const activeLocale = this.store.get(activeLocaleAtom);

      if (!isDefaultLocale) {
        const i18nConfigVal = this.store.get(i18nConfigAtom);
        const defaultLocale = i18nConfigVal?.defaultLocale ?? 'en';
        const filePath = this.store.get(activeFilePathAtom);
        const namespace = filePathToSlug(filePath); // e.g. 'home', 'about'
        const key = nodeId;

        // Replica detection — when the user edits text on a non-primary
        // viewport (tablet/mobile preview) the locale override needs to land
        // in `textOverrides[<vpWidth>]`, NOT in the flat `text` field, so
        // tablet-French stays independent of desktop-French. Without this,
        // any replica edit overwrites the primary translation.
        const editingVpId = this.editingVpId;
        const viewportsForLocale = this.store.get(viewportsConfigAtom);
        const primaryVpForLocale = viewportsForLocale.find(v => v.isPrimary) ?? viewportsForLocale[0];
        const editingVpForLocale = viewportsForLocale.find(v => v.id === editingVpId) ?? primaryVpForLocale;
        const primaryWidthForLocale = primaryVpForLocale?.width ?? 1440;
        const editingVpWidth = editingVpForLocale?.width ?? primaryWidthForLocale;
        const isReplicaEdit = editingVpWidth !== primaryWidthForLocale;

        // Pre-edit canvas text — the seed fallback. transformTextToTranslation
        // captures originalText from plain JSXText children only; on wrapped /
        // mixed-content nodes (motion wrappers, spans) it can come back empty
        // while the t() swap still happens. If the default message then never
        // gets seeded, the default locale renders EMPTY after the next full
        // rebuild (the "empty after page switch" half of the Peintre report).
        const preEditText = this.store.get(nodesAtom).get(nodeId)?.textContent ?? '';

        // 1. Transform the JSX (idempotent) + capture the original text.
        modifyProjectFile(filePath, (currentCode) => {
          const result = transformTextToTranslation(currentCode, nodeId, key, namespace);
          // 2. Seed the default-locale messages file so the live site AND
          //    the canvas default-locale view keep the original text.
          //    Never overwrite an existing value — once seeded, the default
          //    text is edited via the normal default-locale commit path.
          //    Seed even when the transform reports no change (an earlier
          //    partial commit may have swapped the JSX without seeding).
          const seedText = (result.changed && result.originalText) ? result.originalText : preEditText;
          if (seedText) {
            const defaultMsgPath = `messages/${defaultLocale}.json`;
            const defaultMsgRaw = projectFS.readFile(defaultMsgPath) ?? '{}';
            if (getMessageValue(defaultMsgRaw, namespace, key) === null) {
              const updated = setMessageValue(defaultMsgRaw, namespace, key, seedText);
              projectFS.writeFile(defaultMsgPath, updated);
              trace.action('locale:seed-default-message', {
                namespace, key, locale: defaultLocale,
                source: (result.changed && result.originalText) ? 'transform' : 'pre-edit-canvas',
              });
            }
          }
          return result.code;
        });

        // 3. Write the new translation to messages/{activeLocale}.json. For
        //    replica edits, suffix the key with `__<vpWidth>` so the entry
        //    coexists with the primary translation. (The live site's JSX
        //    needs a `useResponsiveText`-aware rewrite to consume these
        //    suffix keys — tracked separately. The canvas-side preview
        //    works off `localeOverridesAtom` below, which IS viewport-aware
        //    via the renderer's bucket logic.)
        const activeMsgPath = `messages/${activeLocale}.json`;
        const activeMsgRaw = projectFS.readFile(activeMsgPath) ?? '{}';
        const messageKey = isReplicaEdit ? `${key}__${editingVpWidth}` : key;
        const updatedActiveMsg = setMessageValue(activeMsgRaw, namespace, messageKey, inner);
        projectFS.writeFile(activeMsgPath, updatedActiveMsg);

        // 4. Mirror to the canvas-fast-render path so the editor reflects
        //    the new text immediately (Renderer reads localeOverridesAtom).
        //    Replica edits go into `textOverrides[<vpWidth>]`; primary edits
        //    keep using the flat `text` field so existing single-locale
        //    pages don't change shape.
        //    NOTE: messages/{locale}.json is the ONLY persisted store now —
        //    the legacy i18n/{locale}.json dual-write was dropped (it never
        //    reached the live site and drifted from messages; overhaul
        //    Phase 1, docs/localization/overhaul-plan.md).
        this.store.set(localeOverridesAtom, prev => {
          const next = new Map(prev);
          const existing = next.get(nodeId) || {};
          if (isReplicaEdit) {
            next.set(nodeId, {
              ...existing,
              textOverrides: {
                ...(existing.textOverrides || {}),
                [String(editingVpWidth)]: inner,
              },
            });
          } else {
            next.set(nodeId, { ...existing, text: inner });
          }
          return next;
        });
        trace.action('locale:text-commit', {
          nodeId, locale: activeLocale, namespace, key: messageKey,
          text: inner.slice(0, 50),
          replicaWidth: isReplicaEdit ? editingVpWidth : null,
        });
        // Renderer rebuild since we cleared innerHTML during the edit.
        this.renderer.setTextEditing(true);
        requestAnimationFrame(() => { this.renderer.setTextEditing(false); });
        return;
      }

      // Default-locale edit on a node whose JSX already contains `{t('id')}`:
      // routing the edit through `updateChildrenHTML` would overwrite the
      // translation call with plain text and break the live site. Write to
      // `messages/{defaultLocale}.json` instead — the JSX stays as-is, and
      // both the canvas (via localeOverridesAtom) and the live site (via
      // useTranslations) pick up the new value on next render.
      if (isDefaultLocale) {
        const filePath = this.store.get(activeFilePathAtom);
        const sourceCode = projectFS.readFile(filePath) ?? '';
        if (sourceCode && nodeHasTranslationCall(sourceCode, nodeId)) {
          const i18nConfigVal = this.store.get(i18nConfigAtom);
          const defaultLocale = i18nConfigVal?.defaultLocale ?? 'en';
          const namespace = filePathToSlug(filePath);
          const key = nodeId;
          const msgPath = `messages/${defaultLocale}.json`;
          const msgRaw = projectFS.readFile(msgPath) ?? '{}';
          const updated = setMessageValue(msgRaw, namespace, key, inner);
          projectFS.writeFile(msgPath, updated);
          // Mirror to the override map so the canvas Renderer paints the
          // new text without waiting for a full re-render (the messages
          // path also requires the Renderer to apply via override).
          this.store.set(localeOverridesAtom, prev => {
            const next = new Map(prev);
            const existing = next.get(nodeId) || {};
            next.set(nodeId, { ...existing, text: inner });
            return next;
          });
          trace.action('default-locale:message-commit', { nodeId, locale: defaultLocale, namespace, key, text: inner.slice(0, 50) });
          this.renderer.setTextEditing(true);
          requestAnimationFrame(() => { this.renderer.setTextEditing(false); });
          return;
        }
      }

      // Map-aware text commit: if the node has a text binding ({item.desc}),
      // update the map JSON data instead of writing JSX text content.
      const mapCtx = this.store.get(mapContextAtom);
      const mapIdx = this.store.get(mapItemIndexAtom);
      if (mapCtx && mapIdx != null) {
        // Find the text binding field for this node
        const nodesForMap = this.store.get(nodesAtom);
        const mapEditNode = nodesForMap.get(nodeId);
        const textField = mapEditNode?.binding?.property === 'text' ? mapEditNode.binding.field : null;
        if (textField) {
          const itemData = { ...(mapCtx.mapData[mapIdx] || {}) };
          const oldVal = itemData[textField];
          itemData[textField] = inner;
          queueMutation({ type: 'updateMapItem', varName: mapCtx.varName, index: mapIdx, item: itemData });
          if (mapIdx === 0) {
            propagateToGhosts(mapCtx.varName, textField, oldVal, inner, mapCtx.mapData);
          }
          trace.action('canvas:map-text-commit', { nodeId, mapIdx, textField, text: inner.slice(0, 50) });
          this.renderer.setTextEditing(true);
          requestAnimationFrame(() => { this.renderer.setTextEditing(false); });
          return;
        }
      }

      // FIT text: persist the SANDBOX-computed re-fit BEFORE the text mutation
      // so the Renderer rebuild reads the correct viewBox + fontSize from code.
      // The sandbox measured it (fonts live in ITS document; this frame can't
      // touch the cross-origin iframe DOM — the old parent-side measure/query
      // approach silently no-op'd) and already applied it to every DOM copy,
      // so there's no visual jump between commit and re-render.
      //
      // PER-VIEWPORT (design-tool parity): a commit on a NON-PRIMARY replica writes
      // its fit numbers as overrides for THAT breakpoint only — fontSize +
      // marginTop as @media styles (updateContainerStyle), viewBox as a
      // responsive attr ternary (setResponsiveAttr; @media can't override
      // attributes). A PRIMARY commit writes the base — through the
      // base-PRESERVING attr setter so existing per-viewport viewBox branches
      // survive (plain updateHtmlAttrs would clobber the ternary).
      if (fit) {
        // FIT wrapper contract: ONE styled <p> whose line breaks are <br /> —
        // that's what the svg's whiteSpace:'pre' + the fit measurer speak. A
        // multi-line TipTap commit arrives as `<p>A</p><p>B</p>`; written as-is
        // it nests unstyled paragraphs (UA margins) inside the fit <p>, the
        // layout box outgrows the viewBox and the center-origin Fit% scale
        // hangs the text out the bottom. Fold to <br /> lines (inline marks
        // and entities pass through untouched).
        inner = foldFitParagraphsToBr(inner);
        const fitViewports = this.store.get(viewportsConfigAtom);
        const fitPrimary = fitViewports.find(v => v.isPrimary) ?? fitViewports[0];
        const fitEditingVp = fitViewports.find(v => v.id === this.editingVpId) ?? fitPrimary;
        const fitPrimaryW = fitPrimary?.width ?? 1440;
        const fitVpW = fitEditingVp?.width ?? fitPrimaryW;
        if (fitVpW !== fitPrimaryW) {
          const baseViewBox = String((this.store.get(nodesAtom).get(fit.svgNodeId)?.attrs as any)?.viewBox ?? fit.viewBox);
          queueMutation({ type: 'setResponsiveAttr', nodeId: fit.svgNodeId, vpWidth: fitVpW, attr: 'viewBox', value: fit.viewBox, baseValue: baseViewBox });
          queueMutation({ type: 'updateContainerStyle', nodeId, maxWidth: fitVpW, styles: { fontSize: `${fit.fontSize}px`, marginTop: `${fit.marginTop}px` } });
          trace.action('fit-text:commit-viewbox-update', { svgId: fit.svgNodeId, viewBox: fit.viewBox, fontSize: fit.fontSize, marginTop: fit.marginTop, vpWidth: fitVpW, perViewport: true });
        } else {
          queueMutation({ type: 'setResponsiveAttrBase', nodeId: fit.svgNodeId, attr: 'viewBox', value: fit.viewBox });
          // fontSize + ink-centering marginTop on the inner text node, matching the viewBox
          queueMutation({ type: 'updateStyles', nodeId, styles: { fontSize: `${fit.fontSize}px`, marginTop: `${fit.marginTop}px` } });
          trace.action('fit-text:commit-viewbox-update', { svgId: fit.svgNodeId, viewBox: fit.viewBox, fontSize: fit.fontSize, marginTop: fit.marginTop, perViewport: false });
        }
        // FIT contract: the wrapper's height must be AUTO — the viewBox owns the
        // aspect. A fixed px height (baked by a canvas drag round-trip) freezes
        // the box while every re-fit changes the aspect → stretched/mangled
        // text. Normalize in code whenever a commit finds it fixed.
        const fitSvgNode = this.store.get(nodesAtom).get(fit.svgNodeId);
        const fitSvgHeight = (fitSvgNode?.styles as Record<string, string> | undefined)?.height;
        if (fitSvgHeight && fitSvgHeight !== 'auto') {
          queueMutation({ type: 'updateStyles', nodeId: fit.svgNodeId, styles: { height: 'auto' } });
          trace.action('fit-text:height-normalized', { svgId: fit.svgNodeId, was: fitSvgHeight });
        }
      }

      // Queue the text update — prevent onBeforeFlush from setting the skip flag
      // (we cleared el.innerHTML, so the Renderer MUST rebuild from the new nodes)
      this.renderer.setTextEditing(true);
      // Per-viewport text override routing.
      //   - Edit on a non-primary viewport, OR
      //   - Edit on any viewport when this node already has overrides set
      // → route through `updateTextOverride` (rewrites the JSX
      //   `useResponsiveText('primary', { width: 'override' })` call).
      // Otherwise fall through to the plain `updateChildrenHTML` path used
      // for normal text edits — keeps non-responsive text JSX clean.
      const editingVpId = this.editingVpId;
      const viewports = this.store.get(viewportsConfigAtom);
      const primaryVp = viewports.find(v => v.isPrimary) ?? viewports[0];
      const editingVp = viewports.find(v => v.id === editingVpId) ?? primaryVp;
      const primaryWidth = primaryVp?.width ?? 1440;
      const vpWidth = editingVp?.width ?? primaryWidth;
      const nodesForVp = this.store.get(nodesAtom);
      const editingNode = nodesForVp.get(nodeId);
      const hasOverrides = !!editingNode?.textOverrides
        && Object.keys(editingNode.textOverrides).length > 0;

      // Design-component master: each variant is a viewport whose id IS the
      // variant name. Editing text on a non-primary variant tile — or on ANY
      // tile of a node that already carries per-variant text — stores it as a
      // `{variant === 'x' ? 'a' : 'b'}` ternary so it round-trips per variant.
      const isDesignComponent = isComponentFilePath(this.store.get(activeFilePathAtom));
      const onNonPrimaryVariant = isDesignComponent && editingVpId !== (primaryVp?.id ?? 'default');
      const hasConditionalText = !!editingNode?.conditionalText
        && Object.keys(editingNode.conditionalText).length > 0;

      // SOLO-REPLICA text redirect. A node carrying
      // `data-replica-solo="<vpId>"` is the user's "I'm authoring on
      // this one replica, everything I do here should build the
      // MASTER values" contract — applied to layout/size/color/etc.
      // earlier, and now to text content too. Route the edit as a
      // PLAIN primary children-HTML write (NOT a per-vp
      // `useResponsiveText` override or per-variant ternary), so the
      // base inline JSX carries the real text the user typed. When
      // they later unhide the element on primary or another
      // replica/variant, those inherit the text for free — no
      // `useResponsiveText` indirection, no `{variant === 'x' ? …}`
      // ternary, no zero-width placeholder collapse.
      //
      // Solo redirect applies on BOTH page replicas and design-component
      // variants — same semantic: "I'm only seeing this on one
      // replica/variant; my edits build the master".
      const soloVpId = editingNode?.attrs?.['data-replica-solo'];
      const isSoloRedirect = !!soloVpId;

      // WHITESPACE VISIBILITY — a committed text with a leading/trailing
      // space (`Time - `) or internal runs (`a  b`) now survives the source
      // round-trip (inline JSXText + cleanJsxText), but default CSS
      // `white-space: normal` still doesn't PAINT edge spaces at the end of
      // an inline box — the user types `Time - `, the data commits, and the
      // canvas AND the live site both render `Time -`. TipTap shows it while
      // editing (its editor is pre-wrap), so the space "vanishes" on exit.
      // the reference's answer, and ours: text layers with meaningful whitespace get
      // `white-space: pre-wrap`. Only when the user hasn't set an explicit
      // whiteSpace themselves (never clobber nowrap / FIT's 'pre').
      {
        const wsProbe = document.createElement('div');
        wsProbe.innerHTML = inner;
        const plain = wsProbe.textContent ?? '';
        const hasMeaningfulWs = /^[ \u00A0]|[ \u00A0]$| {2,}/.test(plain);
        const hasExplicitWs = !!editingNode?.styles?.whiteSpace;
        if (hasMeaningfulWs && !hasExplicitWs) {
          trace.action('text-edit:ensure-pre-wrap', { nodeId, plainLen: plain.length });
          queueMutation({ type: 'updateStyles', nodeId, styles: { whiteSpace: 'pre-wrap' } });
        }
      }

      if (isSoloRedirect) {
        // Plain primary children-HTML write (master baseline). On a
        // design component the conditional-text branch below would
        // otherwise wrap this into a `{variant === 'x' ? … }` ternary,
        // which is the wrong contract here: the text isn't per-variant,
        // it's the master value the user just hasn't unhidden on the
        // other variants yet.
        queueMutation({ type: 'updateChildrenHTML', nodeId, html: inner });
      } else if (isDesignComponent && (onNonPrimaryVariant || hasConditionalText)) {
        // Per-variant text is plain-text only — flatten TipTap's HTML. Do NOT
        // .trim(): a typed edge space (`Time - `) is meaningful and per-variant
        // text is stored as a string literal in the ternary, where it survives
        // verbatim (same whitespace contract as the plain path above).
        const tmp = document.createElement('div');
        tmp.innerHTML = inner;
        queueMutation({
          type: 'updateVariantText',
          nodeId,
          variantName: editingVpId,
          text: tmp.textContent ?? '',
        });
      } else if (vpWidth !== primaryWidth || hasOverrides) {
        queueMutation({
          type: 'updateTextOverride',
          nodeId,
          vpWidth,
          primaryWidth,
          text: inner,
        });
      } else {
        // Plain primary text write (also covers the solo-redirect case
        // — `data-replica-solo` set → write as if on primary).
        queueMutation({ type: 'updateChildrenHTML', nodeId, html: inner });
      }

      // Clear after a tick so subsequent non-text mutations still skip normally
      requestAnimationFrame(() => { this.renderer.setTextEditing(false); });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
      const errStack = err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n') : '';
      trace.error('canvas:commitTextEdit-failed', { message: errMsg, stack: errStack });
      // Editor is in the iframe — nothing to destroy parent-side. Just clear
      // tracking refs and atoms so a stuck editing session doesn't leave the
      // toolbar pointing at a phantom selection.
      this.editingNodeId = null;
      if (this.iframeRef.current) {
        this.iframeRef.current.style.pointerEvents = 'none';
      }
      this.store.set(isTextEditingAtom, false);
      this.store.set(textEditSnapshotAtom, null);
      this.store.set(selectionStylesAtom, {});
      // Best-effort cancel into the sandbox — it's a no-op if the editor was
      // already destroyed (which is the common case since the iframe is what
      // sent the commit event in the first place).
      try { this.bridge.cancelTextEdit(); } catch { /* ignore */ }
    }
  }

  // ─── commitEdit ────────────────────────────────────────────────────────────

  // Public-shaped wrapper — kept for callers that "just want to commit now"
  // (page switch, Esc shortcut). Pulls HTML from the iframe and applies.
  async commitEdit(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || !this.editingNodeId) return;
    try {
      const { html, fit } = await bridge.commitTextEdit();
      this.commitEditWithHtml(html, fit);
    } catch (err) {
      trace.error('canvas:commitTextEdit-bridge-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** After a text session ends, FOCUS must return to the parent window —
   *  the TipTap editor lives in the sandbox IFRAME, and a commit triggered
   *  by a click inside the iframe (the text-creator first-commit flow)
   *  leaves the iframe focused: the parent's keydown listeners then never
   *  fire and every shortcut (⌘C/V/D, undo…) goes dead until some click
   *  lands in the parent document (the "have to unselect the node" find). */
  private reclaimKeyboardFocus(): void {
    try {
      window.focus();
      const active = document.activeElement as HTMLElement | null;
      if (active && active.tagName === 'IFRAME') active.blur();
      trace.action('canvas:text-edit-focus-reclaimed', {});
    } catch { /* ignore */ }
  }

  // ─── cancelEdit ────────────────────────────────────────────────────────────

  cancelEdit(): void {
    // Drop in-flight state, nothing to persist.
    this.editingNodeId = null;
    if (this.iframeRef.current) {
      this.iframeRef.current.style.pointerEvents = 'none';
    }
    this.store.set(isTextEditingAtom, false);
    this.store.set(textEditSnapshotAtom, null);
    this.store.set(selectionStylesAtom, {});
    // Same render-gate reset as the empty-content commit path — without
    // it the renderer stays stuck "editing" after a programmatic cancel
    // and skips every subsequent canvas mutation.
    this.renderer.setTextEditing(false);
    // Empty-frame quick-text revert: same scaffold-undo the commit path
    // does. Cancel hits this when the user pressed Escape; commit hits
    // the equivalent path inside `commitEditWithHtml`. Either way,
    // dismissing the editor without typing reverts the auto-inserted
    // text + flex layout back to the original empty frame.
    this.revertEmptyFrameDblclickIfPending();
    this.reclaimKeyboardFocus();
    releaseHistoryCoalescing();
    trace.action('canvas:text-edit-cancelled', { editingNodeId: null });
  }

  // ─── startEdit ────────────────────────────────────────────────────────────

  startEdit(nodeId: string, textContent: string, vpId?: string): void {
    // Already editing? Commit current session first so we don't end up with
    // two editors live in the iframe.
    if (this.editingNodeId && this.editingNodeId !== nodeId) {
      this.commitEdit();
    }

    this.editingVpId = vpId || this.getInteractingVpId() || 'desktop';
    this.editingNodeId = nodeId;

    const bridge = this.bridge;
    if (!bridge) {
      trace.error('canvas:text-edit-no-bridge', { nodeId });
      return;
    }

    const vpPrefix = getViewportPrefix(this.editingVpId);
    // Clear hover state on entry. Without this a hover from before the edit
    // (e.g. user mouses onto a sibling, then double-clicks the text) leaks
    // through the iframe `pointer-events: auto` flip and survives the edit.
    // After commit the SelectionOverlay re-mounts and the stale hoveredId
    // drives a HoverHighlight against a node whose cached corners no longer
    // reflect reality — the outline appears "stuck" through subsequent zooms.
    this.store.set(hoveredIdAtom, null);
    this.store.set(hoveredNodeIdAtom, null);
    // Also clear the canvas-dnd library's own hover overlay (rendered into
    // `#dnd-overlay` inside the iframe). TipTap pulls pointer focus, so
    // canvas-dnd's pointermove tracker stops firing — without an explicit
    // clear, its <path data-hover-for="..."> stays drawn at fixed coordinates
    // and follows neither the element nor subsequent zooms (the symptom the
    // user reported as the "stuck blue rectangle").
    bridge.setDndHovered(null);
    // Mark editing state for the toolbar / hooks. The actual editor lives in
    // the sandbox; the parent only owns this flag + the snapshot atom.
    this.store.set(isTextEditingAtom, true);

    // Renderer skip: prevent a re-render from blowing away the TipTap DOM
    // mid-edit. The iframe-side `data-editing` guard on the element handles
    // patch-time skipping; this gates the parent-driven full-render path.
    this.renderer.setTextEditing(true);

    // The iframe defaults to pointer-events: none so the parent's selection /
    // drag coordinator owns canvas clicks. While text editing, clicks must
    // reach inside the iframe so ProseMirror can position the cursor and
    // handle range selection. Flip to auto for the duration of the session.
    if (this.iframeRef.current) {
      this.iframeRef.current.style.pointerEvents = 'auto';
    }

    // Tell the sandbox whether this node uses `useResponsiveText` so its
    // live-replica-sync skips fan-out during typing. Each viewport resolves
    // the hook independently in its own React tree; mirroring keystrokes
    // across replicas would briefly overwrite their resolved values.
    const nodesNow = this.store.get(nodesAtom);
    const editingNode = nodesNow.get(stripGhostSuffix(nodeId));
    const isResponsive = !!editingNode?.textOverrides && Object.keys(editingNode.textOverrides).length > 0;
    // Variant tiles with their OWN text override (a `{variant === 'x' ? … }`
    // ternary or a per-variant text variable) keep their committed content —
    // the sandbox's live keystroke mirror must skip them or typing on the
    // primary overwrites every tile until commit restores them ("during
    // typing they sync", 2026-08-05). 'default' is the edited fallback
    // itself, never excluded.
    const syncExcludeVpIds = [
      ...Object.keys(editingNode?.conditionalText ?? {}),
      ...Object.keys(editingNode?.conditionalTextVariable ?? {}),
    ].filter((v) => v !== 'default');
    bridge.startTextEdit(nodeId, vpPrefix, textContent, isResponsive, syncExcludeVpIds);

    // One undo entry per session: merge the creation that spawned this edit
    // with the content committed by it.
    holdHistoryCoalescing();
    trace.action('canvas:text-edit-started', {
      nodeId, vpId: this.editingVpId, syncExcludeVpIds,
      hasConditionalText: !!editingNode?.conditionalText,
    });
  }

  // ─── dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    trace.fn('CanvasTextEditController.dispose', {});
    this.editingNodeId = null;
    this.emptyFrameScaffold = null;
  }
}
