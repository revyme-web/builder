// LeftHeader.tsx — Top-left header bar above the left panel.
// 52 px height, spans menu + panel width (308 px). Two slots:
//   1. Revyme logo (left) — opens an account/menubar dropdown
//   2. Project name chip (right) — shows the website title, opens
//      a project-scoped menu (rename, site settings, dashboard)
//
// The File / Edit / Insert / View menubar that used to live in the
// right slot was folded into the logo dropdown as right-opening
// submenus (under "Go to Dashboard" / "Your Account"), freeing the
// 256 px slot for the project name. The original menubar's `MenuTabs`
// component is gone; its menu definitions live in `menu-builders.tsx`
// and are consumed verbatim by the logo dropdown.

import { useRef, useState, useMemo } from 'react';
import { useAtom } from 'jotai';
import { flushNow } from '@/code/mutation/mutation-queue';
import { previewModeAtom } from '@/code/stores/editor-store';
import {
  directSelectionEnabledAtom,
  autoPanSpeedAtom,
  autoFocusLayersAtom,
  showRulersAtom,
  useSmoothZoomAtom,
  showPixelGridAtom,
} from '@/code/stores/user-preferences-store';
import { trace } from '@/shared/debug-trace';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { buildTabs, buildPreferencesSubmenu } from './menu-builders';
import ProjectChip from './ProjectChip';
import KeyboardShortcutsModal from '@/editor/ui/KeyboardShortcutsModal';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import Button from '@/design-system/Button';
import { useIsViewer } from '@/code/stores/viewer-mode-store';

// ─── Back chevron — same glyph the settings overlay uses for its
// "Back to canvas" affordance. Inline so we don't pull a third-
// party icon for one button.

function BackChevronIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// ─── Revyme Logo (inline SVG, switches with dark/light mode) ─────────────

function RevymeLogo() {
  // Fill tracks `--text-primary` via `currentColor` — a dark glyph in
  // light mode, light glyph in dark mode. A pure-CSS invert that follows
  // the theme automatically. (The previous version read the `dark` class
  // off `documentElement` once at render time; that value never updated
  // on a theme toggle, so the white logo stayed white and disappeared on
  // the light header.)
  //
  // Sized to match the menu chip height (30px) — small enough to read as
  // an app icon, big enough to be a real click target. The narrow vector
  // makes it look "tall and thin" at any size; width 14 keeps the visual
  // weight balanced with the project-name chip next to it.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 779.79 1578.33"
      width={14}
      height={22}
      style={{ color: 'var(--text-primary)' }}
    >
      <polygon fill="currentColor" points="0 0 0 464.88 779.79 922.26 779.79 461.13 0 0" />
      <polygon fill="currentColor" points="779.79 1357.14 0 899.76 0 1357.14 408.64 1578.33 779.79 1357.14" />
      <polygon fill="currentColor" points="402.21 700.79 402.21 1135.67 779.79 922.26 402.21 700.79" />
    </svg>
  );
}

// ─── Logo button — account-level actions + the entire File/Edit/Insert/View
// menubar as right-opening submenus. Used to be a 2-item menu (Dashboard,
// Account) plus a separate `MenuTabs` chip strip; the strip was folded into
// this dropdown to free the panel-width slot for the project name. Order
// follows the user-confirmed structure: account actions on top, divider,
// File / Edit / Insert / View below.

export function LogoButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // Viewers keep "Go to Dashboard" + "Your Account" (account-level,
  // harmless) but every menubar tab (File / Edit / Insert / View) is
  // disabled — they all open write paths.
  const isViewer = useIsViewer();

  // Preference atoms — `buildPreferencesSubmenu` needs them so the toggle
  // rows can render their current state + flip atoms on click. Subscribing
  // here means the submenu re-renders correctly when the user flips a
  // preference (Edit → Preferences → toggle). The atoms are
  // `atomWithStorage`-backed; the new value persists across reloads.
  const [directSelectionEnabled, setDirectSelectionEnabled] = useAtom(directSelectionEnabledAtom);
  const [autoPanSpeed, setAutoPanSpeed] = useAtom(autoPanSpeedAtom);
  const [autoFocusLayers, setAutoFocusLayers] = useAtom(autoFocusLayersAtom);
  const [showRulers, setShowRulers] = useAtom(showRulersAtom);
  const [useSmoothZoom, setUseSmoothZoom] = useAtom(useSmoothZoomAtom);
  const [showPixelGrid, setShowPixelGrid] = useAtom(showPixelGridAtom);

  const items: DropdownMenuEntry[] = useMemo(() => {
    const preferencesSubmenu = buildPreferencesSubmenu(
      { directSelectionEnabled, autoPanSpeed, autoFocusLayers, showRulers, useSmoothZoom, showPixelGrid },
      { setDirectSelectionEnabled, setAutoPanSpeed, setAutoFocusLayers, setShowRulers, setUseSmoothZoom, setShowPixelGrid },
    );
    const tabs = buildTabs(preferencesSubmenu);
    // Each tab becomes a single dropdown entry with `submenuItems` —
    // DropdownMenu's submenu machinery (used elsewhere by Site Settings,
    // Plugins, Preferences) flips open on hover. Same flush-before-hard-
    // nav dance the old account entries used: any pending mutation queue
    // must commit to local/cloud before the route swap, otherwise the
    // autosave races the navigation and drops the most recent edit.
    return [
      {
        id: 'logo-dashboard',
        label: 'Go to Dashboard',
        onClick: () => {
          flushNow();
          trace.action('left-header:logo-dashboard');
          // Hard nav: `/dashboard` is owned by revyme-cloud (different
          // app), reached via the dispatcher. React Router with
          // basename="/builder" can't route there.
          window.location.href = '/dashboard';
        },
      },
      {
        id: 'logo-account',
        label: 'Your Account',
        onClick: async () => {
          flushNow();
          trace.action('left-header:logo-account');
          // Route to the workspace-scoped account settings in the cloud
          // dashboard: `/dashboard?ws=<workspaceId>&view=settings:account`.
          // `/dashboard` is owned by revyme-cloud, reached via the
          // dispatcher (same hard-nav as "Go to Dashboard" above).
          //
          // workspaceId is fetched per-click. Local mode (or any fetch
          // error) → null → the `ws` param is omitted and the cloud app
          // lands on the user's default workspace. flushNow() already
          // committed pending mutations above, so the await here can't
          // race autosave.
          const projectId = getProjectId();
          let workspaceId: string | null = null;
          if (projectId !== 'local') {
            workspaceId = await backend.getWebsiteWorkspaceId(projectId).catch(() => null);
          }
          const params = new URLSearchParams();
          if (workspaceId) params.set('ws', workspaceId);
          params.set('view', 'settings:account');
          window.location.href = `/dashboard?${params.toString()}`;
        },
      },
      { type: 'separator' },
      // The menubar — flattened into 4 submenu entries. Each `tab.items`
      // is a `DropdownMenuEntry[]` straight from menu-builders.tsx; no
      // shape adaptation needed. The hover-to-open behaviour comes for
      // free from DropdownMenu's submenu support.
      ...tabs.map((tab) => ({
        id: `logo-${tab.id}`,
        label: tab.label,
        // Viewer: disable the tab entirely. DropdownMenu blocks the
        // click AND the hover-to-open for disabled entries, so the
        // File/Edit/Insert/View submenus never fly out.
        disabled: isViewer,
        submenuItems: tab.items,
        onClick: () => {}, // parent items with submenus need a no-op
      })),
    ];
  }, [
    isViewer,
    directSelectionEnabled, autoPanSpeed, autoFocusLayers, showRulers, useSmoothZoom, showPixelGrid,
    setDirectSelectionEnabled, setAutoPanSpeed, setAutoFocusLayers, setShowRulers, setUseSmoothZoom, setShowPixelGrid,
  ]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-none bg-transparent hover:bg-white/[0.10] transition-colors"
      >
        <RevymeLogo />
      </button>
      <DropdownMenu
        isOpen={open}
        onClose={() => setOpen(false)}
        items={items}
        anchorRef={ref}
        position="bottom-left"
        minWidth={200}
        hoverStyle="accent"
        searchable
      />
    </>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function LeftHeader() {
  const [previewMode, setPreviewMode] = useAtom(previewModeAtom);
  trace.fn('LeftHeader:render', { previewMode });

  return (
    <div
      className="h-[52px] bg-[var(--bg-surface)] border-b border-r border-[var(--border-light)] fixed top-0 left-0 z-[9999] flex"
      style={{ width: 'calc(52px + 256px)' }}
    >
      {/* Logo column — 51 px wide so the rule at its right edge lands
          at x=51 (1 px left of the LeftMenu's internal rule at x=52).
          Logo button is 32×32 (matches the VIBE / + buttons in
          LeftMenu) and centered inside. */}
      <div className="w-[51px] h-full flex items-center justify-center flex-shrink-0">
        <LogoButton />
      </div>

      {/* Vertical rule at x=51 — visually adjacent to LeftMenu's own
          rule below the header. `paddingTop/Bottom` create breathing
          room so it doesn't touch the header's `border-b` or top edge.
          Wrapper carries the padding; the inner div is the actual rule
          (full-height inside the wrapper). */}
      <div
        aria-hidden
        style={{
          width: 1,
          paddingTop: 15,
          paddingBottom: 15,
          flexShrink: 0,
          alignSelf: 'stretch',
        }}
      >
        <div style={{ width: 1, height: '100%', backgroundColor: 'var(--border-light)' }} />
      </div>

      {/* In preview mode we swap the project chip for a single "Back"
          affordance — matches the settings-overlay top-left back
          button. Reads as "you're in preview, here's the way out"
          without the project chip competing for attention. */}
      <div className="flex-1 min-w-0 flex items-center" style={{ paddingLeft: 10, paddingRight: 10 }}>
        {previewMode ? (
          <Button
            variant="secondary"
            size="sm"
            tabIndex={-1}
            icon={<BackChevronIcon />}
            onClick={() => {
              trace.action('left-header:exit-preview');
              setPreviewMode(false);
            }}
            title="Exit preview"
          >
            Back
          </Button>
        ) : (
          <ProjectChip />
        )}
      </div>

      {/* Keyboard Shortcuts overview — opened via the logo menu's
          View → "Keyboard shortcuts" item (shortcutsModalOpenAtom).
          Portal-rendered, so its placement here is just ownership. */}
      <KeyboardShortcutsModal />
    </div>
  );
}
