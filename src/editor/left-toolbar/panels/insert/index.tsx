// index.tsx — Main InsertOverlay component with sidebar + secondary panel.
// Hover-driven: hovering a sidebar category opens the secondary detail panel.
// Secondary panel is full-height, same width as first sidebar, opens cleanly to the right.

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { CATEGORIES, CREATIVE_CATEGORIES, type InsertCategory, type InsertItem } from '@/shared/insert-items/element-data';
import { CATEGORY_ICON_MAP } from '@/shared/insert-items/category-icons';
import { ELEMENT_ICON_MAP } from '@/shared/insert-items/element-icons';
import { CmsFieldGlyph, CmsNavGlyph, CmsCollectionGlyph } from '@/shared/insert-items/cms-field-glyphs';
import DSidebarRow from '@/design-system/SidebarRow';
import SectionLabel from '@/design-system/SectionLabel';
import { startToolbarDrag } from '@/canvas/drag/toolbar-drag-bridge';
import { getToolbarItemConfig } from '@/canvas/drag/toolbar-item-config';
import { blueprintToToolbarItem } from '@/canvas/section-insert';
import { SECTION_THUMBS } from '@/shared/insert-items/section-thumb-map';
import { SHADER_THUMBS } from '@/shared/insert-items/shader-thumb-map';
import { collectionSchemasAtom } from '@/code/stores/cms-store';
import { cmsPageMetaAtom } from '@/code/stores/cms-page-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';

// ─── Chevron Right ─────────────────────────────────────────────────────────

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ─── Insert Category Row (uses design system SidebarRow + chevron) ─────────

function InsertCategoryRow({ iconKey, label, isActive, onMouseEnter }: {
  iconKey: string; label: string; isActive: boolean; onMouseEnter: () => void;
}) {
  const IconComponent = CATEGORY_ICON_MAP[iconKey];
  return (
    <DSidebarRow
      size="lg"
      icon={IconComponent ? <IconComponent /> : <div className="w-5 h-5 rounded bg-gray-600" />}
      label={label}
      isActive={isActive}
      iconColor="inherit"
      right={<ChevronRight className={`transition-all duration-150 ${isActive ? 'text-[var(--text-primary)] translate-x-0.5' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] group-hover:translate-x-0.5'}`} />}
      onMouseEnter={onMouseEnter}
      style={{ cursor: 'pointer' }}
    />
  );
}

import { IconPanel } from './IconPanel';
import { SocialIcon } from 'react-social-icons/component';
// Side-effect imports: each network's icon registers itself on import.
// Pulling them in here loads the SocialIcon library's brand-correct
// renderings (Google Maps' multi-color G, Spotify's wordmark green,
// TikTok's split cyan/red, etc.) into the runtime registry.
import 'react-social-icons/youtube';
import 'react-social-icons/vimeo';
import 'react-social-icons/soundcloud';
import 'react-social-icons/spotify';
import 'react-social-icons/google';
import 'react-social-icons/facebook';
import 'react-social-icons/x';
import 'react-social-icons/instagram';
import 'react-social-icons/linkedin';
import 'react-social-icons/pinterest';
import 'react-social-icons/tiktok';

// ─── Gradient Card (for Creative/Utility items with gradientColors) ───────

/** Some utility iconKeys (`noiseFilmGrain`, `dividerWave`, `patternGrid`,
 *  `shaderWaveLines`, …) are full-width SVG / CSS previews of the actual
 *  effect — they already render at `w-full h-12` and don't want to be
 *  wrapped in the 44px brand circle the integrations use. This predicate
 *  routes them down the wide-preview branch. */
// `isPreviewIcon` + `hexToRgba` live in icon-style-utils so the
// ToolbarGhost (drag overlay) can use the EXACT same predicate +
// palette helpers — keeps the ghost in sync with the card it was
// dragged from.
import { isPreviewIcon, hexToRgba } from '@/shared/insert-items/icon-style-utils';

/**
 * GradientCard — Insert-panel card for brand/integration items.
 *
 * Matches the legacy builder's InsertCategoryOverlay design:
 *   - Card background: ~8–10% alpha gradient (only a hint of brand color
 *     bleeds through). Faint enough that the dark panel surface dominates.
 *   - Icon: solid-color circle (brand primary) with a white glyph centered.
 *     Element icons (`YouTubeIcon`, `VimeoIcon`, etc.) already ship as
 *     `fill="white"` SVGs, so they read against the brand circle.
 *   - Label: brand-primary color (`gradientColors[0]`), full opacity.
 *
 * Items with a dark-on-dark brand palette (Typeform, X) get a fallback —
 * if the primary is near-black, we use the editor's default text color so
 * the label doesn't disappear into the panel background.
 */
function GradientCard({ item }: { item: InsertItem }) {
  const IconComponent = ELEMENT_ICON_MAP[item.iconKey];
  const colors = item.gradientColors || ['#444', '#333'];
  const accent = colors[0];

  // Card-bg gradient at ~10% alpha — same recipe as the legacy builder
  // (`color + '15'` hex). Just enough to suggest the brand identity.
  const CARD_ALPHA = 0.1;
  const rgbaColors = colors.map((c) => hexToRgba(c, CARD_ALPHA));
  const bgStyle = colors.length >= 2
    ? { background: `linear-gradient(135deg, ${rgbaColors.join(', ')})` }
    : { backgroundColor: rgbaColors[0] };

  // Text + icon-circle color. Detect "near black" / "near white" accents
  // (Typeform = #262627, X = #000000, etc.) and fall back to the editor's
  // primary text color so the label reads against the dark panel bg.
  // Anything bright enough to read on dark gets the brand color.
  const isNeutralAccent = (() => {
    const h = accent.replace('#', '');
    if (h.length !== 6) return false;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const max = Math.max(r, g, b);
    return max < 60 || max > 240; // very dark or very light
  })();
  const labelColor = isNeutralAccent ? 'var(--text-primary)' : accent;

  // Drag wiring — same as GridCard. Without this, integration / brand cards
  // (YouTube, Spotify, Calendly etc.) render visually but pointerdown does
  // nothing, so the user can't drop them onto the canvas.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const config = getToolbarItemConfig(item.id);
    if (!config) return;
    e.preventDefault();
    trace.action('insert-panel:drag-start', { itemId: item.id });
    startToolbarDrag(config, e.nativeEvent);
  }, [item.id]);

  return (
    <div
      onPointerDown={handlePointerDown}
      className="flex flex-col items-center gap-2 p-4 cut-corners cursor-pointer transition-all group hover:scale-[1.03]"
      style={bgStyle}
    >
      {item.socialNetwork ? (
        // Brand-faithful icon via react-social-icons. The lib renders its
        // own colored circle + glyph (Google Maps shows the multi-color G,
        // TikTok shows the split-color logo, etc.), so we don't wrap it in
        // a colored circle of our own — that'd double up backgrounds.
        <div className="w-11 h-11 rounded-full overflow-hidden flex items-center justify-center transition-transform group-hover:scale-105">
          <SocialIcon
            network={item.socialNetwork}
            style={{ width: 44, height: 44 }}
            // Drag handler is on the parent card; the SocialIcon's <a>
            // wrapper would otherwise navigate on click. Stop the link.
            as="div"
          />
        </div>
      ) : isPreviewIcon(item.iconKey) ? (
        // Noises + dividers ship as wide preview SVGs (60×48 / 120×48
        // viewBox with `w-full h-12`). Render them full-width — squeezing
        // into a 44px circle compresses the pattern and loses the
        // pixel-perfect look the legacy builder had.
        <div className="w-full h-14 flex items-center justify-center overflow-hidden cut-corners">
          {IconComponent ? <IconComponent /> : null}
        </div>
      ) : (
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center transition-transform group-hover:scale-105"
          style={{ backgroundColor: accent }}
        >
          {IconComponent ? <IconComponent /> : <div className="w-6 h-6 rounded-full bg-white/20" />}
        </div>
      )}
      <span className="text-[11px] font-semibold text-center" style={{ color: labelColor }}>
        {item.name}
      </span>
    </div>
  );
}

// ─── Grid Card ─────────────────────────────────────────────────────────────

interface GridCardProps {
  item: InsertItem;
}

function GridCard({ item }: GridCardProps) {
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Sections-library cards build their ToolbarItem from the blueprint
    // source (fresh ids per drag); everything else looks up the static
    // catalogue. Either way it's the same native toolbar drag.
    const config = item.sectionBlueprintId
      ? blueprintToToolbarItem(item.sectionBlueprintId)
      : getToolbarItemConfig(item.id);
    if (!config) return; // not a draggable item (code components, cards — V2)
    e.preventDefault();
    trace.action('insert-panel:drag-start', { itemId: item.id });
    startToolbarDrag(config, e.nativeEvent);
  }, [item.id, item.sectionBlueprintId]);

  // Items with gradientColors get a gradient background card
  if (item.gradientColors && item.gradientColors.length > 0) {
    return <GradientCard item={item} />;
  }

  // Shaders-library cards: full-bleed cover render of the actual shader
  // (shader-thumb-map, bundled imports). Checked AFTER gradientColors so
  // the Backgrounds panel's gradient tiles keep their look even where item
  // ids overlap (MeshGradient / LiquidMetal appear in both panels).
  if (SHADER_THUMBS[item.id]) {
    return (
      <div
        data-toolbar-item={item.id}
        onPointerDown={handlePointerDown}
        className="flex flex-col cut-corners bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] cursor-grab transition-all group overflow-hidden"
      >
        <div className="w-full overflow-hidden">
          <img
            src={SHADER_THUMBS[item.id]}
            alt={item.name}
            draggable={false}
            className="w-full block transition-transform duration-300 group-hover:scale-[1.02]"
            style={{ aspectRatio: '16 / 10', objectFit: 'cover' }}
          />
        </div>
        <div className="px-3 py-2.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
            {item.name}
          </span>
        </div>
      </div>
    );
  }

  // Sections-library cards: full-width cover image (marketplace-style
  // mockup rendered from the blueprint source — bundled via
  // section-thumb-map, regenerated by scripts/gen-section-thumbs.mjs when
  // a blueprint changes) with the name below. Same pointer-drag as every
  // other card; the img must not be natively draggable or the browser's
  // image-drag eats the gesture.
  if (item.sectionBlueprintId) {
    return (
      <div
        data-toolbar-item={item.id}
        onPointerDown={handlePointerDown}
        className="flex flex-col cut-corners bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] cursor-grab transition-all group overflow-hidden"
      >
        <div className="w-full overflow-hidden">
          <img
            src={SECTION_THUMBS[item.sectionBlueprintId]}
            alt={item.name}
            draggable={false}
            className="w-full block transition-transform duration-300 group-hover:scale-[1.02]"
            style={{ aspectRatio: '16 / 10', objectFit: 'cover' }}
          />
        </div>
        <div className="px-3 py-2.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
            {item.name}
          </span>
        </div>
      </div>
    );
  }

  const IconComponent = ELEMENT_ICON_MAP[item.iconKey];

  // CMS cards render a type-aware mini "drawing" instead of a flat icon —
  // a paragraph for body text, a calendar for a date, a chain for a link…
  let cmsGlyph: React.ReactNode = null;
  if (item.cmsNav) cmsGlyph = <CmsNavGlyph dir={item.cmsNav} />;
  else if (item.cmsFieldType) cmsGlyph = <CmsFieldGlyph type={item.cmsFieldType} />;
  else if (item.cmsCollection) cmsGlyph = <CmsCollectionGlyph />;

  return (
    <div
      data-toolbar-item={item.id}
      onPointerDown={handlePointerDown}
      // Theme-mirrored subtle fill so each element reads as a distinct
      // tile in both modes — `bg-white/[0.06]` only lifted off the dark
      // panel; on the light panel it was invisible.
      className="flex flex-col items-center gap-1.5 p-2.5 cut-corners bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] cursor-pointer transition-all group"
    >
      {/* Icon box fills the card width so it scales down with the grid
          column instead of overflowing a narrow panel. */}
      <div className="w-full h-14 flex items-center justify-center">
        {cmsGlyph ?? (IconComponent ? <IconComponent /> : <div className="w-8 h-8 rounded bg-white/10" />)}
      </div>
      <span className="text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] font-medium text-center">
        {item.name}
      </span>
    </div>
  );
}

// ─── Secondary Panel Content ──────────────────────────────────────────────

interface SecondaryPanelContentProps {
  category: InsertCategory;
}

function SecondaryPanelContent({ category }: SecondaryPanelContentProps) {
  trace.fn('InsertOverlay:SecondaryPanelContent.render', { category: category.id });

  // Lets the "Create Collection" empty-state button switch the sidebar
  // from Insert → CMS so the user lands in the panel where they can
  // actually create one. Hook called unconditionally (rules-of-hooks)
  // even though only the cms-collections empty path uses it.
  const setLeftPanel = useSetAtom(leftPanelAtom);

  // Icons category: render the Iconify-powered browser instead of the
  // standard sections grid. This category has no static items — content
  // is fetched live from api.iconify.design and dragged onto the canvas
  // as <img> elements pointing at the SVG endpoint.
  if (category.id === 'icons') {
    return <IconPanel />;
  }

  // Conditionally inert categories (e.g. CMS Fields off a detail page)
  // carry an `emptyStateMessage` — the row stays visible in the sidebar
  // for discoverability, and hovering opens this hint instead of an
  // empty grid.
  if (category.emptyStateMessage) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <span className="text-xs text-[var(--text-tertiary)] leading-relaxed max-w-[220px]">
          {category.emptyStateMessage}
        </span>
      </div>
    );
  }

  if (category.sections.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <span className="text-xs text-[var(--text-tertiary)]">Coming soon</span>
      </div>
    );
  }

  // Friendly empty-state for the CMS Collections category before the
  // user has created any collections. Shown instead of a blank
  // "Collections" grid. The "Create Collection" button jumps the user
  // straight to the CMS panel (via `leftPanelAtom`) — saves them the
  // sidebar-navigation step they'd otherwise have to do.
  const totalItems = category.sections.reduce((n, s) => n + s.items.length, 0);
  if (category.id === 'cms-collections' && totalItems === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="text-xs font-medium text-[var(--text-secondary)]">No collections yet</span>
        <span className="text-[10px] text-[var(--text-disabled)] max-w-[220px] leading-relaxed">
          Create a collection to start binding cards, lists, and pages to dynamic content.
        </span>
        <button
          type="button"
          onClick={() => {
            trace.action('insert-panel:empty-collections:open-cms');
            setLeftPanel('cms');
          }}
          className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 cut-corners text-[11px] font-semibold cursor-pointer transition-colors"
          style={{
            backgroundColor: 'var(--accent)',
            color: 'var(--accent-fg)',
            border: 'none',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create Collection
        </button>
      </div>
    );
  }

  const gridCols =
    category.columns === 1 ? 'grid-cols-1'
    : category.columns === 3 ? 'grid-cols-3'
    : 'grid-cols-2';

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5 scrollbar-hide">
      {category.sections.map(section => (
        <div key={section.id}>
          {/* Section labels render in Title Case (e.g. "Forms") — no
              uppercase/letter-spacing transforms. The category-level
              header is intentionally absent so the panel opens straight
              into content (matches the reference the reference/legacy builder). */}
          <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] mb-2.5 px-1">
            {section.label}
          </h3>
          <div className={`grid ${gridCols} ${category.columns === 1 ? 'gap-3' : 'gap-1.5'}`}>
            {section.items.map(item => (
              <GridCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main InsertOverlay ────────────────────────────────────────────────────

/** Width of the first sidebar panel (set by LeftPanel.tsx). */
const SIDEBAR_WIDTH = 256;
/** Width of the secondary detail panel. */
const SECONDARY_WIDTH = 270;
/** Left menu icon strip width. */
const MENU_WIDTH = 52;
/** Top toolbar height. */
const TOP_BAR = 52;

export default function InsertOverlay() {
  trace.fn('InsertOverlay.render');

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search ──────────────────────────────────────────────────────────────
  // Two layers: the raw input value (re-renders on every keystroke for
  // controlled-input UX) and a debounced version that drives the actual
  // result computation. 150ms is the sweet spot for type-and-see — fast
  // enough that results feel live, slow enough that we don't re-filter
  // on each individual key while typing a longer word.
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const searchActive = debouncedQuery.trim().length > 0;

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setActiveCategory(null);
      trace.action('insert-overlay:close-secondary');
    }, 200);
  }, [cancelClose]);

  const handleCategoryHover = useCallback((categoryId: string) => {
    cancelClose();
    setActiveCategory(categoryId);
    // Note: search text is INTENTIONALLY left alone here. The portal
    // priority below routes `activeCategory` ahead of `searchActive`,
    // so hovering a category swaps the panel display without nuking
    // the input. Mouse-out of the category (`scheduleClose` → null
    // activeCategory) falls back to the SearchResultsPanel if the
    // input still has text — the user can keep their query around as
    // a tab they can flip back to by un-hovering.
    trace.action('insert-overlay:hover-category', { categoryId });
  }, [cancelClose]);

  // CMS lives in its OWN top-level group ("CMS") between Insert and
  // Community Blocks — see the JSX below. It exposes two sibling
  // categories so each one opens its own secondary panel:
  //
  //   - cms-collections : one card per collection in the user's CMS
  //     (cms/*.schema.json). Drag drops a list bound to that collection
  //     (`cms:<slug>` toolbar id, resolved by toolbar-item-config).
  //
  //   - cms-fields : one card per field across all collections,
  //     prefixed with the collection name so duplicates (e.g. multiple
  //     `title` fields) stay disambiguated. Drag drops a type-aware
  //     placeholder (`<img>` for image, `<a>` for link, swatch `<div>`
  //     for color, `<p>` text otherwise) carrying a binding hint that
  //     auto-rewires when the drop lands inside a `.map(…)`.
  //
  // Empty when the user has no collections — the rows still render but
  // the secondary panel has no cards.
  const cmsSchemas = useAtomValue(collectionSchemasAtom);

  const cmsCollectionsCategory = useMemo<InsertCategory>(() => {
    const items: InsertItem[] = Array.from(cmsSchemas.entries()).map(([slug, schema]) => ({
      id: `cms:${slug}`,
      name: schema.name || slug,
      iconKey: 'collection',
      cmsCollection: true,
    }));
    return {
      id: 'cms-collections',
      label: 'Collections',
      iconKey: 'cmsCollections',
      columns: 1,
      sections: [{ id: 'collections', label: 'Collections', items }],
    };
  }, [cmsSchemas]);

  // Fields are scoped to the active detail page's collection. The row
  // is ALWAYS visible in the CMS group (so the affordance is
  // discoverable), but when the active file isn't a detail page the
  // secondary panel renders an empty-state message instead of cards —
  // there's no binding target outside a CMS context, so we explain
  // rather than silently show nothing.
  const cmsPageMeta = useAtomValue(cmsPageMetaAtom);
  const cmsFieldsCategory = useMemo<InsertCategory>(() => {
    if (cmsPageMeta?.kind !== 'detail') {
      return {
        id: 'cms-fields',
        label: 'Fields',
        iconKey: 'cmsFields',
        columns: 1,
        sections: [],
        emptyStateMessage: 'Fields available only on detail pages.',
      };
    }
    const schema = cmsSchemas.get(cmsPageMeta.collection);
    if (!schema) {
      return {
        id: 'cms-fields',
        label: 'Fields',
        iconKey: 'cmsFields',
        columns: 1,
        sections: [],
        emptyStateMessage: `No schema found for collection "${cmsPageMeta.collection}".`,
      };
    }
    const items: InsertItem[] = (schema.fields ?? []).map(f => ({
      id: `cmsField:${cmsPageMeta.collection}:${f.id}`,
      name: f.name,
      iconKey: 'collectionField',
      cmsFieldType: f.type,
    }));
    // Prev/Next nav links — drop an <a> that navigates to the adjacent
    // item's detail page (resolved from the collection order).
    items.push(
      {
        id: `cmsFieldNav:${cmsPageMeta.collection}:prev`,
        name: '← Previous',
        iconKey: 'collectionField',
        cmsNav: 'prev',
      },
      {
        id: `cmsFieldNav:${cmsPageMeta.collection}:next`,
        name: 'Next →',
        iconKey: 'collectionField',
        cmsNav: 'next',
      },
    );
    return {
      id: 'cms-fields',
      label: 'Fields',
      iconKey: 'cmsFields',
      columns: 1,
      sections: [{ id: 'fields', label: 'Fields', items }],
    };
  }, [cmsSchemas, cmsPageMeta]);

  const cmsCategories = useMemo(() => [cmsCollectionsCategory, cmsFieldsCategory], [cmsCollectionsCategory, cmsFieldsCategory]);

  // ── Search results ─────────────────────────────────────────────────────
  // Walks every InsertItem across Insert + Creative + CMS categories and
  // filters by case-insensitive substring. The match target is BOTH
  // the item's own name AND its parent section label / category label —
  // so typing "divi" surfaces every item under the "Dividers" section
  // (without forcing each divider's `name` to contain "divider"), and
  // typing "card" pulls every card across the Layouts section.
  //
  // Match priority: when a SECTION label matches, the entire section's
  // items are included as if the user clicked into that section.
  // When the parent CATEGORY label matches, every item in every section
  // of that category is included (e.g. "Effects" → all effects).
  // Per-item name matches always win on a one-by-one basis.
  //
  // Memoised on `debouncedQuery` (not raw input) + `cmsCategories` (CMS
  // schemas can change while the panel is open). Empty array when no
  // query — cheap short-circuit before walking the tree.
  const searchResults = useMemo(() => {
    if (!searchActive) return [];
    const q = debouncedQuery.trim().toLowerCase();
    const all = [...CATEGORIES, ...CREATIVE_CATEGORIES, ...cmsCategories];
    const groups: Array<{ id: string; label: string; items: InsertItem[] }> = [];
    for (const cat of all) {
      const categoryMatches = cat.label.toLowerCase().includes(q);
      const matched: InsertItem[] = [];
      // Dedup by item.id within this category — when both the section
      // label and a leaf name match, we don't want the item appearing
      // twice in the same group.
      const seen = new Set<string>();
      for (const section of cat.sections) {
        const sectionMatches = section.label.toLowerCase().includes(q);
        for (const item of section.items) {
          if (
            categoryMatches ||
            sectionMatches ||
            item.name.toLowerCase().includes(q)
          ) {
            if (!seen.has(item.id)) {
              matched.push(item);
              seen.add(item.id);
            }
          }
        }
      }
      if (matched.length > 0) groups.push({ id: cat.id, label: cat.label, items: matched });
    }
    return groups;
  }, [searchActive, debouncedQuery, cmsCategories]);

  // CATEGORIES is the Insert group — CMS / Creative no longer live there.
  // The secondary-panel lookup must search Insert + Creative + CMS
  // categories so hovering any of those rows opens the right detail panel.
  const renderedCategories = CATEGORIES;
  const activeCategoryData = activeCategory
    ? [...renderedCategories, ...CREATIVE_CATEGORIES, ...cmsCategories].find(c => c.id === activeCategory) ?? null
    : null;

  // Sidebar category rows — the Insert / CMS / Creative groups below render
  // the exact same row markup, so they share this one helper.
  const renderCategoryRows = (cats: InsertCategory[]) => cats.map(cat => (
    <InsertCategoryRow
      key={cat.id}
      iconKey={cat.iconKey}
      label={cat.label}
      isActive={activeCategory === cat.id}
      onMouseEnter={() => handleCategoryHover(cat.id)}
    />
  ));

  return (
    <div
      className="flex flex-col h-full overflow-y-auto"
      onMouseLeave={scheduleClose}
      onMouseEnter={cancelClose}
    >
      {/* Sidebar -- fills the 256px panel */}
      <div className="flex flex-col flex-1">
        {/* Search input — typing here filters EVERY InsertItem across
            Insert + Creative + CMS categories and opens a results panel
            to the right of the sidebar (same slot the hover-based
            category panel uses, just with search results instead).
            Theme-mirrored bg / hover / focus tints match the
            PageSelector search styling so the two read as the same
            tier of input. ESC clears + closes. */}
        {/* `pt-[12px]` matches the rail's top padding so the input sits on the
            same line as the Vibe icon beside it. */}
        <div className="px-2 pb-2 pt-[12px]">
          <div className="relative">
            <svg
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const v = e.target.value;
                setSearchQuery(v);
                // The user typing means search becomes the focus —
                // drop any hover-opened active category so its sidebar
                // row stops looking selected behind the search panel.
                // Going back to category browsing is just a hover away
                // (see `handleCategoryHover` which also clears the
                // search reciprocally).
                if (v.length > 0 && activeCategory !== null) {
                  setActiveCategory(null);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  setDebouncedQuery('');
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              onFocus={cancelClose}
              placeholder="Search elements…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] focus:bg-black/[0.12] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:focus:bg-white/[0.18] cut-corners text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors"
            />
          </div>
        </div>

        <SectionLabel size="md">Insert</SectionLabel>

        {/* Main categories */}
        <div className="px-2">
          {renderCategoryRows(renderedCategories)}
        </div>

        {/* Divider */}
        <div className="mx-3 my-1.5 border-t border-[var(--border-light)]" />

        {/* CMS — its own top-level group, sibling to Insert and Creative.
            Surfaces Collections + Fields as two separate rows so each
            opens its own secondary panel. */}
        <SectionLabel size="xs">CMS</SectionLabel>
        <div className="px-2">
          {renderCategoryRows(cmsCategories)}
        </div>

        {/* Divider */}
        <div className="mx-3 my-1.5 border-t border-[var(--border-light)]" />

        {/* Creative — promoted from a single Insert row into its OWN
            top-level group. Each of the five ex-sections (Effects /
            Backgrounds / Text Effects / Containers / Cursors) is a
            sibling row that opens its own secondary panel. Categories
            defined in `CREATIVE_CATEGORIES`. */}
        <SectionLabel size="xs">CREATIVE</SectionLabel>
        <div className="px-2 pb-2">
          {renderCategoryRows(CREATIVE_CATEGORIES)}
        </div>
      </div>

      {/* Secondary panel — full-height sidebar via portal, adjacent to the first.
          The category title (Utility / Integrations / Elements …) is NOT
          rendered up top; the active item in the primary sidebar is the
          source of truth for which category is open, and a header here
          just duplicated that affordance. Content opens directly. */}
      {/* Secondary panel — hover-based category wins over search when
          BOTH are active, so the user can pick a specific category from
          the sidebar without losing their search text. Mouse-out of the
          category clears `activeCategoryData` and the panel falls back
          to the SearchResultsPanel automatically (if there's still
          query text). Either state on its own works as expected:
          search-only when nothing is hovered, hover-only when search
          is empty. Clearing both → portal closes. */}
      {(activeCategoryData || searchActive) && createPortal(
        <div
          data-editor-panel="left-secondary"
          // z-[9999] is one above the bottom toolbar (z-[9998] in
          // editor/BottomToolbar.tsx). The old z-[5000] meant the
          // toolbar floated over the bottom edge of the secondary panel
          // — annoying when scanning shape / layout tiles that sit low
          // in the panel. Now the secondary sidebar covers the toolbar
          // along its full height while open.
          className="fixed z-[9999] bg-[var(--bg-surface)] border-r border-[var(--border-light)] flex flex-col shadow-2xl"
          style={{
            left: MENU_WIDTH + SIDEBAR_WIDTH,
            top: 0,
            width: SECONDARY_WIDTH,
            height: '100vh',
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {activeCategoryData ? (
            <SecondaryPanelContent category={activeCategoryData} />
          ) : (
            <SearchResultsPanel
              query={debouncedQuery}
              groups={searchResults}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Search Results Panel ──────────────────────────────────────────────────
//
// Render every matching InsertItem in a 2-column grid, grouped by source
// category (so "Frame" from Insert > Basic reads differently from
// "Frame" anywhere else, and grouping makes scanning easier). Auto-scrolls
// when results exceed the panel height; the panel itself stays at full
// height so the grid expands organically as the user types more.
// Empty result set shows a friendly "no matches" hint instead of a
// blank panel.

interface SearchResultsPanelProps {
  query: string;
  groups: Array<{ id: string; label: string; items: InsertItem[] }>;
}

function SearchResultsPanel({ query, groups }: SearchResultsPanelProps) {
  trace.fn('InsertOverlay:SearchResultsPanel.render', {
    query, groupCount: groups.length,
    matchCount: groups.reduce((n, g) => n + g.items.length, 0),
  });

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          No matches for &ldquo;{query.trim()}&rdquo;
        </span>
        <span className="text-[10px] text-[var(--text-disabled)] max-w-[220px] leading-relaxed">
          Try a different keyword, or clear the search to browse all
          elements by category.
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5 scrollbar-hide">
      {groups.map(group => (
        <div key={group.id}>
          <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] mb-2.5 px-1">
            {group.label}
            <span className="ml-1.5 font-normal text-[var(--text-disabled)]">
              · {group.items.length}
            </span>
          </h3>
          <div className="grid grid-cols-2 gap-1.5">
            {group.items.map(item => (
              <GridCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
