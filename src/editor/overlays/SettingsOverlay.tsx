// SettingsOverlay.tsx — Full-screen settings takeover.
//
// Replaces the entire editor surface with a standard settings UI: a top
// bar with a back arrow (returns to the canvas), a left section nav, and a
// scrollable content area. No backdrop click-out — only the back arrow / Esc
// close the overlay. Cloud sections (Domain, Plans, Analytics, Submit) are
// registered via plugin-registry.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAtom } from 'jotai';
import { SettingsWebsiteIcon, PageHomeIcon, PageDocumentIcon } from '@/shared/icons';
import Button from '@/design-system/Button';
import { LogoButton } from '@/editor/header/LeftHeader';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { projectFS } from '@/code/project/project-fs';
import { getSettingsCategories, type SettingsSectionDef } from '@/plugins/plugin-registry';
import {
  websiteSettingsAtom,
  settingsOverlayOpenAtom,
  settingsSectionAtom,
  selectedAbTestPageAtom,
  selectedSeoPageAtom,
  loadSettingsFromLayout,
} from '@/code/stores/website-settings-store';
import { pageFilePathToSlug, pageSlugToFilePath } from '@/code/project/page-slug-utils';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getProjectId } from '@/backend/project-id';
import { trace } from '@/shared/debug-trace';
import {
  SettingsGroup,
  SettingsRow,
  ROW_INPUT_CLS,
  SaveButton,
  RowButton,
  RowSelect,
  LANGUAGE_OPTIONS,
  ConfirmModal,
  Toggle,
} from './settings-shared';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { setWebsiteWatermark } from '@/backend/revyme-backend';

// ─── Inline SVG icons ──────────────────────────────────────────────────────

const BackIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const UploadIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const Trash2Icon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const MoreVerticalIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
  </svg>
);

const ChevronDownIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal slice of an A/B test row the sidebar needs — `id` + `name`
 *  for the row ellipsis's Rename / Delete actions. Mirrors the backend
 *  shape but typed locally so the overlay doesn't pull a dep on the
 *  cloud bundle just for this. */
interface AbTestSidebarRow {
  id: string;
  page_path: string;
  name: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format a stored `page_path` (e.g. `page`, `about/page`, `page-copy/page`)
 *  into a friendly display label for the sidebar child rows.
 *    `page`            → "Home"
 *    `about/page`      → "about"
 *    `page-copy/page`  → "page-copy" */
function formatAbTestPageLabel(pagePath: string): string {
  if (pagePath === 'page') return 'Home';
  if (pagePath.endsWith('/page')) return pagePath.slice(0, -'/page'.length);
  return pagePath;
}

// ─── Build menu categories from registry ────────────────────────────────────

interface MenuItem {
  id: string;
  label: string;
  icon: any;
  /** A/B-test-only: which page_path the item drills into. Click sets
   *  both activeSection='ab-tests' and selectedAbTestPageAtom=pagePath. */
  pagePath?: string;
}

function buildMenuCategories(
  registered: Array<{ title: string; items: SettingsSectionDef[] }>,
  abTestPages: string[],
): Array<{ title: string; items: MenuItem[] }> {
  // Website is always first in General
  const result: Array<{ title: string; items: MenuItem[] }> = [
    { title: 'General', items: [{ id: 'website', label: 'Website', icon: SettingsWebsiteIcon }] },
  ];

  for (const cat of registered) {
    // Strip the registry's ab-tests item when we're going to synthesize a
    // category from the pages instead — keeps the sidebar from showing
    // both an "A/B Tests" parent AND its child pages.
    const items = cat.items
      .filter(s => !(s.id === 'ab-tests' && abTestPages.length > 0))
      .map<MenuItem>(s => ({ id: s.id, label: s.label, icon: s.icon }));
    if (items.length === 0) continue;

    const existing = result.find(c => c.title === cat.title);
    if (existing) {
      existing.items.push(...items);
    } else {
      result.push({ title: cat.title, items });
    }
  }

  // Synthesize an "A/B Tests" category whose ITEMS are the actual pages
  // with tests. Matches the reference's sidebar: pages float as first-class nav
  // entries rather than living under a clickable "A/B Tests" index that
  // shows a flat all-tests list.
  //
  // Icons + ordering mirror the Pages panel: the home page (`page`) uses
  // the home glyph and pins to the top of the list, every other page
  // uses the document glyph and sorts alphabetically below it.
  if (abTestPages.length > 0) {
    const sorted = [...abTestPages].sort((a, b) => {
      if (a === 'page') return -1;
      if (b === 'page') return 1;
      return a.localeCompare(b);
    });
    result.push({
      title: 'A/B Tests',
      items: sorted.map<MenuItem>(p => ({
        id: `ab-tests:${p}`,
        label: formatAbTestPageLabel(p),
        icon: p === 'page' ? PageHomeIcon : PageDocumentIcon,
        pagePath: p,
      })),
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SettingsOverlay
// ═══════════════════════════════════════════════════════════════════════════

export default function SettingsOverlay() {
  // ─── Atoms ───────────────────────────────────────────────────────────
  const [isOpen, setIsOpen] = useAtom(settingsOverlayOpenAtom);
  const [websiteSettings, setWebsiteSettings] = useAtom(websiteSettingsAtom);
  const [activeSection, setActiveSection] = useAtom(settingsSectionAtom);

  // ─── Mobile nav dropdown (sidebar replacement on small screens) ─────
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // ─── A/B test page children for the sidebar ────────────────────────
  // List of unique `page_path` values from the website's A/B tests. Shown
  // as nested children under the "A/B Tests" sidebar entry so the user
  // can drill into a specific page's tests with one click — same UX as
  // the reference's settings sidebar. Refreshed on overlay open + whenever the
  // tests change (the `ab-tests-changed` event the test rows dispatch
  // after create/update/delete).
  const [abTestPages, setAbTestPages] = useState<string[]>([]);
  // Keyed by `page_path` — full test rows so the sidebar's per-row
  // ellipsis menu can rename / delete without re-fetching. Kept in sync
  // with `abTestPages` by the same load() effect below.
  const [abTestsByPage, setAbTestsByPage] = useState<Map<string, AbTestSidebarRow[]>>(new Map());
  const [selectedAbTestPage, setSelectedAbTestPage] = useAtom(selectedAbTestPageAtom);
  const [selectedSeoPage, setSelectedSeoPage] = useAtom(selectedSeoPageAtom);

  // ─── A/B Tests sidebar row ellipsis state ──────────────────────────
  // Which row's ⋯ dropdown is currently open; which row is in rename
  // mode; which row is in delete-confirm. One-at-a-time is fine — the
  // sidebar is single-column. Refs keyed by page_path so each row's ⋯
  // button can be the popover/menu anchor.
  const [abMenuOpenFor, setAbMenuOpenFor] = useState<string | null>(null);
  const [abRenameTarget, setAbRenameTarget] = useState<AbTestSidebarRow | null>(null);
  const [abDeleteTarget, setAbDeleteTarget] = useState<string | null>(null);
  const [isAbDeleting, setIsAbDeleting] = useState(false);
  const abMenuRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // ─── Mobile detection ──────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ─── Project ID ─────────────────────────────────────────────────────
  const websiteId = getProjectId() || '';

  // ─── File input refs ────────────────────────────────────────────────
  const faviconLightInputRef = useRef<HTMLInputElement>(null);
  const socialShareInputRef = useRef<HTMLInputElement>(null);

  // ─── Upload loading states ──────────────────────────────────────────
  const [isUploadingFaviconLight, setIsUploadingFaviconLight] = useState(false);
  const [isUploadingSocialShare, setIsUploadingSocialShare] = useState(false);
  const [isDeletingFavicon, setIsDeletingFavicon] = useState(false);
  const [isDeletingSocialShare, setIsDeletingSocialShare] = useState(false);

  // ─── Confirm modal states ──────────────────────────────────────────
  const [showRemoveFaviconConfirm, setShowRemoveFaviconConfirm] = useState(false);
  const [showRemoveSocialShareConfirm, setShowRemoveSocialShareConfirm] = useState(false);

  // ─── Subdomain state (for Google Search Preview) ───────────────────
  const [subdomain, setSubdomain] = useState<string | null>(null);

  // ─── Local form state ──────────────────────────────────────────────
  const [siteName, setSiteName] = useState(websiteSettings.name || '');
  const [siteDescription, setSiteDescription] = useState(websiteSettings.description || '');
  const [defaultLanguage, setDefaultLanguage] = useState(websiteSettings.languageCode || 'en');
  const [customCodeHead, setCustomCodeHead] = useState(websiteSettings.customCodeHead || '');
  const [customCodeBody, setCustomCodeBody] = useState(websiteSettings.customCodeBody || '');
  const [defaultTheme, setDefaultTheme] = useState<'light' | 'dark' | 'system'>(websiteSettings.defaultTheme || 'light');

  // ─── "Made in Revyme" badge opt-out ─────────────────────────────────
  // Available on EVERY plan (2026-08-19) — the badge is a user choice, not
  // a paid perk. Truth lives in `websites.hide_watermark` (the Worker reads
  // it via PLANS_KV), so this reads/writes the backend directly rather than
  // the project's siteConfig. Applies to the LIVE site within seconds — no
  // republish (for sites published on the hideWatermark-aware worker).
  const [showBadge, setShowBadge] = useState(true);
  const [badgeLoaded, setBadgeLoaded] = useState(false);
  useEffect(() => {
    if (!CLOUD_ENABLED || !websiteId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/websites/${websiteId}`, { credentials: 'include' });
        if (!res.ok) return;
        const row = await res.json() as { hide_watermark?: boolean };
        if (!cancelled) { setShowBadge(!(row.hide_watermark ?? false)); setBadgeLoaded(true); }
      } catch { /* toggle stays at default-on, disabled until loaded */ }
    })();
    return () => { cancelled = true; };
  }, [websiteId]);
  const handleToggleBadge = useCallback((show: boolean) => {
    setShowBadge(show); // optimistic — revert on failure
    void setWebsiteWatermark(websiteId, !show).catch(() => setShowBadge(!show));
    trace.action('settings:watermark-toggle', { websiteId, show });
  }, [websiteId]);

  // ─── Change tracking ───────────────────────────────────────────────
  const [hasMetadataChanges, setHasMetadataChanges] = useState(false);
  const [hasCustomCodeChanges, setHasCustomCodeChanges] = useState(false);
  const [hasThemeChanges, setHasThemeChanges] = useState(false);

  // ─── Change tracking effects ───────────────────────────────────────

  useEffect(() => {
    setHasMetadataChanges(
      siteName !== (websiteSettings.name || '') ||
      siteDescription !== (websiteSettings.description || '') ||
      defaultLanguage !== (websiteSettings.languageCode || 'en')
    );
  }, [siteName, siteDescription, defaultLanguage, websiteSettings]);

  useEffect(() => {
    setHasCustomCodeChanges(
      customCodeHead !== (websiteSettings.customCodeHead || '') ||
      customCodeBody !== (websiteSettings.customCodeBody || '')
    );
  }, [customCodeHead, customCodeBody, websiteSettings]);

  useEffect(() => {
    setHasThemeChanges(defaultTheme !== (websiteSettings.defaultTheme || 'light'));
  }, [defaultTheme, websiteSettings]);

  // ─── Open-time reset — reload fresh settings from the file when the
  // user opens the overlay. No fade — render is gated by `isOpen` alone
  // so it snaps in / snaps out.

  useEffect(() => {
    if (!isOpen) return;
    trace.action('settings:open');
    const fresh = loadSettingsFromLayout();
    setWebsiteSettings(fresh);
    setSiteName(fresh.name);
    setSiteDescription(fresh.description);
    setDefaultLanguage(fresh.languageCode);
    setCustomCodeHead(fresh.customCodeHead);
    setCustomCodeBody(fresh.customCodeBody);
    setDefaultTheme(fresh.defaultTheme);
    setHasMetadataChanges(false);
    setHasCustomCodeChanges(false);
    setHasThemeChanges(false);
    // NOTE: selectedAbTestPage is intentionally NOT reset here — the URL
    // restore effect + the auto-select-first-page effect together drive
    // that atom now, so wiping it on every open would clobber the page
    // a URL refresh just restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ─── A/B tests pages fetch ─────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !websiteId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/ab-tests?websiteId=${websiteId}`);
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const tests = (j.tests ?? []) as AbTestSidebarRow[];
        const pages: string[] = Array.from(new Set(tests.map(t => t.page_path))).sort();
        const byPage = new Map<string, AbTestSidebarRow[]>();
        for (const t of tests) {
          const list = byPage.get(t.page_path) ?? [];
          list.push({ id: t.id, page_path: t.page_path, name: t.name });
          byPage.set(t.page_path, list);
        }
        setAbTestPages(pages);
        setAbTestsByPage(byPage);
      } catch (e) {
        trace.error('settings:ab-test-pages', e);
      }
    };
    void load();
    window.addEventListener('ab-tests-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('ab-tests-changed', load);
    };
  }, [isOpen, websiteId]);

  // ─── URL sync — restore on mount + reflect open/section in ?settings= ────
  //
  // Refresh-safe: the modal state lives in the URL (?settings=plans), so a
  // reload from `/builder/<id>?settings=plans` lands the user right back at
  // the Plans tab. Uses replaceState so this doesn't pollute browser history
  // for every section click (back arrow still jumps out to wherever you
  // came from before opening Settings).

  // ?settings value encodes the section and (when applicable) the
  // sub-selection. Two prefixed forms supported today:
  //   ab-tests:<pagePath>  →  A/B Tests sub-page (e.g. ab-tests:page)
  //   pages:<slug>         →  Pages SEO sub-page (e.g. pages:about/page)
  // Anything else is a bare section id (`website`, `domain`, …).
  // No suffix on `pages:` means "no page chosen yet" — the section's
  // auto-select effect picks the first one.
  const applySettingsParam = (value: string) => {
    if (value.startsWith('ab-tests:')) {
      setActiveSection('ab-tests');
      setSelectedAbTestPage(decodeURIComponent(value.slice('ab-tests:'.length)));
      return;
    }
    if (value.startsWith('pages:')) {
      setActiveSection('pages');
      const slug = decodeURIComponent(value.slice('pages:'.length));
      setSelectedSeoPage(slug ? pageSlugToFilePath(slug) : null);
      return;
    }
    setActiveSection(value);
    if (value !== 'ab-tests') setSelectedAbTestPage(null);
    if (value !== 'pages') setSelectedSeoPage(null);
  };

  // Restore from URL on first mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const section = params.get('settings');
    if (section) {
      applySettingsParam(section);
      setIsOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write to URL on every isOpen / activeSection / selectedAbTestPage /
  // selectedSeoPage change.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (isOpen) {
      let value = activeSection;
      if (activeSection === 'ab-tests' && selectedAbTestPage) {
        value = `ab-tests:${encodeURIComponent(selectedAbTestPage)}`;
      } else if (activeSection === 'pages' && selectedSeoPage) {
        value = `pages:${encodeURIComponent(pageFilePathToSlug(selectedSeoPage))}`;
      }
      params.set('settings', value);
    } else {
      params.delete('settings');
    }
    const search = params.toString();
    const nextUrl =
      window.location.pathname +
      (search ? '?' + search : '') +
      window.location.hash;
    const currentUrl =
      window.location.pathname + window.location.search + window.location.hash;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [isOpen, activeSection, selectedAbTestPage, selectedSeoPage]);

  // Sync state ← URL on browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const section = params.get('settings');
      if (section) {
        applySettingsParam(section);
        setIsOpen(true);
      } else {
        setIsOpen(false);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select the first page when the user lands on the A/B Tests
  // section without one chosen yet — the bare "index" view isn't a
  // useful destination once there are tests, so we always pin to a
  // concrete page. ALSO re-pick when the currently-selected page is
  // no longer in the list (e.g. user just deleted the last test on
  // it from the sidebar's ⋯ menu, so the page disappeared from the
  // A/B Tests sidebar). An empty list falls back to null + the
  // "no tests" placeholder content.
  useEffect(() => {
    if (activeSection !== 'ab-tests') return;
    if (abTestPages.length === 0) {
      if (selectedAbTestPage !== null) setSelectedAbTestPage(null);
      return;
    }
    if (selectedAbTestPage === null || !abTestPages.includes(selectedAbTestPage)) {
      setSelectedAbTestPage(abTestPages[0]!);
    }
  }, [activeSection, selectedAbTestPage, abTestPages, setSelectedAbTestPage]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        trace.action('settings:close-escape');
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  // ─── Fetch subdomain for Google Search Preview ─────────────────────

  useEffect(() => {
    if (!isOpen || !websiteId) return;
    const fetchSubdomain = async () => {
      try {
        const response = await fetch(`/api/websites/${websiteId}`);
        if (response.ok) {
          // GET /api/websites/:id returns the row flat — no `.website` wrapper.
          const data = await response.json();
          setSubdomain(data.subdomain || null);
        }
      } catch (error) {
        trace.error('settings:fetch-subdomain', error);
      }
    };
    fetchSubdomain();
  }, [isOpen, websiteId]);

  // ─── A/B Tests sidebar Rename / Delete handlers ────────────────────

  /** PATCH /api/ab-tests/:id with the new name, then re-fire the
   *  ab-tests-changed event so the sidebar (and the test-card detail
   *  view if it's open) both refresh. */
  const handleAbRename = useCallback(async (testId: string, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    trace.action('settings:ab-rename', { testId, nextName: trimmed });
    try {
      const r = await fetch(`/api/ab-tests/${testId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Rename failed');
        return;
      }
      window.dispatchEvent(new CustomEvent('ab-tests-changed'));
      setAbRenameTarget(null);
    } catch (e) {
      trace.error('settings:ab-rename', e);
    }
  }, []);

  /** DELETE every test on the page + their variant trees in ProjectFS.
   *  Backend only drops the DB row; the variant files under
   *  `_revyme/variants/<testId>/` are FE-owned, so we have to sweep
   *  them ourselves or the Pages panel keeps listing ghost variants. */
  const handleAbDeleteForPage = useCallback(async (pagePath: string) => {
    const tests = abTestsByPage.get(pagePath) ?? [];
    if (tests.length === 0) {
      setAbDeleteTarget(null);
      return;
    }
    trace.action('settings:ab-delete-page', { pagePath, testCount: tests.length });
    setIsAbDeleting(true);
    try {
      for (const t of tests) {
        const r = await fetch(`/api/ab-tests/${t.id}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => null);
          alert(err?.error?.message ?? `Failed to delete "${t.name}"`);
          continue;
        }
        const prefix = `_revyme/variants/${t.id}/`;
        for (const path of projectFS.listFiles(prefix)) {
          projectFS.deleteFile(path);
        }
      }
      window.dispatchEvent(new CustomEvent('ab-tests-changed'));
      // The auto-select effect (below the URL sync) handles "the
      // selected page no longer exists in `abTestPages`" — once load()
      // updates the list it'll re-pick the first remaining page (or
      // null if the list is empty). No manual re-selection needed
      // here, and trying to do it synchronously hits a race because
      // load() is still in flight.
      setAbDeleteTarget(null);
    } catch (e) {
      trace.error('settings:ab-delete-page', e);
    } finally {
      setIsAbDeleting(false);
    }
  }, [abTestsByPage]);

  // ─── Save handlers ─────────────────────────────────────────────────

  const handleSaveSiteMetadata = useCallback(() => {
    if (!hasMetadataChanges) return;
    trace.action('settings:save-metadata', { siteName, siteDescription, defaultLanguage });
    setWebsiteSettings({
      ...websiteSettings,
      name: siteName,
      description: siteDescription,
      languageCode: defaultLanguage,
    });
    queueMutation({ type: 'updateMetadata', metadata: { title: siteName, description: siteDescription } });
    queueMutation({ type: 'updateSiteConfig', config: { language: defaultLanguage } });
    setHasMetadataChanges(false);
  }, [hasMetadataChanges, siteName, siteDescription, defaultLanguage, websiteSettings, setWebsiteSettings]);

  const handleSaveCustomCode = useCallback(() => {
    if (!hasCustomCodeChanges) return;
    trace.action('settings:save-custom-code');
    setWebsiteSettings({ ...websiteSettings, customCodeHead, customCodeBody });
    queueMutation({ type: 'updateSiteConfig', config: { customHead: customCodeHead, customBody: customCodeBody } });
    setHasCustomCodeChanges(false);
  }, [hasCustomCodeChanges, customCodeHead, customCodeBody, websiteSettings, setWebsiteSettings]);

  const handleSaveTheme = useCallback(() => {
    if (!hasThemeChanges) return;
    trace.action('settings:save-theme', { defaultTheme });
    setWebsiteSettings({ ...websiteSettings, defaultTheme });
    queueMutation({ type: 'updateSiteConfig', config: { theme: defaultTheme } });
    setHasThemeChanges(false);
  }, [hasThemeChanges, defaultTheme, websiteSettings, setWebsiteSettings]);

  // ─── Upload handler ────────────────────────────────────────────────

  const handleUploadMetadata = useCallback(async (
    file: File,
    source: string,
    setLoading: (loading: boolean) => void,
    onSuccess: (url: string) => void,
  ) => {
    if (!websiteId) return;
    setLoading(true);
    trace.action('settings:upload-start', { source, fileName: file.name });
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'metadata');
      formData.append('source', source);
      formData.append('websiteId', websiteId);
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const data = await response.json();
      trace.action('settings:upload-success', { source, url: data.url });
      onSuccess(data.url);
    } catch (error) {
      trace.error('settings:upload-failed', error);
      alert('Failed to upload. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [websiteId]);

  // ─── Favicon handlers ──────────────────────────────────────────────

  const handleFaviconLightUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleUploadMetadata(file, 'favicon-light', setIsUploadingFaviconLight, (url) => {
      setWebsiteSettings({ ...websiteSettings, faviconLight: url });
      queueMutation({ type: 'updateMetadata', metadata: { icons: { icon: url } } });
    });
    e.target.value = '';
  }, [handleUploadMetadata, websiteSettings, setWebsiteSettings]);

  const handleRemoveFavicon = () => {
    if (!websiteSettings.faviconLight) return;
    setShowRemoveFaviconConfirm(true);
  };

  const confirmRemoveFavicon = useCallback(async () => {
    setShowRemoveFaviconConfirm(false);
    setIsDeletingFavicon(true);
    trace.action('settings:remove-favicon');
    try {
      const deleteResponse = await fetch('/api/delete-file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: websiteSettings.faviconLight }),
      });
      if (!deleteResponse.ok) {
        throw new Error('Failed to delete file from storage');
      }
      setWebsiteSettings({
        ...websiteSettings,
        faviconLight: '',
      });
      queueMutation({ type: 'updateMetadata', metadata: { icons: { icon: '' } } });
    } catch (error) {
      trace.error('settings:remove-favicon', error);
      alert('Failed to remove favicon. Please try again.');
    } finally {
      setIsDeletingFavicon(false);
    }
  }, [websiteSettings, setWebsiteSettings]);

  // ─── Social share handlers ─────────────────────────────────────────

  const handleSocialShareUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleUploadMetadata(file, 'social-share-default', setIsUploadingSocialShare, (url) => {
      setWebsiteSettings({ ...websiteSettings, socialShareImage: url });
      queueMutation({ type: 'updateMetadata', metadata: { openGraph: { images: [url] } } });
    });
    e.target.value = '';
  }, [handleUploadMetadata, websiteSettings, setWebsiteSettings]);

  const handleRemoveSocialShare = () => {
    if (!websiteSettings.socialShareImage) return;
    setShowRemoveSocialShareConfirm(true);
  };

  const confirmRemoveSocialShare = useCallback(async () => {
    setShowRemoveSocialShareConfirm(false);
    setIsDeletingSocialShare(true);
    trace.action('settings:remove-social-share');
    try {
      const deleteResponse = await fetch('/api/delete-file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: websiteSettings.socialShareImage }),
      });
      if (!deleteResponse.ok) {
        throw new Error('Failed to delete file from storage');
      }
      setWebsiteSettings({
        ...websiteSettings,
        socialShareImage: '',
      });
      queueMutation({ type: 'updateMetadata', metadata: { openGraph: { images: [] } } });
    } catch (error) {
      trace.error('settings:remove-social-share', error);
      alert('Failed to remove image. Please try again.');
    } finally {
      setIsDeletingSocialShare(false);
    }
  }, [websiteSettings, setWebsiteSettings]);

  // ─── Language change handler ───────────────────────────────────────

  const handleDefaultLanguageChange = (code: string) => {
    trace.action('settings:language-change', { from: defaultLanguage, to: code });
    setDefaultLanguage(code);
  };

  // ─── Menu categories (built from registry) ────────────────────────

  const menuCategories = buildMenuCategories(getSettingsCategories(), abTestPages);

  // ─── renderContent ─────────────────────────────────────────────────

  const renderContent = () => {
    // Website section is inline (uses parent state: websiteSettings atom, mutation queue)
    if (activeSection === 'website') {
      return (
        <div className="space-y-8">
          {/* ─── Site metadata ─── */}
          <SettingsGroup
            title="Site metadata"
            action={
              <SaveButton
                onClick={handleSaveSiteMetadata}
                saving={false}
                dirty={hasMetadataChanges}
              />
            }
          >
            <SettingsRow label="Name" htmlFor="site-name">
              <input
                id="site-name"
                type="text"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                className={ROW_INPUT_CLS}
                placeholder="My Amazing Website"
              />
            </SettingsRow>

            <SettingsRow label="Default language" htmlFor="site-language">
              <RowSelect
                id="site-language"
                value={defaultLanguage}
                options={LANGUAGE_OPTIONS}
                onChange={handleDefaultLanguageChange}
              />
            </SettingsRow>

            <SettingsRow label="Description" htmlFor="site-description" align="top">
              <textarea
                id="site-description"
                rows={3}
                value={siteDescription}
                onChange={(e) => setSiteDescription(e.target.value)}
                className={`${ROW_INPUT_CLS} resize-none min-h-[56px]`}
                placeholder="A brief description of your website..."
              />
            </SettingsRow>

            <SettingsRow label="Search preview" align="top" interactive={false}>
              <div className="flex flex-col gap-0.5 py-1">
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                  <span>{subdomain ? `${subdomain}.revyme.app` : 'yoursite.revyme.app'}</span>
                  <MoreVerticalIcon />
                </div>
                <div className="text-base text-[#8ab4f8] font-normal leading-tight">
                  {siteName || 'My Website'}
                </div>
                <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {siteDescription || 'Made with Revyme'}
                </div>
              </div>
            </SettingsRow>
          </SettingsGroup>

          {/* ─── Branding ─── */}
          <SettingsGroup title="Branding">
            <input
              ref={faviconLightInputRef}
              type="file"
              accept="image/png,image/x-icon,image/vnd.microsoft.icon"
              onChange={handleFaviconLightUpload}
              className="hidden"
            />
            <input
              ref={socialShareInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png"
              onChange={handleSocialShareUpload}
              className="hidden"
            />

            <SettingsRow label="Favicon" align="top">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 shrink-0 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--bg-hover)]/50 flex items-center justify-center overflow-hidden">
                    {websiteSettings.faviconLight ? (
                      <img src={websiteSettings.faviconLight} alt="Favicon" className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-[10px] text-[var(--text-tertiary)]">32×32</span>
                    )}
                  </div>
                  <RowButton
                    onClick={() => faviconLightInputRef.current?.click()}
                    loading={isUploadingFaviconLight}
                  >
                    <UploadIcon />
                    Upload
                  </RowButton>
                  {websiteSettings.faviconLight && (
                    <RowButton
                      onClick={handleRemoveFavicon}
                      loading={isDeletingFavicon}
                      variant="danger"
                      title="Remove favicon"
                    >
                      <Trash2Icon />
                    </RowButton>
                  )}
                </div>
                <p className="text-xs text-[var(--text-tertiary)]">
                  32×32px or 64×64px PNG or ICO format.
                </p>
              </div>
            </SettingsRow>

            <SettingsRow label="Social image" align="top">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <div className="w-28 h-[59px] shrink-0 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--bg-hover)]/50 flex items-center justify-center overflow-hidden">
                    {websiteSettings.socialShareImage ? (
                      <img src={websiteSettings.socialShareImage} alt="Social share" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-[var(--text-tertiary)]">1200×630</span>
                    )}
                  </div>
                  <RowButton
                    onClick={() => socialShareInputRef.current?.click()}
                    loading={isUploadingSocialShare}
                  >
                    <UploadIcon />
                    Upload
                  </RowButton>
                  {websiteSettings.socialShareImage && (
                    <RowButton
                      onClick={handleRemoveSocialShare}
                      loading={isDeletingSocialShare}
                      variant="danger"
                      title="Remove social share image"
                    >
                      <Trash2Icon />
                    </RowButton>
                  )}
                </div>
                <p className="text-xs text-[var(--text-tertiary)]">
                  1200×630px JPG or PNG. Appears when sharing on social media.
                </p>
              </div>
            </SettingsRow>

            {/* "Made in Revyme" badge — a free choice on every plan. Saves
                immediately (no Save button): the backend flips the column and
                rewrites the site's edge KV, so the live site follows within
                seconds. Hidden entirely in OSS/self-hosted builds — there is
                no worker injecting a badge there. */}
            {CLOUD_ENABLED && (
              <SettingsRow label="Made in Revyme badge">
                <div className="flex items-center justify-between gap-3 py-1">
                  <p className="text-xs text-[var(--text-tertiary)]">
                    Show the small &ldquo;Made in Revyme&rdquo; badge on your published site.
                  </p>
                  <div className={badgeLoaded ? '' : 'opacity-40 pointer-events-none'}>
                    <Toggle value={showBadge} onChange={handleToggleBadge} />
                  </div>
                </div>
              </SettingsRow>
            )}
          </SettingsGroup>

          {/* ─── Appearance ─── */}
          <SettingsGroup
            title="Appearance"
            action={
              <SaveButton onClick={handleSaveTheme} saving={false} dirty={hasThemeChanges} />
            }
          >
            <SettingsRow label="Default theme" htmlFor="default-theme" align="top">
              <div className="flex flex-col gap-1">
                <RowSelect
                  id="default-theme"
                  value={defaultTheme}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'system', label: 'System' },
                  ]}
                  onChange={(v) => setDefaultTheme(v as 'light' | 'dark' | 'system')}
                />
                <p className="text-xs text-[var(--text-tertiary)]">
                  Initial theme when visitors load your site.
                </p>
              </div>
            </SettingsRow>
          </SettingsGroup>

          {/* ─── Custom code ─── */}
          <SettingsGroup
            title="Custom code"
            action={
              <SaveButton
                onClick={handleSaveCustomCode}
                saving={false}
                dirty={hasCustomCodeChanges}
              />
            }
          >
            <SettingsRow label="End of <head> tag" htmlFor="custom-head" align="top">
              <textarea
                id="custom-head"
                rows={5}
                value={customCodeHead}
                onChange={(e) => setCustomCodeHead(e.target.value)}
                className={`${ROW_INPUT_CLS} resize-none font-mono text-xs min-h-[80px]`}
                placeholder={`<!-- Analytics, meta tags, or custom CSS -->\n<script>\n  // Your custom code here\n</script>`}
              />
            </SettingsRow>
            <SettingsRow label="End of <body> tag" htmlFor="custom-body" align="top">
              <textarea
                id="custom-body"
                rows={5}
                value={customCodeBody}
                onChange={(e) => setCustomCodeBody(e.target.value)}
                className={`${ROW_INPUT_CLS} resize-none font-mono text-xs min-h-[80px]`}
                placeholder={`<!-- Scripts, tracking codes -->\n<script>\n  // Your custom code here\n</script>`}
              />
            </SettingsRow>
          </SettingsGroup>
        </div>
      );
    }

    // Look up registered section from plugin registry
    const allSections = getSettingsCategories().flatMap(c => c.items);
    const section = allSections.find(s => s.id === activeSection);
    if (section) {
      const Component = section.component;
      return <Component websiteId={websiteId} />;
    }

    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--text-secondary)]">Section coming soon...</p>
      </div>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────

  if (!isOpen) return null;

  const onClose = () => {
    trace.action('settings:close');
    setIsOpen(false);
  };

  const activeLabel = menuCategories
    .flatMap((cat) => cat.items)
    .find((item) => item.id === activeSection)?.label;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex flex-col"
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      {/* ─── Top bar (standard: back arrow left, title centered) ──
          The editor's RightHeader is bumped to z-[10001] when settings
          is open so it floats above this bar on the right. We reserve
          260px of right padding (RightHeader's width) so the centered
          title stays visually centered relative to the visible portion
          of this bar.

          Left side mirrors LeftHeader (51px logo column + vertical
          rule) so the chrome reads continuously with the editor — same
          treatment preview mode gets. The Back button sits where the
          File/Edit/Insert/View tabs would normally live.            */}
      <div
        className="relative flex items-center h-[52px] border-b border-[var(--control-border)] shrink-0"
        style={{ backgroundColor: 'var(--bg-surface)', paddingRight: 260 }}
      >
        <div className="w-[51px] h-full flex items-center justify-center flex-shrink-0">
          <LogoButton />
        </div>
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
        {/* Back to canvas — same design-system Button + size + variant
            as the right-header Play button, just mirrored: icon on
            the left, "Back" label as the badge text. Reads as a peer
            of the Settings / Export / Play / Publish controls on the
            opposite side of the header. */}
        <div className="flex items-center" style={{ paddingLeft: 7 }}>
          <Button
            variant="secondary"
            size="sm"
            tabIndex={-1}
            className="cut-corners"
            icon={<BackIcon />}
            onClick={onClose}
            title="Back to canvas"
          >
            Back
          </Button>
        </div>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm font-semibold text-[var(--text-primary)] truncate"
          style={{ pointerEvents: 'none' }}
        >
          Settings
        </div>
      </div>

      {/* ─── Body: sidebar + content ─────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar -- desktop only */}
        {!isMobile && (
          <div
            className="w-60 border-r border-[var(--control-border)] flex flex-col overflow-y-auto shrink-0"
            style={{ backgroundColor: 'var(--bg-surface)' }}
          >
            <nav className="flex-1 px-3 py-8 space-y-5">
              {menuCategories.map((category, index) => (
                <div key={index}>
                  {/* Category title — matches the property-panel ToolSection
                      header style (text-xs font-bold, primary color, mixed
                      case) so the settings sidebar and the right tool panel
                      read as the same visual language. */}
                  <div className="px-3 mb-1.5 text-xs font-bold text-[var(--text-primary)]">
                    {category.title}
                  </div>
                  <div className="space-y-0.5">
                    {category.items.map((item) => {
                      const Icon = item.icon;
                      // Page-scoped A/B Tests items carry their own pagePath
                      // so we can highlight the exact row the user is on; all
                      // other items match purely on activeSection.
                      const isActive = item.pagePath
                        ? activeSection === 'ab-tests' && selectedAbTestPage === item.pagePath
                        : activeSection === item.id;
                      const tests = item.pagePath ? abTestsByPage.get(item.pagePath) ?? [] : [];
                      const showEllipsis = !!item.pagePath && tests.length > 0;
                      const menuOpen = showEllipsis && abMenuOpenFor === item.pagePath;
                      const isRenaming = !!item.pagePath && abRenameTarget?.page_path === item.pagePath;

                      // A/B Tests rows get a hover-revealed ellipsis on the
                      // right (Rename + Delete) — same pattern as the Pages
                      // panel. Wrapped in `group` so the ellipsis can react
                      // to hover ON THE ROW (not just on itself).
                      //
                      // Rename swaps the label `<span>` for an inline
                      // `<input>` (same row geometry — no popover). Save
                      // on Enter / blur; Esc cancels. Mirrors the Pages
                      // panel rename UX exactly.
                      return (
                        <div key={item.id} className="group relative flex items-center">
                          {isRenaming && abRenameTarget ? (
                            <div
                              className={`w-full flex items-center gap-2 pl-5 pr-3 py-1.5 cut-corners text-xs font-medium ${
                                isActive
                                  ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-primary)] bg-[var(--bg-hover)]'
                              }`}
                            >
                              <Icon className="w-3.5 h-3.5 shrink-0" />
                              <SidebarRenameInput
                                initial={abRenameTarget.name}
                                onCommit={(next) => handleAbRename(abRenameTarget.id, next)}
                                onCancel={() => setAbRenameTarget(null)}
                              />
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (item.pagePath) {
                                  trace.action('settings:ab-test-page-change', { page: item.pagePath });
                                  setActiveSection('ab-tests');
                                  setSelectedAbTestPage(item.pagePath);
                                } else {
                                  trace.action('settings:section-change', { from: activeSection, to: item.id });
                                  setActiveSection(item.id);
                                  setSelectedAbTestPage(null);
                                }
                              }}
                              // `pr-9` reserves space so the row label never
                              // disappears behind the ellipsis on hover.
                              className={`w-full flex items-center gap-2 pl-5 ${showEllipsis ? 'pr-9' : 'pr-3'} py-1.5 cut-corners text-xs font-medium transition-colors cursor-pointer ${
                                isActive
                                  ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                              }`}
                            >
                              <Icon className="w-3.5 h-3.5" />
                              <span className="truncate">{item.label}</span>
                            </button>
                          )}
                          {showEllipsis && item.pagePath && !isRenaming && (
                            <button
                              ref={(el) => { abMenuRefs.current.set(item.pagePath!, el); }}
                              type="button"
                              aria-label="More actions"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAbMenuOpenFor((cur) => cur === item.pagePath ? null : item.pagePath!);
                              }}
                              // Hidden until row hover OR menu open OR row
                              // selected — matches the reference pages-panel
                              // ellipsis pattern: visible only when the user
                              // is hovering or interacting with the row.
                              className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center cut-corners text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-opacity ${
                                menuOpen || isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                              }`}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                <circle cx="5" cy="12" r="1.6" />
                                <circle cx="12" cy="12" r="1.6" />
                                <circle cx="19" cy="12" r="1.6" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        )}

        {/* Content Area */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ backgroundColor: 'var(--bg-surface)' }}
        >
          {/* Mobile: section picker dropdown above the content */}
          {isMobile && (
            <div
              className="flex items-center px-4 py-3 border-b border-[var(--control-border)] shrink-0"
              style={{ backgroundColor: 'var(--bg-surface)' }}
            >
              <div className="relative">
                <button
                  onClick={() => setMobileNavOpen((p) => !p)}
                  className="flex items-center gap-1.5 text-base font-semibold text-[var(--text-primary)] cursor-pointer"
                >
                  {activeLabel}
                  <ChevronDownIcon />
                </button>
                {mobileNavOpen && (
                  <>
                    <div className="fixed inset-0 z-[1]" onClick={() => setMobileNavOpen(false)} />
                    <div className="absolute top-full left-0 mt-1 min-w-[200px] bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-lg py-1.5 z-[2]">
                      {menuCategories.map((category, ci) => (
                        <div key={ci}>
                          <div className="px-3 py-1 text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                            {category.title}
                          </div>
                          {category.items.map((item) => {
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.id}
                                onClick={() => {
                                  trace.action('settings:section-change', { from: activeSection, to: item.id });
                                  setActiveSection(item.id);
                                  setMobileNavOpen(false);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                                  activeSection === item.id
                                    ? 'text-[var(--text-primary)] bg-[var(--bg-active)]'
                                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                                }`}
                              >
                                <Icon className="w-4 h-4" />
                                <span>{item.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Scrollable content — wider max-width gives analytics/dashboards
              real estate while keeping form sections readable. Each section
              renders its own page heading (e.g. "Analytics", "A/B testing"),
              so we don't impose one here.

              The A/B-tests detail view + Pages SEO opt out of the
              max-w-4xl + outer scroll because they render their own
              inner sidebar flush against the outer settings sidebar.
              Each manages its own padding and scroll behaviour. */}
          {(activeSection === 'ab-tests' && selectedAbTestPage) || activeSection === 'pages' ? (
            <div className="flex-1 min-h-0">{renderContent()}</div>
          ) : (
            <div className={`flex-1 overflow-y-auto ${isMobile ? 'px-4 py-5' : 'px-10 py-8'}`}>
              <div className="mx-auto max-w-4xl">
                {renderContent()}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Remove Favicon Modal */}
      <ConfirmModal
        isOpen={showRemoveFaviconConfirm}
        onConfirm={confirmRemoveFavicon}
        onCancel={() => setShowRemoveFaviconConfirm(false)}
        title="Remove favicon"
        message="Are you sure you want to remove this favicon?"
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Confirm Remove Social Share Modal */}
      <ConfirmModal
        isOpen={showRemoveSocialShareConfirm}
        onConfirm={confirmRemoveSocialShare}
        onCancel={() => setShowRemoveSocialShareConfirm(false)}
        title="Remove social share image"
        message="Are you sure you want to remove this image?"
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
      />

      {/* ─── A/B Tests sidebar row ⋯ infrastructure ───────────────────
          DropdownMenu anchored to whichever row's ⋯ is currently open.
          Rename + Delete entries operate on the FIRST test of that
          page (1 test per page is the common flow — multi-test pages
          surface the per-test ellipsis in the test card itself). */}
      {abMenuOpenFor && (() => {
        const tests = abTestsByPage.get(abMenuOpenFor) ?? [];
        const primaryTest = tests[0];
        const anchorEl = abMenuRefs.current.get(abMenuOpenFor) ?? null;
        // anchorRef has to be a stable RefObject; fake one off the
        // current snapshot. DropdownMenu only reads `.current`.
        const anchorRef = { current: anchorEl } as React.RefObject<HTMLButtonElement>;
        const items: DropdownMenuEntry[] = [];
        if (primaryTest) {
          items.push({
            id: 'rename',
            label: tests.length > 1 ? `Rename "${primaryTest.name}"` : 'Rename',
            onClick: () => {
              setAbMenuOpenFor(null);
              setAbRenameTarget(primaryTest);
            },
          });
          items.push({ type: 'separator' });
        }
        items.push({
          id: 'delete',
          label: tests.length > 1 ? `Delete ${tests.length} tests` : 'Delete',
          onClick: () => {
            setAbMenuOpenFor(null);
            setAbDeleteTarget(abMenuOpenFor);
          },
        });
        return (
          <DropdownMenu
            isOpen
            onClose={() => setAbMenuOpenFor(null)}
            items={items}
            anchorRef={anchorRef}
            position="bottom-right"
            minWidth={160}
            hoverStyle="accent"
          />
        );
      })()}

      <ConfirmModal
        isOpen={abDeleteTarget !== null}
        onConfirm={() => { if (abDeleteTarget) void handleAbDeleteForPage(abDeleteTarget); }}
        onCancel={() => setAbDeleteTarget(null)}
        title="Delete A/B test"
        message={(() => {
          if (!abDeleteTarget) return '';
          const tests = abTestsByPage.get(abDeleteTarget) ?? [];
          if (tests.length === 1) {
            return `"${tests[0]!.name}" will be permanently removed along with its variant files. Conversion data already in your analytics stays put.`;
          }
          return `${tests.length} test(s) on this page will be permanently removed along with their variant files. Conversion data already in your analytics stays put.`;
        })()}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        isLoading={isAbDeleting}
      />
    </div>,
    document.body
  );
}

/** Inline rename input for an A/B Tests sidebar row. Replaces the
 *  row's label `<span>` while editing. Mirrors the Pages-panel rename
 *  UX exactly: auto-focus, auto-select on mount, commit on Enter or
 *  blur, cancel on Escape. Save target is the FIRST test on the page
 *  (the SettingsOverlay's `abRenameTarget` already carries that test). */
function SidebarRenameInput({
  initial, onCommit, onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  // Track whether a commit has already fired so onBlur doesn't
  // double-commit after Enter / Escape (Enter calls onCommit then the
  // input loses focus → onBlur would re-fire).
  const committedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || trimmed === initial) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); committedRef.current = true; onCancel(); }
      }}
      onBlur={commit}
      className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs font-medium text-[var(--text-primary)] p-0"
    />
  );
}
