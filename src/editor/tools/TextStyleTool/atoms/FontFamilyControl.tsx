// FontFamilyControl.tsx — Font family selector.
// Shows current font name rendered in that font, click opens FontFamilyPopup.
// Two modes: text mode (reads from useTextStyles) and external mode (value/onChange props).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ControlLabel, ControlActionRow } from '../../../controls';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useToolPopupOptional } from '../../../ui/ToolPopup';
import FontFamilyPopup from '../../../ui/FontFamilyPopup';
import { loadGoogleFont } from '@/shared/font-loader';
import { ensureGoogleFontImport } from '@/code/project/preset-ops';
import { injectCanvasCSS, removeCanvasCSS, getInteractingViewport, getViewportPrefix } from '@/canvas/node-ops';
import { fitTextInnerId } from '@/shared/id-utils';
import { refitFitTextForStyles } from '../fit-refit';
import { selectedNodeAtom } from '@/code/stores/store';
import { isTextEditingAtom } from '@/code/stores/editor-store';
import { trace } from '@/shared/debug-trace';

/** Build the canvas-CSS selector for a node's font-family preview rule.
 *  Targets the SPECIFIC viewport replica the user is interacting with, not
 *  every replica that shares the same `data-id`. The renderer stamps each
 *  rendered instance with `data-node-id="<vpPrefix><id>"` (primary uses
 *  `''`, replicas use `'tablet-'`/`'mobile-'`/`'<variant>-'`), so the
 *  prefixed attribute uniquely identifies one rendered element.
 *  `injectCanvasCSS` keys rules by exact selector string — re-using the
 *  same selector on every hover REPLACES the rule body in place, and the
 *  matching `removeCanvasCSS(selector)` clears it on unhover. */
function fontPreviewSelector(nodeId: string, vpId: string): string {
  const prefix = getViewportPrefix(vpId);
  const fullId = `${prefix}${nodeId}`;
  // data-node-id is Revyme-generated and never contains backslash or
  // quote chars in practice, but escape defensively in case a future
  // codegen change relaxes that.
  const esc = fullId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-node-id="${esc}"]`;
}

interface FontFamilyControlProps {
  /** External value (for preset editing). When provided, bypasses useTextStyles. */
  value?: string;
  /** External onChange (for preset editing). */
  onChange?: (value: string) => void;
  /** Row label (external mode only). Defaults to "Family"; a code-component `font`
   *  control passes its own @control label here. */
  label?: string;
}

/** Inner component for text editing context (has ControlProvider) */
function FontFamilyInner() {
  const text = useTextStyles();
  const { value, isMixed } = text.get('fontFamily');
  return (
    <FontFamilyBase
      value={value}
      isMixed={isMixed}
      onChange={(v) => text.set('fontFamily', v)}
      // Hand the same writer to the preview path: in TipTap edit mode it
      // applies fontFamily as a mark on the selected text portion; in
      // node mode it writes the inline style. Either way, on unhover we
      // call the same writer with the original value to revert.
      onPreviewWrite={(v) => text.set('fontFamily', v)}
    />
  );
}

/** Shared base component — renders the button + popup/panel */
function FontFamilyBase({ value, isMixed, onChange, plain, onPreviewWrite, label = 'Family' }: {
  value: string;
  isMixed?: boolean;
  onChange: (v: string) => void;
  plain?: boolean;
  /** Row label — defaults to "Family". */
  label?: string;
  /** When provided (text-mode), the preview pipeline writes via this
   *  setter. The control assumes the writer ALSO handles the
   *  selected-text-portion case (TipTap mark on the active selection)
   *  rather than re-implementing that here. */
  onPreviewWrite?: (v: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const popupCtx = useToolPopupOptional();
  const selectedId = useAtomValue(selectedNodeAtom);
  const isTextEditing = useAtomValue(isTextEditingAtom);
  // Snapshot of what we did when entering preview mode, so unhover can
  // revert exactly what we changed:
  //   { mode: 'element' } — we injected a CSS rule, just remove it.
  //   { mode: 'text', originalValue } — we wrote via TipTap / node, write
  //   the original back.
  const previewRef = useRef<
    // `vpId` snapshotted at preview-start so the cleanup selector matches
    // the same replica we injected against. Without it, switching the
    // active viewport mid-hover (rare but possible via panel state) would
    // leave the rule live on the original replica.
    | { mode: 'element'; targetId: string; vpId: string }
    | { mode: 'text'; originalValue: string }
    | null
  >(null);

  const displayName = (() => {
    if (isMixed) return 'Mixed';
    if (!value) return 'Default';
    return value.split(',')[0].trim().replace(/['"]/g, '');
  })();

  if (value && !isMixed) loadGoogleFont(displayName);

  const handleChange = useCallback((family: string) => {
    trace.action('font-family:change', { from: value, to: family });
    onChange(family);
    // Inject @import into globals.css so preview/live loads the font
    ensureGoogleFontImport(family);
    // FIT text: the frozen viewBox + inner fontSize were measured for the OLD
    // font — the new font's line no longer matches the box it's centered in,
    // so the text reads as off-center. Re-fit for the new metrics (waits for
    // the face to load, then re-solves size + height, keeping the box width).
    const sid = selectedIdRef.current;
    if (sid && fitTextInnerId(sid) && !isTextEditingRef.current) {
      void refitFitTextForStyles(sid, { fontFamily: family });
    }
  }, [onChange, value]);

  // Pin live values onto refs so the preview callbacks NEVER need them in
  // their deps — `handlePreview` rebuilding on every hover (because
  // `value` flips when the preview write echoes back through the snapshot
  // atom) caused react-window's row props to re-memoize each tick → list
  // re-mounted rows → cursor's row identity changed → mouseenter fired
  // again on the same visual row → preview wrote again → loop. The user
  // saw the canvas font flash to the hovered value for ~100ms then snap
  // back as the loop's clear-and-rewrite cascade collapsed.
  //
  // With refs, both callbacks are stable across renders and the loop is
  // broken: hover writes the preview and that's the end of it. Container
  // mouseleave handles cleanup; click handles commit.
  const valueRef = useRef(value);
  const isTextEditingRef = useRef(isTextEditing);
  const selectedIdRef = useRef(selectedId);
  const onPreviewWriteRef = useRef(onPreviewWrite);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { isTextEditingRef.current = isTextEditing; }, [isTextEditing]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { onPreviewWriteRef.current = onPreviewWrite; }, [onPreviewWrite]);

  /** Drop the active hover preview, restoring whatever we changed when
   *  we entered preview mode. Idempotent — safe to call multiple times. */
  const clearFontPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    if (preview.mode === 'text' && onPreviewWriteRef.current) {
      onPreviewWriteRef.current(preview.originalValue);
    } else if (preview.mode === 'element') {
      // Selector matches what we injected in handlePreview. Same
      // (targetId, vpId) = same key in the canvas <style> registry.
      removeCanvasCSS(fontPreviewSelector(preview.targetId, preview.vpId));
    }
    previewRef.current = null;
  }, []);

  /** Apply / clear the font hover preview from the popup. Two paths:
   *
   *   - Text-portion mode (`isTextEditing` — TipTap is active): write
   *     fontFamily via the same setter the commit path uses. TipTap
   *     applies it as a mark on the selected range, so a partial
   *     selection only previews on the highlighted characters. On
   *     unhover we restore the original value via the same setter.
   *
   *   - Whole-element mode: inject a scoped CSS rule into the canvas
   *     <style> via `injectCanvasCSS`. A `[data-id="<id>"] { font-family
   *     ... !important }` rule wins against any inline style, so the
   *     element instantly reflects the previewed font WITHOUT mutating
   *     the source code. Removed on unhover. */
  const handlePreview = useCallback((previewValue: string | null) => {
    if (!previewValue) {
      clearFontPreview();
      return;
    }
    // Make sure the font face is actually loaded before we preview —
    // otherwise the canvas falls back to the parent stack and the user
    // sees no visual change.
    const fontName = previewValue.split(',')[0].trim().replace(/['"]/g, '');
    if (fontName) loadGoogleFont(fontName);

    if (isTextEditingRef.current && onPreviewWriteRef.current) {
      // Text mode: snapshot the original value the FIRST time we enter
      // preview, then keep overwriting on subsequent hovers without
      // re-snapshotting (which would capture the previewed value as
      // "original" and trap the user there).
      if (previewRef.current?.mode !== 'text') {
        clearFontPreview();
        previewRef.current = { mode: 'text', originalValue: valueRef.current };
      }
      onPreviewWriteRef.current(previewValue);
      return;
    }

    const rawSid = selectedIdRef.current;
    if (!rawSid) return;
    // FIT text: selection lands on the SVG WRAPPER (`<textId>-svg`) but the
    // font lives on the inner <p data-id="<textId>">'s inline style — a rule
    // on the wrapper only INHERITS down and the p's own font-family wins, so
    // the hover preview was a visual no-op (click worked: useTextStyles'
    // commit path resolves the inner node). Retarget the rule to the inner
    // text node. Preview metrics may slightly overflow the frozen viewBox —
    // commit re-fits.
    const sid = fitTextInnerId(rawSid) ?? rawSid;
    // Element mode: keyed by the selected node id + active viewport. Each
    // replica has its own `data-node-id="<vpPrefix><sid>"`, so the
    // selector targets ONLY the replica the user is interacting with —
    // primary stays untouched when previewing on tablet/mobile (or vice
    // versa). Re-injecting with the same selector REPLACES the rule body
    // (per `injectCanvasCSS` semantics), so per-row hover updates stay
    // O(1) replacements.
    const { vpId } = getInteractingViewport();
    if (
      previewRef.current?.mode !== 'element' ||
      previewRef.current.targetId !== sid ||
      previewRef.current.vpId !== vpId
    ) {
      clearFontPreview();
      previewRef.current = { mode: 'element', targetId: sid, vpId };
    }
    injectCanvasCSS(
      fontPreviewSelector(sid, vpId),
      `font-family: ${previewValue} !important;`,
    );
  }, [clearFontPreview]);

  // Always clear on unmount so a stale rule doesn't survive (e.g. user
  // closes the panel by selecting a different node mid-hover).
  useEffect(() => clearFontPreview, [clearFontPreview]);

  const handleClick = useCallback(() => {
    if (popupCtx) {
      // Inside a ToolPopup (preset editor) — push font list as sliding panel
      popupCtx.pushPanel('Font Family', (
        <FontFamilyPopup
          value={isMixed ? '' : value}
          onChange={handleChange}
          onPreview={handlePreview}
          isOpen={true}
          onClose={() => popupCtx.popPanel()}
          anchorRef={rowRef}
          inline
        />
      ));
    } else {
      // Standalone — open own popup
      setIsOpen(true);
    }
  }, [popupCtx, value, isMixed, handleChange, handlePreview]);

  trace.fn('FontFamilyControl:render', { value, isMixed, displayName, isOpen });

  return (
    <>
      <div ref={rowRef} className="flex items-center justify-between w-full">
        <ControlLabel label={label} property="fontFamily" plain={plain} />
        <ControlActionRow onClick={handleClick} className="min-w-0 overflow-hidden">
          <span
            className="text-xs truncate flex-1 min-w-0"
            style={{ fontFamily: isMixed ? undefined : value || undefined }}
          >
            {displayName}
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-[var(--text-secondary)]">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </ControlActionRow>
      </div>
      {/* Standalone popup — only when NOT inside a parent ToolPopup */}
      {!popupCtx && (
        <FontFamilyPopup
          value={isMixed ? '' : value}
          onChange={handleChange}
          onPreview={handlePreview}
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          anchorRef={rowRef}
        />
      )}
    </>
  );
}

/** Public API — uses text hooks when no props, external value when props provided */
export function FontFamilyControl({ value, onChange, label }: FontFamilyControlProps = {}) {
  if (value !== undefined && onChange !== undefined) {
    return <FontFamilyBase value={value} onChange={onChange} plain label={label} />;
  }
  return <FontFamilyInner />;
}
