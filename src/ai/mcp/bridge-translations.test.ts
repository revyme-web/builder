// manageTranslations bridge op — locales CRUD + text translations through the
// editor's own {t()}+messages pipeline.
import { describe, it, expect, beforeEach } from 'vitest';
import { bridgeHandlers } from './bridge-client';
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

  it('write_texts rejects unconfigured and default locales', async () => {
    await expect(bridgeHandlers.manageTranslations({
      op: 'write_texts', locale: 'de', items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Hallo' }],
    })).rejects.toThrow(/not configured/);
    await expect(bridgeHandlers.manageTranslations({
      op: 'write_texts', locale: 'en', items: [{ filePath: PAGE_PATH, nodeId: 'title', text: 'Hi' }],
    })).rejects.toThrow(/default locale/);
  });
});
