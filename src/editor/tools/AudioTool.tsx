// AudioTool.tsx — Audio source and HTML audio attribute controls.
// Shows only when an <audio> or <motion.audio> element is selected.
// Uses UnifiedControlProvider with mode='htmlAttr' for attr-based controls.

import { useState, useCallback } from 'react';
import { ToolSection, ToolSelect, ToolInput } from '../controls';
import { UnifiedControlProvider, useControlContext } from '../controls/unified';
import { ControlRow } from '../controls/unified/ControlRow';
import { useControl } from '../controls/ControlProvider';
import type { AtomProps } from '../controls/unified/types';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';

// ─── Options ────────────────────────────────────────────────────────────────

const YES_NO_OPTIONS = [
  { value: '', label: 'No' },
  { value: 'true', label: 'Yes' },
];

const PRELOAD_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'metadata', label: 'Metadata' },
  { value: 'none', label: 'None' },
];

// ─── ToolAtom: Yes/No Select ────────────────────────────────────────────────

function YesNoAtom() {
  const { value, onChange } = useControlContext();
  return <ToolSelect value={value || ''} onChange={onChange} options={YES_NO_OPTIONS} />;
}

function PreloadAtom() {
  const { value, onChange } = useControlContext();
  return <ToolSelect value={value || 'auto'} onChange={onChange} options={PRELOAD_OPTIONS} />;
}

// ─── Exported ToolAtom controls ─────────────────────────────────────────────

function AudioControlsControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="controls" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Controls"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function AudioAutoplayControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="autoplay" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Autoplay"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function AudioLoopControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="loop" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Loop"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function AudioMutedControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="muted" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Muted"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function AudioPreloadControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="preload" defaultValue="auto" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Preload"><PreloadAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

// ─── AudioTool ──────────────────────────────────────────────────────────────

export default function AudioTool() {
  const { node, nodeId, vpId } = useControl();

  if (!node || (node.type !== 'audio' && node.type !== 'motion.audio')) return null;

  return <AudioToolInner nodeId={nodeId!} node={node} vpId={vpId} />;
}

function AudioToolInner({
  nodeId,
  node,
  vpId,
}: {
  nodeId: string;
  node: NonNullable<ReturnType<typeof useControl>['node']>;
  vpId: string;
}) {
  const src = node.attrs?.src ?? '';
  const [localSrc, setLocalSrc] = useState(src);

  const commitSrc = useCallback((value: string) => {
    const trimmed = value.trim();
    trace.action('audio-tool:update-src', { nodeId, src: trimmed.slice(0, 80) });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { src: trimmed } });
    // Instant canvas feedback via bridge — the canvas DOM lives in the
    // sandbox iframe. null removes the attribute (empty input clears src).
    getCanvasBridge().setAttribute(nodeId, getViewportPrefix(vpId), 'src', trimmed || null);
  }, [nodeId, vpId]);

  // Sync local state on node change
  if (localSrc !== src && !document.activeElement?.closest('[data-audio-src-input]')) {
    setLocalSrc(src);
  }

  trace.fn('AudioTool:render', { nodeId, src: src.slice(0, 60) });

  return (
    <ToolSection title="Audio" collapsible>
      {/* Source URL */}
      <div className="flex items-center justify-between w-full">
        <span className="w-3/4 text-xs font-medium text-[var(--text-secondary)] select-none">Source</span>
        <ToolInput
          value={localSrc}
          onChange={(val) => { setLocalSrc(val); commitSrc(val); }}
          text
          placeholder="Audio URL..."
        />
      </div>

      {/* ToolAtom controls */}
      <AudioControlsControl />
      <AudioAutoplayControl />
      <AudioLoopControl />
      <AudioMutedControl />
      <AudioPreloadControl />
    </ToolSection>
  );
}
