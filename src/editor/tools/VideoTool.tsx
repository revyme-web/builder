// VideoTool.tsx — Video source, poster, and HTML video attribute controls.
// Shows only when a <video> or <motion.video> element is selected.
// Uses UnifiedControlProvider with mode='htmlAttr' for attr-based controls.
// CSS properties (objectFit) use mode='direct'.

import { useState, useCallback } from 'react';
import { ToolSection, ToolSelect } from '../controls';
import { UnifiedControlProvider, useControlContext } from '../controls/unified';
import { ControlRow } from '../controls/unified/ControlRow';
import { useControl } from '../controls/ControlProvider';
import type { AtomProps } from '../controls/unified/types';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import VideoSearchModal from '../ui/VideoSearchModal';
import ImageSearchModal from '../ui/ImageSearchModal';
import { trace } from '@/shared/debug-trace';

// ─── Options ────────────────────────────────────────────────────────────────

const OBJECT_FIT_OPTIONS = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];

const PRELOAD_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'metadata', label: 'Metadata' },
  { value: 'none', label: 'None' },
];

const YES_NO_OPTIONS = [
  { value: '', label: 'No' },
  { value: 'true', label: 'Yes' },
];

// ─── ToolAtom: Yes/No Select ────────────────────────────────────────────────

function YesNoAtom() {
  const { value, onChange } = useControlContext();
  return <ToolSelect value={value || ''} onChange={onChange} options={YES_NO_OPTIONS} />;
}

function VideoControlsControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="controls" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Controls"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function VideoAutoplayControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="autoplay" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Autoplay"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function VideoLoopControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="loop" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Loop"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

function VideoMutedControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="muted" defaultValue="" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Muted"><YesNoAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

// ─── ToolAtom: Preload Select ───────────────────────────────────────────────

function PreloadAtom() {
  const { value, onChange } = useControlContext();
  return <ToolSelect value={value || 'auto'} onChange={onChange} options={PRELOAD_OPTIONS} />;
}

function VideoPreloadControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="preload" defaultValue="auto" mode={props.mode || 'htmlAttr'} {...props}>
      <ControlRow label="Preload"><PreloadAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

// ─── ToolAtom: Object Fit (CSS property — direct mode) ──────────────────────

function FitAtom() {
  const { value, onChange } = useControlContext();
  return <ToolSelect value={value || 'cover'} onChange={onChange} options={OBJECT_FIT_OPTIONS} />;
}

function VideoFitControl(props: AtomProps) {
  return (
    <UnifiedControlProvider property="objectFit" defaultValue="cover" mode={props.mode || 'direct'} {...props}>
      <ControlRow label="Fit"><FitAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

// ─── VideoTool (composed from ToolAtoms) ────────────────────────────────────

export default function VideoTool() {
  const { node, nodeId, vpId } = useControl();

  if (!node || (node.type !== 'video' && node.type !== 'motion.video')) return null;

  return <VideoToolInner nodeId={nodeId!} node={node} vpId={vpId} />;
}

function VideoToolInner({
  nodeId,
  node,
  vpId,
}: {
  nodeId: string;
  node: NonNullable<ReturnType<typeof useControl>['node']>;
  vpId: string;
}) {
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [posterModalOpen, setPosterModalOpen] = useState(false);

  const src = node.attrs?.src ?? '';
  const poster = node.attrs?.poster ?? '';

  // ─── Video selection ──────────────────────────────────────────────
  const handleVideoSelect = useCallback((url: string) => {
    trace.action('video-tool:select-video', { nodeId, url: url.slice(0, 80) });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { src: url } });
    // Instant canvas feedback via bridge — the canvas DOM lives in the iframe.
    getCanvasBridge().setAttribute(nodeId, getViewportPrefix(vpId), 'src', url);
  }, [nodeId, vpId]);

  // ─── Poster selection ─────────────────────────────────────────────
  const handlePosterSelect = useCallback((url: string) => {
    trace.action('video-tool:select-poster', { nodeId, url: url.slice(0, 80) });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { poster: url } });
    // Instant canvas feedback via bridge — the canvas DOM lives in the iframe.
    getCanvasBridge().setAttribute(nodeId, getViewportPrefix(vpId), 'poster', url);
  }, [nodeId, vpId]);

  const removePoster = useCallback(() => {
    trace.action('video-tool:remove-poster', { nodeId });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { poster: '' } });
    // Instant canvas feedback via bridge — null removes the attribute.
    getCanvasBridge().setAttribute(nodeId, getViewportPrefix(vpId), 'poster', null);
  }, [nodeId, vpId]);

  trace.fn('VideoTool:render', { nodeId, src: src.slice(0, 60), poster: poster.slice(0, 40) });

  return (
    <>
      <ToolSection title="Video" collapsible>
        {/* Video preview / choose */}
        {src ? (
          <div className="flex flex-col gap-2">
            <div
              className="w-full h-28 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity bg-[var(--control-bg)]"
              onClick={() => setVideoModalOpen(true)}
            >
              <video src={src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
            </div>
            <button
              onClick={() => setVideoModalOpen(true)}
              className="w-full h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            onClick={() => setVideoModalOpen(true)}
            className="w-full h-20 cut-corners cut-border border-2 border-dashed border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--accent)] hover:[--cut-border-color:var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            Choose Video
          </button>
        )}

        {/* Poster — swatch + label when set (like Fill Image), Choose button when empty */}
        <div className="flex items-center justify-between w-full">
          <span className="w-3/4 text-xs font-medium text-[var(--text-secondary)] select-none">Poster</span>
          {poster ? (
            <button
              onClick={() => setPosterModalOpen(true)}
              className="w-full h-[var(--control-height)] flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] text-xs text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
            >
              <div
                className="w-6 h-6 rounded shrink-0 border border-[var(--border-light)]"
                style={{ backgroundImage: `url(${poster})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
              <span className="truncate">Image</span>
            </button>
          ) : (
            <button
              onClick={() => setPosterModalOpen(true)}
              className="w-full h-[var(--control-height)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] text-[var(--text-secondary)] hover:border-[var(--control-border-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              Choose
            </button>
          )}
        </div>

        {/* ToolAtom controls — all using UnifiedControlProvider */}
        <VideoControlsControl />
        <VideoAutoplayControl />
        <VideoLoopControl />
        <VideoMutedControl />
        <VideoPreloadControl />
        <VideoFitControl />
      </ToolSection>

      <VideoSearchModal isOpen={videoModalOpen} onClose={() => setVideoModalOpen(false)} onSelect={handleVideoSelect} />
      <ImageSearchModal isOpen={posterModalOpen} onClose={() => setPosterModalOpen(false)} onSelect={handlePosterSelect} />
    </>
  );
}
