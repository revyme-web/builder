// category-icons.tsx — Sidebar category icons (20x20 colored squares with white inner SVGs).

import React from 'react';

// ─── Shared wrapper: colored square with inner SVG ─────────────────────────

function CategorySquare({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div
      className="w-5 h-5 rounded flex items-center justify-center shrink-0"
      style={{ backgroundColor: bg }}
    >
      {children}
    </div>
  );
}

// ─── Category Icons ────────────────────────────────────────────────────────

/** Amber square with 4 small white squares grid */
function ElementsIcon() {
  return (
    <CategorySquare bg="#F59E0B">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="4" height="4" rx="0.5" fill="white" />
        <rect x="7" y="1" width="4" height="4" rx="0.5" fill="white" />
        <rect x="1" y="7" width="4" height="4" rx="0.5" fill="white" />
        <rect x="7" y="7" width="4" height="4" rx="0.5" fill="white" />
      </svg>
    </CategorySquare>
  );
}

/** Orange square with star */
function CreativeIcon() {
  return (
    <CategorySquare bg="#F97316">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M6 1l1.3 2.8L10.2 4.3 8.1 6.3 8.6 9.2 6 7.8 3.4 9.2 3.9 6.3 1.8 4.3 4.7 3.8Z"
          fill="white"
        />
      </svg>
    </CategorySquare>
  );
}

/** Blue square with 4-square grid */
function IntegrationsIcon() {
  return (
    <CategorySquare bg="#3B82F6">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="4.5" height="4.5" rx="1" fill="white" />
        <rect x="6.5" y="1" width="4.5" height="4.5" rx="1" fill="white" />
        <rect x="1" y="6.5" width="4.5" height="4.5" rx="1" fill="white" />
        <rect x="6.5" y="6.5" width="4.5" height="4.5" rx="1" fill="white" />
      </svg>
    </CategorySquare>
  );
}

/** Green square with star */
function IconsIcon() {
  return (
    <CategorySquare bg="#22C55E">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M6 1.5l1.1 2.4 2.6.4-1.9 1.8.4 2.6L6 7.5l-2.2 1.2.4-2.6L2.3 4.3l2.6-.4Z"
          fill="white"
        />
      </svg>
    </CategorySquare>
  );
}

/** Rose square with gear */
function UtilityIcon() {
  return (
    <CategorySquare bg="#F43F5E">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M5 1h2v1.1a3.5 3.5 0 011 .4l.8-.8 1.4 1.4-.8.8c.2.3.3.6.4 1H11v2H9.9a3.5 3.5 0 01-.4 1l.8.8-1.4 1.4-.8-.8c-.3.2-.6.3-1 .4V11H5V9.9a3.5 3.5 0 01-1-.4l-.8.8-1.4-1.4.8-.8A3.5 3.5 0 012.1 7H1V5h1.1c.1-.4.2-.7.4-1l-.8-.8L3.1 1.8l.8.8c.3-.2.6-.3 1-.4V1z"
          fill="white"
        />
        <circle cx="6" cy="6" r="1.5" fill="#F43F5E" />
      </svg>
    </CategorySquare>
  );
}

// ─── Community Block Icons ─────────────────────────────────────────────────

/** Purple square with grid */
function AllBlocksIcon() {
  return (
    <CategorySquare bg="#8B5CF6">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="3" height="3" rx="0.5" fill="white" />
        <rect x="5" y="1" width="3" height="3" rx="0.5" fill="white" opacity="0.8" />
        <rect x="9" y="1" width="2" height="3" rx="0.5" fill="white" opacity="0.6" />
        <rect x="1" y="5" width="10" height="3" rx="0.5" fill="white" opacity="0.7" />
        <rect x="1" y="9" width="5" height="2" rx="0.5" fill="white" opacity="0.5" />
        <rect x="7" y="9" width="4" height="2" rx="0.5" fill="white" opacity="0.5" />
      </svg>
    </CategorySquare>
  );
}

/** Indigo square with stacked sections */
function SectionsIcon() {
  return (
    <CategorySquare bg="#6366F1">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="3" rx="0.5" fill="white" />
        <rect x="1" y="5" width="10" height="3" rx="0.5" fill="white" opacity="0.7" />
        <rect x="1" y="9" width="10" height="2" rx="0.5" fill="white" opacity="0.4" />
      </svg>
    </CategorySquare>
  );
}

/** Cyan square with menu lines */
function MenusIcon() {
  return (
    <CategorySquare bg="#06B6D4">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="2" y="2.5" width="8" height="1.2" rx="0.5" fill="white" />
        <rect x="2" y="5.4" width="8" height="1.2" rx="0.5" fill="white" />
        <rect x="2" y="8.3" width="8" height="1.2" rx="0.5" fill="white" />
      </svg>
    </CategorySquare>
  );
}

/** Slate square with bottom bar */
function FootersIcon() {
  return (
    <CategorySquare bg="#64748B">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="7" rx="0.5" fill="white" opacity="0.3" />
        <rect x="1" y="9" width="10" height="2" rx="0.5" fill="white" />
      </svg>
    </CategorySquare>
  );
}

/** Violet square with gradient fill */
function BackgroundsIcon() {
  return (
    <CategorySquare bg="#7C3AED">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <defs>
          <linearGradient id="bg-grad" x1="0" y1="0" x2="12" y2="12" gradientUnits="userSpaceOnUse">
            <stop stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="10" height="10" rx="1.5" fill="url(#bg-grad)" />
      </svg>
    </CategorySquare>
  );
}

/** Emerald square with database/cylinder glyph — CMS sidebar entry. */
function CmsCategoryIcon() {
  return (
    <CategorySquare bg="#10B981">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="6" cy="2.5" rx="4.5" ry="1.5" />
        <path d="M10.5 6c0 .83-2 1.5-4.5 1.5S1.5 6.83 1.5 6" />
        <path d="M1.5 2.5v7c0 .83 2 1.5 4.5 1.5s4.5-.67 4.5-1.5v-7" />
      </svg>
    </CategorySquare>
  );
}

/** Teal square with stacked-list glyph — CMS > Collections sidebar row.
 *  Distinct from CmsCategoryIcon (cylinder) so the user can tell at a
 *  glance which CMS row they're on; both sit in the same teal-emerald
 *  family so the section reads as one group. */
function CmsCollectionsIcon() {
  return (
    <CategorySquare bg="#14B8A6">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1.5" y="1.5" width="9" height="2.4" rx="0.6" fill="white" />
        <rect x="1.5" y="4.8" width="9" height="2.4" rx="0.6" fill="white" opacity="0.75" />
        <rect x="1.5" y="8.1" width="9" height="2.4" rx="0.6" fill="white" opacity="0.5" />
      </svg>
    </CategorySquare>
  );
}

/** Slate-emerald square with three text-line glyphs — CMS > Fields
 *  sidebar row. Visually echoes the per-field card icon
 *  (CollectionFieldIcon) so the same affordance reads consistently
 *  in the sidebar AND in the Fields panel grid. */
function CmsFieldsIcon() {
  return (
    <CategorySquare bg="#0EA5A4">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="1.2" strokeLinecap="round">
        <path d="M2 3h8" />
        <path d="M2 6h5.5" />
        <path d="M2 9h7" />
      </svg>
    </CategorySquare>
  );
}

// ─── Creative subcategory icons ────────────────────────────────────────────
// Each one is a small colored square in a palette that hints at the
// subcategory's content — they all read as a family but each is
// distinguishable at a glance in the row list.

/** Purple square with motion lines (scrolling marquee feel). */
function CreativeEffectsIcon() {
  return (
    <CategorySquare bg="#8B5CF6">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="3" width="2.5" height="2" rx="0.4" fill="white" opacity="0.95" />
        <rect x="4.5" y="3" width="2.5" height="2" rx="0.4" fill="white" opacity="0.7" />
        <rect x="8" y="3" width="2.5" height="2" rx="0.4" fill="white" opacity="0.45" />
        <rect x="1" y="7" width="6" height="2" rx="0.4" fill="white" opacity="0.9" />
      </svg>
    </CategorySquare>
  );
}

/** Indigo square with a soft gradient swatch — picks up the Backgrounds vibe. */
function CreativeBackgroundsIcon() {
  return (
    <CategorySquare bg="#6366F1">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <defs>
          <linearGradient id="cbg-grad" x1="0" y1="0" x2="12" y2="12">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0.45" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="10" height="10" rx="1.5" fill="url(#cbg-grad)" />
      </svg>
    </CategorySquare>
  );
}

/** Pink square with stylized "T" glyph — Text Effects. */
function CreativeTextEffectsCategoryIcon() {
  return (
    <CategorySquare bg="#EC4899">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2.5 3.5h7" />
        <path d="M6 3.5v6" />
      </svg>
    </CategorySquare>
  );
}

/** Teal square with a framed box icon — Containers (LensBox / MagnetBox …). */
function CreativeContainersIcon() {
  return (
    <CategorySquare bg="#14B8A6">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="1.2">
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
        <circle cx="6" cy="6" r="2" fill="white" />
      </svg>
    </CategorySquare>
  );
}

/** Cyan square with cursor arrow — Cursors. */
function CreativeCursorsIcon() {
  return (
    <CategorySquare bg="#06B6D4">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="1" strokeLinejoin="round">
        <path d="M3 2 L3 9 L5 7.5 L6.6 10.5 L7.8 10 L6.2 7 L9 7 Z" fill="white" />
      </svg>
    </CategorySquare>
  );
}

// ─── Icon Registry ─────────────────────────────────────────────────────────

export const CATEGORY_ICON_MAP: Record<string, React.FC> = {
  elements: ElementsIcon,
  creative: CreativeIcon,
  integrations: IntegrationsIcon,
  icons: IconsIcon,
  utility: UtilityIcon,
  cms: CmsCategoryIcon,
  cmsCollections: CmsCollectionsIcon,
  cmsFields: CmsFieldsIcon,
  allBlocks: AllBlocksIcon,
  sections: SectionsIcon,
  menus: MenusIcon,
  footers: FootersIcon,
  backgrounds: BackgroundsIcon,
  // Creative subcategories — each Creative row in the sidebar resolves
  // here. Kept separate from `creative` (the old single-row entry, now
  // unused but still registered for back-compat with any out-of-tree refs).
  creativeEffects: CreativeEffectsIcon,
  creativeBackgrounds: CreativeBackgroundsIcon,
  creativeTextEffectsCategory: CreativeTextEffectsCategoryIcon,
  creativeContainers: CreativeContainersIcon,
  creativeCursors: CreativeCursorsIcon,
};
