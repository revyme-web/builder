// component-translations.test.ts — Make Component keeps the translations.
//
// `t` is the PAGE component's `useTranslations()` const. Extracting a subtree
// into `components/Foo.tsx` moved the `{t('key')}` calls somewhere that const
// does not exist: the component crashed on the live site and rendered no text
// at all on the canvas (user report 2026-08-09). The page's OTHER file-local
// hook (`useResponsiveText`) has been carried across since 2026-07-28; the
// translation hook never got the same treatment.
//
// The namespace is derived from the FILE PATH, so scaffolding the hook alone
// is not enough — the words lived under `home` and the component asks for
// `component:Foo`. Both halves are asserted below.

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const fsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('./project-fs', () => ({
  DEFAULT_PROVIDERS: '',
  projectFS: {
    readFile: vi.fn((p: string) => fsStore.get(p) ?? null),
    writeFile: vi.fn((p: string, c: string) => { fsStore.set(p, c); }),
    deleteFile: vi.fn((p: string) => { fsStore.delete(p); }),
    listFiles: vi.fn(() => [...fsStore.keys()].sort()),
    exists: vi.fn((p: string) => fsStore.has(p)),
  },
}));
vi.mock('./modify-file', () => ({
  modifyProjectFile: vi.fn((p: string, fn: (c: string) => string) => {
    fsStore.set(p, fn(fsStore.get(p) ?? ''));
  }),
}));

import { adoptTranslationsForComponent } from './translation-ops';

const PAGE = 'app/page.client.tsx';          // → namespace 'home'
const COMPONENT = 'components/DuPaSu.tsx';   // → namespace 'component:DuPaSu'

/** What Make Component hands over: the extracted JSX, still calling `t`. */
const EXTRACTED = `import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function DuPaSu({ style, ...rest }: any) {
  return <div data-id="footer-inner" {...rest}>
    <p data-id="footer-legal">{t("footer-legal")}</p>
    <p data-id="footer-phone">+33 7 85 66 05 34</p>
  </div>;
}
export default withResponsiveProps(DuPaSu);
`;

const adopt = (code = EXTRACTED) => adoptTranslationsForComponent({
  componentCode: code, pageFilePath: PAGE, componentFilePath: COMPONENT,
});
const msg = (locale: string) => JSON.parse(fsStore.get(`messages/${locale}.json`)!);

beforeEach(() => {
  fsStore.clear();
  fsStore.set('i18n/config.json', JSON.stringify({
    defaultLocale: 'en',
    locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }],
  }));
  fsStore.set('messages/en.json', JSON.stringify({ home: { 'footer-legal': 'All rights reserved' } }));
  fsStore.set('messages/fr.json', JSON.stringify({ home: { 'footer-legal': 'Tous droits réservés' } }));
});

describe('adoptTranslationsForComponent', () => {
  test('gives the component its own hook and import', () => {
    const out = adopt();
    expect(out).toMatch(/from ["']next-intl["']/);
    expect(out).toContain('useTranslations("component:DuPaSu")');
    // The extracted calls are untouched — the hook is named `t` either way.
    expect(out).toContain('t("footer-legal")');
  });

  test('copies the words into the component namespace, in EVERY locale', () => {
    // The half that scaffolding alone does not solve: without this the hook
    // resolves to nothing and the text is still blank — it just stops crashing.
    adopt();
    expect(msg('en')['component:DuPaSu']['footer-legal']).toBe('All rights reserved');
    expect(msg('fr')['component:DuPaSu']['footer-legal']).toBe('Tous droits réservés');
  });

  test('REMOVES the page entry — the node left, so the key must too', () => {
    // Leaving it means the same key holds different words in two namespaces,
    // and whichever reader picks the wrong one shows stale text. A key is the
    // node's data-id (unique per FILE), so nothing on the page still asks for
    // it once the node has moved into the component.
    adopt();
    expect(msg('fr').home?.['footer-legal']).toBeUndefined();
  });

  test('drops the namespace bucket when it empties', () => {
    adopt();
    expect(msg('fr').home).toBeUndefined();
  });

  test('the words survive the move — never gone from BOTH namespaces', () => {
    // Copy and delete compose in one string written once per file, so there is
    // no instant where neither namespace has them.
    adopt();
    expect(msg('fr')['component:DuPaSu']['footer-legal']).toBe('Tous droits réservés');
    expect(msg('en')['component:DuPaSu']['footer-legal']).toBe('All rights reserved');
  });

  test('leaves OTHER page keys alone', () => {
    fsStore.set('messages/fr.json', JSON.stringify({
      home: { 'footer-legal': 'Tous droits réservés', 'hero-title': 'Reste sur la page' },
    }));
    adopt();
    expect(msg('fr').home['hero-title']).toBe('Reste sur la page');
    expect(msg('fr').home['footer-legal']).toBeUndefined();
  });

  test('never clobbers a translation already edited on the component', () => {
    fsStore.set('messages/fr.json', JSON.stringify({
      home: { 'footer-legal': 'Tous droits réservés' },
      'component:DuPaSu': { 'footer-legal': 'Déjà traduit à la main' },
    }));
    adopt();
    expect(msg('fr')['component:DuPaSu']['footer-legal']).toBe('Déjà traduit à la main');
    // …and the now-dead page entry still goes.
    expect(msg('fr').home?.['footer-legal']).toBeUndefined();
  });

  test('does nothing to a subtree with no translations', () => {
    const plain = `function X() { return <div data-id="a"><p>+33 7 85</p></div>; }`;
    expect(adopt(plain)).toBe(plain);
    expect(msg('en')['component:DuPaSu']).toBeUndefined();
  });

  test('is not confused by useResponsiveText, the OTHER file-local hook', () => {
    const responsive = `function X() {
  return <div data-id="a"><p>{useResponsiveText({ base: 'hi' })}</p></div>;
}`;
    expect(adopt(responsive)).toBe(responsive);
  });

  test('a key with no message anywhere still scaffolds, so the JSX runs', () => {
    // Crashing is strictly worse than rendering empty: an unseeded key means
    // the component shows nothing, but the page still builds.
    fsStore.set('messages/en.json', '{}');
    fsStore.set('messages/fr.json', '{}');
    const out = adopt();
    expect(out).toContain('useTranslations("component:DuPaSu")');
  });
});
