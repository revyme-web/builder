// preset-duplicate.test.ts — Duplicate in every preset menu (user report
// 2026-10-22: no Duplicate anywhere). The copy is a new token with the same
// value(s), declared just below the original (dark value too) and filed right
// after it in the panel's folder tree.
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { projectFS, resetProjectFS } from './project-fs';
import { duplicatePresetToken, duplicatePresetGroup, presetCopyName } from './preset-duplicate';
import { parsePresetTokens, duplicatePresetTokensInCSS } from '../generation/preset-gen';
import { groupTypoTokens } from '@/editor/tools/typography-utils';

const GLOBALS = `:root {
  /* Colors */
  --color-brand: #6366f1;
  --color-surface: #ffffff;

  /* Typography */
  --typo-body-font: 'Inter', sans-serif;
  --typo-body-size: 16px;
  --typo-body-size-md: 15px;
  --typo-heading-font: 'Inter', sans-serif;

  /* Borders */
  --border-card-width: 1px;
  --border-card-style: solid;
  --border-card-color: #e5e5e5;
}

:root.dark {
  --color-brand: #a5b4fc;
}
`;

const folders = (rootOrder: string[], children: string[]) =>
  JSON.stringify({ version: 1, rootOrder, folders: [{ id: 'pfld-x-1', name: 'Mine', parentId: null, children }] }, null, 2) + '\n';
const readFolders = (cat: string) => JSON.parse(projectFS.readFile(`_meta/preset-folders-${cat}.json`) ?? '{}');

describe('duplicatePresetTokensInCSS', () => {
  test('the copy sits right below the original, in every block that declares it', () => {
    const out = duplicatePresetTokensInCSS(GLOBALS, [['color-brand', 'color-brand-copy']]);
    expect(out).toContain('  --color-brand: #6366f1;\n  --color-brand-copy: #6366f1;\n  --color-surface');
    expect(out).toContain(':root.dark {\n  --color-brand: #a5b4fc;\n  --color-brand-copy: #a5b4fc;\n}');
  });

  test('a group\'s copies stay one run, after the group\'s last line', () => {
    const out = duplicatePresetTokensInCSS(GLOBALS, [
      ['typo-body-font', 'typo-lead-font'], ['typo-body-size', 'typo-lead-size'], ['typo-body-size-md', 'typo-lead-size-md'],
    ]);
    expect(out).toContain(`  --typo-body-size-md: 15px;
  --typo-lead-font: 'Inter', sans-serif;
  --typo-lead-size: 16px;
  --typo-lead-size-md: 15px;
  --typo-heading-font`);
  });

  test('an unknown name changes nothing', () => {
    expect(duplicatePresetTokensInCSS(GLOBALS, [['color-nope', 'color-x']])).toBe(GLOBALS);
  });
});

describe('presetCopyName', () => {
  test('-copy, then -copy-2 …; a copy of a copy numbers on from the original', () => {
    const taken = new Set(['color-brand', 'color-brand-copy']);
    expect(presetCopyName('color-surface', (c) => !taken.has(c))).toBe('color-surface-copy');
    expect(presetCopyName('color-brand', (c) => !taken.has(c))).toBe('color-brand-copy-2');
    expect(presetCopyName('color-brand-copy', (c) => !taken.has(c))).toBe('color-brand-copy-2');
  });
});

describe('duplicatePresetToken / duplicatePresetGroup — project', () => {
  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile('app/globals.css', GLOBALS);
    projectFS.writeFile('app/page.client.tsx', `const P = () => <div data-id="r" style={{ color: 'var(--color-brand)' }} />;\n`);
  });

  test('a colour: same light and dark value, filed right after the original, pages untouched', () => {
    projectFS.writeFile('_meta/preset-folders-color.json', folders(['color-surface', 'pfld-x-1'], ['color-brand']));
    expect(duplicatePresetToken('color-brand')).toBe('color-brand-copy');
    const tokens = parsePresetTokens(projectFS.readFile('app/globals.css') ?? '');
    expect(tokens.find((t) => t.name === 'color-brand-copy')).toMatchObject({ value: '#6366f1', category: 'color' });
    expect(projectFS.readFile('app/globals.css')).toContain('--color-brand-copy: #a5b4fc;');
    expect(readFolders('color').folders[0].children).toEqual(['color-brand', 'color-brand-copy']);
    expect(projectFS.readFile('app/page.client.tsx')).not.toContain('copy');
    // again → -copy-2, after the original's run
    expect(duplicatePresetToken('color-brand')).toBe('color-brand-copy-2');
    expect(readFolders('color').folders[0].children).toEqual(['color-brand', 'color-brand-copy-2', 'color-brand-copy']);
  });

  test('a typography group copies every token under one new group', () => {
    projectFS.writeFile('_meta/preset-folders-typography.json', folders(['body', 'heading'], []));
    expect(duplicatePresetGroup('typography', 'body')).toBe('body-copy');
    const groups = groupTypoTokens(parsePresetTokens(projectFS.readFile('app/globals.css') ?? ''));
    expect(groups.map((g) => g.name)).toEqual(['body', 'body-copy', 'heading']);
    expect(groups[1].tokens.map((t) => `${t.name}=${t.value}`)).toEqual([
      "typo-body-copy-font='Inter', sans-serif", 'typo-body-copy-size=16px', 'typo-body-copy-size-md=15px',
    ]);
    expect(readFolders('typography').rootOrder).toEqual(['body', 'body-copy', 'heading']);
  });

  test('a border group too; an unknown preset is a no-op', () => {
    expect(duplicatePresetGroup('border', 'card')).toBe('card-copy');
    expect(projectFS.readFile('app/globals.css')).toContain('--border-card-copy-color: #e5e5e5;');
    const before = projectFS.readFile('app/globals.css');
    expect(duplicatePresetToken('color-nope')).toBeNull();
    expect(duplicatePresetGroup('typography', 'nope')).toBeNull();
    expect(projectFS.readFile('app/globals.css')).toBe(before);
  });
});
