// IconSearchResults.tsx — Inline Iconify icon grid rendered under the
// regular search rows in the cmd+K palette's "All" tab.
//
// Mirrors `builder/src/builder/view/search/components/IconSearchResults.tsx`:
//   - Renders an 8-col grid of 48 max icons.
//   - Loading state in the section header.
//   - Click any tile → fetches the SVG content and inserts it as a
//     new canvas-workspace SVG node, then closes the palette.
//
// Insertion model: we use `queueMutation({ type: 'addCanvasNode' })`
// to drop the icon as a floating node on the canvas workspace (no
// parent viewport), same as the toolbar drag's fallback path. Position
// is computed from the current `transformManager` so the icon lands
// near the visible canvas center regardless of pan/zoom. The user
// can then drag it into a viewport like any other element.

import React, { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { useIconSearch, type IconResult } from './useIconSearch';
import { paletteOpenAtom } from '@/code/stores/palette-store';
import { insertNodes, buildSvgClipboardNode } from '@/canvas/insertion-bridge';
import { trace } from '@/shared/debug-trace';

// Some packs ship colour-baked SVGs (logos, multi-color emojis). For
// those, we shouldn't recolor on insertion — they want to keep their
// brand colors. Monochrome packs use `currentColor` and inherit the
// canvas-default text color.
function isColorfulIcon(iconName: string): boolean {
  return (
    iconName.includes('openmoji') ||
    iconName.includes('noto') ||
    iconName.includes('twemoji') ||
    iconName.includes('color') ||
    iconName.includes('colour') ||
    iconName.includes('kameleon') ||
    iconName.includes('stickies') ||
    iconName.includes('flat-color') ||
    iconName.includes('logos') ||
    iconName.includes('vscode-icons') ||
    iconName.includes('emojione') ||
    iconName.includes('fluent-emoji') ||
    iconName.includes('flag')
  );
}

// kebab-case → camelCase for SVG attrs so the inner markup survives the
// trip through the JSX writer. Mirrors `IconPanel.camelCaseSvgAttrs`.
function camelCaseSvgAttrs(html: string): string {
  return html.replace(/([a-z]+(?:-[a-z]+)+)=/gi, (match, attr) => {
    if (attr.includes(':')) return match;
    const camel = attr.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    return `${camel}=`;
  });
}

function normalizeFills(svg: string): string {
  return svg
    .replace(/fill="(#000|#000000|black)"/gi, 'fill="currentColor"')
    .replace(/stroke="(#000|#000000|black)"/gi, 'stroke="currentColor"');
}

interface ParsedSvg { viewBox: string; inner: string; }

async function fetchAndParseSvg(iconName: string): Promise<ParsedSvg | null> {
  try {
    const url = `https://api.iconify.design/${iconName}.svg?width=64&height=64`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const vbMatch = text.match(/viewBox="([^"]+)"/);
    const innerMatch = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
    if (!innerMatch) return null;
    let inner = innerMatch[1].trim();
    inner = inner.replace(/<defs>\s*<style>[^<]*<\/style>\s*<\/defs>/gi, '');
    inner = camelCaseSvgAttrs(inner);
    inner = normalizeFills(inner);
    return { viewBox: vbMatch?.[1] ?? '0 0 24 24', inner };
  } catch {
    return null;
  }
}

async function insertIcon(icon: IconResult): Promise<boolean> {
  const parsed = await fetchAndParseSvg(icon.icon);
  if (!parsed) return false;
  // Route through the centralized insertion bridge so the icon lands
  // wherever the paste rules say (visible center / sibling of selection
  // / inside selected layout). Same code path Ctrl+V uses.
  const clipboard = buildSvgClipboardNode({
    name: icon.name,
    viewBox: parsed.viewBox,
    inner: parsed.inner,
  });
  const ids = insertNodes(clipboard);
  if (ids.length === 0) return false;
  trace.action('palette:icon-insert', { icon: icon.icon, ids });
  return true;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function IconSearchResults({ query }: { query: string }) {
  const { icons, isLoading } = useIconSearch(query);
  const setPaletteOpen = useSetAtom(paletteOpenAtom);
  const [insertingIcon, setInsertingIcon] = useState<string | null>(null);

  // Detect light theme — colorful packs render fine on either bg, but
  // monochrome icons need the inverted filter on light themes so a
  // black-on-white pack stays visible against the bright surface.
  const isLight = useIsLightTheme();

  if (!query || query.trim().length < 2) return null;
  if (!isLoading && icons.length === 0) return null;

  const handleClick = async (icon: IconResult) => {
    if (insertingIcon) return;
    setInsertingIcon(icon.icon);
    try {
      const ok = await insertIcon(icon);
      if (ok) {
        setPaletteOpen(false);
      } else {
        toast.error('Could not load that icon');
      }
    } finally {
      setInsertingIcon(null);
    }
  };

  return (
    <div className="border-t border-[var(--border-light)]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          Icons
        </span>
        {isLoading && <SpinnerIcon className="w-3 h-3 text-[var(--text-tertiary)] animate-spin" />}
      </div>
      {icons.length > 0 && (
        <div className="px-3 pb-3">
          {/* 10-col grid + 20×20 icon glyph — keeps the same per-cell
              padding ratio as the builder but at a smaller cell size,
              so the icon grid feels tighter and you see more options
              at a glance. */}
          <div className="grid grid-cols-10 gap-1">
            {icons.map((icon) => {
              const colorful = isColorfulIcon(icon.icon);
              const filter = colorful
                ? 'none'
                : isLight ? 'invert(0)' : 'invert(0.85) brightness(1.5)';
              return (
                <button
                  key={icon.icon}
                  onClick={() => handleClick(icon)}
                  className="w-full aspect-square flex items-center justify-center bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] cut-corners cut-border border border-[var(--control-border)] transition-colors disabled:opacity-50"
                  disabled={insertingIcon === icon.icon}
                  title={`${icon.name} (${icon.prefix})`}
                >
                  <img
                    src={`https://api.iconify.design/${icon.icon}.svg?width=20&height=20`}
                    alt={icon.name}
                    className="w-5 h-5"
                    style={{ filter }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(false);
  useEffect(() => {
    const probe = () => {
      const c = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();
      const tmp = document.createElement('div');
      tmp.style.color = c;
      document.body.appendChild(tmp);
      const rgb = getComputedStyle(tmp).color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      document.body.removeChild(tmp);
      if (rgb) {
        const [, r, g, b] = rgb.map(Number);
        // text-primary BRIGHT means we're on a DARK theme; invert here
        // means the caller wants `isLight` ↔ surface is light.
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        setIsLight(brightness < 127);
      }
    };
    probe();
    const obs = new MutationObserver(probe);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => obs.disconnect();
  }, []);
  return isLight;
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
