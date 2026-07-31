// PagesSeoSection.tsx — per-page SEO editor.
//
// Layout: inner sidebar (page list) on the left, form on the right.
// Each page in the project gets its own `export const metadata = {}`
// block in its `.tsx` file; this UI reads/writes that block via the
// existing `metadata-gen` helpers (same pattern Website-level settings
// uses against `app/layout.tsx`).
//
// URL sync: the currently-selected page is encoded into the
// `?settings=pages:<page_path>` slug so refreshing or deep-linking from
// the FileExplorer ⋯ menu lands the user on the right form.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedSeoPageAtom } from '@/code/stores/website-settings-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { parseMetadataFromCode, updateMetadataInCode, type SiteMetadata } from '@/code/generation/metadata-gen';
import {
  SettingsGroup,
  SettingsRow,
  ROW_INPUT_CLS,
  SaveButton,
  RowSelect,
} from '@/editor/overlays/settings-shared';
import ImageSearchModal from '@/editor/ui/ImageSearchModal';
import { trace } from '@/shared/debug-trace';
import { pageFilePathToSlug as slugForPage } from '@/code/project/page-slug-utils';

// ─── Page list helpers ──────────────────────────────────────────────────────

interface PageEntry {
  filePath: string;
  /** Friendly label for the sidebar row. */
  label: string;
  /** Slug used in the `?settings=pages:<slug>` URL — same shape as the
   *  A/B Tests sidebar uses (`page` for home, `about/page` for nested). */
  slug: string;
}

/** Strip both halves of the page pair so the helper handles either
 *  the .client.tsx body or the .tsx server wrapper transparently. */
function stripPageSuffix(filePath: string): string {
  return filePath.replace(/\/page\.client\.tsx$/, '').replace(/\/page\.tsx$/, '');
}

/** Convert a client-half page path to its sibling server wrapper. The
 *  server file is where Next.js reads `export const metadata` from. */
function getServerWrapperPath(clientPath: string): string {
  if (clientPath.endsWith('/page.client.tsx')) {
    return clientPath.replace(/\/page\.client\.tsx$/, '/page.tsx');
  }
  if (clientPath === 'app/page.client.tsx') return 'app/page.tsx';
  return clientPath;
}

/** Map a page client path to a friendly label.
 *    app/page.client.tsx          → 'Home'
 *    app/about/page.client.tsx    → 'about'
 *    app/foo/bar/page.client.tsx  → 'bar'
 *  Route-group parens (`(group)/...`) get stripped because they don't
 *  appear in the URL. */
function labelForPage(filePath: string): string {
  if (filePath === 'app/page.client.tsx' || filePath === 'app/page.tsx') return 'Home';
  const slug = stripPageSuffix(filePath)
    .replace(/^app\//, '')
    .replace(/\(.+?\)\//g, '');
  const parts = slug.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : 'Home';
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PagesSeoSection(): React.ReactElement {
  const version = useAtomValue(projectVersionAtom);
  const [selectedPath, setSelectedPath] = useAtom(selectedSeoPageAtom);

  // Enumerate every `app/**/page.client.tsx` (the canvas-editable
  // half of each page pair). Reactive to ProjectFS version so
  // adding / deleting / renaming a page in the canvas keeps this
  // list in sync. We use .client.tsx instead of .tsx because that's
  // the canonical "page" everywhere else in the editor, but SEO
  // metadata reads/writes target the sibling server wrapper.
  const pages = useMemo<PageEntry[]>(() => {
    void version;
    const list: PageEntry[] = projectFS
      .listFiles('app/')
      .filter((f) => f.endsWith('/page.client.tsx') || f === 'app/page.client.tsx')
      .map((filePath) => ({
        filePath,
        label: labelForPage(filePath),
        slug: slugForPage(filePath),
      }));
    list.sort((a, b) => {
      if (a.filePath === 'app/page.client.tsx') return -1;
      if (b.filePath === 'app/page.client.tsx') return 1;
      return a.label.localeCompare(b.label);
    });
    return list;
  }, [version]);

  // Auto-select on mount or when the selected page disappears (e.g.
  // user just deleted it). Mirrors the A/B Tests auto-select effect.
  useEffect(() => {
    if (pages.length === 0) {
      if (selectedPath !== null) setSelectedPath(null);
      return;
    }
    if (selectedPath === null || !pages.some((p) => p.filePath === selectedPath)) {
      setSelectedPath(pages[0]!.filePath);
    }
  }, [pages, selectedPath, setSelectedPath]);

  const selectedPage = pages.find((p) => p.filePath === selectedPath) ?? null;

  return (
    // Full-height two-column layout. The parent SettingsOverlay
    // renders us edge-to-edge (no max-w-4xl wrap) so this can sit
    // flush against the outer settings sidebar — matching the
    // workspace settings UX where the inner sidebar is immediately
    // adjacent to the outer one with a single divider.
    <div className="flex h-full min-h-0">
      {/* Inner sidebar — same width + padding rhythm as the outer
          settings sidebar (px-3 py-5, label text-xs font-bold, rows
          pl-5 pr-3 py-1.5). That keeps the visual cadence consistent
          across the two levels of nav. */}
      <div className="w-[248px] shrink-0 overflow-y-auto scrollbar-hide pl-4">
        {/* `py-8` matches the form column's vertical padding so the
            "Pages" header sits at the exact same Y as the form's
            "SEO · <pagename>" heading on the right.
            Outer `pl-4` on the wrapper gives the whole inner sidebar
            a 16px gutter from the outer settings sidebar — without it
            the "Pages" header sits flush against the General/Insights
            sidebar's right edge, which read too cramped. */}
        <div className="px-3 py-8 space-y-5">
          <div>
            <div className="px-3 mb-1.5 text-xs font-bold text-[var(--text-primary)]">Pages</div>
            <div className="space-y-0.5">
              {pages.length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-[var(--text-tertiary)]">No pages.</p>
              ) : (
                pages.map((p) => {
                  const isActive = p.filePath === selectedPath;
                  return (
                    <button
                      key={p.filePath}
                      type="button"
                      onClick={() => {
                        trace.action('pages-seo:select', { filePath: p.filePath });
                        setSelectedPath(p.filePath);
                      }}
                      className={`w-full flex items-center gap-2 pl-5 pr-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-black/[0.06] dark:bg-white/10 text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                      }`}
                      title={p.filePath}
                    >
                      <span className="truncate">{p.label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Form column — `pt-[18px] pb-8`. The SettingsGroup heading
          wraps in `py-3` (12px) so the heading text-top lands at
          18+12 = 30px. The two sidebars use `py-8` (32px) but their
          headings are `text-xs` (12px font / 16px line-height) while
          the form heading is `text-sm` (14px / 20px). Aligning the
          optical centers of the three headings means raising the
          form heading by ~2px from the naive top-align — `pt-[18px]`
          lands the centers on exactly the same baseline. */}
      <div className="flex-1 min-w-0 overflow-y-auto scrollbar-hide pl-4 pr-10 pt-[10px] pb-8">
        {/* Left-align the form against the inner sidebar's right edge.
            `mx-auto` centered the form within the column on wide
            viewports, which created a wide gap between the Pages list
            and the SEO heading. `max-w-4xl` is kept as a reading-width
            cap so very wide screens don't stretch input fields across
            the entire viewport. */}
        <div className="max-w-4xl">
          {selectedPage ? (
            <PageSeoForm key={selectedPage.filePath} page={selectedPage} />
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">No page selected.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Per-page form ──────────────────────────────────────────────────────────

interface PageMeta {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterCard: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  robotsIndex: boolean;
  robotsFollow: boolean;
  canonical: string;
}

const EMPTY_META: PageMeta = {
  title: '',
  description: '',
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  twitterCard: '',
  twitterTitle: '',
  twitterDescription: '',
  twitterImage: '',
  robotsIndex: true,
  robotsFollow: true,
  canonical: '',
};

/** Pull our flat PageMeta shape out of the parsed Next.js `metadata`
 *  object. We flatten the nested `openGraph` / `twitter` / `robots` /
 *  `alternates.canonical` paths so the form is a single object. */
function metaToForm(meta: SiteMetadata): PageMeta {
  const og = (meta.openGraph ?? {}) as Record<string, unknown>;
  const twitter = (meta.twitter ?? {}) as Record<string, unknown>;
  const robots = (meta.robots ?? {}) as Record<string, unknown>;
  const alternates = (meta.alternates ?? {}) as Record<string, unknown>;
  const ogImages = og.images as unknown;
  const firstOgImage = Array.isArray(ogImages)
    ? (typeof ogImages[0] === 'string' ? ogImages[0] : (ogImages[0] as { url?: string } | undefined)?.url)
    : undefined;
  return {
    title: (meta.title as string) ?? '',
    description: (meta.description as string) ?? '',
    ogTitle: (og.title as string) ?? '',
    ogDescription: (og.description as string) ?? '',
    ogImage: firstOgImage ?? '',
    twitterCard: (twitter.card as string) ?? '',
    twitterTitle: (twitter.title as string) ?? '',
    twitterDescription: (twitter.description as string) ?? '',
    twitterImage: (twitter.image as string) ?? '',
    robotsIndex: robots.index === undefined ? true : robots.index === true,
    robotsFollow: robots.follow === undefined ? true : robots.follow === true,
    canonical: (alternates.canonical as string) ?? '',
  };
}

/** Inverse of `metaToForm` — produce a deep `SiteMetadata` object that
 *  `updateMetadataInCode` can merge. Empty strings mean "clear the
 *  field" (the generator's `cleanEmpty` walks the merged tree and
 *  drops empties), so unfilled inputs don't pollute the metadata
 *  block with `''` literals. */
function formToMeta(form: PageMeta): SiteMetadata {
  const out: SiteMetadata = {
    title: form.title,
    description: form.description,
    openGraph: {
      title: form.ogTitle,
      description: form.ogDescription,
      images: form.ogImage ? [form.ogImage] : [],
    },
    twitter: {
      card: form.twitterCard,
      title: form.twitterTitle,
      description: form.twitterDescription,
      image: form.twitterImage,
    } as Record<string, unknown>,
    alternates: {
      canonical: form.canonical,
    } as Record<string, unknown>,
    robots: {
      index: form.robotsIndex,
      follow: form.robotsFollow,
    } as Record<string, unknown>,
  };
  return out;
}

function PageSeoForm({ page }: { page: PageEntry }): React.ReactElement {
  const version = useAtomValue(projectVersionAtom);
  // SEO metadata lives in the SERVER wrapper (`page.tsx`) — Next.js
  // App Router only honours `export const metadata` from server
  // components. The page list iterates client paths (the canvas-
  // editable half), so derive the sibling server path here for all
  // read/write operations.
  const metadataPath = useMemo(() => getServerWrapperPath(page.filePath), [page.filePath]);

  const initial = useMemo<PageMeta>(() => {
    void version;
    const code = projectFS.readFile(metadataPath);
    if (!code) return EMPTY_META;
    return metaToForm(parseMetadataFromCode(code));
  }, [metadataPath, version]);

  const [form, setForm] = useState<PageMeta>(initial);
  // Reset form state when the parent swaps to a different page. The
  // PagesSeoSection passes `key={page.filePath}` so this remounts in
  // practice, but keep the effect for belt-and-suspenders.
  useEffect(() => { setForm(initial); }, [initial]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const save = useCallback(() => {
    if (!dirty) return;
    trace.action('pages-seo:save', { metadataPath, filePath: page.filePath });
    const next = formToMeta(form);
    modifyProjectFile(metadataPath, (code) => updateMetadataInCode(code, next));
  }, [dirty, form, metadataPath, page.filePath]);

  const update = <K extends keyof PageMeta>(key: K, value: PageMeta[K]) => {
    setForm((cur) => ({ ...cur, [key]: value }));
  };

  // Image picks are discrete (Choose / Remove) — no "drafting" like
  // text inputs have. Requiring users to hit the Save button after
  // picking caused the "I uploaded but it disappears on reload" bug:
  // the new URL lived only in form state until they clicked Save,
  // which is easy to forget. We persist the image change to the file
  // immediately, leaving any in-progress text-field edits intact in
  // form state (a follow-up Save button click commits those).
  const commitImageField = useCallback((field: 'ogImage' | 'twitterImage', url: string) => {
    trace.action('pages-seo:commit-image', { field, hasUrl: url.length > 0, urlLen: url.length });
    const partial: SiteMetadata = field === 'ogImage'
      ? { openGraph: { images: url ? [url] : [] } }
      : { twitter: { image: url || '' } as Record<string, unknown> };
    modifyProjectFile(metadataPath, (code) => updateMetadataInCode(code, partial));
  }, [metadataPath]);

  return (
    <div className="space-y-8">
      <SettingsGroup
        title={`SEO · ${page.label}`}
        action={<SaveButton onClick={save} saving={false} dirty={dirty} />}
      >
        <SettingsRow label="Title" htmlFor="seo-title">
          <input
            id="seo-title"
            type="text"
            value={form.title}
            onChange={(e) => update('title', e.target.value)}
            className={ROW_INPUT_CLS}
            placeholder="Page title — falls back to site title when empty"
          />
        </SettingsRow>
        <SettingsRow label="Description" htmlFor="seo-description" align="top">
          <textarea
            id="seo-description"
            rows={3}
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            className={`${ROW_INPUT_CLS} resize-none min-h-[56px]`}
            placeholder="A brief description that shows in search results."
          />
        </SettingsRow>
        <SettingsRow label="Canonical URL" htmlFor="seo-canonical">
          <input
            id="seo-canonical"
            type="url"
            value={form.canonical}
            onChange={(e) => update('canonical', e.target.value)}
            className={ROW_INPUT_CLS}
            placeholder="https://example.com/about"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Open Graph (Facebook, LinkedIn, iMessage)">
        <SettingsRow label="OG title" htmlFor="og-title">
          <input
            id="og-title"
            type="text"
            value={form.ogTitle}
            onChange={(e) => update('ogTitle', e.target.value)}
            className={ROW_INPUT_CLS}
            placeholder="Falls back to page title when empty"
          />
        </SettingsRow>
        <SettingsRow label="OG description" htmlFor="og-description" align="top">
          <textarea
            id="og-description"
            rows={3}
            value={form.ogDescription}
            onChange={(e) => update('ogDescription', e.target.value)}
            className={`${ROW_INPUT_CLS} resize-none min-h-[56px]`}
            placeholder="Falls back to page description when empty"
          />
        </SettingsRow>
        <SettingsRow label="OG image" align="top">
          <ImagePickerField
            value={form.ogImage}
            onChange={(url) => { update('ogImage', url); commitImageField('ogImage', url); }}
            hint="1200×630 recommended"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Twitter / X">
        <SettingsRow label="Card type" htmlFor="tw-card">
          <RowSelect
            id="tw-card"
            value={form.twitterCard || 'summary_large_image'}
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'summary_large_image', label: 'Summary with large image' },
            ]}
            onChange={(v) => update('twitterCard', v)}
          />
        </SettingsRow>
        <SettingsRow label="Title" htmlFor="tw-title">
          <input
            id="tw-title"
            type="text"
            value={form.twitterTitle}
            onChange={(e) => update('twitterTitle', e.target.value)}
            className={ROW_INPUT_CLS}
            placeholder="Falls back to OG title / page title"
          />
        </SettingsRow>
        <SettingsRow label="Description" htmlFor="tw-description" align="top">
          <textarea
            id="tw-description"
            rows={3}
            value={form.twitterDescription}
            onChange={(e) => update('twitterDescription', e.target.value)}
            className={`${ROW_INPUT_CLS} resize-none min-h-[56px]`}
            placeholder="Falls back to OG description / page description"
          />
        </SettingsRow>
        <SettingsRow label="Image" align="top">
          <ImagePickerField
            value={form.twitterImage}
            onChange={(url) => { update('twitterImage', url); commitImageField('twitterImage', url); }}
            hint="Falls back to OG image"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Search engines">
        <SettingsRow label="Index this page" align="top" interactive={false}>
          <RobotsToggle
            value={form.robotsIndex}
            onChange={(v) => update('robotsIndex', v)}
            hint="Allow search engines to add this page to their index."
          />
        </SettingsRow>
        <SettingsRow label="Follow links" align="top" interactive={false}>
          <RobotsToggle
            value={form.robotsFollow}
            onChange={(v) => update('robotsFollow', v)}
            hint="Allow crawlers to follow outbound links on this page."
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

// ─── Small UI bits ──────────────────────────────────────────────────────────

/** Click-to-pick image field. Renders a square thumbnail tile —
 *  dashed placeholder when empty, image preview when filled — and
 *  opens the same `ImageSearchModal` the Fill button uses (Unsplash
 *  search, drag-drop upload, AI create). Selecting an image fires
 *  `onChange` with its URL; the trash button on a filled tile clears
 *  the value. */
function ImagePickerField({
  value, onChange, hint,
}: {
  value: string;
  onChange: (url: string) => void;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  // Track whether the current URL actually loads as an image. A stale
  // saved value (e.g. typed gibberish carried over from when this
  // field was a URL text input) would otherwise render as a silent
  // broken-`<img>` placeholder, and the user has no way to tell that
  // their previously-saved URL is invalid. Reset on every value change
  // so a fresh upload gets a clean attempt.
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => { setLoadFailed(false); }, [value]);
  const hasImage = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`group relative w-28 h-28 shrink-0 rounded-lg overflow-hidden flex items-center justify-center cursor-pointer transition-colors ${
            hasImage && !loadFailed
              ? 'border border-[var(--border-light)]'
              : hasImage && loadFailed
                ? 'border border-red-500/40 bg-red-500/5'
                : 'border border-dashed border-[var(--control-border)] hover:border-[var(--text-tertiary)] bg-[var(--bg-hover)]/30'
          }`}
          title={hasImage ? (loadFailed ? 'Saved URL did not load — click to replace' : 'Replace image') : 'Choose image'}
        >
          {hasImage && !loadFailed ? (
            <>
              <img
                src={value}
                alt=""
                className="w-full h-full object-cover"
                onError={() => {
                  trace.action('pages-seo:image-load-failed', { urlLen: value.length, head: value.slice(0, 64) });
                  setLoadFailed(true);
                }}
              />
              {/* Hover overlay — surfaces the "Replace" affordance on the
                  filled state without a permanent label cluttering the tile. */}
              <span className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center text-[11px] font-medium text-white opacity-0 group-hover:opacity-100 transition">
                Replace
              </span>
            </>
          ) : hasImage && loadFailed ? (
            <span className="flex flex-col items-center gap-1 text-red-400 px-2 text-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="m3 3 18 18" />
              </svg>
              <span className="text-[10px] leading-tight">Image didn't load — click to replace</span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-1 text-[var(--text-tertiary)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <span className="text-[10px]">Choose</span>
            </span>
          )}
        </button>
        {hasImage && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="h-7 px-2 text-[10px] font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md cursor-pointer"
            title="Remove image"
          >
            Remove
          </button>
        )}
      </div>
      {hint && (
        <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed">{hint}</p>
      )}
      <ImageSearchModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onSelect={(url) => {
          onChange(url);
          setOpen(false);
        }}
      />
    </div>
  );
}

function RobotsToggle({
  value, onChange, hint,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer ${
          value ? 'bg-[var(--accent)]' : 'bg-[var(--grid-line)] border border-[var(--control-border)]'
        }`}
      >
        <span
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            value ? 'translate-x-[1.125rem]' : 'translate-x-1'
          }`}
        />
      </button>
      <span className="text-[10px] text-[var(--text-tertiary)] leading-relaxed">{hint}</span>
    </div>
  );
}


