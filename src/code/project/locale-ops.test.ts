// locale-ops.test.ts — Tests for i18n locale CRUD operations.

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// In-memory store backing the mock projectFS
let fsStore: Map<string, string>;

vi.mock('./project-fs', () => ({
  projectFS: {
    readFile: vi.fn((path: string) => fsStore.get(path) ?? null),
    writeFile: vi.fn((path: string, content: string) => { fsStore.set(path, content); }),
    deleteFile: vi.fn((path: string) => { fsStore.delete(path); }),
    listFiles: vi.fn((dir?: string) => {
      const prefix = dir ? (dir.endsWith('/') ? dir : dir + '/') : '';
      const result: string[] = [];
      for (const path of fsStore.keys()) {
        if (!prefix || path.startsWith(prefix)) result.push(path);
      }
      return result.sort();
    }),
    exists: vi.fn((path: string) => fsStore.has(path)),
  },
}));

import {
  getI18nConfig,
  saveI18nConfig,
  addLocale,
  removeLocale,
  getLocaleOverrides,
  getPageOverrides,
  setNodeOverride,
  setCollectionItemOverride,
} from './locale-ops';
import type { I18nConfig, LocaleOverrides } from '@/shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(path: string): any {
  const raw = fsStore.get(path);
  return raw ? JSON.parse(raw) : null;
}

function writeJSON(path: string, data: any): void {
  fsStore.set(path, JSON.stringify(data, null, 2));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  fsStore = new Map();
  vi.clearAllMocks();
});

// ── getI18nConfig ─────────────────────────────────────────────────────────

describe('getI18nConfig', () => {
  test('returns default config when no file exists', () => {
    const config = getI18nConfig();
    expect(config.defaultLocale).toBe('en');
    expect(config.locales).toEqual([{ code: 'en', label: 'English' }]);
  });

  test('reads config from file', () => {
    const saved: I18nConfig = {
      defaultLocale: 'en',
      locales: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Francais' },
      ],
    };
    writeJSON('i18n/config.json', saved);
    const config = getI18nConfig();
    expect(config).toEqual(saved);
  });

  test('returns default for malformed JSON', () => {
    fsStore.set('i18n/config.json', '{{ not json }}');
    const config = getI18nConfig();
    expect(config.defaultLocale).toBe('en');
  });
});

// ── saveI18nConfig ────────────────────────────────────────────────────────

describe('saveI18nConfig', () => {
  test('writes config to projectFS', () => {
    const config: I18nConfig = {
      defaultLocale: 'en',
      locales: [{ code: 'en', label: 'English' }],
    };
    saveI18nConfig(config);
    const raw = readJSON('i18n/config.json');
    expect(raw).toEqual(config);
  });

  test('overwrites existing config', () => {
    const config1: I18nConfig = {
      defaultLocale: 'en',
      locales: [{ code: 'en', label: 'English' }],
    };
    const config2: I18nConfig = {
      defaultLocale: 'fr',
      locales: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Francais' },
      ],
    };
    saveI18nConfig(config1);
    saveI18nConfig(config2);
    expect(readJSON('i18n/config.json')).toEqual(config2);
  });
});

// ── addLocale ─────────────────────────────────────────────────────────────

describe('addLocale', () => {
  test('adds locale to config and creates empty overrides file', () => {
    addLocale('fr', 'Francais');
    const config = readJSON('i18n/config.json') as I18nConfig;
    expect(config.locales).toContainEqual({ code: 'fr', label: 'Francais' });

    const overrides = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(overrides).toEqual({ pages: {}, collections: {} });
  });

  test('adds locale with direction', () => {
    addLocale('ar', 'Arabic', 'rtl');
    const config = readJSON('i18n/config.json') as I18nConfig;
    expect(config.locales).toContainEqual({ code: 'ar', label: 'Arabic', direction: 'rtl' });
  });

  test('skips duplicate locale code', () => {
    addLocale('fr', 'Francais');
    addLocale('fr', 'French v2');
    const config = readJSON('i18n/config.json') as I18nConfig;
    const frLocales = config.locales.filter(l => l.code === 'fr');
    expect(frLocales).toHaveLength(1);
    expect(frLocales[0].label).toBe('Francais'); // original label kept
  });

  test('preserves existing locales when adding new one', () => {
    addLocale('fr', 'Francais');
    addLocale('es', 'Espanol');
    const config = readJSON('i18n/config.json') as I18nConfig;
    expect(config.locales.some(l => l.code === 'fr')).toBe(true);
    expect(config.locales.some(l => l.code === 'es')).toBe(true);
  });
});

// ── removeLocale ──────────────────────────────────────────────────────────

describe('removeLocale', () => {
  test('removes locale from config and deletes overrides file', () => {
    addLocale('fr', 'Francais');
    expect(fsStore.has('i18n/fr.json')).toBe(true);

    removeLocale('fr');
    const config = readJSON('i18n/config.json') as I18nConfig;
    expect(config.locales.some(l => l.code === 'fr')).toBe(false);
    expect(fsStore.has('i18n/fr.json')).toBe(false);
  });

  test('handles removing non-existent locale gracefully', () => {
    // Should not throw
    removeLocale('nonexistent');
  });

  test('preserves other locales when removing one', () => {
    addLocale('fr', 'Francais');
    addLocale('es', 'Espanol');
    removeLocale('fr');
    const config = readJSON('i18n/config.json') as I18nConfig;
    expect(config.locales.some(l => l.code === 'es')).toBe(true);
    expect(config.locales.some(l => l.code === 'fr')).toBe(false);
  });
});

// ── getLocaleOverrides ────────────────────────────────────────────────────

describe('getLocaleOverrides', () => {
  test('returns empty structure when no file exists', () => {
    const overrides = getLocaleOverrides('fr');
    expect(overrides).toEqual({ pages: {}, collections: {} });
  });

  test('reads overrides from file', () => {
    const saved: LocaleOverrides = {
      pages: {
        'app/page.tsx': {
          'hero-title': { text: 'Bonjour' },
        },
      },
      collections: {},
    };
    writeJSON('i18n/fr.json', saved);
    expect(getLocaleOverrides('fr')).toEqual(saved);
  });

  test('returns empty structure for malformed JSON', () => {
    fsStore.set('i18n/fr.json', '{{ bad }}');
    expect(getLocaleOverrides('fr')).toEqual({ pages: {}, collections: {} });
  });
});

// ── getPageOverrides ──────────────────────────────────────────────────────

describe('getPageOverrides', () => {
  test('returns overrides for a specific page', () => {
    const saved: LocaleOverrides = {
      pages: {
        'app/page.tsx': {
          'hero-title': { text: 'Bonjour' },
          'hero-subtitle': { text: 'Sous-titre' },
        },
        'app/about.tsx': {
          'about-title': { text: 'A propos' },
        },
      },
      collections: {},
    };
    writeJSON('i18n/fr.json', saved);

    const result = getPageOverrides('fr', 'app/page.tsx');
    expect(result).toEqual({
      'hero-title': { text: 'Bonjour' },
      'hero-subtitle': { text: 'Sous-titre' },
    });
  });

  test('returns empty object when page has no overrides', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });
    expect(getPageOverrides('fr', 'app/page.tsx')).toEqual({});
  });

  test('returns empty object when locale file does not exist', () => {
    expect(getPageOverrides('fr', 'app/page.tsx')).toEqual({});
  });
});

// ── setNodeOverride ───────────────────────────────────────────────────────

describe('setNodeOverride', () => {
  test('creates new node override', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setNodeOverride('fr', 'app/page.tsx', 'hero-title', { text: 'Bonjour' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/page.tsx']['hero-title'].text).toBe('Bonjour');
  });

  test('merges styles deeply', () => {
    const initial: LocaleOverrides = {
      pages: {
        'app/page.tsx': {
          'hero-title': { text: 'Bonjour', styles: { fontSize: '24px', color: 'red' } },
        },
      },
      collections: {},
    };
    writeJSON('i18n/fr.json', initial);

    setNodeOverride('fr', 'app/page.tsx', 'hero-title', {
      styles: { fontSize: '28px', fontWeight: 'bold' },
    });

    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    const node = result.pages['app/page.tsx']['hero-title'];
    expect(node.text).toBe('Bonjour');                // preserved
    expect(node.styles!.fontSize).toBe('28px');        // overwritten
    expect(node.styles!.color).toBe('red');            // preserved
    expect(node.styles!.fontWeight).toBe('bold');      // added
  });

  test('merges props deeply', () => {
    const initial: LocaleOverrides = {
      pages: {
        'app/page.tsx': {
          'hero-img': { props: { src: '/fr-hero.jpg', alt: 'Image FR' } },
        },
      },
      collections: {},
    };
    writeJSON('i18n/fr.json', initial);

    setNodeOverride('fr', 'app/page.tsx', 'hero-img', {
      props: { alt: 'Nouvelle image', title: 'Hero' },
    });

    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    const node = result.pages['app/page.tsx']['hero-img'];
    expect(node.props!.src).toBe('/fr-hero.jpg');      // preserved
    expect(node.props!.alt).toBe('Nouvelle image');    // overwritten
    expect(node.props!.title).toBe('Hero');            // added
  });

  test('sets visible override', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setNodeOverride('fr', 'app/page.tsx', 'en-banner', { visible: false });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/page.tsx']['en-banner'].visible).toBe(false);
  });

  test('cleans up empty node overrides', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    // Set an override with only empty styles/props → should be cleaned up
    setNodeOverride('fr', 'app/page.tsx', 'empty-node', {
      styles: {},
      props: {},
    });

    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    // Node should be cleaned up since it has no meaningful data
    expect(result.pages['app/page.tsx']).toBeUndefined();
  });

  test('cleans up page entry when last node is removed', () => {
    const initial: LocaleOverrides = {
      pages: {
        'app/page.tsx': {
          'only-node': { text: 'Hello' },
        },
      },
      collections: {},
    };
    writeJSON('i18n/fr.json', initial);

    // Set override with empty text → should clean up node and page
    setNodeOverride('fr', 'app/page.tsx', 'only-node', {
      text: '',
      styles: {},
      props: {},
    });

    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/page.tsx']).toBeUndefined();
  });

  test('creates page entry when it does not exist', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setNodeOverride('fr', 'app/new-page.tsx', 'title', { text: 'Titre' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/new-page.tsx']).toBeDefined();
    expect(result.pages['app/new-page.tsx']['title'].text).toBe('Titre');
  });

  test('creates overrides file when it does not exist', () => {
    // No fr.json file at all
    setNodeOverride('fr', 'app/page.tsx', 'title', { text: 'Bonjour' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/page.tsx']['title'].text).toBe('Bonjour');
  });

  test('preserves collections when updating pages', () => {
    const initial: LocaleOverrides = {
      pages: {},
      collections: {
        team: { alice: { role: 'PDG' } },
      },
    };
    writeJSON('i18n/fr.json', initial);

    setNodeOverride('fr', 'app/page.tsx', 'title', { text: 'Bonjour' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.team.alice.role).toBe('PDG');
  });
});

// ── setCollectionItemOverride ────────────────────────────────────────────

describe('setCollectionItemOverride', () => {
  test('creates new collection item override', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setCollectionItemOverride('fr', 'team', 'alice', { role: 'PDG', bio: 'La fondatrice' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.team.alice).toEqual({ role: 'PDG', bio: 'La fondatrice' });
  });

  test('merges fields with existing item override', () => {
    const initial: LocaleOverrides = {
      pages: {},
      collections: {
        team: { alice: { role: 'PDG' } },
      },
    };
    writeJSON('i18n/fr.json', initial);

    setCollectionItemOverride('fr', 'team', 'alice', { bio: 'La fondatrice' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.team.alice).toEqual({ role: 'PDG', bio: 'La fondatrice' });
  });

  test('overwrites existing field values', () => {
    const initial: LocaleOverrides = {
      pages: {},
      collections: {
        team: { alice: { role: 'PDG', bio: 'Ancienne bio' } },
      },
    };
    writeJSON('i18n/fr.json', initial);

    setCollectionItemOverride('fr', 'team', 'alice', { bio: 'Nouvelle bio' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.team.alice.role).toBe('PDG');
    expect(result.collections.team.alice.bio).toBe('Nouvelle bio');
  });

  test('creates collection entry when it does not exist', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setCollectionItemOverride('fr', 'blog', 'post-1', { title: 'Article' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.blog['post-1']).toEqual({ title: 'Article' });
  });

  test('creates overrides file when it does not exist', () => {
    setCollectionItemOverride('fr', 'team', 'alice', { role: 'PDG' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.collections.team.alice).toEqual({ role: 'PDG' });
  });

  test('preserves pages when updating collections', () => {
    const initial: LocaleOverrides = {
      pages: { 'app/page.tsx': { title: { text: 'Bonjour' } } },
      collections: {},
    };
    writeJSON('i18n/fr.json', initial);

    setCollectionItemOverride('fr', 'team', 'alice', { role: 'PDG' });
    const result = readJSON('i18n/fr.json') as LocaleOverrides;
    expect(result.pages['app/page.tsx'].title.text).toBe('Bonjour');
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────

describe('round-trip', () => {
  test('set node override → get page overrides → matches', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setNodeOverride('fr', 'app/page.tsx', 'hero-title', {
      text: 'Bienvenue',
      styles: { fontSize: '32px' },
      props: { 'aria-label': 'Titre principal' },
    });

    const overrides = getPageOverrides('fr', 'app/page.tsx');
    expect(overrides['hero-title']).toEqual({
      text: 'Bienvenue',
      styles: { fontSize: '32px' },
      props: { 'aria-label': 'Titre principal' },
    });
  });

  test('set collection override → get locale overrides → matches', () => {
    writeJSON('i18n/es.json', { pages: {}, collections: {} });

    setCollectionItemOverride('es', 'team', 'alice', { role: 'Directora General' });
    setCollectionItemOverride('es', 'team', 'bob', { role: 'Director Tecnico' });

    const overrides = getLocaleOverrides('es');
    expect(overrides.collections.team.alice.role).toBe('Directora General');
    expect(overrides.collections.team.bob.role).toBe('Director Tecnico');
  });

  test('multiple pages and collections in same locale file', () => {
    writeJSON('i18n/fr.json', { pages: {}, collections: {} });

    setNodeOverride('fr', 'app/page.tsx', 'title', { text: 'Accueil' });
    setNodeOverride('fr', 'app/about.tsx', 'title', { text: 'A propos' });
    setCollectionItemOverride('fr', 'team', 'alice', { role: 'PDG' });
    setCollectionItemOverride('fr', 'blog', 'post-1', { title: 'Article 1' });

    const all = getLocaleOverrides('fr');
    expect(Object.keys(all.pages)).toHaveLength(2);
    expect(Object.keys(all.collections)).toHaveLength(2);
    expect(all.pages['app/page.tsx'].title.text).toBe('Accueil');
    expect(all.pages['app/about.tsx'].title.text).toBe('A propos');
    expect(all.collections.team.alice.role).toBe('PDG');
    expect(all.collections.blog['post-1'].title).toBe('Article 1');
  });
});
