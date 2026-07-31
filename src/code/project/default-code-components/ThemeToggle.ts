// ThemeToggle — Code component template (sun/moon button wired to next-themes).
//
// THIRD-PARTY: the sun and moon glyphs are from Feather Icons by Cole Bemis
// (https://github.com/feathericons/feather), MIT. Attribution is repeated
// inside the template literal so it travels into projects this component is
// inserted into. See also the NOTICE file.
//
// On the canvas: renders the icon. The button click is harmless because
// next-themes is stubbed in the code component runtime (`useTheme` returns a fixed
// `{ theme: 'light', setTheme: noop }`) — the canvas has its own theme
// switcher in the editor chrome.
//
// On the live site: requires the user to wrap their app in
// `<ThemeProvider attribute="class">` from next-themes. The toggle then
// flips `<html class="dark">` and `setTheme` persists the choice in
// localStorage. Pair with `:root` and `:root.dark` token blocks in
// `app/globals.css` so the rest of the page colours follow.

export const THEME_TOGGLE_COMPONENT = `'use client';

// Sun and moon glyphs from Feather Icons
// (https://github.com/feathericons/feather)
// Copyright (c) 2013-2023 Cole Bemis — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Theme Toggle" */
/** @comment "Sun/moon button wired to next-themes. Toggles light↔dark on click." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "size": { "type": "number", "label": "Icon Size", "min": 16, "max": 48, "step": 1, "default": 20 },
  "color": { "type": "color", "label": "Color", "default": "currentColor" },
  "background": { "type": "color", "label": "Background", "default": "transparent" },
  "borderRadius": { "type": "number", "label": "Radius", "min": 0, "max": 32, "step": 1, "default": 8, "unit": "px" }
} */

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { withResponsiveProps } from '@revyme/runtime';

function ThemeToggle({
  size = 20,
  color = 'currentColor',
  background = 'transparent',
  borderRadius = 8,
  ...props
}) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  // Avoid SSR/CSR mismatch — only render the resolved theme after mount.
  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && resolvedTheme === 'dark';
  const handleClick = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <button
      type="button"
      data-id={props['data-id']}
      data-name={props['data-name']}
      onClick={handleClick}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      style={{
        ...props.style,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        background,
        borderRadius,
        border: 'none',
        color,
        cursor: 'pointer',
      }}
    >
      {isDark ? (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

export default withResponsiveProps(ThemeToggle);
`;
