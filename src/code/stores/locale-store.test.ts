// locale-store.test.ts — the active locale follows the PROJECT default.
//
// Bug (2026-08-11): `activeLocaleAtom` initialized to a hardcoded 'en'. A
// project whose default locale is French booted with activeLocale 'en' !==
// defaultLocale 'fr' → `isDefaultLocaleAtom` false → the editor opened in
// "Editing English Translation" mode before the user touched anything.

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import { activeLocaleAtom, isDefaultLocaleAtom } from './locale-store';

const CONFIG_FR_DEFAULT = JSON.stringify({
  defaultLocale: 'fr',
  locales: [{ code: 'fr', label: 'Français' }, { code: 'en', label: 'English' }],
});

beforeEach(() => {
  projectFS.writeFile('i18n/config.json', CONFIG_FR_DEFAULT);
});

describe('activeLocaleAtom follows the project default', () => {
  it("boots on the PROJECT default (fr), not 'en' — no translation mode on load", () => {
    const store = createStore();
    store.set(projectVersionAtom, (v: number) => v + 1);
    expect(store.get(activeLocaleAtom)).toBe('fr');
    expect(store.get(isDefaultLocaleAtom)).toBe(true);
  });

  it('an explicit switch overrides, and switching back to the default is default mode again', () => {
    const store = createStore();
    store.set(activeLocaleAtom, 'en');
    expect(store.get(activeLocaleAtom)).toBe('en');
    expect(store.get(isDefaultLocaleAtom)).toBe(false);
    store.set(activeLocaleAtom, 'fr');
    expect(store.get(isDefaultLocaleAtom)).toBe(true);
  });

  it('a dangling override (locale deleted from the config) falls back to the default', () => {
    const store = createStore();
    store.set(activeLocaleAtom, 'en');
    projectFS.writeFile('i18n/config.json', JSON.stringify({
      defaultLocale: 'fr', locales: [{ code: 'fr', label: 'Français' }],
    }));
    store.set(projectVersionAtom, (v: number) => v + 1);
    expect(store.get(activeLocaleAtom)).toBe('fr');
  });

  it("a project with NO i18n config behaves exactly as before (en default)", () => {
    projectFS.deleteFile('i18n/config.json');
    const store = createStore();
    store.set(projectVersionAtom, (v: number) => v + 1);
    expect(store.get(activeLocaleAtom)).toBe('en');
    expect(store.get(isDefaultLocaleAtom)).toBe(true);
  });
});
