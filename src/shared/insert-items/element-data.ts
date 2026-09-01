// element-data.ts — Category and element data structures for the Insert overlay.
// Matches the old builder's InsertCategoryOverlay exactly.

import type { FieldDefinition } from '@/shared/types';
import { SECTION_BLUEPRINTS, sectionItemId, type SectionCategory } from '@/shared/sections-library';

export interface InsertItem {
  id: string;
  name: string;
  /** Key into the element-icons map */
  iconKey: string;
  /** CMS field card — drives a type-aware mini "drawing" instead of iconKey. */
  cmsFieldType?: FieldDefinition['type'];
  /** CMS prev/next nav card — drives the pager "drawing". */
  cmsNav?: 'prev' | 'next';
  /** CMS collection card — drives the records-list "drawing". */
  cmsCollection?: boolean;
  /** Optional gradient colors for card background (Creative/Utility items) */
  gradientColors?: string[];
  /** When set, the integration card renders the brand's `SocialIcon` from
   *  `react-social-icons` instead of the bundled `iconKey` SVG. The lib
   *  ships icons for hundreds of networks at the correct brand colors
   *  (Google Maps' multi-color G, Spotify's wordmark green, TikTok's
   *  cyan/red split, etc.). Names match the lib's `network` prop. */
  socialNetwork?: string;
  /** Sections-library card — the drag builds its ToolbarItem from this
   *  blueprint's source (src/canvas/section-insert.ts blueprintToToolbarItem)
   *  instead of the static toolbar catalogue. */
  sectionBlueprintId?: string;
}

interface InsertSection {
  id: string;
  label: string;
  items: InsertItem[];
}

export interface InsertCategory {
  id: string;
  label: string;
  /** Key into the category-icons map */
  iconKey: string;
  /** Number of grid columns in the secondary panel */
  columns: 1 | 2 | 3;
  sections: InsertSection[];
  /** Optional empty-state message rendered in place of the section grids
   *  when the category is conditionally inert (e.g. CMS Fields when the
   *  user isn't on a detail page). The row stays in the sidebar so the
   *  affordance is discoverable; clicking it shows this message instead
   *  of an empty grid. */
  emptyStateMessage?: string;
}


// ─── Elements Category ─────────────────────────────────────────────────────

const BASIC_ITEMS: InsertItem[] = [
  { id: 'frame', name: 'Frame', iconKey: 'frame' },
  { id: 'column', name: 'Column', iconKey: 'column' },
  { id: 'row', name: 'Row', iconKey: 'row' },
  { id: 'image', name: 'Image', iconKey: 'image' },
  { id: 'video', name: 'Video', iconKey: 'video' },
  { id: 'audio', name: 'Audio', iconKey: 'audio' },
  { id: 'button', name: 'Button', iconKey: 'button' },
];

const TYPOGRAPHY_ITEMS: InsertItem[] = [
  { id: 'heading', name: 'Heading', iconKey: 'heading' },
  { id: 'paragraph', name: 'Paragraph', iconKey: 'paragraph' },
  { id: 'text-link', name: 'Text Link', iconKey: 'textLink' },
  { id: 'quote', name: 'Quote', iconKey: 'quote' },
];

const CARD_ITEMS: InsertItem[] = [
  { id: 'card-basic', name: 'Basic', iconKey: 'cardBasic' },
  { id: 'card-horizontal', name: 'Horizontal', iconKey: 'cardHorizontal' },
  { id: 'card-profile', name: 'Profile', iconKey: 'cardProfile' },
  { id: 'card-pricing', name: 'Pricing', iconKey: 'cardPricing' },
  { id: 'card-product', name: 'Product', iconKey: 'cardProduct' },
];

const LAYOUT_ITEMS: InsertItem[] = [
  // Split Top removed — compound recipe (2-row with nested 2-col below)
  // that the user can build in 2 drops from primitives. The rest are
  // atomic shapes that don't decompose as easily.
  { id: 'layout-2row', name: '2 Row', iconKey: 'layout2Row' },
  { id: 'layout-3row', name: '3 Row', iconKey: 'layout3Row' },
  { id: 'layout-2col', name: '2 Col', iconKey: 'layout2Col' },
  { id: 'layout-3col', name: '3 Col', iconKey: 'layout3Col' },
  { id: 'layout-grid', name: 'Grid', iconKey: 'layoutGrid' },
  { id: 'layout-sidebar', name: 'Sidebar', iconKey: 'layoutSidebar' },
  { id: 'layout-header', name: 'Header', iconKey: 'layoutHeader' },
];

const SHAPE_ITEMS: InsertItem[] = [
  { id: 'shape-square', name: 'Square', iconKey: 'shapeSquare' },
  { id: 'shape-circle', name: 'Circle', iconKey: 'shapeCircle' },
  { id: 'shape-triangle', name: 'Triangle', iconKey: 'shapeTriangle' },
  { id: 'shape-star', name: 'Star', iconKey: 'shapeStar' },
  { id: 'shape-hexagon', name: 'Hexagon', iconKey: 'shapeHexagon' },
  { id: 'shape-pentagon', name: 'Pentagon', iconKey: 'shapePentagon' },
];

// ─── Creative Category ─────────────────────────────────────────────────────

// Effects are slot-based code components — they render connected canvas
// nodes as children. `cs-` prefix + entry in
// src/canvas/drag/toolbar-item-config.ts CODE_SNIPPET_TOOLBAR_ITEMS.
//
// Two flavors live here (no separate "Containers" subcategory anymore —
// the distinction wasn't useful at the user-facing level; both are
// "drop a wrapper, drop children inside, the wrapper does something
// visual with them"):
//   - Scrolling / animation containers (Marquee, Carousel, 3D Marquee, …).
//   - Interaction wrappers (LensBox, MagnetBox, PixelatedHover) — same
//     slot model, just driven by cursor instead of time.
const EFFECTS_ITEMS: InsertItem[] = [
  { id: 'cs-carousel', name: 'Carousel', iconKey: 'effectCarousel', gradientColors: ['#3B82F6', '#2563EB'] },
  { id: 'cs-marquee', name: 'Marquee', iconKey: 'effectMarquee', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-ribbonMarquee', name: 'Path Marquee', iconKey: 'effectPathMarquee', gradientColors: ['#A855F7', '#7C3AED'] },
  { id: 'cs-threeDMarquee', name: '3D Marquee', iconKey: 'effectThreeDMarquee', gradientColors: ['#06B6D4', '#0891B2'] },
  { id: 'cs-imageTrail', name: 'Motion Trail', iconKey: 'effectMotionTrail', gradientColors: ['#3B82F6', '#2563EB'] },
  { id: 'cs-horizontalScroll', name: 'Horizontal Scroll', iconKey: 'effectHorizontalScroll', gradientColors: ['#06B6D4', '#3B82F6', '#8B5CF6'] },
  // Ex-Containers — folded in. Same slot semantics, different driver
  // (cursor instead of time/scroll).
  { id: 'cs-lensBox',        name: 'Lens Box',        iconKey: 'effectLensBox',        gradientColors: ['#667EEA', '#764BA2'] },
  { id: 'cs-magnetBox',      name: 'Magnet Box',      iconKey: 'effectMagnetBox',      gradientColors: ['#F59E0B', '#D97706'] },
];

// Text effects: every item that animates TEXT (or a number that reads
// like text). Categorised by what kind of animation runs — the name
// is the visible behaviour, not "Code snippet". Each `creative*`
// iconKey resolves to an animated preview tile in
// `creative-preview-icons.tsx` that mirrors the code component's behaviour at
// panel size — every text effect has its unique preview now.
const TEXT_EFFECTS_ITEMS: InsertItem[] = [
  { id: 'cs-morphingText',  name: 'Morphing Text',  iconKey: 'creativeMorphingText',   gradientColors: ['#F59E0B', '#D97706'] },
  { id: 'cs-wordRotate',    name: 'Word Rotate',    iconKey: 'creativeWordRotate',     gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-spinningText',  name: 'Spinning Text',  iconKey: 'creativeSpinningText',   gradientColors: ['#F59E0B', '#D97706'] },
  { id: 'cs-typingText',    name: 'Typing Text',    iconKey: 'creativeTypingText',     gradientColors: ['#10B981', '#059669'] },
  { id: 'cs-textPressure',  name: 'Text Pressure',  iconKey: 'creativeTextPressure',   gradientColors: ['#A855F7', '#9333EA'] },
  { id: 'cs-hangingCurved', name: 'Hanging Curved', iconKey: 'creativeHangingCurved',  gradientColors: ['#10B981', '#059669'] },
  { id: 'cs-magneticText',  name: 'Magnetic Text',  iconKey: 'creativeMagneticText',   gradientColors: ['#00FFEE', '#06B6D4'] },
  { id: 'cs-rotatingText',  name: 'Rotating 3D',    iconKey: 'creativeRotatingText3D', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-videoText',     name: 'Video Text',     iconKey: 'creativeVideoText',      gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-counter',       name: 'Counter',        iconKey: 'creativeCounter',        gradientColors: ['#10B981', '#059669'] },
  { id: 'cs-glitchText',    name: 'Glitch Text',    iconKey: 'creativeGlitchText',     gradientColors: ['#FF003C', '#00E5FF'] },
];

// Cursors: full-page cursor overlays. Each code component replaces the native
// cursor with a custom interactive overlay.
const CURSORS_ITEMS: InsertItem[] = [
  { id: 'cs-designCursor', name: 'Design Cursor', iconKey: 'effectDesignCursor', gradientColors: ['#3B82F6', '#2563EB'] },
  { id: 'cs-blobCursor',   name: 'Blob Cursor',   iconKey: 'effectBlobCursor',   gradientColors: ['#A855F7', '#5227FF'] },
  { id: 'cs-ribbonCursor', name: 'Ribbon Cursor', iconKey: 'effectRibbonCursor', gradientColors: ['#A855F7', '#5227FF'] },
  { id: 'cs-splashCursor', name: 'Splash Cursor', iconKey: 'effectSplashCursor', gradientColors: ['#F59E0B', '#EC4899'] },
];

// ─── Integrations (Widgets) Category ──────────────────────────────────────

const WIDGET_FORM_ITEMS: InsertItem[] = [
  // Forms — Custom multi-field form + 3rd-party embeds (no individual widgets here;
  // basic Input/Textarea/Select/Checkbox/Radio live in the standard Elements panel).
  { id: 'custom-form', name: 'Custom Form', iconKey: 'customForm', gradientColors: ['#3b82f6', '#1d4ed8'] },
  { id: 'calendly', name: 'Calendly', iconKey: 'calendly', gradientColors: ['#006BFF', '#0052CC'] },
  { id: 'typeform', name: 'Typeform', iconKey: 'typeform', gradientColors: ['#262627', '#1A1A1A'] },
  { id: 'google-forms', name: 'Google Forms', iconKey: 'googleForms', gradientColors: ['#7B4FFF', '#5C3FD6'] },
];

const EMBED_ITEMS: InsertItem[] = [
  { id: 'youtube', name: 'YouTube', iconKey: 'youtube', gradientColors: ['#FF0000', '#CC0000'], socialNetwork: 'youtube' },
  { id: 'vimeo', name: 'Vimeo', iconKey: 'vimeo', gradientColors: ['#1AB7EA', '#0D94C9'], socialNetwork: 'vimeo' },
  { id: 'soundcloud', name: 'SoundCloud', iconKey: 'soundcloud', gradientColors: ['#FF8800', '#FF6600'], socialNetwork: 'soundcloud' },
  { id: 'spotify', name: 'Spotify', iconKey: 'spotify', gradientColors: ['#1DB954', '#1AA34A'], socialNetwork: 'spotify' },
  { id: 'google-maps', name: 'Google Maps', iconKey: 'googleMaps', gradientColors: ['#4285F4', '#34A853'], socialNetwork: 'google' },
];

const SOCIAL_ITEMS: InsertItem[] = [
  { id: 'facebook', name: 'Facebook', iconKey: 'facebook', gradientColors: ['#1877F2', '#0D65D9'], socialNetwork: 'facebook' },
  { id: 'x', name: 'Twitter/X', iconKey: 'twitterX', gradientColors: ['#000000', '#1a1a1a'], socialNetwork: 'x' },
  { id: 'instagram', name: 'Instagram', iconKey: 'instagram', gradientColors: ['#E1306C', '#C13584', '#833AB4'], socialNetwork: 'instagram' },
  { id: 'linkedin', name: 'LinkedIn', iconKey: 'linkedin', gradientColors: ['#0077B5', '#005885'], socialNetwork: 'linkedin' },
  { id: 'pinterest', name: 'Pinterest', iconKey: 'pinterest', gradientColors: ['#E60023', '#C8001A'], socialNetwork: 'pinterest' },
  { id: 'tiktok', name: 'TikTok', iconKey: 'tiktok', gradientColors: ['#000000', '#1a1a1a'], socialNetwork: 'tiktok' },
];

// ─── Utility Category ────────────────────────────────────────────────────

const NOISE_ITEMS: InsertItem[] = [
  { id: 'cs-filmGrain', name: 'Film Grain', iconKey: 'noiseFilmGrain', gradientColors: ['#A78BFA', '#7C3AED'] },
  { id: 'cs-staticNoise', name: 'Static TV', iconKey: 'noiseStatic', gradientColors: ['#A78BFA', '#7C3AED'] },
  { id: 'cs-perlinNoise', name: 'Perlin', iconKey: 'noisePerlin', gradientColors: ['#A78BFA', '#7C3AED'] },
  { id: 'cs-halftone', name: 'Halftone', iconKey: 'noiseHalftone', gradientColors: ['#A78BFA', '#7C3AED'] },
  { id: 'cs-scanlines', name: 'Scanlines', iconKey: 'noiseScanlines', gradientColors: ['#A78BFA', '#7C3AED'] },
  { id: 'cs-chromaticNoise', name: 'Chromatic', iconKey: 'noiseChromatic', gradientColors: ['#A78BFA', '#7C3AED'] },
];

const DIVIDER_ITEMS: InsertItem[] = [
  { id: 'cs-lineDivider', name: 'Line', iconKey: 'dividerLine', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-waveDivider', name: 'Wave', iconKey: 'dividerWave', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-angledDivider', name: 'Angled', iconKey: 'dividerAngled', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-curvedDivider', name: 'Curved', iconKey: 'dividerCurved', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-zigzagDivider', name: 'Zigzag', iconKey: 'dividerZigzag', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-wavyLineDivider', name: 'Wavy Line', iconKey: 'dividerWavyLine', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-arrowDivider', name: 'Arrow', iconKey: 'dividerArrow', gradientColors: ['#EC4899', '#DB2777'] },
  { id: 'cs-stepsDivider', name: 'Steps', iconKey: 'dividerSteps', gradientColors: ['#EC4899', '#DB2777'] },
];

const INTERACTIVE_UTILITY_ITEMS: InsertItem[] = [
  // `cs-` prefix routes through getToolbarItemConfig's code component/divider branch
  // so dragging actually drops the code component file as a JSX tag. See
  // src/canvas/drag/toolbar-item-config.ts CODE_SNIPPET_TOOLBAR_ITEMS.
  { id: 'cs-themeToggle', name: 'Theme Toggle', iconKey: 'effectThemeToggle', gradientColors: ['#F59E0B', '#1F2937'] },
  { id: 'cs-localeSwitcher', name: 'Locale Switcher', iconKey: 'effectLocaleSwitcher', gradientColors: ['#10B981', '#059669'] },
  { id: 'cs-copyButton', name: 'Copy Button', iconKey: 'effectCopyButton', gradientColors: ['#171A16', '#16A34A'] },
];

// Patterns drop as a `<div>` with a CSS background pattern (or an SVG-data
// URL for shapes CSS can't describe ergonomically). No code component — the user can
// re-style backgroundColor / opacity / pattern color from the regular panel.
const PATTERN_ITEMS: InsertItem[] = [
  { id: 'cs-gridPattern', name: 'Grid', iconKey: 'patternGrid', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-dotPattern', name: 'Dots', iconKey: 'patternDots', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-crossPattern', name: 'Crosses', iconKey: 'patternCrosses', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-diagonalPattern', name: 'Diagonal', iconKey: 'patternDiagonal', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-gridMaskPattern', name: 'Grid + Mask', iconKey: 'patternGridMask', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-honeycombPattern', name: 'Honeycomb', iconKey: 'patternHoneycomb', gradientColors: ['#8B5CF6', '#7C3AED'] },
  { id: 'cs-checkerboardPattern', name: 'Checkerboard', iconKey: 'patternCheckerboard', gradientColors: ['#8B5CF6', '#7C3AED'] },
];

// Backgrounds drop a code-component Code component instance. Each tile shows a
// gradient-style preview but the dropped element is a live animated
// canvas with full @controls (colors, speed, amplitude, …) editable in
// the Properties panel. Covers the 2D canvas shaders plus the 3D
// particle-field background.
const BACKGROUND_ITEMS: InsertItem[] = [
  { id: 'cs-shaderWaveLines',      name: 'Wave Lines',      iconKey: 'shaderWaveLines',      gradientColors: ['#0F0F1A', '#FFFFFF'] },
  { id: 'cs-shaderWaveGradient',   name: 'Wave Gradient',   iconKey: 'shaderWaveGradient',   gradientColors: ['#FF3624', '#9EABFF'] },
  { id: 'cs-shaderMeshGradient',   name: 'Mesh Gradient',   iconKey: 'shaderMeshGradient',   gradientColors: ['#FF6B6B', '#4D96FF'] },
  { id: 'cs-shaderPlasma',         name: 'Plasma',          iconKey: 'shaderPlasma',         gradientColors: ['#FF006E', '#3A86FF'] },
  { id: 'cs-shaderLiquidMetal',    name: 'Liquid Metal',    iconKey: 'shaderLiquidMetal',    gradientColors: ['#1A1A2E', '#7B61FF'] },
  { id: 'cs-shaderCaustics',       name: 'Caustics',        iconKey: 'shaderCaustics',       gradientColors: ['#001824', '#7DF9FF'] },
  { id: 'cs-shaderAurora',         name: 'Aurora',          iconKey: 'shaderAurora',         gradientColors: ['#020617', '#A855F7'] },
  { id: 'cs-shaderMatrixRain',     name: 'Matrix Rain',     iconKey: 'shaderMatrixRain',     gradientColors: ['#020617', '#22C55E'] },
  { id: 'cs-shaderWaveDistortion', name: 'Wave Distortion', iconKey: 'shaderWaveDistortion', gradientColors: ['#0F172A', '#06B6D4'] },
  { id: 'cs-neonParticleField',    name: 'Neon Particles',  iconKey: 'effectNeonParticles',  gradientColors: ['#22D3EE', '#A855F7'] },
];

// Shaders — the Paper-grade WebGL2 shader pack (default-code-components with
// vendored paper-design/shaders GLSL). No gradientColors: these cards render
// full-bleed cover images from shader-thumb-map, like the sections library.
// Gem Smoke and Liquid Metal accept an uploaded image (logo → glass/chrome).
const SHADER_LIBRARY_ITEMS: InsertItem[] = [
  { id: 'cs-shaderGemSmoke',      name: 'Gem Smoke',      iconKey: 'shaderMeshGradient' },
  { id: 'cs-shaderLiquidMetal',   name: 'Liquid Metal',   iconKey: 'shaderLiquidMetal' },
  { id: 'cs-shaderMeshGradient',  name: 'Mesh Gradient',  iconKey: 'shaderMeshGradient' },
  { id: 'cs-shaderGrainGradient', name: 'Grain Gradient', iconKey: 'shaderMeshGradient' },
  { id: 'cs-shaderMetaballs',     name: 'Metaballs',      iconKey: 'shaderMeshGradient' },
  { id: 'cs-shaderSmokeRing',     name: 'Smoke Ring',     iconKey: 'shaderMeshGradient' },
];

// ─── Sections library items ────────────────────────────────────────────────

function sectionLibraryItems(category: SectionCategory): InsertItem[] {
  return SECTION_BLUEPRINTS.filter((b) => b.category === category).map((b) => ({
    id: sectionItemId(b.id),
    name: b.name,
    iconKey: 'sectionBlueprint',
    sectionBlueprintId: b.id,
  }));
}

// ─── Categories ────────────────────────────────────────────────────────────

export const CATEGORIES: InsertCategory[] = [
  {
    id: 'elements',
    label: 'Elements',
    iconKey: 'elements',
    columns: 3,
    sections: [
      { id: 'basic', label: 'Basic', items: BASIC_ITEMS },
      { id: 'typography', label: 'Typography', items: TYPOGRAPHY_ITEMS },
      // Cards + Layouts merged — both are pre-arranged structural
      // templates (a wrapper + child frames). Bare layout primitives
      // come FIRST so the user grabs the structural shape they need
      // (2 Row / 3 Col / Grid / Sidebar / Header) before scrolling
      // to the richer Card recipes (Basic / Horizontal / Pricing /
      // Product / etc.) at the bottom of the section.
      { id: 'layouts', label: 'Layouts', items: [...LAYOUT_ITEMS, ...CARD_ITEMS] },
      { id: 'shapes', label: 'Shapes', items: SHAPE_ITEMS },
    ],
  },
  // Sections — the source-level blueprint library (shared/sections-library).
  // Items are generated from the registry so a new blueprint shows up here
  // by being added to SECTION_BLUEPRINTS alone. Cards drag like every other
  // element (blueprintToToolbarItem builds the descriptor tree per drag).
  // TEMPORARILY hidden pre-push (2026-08-30) — uncomment to relaunch; the
  // library, insert path, thumbnails and tests all stay live underneath.
  // {
  //   id: 'sections',
  //   label: 'Sections',
  //   iconKey: 'sections',
  //   columns: 1,
  //   sections: [
  //     { id: 'headers', label: 'Headers', items: sectionLibraryItems('header') },
  //     { id: 'heroes', label: 'Heroes', items: sectionLibraryItems('hero') },
  //   ],
  // },
  // Creative is no longer a single Insert row — it's promoted to its own
  // top-level GROUP (sibling to Insert / CMS / Community Blocks). The five
  // ex-sections (Effects, Backgrounds, Text Effects, Containers, Cursors)
  // each become their own row + secondary panel via `CREATIVE_CATEGORIES`
  // below.
  {
    id: 'integrations',
    label: 'Integrations',
    iconKey: 'integrations',
    columns: 2,
    sections: [
      { id: 'forms', label: 'Forms', items: WIDGET_FORM_ITEMS },
      { id: 'embeds', label: 'Embeds', items: EMBED_ITEMS },
      { id: 'social', label: 'Social', items: SOCIAL_ITEMS },
    ],
  },
  {
    id: 'icons',
    label: 'Icons',
    iconKey: 'icons',
    columns: 3,
    sections: [],
  },
  {
    id: 'utility',
    label: 'Utility',
    iconKey: 'utility',
    columns: 2,
    sections: [
      // Interactive first (theme/locale — most-used), then visual-effect
      // groups in increasing-fidelity order: Noises (overlay grain/static),
      // Patterns (CSS tiles), Dividers (section breaks). Shaders moved to
      // the Creative category.
      { id: 'interactive', label: 'Interactive', items: INTERACTIVE_UTILITY_ITEMS },
      { id: 'noises', label: 'Noises', items: NOISE_ITEMS },
      { id: 'patterns', label: 'Patterns', items: PATTERN_ITEMS },
      { id: 'dividers', label: 'Dividers', items: DIVIDER_ITEMS },
    ],
  },
];

// ─── Creative ──────────────────────────────────────────────────────────────
//
// Each Creative subcategory is now a TOP-LEVEL row in its own sidebar
// group (between Insert and CMS), and each row opens its own secondary
// panel. Implementation-wise that means each one is a full `InsertCategory`
// with a single section — the secondary-panel renderer takes any
// InsertCategory shape, so we don't need a new code path. Item arrays
// are reused as-is from the per-section constants above (`EFFECTS_ITEMS`
// et al.), so the actual cards inside each panel are unchanged.

export const CREATIVE_CATEGORIES: InsertCategory[] = [
  // Shaders leads the group — the flagship pack (thumbnail cards, not
  // gradient tiles). Distinct from Backgrounds: these are the Paper-grade
  // WebGL2 components, two of which turn an uploaded image into glass/chrome.
  {
    id: 'creative-shaders',
    label: 'Shaders',
    iconKey: 'creativeShaders',
    columns: 2,
    sections: [{ id: 'shaders', label: 'Shaders', items: SHADER_LIBRARY_ITEMS }],
  },
  {
    id: 'creative-effects',
    label: 'Effects',
    iconKey: 'creativeEffects',
    columns: 2,
    sections: [{ id: 'effects', label: 'Effects', items: EFFECTS_ITEMS }],
  },
  {
    id: 'creative-backgrounds',
    label: 'Backgrounds',
    iconKey: 'creativeBackgrounds',
    columns: 2,
    sections: [{ id: 'backgrounds', label: 'Backgrounds', items: BACKGROUND_ITEMS }],
  },
  {
    id: 'creative-text-effects',
    label: 'Text Effects',
    iconKey: 'creativeTextEffectsCategory',
    columns: 2,
    sections: [{ id: 'textEffects', label: 'Text Effects', items: TEXT_EFFECTS_ITEMS }],
  },
  {
    id: 'creative-cursors',
    label: 'Cursors',
    iconKey: 'creativeCursors',
    columns: 2,
    sections: [{ id: 'cursors', label: 'Cursors', items: CURSORS_ITEMS }],
  },
];

