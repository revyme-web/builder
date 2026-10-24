// AnimationTool/popups/TickerPopup.tsx — the Ticker effect on a layout frame
// (Framer's Ticker effect): the frame's own children scroll in an infinite
// loop. Every control writes the whole config through one `setTicker`
// mutation (ticker-gen.ts); the runtime is `RevymeTicker` in @revyme/runtime.
//
// Per breakpoint / per variant: on a replica tile (or a non-default variant)
// Speed, Hover, Draggable and Fade write THIS tile's override
// (ticker-config.ts setTickerScoped), and a field that has one shows the
// accent label with "Reset Override" — the same plain-label override UX as
// every other per-tile value. Direction is global, as in Framer.
//
// Slider / chevron drags never write per tick: a `setTicker` write re-generates
// and re-parses the page, and 60 of them a second made the drag stutter. The
// popup shows the dragged value from a local draft, Fade previews on the canvas
// tiles through the bridge (the Renderer's own stamp), and the code is written
// once on release.

import { useCallback, useEffect, useState } from 'react';
import { getDefaultStore } from 'jotai';
import { ControlLabel, ToolInput, ToolSlider, ToolSegmentedControl } from '../../../controls';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { expediteStableAtomSync } from '@/canvas/hooks/useStableAtomSync';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { viewportPrefixesForNode, vpIdFromPrefix } from '@/canvas/node-ops';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { viewportWidthsAtom } from '@/code/stores/viewport-store';
import { matches as mediaQueryMatchesWidth } from '@/code/project/breakpoint-proof';
import {
  resolveTickerForScope, resolveTickerWhere, setTickerScoped, resetTickerScope, tickerOverrideFor, tickerCanvasMask,
  type TickerConfig, type TickerDirection, type TickerScope, type TickerValueKey,
} from '@/shared/ticker-config';
import { trace } from '@/shared/debug-trace';

// Label + control row, module scope for a stable identity (see LoopPopup).
const Row = ({ label, overridden, onReset, children }: {
  label: string; overridden?: boolean; onReset?: () => void; children: React.ReactNode;
}) => (
  <div className="flex items-center justify-between w-full">
    <ControlLabel label={label} property="" plain overridden={overridden} onResetOverride={onReset} />
    <div className="w-full">{children}</div>
  </div>
);

type DraftKey = 'speed' | 'hoverSpeed' | 'fade';

/** Live Fade preview: the Renderer's own stamp (`data-ticker-fade` +
 *  `--ticker-mask`, see applyTickerStamp) patched onto every tile of the node,
 *  each resolved the way the Renderer resolves it — so a base drag skips tiles
 *  with their own fade and a tile drag only moves that tile. The commit's
 *  render re-stamps the same values. */
function previewFade(nodeId: string, next: TickerConfig): void {
  const store = getDefaultStore();
  const component = isComponentFilePath(store.get(activeFilePathAtom));
  const widths = store.get(viewportWidthsAtom);
  const bridge = getCanvasBridge();
  for (const prefix of viewportPrefixesForNode(nodeId)) {
    const vpId = vpIdFromPrefix(prefix);
    const vpWidth = widths[vpId];
    const t = resolveTickerWhere(next, (s) => ('query' in s
      ? !component && vpWidth !== undefined && mediaQueryMatchesWidth(s.query, vpWidth)
      : component && s.variant === (prefix ? vpId : 'default')));
    if (t.disabled) continue;
    const mask = tickerCanvasMask(t);
    bridge.patchAttrsAndStyles(nodeId, prefix, { 'data-ticker-fade': mask ? 'true' : '' }, { '--ticker-mask': mask ?? '' });
  }
}

export function TickerPopup({ nodeId, ticker, vertical, scope }: {
  nodeId: string;
  /** The stored config (base + every override). */
  ticker: TickerConfig;
  /** The frame lays its children out in a column → offer Up / Down. */
  vertical: boolean;
  /** The tile being edited: null = the primary / default variant (the base). */
  scope: TickerScope | null;
}) {
  const override = tickerOverrideFor(ticker, scope);
  // The value a slider / chevron is dragging, until the release's write lands
  // (the stored config changes) — so the field never flashes the old value.
  const [draft, setDraft] = useState<Partial<Record<DraftKey, number>>>({});
  const storedKey = JSON.stringify(ticker);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => { setDraft({}); }, [storedKey, scopeKey, nodeId]);
  const shownCfg = { ...resolveTickerForScope(ticker, scope), ...draft };

  const commit = useCallback((next: TickerConfig, what: string) => {
    trace.action('ticker-popup:write', { nodeId, what, scope });
    expediteStableAtomSync();
    queueMutation({ type: 'setTicker', nodeId, ticker: next });
  }, [nodeId, scope]);

  const write = (patch: Partial<TickerConfig>) => commit(setTickerScoped(ticker, patch, scope), Object.keys(patch).join(','));
  // Mid-drag: show it, preview Fade on the canvas, write nothing.
  const live = (key: DraftKey, value: number) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === 'fade') previewFade(nodeId, setTickerScoped(ticker, { fade: value }, scope));
  };
  // Per-field Reset Override: back to the base for this tile only.
  const resetOf = (key: TickerValueKey) => (scope && override?.[key] !== undefined
    ? () => commit(resetTickerScope(ticker, scope, key), `reset:${key}`)
    : undefined);
  const isOver = (key: TickerValueKey) => !!scope && override?.[key] !== undefined;

  const num = (v: string, fallback: number) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  // The direction options follow the frame's axis; a direction from the other
  // axis (the frame's layout was flipped) shows as its same-sign twin.
  const options: { value: TickerDirection; label: string }[] = vertical
    ? [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }]
    : [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }];
  const forward = shownCfg.direction === 'right' || shownCfg.direction === 'down';
  const shown: TickerDirection = vertical ? (forward ? 'down' : 'up') : (forward ? 'right' : 'left');
  const hoverPct = Math.round(shownCfg.hoverSpeed * 100);

  return (
    <div className="flex flex-col gap-2">
      <Row label="Direction">
        <ToolSegmentedControl value={shown} onChange={(v) => write({ direction: v as TickerDirection })}
          options={options} size="sm" />
      </Row>
      <Row label="Speed" overridden={isOver('speed')} onReset={resetOf('speed')}>
        <div className="flex items-center gap-2">
          <ToolInput value={String(shownCfg.speed)} step={5} chevronLabel="px/s"
            onChange={(v) => write({ speed: num(v, shownCfg.speed) })}
            onChangeLive={(v) => live('speed', num(v, shownCfg.speed))}
            onCommit={(v) => write({ speed: num(v, shownCfg.speed) })} />
          <ToolSlider value={shownCfg.speed} min={0} max={400} step={5}
            onChange={(n) => live('speed', n)} onCommit={(n) => write({ speed: n })} />
        </div>
      </Row>
      {/* Hover — speed while the pointer is over the ticker: 100% unchanged, 0% pauses. */}
      <Row label="Hover" overridden={isOver('hoverSpeed')} onReset={resetOf('hoverSpeed')}>
        <div className="flex items-center gap-2">
          <ToolInput value={String(hoverPct)} step={10} chevronLabel="%"
            onChange={(v) => write({ hoverSpeed: num(v, hoverPct) / 100 })}
            onChangeLive={(v) => live('hoverSpeed', num(v, hoverPct) / 100)}
            onCommit={(v) => write({ hoverSpeed: num(v, hoverPct) / 100 })} />
          <ToolSlider value={hoverPct} min={0} max={200} step={5}
            onChange={(n) => live('hoverSpeed', n / 100)} onCommit={(n) => write({ hoverSpeed: n / 100 })} />
        </div>
      </Row>
      <Row label="Draggable" overridden={isOver('draggable')} onReset={resetOf('draggable')}>
        <ToolSegmentedControl value={shownCfg.draggable ? 'yes' : 'no'}
          onChange={(v) => write({ draggable: v === 'yes' })}
          options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} size="sm" />
      </Row>
      {/* Fade — soft edges where items enter and leave (0 = hard edge). */}
      <Row label="Fade" overridden={isOver('fade')} onReset={resetOf('fade')}>
        <div className="flex items-center gap-2">
          <ToolInput value={String(shownCfg.fade)} step={4} chevronLabel="px"
            onChange={(v) => write({ fade: num(v, shownCfg.fade) })}
            onChangeLive={(v) => live('fade', num(v, shownCfg.fade))}
            onCommit={(v) => write({ fade: num(v, shownCfg.fade) })} />
          <ToolSlider value={shownCfg.fade} min={0} max={200} step={4}
            onChange={(n) => live('fade', n)} onCommit={(n) => write({ fade: n })} />
        </div>
      </Row>
      <p className="text-[11px] text-[var(--text-disabled)] px-0.5 leading-snug">
        This frame’s children loop forever. The canvas shows it still — it moves in preview and on the live site.
      </p>
    </div>
  );
}
