// FillControl.tsx — Self-contained fill ToolAtom (compound: color/gradient/image/video).
// Supports Single mode (current behavior) and Multiple mode (stacked background layers).

import { useState, useRef, useEffect, useCallback } from 'react';
import { useLivePreview } from '../../../hooks/useLivePreview';
import { useAtomValue, useSetAtom } from 'jotai';
import LocaleBoundPill, { useLocaleStyleOverrides } from '@/editor/controls/LocaleBoundPill';
import { UnifiedControlProvider, useControlContext, useControlContextOptional, ShowControlLabels } from '../../../controls/unified';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import { VariableBoundPill, LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { useControlOptional } from '../../../controls/ControlProvider';
import { CmsBoundPill, CmsMissingPill } from '../../../controls/CmsBoundPill';
import type { MenuItem } from '../../../controls/control-menu-items';
import { createDefaultGradient, formatGradient } from '@/shared/gradient-utils';
import { toHexDisplay } from '../../../ui/color-utils';
import type { AtomProps } from '../../../controls/unified/types';
import { ToolSelect, ToolSegmentedControl, ControlActionRow, ColorSwatch, ControlLabel, RemoveButton } from '../../../controls';
import { YES_NO_OPTIONS } from '../../../controls/css-property-options';
import { useToolPopup } from '../../../ui/ToolPopup';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import ColorPicker from '../../../ui/ColorPicker';
import CreateColorPresetPanel from '../../../ui/CreateColorPresetPanel';
import GradientEditor from '../../../ui/GradientEditor';
import ImageSearchModal from '../../../ui/ImageSearchModal';
import CropModal from '../../../ui/CropModal';
import VideoSearchModal from '../../../ui/VideoSearchModal';
import AssetPresetGrid from '../../../ui/AssetPresetGrid';
import CreateImagePresetPanel from '../../../ui/CreateImagePresetPanel';
import CreateVideoPresetPanel from '../../../ui/CreateVideoPresetPanel';
import EditAssetPresetPanel from '../../../ui/EditAssetPresetPanel';
import ColorPresetEditPanel from '../../../ui/ColorPresetEditPanel';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { isComponentFileAtom } from '@/code/stores/store';
import { activeCodeAtom } from '@/code/project/active-file-store';
import { getPropType } from '@/code/components/prop-meta';
import {
  parseBackgroundLayers, formatBackgroundLayers, isMultiLayerBackground,
  createDefaultLayer, getLayerLabel,
  type BgLayer, type BgLayerType,
} from '../../../ui/background-layer-utils';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { presetTokensAtom, livePresetTokenAtom } from '@/code/stores/preset-store';
import { resolveCssTokens } from '@/code/project/preset-ops';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { instantCreateAndEditVariable } from '../../../controls/instant-create-variable';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { variableModalRequestAtom } from '@/code/stores/store';
import { canAcceptChildren } from '@/shared/constants';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

// ─── Shared Constants ───────────────────────────────────────────────────────

const SIZE_OPTIONS = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'auto', label: 'Auto' },
  { value: '100% 100%', label: 'Stretch' },
];

const POSITION_OPTIONS = [
  { value: 'center', label: 'Center' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top left', label: 'Top Left' },
  { value: 'top right', label: 'Top Right' },
  { value: 'bottom left', label: 'Bottom Left' },
  { value: 'bottom right', label: 'Bottom Right' },
];

const REPEAT_OPTIONS = [
  { value: 'no-repeat', label: 'No Repeat' },
  { value: 'repeat', label: 'Repeat' },
  { value: 'repeat-x', label: 'Repeat X' },
  { value: 'repeat-y', label: 'Repeat Y' },
];

const ATTACHMENT_OPTIONS = [
  { value: 'scroll', label: 'Scroll' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'local', label: 'Local' },
];

const BLEND_MODE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

// ─── Image Fill Tab (shared between Single and Multiple) ────────────────────

function ImageFillTab({ styles, onUpdate }: { styles: Record<string, string>; onUpdate: (k: string, v: string) => void }) {
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const { pushPanel, popPanel } = useToolPopup();
  const allTokens = useAtomValue(presetTokensAtom);
  const imagePresets = allTokens.filter(t => t.category === 'image');

  const bg = styles.backgroundImage || '';
  // Detect var(--image-name) — i.e. the user has applied an image preset.
  const presetMatch = bg.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  const activePresetName = presetMatch && imagePresets.some(p => p.name === presetMatch[1])
    ? presetMatch[1]
    : undefined;
  // Resolve the underlying URL for preview (preset reference or direct url()).
  const previewUrl = activePresetName
    ? extractUrl(imagePresets.find(p => p.name === activePresetName)?.value || '')
    : extractUrl(bg);
  const hasImage = !!previewUrl;
  const previewBg = previewUrl ? `url(${previewUrl})` : 'none';

  const handleCreatePreset = useCallback(() => {
    pushPanel('New Image Preset', (
      <CreateImagePresetPanel initialValue={bg} onCreated={() => popPanel()} />
    ));
  }, [pushPanel, popPanel, bg]);

  const handleEditPreset = useCallback((name: string) => {
    const token = imagePresets.find(t => t.name === name);
    if (!token) return;
    const displayName = token.label || name.replace(/^image-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    pushPanel(`Edit "${displayName}"`, (
      <EditAssetPresetPanel
        presetName={name}
        type="image"
        initialValue={token.value}
        onDeleted={() => popPanel()}
      />
    ));
  }, [pushPanel, popPanel, imagePresets]);

  return (
    <div className="flex flex-col gap-2">
      {/* Image preview + Choose button */}
      {hasImage ? (
        <div className="flex flex-col gap-2">
          <div className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
            onClick={() => setImageModalOpen(true)}
            style={{ backgroundImage: previewBg, backgroundSize: styles.backgroundSize || 'cover', backgroundPosition: styles.backgroundPosition || 'center' }}
          />
          <div className="flex gap-1.5">
            <button onClick={() => setImageModalOpen(true)}
              className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer">
              Change
            </button>
            {/* Crop — opens a modal to crop the current image, then replaces the
                fill with the cropped upload (undo-safe: it's a style write). */}
            <button onClick={() => setCropModalOpen(true)}
              className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer flex items-center justify-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" />
              </svg>
              Crop
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setImageModalOpen(true)}
          className="w-full h-20 rounded-lg border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
          Choose Image
        </button>
      )}

      {/* Size/Position/Repeat/Attachment controls — only when image is set */}
      {hasImage && (
        <>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Size" property="backgroundSize" plain />
            <ToolSelect value={styles.backgroundSize || 'cover'} onChange={(v) => onUpdate('backgroundSize', v)} options={SIZE_OPTIONS} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Position" property="backgroundPosition" plain />
            <ToolSelect value={styles.backgroundPosition || 'center'} onChange={(v) => onUpdate('backgroundPosition', v)} options={POSITION_OPTIONS} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Repeat" property="backgroundRepeat" plain />
            <ToolSelect value={styles.backgroundRepeat || 'no-repeat'} onChange={(v) => onUpdate('backgroundRepeat', v)} options={REPEAT_OPTIONS} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Attachment" property="backgroundAttachment" plain />
            <ToolSelect value={styles.backgroundAttachment || 'scroll'} onChange={(v) => onUpdate('backgroundAttachment', v)} options={ATTACHMENT_OPTIONS} />
          </div>
        </>
      )}

      {/* Image preset grid + Create new entry */}
      <AssetPresetGrid
        presets={imagePresets}
        type="image"
        activePresetName={activePresetName}
        onApplyPreset={(varVal) => {
          // Apply preset reference; clear conflicting fill props that might
          // have come from a prior solid/gradient/raw-url selection.
          onUpdate('backgroundColor', '');
          onUpdate('background', '');
          onUpdate('backgroundImage', varVal);
          // ALWAYS (re)write size/position/repeat — preserve the authored
          // value, default otherwise. The `background: ''` clear above wipes
          // every background-* longhand from the inline DOM style (CSSOM
          // shorthand semantics), and a value unchanged in CODE is never
          // repaired by the render diff — the image painted at `auto` (huge)
          // until Size was touched (user report 2026-07-30).
          onUpdate('backgroundSize', styles.backgroundSize || 'cover');
          onUpdate('backgroundPosition', styles.backgroundPosition || 'center');
          onUpdate('backgroundRepeat', styles.backgroundRepeat || 'no-repeat');
          trace.action('fill:image-preset-applied', { var: varVal });
        }}
        onCreatePreset={handleCreatePreset}
        onEditPreset={handleEditPreset}
      />

      {/* Image Search Modal */}
      <ImageSearchModal
        isOpen={imageModalOpen}
        onClose={() => setImageModalOpen(false)}
        onSelect={(url) => {
          onUpdate('backgroundColor', '');
          onUpdate('background', '');
          onUpdate('backgroundImage', `url(${url})`);
          // Preserve the existing size/position/repeat when CHANGING the image
          // (e.g. keep `Contain`), default otherwise — written UNCONDITIONALLY
          // to repair the `background: ''` shorthand wipe (see preset path).
          onUpdate('backgroundSize', styles.backgroundSize || 'cover');
          onUpdate('backgroundPosition', styles.backgroundPosition || 'center');
          onUpdate('backgroundRepeat', styles.backgroundRepeat || 'no-repeat');
          trace.action('fill:image-selected', { url: url.slice(0, 80) });
        }}
      />

      {/* Crop Modal — crops the CURRENT image and replaces the fill with the
          cropped upload. The style write goes through `onUpdate` (mutation
          queue), so Cmd+Z reverts to the original image. */}
      <CropModal
        isOpen={cropModalOpen}
        onClose={() => setCropModalOpen(false)}
        src={previewUrl}
        onApply={(url) => {
          onUpdate('backgroundColor', '');
          onUpdate('background', '');
          onUpdate('backgroundImage', `url(${url})`);
          // Unconditional for the shorthand-wipe repair (see preset path).
          onUpdate('backgroundSize', styles.backgroundSize || 'cover');
          onUpdate('backgroundPosition', styles.backgroundPosition || 'center');
          onUpdate('backgroundRepeat', styles.backgroundRepeat || 'no-repeat');
          trace.action('fill:image-cropped', { url: url.slice(0, 80) });
        }}
      />
    </div>
  );
}

/** Pull URL out of `url(...)` wrapper (handles single/double/no quotes). */
function extractUrl(value: string): string | null {
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  return m ? m[1] : null;
}

// ─── Single Mode Fill Popup Content ─────────────────────────────────────────

type FillTab = 'color' | 'gradient' | 'image' | 'video';

function detectFillTab(styles: Record<string, string>, node?: CanvasNode | null): FillTab {
  // bg-video child on the node = Video tab. This is the new canonical state;
  // the legacy `backgroundVideo` style key was a no-op CSS prop that the parser
  // now strips silently, so we don't check it here.
  if (node?.bgVideo) return 'video';
  const bgImage = styles.backgroundImage || '';
  // Direct url() — Image tab.
  if (bgImage.includes('url(')) return 'image';
  // Image preset reference (`var(--image-...)`). Other var() refs fall through
  // to color tab so things like `var(--color-brand)` don't open Image.
  if (/^var\(\s*--image-/.test(bgImage)) return 'image';
  if (styles.background?.includes('gradient') || bgImage.includes('gradient')) return 'gradient';
  return 'color';
}

/** Transparent-checker pattern for the empty poster swatch — matches the
 *  alpha-checker visual the rest of the editor uses for "no value yet". */
const ALPHA_CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(255,255,255,0.15) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.15) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.15) 75%)',
  backgroundSize: '6px 6px',
  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
};

const VIDEO_OBJECT_FIT_OPTIONS = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Stretch' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];

function VideoFillTab({ node }: { node: CanvasNode | null }) {
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const posterInputRef = useRef<HTMLInputElement>(null);
  const { pushPanel, popPanel } = useToolPopup();
  const allTokens = useAtomValue(presetTokensAtom);
  const videoPresets = allTokens.filter(t => t.category === 'video');

  const nodeId = node?.id ?? null;
  const nodeTag = node?.type ?? null;
  const acceptsChildren = nodeTag ? canAcceptChildren(nodeTag) : true;

  const cfg = node?.bgVideo;
  const currentUrl = cfg?.src ?? '';
  const activePresetName = currentUrl
    ? videoPresets.find(p => p.value === currentUrl)?.name
    : undefined;
  const hasVideo = !!currentUrl;

  // Partial-update wrapper — every toggle/select calls this with one field.
  const patchVideo = useCallback((opts: Parameters<typeof queueMutation>[0] extends infer _ ? Record<string, unknown> : never) => {
    if (!nodeId) return;
    queueMutation({ type: 'setVideoFill', nodeId, opts: opts as any });
    trace.action('fill:video-patched', { nodeId, fields: Object.keys(opts) });
  }, [nodeId]);

  // Apply a NEW src — used by the file picker and by preset-apply. Also
  // clears competing fills that may be set on the host.
  const applyVideoSrc = useCallback((url: string) => {
    if (!nodeId) return;
    queueMutation({ type: 'setVideoFill', nodeId, opts: { src: url } });
    queueMutation({ type: 'updateStyles', nodeId, styles: {
      backgroundColor: '',
      background: '',
      backgroundImage: '',
      backgroundVideo: '',
    } });
    trace.action('fill:video-src-applied', { nodeId, urlLength: url.length });
  }, [nodeId]);

  const handleCreatePreset = useCallback(() => {
    pushPanel('New Video Preset', (
      <CreateVideoPresetPanel initialValue={currentUrl} onCreated={() => popPanel()} />
    ));
  }, [pushPanel, popPanel, currentUrl]);

  const handleEditPreset = useCallback((name: string) => {
    const token = videoPresets.find(t => t.name === name);
    if (!token) return;
    const displayName = token.label || name.replace(/^video-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    pushPanel(`Edit "${displayName}"`, (
      <EditAssetPresetPanel
        presetName={name}
        type="video"
        initialValue={token.value}
        onDeleted={() => popPanel()}
      />
    ));
  }, [pushPanel, popPanel, videoPresets]);

  if (!acceptsChildren) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <p className="text-[10px] text-[var(--text-disabled)]">
          Video backgrounds need an element that can hold children — switch the
          tag to a frame (div / section / etc.) first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasVideo ? (
        <div className="flex flex-col gap-2">
          <div
            className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden bg-black cursor-pointer hover:opacity-90 transition-opacity"
            onClick={() => setVideoModalOpen(true)}
          >
            <video
              src={currentUrl}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
              className="w-full h-full object-cover pointer-events-none"
            />
          </div>
          <button onClick={() => setVideoModalOpen(true)}
            className="w-full h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer">
            Change
          </button>
        </div>
      ) : (
        <button onClick={() => setVideoModalOpen(true)}
          className="w-full h-20 rounded-lg border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          Choose Video
        </button>
      )}

      {/* HTML video controls — only shown when a video is set. Each row writes
          one field via setVideoFill (idempotent partial update). Boolean
          fields use a Yes/No segmented control to match the rest of the
          editor (no naked switches). */}
      {hasVideo && cfg && (
        <div className="flex flex-col gap-2 border-t border-[var(--border-light)] pt-2">
          <div className="flex items-center justify-between">
            <ControlLabel label="Autoplay" property="autoplay" plain />
            <ToolSegmentedControl size="sm" value={cfg.autoPlay ? 'yes' : 'no'}
              onChange={(v) => patchVideo({ autoPlay: v === 'yes' })} options={YES_NO_OPTIONS} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Muted" property="muted" plain />
            <ToolSegmentedControl size="sm" value={cfg.muted ? 'yes' : 'no'}
              onChange={(v) => patchVideo({ muted: v === 'yes' })} options={YES_NO_OPTIONS} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Loop" property="loop" plain />
            <ToolSegmentedControl size="sm" value={cfg.loop ? 'yes' : 'no'}
              onChange={(v) => patchVideo({ loop: v === 'yes' })} options={YES_NO_OPTIONS} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Plays Inline" property="playsInline" plain />
            <ToolSegmentedControl size="sm" value={cfg.playsInline ? 'yes' : 'no'}
              onChange={(v) => patchVideo({ playsInline: v === 'yes' })} options={YES_NO_OPTIONS} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Controls" property="controls" plain />
            <ToolSegmentedControl size="sm" value={cfg.controls ? 'yes' : 'no'}
              onChange={(v) => patchVideo({ controls: v === 'yes' })} options={YES_NO_OPTIONS} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Fit" property="objectFit" plain />
            <ToolSelect
              value={cfg.objectFit || 'cover'}
              onChange={(v) => patchVideo({ objectFit: v })}
              options={VIDEO_OBJECT_FIT_OPTIONS}
            />
          </div>
          {/* Poster — single ControlActionRow matching the Fill row pattern.
              Swatch shows the image when set (or a transparent-checker pattern
              when empty), label reads "Upload…" when empty / a short caption
              when set. Whole row triggers the OS file picker; × clears. */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Poster" property="poster" plain />
            <ControlActionRow
              onClick={() => posterInputRef.current?.click()}
              className="justify-between"
            >
              <span className="flex items-center gap-2 truncate">
                <ColorSwatch
                  style={cfg.poster
                    ? { backgroundImage: `url(${cfg.poster})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : ALPHA_CHECKER_STYLE}
                />
                <span className={`text-xs truncate ${cfg.poster ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                  {cfg.poster ? 'Poster set' : 'Upload…'}
                </span>
              </span>
              {cfg.poster && (
                <span
                  onClick={(e) => { e.stopPropagation(); patchVideo({ poster: '' }); }}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm leading-none cursor-pointer shrink-0 px-1"
                >
                  &times;
                </span>
              )}
            </ControlActionRow>
            <input
              ref={posterInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === 'string') {
                    patchVideo({ poster: reader.result });
                  }
                };
                reader.readAsDataURL(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      )}

      {/* Video preset grid */}
      <AssetPresetGrid
        presets={videoPresets}
        type="video"
        activePresetName={activePresetName}
        onApplyPreset={(varVal) => {
          // Bake the preset URL into <video src> at apply-time. <video src>
          // can't resolve CSS vars, so storing `var(--video-foo)` wouldn't
          // work — see design notes.
          const m = varVal.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
          const tokenName = m?.[1];
          const token = tokenName ? videoPresets.find(p => p.name === tokenName) : undefined;
          if (token) applyVideoSrc(token.value);
        }}
        onCreatePreset={handleCreatePreset}
        onEditPreset={handleEditPreset}
      />

      <VideoSearchModal
        isOpen={videoModalOpen}
        onClose={() => setVideoModalOpen(false)}
        onSelect={applyVideoSrc}
      />
    </div>
  );
}

function SingleModeFillContent({ styles, onUpdate, onLivePreview }: { styles: Record<string, string>; onUpdate: (k: string, v: string) => void; onLivePreview?: (color: string | null) => void }) {
  const ctx = useControlContextOptional();
  // Legacy control ctx exposes `updateStyleLive` — the fast canvas-only DOM
  // patch used for smooth drags (commit via onUpdate on release).
  const legacyCtl = useControlOptional();
  const nodeId = ctx?.nodeId ?? null;
  const node = ctx?.node ?? null;
  const [tab, setTab] = useState<FillTab>(() => detectFillTab(styles, node));
  const { pushPanel, popPanel } = useToolPopup();
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = allTokens.filter(t => t.category === 'color');

  const handleCreatePreset = useCallback((color: string) => {
    pushPanel('New Color Preset', (
      <CreateColorPresetPanel initialColor={color} onCreated={() => popPanel()} />
    ));
    trace.action('fill-control:create-preset-panel', { color });
  }, [pushPanel, popPanel]);

  // Re-detect tab ONLY when selected node changes (not during editing)
  useEffect(() => {
    setTab(detectFillTab(styles, node));
  }, [nodeId]);

  return (
    <>
      {/* Tabs at top of popup */}
      <ToolSegmentedControl
        value={tab}
        onChange={(v) => {
          const newTab = v as FillTab;
          trace.action('fill:tab-change', { from: tab, to: newTab });

          // Clear conflicting fill properties when switching tabs
          if (newTab !== tab) {
            if (tab === 'color') onUpdate('backgroundColor', '');
            if (tab === 'gradient') { onUpdate('background', ''); onUpdate('backgroundImage', ''); }
            if (tab === 'image') { onUpdate('backgroundImage', ''); onUpdate('backgroundSize', ''); onUpdate('backgroundPosition', ''); onUpdate('backgroundRepeat', ''); onUpdate('backgroundAttachment', ''); }
            // Leaving the Video tab — remove the bg-video child via the
            // dedicated mutation, since it lives on the node, not in styles.
            if (tab === 'video' && nodeId) {
              queueMutation({ type: 'removeVideoFill', nodeId });
            }
          }
          setTab(newTab);
        }}
        options={[
          { value: 'color', label: 'Color' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video' },
        ]}
        size="sm"
      />

      {/* Tab content */}
      {tab === 'color' && (() => {
        const bgVal = styles.backgroundColor || '';
        const currentPresetName = bgVal.startsWith('var(--') ? parseVarRef(bgVal) || '' : '';
        const resolvedBg = currentPresetName
          ? (colorPresets.find(t => t.name === currentPresetName)?.value || '#000000')
          : (bgVal || '#000000');
        return (
          <ColorPicker
            value={resolvedBg}
            // Smooth drag: onChange LIVE-PATCHES the canvas DOM every frame (no
            // per-frame code write); onChangeEnd commits once on release (and
            // immediately for one-shot edits: hex input, eyedropper). Falls back
            // to a per-frame code write when there's no live ctx.
            onChange={legacyCtl
              ? (c) => { legacyCtl.updateStyleLive('backgroundColor', c); onLivePreview?.(c); }
              : (c) => { trace.action('fill:color', { value: c }); onUpdate('backgroundColor', c); }}
            onChangeEnd={legacyCtl ? (c) => { trace.action('fill:color', { value: c }); onLivePreview?.(c); onUpdate('backgroundColor', c); } : undefined}
            showAlpha
            onCreatePreset={handleCreatePreset}
            colorPresets={colorPresets}
            onApplyPreset={(varVal) => { onUpdate('backgroundColor', varVal); }}
            activePresetName={currentPresetName || undefined}
            onEditPreset={(name) => {
              const token = colorPresets.find(t => t.name === name);
              if (!token) return;
              const displayName = (token.label || name.replace(/^color-/, '')).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              pushPanel(`Edit "${displayName}"`, (
                <ColorPresetEditPanel
                  presetName={name}
                  initialValue={token.value}
                  onUpdate={(val) => {
                    // Canvas-side fast path + queued persistence — same as
                    // ColorInput / GradientEditor wire it. The shared panel
                    // handles dark-mode internally via setDarkTokenValue.
                    const bridge = getCanvasBridge() as any;
                    if (typeof bridge?.setCanvasTokenVar === 'function') {
                      bridge.setCanvasTokenVar(name, val);
                    }
                    queueMutation({ type: 'updatePresetToken', name, value: val });
                  }}
                />
              ));
            }}
          />
        );
      })()}

      {tab === 'gradient' && (
        <GradientEditor
          value={styles.backgroundImage || styles.background || ''}
          onChange={(css) => {
            // Clear conflicting props FIRST — `background: ''` wipes every
            // background-* longhand from the inline DOM (CSSOM shorthand
            // semantics), so it must precede the backgroundImage write.
            if (styles.background) onUpdate('background', '');
            if (styles.backgroundColor) onUpdate('backgroundColor', '');
            onUpdate('backgroundImage', css);
          }}
          // Smooth drag: patch the canvas DOM directly every frame (no code
          // re-parse); GradientEditor fires onChange once on release to commit.
          onLiveChange={legacyCtl ? (css) => legacyCtl.updateStyleLive('backgroundImage', css) : undefined}
        />
      )}

      {tab === 'image' && (
        <ImageFillTab styles={styles} onUpdate={onUpdate} />
      )}

      {tab === 'video' && (
        <VideoFillTab node={node} />
      )}
    </>
  );
}

// ─── Layer Editor Panel (pushPanel content for Multiple mode) ────────────────

function LayerEditorPanel({ layer: initialLayer, onChange }: { layer: BgLayer; onChange: (updated: BgLayer) => void }) {
  // Own local state so the panel is reactive even inside a frozen pushPanel
  const [layer, setLayer] = useState<BgLayer>(initialLayer);
  const [tab, setTab] = useState<'color' | 'gradient' | 'image'>(() => initialLayer.type);
  const [imageModalOpen, setImageModalOpen] = useState(false);

  // External re-seed (undo/redo while a layer panel is open). Own updates
  // flow through `update` below (local sig kept in step), so a differing
  // incoming layer is always external.
  const initLayerSig = JSON.stringify(initialLayer);
  const localLayerSigRef = useRef(initLayerSig);
  const prevInitLayerSigRef = useRef(initLayerSig);
  useEffect(() => {
    if (initLayerSig === prevInitLayerSigRef.current) return;
    prevInitLayerSigRef.current = initLayerSig;
    if (localLayerSigRef.current === initLayerSig) return;
    localLayerSigRef.current = initLayerSig;
    setLayer(initialLayer);
    setTab(initialLayer.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initLayerSig]);

  // Update local + flush to parent in one call
  const update = useCallback((updated: BgLayer) => {
    setLayer(updated);
    localLayerSigRef.current = JSON.stringify(updated);
    onChange(updated);
  }, [onChange]);

  return (
    <div className="flex flex-col gap-3">
      {/* Type selector */}
      <ToolSegmentedControl
        value={tab}
        onChange={(v) => {
          const newTab = v as 'color' | 'gradient' | 'image';
          trace.action('fill-layer:tab-change', { layerId: layer.id, from: tab, to: newTab });
          setTab(newTab);
          // Set a default value for the new type
          if (newTab === 'gradient' && !layer.value.includes('gradient')) {
            update({ ...layer, type: 'gradient', value: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.8) 100%)' });
          } else if (newTab === 'image' && !layer.value.includes('url(')) {
            update({ ...layer, type: 'image', value: '' });
          } else if (newTab === 'color') {
            update({ ...layer, type: 'color', value: 'linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5))' });
          }
        }}
        options={[
          { value: 'color', label: 'Color' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'image', label: 'Image' },
        ]}
        size="sm"
      />

      {/* Editor for the type */}
      {tab === 'color' && (
        <ColorPicker
          value={(() => {
            // Extract color from flat gradient like "linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5))"
            // (rgba/rgb, hsla/hsl, or hex — the solid-color trick can use any).
            const match = layer.value.match(/rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
            return match ? match[0] : '#000000';
          })()}
          onChange={(c) => {
            // Wrap color as a flat gradient (CSS backgroundImage needs gradient or url, not bare colors)
            update({ ...layer, type: 'color', value: `linear-gradient(${c}, ${c})` });
          }}
          showAlpha
        />
      )}

      {tab === 'gradient' && (
        <GradientEditor
          value={layer.value}
          onChange={(css) => update({ ...layer, type: 'gradient', value: css })}
        />
      )}

      {tab === 'image' && (
        <div className="flex flex-col gap-3">
          {layer.value.includes('url(') ? (
            <div className="flex flex-col gap-2">
              <div className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setImageModalOpen(true)}
                style={{ backgroundImage: layer.value, backgroundSize: layer.size || 'cover', backgroundPosition: layer.position || 'center' }}
              />
              <div className="flex gap-1.5">
                <button onClick={() => setImageModalOpen(true)}
                  className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer">
                  Change
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setImageModalOpen(true)}
              className="w-full h-20 rounded-lg border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
              </svg>
              Choose Image
            </button>
          )}
          <ImageSearchModal
            isOpen={imageModalOpen}
            onClose={() => setImageModalOpen(false)}
            onSelect={(url) => {
              update({ ...layer, type: 'image', value: `url(${url})` });
              trace.action('fill-layer:image-selected', { layerId: layer.id, url: url.slice(0, 80) });
            }}
          />
        </div>
      )}

      {/* Per-layer controls — Size/Position/Repeat/Attachment only for images.
          Gradients already have their own direction/shape/center/repeat in GradientEditor.
          Blend mode is relevant for all layer types. */}
      <div className="border-t border-[var(--border-light)] pt-3 flex flex-col gap-2">
        {tab === 'image' && (
          <>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Size" property="backgroundSize" plain />
              <ToolSelect value={layer.size} onChange={(v) => update({ ...layer, size: v })} options={SIZE_OPTIONS} />
            </div>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Position" property="backgroundPosition" plain />
              <ToolSelect value={layer.position} onChange={(v) => update({ ...layer, position: v })} options={POSITION_OPTIONS} />
            </div>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Repeat" property="backgroundRepeat" plain />
              <ToolSelect value={layer.repeat} onChange={(v) => update({ ...layer, repeat: v })} options={REPEAT_OPTIONS} />
            </div>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Attachment" property="backgroundAttachment" plain />
              <ToolSelect value={layer.attachment} onChange={(v) => update({ ...layer, attachment: v })} options={ATTACHMENT_OPTIONS} />
            </div>
          </>
        )}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Blend" property="backgroundBlendMode" plain />
          <ToolSelect value={layer.blendMode} onChange={(v) => update({ ...layer, blendMode: v })} options={BLEND_MODE_OPTIONS} />
        </div>
      </div>
    </div>
  );
}

// ─── Sortable Layer Row ─────────────────────────────────────────────────────

function SortableLayerRow({ layer, onEdit, onRemove }: {
  layer: BgLayer;
  onEdit: (layer: BgLayer) => void;
  onRemove: (layerId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: layer.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 1,
  };

  return (
    // The WHOLE row is the drag handle (dnd-kit listeners here, not just the grip) AND the click target:
    // the PointerSensor's `distance: 3` activation means a press-and-move REORDERS, while a plain click (no
    // movement) falls through to onClick → edit the layer. Mouse-down anywhere on the row to drag; click to enter.
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onEdit(layer)}
      className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-grab active:cursor-grabbing touch-none
        ${isDragging ? 'border-[var(--accent)] shadow-lg' : 'border-[var(--control-border)] hover:border-[var(--control-border-hover)]'}
        bg-[var(--grid-line)]`}
    >
      {/* Grip — now just a visual affordance (the whole row drags). */}
      <div className="flex-shrink-0 text-[var(--text-disabled)]">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
          <circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/>
          <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
          <circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/>
        </svg>
      </div>

      {/* Swatch */}
      <div
        className="flex-shrink-0 w-6 h-6 rounded border border-[var(--border-light)] overflow-hidden"
        style={layer.type === 'image'
          ? { backgroundImage: layer.value, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: layer.value }
        }
      />

      {/* Label */}
      <span className="flex-1 text-xs text-[var(--text-primary)] truncate">
        {getLayerLabel(layer)}
      </span>

      {/* Remove — stop pointer/click from starting a drag or entering the layer. */}
      <span onPointerDown={(e) => e.stopPropagation()}>
        <RemoveButton onClick={(e) => { e.stopPropagation(); onRemove(layer.id); }} />
      </span>
    </div>
  );
}

// ─── Multiple Mode Fill Content ─────────────────────────────────────────────

function MultiModeFillContent({ styles, onUpdate, onChangeMultiple }: {
  styles: Record<string, string>;
  onUpdate: (k: string, v: string) => void;
  onChangeMultiple: (s: Record<string, string>) => void;
}) {
  const { pushPanel } = useToolPopup();
  const [layers, setLayers] = useState<BgLayer[]>(() => parseBackgroundLayers(styles));
  const ctx = useControlContextOptional();
  const nodeId = ctx?.nodeId ?? null;

  // Re-parse on node change AND on EXTERNAL style changes (undo/redo while
  // the Fill popup is open) — the id-only sync kept deleted/changed layers
  // in the list until reselect. Own flushes are skipped via the self-write
  // counter (ShadowControl's pattern).
  const bgSig = `${styles.backgroundImage ?? ''}|${styles.backgroundColor ?? ''}|${styles.background ?? ''}`;
  const selfWriteRef = useRef(0);
  const prevBgSigRef = useRef(bgSig);
  useEffect(() => {
    setLayers(parseBackgroundLayers(styles));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  useEffect(() => {
    if (bgSig === prevBgSigRef.current) return;
    prevBgSigRef.current = bgSig;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    trace.action('fill-multi:reseed-from-parse', { nodeId });
    setLayers(parseBackgroundLayers(styles));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSig]);

  // Flush layers to CSS
  const flushLayers = useCallback((newLayers: BgLayer[]) => {
    setLayers(newLayers);
    selfWriteRef.current++;
    const css = formatBackgroundLayers(newLayers);
    onChangeMultiple({ ...css, background: '' });
    trace.action('fill-multi:flush', { layerCount: newLayers.length });
  }, [onChangeMultiple]);

  const removeLayer = useCallback((layerId: string) => {
    const newLayers = layers.filter(l => l.id !== layerId);
    flushLayers(newLayers);
    trace.action('fill-multi:remove-layer', { layerId });
  }, [layers, flushLayers]);

  const addLayer = useCallback((type: BgLayerType) => {
    const layer = createDefaultLayer(type);
    const newLayers = [layer, ...layers];
    flushLayers(newLayers);
    trace.action('fill-multi:add-layer', { type, layerId: layer.id });
    return layer;
  }, [layers, flushLayers]);

  const openLayerEditor = useCallback((layer: BgLayer) => {
    const label = getLayerLabel(layer);
    pushPanel(label, (
      <LayerEditorPanelConnected
        layerId={layer.id}
        layersRef={layersRef}
        onFlush={flushLayers}
      />
    ));
  }, [pushPanel, flushLayers]);

  // Keep a ref to layers so the pushPanel content can read current state
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // ── dnd-kit sortable ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const currentLayers = layersRef.current;
    const oldIdx = currentLayers.findIndex(l => l.id === active.id);
    const newIdx = currentLayers.findIndex(l => l.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const reordered = arrayMove(currentLayers, oldIdx, newIdx);
    flushLayers(reordered);
    trace.action('fill-multi:reorder', { layerId: active.id as string, from: oldIdx, to: newIdx });
  }, [flushLayers]);

  const layerIds = layers.map(l => l.id);

  return (
    <div className="flex flex-col gap-2">
      {/* Sortable layer list */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={layerIds} strategy={verticalListSortingStrategy}>
          {layers.map((layer) => (
            <SortableLayerRow
              key={layer.id}
              layer={layer}
              onEdit={openLayerEditor}
              onRemove={removeLayer}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* + Add Layer */}
      <div className="flex gap-1.5">
        <button
          onClick={() => { const l = addLayer('gradient'); openLayerEditor(l); }}
          className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
        >
          + Gradient
        </button>
        <button
          onClick={() => { const l = addLayer('image'); openLayerEditor(l); }}
          className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
        >
          + Image
        </button>
        <button
          onClick={() => { const l = addLayer('color'); openLayerEditor(l); }}
          className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
        >
          + Color
        </button>
      </div>
    </div>
  );
}

// ─── Connected Layer Editor (reads from ref to stay in sync) ────────────────

function LayerEditorPanelConnected({ layerId, layersRef, onFlush }: {
  layerId: string;
  layersRef: React.RefObject<BgLayer[]>;
  onFlush: (layers: BgLayer[]) => void;
}) {
  // Find the layer by ID from current ref
  const layer = layersRef.current?.find(l => l.id === layerId);
  if (!layer) return <div className="text-xs text-[var(--text-disabled)]">Layer removed</div>;

  return (
    <LayerEditorPanel
      layer={layer}
      onChange={(updated) => {
        const newLayers = (layersRef.current || []).map(l => l.id === layerId ? updated : l);
        onFlush(newLayers);
      }}
    />
  );
}

// ─── Fill Popup Content (Single/Multiple mode switch) ───────────────────────

type FillMode = 'single' | 'multiple';

function FillPopupContent({ styles, onUpdate, onChangeMultiple, nodeId: nodeIdProp, onLivePreview }: {
  styles: Record<string, string>;
  onUpdate: (k: string, v: string) => void;
  onChangeMultiple: (s: Record<string, string>) => void;
  nodeId?: string | null;
  /** Per-frame solid-color preview for the row swatch during a picker drag. */
  onLivePreview?: (color: string | null) => void;
}) {
  const ctx = useControlContextOptional();
  const nodeId = ctx?.nodeId ?? nodeIdProp ?? null;
  const [mode, setMode] = useState<FillMode>(() =>
    isMultiLayerBackground(styles) ? 'multiple' : 'single'
  );

  // Re-detect mode on node change AND on external style changes (an undo
  // that reverts multi-layer → single must flip the tab back).
  const modeSig = `${nodeId}|${isMultiLayerBackground(styles)}`;
  const prevModeSigRef = useRef(modeSig);
  useEffect(() => {
    if (modeSig === prevModeSigRef.current) return;
    prevModeSigRef.current = modeSig;
    setMode(isMultiLayerBackground(styles) ? 'multiple' : 'single');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSig]);

  const handleModeChange = useCallback((v: string) => {
    const newMode = v as FillMode;
    trace.action('fill:mode-change', { from: mode, to: newMode });

    if (newMode === 'multiple' && mode === 'single') {
      // Convert current single fill to a layer if there's a gradient or image
      // backgroundColor stays as base color — no conversion needed
      // backgroundImage (gradient or url) becomes Layer 1
    }

    if (newMode === 'single' && mode === 'multiple') {
      // Keep only the top layer + backgroundColor
      const layers = parseBackgroundLayers(styles);
      if (layers.length > 0) {
        const top = layers[0];
        if (top.type === 'gradient' || top.type === 'color') {
          onChangeMultiple({
            backgroundImage: top.value,
            backgroundSize: '',
            backgroundPosition: '',
            backgroundRepeat: '',
            backgroundAttachment: '',
            backgroundBlendMode: '',
            background: '',
          });
        } else if (top.type === 'image') {
          onChangeMultiple({
            backgroundImage: top.value,
            backgroundSize: top.size,
            backgroundPosition: top.position,
            backgroundRepeat: top.repeat,
            backgroundAttachment: top.attachment,
            backgroundBlendMode: '',
            background: '',
          });
        }
      }
    }

    setMode(newMode);
  }, [mode, styles, onChangeMultiple]);

  return (
    // Force the image sub-field labels (Size / Position / Repeat / Attachment / Blend) visible inside the
    // popup even when the atom carries `hideLabel` from the Variable modal's Default row.
    <ShowControlLabels>
      {/* Mode toggle */}
      <ToolSegmentedControl
        value={mode}
        onChange={handleModeChange}
        options={[
          { value: 'single', label: 'Single' },
          { value: 'multiple', label: 'Multiple' },
        ]}
        size="sm"
      />

      {mode === 'single' ? (
        <SingleModeFillContent styles={styles} onUpdate={onUpdate} onLivePreview={onLivePreview} />
      ) : (
        <MultiModeFillContent styles={styles} onUpdate={onUpdate} onChangeMultiple={onChangeMultiple} />
      )}
    </ShowControlLabels>
  );
}

// ─── Fill Atom (inner component) ─────────────────────────────────────────────

function FillAtom() {
  const { node, onChangeMultiple, binding, mode, allProps, hasVariable } = useControlContext();
  const legacyCtl = useControlOptional();
  const styles = allProps;
  const btnRef = useRef<HTMLSpanElement>(null);
  const allTokens = useAtomValue(presetTokensAtom);
  const { openPanel, panelPopup } = useEditorPanel('Fill', () => (
    <FillPopupContent styles={styles} onUpdate={onUpdate} onChangeMultiple={onChangeMultiple} onLivePreview={setLivePreviewColor} />
  ), { width: 280 });
  // File-aware accent: purple ("--accent-secondary") on component master files,
  // standard accent (blue) on regular pages — same convention applied across
  // the menu items + bound pill.
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const fillHoverColor: 'accent' | 'accent-secondary' = isComponentFile ? 'accent-secondary' : 'accent';
  // Locale `:lang()` overrides on the fill → blue Locale pill (Phase 4).
  const fillLocaleOverrides = useLocaleStyleOverrides('backgroundColor', node?.id ?? null);
  // Active file code — used to read a bound Fill variable's @propMeta TYPE so an
  // image/video variable can surface its object-fit + focal-point rows inline.
  const activeCode = useAtomValue(activeCodeAtom);

  // Live color-drag preview for the row swatch + hex label. While the user
  // drags the Fill color picker the canvas is patched DOM-only (no commit), so
  // the committed `styles.backgroundColor` stays frozen and the row swatch
  // would lag until release. Mirror the dragged color here so the swatch tracks
  // it in real time WITHOUT a per-frame code write (which is what made it low
  // FPS before). The effect clears the override the moment the committed value
  // changes (the release re-parse) — no flicker, because by then the committed
  // value equals the last dragged color; and it never masks a later external
  // edit (preset apply, undo) since any real change to backgroundColor resets it.
  const [livePreviewColor, setLivePreviewColor] = useLivePreview<string>([styles.backgroundColor]);

  // Live override of an APPLIED color preset's value while it's being dragged
  // in its edit popup (presets panel / Library) — so the Fill row swatch tracks
  // the edit in real time, same as the presets-panel swatch.
  const livePreset = useAtomValue(livePresetTokenAtom);

  // ─── Fill-specific Create Variable submenu ─────────────────────────────
  // The Fill row holds a multi-tab editor (color / gradient / image / video).
  // A single "Create Variable" entry can't represent that — each tab edits a
  // *different* CSS property. So FillControl provides its own submenu with three
  // leaves (Color / Gradient / Image — video is excluded, it's not a CSS value); each INSTANT-creates a
  // variable on the matching property + opens the manage modal in edit mode.
  // Hide the default Create Variable on this row to avoid two competing entries.
  // Instant-create (the reference): make the variable NOW with an auto-name + bind it, then open the manage modal in
  // EDIT mode — the SAME flow every other control uses (NOT the old create FORM with a "Create Variable" button).
  const fillActiveFilePath = useAtomValue(activeFilePathAtom);
  const fillPageVariables = useAtomValue(pageVariablesAtom);
  const setFillVarModalRequest = useSetAtom(variableModalRequestAtom);
  const createFillVar = (property: string, label: string, value: string) => {
    if (!legacyCtl) return;
    instantCreateAndEditVariable({
      property, propertyLabel: label, value,
      activeFilePath: fillActiveFilePath, pageVariables: fillPageVariables,
      createVariable: legacyCtl.createVariable,
      setVariableModalRequest: setFillVarModalRequest,
    });
  };

  const fillVariableSubmenu: MenuItem[] = [
    {
      label: 'Color',
      show: true,
      onClick: () => createFillVar('backgroundColor', 'Color', styles.backgroundColor || '#ffffff'),
    },
    {
      label: 'Gradient',
      show: true,
      onClick: () => createFillVar('background', 'Gradient',
        (styles.background && /gradient/.test(styles.background)) ? styles.background : formatGradient(createDefaultGradient())),
    },
    {
      label: 'Image',
      show: true,
      onClick: () => createFillVar('backgroundImage', 'Image', styles.backgroundImage || ''),
    },
    // No "Video" leaf: video isn't a CSS-property value swap (color/image/gradient are) — it needs a real
    // <video> DOM element, so it can't be a style variable. A video FILL stays a per-node feature, not a var.
  ];

  const fillExtraMenuItems: MenuItem[] = [
    {
      label: 'Create Variable',
      show: !!(legacyCtl && legacyCtl.nodeId),
      hoverColor: fillHoverColor,
      onClick: () => { /* parent dropdown opens the submenu on hover */ },
      submenuItems: fillVariableSubmenu,
    },
  ];

  // Detached CMS Fill (design-tool parity): a `backgroundImage: url(${item.image})` /
  // `backgroundColor: item.brand` binding dragged OUT of its `.map()` is stashed as
  // `data-cms-orphan="__style.<cssProp>:field"`. Show the blue "Missing" pill (same
  // as a component-instance Missing prop) instead of an empty "Add" fill.
  const fillOrphan = legacyCtl?.node?.orphanBindings?.find(
    (o) => o.prop === '__style.backgroundImage' || o.prop === '__style.backgroundColor',
  );
  if (fillOrphan && legacyCtl?.node) {
    const orphanNodeId = legacyCtl.node.id;
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Fill" property="backgroundColor" />
        <CmsMissingPill
          field={fillOrphan.field}
          onClear={() => queueMutation({ type: 'clearCmsOrphan', nodeId: orphanNodeId, propName: fillOrphan.prop })}
        />
      </div>
    );
  }

  // CMS-bound: blue pill, takes priority over all other Fill bindings
  // (animation, variable, asset preset). Same pattern as ContentControl.
  // Look at backgroundColor first; getBindingForProperty already aliases
  // it to backgroundImage when the bound field is image-typed.
  if (legacyCtl?.cmsBinding?.getBindingForProperty('backgroundColor')) {
    // IMAGE-typed CMS binding (`backgroundImage: url(${item.field})`): surface the
    // same Size (object-fit) + Focal Point rows the variable-bound image fill shows
    // — backgroundSize/backgroundPosition are the node's OWN styles (not bound), so
    // the user can tune how every row's bound image sits in its frame (the reference
    // parity; ghost copies pick the styles up via the template style sync).
    const cmsFillIsImage = !!legacyCtl.node?.styleBindings?.some((b: { styleProp: string }) => b.styleProp === 'backgroundImage')
      || /url\(/.test(styles.backgroundImage || '');
    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Fill" property="backgroundColor" />
          <CmsBoundPill
            property="backgroundColor"
            fallbackValue={styles.backgroundColor || styles.backgroundImage || ''}
          />
        </div>
        {cmsFillIsImage && (
          <>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Size" property="backgroundSize" plain />
              <ToolSelect value={styles.backgroundSize || 'cover'} onChange={(v) => onChangeMultiple({ backgroundSize: v })} options={SIZE_OPTIONS} />
            </div>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Focal Point" property="backgroundPosition" plain />
              <ToolSelect value={styles.backgroundPosition || 'center'} onChange={(v) => onChangeMultiple({ backgroundPosition: v })} options={POSITION_OPTIONS} />
            </div>
          </>
        )}
      </div>
    );
  }

  // Bound check — animation/scroll first, variable pill second.
  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Fill" property="backgroundColor" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  // Variable-bound: Fill is a multi-property atom (color / gradient / image),
  // so the purple state has to come from ANY of those bindings — not just
  // the unified context's `hasVariable`, which only watches backgroundColor.
  //
  // Detection uses the legacy ControlProvider's `getValueSource` so the
  // result agrees with what `ControlLabel` sees (it uses the same helper).
  // The previous `node.styleVariables` walk caught only the post-resolve
  // marker case; if the parser left the value as `var:propName` (variable
  // declared but not in propDefaults yet, or a type-mismatch keeping the
  // resolve from running) the marker wasn't set and FillControl's pill
  // disappeared while ControlLabel still showed the two-line bound state —
  // exactly the inconsistency the user reported.
  const fillBoundEntry: { property: string; ref: string; current: string } | null = (() => {
    if (mode !== 'direct' || !legacyCtl) return null;
    for (const prop of ['backgroundColor', 'background', 'backgroundImage'] as const) {
      const src = legacyCtl.getValueSource(prop);
      if (src.source === 'prop' && src.ref) {
        return { property: prop, ref: src.ref, current: styles[prop] || '' };
      }
    }
    return null;
  })();
  if (fillLocaleOverrides.length > 0 && node?.id) {
    return (
      <div className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
        <ControlLabel label="Fill" property="backgroundColor" cell />
        <LocaleBoundPill
          property="backgroundColor"
          propertyLabel="Fill"
          nodeId={node.id}
          baseValue={styles.backgroundColor || ''}
          onChangeBase={(v) => onChangeMultiple({ backgroundColor: v })}
        />
      </div>
    );
  }
  if (fillBoundEntry && legacyCtl) {
    // When the bound variable is an IMAGE, surface object-fit (Size) + focal point
    // (Position) INLINE under the pill — they're independent node styles
    // (backgroundSize/backgroundPosition), so they're set PER-VARIANT through the
    // same write path as any other control (design-tool parity). A color/gradient
    // variable shows just the pill. (VIDEO fit/position live on the bgVideo child
    // via setVideoFill — a separate wiring — so they're not surfaced here yet.)
    const fillVarType = getPropType(activeCode, fillBoundEntry.ref);
    const showImageRows = fillVarType === 'image';
    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Fill" property={fillBoundEntry.property} />
          <LegacyVariableBoundPill
            property={fillBoundEntry.property}
            propertyLabel="Fill"
            variableRef={fillBoundEntry.ref}
            currentValue={fillBoundEntry.current}
            removeVariable={legacyCtl.removeVariable}
          />
        </div>
        {showImageRows && (
          <>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Size" property="backgroundSize" plain />
              <ToolSelect value={styles.backgroundSize || 'cover'} onChange={(v) => onChangeMultiple({ backgroundSize: v })} options={SIZE_OPTIONS} />
            </div>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Focal Point" property="backgroundPosition" plain />
              <ToolSelect value={styles.backgroundPosition || 'center'} onChange={(v) => onChangeMultiple({ backgroundPosition: v })} options={POSITION_OPTIONS} />
            </div>
          </>
        )}
      </div>
    );
  }
  // Fallback to the unified pill in case styleVariables hasn't been populated
  // yet but the unified context's binding detection has fired.
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Fill" property="backgroundColor" />
        <VariableBoundPill propertyLabel="Fill" />
      </div>
    );
  }

  // Bridge: onUpdate(key, value) → onChangeMultiple({ key: value })
  const onUpdate = (k: string, v: string) => {
    onChangeMultiple({ [k]: v });
  };

  // Detect fill type for preview swatch
  const bgColor = styles.backgroundColor || '';
  const bgImage = styles.backgroundImage || '';
  // Video lives on the node (bg-video child), not as a fake CSS prop anymore.
  const bgVideoUrl = node?.bgVideo?.src ?? '';
  const bgProp = styles.background || '';
  const hasGradient = bgProp.includes('gradient') || bgImage.includes('gradient');
  const hasImage = bgImage.includes('url(');
  const hasVideo = !!bgVideoUrl;
  const isMulti = isMultiLayerBackground(styles);

  // Preset reference detection — color/image/video share the blue-pill row UI.
  // Color/image presets are stored as `var(--name)` in their style property;
  // video presets are baked at apply-time so we match by URL against tokens.
  const colorVarMatch = bgColor.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  const imageVarMatch = bgImage.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  const colorPresetToken = colorVarMatch ? allTokens.find(t => t.name === colorVarMatch[1] && t.category === 'color') : undefined;
  const imagePresetToken = imageVarMatch ? allTokens.find(t => t.name === imageVarMatch[1] && t.category === 'image') : undefined;
  const videoPresetToken = bgVideoUrl ? allTokens.find(t => t.value === bgVideoUrl && t.category === 'video') : undefined;
  const presetKind: 'color' | 'image' | 'video' | null =
    imagePresetToken ? 'image' : videoPresetToken ? 'video' : colorPresetToken ? 'color' : null;
  const isPresetRef = presetKind !== null;

  // True when ANY fill is present — drives the empty alpha-checker placeholder
  // and gates the × clear button. A live color drag counts as a fill so the
  // row doesn't flash to the "Add" placeholder mid-drag.
  const hasAnyFill = livePreviewColor != null || isMulti || isPresetRef || hasGradient || hasImage || hasVideo || !!bgColor;

  // Click-handler for the × on the Fill row — wipes EVERY background-related
  // value (color, gradient, image, multi-layer extras, AND the bg-video
  // child) so the row collapses back to its empty / "Add" state regardless
  // of which fill type is currently in use.
  // NB: plain function, not useCallback. Sits AFTER the early-return branches
  // (bound / hasVariable above), so wrapping in a hook would violate the
  // hooks-rule when the bound branch returns early — fewer hooks than a
  // normal render → "Rendered fewer hooks than expected" crash.
  const handleClearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChangeMultiple({
      backgroundColor: '',
      background: '',
      backgroundImage: '',
      backgroundSize: '',
      backgroundPosition: '',
      backgroundRepeat: '',
      backgroundAttachment: '',
      backgroundBlendMode: '',
    });
    if (node?.id && node.bgVideo) {
      queueMutation({ type: 'removeVideoFill', nodeId: node.id });
    }
    trace.action('fill:clear-all', { nodeId: node?.id });
  };

  // Empty state defaults — alpha-checker swatch + "Add" label. Each branch
  // below overrides these when a fill is actually set; if none match the
  // row keeps the placeholder so the user can see at-a-glance there's no
  // background AND has a clear affordance to open the popup and pick one.
  let swatchStyle: React.CSSProperties = ALPHA_CHECKER_STYLE;
  let labelText = 'Add';

  if (livePreviewColor != null) {
    // Live color-picker drag — show the dragged solid color directly. Takes
    // priority over the committed-style branches so the swatch + hex track the
    // picker in real time (the Color tab clears any gradient/image first).
    swatchStyle = { backgroundColor: livePreviewColor };
    labelText = toHexDisplay(livePreviewColor);
  } else if (isMulti) {
    // Show composite background preview. Resolve design-token var()s to their
    // values — the swatch renders in the EDITOR frame where project tokens
    // aren't in scope, so an unresolved var() would blank the preview.
    swatchStyle = { backgroundImage: resolveCssTokens(bgImage, allTokens), backgroundSize: 'cover', backgroundPosition: 'center' };
    const layerCount = parseBackgroundLayers(styles).length;
    labelText = `${layerCount} Layers`;
  } else if (isPresetRef) {
    const token = imagePresetToken || videoPresetToken || colorPresetToken!;
    const prefix = presetKind === 'image' ? 'image-' : presetKind === 'video' ? 'video-' : 'color-';
    labelText = token.label || token.name.replace(new RegExp('^' + prefix), '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    if (presetKind === 'image') {
      const url = token.value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1] || '';
      swatchStyle = { backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' };
    } else if (presetKind === 'video') {
      // No good way to show a moving video in a tiny square — solid black with
      // the preset name in the label text reads cleanly.
      swatchStyle = { background: '#000' };
    } else {
      // Color preset — reflect an in-progress edit of THIS preset live.
      const liveColor = livePreset && colorPresetToken && livePreset.name === colorPresetToken.name
        ? livePreset.value : token.value;
      swatchStyle = { backgroundColor: liveColor };
    }
  } else if (hasGradient) {
    const gradientCSS = bgProp || bgImage;
    // Resolve design-token var()s (e.g. var(--color-green-mint)) to their hex
    // values: this swatch renders in the EDITOR frame, where the project tokens
    // aren't defined, so a token-coloured stop would otherwise make the whole
    // gradient invalid and the swatch blank.
    swatchStyle = { background: resolveCssTokens(gradientCSS, allTokens) };
    if (gradientCSS.startsWith('linear-gradient')) labelText = 'Linear';
    else if (gradientCSS.startsWith('radial-gradient')) labelText = 'Radial';
    else if (gradientCSS.startsWith('conic-gradient')) labelText = 'Conic';
    else labelText = 'Gradient';
  } else if (hasImage) {
    swatchStyle = { backgroundImage: bgImage, backgroundSize: 'cover' };
    labelText = 'Image';
  } else if (hasVideo) {
    // Raw bg-video URL with no matching preset.
    swatchStyle = { background: '#000' };
    labelText = 'Video';
  } else if (bgColor) {
    const displayColor = bgColor.startsWith('#') && bgColor.length === 4
      ? `#${bgColor[1]}${bgColor[1]}${bgColor[2]}${bgColor[2]}${bgColor[3]}${bgColor[3]}`
      : bgColor;
    swatchStyle = { backgroundColor: displayColor };
    // Label always shows the HEX equivalent — rgb / rgba / hsl / oklch /
    // named are all converted, matching every other color control.
    labelText = toHexDisplay(bgColor);
  }

  return (
    <>
      <div className="flex items-center justify-between w-full">
        <ControlLabel
          label="Fill"
          property="backgroundColor"
          hideCreateVariable
          extraMenuItems={fillExtraMenuItems}
        />
        <span ref={btnRef} className="contents">
        {isPresetRef ? (
          <button
            className="w-full h-8 flex items-center justify-between px-2 bg-[var(--accent)] rounded-[var(--radius-lg)] text-xs font-medium text-[var(--accent-fg)] cursor-pointer transition-colors hover:opacity-90 truncate"
            onClick={() => {
              openPanel(<FillPopupContent styles={styles} onUpdate={onUpdate} onChangeMultiple={onChangeMultiple} nodeId={node?.id} onLivePreview={setLivePreviewColor} />);
            }}
          >
            <span className="flex items-center gap-2 truncate">
              <ColorSwatch style={swatchStyle} />
              <span className="truncate">{labelText}</span>
            </span>
            <span onClick={handleClearAll}
              className="text-white/70 hover:text-white text-sm ml-1">×</span>
          </button>
        ) : (
          <ControlActionRow
            onClick={() => {
              openPanel(<FillPopupContent styles={styles} onUpdate={onUpdate} onChangeMultiple={onChangeMultiple} nodeId={node?.id} onLivePreview={setLivePreviewColor} />);
            }}
            className="justify-between"
          >
            <span className="flex items-center gap-2 truncate">
              <ColorSwatch style={swatchStyle} />
              <span className={`text-xs truncate ${hasAnyFill ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{labelText}</span>
            </span>
            {hasAnyFill && (
              <span
                onClick={handleClearAll}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm leading-none cursor-pointer shrink-0 px-1"
              >
                &times;
              </span>
            )}
          </ControlActionRow>
        )}
        </span>
      </div>
      {panelPopup(btnRef)}

      {/* Create-Variable modal for the chosen Fill submenu type. The modal
          embeds the right atom in `variableDefault` mode via the registry —
          backgroundColor → ColorPicker, background → GradientEditor,
          backgroundImage → ImageSearchModal — and on Create routes to
          legacy createVariable() with the chosen property. */}
    </>
  );
}

// (Local `PresetEditPanelInline` was extracted to
// `ui/ColorPresetEditPanel.tsx` — it lived here as a near-duplicate of the
// version in ColorInput.tsx. Both consumers now import the shared one so
// the Edit-preset hover button looks and behaves the same in every place.)

// ─── Exported ToolAtom ──────────────────────────────────────────────────────

export function FillControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="backgroundColor" defaultValue="" mode={mode} {...mp}>
      <FillAtom />
    </UnifiedControlProvider>
  );
}
