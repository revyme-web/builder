// LinkUrlControl.tsx — URL input with page dropdown for internal links.
// Supports internal pages (from ProjectFS) and external URLs.
// The picker lists each page by its LEAF name (not the full nested
// route); the href value still carries the full route slug.
//
// On a CMS detail page the dropdown gains a "CMS" section listing the
// collection's detail route (`/collection/:slug`). When the link is
// driven by a Slug variable the field shows the route GRAYED OUT (the
// Slug control owns the real href) instead of being hidden.

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ControlLabel } from '../../controls';
import { useHoistMenuItem } from '../../controls/hoist-context';
import { listPageFiles, getPageSlug } from '@/code/project/active-file-store';
import { projectFS } from '@/code/project/project-fs';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { PageDocumentIcon, CmsIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

/** A CMS detail route offered in the dropdown's "CMS" section. */
interface CmsRouteEntry {
  /** The route stored in `href` when picked, e.g. `/blog/[slug]`. */
  slug: string;
  /** The display form, e.g. `/blog/:slug`. */
  label: string;
}

interface LinkUrlControlProps {
  value: string;
  onChange: (href: string) => void;
  /** Per-viewport override on a replica → the "Link To" label goes purple + offers Reset Override. */
  overridden?: boolean;
  onResetOverride?: () => void;
  /** Read-only + grayed — used while a Slug variable owns the href. */
  disabled?: boolean;
  /** Shown in the input instead of `value` (e.g. the `/coll/:slug` route
   *  display when a Slug variable is bound). */
  displayOverride?: string;
  /** CMS detail routes for the "CMS" dropdown section. */
  cmsRoutes?: CmsRouteEntry[];
}

/** Get all page entries with slug + display name */
function getPageEntries(): Array<{ filePath: string; slug: string }> {
  return listPageFiles().map(fp => ({
    filePath: fp,
    slug: getPageSlug(fp),
  }));
}

/** The leaf segment of a route slug — `/blog/my-post` → `my-post`. The
 *  picker shows this so a nested page reads as its own name, not the
 *  whole parent path leading up to it. */
function pageLeafName(slug: string): string {
  const segs = slug.replace(/^\//, '').split('/').filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : '/';
}

/** Get all anchor IDs from a page file */
export function getAnchorsForPage(filePath: string): string[] {
  const code = projectFS.readFile(filePath);
  if (!code) return [];
  const nodes = parseJSXToNodes(code);
  const anchors: string[] = [];
  for (const [, node] of nodes) {
    if (node.attrs?.id) anchors.push(node.attrs.id);
  }
  return anchors;
}

/** `/<collection>/` prefixes for every collection that has a `[slug]` detail
 *  page (e.g. `['/blog/']`). Used to decide whether a link targets a CMS detail
 *  route (→ show the Slug control) vs a plain page. */
export function getCmsDetailRoutePrefixes(): string[] {
  const out: string[] = [];
  for (const fp of listPageFiles()) {
    const m = getPageSlug(fp).match(/^(\/[^/]+\/)\[[^\]]+\]$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** True when `href` targets a CMS detail route — a dynamic `[param]` route
 *  (`/blog/[slug]`) or a literal item link under a detail-route collection
 *  (`/blog/post-1`). Plain pages (`/about`) and empty links return false. */
export function isCmsDetailLink(href: string): boolean {
  if (!href) return false;
  if (/\[[^\]]+\]/.test(href)) return true;
  return getCmsDetailRoutePrefixes().some(p => href.startsWith(p) && href.length > p.length);
}

/** For a CMS detail link, the collection the link TARGETS + its `/coll/` route
 *  prefix: `/blog/[slug]` or `/blog/post-1` → `{ collection: 'blog', prefix: '/blog/' }`.
 *  Null for plain pages / empty / non-detail links. Lets a link picker show the
 *  slugs of the collection the link points AT — not the one the element lives in
 *  (an advisor card linking to `/blog/[slug]` must list BLOG items, not advisors). */
export function cmsDetailLinkTarget(href: string): { collection: string; prefix: string } | null {
  if (!href) return null;
  const dyn = href.match(/^\/([^/]+)\/\[[^\]]+\]$/);
  if (dyn) return { collection: dyn[1], prefix: `/${dyn[1]}/` };
  for (const p of getCmsDetailRoutePrefixes()) {
    if (href.startsWith(p) && href.length > p.length) return { collection: p.slice(1, -1), prefix: p };
  }
  return null;
}

/** Find the file path for a given page slug */
export function slugToPageFile(slug: string): string | null {
  const pages = listPageFiles();
  for (const fp of pages) {
    if (getPageSlug(fp) === slug) return fp;
  }
  return null;
}

/**
 * The value-column input + page/CMS dropdown WITHOUT a label — the reusable
 * core of the "Link To" control. `LinkUrlControl` wraps it with the Link
 * tool's "Link To" label; the component-instance tool wraps it with the
 * variable's own label (prop name + "Link To" sub-label). Extracted so a
 * link-variable on a page instance gets the *exact same* picker as the Link
 * tool instead of a plain text input.
 */
export function LinkUrlField({
  value, onChange, disabled, displayOverride, cmsRoutes,
}: LinkUrlControlProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Draft = the in-progress typed value. We commit it to code only on blur /
  // Enter / page-pick — NOT on every keystroke (each keystroke would queue a
  // code mutation, re-parsing + re-rendering the canvas per letter). null = not
  // editing → show the committed prop value. draftRef mirrors it so the blur
  // and Escape handlers can read the latest value synchronously.
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraftValue = useCallback((v: string | null) => { draftRef.current = v; setDraft(v); }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  // True between the focusing mousedown and its mouseup, so we can preventDefault
  // on that one mouseup — otherwise the click would re-place the caret and clear
  // the select-all we do on focus. Later clicks (already focused) place the caret
  // normally so the user can still position/drag-select inside the value.
  const justFocusedRef = useRef(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The menu is PORTALED to <body> (position: fixed) so it escapes the
  // ToolPopup's clipping/stacking context — inside the popup an `absolute`
  // menu was cut off. Position is measured from the input's rect; it FLIPS
  // ABOVE the input when there isn't room below (so it isn't cut off at the
  // viewport bottom) and caps its height to the available space.
  const [menuPos, setMenuPos] = useState<{ left: number; width: number; placeAbove: boolean; maxHeight: number; top?: number; bottom?: number } | null>(null);
  // Fade-in: mount at opacity 0, flip to 1 next frame so the menu eases in
  // (and so a flip above/below doesn't visibly jump).
  const [menuVisible, setMenuVisible] = useState(false);
  const recalcMenuPos = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    // Right-align the menu to the input's right edge, clamped to the viewport.
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const PAD = 8;
    const EST_H = 300; // search row + max list (~240) + padding
    const spaceBelow = window.innerHeight - r.bottom - PAD;
    const spaceAbove = r.top - PAD;
    const placeAbove = spaceBelow < EST_H && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(EST_H, placeAbove ? spaceAbove : spaceBelow));
    setMenuPos({
      left, width, placeAbove, maxHeight,
      top: placeAbove ? undefined : r.bottom + 4,
      bottom: placeAbove ? window.innerHeight - r.top + 4 : undefined,
    });
  }, []);

  // Drive the fade-in on open (cleared on close so it re-fades next time).
  useEffect(() => {
    if (!isDropdownOpen) { setMenuVisible(false); return; }
    const id = requestAnimationFrame(() => setMenuVisible(true));
    return () => cancelAnimationFrame(id);
  }, [isDropdownOpen]);

  const isExternal = value.startsWith('http://') || value.startsWith('https://') || value.startsWith('mailto:');
  const [pagePart, sectionPart] = isExternal ? [value, ''] : value.split('#');

  // Split the page list: a DYNAMIC route (slug has a `[param]`, e.g.
  // `/blog/[slug]`) is a CMS DETAIL route — surface it in the "CMS" section as
  // its full path (`/blog/:slug`), NOT as an ambiguous `[slug]` leaf in the
  // Pages list (which collection's slug? — the user-reported confusion).
  const { regularPages, autoCmsRoutes } = useMemo(() => {
    const regularPages: Array<{ filePath: string; slug: string }> = [];
    const autoCmsRoutes: CmsRouteEntry[] = [];
    for (const p of getPageEntries()) {
      if (/\[[^\]]+\]/.test(p.slug)) {
        autoCmsRoutes.push({ slug: p.slug, label: p.slug.replace(/\[[^\]]+\]/g, ':slug') });
      } else {
        regularPages.push(p);
      }
    }
    return { regularPages, autoCmsRoutes };
  }, [isDropdownOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge any explicitly-passed cmsRoutes (the current detail page's own route)
  // with the auto-detected detail-route pages, deduped by slug.
  const allCmsRoutes = useMemo(() => {
    const seen = new Set<string>();
    const out: CmsRouteEntry[] = [];
    for (const r of [...(cmsRoutes ?? []), ...autoCmsRoutes]) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      out.push(r);
    }
    return out;
  }, [cmsRoutes, autoCmsRoutes]);

  const f = filter.toLowerCase();
  const filteredPages = useMemo(() => {
    if (!f) return regularPages;
    return regularPages.filter(p => p.slug.toLowerCase().includes(f));
  }, [regularPages, f]);
  const filteredCms = useMemo(() => {
    if (!f) return allCmsRoutes;
    return allCmsRoutes.filter(r => r.label.toLowerCase().includes(f) || r.slug.toLowerCase().includes(f));
  }, [allCmsRoutes, f]);

  useEffect(() => {
    if (!isDropdownOpen) return;
    recalcMenuPos();
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsDropdownOpen(false);
    };
    // Keep the portaled menu glued to the input as the panel/page scrolls.
    // CAPTURE phase: when this field is the Variable modal's default editor, the modal stops pointerdown
    // propagation on its own content (so it doesn't self-close), so a bubble-phase listener never fired → the
    // page-picker dropdown stayed open until the modal closed. Capture runs before the modal's stop.
    document.addEventListener('pointerdown', handleClick, true);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', recalcMenuPos, true);
    window.addEventListener('resize', recalcMenuPos);
    return () => {
      document.removeEventListener('pointerdown', handleClick, true);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', recalcMenuPos, true);
      window.removeEventListener('resize', recalcMenuPos);
    };
  }, [isDropdownOpen, recalcMenuPos]);

  const handleSelectPage = useCallback((slug: string) => {
    trace.action('link-url:select-page', { slug });
    setDraftValue(null); // a pick supersedes any half-typed draft
    onChange(sectionPart ? `${slug}#${sectionPart}` : slug);
    setFilter('');
    setIsDropdownOpen(false);
  }, [onChange, sectionPart, setDraftValue]);

  const handleInputFocus = useCallback(() => {
    setIsDropdownOpen(true);
    setFilter('');
    // Select all so typing immediately replaces the existing link.
    inputRef.current?.select();
  }, []);

  const displayValue = displayOverride ?? (isExternal ? value : pagePart || '');

  trace.fn('LinkUrlField:render', { value, isExternal, pagePart, sectionPart, disabled });

  return (
    <div className="relative flex items-center gap-2 w-full">
      <div className="relative w-full">
        <input
          ref={inputRef}
          type="text"
          value={draft ?? displayValue}
          readOnly={disabled}
          // Type into a local draft; DON'T commit per keystroke.
          onChange={disabled ? undefined : (e) => setDraftValue(e.target.value)}
          onFocus={disabled ? undefined : handleInputFocus}
          onMouseDown={disabled ? undefined : () => { if (document.activeElement !== inputRef.current) justFocusedRef.current = true; }}
          onMouseUp={disabled ? undefined : (e) => { if (justFocusedRef.current) { e.preventDefault(); justFocusedRef.current = false; } }}
          // Commit on blur (click/tab away). draftRef holds the latest value so
          // this reads it synchronously even right after a keystroke.
          onBlur={disabled ? undefined : () => {
            const d = draftRef.current;
            if (d !== null && d !== displayValue) onChange(d);
            setDraftValue(null);
          }}
          onKeyDown={disabled ? undefined : (e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            // Escape discards the draft: clear the ref BEFORE blur so onBlur skips the commit.
            else if (e.key === 'Escape') { setDraftValue(null); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="/page or https://..."
          className={`w-full h-[var(--control-height-sm)] px-2 text-xs border rounded-[var(--radius-lg)] focus:outline-none transition-colors ${
            disabled
              ? 'bg-[var(--control-bg)] border-[var(--control-border)] text-[var(--text-disabled)] cursor-default'
              : 'bg-[var(--control-bg)] border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)]'
          }`}
        />

        {isDropdownOpen && !disabled && menuPos && createPortal(
          <div
            ref={dropdownRef}
            className="bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-md shadow-[var(--shadow-lg)] overflow-hidden flex flex-col transition-opacity duration-150 ease-out"
            style={{
              position: 'fixed', left: menuPos.left, width: menuPos.width, maxHeight: menuPos.maxHeight, zIndex: 100020,
              opacity: menuVisible ? 1 : 0,
              ...(menuPos.placeAbove ? { bottom: menuPos.bottom } : { top: menuPos.top }),
            }}
          >
            <div className="p-1.5 border-b border-[var(--border-light)] shrink-0">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search…"
                className="w-full px-2 py-1.5 text-xs bg-white/[0.1] hover:bg-white/[0.14] focus:bg-white/[0.18] rounded text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {/* CMS detail routes — only present on a CMS detail page. */}
              {filteredCms.length > 0 && (
                <>
                  <div className="px-3 pt-1 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-disabled)]">CMS</div>
                  {filteredCms.map((r) => (
                    <button
                      key={r.slug}
                      onMouseDown={(e) => { e.preventDefault(); handleSelectPage(r.slug); }}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 mx-1 my-0.5 text-xs rounded text-left transition-colors ${
                        pagePart === r.slug
                          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                          : 'text-[var(--text-primary)] hover:bg-white/[0.06]'
                      }`}
                      style={{ width: 'calc(100% - 0.5rem)' }}
                    >
                      <CmsIcon width={12} height={12} />
                      <span className="truncate">{r.label}</span>
                    </button>
                  ))}
                </>
              )}

              {/* Pages */}
              {filteredCms.length > 0 && filteredPages.length > 0 && (
                <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-disabled)]">Pages</div>
              )}
              {filteredPages.length === 0 && filteredCms.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">No matches.</div>
              ) : (
                filteredPages.map((page) => (
                  <button
                    key={page.filePath}
                    onMouseDown={(e) => { e.preventDefault(); handleSelectPage(page.slug); }}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 mx-1 my-0.5 text-xs rounded text-left transition-colors ${
                      pagePart === page.slug
                        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'text-[var(--text-primary)] hover:bg-white/[0.06]'
                    }`}
                    style={{ width: 'calc(100% - 0.5rem)' }}
                  >
                    <PageDocumentIcon size={12} />
                    <span className="truncate">{pageLeafName(page.slug)}</span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

export default function LinkUrlControl(props: LinkUrlControlProps) {
  // Non-plain (chevron → "Create Variable") when LinkTool injects the item
  // inside a component master, so `href` can become a variable.
  const hoistItem = useHoistMenuItem();
  trace.fn('LinkUrlControl:render', { value: props.value, disabled: props.disabled });

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Link To" property="href" plain={!hoistItem} overridden={props.overridden} onResetOverride={props.onResetOverride} />
      <LinkUrlField {...props} />
    </div>
  );
}
