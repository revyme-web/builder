// IconPanel.tsx — Iconify-powered icon browser for the Insert > Icons panel.
//
// Shape ported from the legacy builder's InsertCategoryOverlay/IconPanel:
//   - Top: persistent search input that hits api.iconify.design/search across
//     every collection at once.
//   - When no query is active: grid of curated icon packs, each card showing
//     three preview icons + the pack title and total count.
//   - Click a pack: drill in. Pack view has its own pack-scoped search and
//     a back button.
//   - Drag any icon onto the canvas: drops as `<img src="…iconify SVG…">`.
//
// We deliberately don't bundle iconify locally — fetching SVGs on demand
// keeps the editor lean. Drag uses Revyme's `startToolbarDrag` so the
// drop integrates with DragCoordinator the same way every other insert
// item does.
//
// `getIconFilter` recolors monochrome icons to match the editor's text
// color (white on dark mode, black on light) so the user sees a
// consistent visual; colorful packs (logos, openmoji, flat-color-icons,
// etc.) bypass the filter and render in their native colors.

import { useState, useEffect, useCallback } from 'react';
import { normalizeIconGeometry } from '@/shared/icon-viewbox';
import { decomposeSvgDropToShapes } from '@/canvas/drag/svg-drop-shapes';
import { startToolbarDrag } from '@/canvas/drag/toolbar-drag-bridge';
import { generateNodeId } from '@/shared/id-utils';
import { trace } from '@/shared/debug-trace';

interface IconifyIcon {
  /** Full icon name with prefix, e.g. `material-symbols:home` */
  icon: string;
  /** Local part only, e.g. `home` */
  name: string;
}

interface IconifyCollection {
  prefix: string;
  title: string;
  total: number;
}

/** Curated subset — the full Iconify catalog has ~200 packs which is more
 *  noise than signal for a website builder. These are the ones with the
 *  highest hit rate per category. */
const TARGET_LIBRARIES = [
  'material-symbols',
  'fa6-solid',
  'phosphor',
  'heroicons',
  'tabler',
  'lucide',
  'bi',
  'pixelarticons',
  'pepicons-pop',
  'game-icons',
  'openmoji',
  'flat-color-icons',
  'logos',
];

const COLORFUL_HINTS = [
  'openmoji', 'noto', 'twemoji', 'color', 'colour', 'kameleon',
  'stickies', 'flat-color', 'logos', 'vscode-icons', 'flagpack',
  'cryptocurrency', 'meteocons',
];

function isColorfulIcon(iconName: string): boolean {
  return COLORFUL_HINTS.some(hint => iconName.includes(hint));
}

/** Light/dark detection by sampling `--text-primary`. Recolors monochrome
 *  icons via CSS filter so they read on either theme; colorful packs bypass. */
function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const detect = () => {
      const tp = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();
      const probe = document.createElement('div');
      probe.style.color = tp;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      document.body.removeChild(probe);
      const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m) {
        const [, r, g, b] = m.map(Number);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        // Bright text → dark theme.
        setIsDark(brightness > 127);
      }
    };
    detect();
    const obs = new MutationObserver(detect);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function getIconFilter(isColorful: boolean, isDark: boolean): string {
  if (isColorful) return 'none';
  return isDark
    ? 'brightness(0) saturate(100%) invert(1)'
    : 'brightness(0) saturate(100%)';
}

// ─── SVG content cache + fetch ────────────────────────────────────────────
//
// Drag drops the icon as an inline `<svg>` so the user can edit paths,
// recolor via `fill`, animate child elements, etc. — `<img src="…svg">`
// would lock the icon as a flat resource. We prefetch the SVG markup on
// each cell mount so by the time the user pointerdowns, the content is
// already in cache; the drag starts instantly with no fetch delay.

export interface ParsedSvg {
  viewBox: string;
  inner: string;
}

const svgCache = new Map<string, Promise<ParsedSvg | null>>();
// Sync-readable mirror: pointerdown handlers can't `await`, but they CAN
// peek at this map. `fetchSvg` writes here once the network resolves.
const svgResolved = new Map<string, ParsedSvg | null>();

/** Convert kebab-case SVG attributes to camelCase so the inner markup
 *  survives the trip into JSX source. iconify icons mostly use `fill`,
 *  `d`, `stroke` (already camel), but `fill-rule`, `clip-path`,
 *  `stroke-linecap`, etc. show up in the more elaborate sets. */
function camelCaseSvgAttrs(html: string): string {
  return html.replace(/([a-z]+(?:-[a-z]+)+)=/gi, (match, attr) => {
    // Skip XML namespace attrs (xlink:href). Rare in icons but harmless.
    if (attr.includes(':')) return match;
    const camel = attr.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    return `${camel}=`;
  });
}

/** Dropped icons get a CONCRETE neutral color (#ABABAB), never
 *  `currentColor`: inherited color follows the section's CSS `color`, which
 *  on a dark hero is typically black → the icon dropped invisible (only its
 *  selection box showed — live find 2026-07-24). #ABABAB reads on light AND
 *  dark surfaces, and the user recolors from there.
 *
 *  MONOCHROME packs also remap hard-coded blacks (they're the pack's "ink",
 *  not a design choice). COLORFUL packs keep their palette — black there is
 *  a real color (openmoji outlines, logo marks); only `currentColor` gets
 *  pinned, since a shape file has no CSS color context to inherit from. */
export const ICON_DROP_COLOR = '#ABABAB';
export function normalizeIconColors(svg: string, colorful: boolean): string {
  if (colorful) return svg.replace(/currentColor/g, ICON_DROP_COLOR);
  return svg
    .replace(/fill="(currentColor|#000|#000000|black)"/gi, `fill="${ICON_DROP_COLOR}"`)
    .replace(/stroke="(currentColor|#000|#000000|black)"/gi, `stroke="${ICON_DROP_COLOR}"`);
}

function fetchSvg(iconName: string): Promise<ParsedSvg | null> {
  const cached = svgCache.get(iconName);
  if (cached) return cached;
  const url = `https://api.iconify.design/${iconName}.svg?width=64&height=64`;
  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      // Extract viewBox + inner content from `<svg ...>...</svg>`. The
      // iconify endpoint returns a single root <svg>; we strip it so the
      // user's canvas <svg> wrapper carries the viewBox while the inner
      // children (path/rect/g/...) become the editable contents.
      const viewBoxMatch = text.match(/viewBox="([^"]+)"/);
      const innerMatch = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
      if (!innerMatch) return null;
      let inner = innerMatch[1].trim();
      // Drop `<defs>` blocks containing only style rules — they reference
      // class names that don't survive the cross-tree paste. Keep `<defs>`
      // when it carries gradients/patterns the icon actually uses.
      inner = inner.replace(/<defs>\s*<style>[^<]*<\/style>\s*<\/defs>/gi, '');
      inner = camelCaseSvgAttrs(inner);
      inner = normalizeIconColors(inner, isColorfulIcon(iconName));
      const viewBox = viewBoxMatch?.[1] ?? '0 0 24 24';
      const parsed: ParsedSvg = { viewBox, inner };
      svgResolved.set(iconName, parsed);
      return parsed;
    } catch {
      svgResolved.set(iconName, null);
      return null;
    }
  })();
  svgCache.set(iconName, promise);
  return promise;
}

/** Build the toolbar drag descriptor for an icon. Prefers the inline SVG
 *  shape (`<svg viewBox="…">{paths}</svg>`); falls back to an `<img>` if
 *  the SVG isn't cached yet (rare — prefetch on cell mount usually wins). */
/** Icons drop at this size; the geometry is scaled to match so the wrapper
 *  stays 1:1 with its viewBox. */
const ICON_DROP_SIZE = 48;

export function buildIconDragItem(
  iconName: string,
  parsed: ParsedSvg | null,
): import('@/canvas/drag/toolbar-item-config').ToolbarItem {
  // NOTE: no pre-conversion here. The drop pipeline itself decomposes svg
  // drops into the native shape grammar (normalizeLayoutDescriptor →
  // decomposeSvgDropToShapes): shrink-wrapped wrapper, merged subpaths
  // split, multi-shape icons as nested groups. A converter pass HERE would
  // run the markup through TWO decompositions — the drop landed with all
  // its group children collapsed onto each other (live find 2026-08-12).
  //
  // CAPABILITY probe, not a pack-name gate: colorful packs used to be
  // hard-wired to the <img> fallback on the theory that multi-color icons
  // can't live in the shape dialect. Empirically false — flat-color-icons /
  // logos / openmoji / twemoji are just MULTIPLE flat-fill paths, which the
  // decomposer turns into native groups (verified 2026-08-12: 9 of 10
  // sampled colorful icons decompose; only real defs/gradient complexity
  // bails). So: ask the ACTUAL decomposer. It bails → <img> keeps the icon
  // pixel-perfect; it succeeds → the drop is fully shape-editable. The
  // probe runs the same input the pipeline will see, so they can't
  // disagree; its result is discarded (the pipeline re-decomposes for real).
  if (parsed) {
    const probe = decomposeSvgDropToShapes(
      `<svg viewBox="${parsed.viewBox}">${parsed.inner}</svg>`,
      'probe', iconName, ICON_DROP_SIZE, ICON_DROP_SIZE,
    );
    if (!probe) {
      trace.action('icon-panel:drop-img-fallback', { icon: iconName, reason: 'decompose-bail' });
      parsed = null;
    }
  }
  if (parsed) {
    // Shapes are 1:1 — one viewBox unit == one CSS pixel — because every gesture
    // (resize, shape edit, per-variant geometry) measures in pixels against the
    // wrapper's box. Iconify ships `0 0 24 24`, so dropping at 48px without this
    // leaves the icon at 2× and bounces SHAPE_WRAPPER_NOT_1TO1. Scale the
    // geometry INTO the drop box rather than shrinking the box to the viewBox:
    // the icon still arrives at a usable size. Returns null for markup whose
    // coordinate space this can't safely rescale (own transforms, gradients,
    // masks) — there we keep the source viewBox untouched.
    const oneToOne = normalizeIconGeometry(parsed.viewBox, parsed.inner, ICON_DROP_SIZE);
    return {
      id: 'icon-' + iconName + '-' + generateNodeId('icon'),
      elementType: 'svg',
      defaultStyles: {
        width: `${ICON_DROP_SIZE}px`,
        height: `${ICON_DROP_SIZE}px`,
        // Concrete neutral — see ICON_DROP_COLOR (covers stray currentColor
        // references inside gradients/masks the attr rewrite didn't touch).
        color: ICON_DROP_COLOR,
        display: 'block',
      },
      defaultAttrs: {
        viewBox: oneToOne?.viewBox ?? parsed.viewBox,
        xmlns: 'http://www.w3.org/2000/svg',
      },
      // Inner SVG markup goes verbatim into the JSX source — the renderer
      // sees `hasMixedContent: true` (parser detects inline path/rect
      // children) and applies via innerHTML on canvas. JSX compile
      // succeeds because `<path d=… />` etc. are valid JSX SVG elements.
      textContent: oneToOne?.inner ?? parsed.inner,
      ghostSize: { width: ICON_DROP_SIZE, height: ICON_DROP_SIZE },
    };
  }
  // Fallback: drop as <img> if SVG fetch hasn't resolved yet. The user
  // can swap to an inline icon by re-dragging once the cache fills.
  return {
    id: 'icon-' + iconName + '-' + generateNodeId('icon'),
    elementType: 'img',
    defaultStyles: {
      width: '48px',
      height: '48px',
      objectFit: 'contain',
      display: 'block',
    },
    defaultAttrs: {
      src: `https://api.iconify.design/${iconName}.svg?width=128&height=128`,
      alt: iconName,
    },
    ghostSize: { width: 48, height: 48 },
  };
}

interface IconCellProps {
  iconData: IconifyIcon;
  isDark: boolean;
}

function IconCell({ iconData, isDark }: IconCellProps) {
  const colorful = isColorfulIcon(iconData.icon);
  // Prefetch the SVG content on mount (cached in module scope) so the
  // drag handler has the markup ready when the user pointerdowns —
  // COLORFUL packs included: whether an icon can drop as native shapes is
  // decided by the decomposer probe in buildIconDragItem, not by pack name
  // (most colorful icons are plain flat-fill paths and decompose fine).
  useEffect(() => {
    fetchSvg(iconData.icon);
  }, [iconData.icon]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Sync read from the resolved-mirror cache. Prefetch-on-mount above
    // populates it within ~50–200ms; pointerdown is rarely fast enough
    // to miss it. When we DO miss (initial paint, slow network), drop
    // as `<img>` — still gives the user a working icon on canvas.
    const parsed = svgResolved.get(iconData.icon) ?? null;
    trace.action('icon-panel:drag-start', { icon: iconData.icon, asSvg: !!parsed });
    startToolbarDrag(buildIconDragItem(iconData.icon, parsed), e.nativeEvent);
  }, [iconData.icon]);
  return (
    <div
      onPointerDown={handlePointerDown}
      className="aspect-square flex items-center justify-center bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] rounded-md transition-colors cursor-grab active:cursor-grabbing"
      title={iconData.name}
    >
      <img
        src={`https://api.iconify.design/${iconData.icon}.svg?width=32&height=32`}
        alt={iconData.name}
        className="w-7 h-7"
        loading="lazy"
        style={{ filter: getIconFilter(colorful, isDark) }}
      />
    </div>
  );
}

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}

function SearchBar({ value, onChange, placeholder }: SearchBarProps) {
  return (
    <div className="relative">
      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-2 py-1.5 text-xs bg-[var(--control-bg)] hover:bg-[var(--control-bg-hover)] focus:bg-[var(--control-bg-hover)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
      />
    </div>
  );
}

export function IconPanel() {
  trace.fn('IconPanel:render');

  // Top-level search — hits the global `/search` endpoint across all packs.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<IconifyIcon[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Pack drill-down state.
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [packIcons, setPackIcons] = useState<IconifyIcon[]>([]);
  const [isLoadingPack, setIsLoadingPack] = useState(false);
  const [packSearchQuery, setPackSearchQuery] = useState('');

  const [availableLibraries, setAvailableLibraries] = useState<IconifyCollection[]>([]);
  const [packPreviews, setPackPreviews] = useState<Map<string, string[]>>(new Map());

  const isDark = useIsDarkMode();

  // ─── Load library list + preview icons ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('https://api.iconify.design/collections');
        const collections = await res.json();
        if (cancelled) return;
        const filtered = TARGET_LIBRARIES
          .filter((prefix) => collections[prefix])
          .map((prefix) => ({
            prefix,
            title: collections[prefix].name || collections[prefix].title || prefix,
            total: collections[prefix].total || 0,
          }));
        setAvailableLibraries(filtered);
        // Load 3 preview icons per pack for the gallery cards.
        const previews = new Map<string, string[]>();
        await Promise.all(filtered.map(async (lib) => {
          try {
            const r = await fetch(`https://api.iconify.design/collection?prefix=${lib.prefix}`);
            const data = await r.json();
            let icons: string[] = [];
            if (data.uncategorized?.length) {
              icons = data.uncategorized.slice(0, 3).map((n: string) => `${lib.prefix}:${n}`);
            } else if (data.categories) {
              const first = Object.values(data.categories)[0] as string[] | undefined;
              if (first?.length) icons = first.slice(0, 3).map((n) => `${lib.prefix}:${n}`);
            }
            previews.set(lib.prefix, icons);
          } catch { /* per-pack failures are non-fatal */ }
        }));
        if (!cancelled) setPackPreviews(previews);
      } catch (err) {
        trace.error('icon-panel:libraries-load-failed', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Global search (debounced) ──────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(searchQuery)}&limit=999`);
        const data = await res.json();
        if (cancelled) return;
        const list: IconifyIcon[] = (data.icons || []).map((full: string) => ({
          icon: full,
          name: full.split(':')[1] || full,
        }));
        setSearchResults(list);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [searchQuery]);

  // ─── Pack-scoped icon load ──────────────────────────────────────────────
  useEffect(() => {
    if (!selectedPack) { setPackIcons([]); return; }
    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setIsLoadingPack(true);
      try {
        if (packSearchQuery.trim()) {
          const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(packSearchQuery)}&prefix=${selectedPack}&limit=999`);
          const data = await res.json();
          if (cancelled) return;
          const list: IconifyIcon[] = (data.icons || []).map((full: string) => ({
            icon: full,
            name: full.split(':')[1] || full,
          }));
          setPackIcons(list);
        } else {
          const res = await fetch(`https://api.iconify.design/collection?prefix=${selectedPack}`);
          const data = await res.json();
          if (cancelled) return;
          let names: string[] = [];
          if (data.uncategorized) names.push(...data.uncategorized);
          if (data.categories) {
            for (const list of Object.values(data.categories) as string[][]) names.push(...list);
          }
          // Dedupe — uncategorized + categories can overlap.
          names = [...new Set(names)];
          setPackIcons(names.map((n) => ({ icon: `${selectedPack}:${n}`, name: n })));
        }
      } catch {
        if (!cancelled) setPackIcons([]);
      } finally {
        if (!cancelled) setIsLoadingPack(false);
      }
    }, packSearchQuery ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [selectedPack, packSearchQuery]);

  const hasSearchQuery = searchQuery.trim().length >= 2;

  // ─── Pack view ──────────────────────────────────────────────────────────
  if (selectedPack) {
    const lib = availableLibraries.find((l) => l.prefix === selectedPack);
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-[var(--border-light)] flex items-center gap-2">
          <button
            onClick={() => { setSelectedPack(null); setPackSearchQuery(''); }}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            aria-label="Back to icon packs"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-[var(--text-primary)] truncate">{lib?.title || selectedPack}</div>
            <div className="text-[10px] text-[var(--text-tertiary)]">{packIcons.length.toLocaleString()} icons</div>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-[var(--border-light)]">
          <SearchBar value={packSearchQuery} onChange={setPackSearchQuery} placeholder="Search this pack…" />
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-hide p-3">
          {isLoadingPack ? (
            <div className="flex items-center justify-center py-16 text-xs text-[var(--text-tertiary)]">Loading…</div>
          ) : packIcons.length > 0 ? (
            <div className="grid grid-cols-5 gap-1.5">
              {packIcons.map((d) => <IconCell key={d.icon} iconData={d} isDark={isDark} />)}
            </div>
          ) : (
            <div className="flex items-center justify-center py-16 text-xs text-[var(--text-tertiary)]">
              {packSearchQuery ? 'No icons found' : 'No icons available'}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Main view: search bar + (results | pack gallery) ──────────────────
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[var(--border-light)]">
        <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search all icons…" />
      </div>
      {hasSearchQuery ? (
        <div className="flex-1 overflow-y-auto scrollbar-hide p-3">
          {isSearching ? (
            <div className="flex items-center justify-center py-16 text-xs text-[var(--text-tertiary)]">Searching…</div>
          ) : searchResults.length > 0 ? (
            <div className="grid grid-cols-5 gap-1.5">
              {searchResults.map((d) => <IconCell key={d.icon} iconData={d} isDark={isDark} />)}
            </div>
          ) : (
            <div className="flex items-center justify-center py-16 text-xs text-[var(--text-tertiary)]">No icons found</div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-hide p-3">
          <div className="grid grid-cols-2 gap-2">
            {availableLibraries.map((lib) => {
              const previews = packPreviews.get(lib.prefix) || [];
              return (
                <button
                  key={lib.prefix}
                  onClick={() => setSelectedPack(lib.prefix)}
                  className="group h-[100px] bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] rounded-lg transition-all hover:scale-[1.02] overflow-hidden flex flex-col cursor-pointer border-none"
                >
                  <div className="flex-1 flex items-center justify-center gap-2 p-3">
                    {previews.map((iconName) => (
                      <img
                        key={iconName}
                        src={`https://api.iconify.design/${iconName}.svg?width=24&height=24`}
                        alt=""
                        className="w-6 h-6 flex-shrink-0"
                        style={{ filter: getIconFilter(isColorfulIcon(iconName), isDark) }}
                      />
                    ))}
                  </div>
                  <div className="px-2 pb-2 text-center">
                    <div className="text-[11px] font-medium text-[var(--text-primary)] truncate">{lib.title}</div>
                    <div className="text-[10px] text-[var(--text-tertiary)]">{lib.total.toLocaleString()}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
