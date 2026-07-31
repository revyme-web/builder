// ToolbarGhost.tsx — Ghost overlay that follows cursor during toolbar drag.
// Always rendered via portal to document.body (escapes canvas transform + overflow:hidden).
// Uses useSyncExternalStore (not Jotai) to avoid Provider store mismatch.
// Matches the toolbar card visual: icon + label in a rounded card.
//
// Icon resolution: prefer the InsertItem record from element-data.ts (single
// source of truth — same data the secondary-panel cards render from). That
// gives us automatic parity for every new card and removes the previous
// hand-curated `ITEM_ICON_MAP` that only knew ~30 of the ~150 item ids.

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { toolbarGhostOps } from '@/canvas/drag/strategies/toolbar-ghost-atom';
import { ELEMENT_ICON_MAP } from '@/shared/insert-items/element-icons';
import { getInsertItem } from '@/shared/insert-items/insert-item-lookup';
import { isPreviewIcon } from '@/shared/insert-items/icon-style-utils';
import { SocialIcon } from 'react-social-icons/component';
import { trace } from '@/shared/debug-trace';

export default function ToolbarGhost() {
  const ghost = useSyncExternalStore(
    toolbarGhostOps.subscribe,
    toolbarGhostOps.get,
  );
  if (!ghost) return null;

  trace.fn('ToolbarGhost.render', { itemId: ghost.item.id, vpId: ghost.vpId });

  const { item, screenPos } = ghost;
  // CDN-linked components (`cdn:<Slug>` ids from the Library panel's
  // Linked rows) render the same compact icon+name tag as local
  // components — same drag affordance, same visual language.
  const isComponent = item.id.startsWith('component:') || item.id.startsWith('cdn:');
  // Iconify drags ship as `icon-<prefix>:<name>-<nodeId>` from IconPanel.
  // Detect them so the ghost can render the actual icon (SVG markup if
  // the prefetch landed, otherwise the iconify image endpoint) instead
  // of the generic "Element type is invalid" placeholder.
  const isIcon = item.id.startsWith('icon-');
  // Media-panel drags ship as `media-image:<url>` / `media-video:<url>`.
  // Each carries the user's uploaded src + a `ghostSize` matched to the
  // gallery tile (live `getBoundingClientRect()` capture in
  // `MediaGalleryPanel.useMediaDrag`). Without this branch they fall
  // through to the generic fallback below and render as a 32 px grey
  // square instead of the actual image at the tile's size.
  const isMediaImage = item.id.startsWith('media-image:');
  const isMediaVideo = item.id.startsWith('media-video:');
  // Look up the full InsertItem (icon + brand metadata) — same record the
  // secondary-panel card rendered from. Falls back to null for non-Insert
  // drags (CMS, code components, components).
  const insertItem = getInsertItem(item.id);
  const iconKey = insertItem?.iconKey;
  const IconComponent = iconKey ? ELEMENT_ICON_MAP[iconKey] : null;
  const socialNetwork = insertItem?.socialNetwork;
  const displayName = isComponent
    ? item.elementType
    : isIcon
      ? (item.defaultAttrs?.alt || 'Icon')
      : insertItem?.name
        ?? (item.id.charAt(0).toUpperCase() + item.id.slice(1));

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: screenPos.x,
        top: screenPos.y,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 99999,
        opacity: 0.85,
      }}
    >
      {isMediaImage || isMediaVideo ? (
        /* Media gallery preview ghost — renders the actual uploaded
           image / video at the gallery tile's live size (captured at
           pointerdown via `getBoundingClientRect()` and stashed on
           `item.ghostSize`). The drop shadow + `pointer-events: none`
           wrapper match the rest of the ghost variants so the cursor
           still drives the strategy underneath. */
        <div
          style={{
            width: item.ghostSize.width,
            height: item.ghostSize.height,
            borderRadius: 6,
            overflow: 'hidden',
            filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))',
          }}
        >
          {isMediaImage ? (
            <img
              src={item.defaultAttrs?.src}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              draggable={false}
            />
          ) : (
            <video
              src={item.defaultAttrs?.src}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              muted
            />
          )}
        </div>
      ) : isIcon ? (
        /* Compact icon-only ghost: 48px square showing the actual SVG.
           Inline `<svg>` reconstructed from the toolbar item's
           `textContent` (the prefetched inner SVG markup) when present;
           falls back to the iconify image endpoint when the user dragged
           before the prefetch resolved. No card chrome — the icon IS the
           preview, matching how the reference/Figma render icon drags. */
        item.elementType === 'svg' && item.textContent ? (
          <svg
            width="48"
            height="48"
            viewBox={item.defaultAttrs?.viewBox || '0 0 24 24'}
            xmlns="http://www.w3.org/2000/svg"
            style={{ color: 'var(--text-primary, #fff)', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))' }}
            // The inner SVG markup was sanitized at fetch time
            // (camelCased + currentColor normalized) so it's safe to
            // inject here for the ghost preview.
            dangerouslySetInnerHTML={{ __html: item.textContent }}
          />
        ) : (
          <img
            src={item.defaultAttrs?.src}
            alt={displayName}
            width={48}
            height={48}
            style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))' }}
          />
        )
      ) : iconKey && isPreviewIcon(iconKey) && IconComponent ? (
        /* Naked preview ghost — same EXACT pixel size the user sees in
           the secondary panel. Math (do NOT change without recalculating):
             - SECONDARY_WIDTH         = 270 px
             - panel content padding   = p-4 (16 × 2)        →  238 px
             - grid gap                = gap-1.5 (6 px)
             - 2-col card width        = (238 − 6) / 2       →  116 px
             - card padding            = p-4 (16 × 2)        →   84 px inner
             - preview slot height     = h-14                →   56 px
           → animated preview renders at 84 × 56 in the panel. The ghost
           uses the same dimensions so the drag feels like the tile
           itself lifting off, not a resized clone. NO chrome, NO label,
           NO background — just the animation + a drop-shadow. */
        <div
          style={{
            width: 84,
            height: 56,
            overflow: 'hidden',
            filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.35))',
          }}
        >
          <IconComponent />
        </div>
      ) : isComponent ? (
        /* Compact component tag — icon + name */
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderRadius: 6,
          backgroundColor: 'rgba(30, 30, 30, 0.9)',
          border: '1px solid rgba(167, 139, 250, 0.5)',
          backdropFilter: 'blur(8px)',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" style={{ color: '#a78bfa', flexShrink: 0 }}>
            <path fill="currentColor" d="M12.53 2.47a.75.75 0 0 0-1.06 0L8.32 5.62a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm5.85 6.3a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm-5.85 5.4a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zM6.68 8.32a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06z" />
          </svg>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', fontWeight: 500, fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap' }}>
            {displayName}
          </span>
        </div>
      ) : (
        /* Icon-only ghost — same priority as the secondary-panel card:
             1. socialNetwork → react-social-icons (brand-correct).
             2. ELEMENT_ICON_MAP[iconKey] → bundled SVG component.
             3. Empty fallback (item not in CATEGORIES). No card chrome,
             no label — the reference/Figma-style "the icon IS the preview". */
        <div style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))' }}>
          {socialNetwork ? (
            <SocialIcon
              network={socialNetwork}
              style={{ width: 56, height: 56 }}
              // Render as a div — the default <a> wrapper would try to
              // navigate on click. The drag overlay never receives clicks
              // (pointer-events: none on the wrapper) but stripping the
              // anchor also strips link-related ARIA the user doesn't need.
              as="div"
            />
          ) : IconComponent ? (
            <IconComponent />
          ) : (
            <div style={{ width: 32, height: 32, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)' }} />
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
