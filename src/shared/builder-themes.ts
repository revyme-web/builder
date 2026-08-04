// builder-themes.ts — accent palettes for the BUILDER's own chrome.
//
// This themes the editor UI (`src/styles/globals.css`), NOT the user's website
// tokens in `app/globals.css`. Those are two unrelated systems that happen to
// both use the word "accent".
//
// Only `--accent` and the foreground that sits ON it need declaring: the rest
// of the family is already derived in globals.css via color-mix —
// `--accent-hover`, `--accent-text`, `--accent-strong`, `--accent-muted` all
// key off `var(--accent)`, so overriding the base cascades to all of them.
// The exceptions are the three values that were hand-set hexes:
// `--accent-fg`, `--accent-strong-fg` and `--accent-surface` (a hardcoded
// orange rgba that would stay orange under a green accent).
//
// Per-mode values exist because Monochrome deliberately inverts. The stock
// palette does NOT change hue between light and dark on purpose — see the
// reasoning in globals.css — so Default and Forest simply repeat themselves.

export interface BuilderThemeColors {
  /** `--accent` — the base every other accent token color-mixes from. */
  accent: string;
  /** `--accent-fg` / `--accent-strong-fg` — the label sitting ON the accent. */
  accentFg: string;
}

export interface BuilderTheme {
  id: string;
  label: string;
  light: BuilderThemeColors;
  dark: BuilderThemeColors;
}

export const BUILDER_THEMES: BuilderTheme[] = [
  {
    // The shipped brass/gold. Selecting this REMOVES the overrides rather than
    // re-asserting them, so the stylesheet's own values (including the tuned
    // `--accent-surface` rgba) come back exactly as authored.
    id: 'default',
    label: 'Default',
    light: { accent: '#cec997', accentFg: '#0d1017' },
    dark: { accent: '#cec997', accentFg: '#0d1017' },
  },
  {
    // Maximum contrast against the chrome in both directions: near-black
    // accent on the light UI, white accent on the dark one.
    id: 'monochrome',
    label: 'Monochrome',
    light: { accent: '#111111', accentFg: '#ffffff' },
    dark: { accent: '#ffffff', accentFg: '#111111' },
  },
  {
    // Deep forest green. Every non-Default palette here is tuned so its
    // WHITE label clears WCAG AA (4.5:1) on the fill — the same bar
    // globals.css sets for the stock accent. The first-pass hues were all
    // ~4.0 and had to come down a step.
    id: 'forest',
    label: 'Green Forest',
    light: { accent: '#297f54', accentFg: '#ffffff' },
    dark: { accent: '#297f54', accentFg: '#ffffff' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    light: { accent: '#2a6fbe', accentFg: '#ffffff' },
    dark: { accent: '#2a6fbe', accentFg: '#ffffff' },
  },
  {
    id: 'ember',
    label: 'Ember',
    light: { accent: '#c04832', accentFg: '#ffffff' },
    dark: { accent: '#c04832', accentFg: '#ffffff' },
  },
  {
    // The pale one: light enough that white labels would wash out, so the
    // foreground goes near-black instead. This is the case the per-theme
    // `accentFg` field exists for.
    id: 'amber',
    label: 'Amber',
    light: { accent: '#e0a83c', accentFg: '#1a1206' },
    dark: { accent: '#e0a83c', accentFg: '#1a1206' },
  },
  {
    id: 'rose',
    label: 'Rose',
    light: { accent: '#ad3f68', accentFg: '#ffffff' },
    dark: { accent: '#ad3f68', accentFg: '#ffffff' },
  },
];

// NOTE: no purple/violet palette on purpose. `--accent-secondary` (#9a66ff)
// is what re-skins the whole chrome inside a component master (App.tsx), and
// a violet theme would make "am I in a component?" unreadable at a glance.

export const DEFAULT_BUILDER_THEME_ID = 'default';

export function getBuilderThemeById(id: string): BuilderTheme | undefined {
  return BUILDER_THEMES.find((t) => t.id === id);
}
