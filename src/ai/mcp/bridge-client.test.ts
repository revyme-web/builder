import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import { bridgeHandlers } from './bridge-client';
import { backend } from '@/backend';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { resetReadTracker } from './read-tracker';

const PAGE_PATH = 'app/page.client.tsx';
const PAGE = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;
}`;

/** Dialect-compliant component (mirrors the freeform-client test fixture). */
const CLEAN_COMPONENT = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Test Card" */

function TestCard({ style }: { style?: React.CSSProperties }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="card" layout style={{ position: 'relative', display: 'flex', padding: '24px', ...style }}>
      <motion.p data-id="label" layout style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#fff' }}>Hello</motion.p>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(TestCard);
`;

const SINNER_COMPONENT = `import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function TestCard({ style }: { style?: React.CSSProperties }) {
  return <div data-id="card" className="p-6" style={{ transition: 'all .3s', ...style }} />;
}
export default withResponsiveProps(TestCard);
`;

describe('bridgeHandlers', () => {
  beforeEach(async () => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE]]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
    resetReadTracker();
    // Real clients call get_context FIRST (the dialect mandates it); it credits the
    // active page so the stale-write guard allows an edit to it. Model that here.
    await bridgeHandlers.getContext({});
  });

  it('getContext reports the active file, its kind, code, pages and components', async () => {
    const ctx = await bridgeHandlers.getContext({}) as any;
    expect(ctx.activeFilePath).toBe(PAGE_PATH);
    expect(ctx.kind).toBe('page');
    expect(ctx.code).toContain('data-id="root"');
    expect(ctx.pages).toContain(PAGE_PATH);
    expect(Array.isArray(ctx.components)).toBe(true);
  });

  it('getContext reports surface=template on a LayoutClient file', async () => {
    const LAYOUT_PATH = 'app/(header)/LayoutClient.tsx';
    projectFS.writeFile(LAYOUT_PATH, "'use client';\nexport default function LayoutClient({ children }: { children: React.ReactNode }) { return <div data-id=\"root\">{children}</div>; }");
    getDefaultStore().set(activeFilePathAtom, LAYOUT_PATH);
    const ctx = await bridgeHandlers.getContext({}) as any;
    expect(ctx.surface).toBe('template');
    expect(ctx.kind).toBe('page'); // dialect stays page; the slot rule rides the gate
  });

  it('readFile returns code, and throws for a missing path', async () => {
    const out = await bridgeHandlers.readFile({ path: PAGE_PATH }) as any;
    expect(out.code).toBe(PAGE);
    await expect(bridgeHandlers.readFile({ path: 'nope.tsx' })).rejects.toThrow('File not found');
  });

  it('submitFiles commits a clean component', async () => {
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: 'components/TestCard.tsx', kind: 'component', code: CLEAN_COMPONENT }],
    }) as any;
    expect(out.committed).toBe(true);
    expect(out.written).toEqual(['components/TestCard.tsx']);
    expect(projectFS.readFile('components/TestCard.tsx')).toContain('withResponsiveProps(TestCard)');
  });

  it('submitFiles bounces violations and writes NOTHING', async () => {
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: 'components/TestCard.tsx', kind: 'component', code: SINNER_COMPONENT }],
    }) as any;
    expect(out.committed).toBe(false);
    expect(out.violations.map((v: any) => v.code)).toContain('CLASSNAME_STYLING');
    expect(projectFS.readFile('components/TestCard.tsx')).toBeNull();
  });

  it('submitFiles remaps a phantom page path to the active page', async () => {
    const updated = PAGE.replace("width: '100%' }} />", "width: '100%', display: 'flex', flexDirection: 'column' }}><p data-id=\"hello\" data-name=\"Hello\">Hi</p></div>");
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: 'page.client.tsx', kind: 'page', code: updated }],
    }) as any;
    expect(out.committed).toBe(true);
    expect(out.written).toEqual([PAGE_PATH]);
    expect(projectFS.readFile('page.client.tsx')).toBeNull();
    expect(projectFS.readFile(PAGE_PATH)).toContain('data-id="hello"');
  });

  it('submitFiles rejects an unknown page path when a COMPONENT is active (no silent remap)', async () => {
    projectFS.writeFile('components/Other.tsx', CLEAN_COMPONENT.replace(/TestCard/g, 'Other'));
    getDefaultStore().set(activeFilePathAtom, 'components/Other.tsx');
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: 'app/invented/page.client.tsx', kind: 'page', code: PAGE }],
    }) as any;
    expect(out.committed).toBe(false);
    expect(out.violations.map((v: any) => v.code)).toContain('PHANTOM_PAGE_PATH');
    expect(projectFS.readFile('app/invented/page.client.tsx')).toBeNull();
  });

  it('submitFiles is atomic: a page importing a missing component bounces the whole batch', async () => {
    const pageWithImport = PAGE
      .replace("import React from 'react';", "import React from 'react';\nimport Ghost from '@/components/Ghost';")
      .replace("width: '100%' }} />", "width: '100%' }}><Ghost data-id=\"g\" data-name=\"Ghost\" style={{ position: 'relative' }} /></div>");
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: PAGE_PATH, kind: 'page', code: pageWithImport }],
    }) as any;
    expect(out.committed).toBe(false);
    expect(out.violations.map((v: any) => v.code)).toContain('COMPONENT_IMPORT_MISSING');
    expect(projectFS.readFile(PAGE_PATH)).toBe(PAGE);
  });

  // ─── STALE-WRITE guard (server-enforced read-before-write) ───────────────────
  // A valid existing component (function name matches the PascalCase file name).
  const SAVED_PATH = 'components/Saved.tsx';
  const SAVED = CLEAN_COMPONENT.replace(/TestCard/g, 'Saved');

  it('submitFiles BOUNCES a blind write to an existing file the client never read', async () => {
    projectFS.writeFile(SAVED_PATH, SAVED);
    // No read_file / get_context for this path → submitting it would clobber blind.
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: SAVED_PATH, kind: 'component', code: SAVED.replace('Hello', 'Changed') }],
    }) as any;
    expect(out.committed).toBe(false);
    expect(out.violations.map((v: any) => v.code)).toContain('STALE_FILE');
    expect(projectFS.readFile(SAVED_PATH)).toBe(SAVED); // untouched
  });

  it('submitFiles ALLOWS the write after a fresh read_file credits the path', async () => {
    projectFS.writeFile(SAVED_PATH, SAVED);
    await bridgeHandlers.readFile({ path: SAVED_PATH });
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: SAVED_PATH, kind: 'component', code: SAVED.replace('Hello', 'Changed') }],
    }) as any;
    expect(out.committed).toBe(true);
    expect(projectFS.readFile(SAVED_PATH)).toContain('Changed');
  });

  it('submitFiles BOUNCES when the live file changed in the editor after the read (the clobber bug)', async () => {
    projectFS.writeFile(SAVED_PATH, SAVED);
    await bridgeHandlers.readFile({ path: SAVED_PATH }); // client reads
    projectFS.writeFile(SAVED_PATH, SAVED.replace('padding', 'margin')); // user edits live
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: SAVED_PATH, kind: 'component', code: SAVED.replace('Hello', 'Changed') }],
    }) as any;
    expect(out.committed).toBe(false);
    expect(out.violations.map((v: any) => v.code)).toContain('STALE_FILE');
    expect(out.violations.find((v: any) => v.code === 'STALE_FILE').message).toContain('changed in the editor');
  });

  it('a NEW file (not on disk) is exempt — no prior read required', async () => {
    const FRESH = CLEAN_COMPONENT.replace(/TestCard/g, 'Fresh');
    const out = await bridgeHandlers.submitFiles({
      files: [{ path: 'components/Fresh.tsx', kind: 'component', code: FRESH }],
    }) as any;
    expect(out.committed).toBe(true); // created without a read; guard does not fire
  });
});

// ─── editor-state gates (race + permission protection) ───────────────────────

import { afterEach } from 'vitest';
import { canvasInteractingAtom } from '@/code/stores/store';
import { isTextEditingAtom } from '@/code/stores/editor-store';
import { setViewerMode } from '@/code/stores/viewer-mode-store';

describe('createIconSet', () => {
  beforeEach(() => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE]]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
    resetReadTracker();
  });

  it('creates an icon set from raw SVGs via the drop pipeline (builder path, no oracle)', async () => {
    const res = (await bridgeHandlers.createIconSet({
      name: 'Test Pack',
      icons: [
        { label: 'square', text: '<svg viewBox="0 0 24 24"><path d="M2 2H22V22H2Z"/></svg>' },
        { label: 'junk', text: 'not svg at all' },
      ],
    })) as { iconSetFilePath: string; iconCount: number; skipped: string[] };
    expect(res.iconSetFilePath).toMatch(/^icons\/.+\.tsx$/);
    expect(res.iconCount).toBe(1);
    expect(res.skipped).toEqual(['junk (not SVG)']);
    const code = projectFS.readFile(res.iconSetFilePath)!;
    expect(code).toContain('@iconSet');
    expect(code).toContain('@name "Test Pack"');
  });

  it('rejects a missing name, an empty batch, and all-junk input', async () => {
    await expect(bridgeHandlers.createIconSet({ name: '', icons: [{ label: 'a', text: '<svg >' }] }))
      .rejects.toThrow('`name` is required');
    await expect(bridgeHandlers.createIconSet({ name: 'X', icons: [] }))
      .rejects.toThrow('non-empty');
    await expect(bridgeHandlers.createIconSet({ name: 'X', icons: [{ label: 'a', text: 'nope' }] }))
      .rejects.toThrow('valid SVG');
  });
});

describe('submitFiles — editor-state gates', () => {
  beforeEach(() => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE]]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
  });
  afterEach(() => {
    setViewerMode(false);
    getDefaultStore().set(canvasInteractingAtom, false);
    getDefaultStore().set(isTextEditingAtom, false);
  });

  const FILES = { files: [{ path: 'components/GateCard.tsx', kind: 'component' as const, code: CLEAN_COMPONENT.replace(/TestCard/g, 'GateCard') }] };

  it('rejects in viewer mode and writes nothing', async () => {
    setViewerMode(true);
    await expect(bridgeHandlers.submitFiles(FILES)).rejects.toThrow('view-only');
    expect(projectFS.readFile('components/GateCard.tsx')).toBeNull();
  });

  it('rejects mid-drag (canvasInteractingAtom)', async () => {
    getDefaultStore().set(canvasInteractingAtom, true);
    await expect(bridgeHandlers.submitFiles(FILES)).rejects.toThrow('mid-interaction');
    expect(projectFS.readFile('components/GateCard.tsx')).toBeNull();
  });

  it('rejects during a text-editing session', async () => {
    getDefaultStore().set(isTextEditingAtom, true);
    await expect(bridgeHandlers.submitFiles(FILES)).rejects.toThrow('text-editing');
    expect(projectFS.readFile('components/GateCard.tsx')).toBeNull();
  });

  it('commits normally once the gates clear', async () => {
    const out = await bridgeHandlers.submitFiles(FILES) as any;
    expect(out.committed).toBe(true);
    expect(projectFS.readFile('components/GateCard.tsx')).toContain('GateCard');
  });
});

// ─── preset management (design tokens in app/globals.css) ────────────────────

describe('managePresets', () => {
  beforeEach(() => {
    resetProjectFS(new Map([
      [PAGE_PATH, PAGE],
      ['app/globals.css', ':root {\n  --color-existing: #111111;\n}\n'],
    ]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
  });

  it('lists tokens with categories', async () => {
    const out = await bridgeHandlers.managePresets({ action: 'list' }) as any;
    expect(out.tokens.map((t: any) => t.name)).toContain('color-existing');
  });

  it('set creates new tokens and updates existing ones in globals.css', async () => {
    const out = await bridgeHandlers.managePresets({
      action: 'set',
      tokens: [
        { name: 'color-brand-red', value: '#e52521', category: 'color', label: 'Brand Red' },
        { name: 'color-existing', value: '#222222' },
      ],
    }) as any;
    expect(out.written).toEqual(['color-brand-red', 'color-existing']);
    const css = projectFS.readFile('app/globals.css')!;
    expect(css).toContain('--color-brand-red: #e52521;');
    expect(css).toContain('--color-existing: #222222;');
  });

  it('rejects non-kebab names and empty values', async () => {
    await expect(bridgeHandlers.managePresets({ action: 'set', tokens: [{ name: 'BrandRed', value: '#fff' }] }))
      .rejects.toThrow('kebab-case');
    await expect(bridgeHandlers.managePresets({ action: 'set', tokens: [{ name: 'color-x', value: '  ' }] }))
      .rejects.toThrow('empty value');
  });

  it('refuses to remove a token still used by an element', async () => {
    projectFS.writeFile(PAGE_PATH, PAGE.replace(
      "width: '100%' }}",
      "width: '100%', backgroundColor: 'var(--color-existing)' }}",
    ));
    await expect(bridgeHandlers.managePresets({ action: 'remove', names: ['color-existing'] }))
      .rejects.toThrow('still used');
    expect(projectFS.readFile('app/globals.css')).toContain('--color-existing');
  });

  it('removes an unused token', async () => {
    const out = await bridgeHandlers.managePresets({ action: 'remove', names: ['color-existing'] }) as any;
    expect(out.removed).toEqual(['color-existing']);
    expect(projectFS.readFile('app/globals.css')).not.toContain('--color-existing');
  });
});

// ─── CMS management (collections + builder-scaffolded pages) ─────────────────

describe('manageCms — the "make me a blog" flow end-to-end', () => {
  beforeEach(() => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE]]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
  });

  it('create_collection → add_field → add_item → create_pages → scaffolds pass the gate', async () => {
    const created = await bridgeHandlers.manageCms({ action: 'create_collection', args: { name: 'Blog' } }) as any;
    expect(created.slug).toBeTruthy();
    const slug = created.slug;

    await bridgeHandlers.manageCms({ action: 'add_field', args: { collection: slug, name: 'Title', type: 'text' } });
    await bridgeHandlers.manageCms({ action: 'add_field', args: { collection: slug, name: 'Body', type: 'richtext' } });

    const schema = await bridgeHandlers.manageCms({ action: 'get_collection', args: { collection: slug } }) as any;
    const fieldIds = (schema.fields ?? schema.schema?.fields ?? []).map((f: any) => f.id);
    expect(fieldIds.length).toBeGreaterThanOrEqual(2);

    // Field values are PURE text (assertPureTextValues, user rule 2026-07-30)
    // — markup like `<p>…</p>` is rejected; paragraphs are blank lines.
    const item = await bridgeHandlers.manageCms({
      action: 'add_item',
      args: { collection: slug, values: { [fieldIds[0]]: 'First post', [fieldIds[1]]: 'Hello world.\n\nSecond paragraph.' } },
    }) as any;
    expect(item.error).toBeUndefined();

    const pages = await bridgeHandlers.manageCms({ action: 'create_pages', args: { collection: slug, kind: 'both' } }) as any;
    expect(pages.written).toHaveLength(2);

    // The builder's own scaffolds must pass a no-op gate resubmit (prime rule).
    const { gateTurnFiles } = await import('@/ai/freeform/freeform-client');
    for (const path of pages.written) {
      const code = projectFS.readFile(path)!;
      const { violations } = gateTurnFiles([{ path, kind: 'page', code }], path);
      expect(violations.map((v: any) => `${path}: ${v.code} ${v.message}`)).toEqual([]);
    }

    // Context exposes the collection.
    const ctx = await bridgeHandlers.getContext({}) as any;
    expect(ctx.collections.map((c: any) => c.slug)).toContain(slug);
    expect(ctx.collections.find((c: any) => c.slug === slug).itemCount).toBe(1);
  });

  it('create_pages refuses a nonexistent collection', async () => {
    await expect(bridgeHandlers.manageCms({ action: 'create_pages', args: { collection: 'ghost' } }))
      .rejects.toThrow('does not exist');
  });

  it('viewer mode blocks writes but allows reads', async () => {
    setViewerMode(true);
    const list = await bridgeHandlers.manageCms({ action: 'list_collections' }) as any;
    expect(list).toBeTruthy();
    await expect(bridgeHandlers.manageCms({ action: 'create_collection', args: { name: 'X' } }))
      .rejects.toThrow('view-only');
    setViewerMode(false);
  });
});

// ─── uploadImage (localize an external image into the user's quota'd storage) ─

describe('uploadImage', () => {
  // base64("hello") — 5 bytes; lets us assert the decoded File round-trips.
  const HELLO_B64 = 'aGVsbG8=';

  beforeEach(() => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE]]));
    setViewerMode(false);
    // getProjectId() reads window.location — put us on a real builder URL so
    // the standalone/local guard doesn't trip on the happy path.
    window.history.pushState({}, '', '/builder/proj123');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('decodes base64 and uploads through backend.uploadAsset with the website id', async () => {
    const spy = vi.spyOn(backend, 'uploadAsset').mockResolvedValue('https://assets.revyme.app/u/proj123/images/x.webp');
    const out = await bridgeHandlers.uploadImage({ dataBase64: HELLO_B64, contentType: 'image/webp', filename: 'sphere.webp' }) as any;
    expect(out.url).toBe('https://assets.revyme.app/u/proj123/images/x.webp');
    expect(spy).toHaveBeenCalledTimes(1);
    const [projectId, file] = spy.mock.calls[0];
    expect(projectId).toBe('proj123');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('sphere.webp');
    expect(file.type).toBe('image/webp');
    expect(file.size).toBe(5); // "hello"
  });

  it('defaults type to image/webp and derives a filename when none is given', async () => {
    const spy = vi.spyOn(backend, 'uploadAsset').mockResolvedValue('https://cdn/y.webp');
    await bridgeHandlers.uploadImage({ dataBase64: HELLO_B64 });
    const file = spy.mock.calls[0][1];
    expect(file.type).toBe('image/webp');
    expect(file.name).toBe('asset.webp');
  });

  it('throws when dataBase64 is missing (server downloads URLs; the bridge only takes bytes)', async () => {
    await expect(bridgeHandlers.uploadImage({})).rejects.toThrow('dataBase64 required');
  });

  it('throws in standalone/local mode (no website = no storage)', async () => {
    window.history.pushState({}, '', '/'); // getProjectId() → 'local'
    await expect(bridgeHandlers.uploadImage({ dataBase64: HELLO_B64 })).rejects.toThrow('No website is open');
  });

  it('is blocked in viewer mode', async () => {
    setViewerMode(true);
    await expect(bridgeHandlers.uploadImage({ dataBase64: HELLO_B64 })).rejects.toThrow('view-only');
    setViewerMode(false);
  });

  it('lets the storage-cap error bubble (model reports out-of-storage, does not retry)', async () => {
    vi.spyOn(backend, 'uploadAsset').mockRejectedValue(new Error('Storage limit reached for this plan.'));
    await expect(bridgeHandlers.uploadImage({ dataBase64: HELLO_B64 })).rejects.toThrow('Storage limit reached');
  });
});

describe('managePresets — set_typography (compound family via the builder template)', () => {
  beforeEach(() => {
    resetProjectFS(new Map([[PAGE_PATH, PAGE], ['app/globals.css', ':root {\n}\n']]));
    getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
  });

  it('creates the full --typo-<name>-* family with overrides and responsive tiers', async () => {
    const out = await bridgeHandlers.managePresets({
      action: 'set_typography',
      name: 'display',
      tag: 'h1',
      values: { font: "'Anton', sans-serif", weight: '900', size: '72px', 'size-md': '48px', 'size-sm': '36px' },
    }) as any;
    const css = projectFS.readFile('app/globals.css')!;
    expect(css).toContain("--typo-display-font: 'Anton', sans-serif;");
    expect(css).toContain('--typo-display-weight: 900;');
    expect(css).toContain('--typo-display-size: 72px;');
    expect(css).toContain('--typo-display-size-md: 48px;');
    expect(css).toContain('--typo-display-size-sm: 36px;');
    expect(css).toContain('--typo-display-tag: h1;');
    expect(css).toContain('--typo-display-min-default: 1200;');
    expect(css).toContain('--typo-display-min-md: 600;');
    expect(out.applyGuide).toContain('var(--typo-display-font)');
  });

  it('rejects unknown suffixes with the valid list', async () => {
    await expect(bridgeHandlers.managePresets({
      action: 'set_typography', name: 'display', values: { fontsize: '72px' },
    })).rejects.toThrow('Unknown typography suffix');
  });

  it('a second call UPDATES the family in place (no duplicate lines)', async () => {
    await bridgeHandlers.managePresets({ action: 'set_typography', name: 'display', values: { size: '72px' } });
    await bridgeHandlers.managePresets({ action: 'set_typography', name: 'display', values: { size: '64px' } });
    const css = projectFS.readFile('app/globals.css')!;
    expect(css).toContain('--typo-display-size: 64px;');
    expect([...css.matchAll(/--typo-display-size:/g)]).toHaveLength(1);
  });

  it('the gate accepts a page applying the family (UNKNOWN_TOKEN stays silent)', async () => {
    await bridgeHandlers.managePresets({
      action: 'set_typography', name: 'display', values: { 'size-md': '48px' },
    });
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    <h1 data-id="hero-title" data-name="Title" style={{ position: 'relative', fontFamily: 'var(--typo-display-font)', fontSize: 'var(--typo-display-size)', fontWeight: 'var(--typo-display-weight)', color: 'var(--typo-display-color)', lineHeight: 'var(--typo-display-line-height)', margin: '0px' }}>Hello</h1>
    <style>{\`@media (max-width: 1199px){ [data-id="hero-title"] { font-size: var(--typo-display-size-md); } }\`}</style>
  </div>;
}`;
    const { gateTurnFiles } = await import('@/ai/freeform/freeform-client');
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: page }], PAGE_PATH);
    expect(violations).toEqual([]);
  });
});

// ── publishListing — the New Component modal as one bridge call ────────────
vi.mock('@/cloud/components/component-share', () => ({
  shareComponent: vi.fn(async () => ({
    success: true,
    url: 'https://assets.revyme.app/components/TestCard@abc123def456.js',
    version: 'abc123def456',
  })),
}));

describe('publishListing', () => {
  const COMPONENT = `'use client';
/** @label "Test Card" */
/** @comment "x" */
/** @defaultWidth 400 */
/** @defaultHeight 300 */
/** @controls { "speed": { "type": "number", "label": "Speed", "default": 1 } } */
import { withResponsiveProps } from '@revyme/runtime';
function TestCard(props) { return <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', ...props.style }} />; }
export default withResponsiveProps(TestCard);
`;

  beforeEach(() => {
    resetProjectFS(new Map([['components/TestCard.tsx', COMPONENT]]));
    vi.unstubAllGlobals();
  });

  it('shares the file, creates the listing, and publishes it', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      if (url.startsWith('/api/creator/components?')) {
        return { ok: true, status: 200, json: async () => ({ components: [] }) } as any;
      }
      if (url === '/api/creator/components') {
        return { ok: true, status: 201, json: async () => ({ id: 'row-1', status: 'draft', thumbnail_url: 'https://cdn/t.jpg' }) } as any;
      }
      if (url === '/api/creator/components/row-1/publish') {
        return { ok: true, status: 200, json: async () => ({ id: 'row-1', status: 'pending' }) } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const out = await bridgeHandlers.publishListing({
      path: 'components/TestCard.tsx',
      name: 'Test Card',
      byline: 'A test card',
      category: 'Cards',
      tags: ['Hover', 'Motion'],
      thumbnailUrl: 'https://cdn/t.jpg',
    }) as any;

    expect(out.action).toBe('created');
    expect(out.status).toBe('pending');
    expect(out.componentUrl).toContain('@abc123def456.js');
    const create = calls.find((c) => c.url === '/api/creator/components');
    expect(create!.body.tags).toBe('Hover, Motion');
    expect(create!.body.version_hash).toBe('abc123def456');
    expect(calls.some((c) => c.url === '/api/creator/components/row-1/publish')).toBe(true);
  });

  it('updates the existing listing (same name) and reports a staged code update', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url.startsWith('/api/creator/components?')) {
        return { ok: true, status: 200, json: async () => ({ components: [{ id: 'row-9', name: 'Test Card', status: 'approved', component_url: 'https://old', thumbnail_url: 'https://cdn/t.jpg', pending_status: null }] }) } as any;
      }
      if (url === '/api/creator/components/row-9' && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ id: 'row-9', status: 'approved', pending_status: 'pending' }) } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const out = await bridgeHandlers.publishListing({
      path: 'components/TestCard.tsx',
      name: 'Test Card',
    }) as any;

    expect(out.action).toBe('updated');
    expect(out.pendingUpdate).toBe(true);
    expect(out.notes.join(' ')).toContain('staged');
  });

  it('rejects when the editor session is signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as any));
    await expect(bridgeHandlers.publishListing({ path: 'components/TestCard.tsx', name: 'X' })).rejects.toThrow('Not signed in');
  });
});
