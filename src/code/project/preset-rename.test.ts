// preset-rename.test.ts — renaming a preset must carry every element using it.
// The Library's old rename removed the token and re-added it under the new
// name, so `var(--old)` everywhere lost its value ("apply it, rename it, and
// it breaks instantly" — Discord report 2026-10-21).
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { projectFS, resetProjectFS } from './project-fs';
import {
  renamePresetToken, renameCustomPropertyInText, presetRenameTarget, renamePresetGroup, presetGroupRenameTarget,
} from './preset-rename';
import { parsePresetTokens } from '../generation/preset-gen';

const GLOBALS = `:root {
  /* Colors */
  --color-brand: #6366f1;
  --color-brand-light: #818cf8;
  --color-accent: var(--color-brand);
}

:root.dark {
  --color-brand: #a5b4fc;
}
`;

const PAGE = `'use client';
export default function Page() {
  return <div data-id="root" style={{ backgroundColor: 'var(--color-brand)', color: 'var(--color-brand-light)', borderColor: 'var( --color-brand, #000)' }}>
    <p data-id="t" style={{ color: 'var(--color-brand)' }}>--color-brand is the brand colour</p>
  </div>;
}
`;

describe('presetRenameTarget — keeps the category prefix', () => {
  test.each([
    ['color-brand', 'Primary', 'color-primary'],
    ['color-brand', 'Brand Dark', 'color-brand-dark'],
    ['color-brand', 'color-primary', 'color-primary'],
    ['radius-card', 'Pill', 'radius-pill'],
    ['brand-color', 'Primary', 'primary'],
  ])('%s + "%s" → %s', (from, input, to) => {
    expect(presetRenameTarget(from, input)).toBe(to);
  });

  test('an input that slugs to nothing is refused', () => {
    expect(presetRenameTarget('color-brand', '  !!  ')).toBeNull();
    expect(presetRenameTarget('color-brand', 'color-')).toBeNull();
  });
});

describe('renameCustomPropertyInText — exact-name boundaries', () => {
  test('renames declarations and references, never a longer name', () => {
    const out = renameCustomPropertyInText(GLOBALS, 'color-brand', 'color-primary');
    expect(out).toContain('--color-primary: #6366f1;');
    expect(out).toContain('--color-brand-light: #818cf8;');
    expect(out).toContain('--color-accent: var(--color-primary);');
    expect(out).toContain(':root.dark {\n  --color-primary: #a5b4fc;');
    expect(out).not.toMatch(/--color-brand(?![\w-])/);
  });

  test('varOnly leaves bare mentions alone', () => {
    const json = '{"note":"use --color-brand","fill":"var(--color-brand)"}';
    expect(renameCustomPropertyInText(json, 'color-brand', 'color-primary', true))
      .toBe('{"note":"use --color-brand","fill":"var(--color-primary)"}');
  });
});

describe('renamePresetToken — project-wide', () => {
  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile('app/globals.css', GLOBALS);
    projectFS.writeFile('app/page.client.tsx', PAGE);
    projectFS.writeFile('components/Card.tsx', `export default function Card() { return <div data-id="c" style={{ background: 'linear-gradient(var(--color-brand), white)' }} />; }\n`);
    projectFS.writeFile('cms/posts.json', '{"items":[{"tint":"var(--color-brand)","body":"--color-brand rocks"}]}');
    projectFS.writeFile('_meta/comments.json', '[{"id":"c1","x":0,"y":0,"filePath":"app/page.client.tsx","text":"var(--color-brand) looks off"}]');
  });

  test('the token and every reference follow; the near-namesake does not', () => {
    const res = renamePresetToken('color-brand', 'color-primary');
    expect(res).toMatchObject({ ok: true, to: 'color-primary' });

    const tokens = parsePresetTokens(projectFS.readFile('app/globals.css') ?? '');
    expect(tokens.find((t) => t.name === 'color-primary')).toMatchObject({ value: '#6366f1', category: 'color' });
    expect(tokens.find((t) => t.name === 'color-brand')).toBeUndefined();
    expect(tokens.find((t) => t.name === 'color-brand-light')).toBeDefined();

    const page = projectFS.readFile('app/page.client.tsx') ?? '';
    expect(page).toContain("backgroundColor: 'var(--color-primary)'");
    expect(page).toContain("color: 'var(--color-brand-light)'");
    expect(page).toContain("borderColor: 'var( --color-primary, #000)'");
    expect(page).toContain("style={{ color: 'var(--color-primary)' }}");
    expect(projectFS.readFile('components/Card.tsx')).toContain('linear-gradient(var(--color-primary), white)');
    // data files: references only — the user's text keeps its words
    expect(projectFS.readFile('cms/posts.json')).toBe('{"items":[{"tint":"var(--color-primary)","body":"--color-brand rocks"}]}');
    // editor state is never rewritten
    expect(projectFS.readFile('_meta/comments.json')).toContain('var(--color-brand) looks off');
    expect((res as { files: string[] }).files.sort()).toEqual(['app/globals.css', 'app/page.client.tsx', 'cms/posts.json', 'components/Card.tsx']);
  });

  test('refuses a name that already exists — renaming onto it would merge two presets', () => {
    expect(renamePresetToken('color-brand', 'color-brand-light')).toEqual({ ok: false, reason: 'exists' });
    expect(projectFS.readFile('app/globals.css')).toBe(GLOBALS);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(PAGE);
  });

  test('refuses an unknown source and an invalid target', () => {
    expect(renamePresetToken('color-nope', 'color-x')).toEqual({ ok: false, reason: 'missing' });
    expect(renamePresetToken('color-brand', 'Has Space')).toEqual({ ok: false, reason: 'invalid' });
    expect(renamePresetToken('color-brand', 'color-brand')).toEqual({ ok: false, reason: 'unchanged' });
  });
});

const folders = (rootOrder: string[], children: string[]) =>
  JSON.stringify({ version: 1, rootOrder, folders: [{ id: 'pfld-x-1', name: 'Mine', parentId: null, children }] }, null, 2) + '\n';
const readFolders = (cat: string) => JSON.parse(projectFS.readFile(`_meta/preset-folders-${cat}.json`) ?? '{}');

describe('a simple preset keeps its folder', () => {
  test('the folder tree entry follows the renamed token', () => {
    resetProjectFS();
    projectFS.writeFile('app/globals.css', GLOBALS);
    projectFS.writeFile('_meta/preset-folders-color.json', folders(['color-brand-light', 'pfld-x-1'], ['color-accent', 'color-brand']));
    expect(renamePresetToken('color-brand', 'color-primary')).toMatchObject({ ok: true });
    const f = readFolders('color');
    expect(f.folders[0].children).toEqual(['color-accent', 'color-primary']);
    expect(f.rootOrder).toEqual(['color-brand-light', 'pfld-x-1']);
  });
});

// Typography / border presets are token GROUPS: the panel's "Body" row is
// `typo-body-font`, `typo-body-size`, `typo-body-size-md` … Its menu had no
// Rename at all (user report 2026-10-22).
const TYPO_GLOBALS = `:root {
  /* Typography */
  --typo-heading-font: 'Inter', sans-serif;
  --typo-heading-size: 56px;
  --typo-body-tag: p;
  --typo-body-font: 'Inter', sans-serif;
  --typo-body-size: 16px;
  --typo-body-line-height: 1.7;
  --typo-body-color: #333333;
  --typo-body-size-md: 15px;
  --typo-body-stroke-color: #000000;
  --typo-body-min-default: 1200;

  /* Borders */
  --border-card-width: 1px;
  --border-card-style: solid;
  --border-card-color: #e5e5e5;
}
`;

const TYPO_PAGE = `export default function Page() {
  return <div data-id="root">
    <p data-id="t" style={{ fontFamily: 'var(--typo-body-font)', fontSize: 'var(--typo-body-size)', lineHeight: 'var(--typo-body-line-height)', WebkitTextStrokeColor: 'var(--typo-body-stroke-color)' }}>Hi</p>
    <div data-id="b" style={{ borderWidth: 'var(--border-card-width)', borderStyle: 'var(--border-card-style)', borderColor: 'var(--border-card-color)' }} />
    <style>{\`@media (max-width: 1199px) { [data-id="t"] { font-size: var(--typo-body-size-md) !important; } }\`}</style>
  </div>;
}
`;

describe('renamePresetGroup — typography and border groups', () => {
  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile('app/globals.css', TYPO_GLOBALS);
    projectFS.writeFile('app/page.client.tsx', TYPO_PAGE);
    projectFS.writeFile('_meta/preset-folders-typography.json', folders(['heading', 'pfld-x-1'], ['body']));
  });

  test('the target is the slugged group name; typing the prefix is fine', () => {
    expect(presetGroupRenameTarget('typography', 'body', 'Body Large')).toBe('body-large');
    expect(presetGroupRenameTarget('typography', 'body', 'typo-lead')).toBe('lead');
    expect(presetGroupRenameTarget('border', 'card', 'Outline')).toBe('outline');
    expect(presetGroupRenameTarget('typography', 'body', ' !! ')).toBeNull();
  });

  test('every token of the group, every reference and the folder entry follow', () => {
    expect(renamePresetGroup('typography', 'body', 'body-large')).toMatchObject({ ok: true, to: 'body-large' });
    const names = parsePresetTokens(projectFS.readFile('app/globals.css') ?? '').map((t) => t.name);
    expect(names.filter((n) => n.startsWith('typo-body-large-')).sort()).toEqual([
      'typo-body-large-color', 'typo-body-large-font', 'typo-body-large-line-height', 'typo-body-large-min-default',
      'typo-body-large-size', 'typo-body-large-size-md', 'typo-body-large-stroke-color', 'typo-body-large-tag',
    ]);
    expect(names).toContain('typo-heading-font');
    const page = projectFS.readFile('app/page.client.tsx') ?? '';
    expect(page).not.toMatch(/--typo-body-(?!large)/);
    expect(page).toContain("fontSize: 'var(--typo-body-large-size)'");
    expect(page).toContain('font-size: var(--typo-body-large-size-md) !important');
    expect(page).toContain("WebkitTextStrokeColor: 'var(--typo-body-large-stroke-color)'");
    expect(readFolders('typography').folders[0].children).toEqual(['body-large']);
  });

  test('a border group renames the same way', () => {
    expect(renamePresetGroup('border', 'card', 'outline')).toMatchObject({ ok: true });
    const css = projectFS.readFile('app/globals.css') ?? '';
    expect(css).toContain('--border-outline-width: 1px;');
    expect(css).not.toContain('--border-card-');
    expect(projectFS.readFile('app/page.client.tsx')).toContain("borderColor: 'var(--border-outline-color)'");
  });

  test('refused, with nothing written: an existing group, or a name that would split the group', () => {
    expect(renamePresetGroup('typography', 'body', 'heading')).toEqual({ ok: false, reason: 'exists' });
    // the group's colour token `typo-x-stroke-color` reads back as group `x` (suffix stroke-color)
    expect(renamePresetGroup('typography', 'body', 'x-stroke')).toEqual({ ok: false, reason: 'invalid' });
    expect(renamePresetGroup('typography', 'nope', 'lead')).toEqual({ ok: false, reason: 'missing' });
    expect(projectFS.readFile('app/globals.css')).toBe(TYPO_GLOBALS);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(TYPO_PAGE);
  });
});
