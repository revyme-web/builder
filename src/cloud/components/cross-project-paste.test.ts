// cross-project-paste.test.ts — component linking for pastes that cross a
// project boundary: clipboard master capture, expanded-internal strip,
// alias-aware import injection, CDN link + local materialization fallback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));

// Live-binding mock so cloud/standalone paths are both testable.
// `vi.hoisted` because `vi.mock` factories are hoisted ABOVE plain `let`s: the
// getter would read `cloudFlag` in its temporal dead zone the moment any import
// chain evaluates `@/shared/cloud-flag` during module init (a TDZ ReferenceError
// that took down the whole file). Hoisting the state with the mock fixes the order.
const flag = vi.hoisted(() => ({ cloud: false }));
vi.mock('@/shared/cloud-flag', () => ({
  get CLOUD_ENABLED() { return flag.cloud; },
}));

import { projectFS } from '@/code/project/project-fs';
import { initMutationQueue, syncImports } from '@/code/mutation/mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import {
  isCrossProjectPaste, stripExpandedInternals, localImportPathFor,
  linkClipboardComponents, ensureLocalComponentImports, applyTagRenames,
} from './cross-project-paste';
import { ensureDefaultImport } from './component-paste';
import { captureComponentMasters, importMapFromSource } from '@/code/features/paste-engine/copy/capture-components';
import type { ClipboardData, ClipboardNode } from '@/code/features/paste-engine/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MASTER = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Badge from '@/components/Badge';
const variantConfig = { variants: [] };
function NuSuBi({ style }) { return <motion.div data-id="root" style={{ position: 'relative', ...style }}><Badge /></motion.div>; }
export default withResponsiveProps(NuSuBi);
`;
const BADGE = `import React from 'react';
export default function Badge() { return <span data-id="root" style={{ position: 'relative' }}>hi</span>; }
`;
const CODE_COMP = `import React from 'react';
export default function Marquee({ children, style }) { return <div data-id="root" style={{ position: 'relative', ...style }}>{children}</div>; }
`;
const TARGET_PAGE = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 }
  ]
} */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
    </div>
  );
}
`;

const node = (partial: Partial<ClipboardNode> & { id: string; type: string }): ClipboardNode => ({
  parentId: null, children: [], order: 0, styles: {}, ...partial,
});

function seedTarget(path = 'app/page.client.tsx'): void {
  projectFS.writeFile(path, TARGET_PAGE);
  setBumpVersion(() => {});
  initMutationQueue(TARGET_PAGE, (c) => projectFS.writeFile(path, c));
}

beforeEach(() => {
  flag.cloud = false;
  // Fresh-ish FS namespace per test — unique paths keep tests independent.
});
afterEach(() => vi.unstubAllGlobals());

// ─── stripExpandedInternals ──────────────────────────────────────────────────

describe('stripExpandedInternals', () => {
  it('drops expanded-master internals (colon ids) and scrubs child refs', () => {
    const nodes = [
      node({ id: 'NuSuBi-1', type: 'NuSuBi', children: ['NuSuBi-1:inner'] }),
      node({ id: 'NuSuBi-1:inner', type: 'div', parentId: 'NuSuBi-1' }),
      node({ id: 'div-2', type: 'div' }),
    ];
    const out = stripExpandedInternals(nodes);
    expect(out.map((n) => n.id)).toEqual(['NuSuBi-1', 'div-2']);
    expect(out[0]!.children).toEqual([]);
  });

  it('is a no-op passthrough when nothing is expanded', () => {
    const nodes = [node({ id: 'a', type: 'div', children: ['b'] }), node({ id: 'b', type: 'p', parentId: 'a' })];
    expect(stripExpandedInternals(nodes)).toBe(nodes);
  });
});

// ─── ensureDefaultImport ─────────────────────────────────────────────────────

describe('ensureDefaultImport', () => {
  const URL = 'https://assets.revyme.app/components/NuSuBi@abc123.js';

  it('inserts under the desired name when free — after the @canvas block, not inside it', () => {
    const { code, localName } = ensureDefaultImport(TARGET_PAGE, 'NuSuBi', URL);
    expect(localName).toBe('NuSuBi');
    expect(code).toContain(`import NuSuBi from "${URL}";`);
    // The canvas-config block must stay intact (insertion goes below it).
    expect(code.indexOf('@canvas')).toBeLessThan(code.indexOf(`import NuSuBi from "${URL}"`));
    expect(code.indexOf('"viewports"')).toBeLessThan(code.indexOf(`import NuSuBi from "${URL}"`));
  });

  it('reuses the existing local name when the specifier is already imported', () => {
    const withImport = TARGET_PAGE.replace("import React from 'react';", `import React from 'react';\nimport Renamed from "${URL}";`);
    const { code, localName } = ensureDefaultImport(withImport, 'NuSuBi', URL);
    expect(localName).toBe('Renamed');
    expect(code).toBe(withImport);
  });

  it('aliases on collision with a different import of the same name', () => {
    const withLocal = TARGET_PAGE.replace("import React from 'react';", "import React from 'react';\nimport NuSuBi from '@/components/NuSuBi';");
    const { code, localName } = ensureDefaultImport(withLocal, 'NuSuBi', URL);
    expect(localName).toBe('NuSuBiLinked');
    expect(code).toContain(`import NuSuBiLinked from "${URL}";`);
    // The project's own import is untouched.
    expect(code).toContain("import NuSuBi from '@/components/NuSuBi';");
  });

  it('aliases on collision with a local declaration', () => {
    const withConst = TARGET_PAGE.replace('export default function Page()', 'const NuSuBi = 1;\nexport default function Page()');
    const { localName } = ensureDefaultImport(withConst, 'NuSuBi', URL);
    expect(localName).toBe('NuSuBiLinked');
  });
});

// ─── capture (copy side) ─────────────────────────────────────────────────────

describe('captureComponentMasters', () => {
  it('captures a design master via componentFile, transitive deps included', () => {
    projectFS.writeFile('components/NuSuBi.tsx', MASTER);
    projectFS.writeFile('components/Badge.tsx', BADGE);
    const masters = captureComponentMasters(
      [node({ id: 'NuSuBi-1', type: 'NuSuBi', componentFile: 'components/NuSuBi.tsx' })],
      '',
    );
    expect(masters).toHaveLength(1);
    expect(masters[0]!.kind).toBe('design');
    expect(masters[0]!.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['components/NuSuBi.tsx', 'components/Badge.tsx']),
    );
  });

  it('resolves CODE components from the source file import lines (no componentFile)', () => {
    projectFS.writeFile('components/Marquee.tsx', CODE_COMP);
    const source = "import Marquee from '@/components/Marquee';\n";
    const masters = captureComponentMasters([node({ id: 'm1', type: 'Marquee' })], source);
    expect(masters).toHaveLength(1);
    expect(masters[0]!.kind).toBe('code');
    expect(masters[0]!.masterPath).toBe('components/Marquee.tsx');
  });

  it('skips motion.* / Link / lowercase tags and unresolvable tags', () => {
    const masters = captureComponentMasters(
      [
        node({ id: 'a', type: 'motion.div' }),
        node({ id: 'b', type: 'Link' }),
        node({ id: 'c', type: 'div' }),
        node({ id: 'd', type: 'MysteryComp' }),
      ],
      '',
    );
    expect(masters).toEqual([]);
  });

  it('importMapFromSource maps default imports for components and icons', () => {
    const map = importMapFromSource(
      "import Marquee from '@/components/Marquee';\nimport Zap from '@/icons/Zap';\nimport { motion } from 'framer-motion';",
    );
    expect(map.get('Marquee')).toBe('components/Marquee.tsx');
    expect(map.get('Zap')).toBe('icons/Zap.tsx');
    expect(map.has('motion')).toBe(false);
  });
});

// ─── detection ───────────────────────────────────────────────────────────────

describe('isCrossProjectPaste', () => {
  const withComponents = (sourceProjectId: string | null): ClipboardData => ({
    version: 1, timestamp: 0, nodes: [], sourceProjectId,
    components: [{ tagName: 'X', masterPath: 'components/X.tsx', kind: 'code', files: [{ path: 'components/X.tsx', content: 'x' }] }],
  });

  it('true when project ids differ and masters are present', () => {
    // jsdom pathname is '/', so getProjectId() → 'local'.
    expect(isCrossProjectPaste(withComponents('remote-abc'))).toBe(true);
  });

  it('false for same project, missing id, or no components', () => {
    expect(isCrossProjectPaste(withComponents('local'))).toBe(false);
    expect(isCrossProjectPaste(withComponents(null))).toBe(false);
    expect(isCrossProjectPaste({ version: 1, timestamp: 0, nodes: [], sourceProjectId: 'remote' })).toBe(false);
  });
});

// ─── linking (cloud) + materialization (standalone) ─────────────────────────

describe('linkClipboardComponents', () => {
  const DATA: ClipboardData = {
    version: 1, timestamp: 0,
    nodes: [node({ id: 'NuSuBi-1', type: 'NuSuBi' })],
    sourceProjectId: 'remote-abc',
    components: [{
      tagName: 'NuSuBi', masterPath: 'components/NuSuBi.tsx', kind: 'design',
      files: [
        { path: 'components/NuSuBi.tsx', content: MASTER },
        { path: 'components/Badge.tsx', content: BADGE },
      ],
    }],
  };

  it('CLOUD: shares the captured files and imports the CDN URL', async () => {
    flag.cloud = true;
    const target = 'app/link-cloud/page.client.tsx';
    seedTarget(target);
    const url = 'https://assets.revyme.app/components/NuSuBi@fff111.js';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, url, version: 'fff111' }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await linkClipboardComponents(DATA, target);

    expect(result.linked).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.tagRenames.size).toBe(0);
    // The share body carried the clipboard FILES (no projectFS walk at paste).
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(
      expect.arrayContaining(['components/NuSuBi.tsx', 'components/Badge.tsx']),
    );
    expect(projectFS.readFile(target)).toContain(`import NuSuBi from "${url}";`);
  });

  it('STANDALONE: materializes the bundle; syncImports auto-adds the import once the tag lands', async () => {
    flag.cloud = false;
    const target = 'app/link-local/page.client.tsx';
    seedTarget(target);

    const result = await linkClipboardComponents(DATA, target);

    expect(result.materialized).toBe(1);
    expect(result.tagRenames.size).toBe(0);
    expect(projectFS.readFile('components/NuSuBi.tsx')).toBe(MASTER);
    expect(projectFS.readFile('components/Badge.tsx')).toBe(BADGE);
    // The import is deliberately NOT pre-injected (syncImports would prune
    // it as unused before the nodes flush) — instead the flush that writes
    // the pasted `<NuSuBi>` auto-injects it. Simulate that flush pass:
    const pageWithTag = TARGET_PAGE.replace('</div>', '<NuSuBi data-id="n1" style={{ position: \'relative\' }} /></div>');
    expect(syncImports(pageWithTag)).toContain("import NuSuBi from '@/components/NuSuBi';");
  });

  it('CLOUD share failure degrades to local materialization, not a broken tag', async () => {
    flag.cloud = true;
    const target = 'app/link-degrade/page.client.tsx';
    seedTarget(target);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ success: false, error: 'nope' }) }));

    const result = await linkClipboardComponents(DATA, target);

    expect(result.linked).toBe(0);
    expect(result.materialized).toBe(1);
    expect(result.failed).toEqual([]);
    expect(projectFS.exists('components/NuSuBi.tsx')).toBe(true);
  });
});

// ─── same-project imports + rename application ───────────────────────────────

describe('ensureLocalComponentImports / applyTagRenames', () => {
  it('cross-PAGE paste: master present → no-op (syncImports owns the import); missing master → materialized', () => {
    projectFS.writeFile('components/Marquee.tsx', CODE_COMP);
    const target = 'app/other/page.client.tsx';
    seedTarget(target);
    const data: ClipboardData = {
      version: 1, timestamp: 0, nodes: [node({ id: 'm1', type: 'Marquee' })], sourceProjectId: 'local',
      components: [
        { tagName: 'Marquee', masterPath: 'components/Marquee.tsx', kind: 'code', files: [{ path: 'components/Marquee.tsx', content: CODE_COMP }] },
        { tagName: 'GhostComp', masterPath: 'components/GhostComp.tsx', kind: 'code', files: [{ path: 'components/GhostComp.tsx', content: CODE_COMP }] },
      ],
    };
    const renames = ensureLocalComponentImports(data, target);
    expect(renames.size).toBe(0);
    // Present master untouched; missing one materialized from the bundle.
    expect(projectFS.readFile('components/Marquee.tsx')).toBe(CODE_COMP);
    expect(projectFS.readFile('components/GhostComp.tsx')).toBe(CODE_COMP);
    // The flush that writes the pasted tags auto-injects both imports.
    const pageWithTags = TARGET_PAGE.replace('</div>', '<Marquee data-id="m1" style={{ position: \'relative\' }} /></div>');
    expect(syncImports(pageWithTags)).toContain("import Marquee from '@/components/Marquee';");
  });

  it('applyTagRenames rewrites only renamed tags', () => {
    const nodes = [node({ id: 'a', type: 'NuSuBi' }), node({ id: 'b', type: 'div' })];
    const out = applyTagRenames(nodes, new Map([['NuSuBi', 'NuSuBiLinked']]));
    expect(out[0]!.type).toBe('NuSuBiLinked');
    expect(out[1]!.type).toBe('div');
    expect(applyTagRenames(nodes, new Map())).toBe(nodes);
  });

  it('localImportPathFor strips the extension', () => {
    expect(localImportPathFor('components/NuSuBi.tsx')).toBe('@/components/NuSuBi');
    expect(localImportPathFor('icons/Zap.tsx')).toBe('@/icons/Zap');
  });
});
