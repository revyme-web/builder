// locale-store.ts — Jotai atoms for Localization / i18n state.
// i18nConfigAtom is DERIVED from ProjectFS — auto-updates on version bump (undo/redo).

import { atom } from 'jotai';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import type { I18nConfig, NodeOverride } from '@/shared/types';

// i18n configuration — derived from ProjectFS (reads i18n/config.json)
export const i18nConfigAtom = atom<I18nConfig>((get) => {
  get(projectVersionAtom);
  const raw = projectFS.readFile('i18n/config.json');
  if (!raw) return { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] };
  try { return JSON.parse(raw); } catch { return { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] }; }
});

// Currently active locale in the editor (for preview / translation editing).
//
// The default FOLLOWS THE PROJECT's default locale, never a hardcoded 'en'
// (2026-08-11): the old `atom('en')` initial made every project whose default
// locale isn't English boot straight into "Editing English Translation" mode —
// activeLocale('en') !== defaultLocale('fr') reads as "a translation is being
// edited" before the user touched anything. Modeled as a nullable OVERRIDE on
// top of the config default: null → follow the project default (correct even
// though the config loads AFTER this module initializes, and when the user
// later changes the default), a string → the user explicitly switched this
// session. An override pointing at a locale that was deleted from the config
// also falls back to the default instead of dangling.
const activeLocaleOverrideAtom = atom<string | null>(null);
export const activeLocaleAtom = atom(
  (get) => {
    const cfg = get(i18nConfigAtom);
    const override = get(activeLocaleOverrideAtom);
    return override && cfg.locales.some((l) => l.code === override)
      ? override
      : cfg.defaultLocale;
  },
  (_get, set, next: string) => set(activeLocaleOverrideAtom, next),
);

// Is the current locale the default? (derived)
export const isDefaultLocaleAtom = atom(get =>
  get(activeLocaleAtom) === get(i18nConfigAtom).defaultLocale
);

// Current page's locale overrides: Map<nodeId, NodeOverride>
export const localeOverridesAtom = atom<Map<string, NodeOverride>>(new Map());
