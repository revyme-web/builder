// builder-theme.ts — paints a BuilderTheme onto the editor chrome.
//
// Themes the EDITOR UI (`src/styles/globals.css`), NOT the user's website
// tokens in `app/globals.css`. Two unrelated systems that both say "accent".
//
// The accent values go on <html> as INLINE styles, which outrank both the
// `:root` and `.dark` rules in globals.css — so one write covers whichever
// mode is active, with no stylesheet swapping. (globals.aurora / grove / reef
// stay what they always were: whole-file experiments copied over globals.css
// by hand. This is the runtime path.)
//
// `builderThemeAtom` owns the id and its persistence; this module owns the DOM.
// `subscribeBuilderTheme` wires the two together once at boot.

import { getDefaultStore } from 'jotai';
import { builderThemeAtom } from '@/code/stores/user-preferences-store';
import {
  DEFAULT_BUILDER_THEME_ID,
  getBuilderThemeById,
  type BuilderTheme,
} from '@/shared/builder-themes';
import { trace } from '@/shared/debug-trace';

/** The variables we own. The rest of the accent family color-mixes off these. */
const OWNED_VARS = ['--accent', '--accent-fg', '--accent-strong-fg', '--accent-surface'] as const;

let observer: MutationObserver | null = null;

// Component-master files re-skin the whole chrome purple (App.tsx) by writing
// the SAME inline custom properties this module owns. While that's active the
// theme must stand down completely — otherwise picking a theme mid-component
// would overwrite the purple, and the component-mode signal would be lost.
let suspended = false;

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

function currentTheme(): BuilderTheme {
  const id = getDefaultStore().get(builderThemeAtom);
  return getBuilderThemeById(id) ?? getBuilderThemeById(DEFAULT_BUILDER_THEME_ID)!;
}

/** Write (or clear) the accent variables for `theme` in the CURRENT mode. */
function paint(theme: BuilderTheme): void {
  const root = document.documentElement;

  // Default REMOVES the overrides rather than re-asserting them, so the
  // stylesheet's authored values return — including the hand-tuned
  // `--accent-surface` rgba, which no color-mix reproduces exactly.
  if (theme.id === DEFAULT_BUILDER_THEME_ID) {
    for (const v of OWNED_VARS) root.style.removeProperty(v);
    return;
  }

  const c = isDarkMode() ? theme.dark : theme.light;
  root.style.setProperty('--accent', c.accent);
  root.style.setProperty('--accent-fg', c.accentFg);
  root.style.setProperty('--accent-strong-fg', c.accentFg);
  // Hardcoded as an orange rgba in the stylesheet, so it would stay orange
  // under any other accent. Derive it to keep tinted surfaces in family.
  root.style.setProperty('--accent-surface', 'color-mix(in srgb, var(--accent) 12%, transparent)');
}

/** Re-paint the accent for the mode that's now active. No-op while suspended. */
export function applyBuilderTheme(): void {
  if (suspended) return;
  paint(currentTheme());
}

/** Hand the accent variables over to another owner (component-master purple). */
export function suspendBuilderTheme(): void {
  suspended = true;
}

/**
 * Take the accent variables back and repaint.
 *
 * The other owner clears its overrides with `removeProperty`, which wipes OUR
 * inline values too — they live on the same `<html>` style. Without this the
 * chrome fell back to the stylesheet's stock brass on leaving a component, so
 * a user on Monochrome or Green Forest silently got Default back.
 */
export function resumeBuilderTheme(): void {
  suspended = false;
  applyBuilderTheme();
}

/**
 * Wire the atom + the light/dark switch to the DOM. Call once at boot.
 *
 * The MutationObserver watches <html class> instead of hooking BottomToolbar's
 * ThemeSwitcher, so ANY code path that flips `.dark` keeps an inverting theme
 * (Monochrome) correct.
 */
export function subscribeBuilderTheme(): void {
  const store = getDefaultStore();

  applyBuilderTheme();
  store.sub(builderThemeAtom, () => {
    applyBuilderTheme();
    trace.action('builder-theme:changed', { id: store.get(builderThemeAtom) });
  });

  if (observer || typeof MutationObserver === 'undefined') return;
  let wasDark = isDarkMode();
  observer = new MutationObserver(() => {
    const nowDark = isDarkMode();
    if (nowDark === wasDark) return;   // class changed for an unrelated reason
    wasDark = nowDark;
    applyBuilderTheme();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}
