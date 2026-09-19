// src/ai/agent/tools/set-page.test.ts
//
// Deterministic tests for P1 (page targeting — fiability audit 2026-08-19).
// Covers: route/path resolution, missing-page safety, activation end-to-end
// (writes land on the NEW page, never the old one), the shared helper through
// create_page, and idempotency. No LLM, no bench. The project is reset with
// the same headless wiring the harness uses (resetProjectFS + real mutation
// queue + node seed), so these tests exercise the REAL write path.

import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getCurrentCode, syncQueueCode, initMutationQueue } from '@/code/mutation/mutation-queue';
import { resetProjectFS, projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom, seedNodesForCode } from '@/code/stores/store';
import { resolvePageTarget, setPageTool } from './set-page';
import { createPageTool } from './action-layer-rich';
import { setActiveFilePath } from '@/code/mutation/mutation-queue';
import { bumpProjectVersion } from '@/code/project/modify-file';
// The REAL semantic write tool — the production path a model uses after
// switching pages (queues {type:'addNode', parentId, node} + reads the node
// cache). Using it (not a hand-rolled queueMutation) proves the whole wire.
import { addNodeTool } from './semantic-structure';

const HOME = 'app/page.client.tsx';
const ABOUT = 'app/about/page.client.tsx';

// Oracle-valid two-page project: home + about.
function seedProject(): void {
  resetProjectFS(new Map<string, string>([
    [HOME, `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <p data-id="home-heading" data-name="Heading" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '32px' }}>Home</p>
    </div>
  );
}`],
    [ABOUT, `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}></div>
  );
}`],
  ]));
  const store = getDefaultStore();
  store.set(selectedIdsAtom, []);
  // Wire the mutation queue with a DYNAMIC active-path flush — the browser
  // semantic (the queue writes to whatever file is active at flush time, not
  // a path captured at init). The eval harness captures the init path instead,
  // which would make set_page pointless in a headless run; this wiring is the
  // product contract the tool (and switchActiveFile) rely on.
  initMutationQueue(
    projectFS.readFile(HOME) ?? '',
    (flushed) => {
      const target = store.get(activeFilePathAtom);
      projectFS.writeFile(target, flushed);
      bumpProjectVersion();
    },
  );
  store.set(activeFilePathAtom, HOME);
  setActiveFilePath(HOME);
  syncQueueCode(projectFS.readFile(HOME) ?? '');
  store.set(projectVersionAtom, (v) => v + 1);
  seedNodesForCode(projectFS.readFile(HOME) ?? '');
}

beforeEach(() => {
  seedProject();
});

const MID = { ensureCheckpoint: () => undefined, vpWidth: 1440, signal: new AbortController().signal } as never;

async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx: never) => Promise<any> },
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const res = await tool.execute(args, MID);
  return { ok: !res.isError, text: (res.content as any).map((c: any) => c.text).join('\n') };
}

describe('resolvePageTarget', () => {
  it('resolves client path as-is', () => {
    expect(resolvePageTarget(ABOUT)).toBe(ABOUT);
    expect(resolvePageTarget(HOME)).toBe(HOME);
  });

  it('resolves the server wrapper to the client half', () => {
    expect(resolvePageTarget('app/about/page.tsx')).toBe(ABOUT);
  });

  it('resolves route slugs', () => {
    expect(resolvePageTarget('about')).toBe(ABOUT);
    expect(resolvePageTarget('/about')).toBe(ABOUT);
    expect(resolvePageTarget('home')).toBe(HOME);
    expect(resolvePageTarget('/')).toBe(HOME);
    expect(resolvePageTarget('')).toBe(HOME);
  });

  it('returns null for an unknown page (never guesses)', () => {
    expect(resolvePageTarget('contact')).toBeNull();
    expect(resolvePageTarget('app/nope/page.client.tsx')).toBeNull();
  });
});

describe('set_page tool', () => {
  it('fails clearly on a missing page, changes nothing', async () => {
    const before = getDefaultStore().get(activeFilePathAtom);
    const res = await exec(setPageTool, { page: 'contact' });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('contact');
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(before);
  });

  it('activates the about page and subsequent semantic writes land on it (NOT home)', async () => {
    const res = await exec(setPageTool, { page: 'about' });
    expect(res.ok).toBe(true);
    expect(res.text).toContain(ABOUT);
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(ABOUT);
    // The REAL add_node tool — the production write path after a page switch.
    const add = await exec(addNodeTool, {
      parent_id: 'root',
      id: 'about-title',
      tag: 'p',
      name: 'About title',
      styles: { position: 'relative', flex: '0 0 auto', order: '0', fontSize: '24px' },
      text: 'About us',
    });
    expect(add.ok).toBe(true);
    const aboutCode = projectFS.readFile(ABOUT) ?? '';
    const homeCode = projectFS.readFile(HOME) ?? '';
    expect(aboutCode).toContain('about-title');
    expect(homeCode).not.toContain('about-title');
    // The mutation queue's tracked code IS the about page now.
    expect(getCurrentCode()).toContain('about-title');
  });

  it('is idempotent when already active', async () => {
    await exec(setPageTool, { page: HOME });
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(HOME);
    const res = await exec(setPageTool, { page: HOME });
    expect(res.ok).toBe(true);
    expect(res.text).toContain(HOME);
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(HOME);
  });

  it('clears selection so nothing points into the previous page', async () => {
    getDefaultStore().set(selectedIdsAtom, ['home-heading']);
    await exec(setPageTool, { page: 'about' });
    expect(getDefaultStore().get(selectedIdsAtom)).toEqual([]);
  });
});

describe('create_page activates the new page (observation A)', () => {
  it('after create_page, a semantic write lands on the NEW page, not home', async () => {
    const res = await exec(createPageTool, { name: 'Contact', dir: 'app' });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('activated');
    const active = getDefaultStore().get(activeFilePathAtom);
    expect(active).toBe('app/contact/page.client.tsx');
    const add = await exec(addNodeTool, {
      parent_id: 'root',
      id: 'contact-heading',
      tag: 'h1',
      name: 'Heading',
      styles: { position: 'relative', flex: '0 0 auto', order: '0', fontSize: '40px' },
      text: 'Contact us',
    });
    expect(add.ok).toBe(true);
    expect(projectFS.readFile('app/contact/page.client.tsx') ?? '').toContain('contact-heading');
    expect(projectFS.readFile(HOME) ?? '').not.toContain('contact-heading');
    expect(getCurrentCode()).toContain('contact-heading');
  });
});
