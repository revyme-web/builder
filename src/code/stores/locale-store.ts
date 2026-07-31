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

// Currently active locale in the editor (for preview)
export const activeLocaleAtom = atom<string>('en');

// Is the current locale the default? (derived)
export const isDefaultLocaleAtom = atom(get =>
  get(activeLocaleAtom) === get(i18nConfigAtom).defaultLocale
);

// Current page's locale overrides: Map<nodeId, NodeOverride>
export const localeOverridesAtom = atom<Map<string, NodeOverride>>(new Map());
