// ExportTool.tsx — Export selected element as PNG/JPG/SVG at 1x/2x/3x.
// Capture runs INSIDE the sandbox iframe via the bridge — `html-to-image`
// must clone the element from the iframe's own DOM. The old parent-frame
// `findNodeElement` + html-to-image path returned null post-iframe-migration
// (canvas content isn't in the parent document), so the preview hung on
// "Generating…" forever and Export silently no-op'd.

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { ToolSection, ToolSelect, ControlLabel } from '../controls';
import { useControl } from '../controls/ControlProvider';
import { exportSectionOpenAtom } from '@/code/stores/editor-store';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';

/** `captureElement` lives on PostMessageBridge but isn't in the base
 *  `CanvasBridge` interface — same pattern as the shape-edit RPC methods.
 *  Cast + optional-chain so NullBridge (pre-iframe-load) is a safe no-op. */
type BridgeWithCapture = {
  captureElement?: (
    nodeId: string,
    vpPrefix: string,
    opts: { format: 'png' | 'jpeg' | 'svg'; pixelRatio: number; backgroundColor?: string },
  ) => Promise<string | null>;
};

const SCALE_OPTIONS = [
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: '3', label: '3x' },
];

const FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'svg', label: 'SVG' },
];

export default function ExportTool() {
  const { node, nodeId, vpId } = useControl();
  // Section expansion is GLOBAL (exportSectionOpenAtom) — the + opens Export
  // for every selection, the − closes it everywhere. Mirrors AnchorTool's
  // +/− affordance but with shared (not per-node) state, per design.
  const [open, setOpen] = useAtom(exportSectionOpenAtom);
  const [scale, setScale] = useState('1');
  const [format, setFormat] = useState('png');
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const nodeName = node?.name || node?.type || 'element';

  // Auto-generate the preview shortly after the selection settles. The
  // capture itself runs OFF the parent's main thread (inside the sandbox
  // iframe via the bridge), so a plain debounced setTimeout is enough —
  // the previous `requestIdleCallback` indirection was both unnecessary
  // AND broken: `const rIC = window.requestIdleCallback; rIC(cb)` calls a
  // `window` method through a bare reference, losing its `this` binding →
  // "Illegal invocation" throw → the idle callback never scheduled, so the
  // preview only ever appeared after a manual Export.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setPreview(null);
    cancelledRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // `open` gate: no bridge captures while the section is collapsed.
    if (!nodeId || !showPreview || !open) return;
    cancelledRef.current = false;

    // Debounce 600ms after selection settles, then capture via the bridge.
    debounceRef.current = setTimeout(async () => {
      if (cancelledRef.current) return;
      // Capture runs inside the sandbox iframe via the bridge — the
      // element lives in the iframe's DOM, unreachable from the parent.
      const bridge = getCanvasBridge() as BridgeWithCapture;
      if (typeof bridge.captureElement !== 'function') return;
      try {
        // Rasterize at full resolution (pixelRatio: 1), not 0.25 — the old
        // quarter-res value was a main-thread-perf hack that no longer
        // applies now the capture runs off-thread inside the iframe. At
        // 0.25x, text/details get baked in blurry; at 1x the preview box's
        // `object-contain` just downscales a crisp source.
        const dataUrl = await bridge.captureElement(nodeId, getViewportPrefix(vpId), {
          format: 'png', pixelRatio: 1,
        });
        if (cancelledRef.current) return;
        if (dataUrl) {
          setPreview(dataUrl);
          trace.action('export-tool:preview-generated', { nodeId });
        } else {
          trace.error('export-tool:preview-failed', { nodeId, error: 'capture returned null' });
        }
      } catch (err) {
        trace.error('export-tool:preview-failed', { nodeId, error: String(err) });
      }
    }, 600);

    return () => {
      cancelledRef.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [nodeId, vpId, showPreview, open]);

  const handleExport = useCallback(async () => {
    if (!nodeId) return;

    const bridge = getCanvasBridge() as BridgeWithCapture;
    if (typeof bridge.captureElement !== 'function') {
      trace.error('export-tool:no-bridge', { nodeId });
      return;
    }

    setExporting(true);
    trace.action('export-tool:start', { nodeId, format, scale, nodeName });

    try {
      // `format` state is 'png' | 'jpg' | 'svg'; html-to-image's JPEG
      // export is `toJpeg`, so normalize 'jpg' → 'jpeg' for the bridge.
      const captureFormat: 'png' | 'jpeg' | 'svg' = format === 'jpg' ? 'jpeg' : (format as 'png' | 'svg');
      const dataUrl = await bridge.captureElement(nodeId, getViewportPrefix(vpId), {
        format: captureFormat,
        pixelRatio: parseInt(scale, 10),
        // JPEG has no alpha channel — give it a white backdrop instead of black.
        backgroundColor: captureFormat === 'jpeg' ? '#ffffff' : undefined,
      });

      if (!dataUrl) {
        trace.error('export-tool:element-not-found', { nodeId, vpId });
        return;
      }

      // Set preview
      setPreview(dataUrl);

      // Trigger download
      const link = document.createElement('a');
      link.download = `${nodeName}@${scale}x.${format}`;
      link.href = dataUrl;
      link.click();

      trace.action('export-tool:success', { nodeId, format, scale, nodeName });
    } catch (err) {
      trace.error('export-tool:failed', {
        nodeId, format, scale,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExporting(false);
    }
  }, [nodeId, vpId, format, scale, nodeName]);

  trace.fn('ExportTool:render', { nodeId, format, scale, exporting, open });

  // Same +/− affordance as AnchorTool / AccessibilityTool. The oversized
  // `pl-[80px] -ml-[80px]` hit area mirrors AnchorTool's toggle button.
  const toggleBtn = (
    <button
      onClick={(e) => {
        e.stopPropagation();
        trace.action('export-tool:toggle-section', { open: !open });
        setOpen(!open);
      }}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
    >
      {open ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-opacity group-hover:opacity-80">
          <path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-opacity group-hover:opacity-80">
          <path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );

  return (
    <ToolSection title="Export" collapsible action={toggleBtn} hasContent={open}>
      {/* Scale */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Scale" property="__export-scale" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSelect
            value={scale}
            onChange={(val) => {
              trace.action('export-tool:scale-change', { from: scale, to: val });
              setScale(val);
            }}
            options={SCALE_OPTIONS}
          />
        </div>
      </div>

      {/* Format */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Format" property="__export-format" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSelect
            value={format}
            onChange={(val) => {
              trace.action('export-tool:format-change', { from: format, to: val });
              setFormat(val);
            }}
            options={FORMAT_OPTIONS}
          />
        </div>
      </div>

      {/* Preview toggle */}
      <button
        onClick={() => {
          const next = !showPreview;
          trace.action('export-tool:toggle-preview', { showPreview: next });
          if (!next) setPreview(null);
          setShowPreview(next);
        }}
        className="flex items-center justify-between w-full text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors py-0.5"
      >
        <span>Preview</span>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          className="transition-transform duration-150"
          style={{ transform: showPreview ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          <path d="M2 4.5L6 8L10 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {showPreview && (
        <div className="w-full cut-corners cut-border [--cut-border-color:var(--control-border)] border border-[var(--control-border)] overflow-hidden bg-[var(--grid-line)] p-2" style={{ height: '120px' }}>
          {preview ? (
            <img src={preview} alt="Export preview" className="w-full h-full object-contain cut-corners" />
          ) : (
            // Pulsating skeleton while the capture is generating.
            <div className="w-full h-full animate-pulse bg-[var(--text-primary)]/[0.06] cut-corners" />
          )}
        </div>
      )}

      {/* Export Button */}
      <button
        onClick={handleExport}
        disabled={exporting || !nodeId}
        className={`w-full h-[var(--control-height)] cut-corners cut-border text-xs font-medium transition-colors border ${
          exporting || !nodeId
            ? 'bg-[var(--grid-line)] border-[var(--control-border)] [--cut-border-color:var(--control-border)] text-[var(--text-disabled)] cursor-not-allowed'
            : 'bg-[var(--grid-line)] border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] text-[var(--text-primary)] cursor-pointer'
        }`}
      >
        {exporting ? 'Exporting...' : `Export ${nodeName}`}
      </button>
    </ToolSection>
  );
}
