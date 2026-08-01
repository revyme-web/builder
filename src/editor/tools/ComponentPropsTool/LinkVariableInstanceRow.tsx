// ComponentPropsTool/LinkVariableInstanceRow.tsx — lifted verbatim from
// ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import { useMemo, useRef, useState } from 'react';
import { ControlLabel } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import { HoistMenuItemProvider } from '../../controls/hoist-context';
import { LinkUrlField, isCmsDetailLink, cmsDetailLinkTarget } from '../LinkTool/LinkUrlControl';
import LinkSectionControl from '../LinkTool/LinkSectionControl';
import LinkSlugControl, { type CmsNavMode } from '../LinkTool/LinkSlugControl';
import { cmsNavHrefExpr } from '@/code/generation/map-gen';
import { ChainLinkIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

/**
 * Page-level instance editor row for an `href` link variable. Renders a
 * BUTTON (link icon + current page + ×) that opens a "Link" ToolPopup — the
 * same `LinkUrlField` page/CMS picker as the Link tool PLUS the `Section`
 * anchor dropdown, so you can target an anchor on the linked page (the reference
 * "Link → Section"). The combined `page#section` string is written to the
 * instance prop. × clears the value.
 */
export function LinkVariableInstanceRow({
  label, subLabel, propName, value, defaultValue, labelPlain, onChange, cmsBinding, onSetExpr,
}: {
  label: string;
  subLabel: string;
  propName: string;
  value: string;
  defaultValue: string | null;
  labelPlain: boolean;
  onChange: (propName: string, value: string, defaultValue: string | null) => void;
  /** When the instance sits inside a CMS collection list, the link gets the
   *  same "Slug → This Row" control as the Link tool. Null otherwise. */
  cmsBinding: { slug: string; itemVar: string } | null;
  /** Write the prop as a raw JSX expression (the per-row slug template). */
  onSetExpr: (propName: string, expr: string) => void;
}) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // A per-row CMS detail link reads back as a (regex-truncated) template that
  // interpolates the item `_slug` — `linkHref={`/coll/${item._slug}`}`. That's
  // the "This Row" slug binding; a plain URL never interpolates `_slug`.
  const isRowSlug = !!cmsBinding && value.includes('_slug') && value.includes('${');
  // The Slug control only makes sense when the link TARGETS a CMS detail route
  // (a `[slug]` dynamic route, a literal item link, or the row binding). A plain
  // page link (`/about`) or empty link gets no Slug control.
  const isSlugLink = isRowSlug || isCmsDetailLink(value);
  const navMode: CmsNavMode = isRowSlug ? 'row' : 'none';
  // The Slug picker must follow the collection the link TARGETS, not the one
  // the instance lives in. A row binding (`This Row`) is always the instance's
  // own collection; a static detail link (`/blog/[slug]` or `/blog/post-1`)
  // targets whatever collection appears in the href (blog), so list BLOG slugs
  // and write back `/blog/<slug>` — NOT `/advisors/<slug>`.
  const detailTarget = useMemo(() => cmsDetailLinkTarget(value), [value]);
  const slugCollection = isRowSlug
    ? (cmsBinding?.slug ?? '')
    : (detailTarget?.collection ?? cmsBinding?.slug ?? '');
  const routePrefix = isRowSlug
    ? (cmsBinding ? `/${cmsBinding.slug}/` : '')
    : (detailTarget?.prefix ?? (cmsBinding ? `/${cmsBinding.slug}/` : ''));
  // A literal item link (`/coll/<item-slug>`) — read the slug back so the Slug
  // control's autocomplete shows it. A bare `[param]` route (`/blog/[slug]`,
  // no item picked yet) reads as empty so the input shows its placeholder.
  const slugRest = (!isRowSlug && !!routePrefix && value.startsWith(routePrefix))
    ? value.slice(routePrefix.length).split(/[#?]/)[0]
    : '';
  const literalSlug = /^\[[^\]]+\]$/.test(slugRest) ? '' : slugRest;

  const isExternal = value.startsWith('http://') || value.startsWith('https://') || value.startsWith('mailto:');
  const [pagePart, sectionPart] = isExternal ? [value, ''] : value.split('#');
  // Display: a row-slug binding → "This Row"; otherwise just the PAGE name —
  // leaf of the slug (`/blog/post` → `post`, `/` → `Home`). The `#section` is
  // omitted (it lives in the popup's Section dropdown). Empty → placeholder.
  const display = useMemo(() => {
    if (isRowSlug) return 'This Row';
    if (!value) return '';
    if (isExternal) return value;
    return (pagePart || '/').replace(/^\//, '').split('/').filter(Boolean).pop() || 'Home';
  }, [value, isExternal, pagePart, isRowSlug]);

  trace.fn('LinkVariableInstanceRow:render', { propName, value, navMode });

  return (
    <>
      <div className="flex items-center justify-between w-full" ref={btnRef}>
        <ControlLabel label={label} property="" plain={labelPlain} subLabel={subLabel} />
        <div className="flex items-center gap-2 w-full min-w-0">
          <button
            onClick={() => setOpen(true)}
            className="w-full min-w-0 h-8 flex items-center gap-2 pl-1 pr-2 rounded-[var(--radius-lg)] bg-[var(--control-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-xs text-[var(--text-primary)] transition-colors cursor-pointer"
            title={value || 'Add link'}
          >
            {/* Accent swatch ONLY when a link is set; empty "Add link" shows a
                bare muted icon (no filled square), like the other empty rows. */}
            <span
              className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${value ? 'text-[var(--accent-fg)]' : 'text-[var(--text-secondary)]'}`}
              style={value ? { backgroundColor: 'var(--accent)' } : undefined}
            >
              <ChainLinkIcon size={12} />
            </span>
            {display
              ? <span className="truncate flex-1 min-w-0 text-left">{display}</span>
              : <span className="truncate flex-1 min-w-0 text-left text-[var(--text-secondary)]">Add link</span>}
            {value && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onSetExpr(propName, "''"); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onSetExpr(propName, "''"); } }}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm leading-none shrink-0 cursor-pointer"
                title="Clear link"
              >
                ×
              </span>
            )}
          </button>
        </div>
      </div>
      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title="Link" anchorRef={btnRef} width={280}>
        {/* `item={null}` ISOLATES this popup from the prop row's ambient hoist
            menu item — without it the Slug control's chevron inherits the
            linkHref prop's "Set Variable → CMS field" connect, so it shows TWO
            "Set Variable" entries (the slug's + the inherited one). `pl-5` gives
            the Slug ControlLabel's left chevron room so it isn't clipped. */}
        <HoistMenuItemProvider item={null}>
        <div className="flex flex-col gap-2 pl-5">
          {/* "Link" label row — LinkUrlField is label-less, so pair it with a
              ControlLabel matching the Section row's layout below. When the
              link is bound to the row slug, the URL field shows the route
              grayed (`/coll/:slug`) — the Slug control owns the value. */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Link" property="__link-to" plain />
            <LinkUrlField
              value={isRowSlug ? '' : value}
              // Keep "Link To" showing the ROUTE (`/blog/:slug`) while the Slug
              // row owns the picked item — so picking a slug doesn't collapse
              // the link back to a bare item path.
              displayOverride={
                isRowSlug && cmsBinding ? `/${cmsBinding.slug}/:slug`
                : detailTarget ? `${detailTarget.prefix}:slug`
                : undefined
              }
              onChange={(v) => onChange(propName, v, defaultValue)}
            />
          </div>
          {/* CMS Slug — ported from the Link tool. Shown ONLY when the link
              targets a CMS detail route (row binding / `[slug]` route / literal
              item link). "Slug → This Row" links each row to its own detail
              page; a literal slug links every row to one specific item. */}
          {cmsBinding && isSlugLink && (
            <LinkSlugControl
              navMode={navMode}
              literalSlug={literalSlug}
              collection={slugCollection}
              // "This Row" (= each card → its OWN detail page) only makes sense
              // when the link targets the SAME collection the instance lives in.
              // Linking to a different collection (advisors card → /blog/:slug)
              // → 'none' → literal blog-item pick only, no "This Row".
              variantContext={cmsBinding && slugCollection === cmsBinding.slug ? 'row' : 'none'}
              onNavModeChange={(mode) => {
                if (mode === 'row') onSetExpr(propName, cmsNavHrefExpr(cmsBinding.slug, '', 'row', cmsBinding.itemVar));
                else onSetExpr(propName, "''"); // 'none' → blank (Add link), not the master default
              }}
              onLiteralSlugChange={(slug) => onChange(propName, slug ? `${routePrefix}${slug}` : '', defaultValue)}
            />
          )}
          {/* Section/anchor — only appears when the linked page has anchor IDs
              (LinkSectionControl returns null otherwise). Hidden for a row-slug
              binding (no fixed page to anchor into). */}
          {!isExternal && !isRowSlug && (
            <LinkSectionControl
              pageSlug={pagePart || '/'}
              value={sectionPart || ''}
              onChange={(section) => {
                const base = pagePart || '/';
                onChange(propName, section ? `${base}#${section}` : base, defaultValue);
              }}
            />
          )}
        </div>
        </HoistMenuItemProvider>
      </ToolPopup>
    </>
  );
}
