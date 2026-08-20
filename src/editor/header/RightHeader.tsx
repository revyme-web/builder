// RightHeader.tsx — Top-right header bar above the properties panel.
// Exact port from old builder: 52px height, 260px width.
// Contains: Settings, Export, Preview (play icon), Live buttons.
//
// The Live button does NOT publish on click — it opens `LiveDropdown`
// (port of `../../builder/src/builder/view/header/RightHeader.tsx` ~lines
// 759–910) which shows the live URL, last-published timestamp, and a
// primary button that reads "Publish" on first publish or "Update live
// site" once already published. Clicking that button kicks off the
// actual deploy + drives a fake-monotonic progress bar inside the
// dropdown so the 25 s deploy doesn't feel dead.

import { useCallback, useEffect, useState } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { exportDropdownOpenAtom } from '@/code/stores/editor-store';
import { PlayIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import Button from '@/design-system/Button';
import { settingsOverlayOpenAtom, settingsSectionAtom, websiteMetaAtom } from '@/code/stores/website-settings-store';
import { isComponentFileAtom } from '@/code/stores/store';
import { LiveDropdown } from './LiveDropdown';
import { ExportDropdown, type ExportFormat } from './ExportDropdown';
import { exportProject } from './export-project';
import { useIsClosedSource } from '@/code/stores/closed-source-store';
import { parseWebsiteMeta } from './publish-utils';
import { useSigmoidProgress } from '@/editor/hooks/useSigmoidProgress';
import type { WebsiteMeta } from '@/backend/types';
import { useIsViewer } from '@/code/stores/viewer-mode-store';

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  previewMode: boolean;
  onTogglePreview: () => void;
}

export default function RightHeader({ previewMode, onTogglePreview }: Props) {
  trace.fn('RightHeader:render', { previewMode });
  // Viewers can preview but not Settings / Export / Publish — those
  // either change the site or trigger a deploy.
  const isViewer = useIsViewer();
  // Closed-source template remix — exporting would hand over the source the
  // template's creator chose to hide, so Export is disabled with a tooltip.
  const isClosedSource = useIsClosedSource();
  const [exportTipOpen, setExportTipOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(false);
  const [meta, setMeta] = useState<WebsiteMeta | null>(null);
  const [open, setOpen] = useState(false);
  // ─── Fake progress ticker ────────────────────────────────────────────
  // 0 → 0.95 over ~25 s on a sigmoid curve so the bar moves fast at the
  // start and decelerates as it approaches the asymptote — "looks like
  // it's working hard." Real success snaps it to 1.0; real failure snaps
  // it to 0. We don't model deploy progress because vinext doesn't expose
  // any. Shared RAF harness — see useSigmoidProgress.
  const { progress, setProgress, startProgress, stopProgress } = useSigmoidProgress();

  const setSettingsOpen = useSetAtom(settingsOverlayOpenAtom);
  const setWebsiteMeta = useSetAtom(websiteMetaAtom);
  // When the settings takeover (z-10000) is open we bump our own z to
  // 10001 so the right header keeps floating above it — gives the user
  // Publish / Preview / Settings (close) access without leaving the
  // settings page. LeftHeader stays at 9999 and is intentionally hidden
  // by the overlay (the back arrow replaces its menu / logo affordance).
  const settingsOpen = useAtomValue(settingsOverlayOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  // Component-master files swap the editor's accent color from blue
  // (`--accent`) to purple (`--accent-secondary`). Mirror that on the
  // header's primary buttons (Play when active, Live) so the user has a
  // consistent visual signal that they're editing a component, not a
  // page. Inline `style.backgroundColor` overrides the variant class's
  // `bg-[var(--accent)]` (specificity: inline > class).
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const primaryBg = isComponentFile ? { backgroundColor: 'var(--accent-secondary)' } : undefined;

  // ─── Meta fetch ──────────────────────────────────────────────────────
  // Pulls publish state on mount + after every successful publish so the
  // dropdown stays in sync with the backend (subdomain, published_at,
  // custom_domain, etc.). Fire-and-forget — failures just leave `meta`
  // null and the dropdown shows "Not published yet".
  const fetchMeta = useCallback(async () => {
    if (!CLOUD_ENABLED) return;
    try {
      const id = (await import('@/backend/project-id')).getProjectId();
      const res = await fetch(`/api/websites/${id}`);
      if (!res.ok) return;
      const w = await res.json();
      const parsed = parseWebsiteMeta(w);
      setMeta(parsed);
      // Mirror into the shared atom so non-header chrome (the bottom
      // toolbar's Upgrade button) can react to the site's plan.
      setWebsiteMeta(parsed);
    } catch (err) {
      trace.error('header:meta-fetch', err);
    }
  }, []);

  useEffect(() => {
    fetchMeta();
  }, [fetchMeta]);

  // Re-pull meta when the Domain settings tab adds/removes a custom
  // subdomain or domain — the publish dropdown's live URL derives from
  // custom_domain → custom_subdomain → subdomain, so it must re-sync.
  useEffect(() => {
    const onChange = () => fetchMeta();
    window.addEventListener('website-meta-changed', onChange);
    return () => window.removeEventListener('website-meta-changed', onChange);
  }, [fetchMeta]);

  // ─── Export ──────────────────────────────────────────────────────────
  // Click "Export" → opens ExportDropdown (mirrors LiveDropdown's
  // pattern). The dropdown lists format options (Source / Tailwind /
  // …) and a primary "Export project" button. Format selection is
  // persisted across opens; the button flips to "Upgrade to export
  // in X" when the selected format requires a higher plan tier.
  const [exporting, setExporting] = useState(false);
  // Atom, not local state — File ▸ Export code… in the left-header menu opens
  // this same dropdown, so the user picks a format in one place instead of
  // the menu duplicating the picker or exporting a format it guessed.
  const [exportOpen, setExportOpen] = useAtom(exportDropdownOpenAtom);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('source');
  const setSettingsOpenAtom = useSetAtom(settingsOverlayOpenAtom);
  const setSettingsSectionAtom = useSetAtom(settingsSectionAtom);

  // The fetch → blob → download sequence lives in `export-project.ts` so
  // the cmd+K "Export Code" row runs the same path rather than a second
  // copy. Only the spinner and dropdown state are the component's job.
  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (await exportProject(exportFormat)) setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }, [exporting, exportFormat]);

  // Open Settings → Plans tab when the user clicks the upgrade
  // affordance inside the export dropdown.
  const handleExportUpgrade = useCallback(() => {
    trace.action('header:export-upgrade-click', { format: exportFormat });
    setExportOpen(false);
    setSettingsSectionAtom('plans');
    setSettingsOpenAtom(true);
  }, [exportFormat, setSettingsSectionAtom, setSettingsOpenAtom]);

  const handleExportToggle = useCallback(() => {
    if (!CLOUD_ENABLED) return;
    setExportOpen((v) => !v);
    trace.action('header:export-toggle');
  }, []);

  // ─── Publish ─────────────────────────────────────────────────────────
  const handlePublish = useCallback(async () => {
    if (!CLOUD_ENABLED || publishing) return;
    const id = (await import('@/backend/project-id')).getProjectId();
    setPublishing(true);
    setPublishSuccess(false);
    startProgress();
    trace.action('header:publish-start', { id });
    try {
      // Publish builds from the STORED DB row — flush any queued mutations
      // and the debounced autosave first, or a publish clicked within ~2s of
      // an edit deploys the previous save (the "added a frame, published,
      // live site doesn't have it" report).
      const { flushNow } = await import('@/code/mutation/mutation-queue');
      flushNow();
      const { flushSaveNow } = await import('@/backend/autosave');
      await flushSaveNow();
      const res = await fetch(`/api/websites/${id}/publish`, { method: 'POST' });
      const json = await res.json();
      if (json.success && json.url) {
        trace.action('header:publish-success', { url: json.url });
        setProgress(1);
        setPublishSuccess(true);
        await fetchMeta();
        setTimeout(() => setPublishSuccess(false), 2000);
      } else {
        trace.error('header:publish-failed', json);
        setProgress(0);
        alert(json.error || json.details || 'Publish failed');
      }
    } catch (err) {
      trace.error('header:publish-error', err);
      setProgress(0);
      alert('Publish failed — check console');
    } finally {
      stopProgress();
      setPublishing(false);
    }
  }, [publishing, startProgress, stopProgress, fetchMeta]);

  // Toggle dropdown — clicks on the Live button itself open/close it.
  // The dropdown's outside-click handler skips clicks on
  // `[data-live-trigger]` so this toggle wins cleanly.
  const handleLiveClick = useCallback(() => {
    if (!CLOUD_ENABLED) return;
    setOpen((prev) => !prev);
    trace.action('header:live-toggle');
  }, []);

  return (
    <div
      className={`h-[52px] fixed top-0 right-0 flex items-center px-2 ${
        settingsOpen ? 'z-[10001]' : 'z-[9999]'
      }`}
      // Sits on the right ChromeIsland (12px margins) — the island backdrop
      // carries surface/glass/outer border and the cut corners.
      style={{ width: 260, top: 0, right: 0, isolation: "isolate" }}
    >
      {/* Settings / Export / Live each `flex-1` so the row fills the
          260 px header width with tight 3 px gaps; Play stays compact at
          its intrinsic icon-only width (no flex-1) per the spec. */}
      <div className="flex flex-1 items-center gap-[3px]">
        {/* Settings / Play are mutually-exclusive takeover modes — clicking
            either while it's already active closes it, and clicking one
            while the OTHER is active swaps modes (so Play from Settings
            jumps straight into preview). */}
        <Button
          variant={settingsOpen ? 'primary' : 'secondary'}
          size="sm"
          tabIndex={-1}
          className="flex-1 cut-corners"
          data-tutorial="header-settings-button"
          disabled={isViewer}
          onClick={() => {
            trace.action('header:settings-toggle', { wasOpen: settingsOpen, previewMode });
            // Swap out of preview before opening settings so the two
            // takeover modes never stack on top of each other.
            if (!settingsOpen && previewMode) onTogglePreview();
            setSettingsOpen(!settingsOpen);
          }}
          style={settingsOpen ? primaryBg : undefined}
        >
          Settings
        </Button>
        <div
          className="relative flex-1"
          // A disabled button swallows pointer events, so the closed-source
          // tooltip hangs off this wrapper instead.
          onMouseEnter={isClosedSource ? () => setExportTipOpen(true) : undefined}
          onMouseLeave={isClosedSource ? () => setExportTipOpen(false) : undefined}
        >
          <Button
            variant={exportOpen ? 'primary' : 'secondary'}
            size="sm"
            tabIndex={-1}
            className="w-full cut-corners"
            onClick={handleExportToggle}
            disabled={!CLOUD_ENABLED || isViewer || isClosedSource}
            // `data-export-trigger` lets ExportDropdown's outside-click
            // listener ignore clicks on us so this toggle isn't fought
            // by a "close because outside" race.
            data-export-trigger=""
            data-tutorial="header-export-button"
            style={exportOpen ? primaryBg : undefined}
          >
            Export
          </Button>
          {isClosedSource && exportTipOpen && (
            <div className="absolute left-1/2 top-full z-[10000] mt-2 w-56 -translate-x-1/2 cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--bg-surface)] px-3 py-2 text-center text-[11px] leading-relaxed text-[var(--text-secondary)] shadow-xl pointer-events-none">
              Export is unavailable — this template's creator made its code closed source.
            </div>
          )}
          <ExportDropdown
            open={exportOpen}
            meta={meta}
            format={exportFormat}
            onFormatChange={setExportFormat}
            exporting={exporting}
            onExport={handleExport}
            onUpgrade={handleExportUpgrade}
            onClose={() => setExportOpen(false)}
          />
        </div>
        <Button
          variant={previewMode ? 'primary' : 'secondary'}
          size="sm"
          tabIndex={-1}
          icon={<PlayIcon size={14} />}
          className="cut-corners"
          data-tutorial="header-preview-button"
          onClick={() => {
            // Closing settings first prevents the takeover from sitting
            // under the preview iframe on the next frame.
            if (settingsOpen) setSettingsOpen(false);
            onTogglePreview();
          }}
          // Only override when actually in primary state (preview active).
          // Secondary state has no `--accent` background, so the override
          // would force purple onto the unpressed Play button.
          style={previewMode ? primaryBg : undefined}
        />
        <div className="relative flex-1">
          <Button
            variant="primary"
            size="sm"
            tabIndex={-1}
            // While publishing with the dropdown closed, the button itself
            // becomes the progress bar: an accent-fg-tinted fill grows from
            // left to right based on `progress` (0-1), and the label flips
            // from "Publish" to "42%" so the user still sees what's happening
            // without needing to open the dropdown. With the dropdown open
            // the dropdown's own UI handles the feedback, so the button
            // stays plain.
            onClick={handleLiveClick}
            disabled={isViewer}
            className="w-full relative overflow-hidden cut-corners"
            style={primaryBg}
            // Tag for the dropdown's outside-click filter.
            data-live-trigger
            data-tutorial="header-publish-button"
          >
            {publishing && !open && (
              <span
                // accent-fg, not white. accent-fg is by definition the ink that
                // contrasts with whatever `--accent` is, so the fill darkens a
                // light accent and lightens a dark one. Flat white only read
                // while the accent was dark — on the light accent this was
                // beige-on-beige (2026-08-01). Mirrors LiveDropdown's bar.
                className="absolute inset-y-0 left-0 transition-[width] duration-150 ease-out pointer-events-none"
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  backgroundColor: 'color-mix(in srgb, var(--accent-fg) 24%, transparent)',
                }}
              />
            )}
            <span className="relative tabular-nums">
              {publishing && !open ? `${Math.round(progress * 100)}%` : 'Publish'}
            </span>
          </Button>
          <LiveDropdown
            open={open}
            meta={meta}
            publishing={publishing}
            publishSuccess={publishSuccess}
            progress={progress}
            onPublish={handlePublish}
            onClose={() => setOpen(false)}
            onOpenBackups={() => {
              trace.action('header:open-backups-from-dropdown');
              setSettingsSection('backups');
              setSettingsOpen(true);
            }}
            onAddDomain={() => {
              trace.action('header:add-domain-from-dropdown');
              setSettingsSection('domain');
              setSettingsOpen(true);
            }}
            onOpenStaging={() => {
              trace.action('header:open-staging-from-dropdown');
              setSettingsSection('staging');
              setSettingsOpen(true);
            }}
          />
        </div>
      </div>
    </div>
  );
}
