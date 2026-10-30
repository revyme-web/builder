// manageTranslations bridge op — locales CRUD + text translations through the
// editor's own {t()}+messages pipeline.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bridgeHandlers } from './bridge-client';
import { backend } from '@/backend';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

const PAGE_PATH = 'app/page.client.tsx';
const PAGE = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <h1 data-id="title" data-name="Title" style={{ position: 'relative' }}>Welcome home</h1>
      <p data-id="tagline" data-name="Tagline" style={{ position: 'relative' }}>We build things</p>
    </div>
  );
}`;

const CONFIG = JSON.stringify({
  defaultLocale: 'en',
  locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }],
});

// Translation writes await a real save (bridge-client persistBridgeWrite):
// a resolved project and a backend that accepts it.
beforeEach(() => {
  window.history.pushState({}, '', '/builder/proj123');
  vi.spyOn(backend, 'saveProject').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

beforeEach(() => {
  resetProjectFS(new Map([
    [PAGE_PATH, PAGE],
    ['i18n/config.json', CONFIG],
    ['messages/en.json', '{}'],
    ['messages/fr.json', '{}'],
  ]));
});

describe('manageTranslations', () => {
  it('get returns config + translatable texts with per-locale translations', async () => {
    const out = await bridgeHandlers.manageTranslations({ op: 'get' }) as any;
    expect(out.config.defaultLocale).toBe('en');
    const keys = out.texts.map((t: any) => `${t.filePath}:${t.nodeId}`);
    expect(keys).toContain(`${PAGE_PATH}:title`);
    expect(keys).toContain(`${PAGE_PATH}:tagline`);
    const title = out.texts.find((t: any) => t.nodeId === 'title');
    expect(title.source).toBe('Welcome home');
    expect(title.translations).toHaveProperty('fr', '');
  });

  it('set_locales adds locales, seeds messages files, skips duplicates', async () => {
    const out = await bridgeHandlers.manageTranslations({
      op: 'set_locales',
      locales: [{ code: 'it', label: 'Italian' }, { code: 'fr', label: 'French' }],
    }) as any;
    const codes = out.config.locales.map((l: any) => l.code);
    expect(codes).toEqual(['en', 'fr', 'it']);
    expect(projectFS.readFile('messages/it.json')).toBe('{}');
  });

  it('set_locales rejects malformed codes', async () => {
    await expect(bridgeHandlers.manageTranslations({
      op: 'set_locales', locales: [{ code: 'French!', label: 'French' }],
    })).rejects.toThrow(/Invalid locale code/);
  });

  it('write_texts converts to t(), seeds default, writes the target locale', async () => {
    const out = await bridgeHandlers.manageTranslations({
      op: 'write_texts', locale: 'fr',
      items: [
        { filePath: PAGE_PATH, nodeId: 'title', text: 'Bienvenue' },
        { filePath: PAGE_PATH, nodeId: 'nope', text: 'x' },
      ],
    }) as any;
    expect(out.written).toBe(1);
    expect(out.unknown).toEqual([`${PAGE_PATH}:nope`]);

    const code = projectFS.readFile(PAGE_PATH)!;
    expect(code).toMatch(/\{t\(['"]title['"]\)\}/);
    expect(code).toMatch(/useTranslations\(['"]home['"]\)/);
    expect(JSON.parse(projectFS.readFile('messages/en.json')!)).toEqual({ home: { title: 'Welcome home' } });
    expect(JSON.parse(projectFS.readFile('messages/fr.json')!)).toEqual({ home: { title: 'Bienvenue' } });

    // Round-trip: get now shows the stored translation.
    const got = await bridgeHandlers.manageTranslations({ op: 'get' }) as any;
    expect(got.texts.find((t: any) => t.nodeId === 'title').translations.fr).toBe('Bienvenue');
  });

  it('write_texts rejects unconfigured locales', async () => {
    await expect(bridgeHandlers.manageTranslations({
      op: 'write_texts', locale: 'de', items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Hallo' }],
    })).rejects.toThrow(/not configured/);
  });

  // English copy that lives in messages/en.json had no write path at all:
  // write_texts refused the default locale and set_text appended beside the
  // t() call (customer's agent, 2026-10-30).
  it('write_texts on the DEFAULT locale edits the source copy — the message for a translated text', async () => {
    await bridgeHandlers.manageTranslations({ op: 'write_texts', locale: 'fr', items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Bienvenue' }] });
    const before = projectFS.readFile(PAGE_PATH)!;
    const out = await bridgeHandlers.manageTranslations({
      op: 'write_texts', locale: 'en',
      items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Welcome back' }, { filePath: PAGE_PATH, nodeId: 'tagline', text: 'We ship things' }],
    }) as any;
    expect(out.written).toBe(2);
    expect(JSON.parse(projectFS.readFile('messages/en.json')!).home.title).toBe('Welcome back');
    expect(JSON.parse(projectFS.readFile('messages/fr.json')!).home.title).toBe('Bienvenue');
    const code = projectFS.readFile(PAGE_PATH)!;
    // The translated node's JSX is untouched; the plain one is edited in place.
    expect(code.match(/data-id="title"[^>]*>([^<]*)</)![1]).toBe(before.match(/data-id="title"[^>]*>([^<]*)</)![1]);
    expect(code).toContain('>We ship things</p>');
  });
});

describe('set_text on a translated text', () => {
  it('writes the default-locale message instead of appending beside the t() call', async () => {
    const { setTextTool } = await import('@/ai/agent/tools/semantic-property');
    const { getDefaultStore } = await import('jotai');
    const { activeFilePathAtom } = await import('@/code/project/active-file-store');
    await bridgeHandlers.manageTranslations({ op: 'write_texts', locale: 'fr', items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Bienvenue' }] });
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
    const before = projectFS.readFile(PAGE_PATH)!;
    const res = await setTextTool.execute({ node_id: 'title', text: 'Welcome back' }, { ensureCheckpoint: () => {}, vpWidth: 1440, signal: new AbortController().signal });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(projectFS.readFile('messages/en.json')!).home.title).toBe('Welcome back');
    expect(projectFS.readFile(PAGE_PATH)).toBe(before);
    expect(JSON.parse(projectFS.readFile('messages/fr.json')!).home.title).toBe('Bienvenue');
  });
});

describe('code-component text props are translatable', () => {
  const HERO = `'use client';
/** @controls {
  "headline": { "type": "text", "label": "Headline", "default": "Your local team." },
  "sub": { "type": "text", "label": "Subtitle", "default": "We make it work." },
  "ctaUrl": { "type": "text", "label": "Button link", "default": "/contact" },
  "videoId": { "type": "text", "label": "Video", "default": "76979871" },
  "variant": { "type": "text", "label": "Variant", "default": "full" }
} */
export default function Hero({ headline = 'Your local team.', sub = 'We make it work.', ctaUrl = '/contact', videoId = '76979871', variant = 'full' }) {
  return <section><h1>{headline}</h1><p>{sub}</p></section>;
}`;
  const host = (props: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import Hero from '@/components/Hero';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <Hero data-id="hero" data-name="Hero" ${props} />
    </div>
  );
}`;

  it('lists copy props (not links or ids), translates one per locale, and edits the default', async () => {
    resetProjectFS(new Map([
      [PAGE_PATH, host('headline="Built for Germany." sub="We make it work." ctaUrl="/contact" videoId="76979871" variant="full"')],
      ['components/Hero.tsx', HERO],
      ['i18n/config.json', CONFIG], ['messages/en.json', '{}'], ['messages/fr.json', '{}'],
    ]));
    const got = await bridgeHandlers.manageTranslations({ op: 'get' }) as any;
    const rows = got.texts.filter((t: any) => t.nodeId.startsWith('hero#'));
    expect(rows.map((t: any) => t.nodeId).sort()).toEqual(['hero#headline', 'hero#sub']);
    expect(rows.find((t: any) => t.nodeId === 'hero#headline').source).toBe('Built for Germany.');

    await bridgeHandlers.manageTranslations({ op: 'write_texts', locale: 'fr', items: [{ filePath: PAGE_PATH, nodeId: 'hero#headline', text: 'Conçu pour l\'Allemagne.' }] });
    const again = await bridgeHandlers.manageTranslations({ op: 'get' }) as any;
    const headline = again.texts.find((t: any) => t.nodeId === 'hero#headline');
    expect(headline.translations.fr).toBe('Conçu pour l\'Allemagne.');
    expect(headline.source).toBe('Built for Germany.');

    await bridgeHandlers.manageTranslations({ op: 'write_texts', locale: 'en', items: [{ filePath: PAGE_PATH, nodeId: 'hero#headline', text: 'Made for Germany.' }] });
    const last = (await bridgeHandlers.manageTranslations({ op: 'get' }) as any).texts.find((t: any) => t.nodeId === 'hero#headline');
    expect(last.source).toBe('Made for Germany.');
    expect(last.translations.fr).toBe('Conçu pour l\'Allemagne.');
  });

  it('a prop that is a hand-written t() call is not listed (no tool owns that code)', async () => {
    resetProjectFS(new Map([
      [PAGE_PATH, host('headline={t("hero-title")} sub="We make it work."')],
      ['components/Hero.tsx', HERO],
      ['i18n/config.json', CONFIG], ['messages/en.json', '{}'], ['messages/fr.json', '{}'],
    ]));
    const got = await bridgeHandlers.manageTranslations({ op: 'get' }) as any;
    expect(got.texts.filter((t: any) => t.nodeId.startsWith('hero#')).map((t: any) => t.nodeId)).toEqual(['hero#sub']);
  });
});
