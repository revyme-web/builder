// PathTool.tsx — Properties panel for the currently-selected anchor inside
// SVG shape-edit mode. Mirrors the reference's "Path" panel:
//
//   Position  — selected anchor's (x, y) in SVG user-space (read-only)
//   Curve     — handle-mode segmented control:
//                  Straight     (no bezier handles → corner)
//                  Mirrored     (symmetric handles → smooth curve)
//                  Disconnected (asymmetric handles → cusp)
//
// Visible only when shape-edit mode is active AND the library has reported
// a selected anchor via the `onAnchorInfo` callback. Hides automatically
// when the user deselects (info → null) or exits shape-edit.
//
// Data flow: SvgPathEditor (in iframe) → `onAnchorInfo` → bridge event
// → `selectedAnchorInfoAtom`. Curve change → bridge.setShapeEditHandleMode
// → editor.setHandleMode → library fires `onAnchorInfo` again with the
// new mode, atom updates, segmented control re-renders selected.

import { useAtomValue } from 'jotai';
import { ToolSection, ToolInput, ToolSegmentedControl, ToolDivider } from '../controls';
import ControlLabel from '../controls/ControlLabel';
import { selectedAnchorInfoAtom } from '@/code/stores/shape-edit-store';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';

// ── Curve icons (match the reference's visual style) ────────────────────────────
// All on a 14×14 viewBox, currentColor stroke so they pick up the segmented
// control's active/inactive fill.

function CurveStraightIcon() {
  // Single point, no handles → represented as a small filled circle.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}

function CurveMirroredIcon() {
  // Center point with two equal-length handles extending horizontally.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="7" r="1.8" fill="currentColor" />
      <circle cx="2" cy="7" r="1.3" fill="currentColor" />
      <circle cx="12" cy="7" r="1.3" fill="currentColor" />
    </svg>
  );
}

function CurveDisconnectedIcon() {
  // Center point with two handles at different angles → cusp.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <line x1="2" y1="11" x2="7" y2="7" stroke="currentColor" strokeWidth="1.2" />
      <line x1="7" y1="7" x2="12" y2="6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="7" r="1.8" fill="currentColor" />
      <circle cx="2" cy="11" r="1.3" fill="currentColor" />
      <circle cx="12" cy="6" r="1.3" fill="currentColor" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────

export default function PathTool() {
  const anchor = useAtomValue(selectedAnchorInfoAtom);
  if (!anchor) return null;

  const setHandleMode = (mode: string) => {
    trace.action('path-tool:set-handle-mode', { from: anchor.handleMode, to: mode });
    const bridge = getCanvasBridge() as { setShapeEditHandleMode?: (m: string) => void };
    bridge.setShapeEditHandleMode?.(mode);
  };

  const setPosition = (axis: 'x' | 'y', raw: string) => {
    const next = Number.parseFloat(raw);
    if (!Number.isFinite(next)) return;
    const targetX = axis === 'x' ? next : anchor.x;
    const targetY = axis === 'y' ? next : anchor.y;
    trace.action('path-tool:set-position', { axis, from: { x: anchor.x, y: anchor.y }, to: { x: targetX, y: targetY } });
    const bridge = getCanvasBridge() as { setShapeEditAnchorPosition?: (x: number, y: number) => void };
    bridge.setShapeEditAnchorPosition?.(targetX, targetY);
  };

  return (
    <>
    <ToolSection title="Path">
      {/* Position — selected anchor's (x, y) in SVG user-space. Both inputs
          drive `editor.setAnchorPosition` via the bridge: typed values commit
          on blur / Enter, chevron drag scrubs by 1 unit per pixel. */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Position" property="__path-pos" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={String(Math.round(anchor.x))} onChange={v => setPosition('x', v)} chevronLabel="x" />
          <ToolInput value={String(Math.round(anchor.y))} onChange={v => setPosition('y', v)} chevronLabel="y" />
        </div>
      </div>

      {/* Curve — handle mode segmented control. Library values:
          'straight'     — corner anchor, no bezier handles
          'mirrored'     — symmetric handles (same length, opposite dir)
          'disconnected' — independent handles → cusp */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Curve" property="__path-curve" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSegmentedControl
            value={anchor.handleMode}
            onChange={setHandleMode}
            options={[
              { value: 'straight',     icon: <CurveStraightIcon /> },
              { value: 'mirrored',     icon: <CurveMirroredIcon /> },
              { value: 'disconnected', icon: <CurveDisconnectedIcon /> },
            ]}
            size="sm"
          />
        </div>
      </div>
    </ToolSection>
    <ToolDivider />
    </>
  );
}
