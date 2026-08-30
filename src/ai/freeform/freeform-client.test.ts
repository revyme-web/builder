import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runFreeformEdit, formatBounce } from './freeform-client';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

const FILE = 'components/TestCard.tsx';

const ORIGINAL = `import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function TestCard({ style }: { style?: React.CSSProperties }) {
  return <div data-id="card" style={{ display: 'flex', ...style }} />;
}
export default withResponsiveProps(TestCard);
`;

/** Dialect-compliant — passes checkFile. */
const CLEAN = `import React from 'react';
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

/** Violates the dialect — className + transition. */
const SINNER = `import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function TestCard({ style }: { style?: React.CSSProperties }) {
  return <div data-id="card" className="p-6" style={{ transition: 'all .3s', ...style }} />;
}
export default withResponsiveProps(TestCard);
`;

// The client runs each attempt as a JOB: POST /api/freeform/job → { jobId },
// then polls GET /api/freeform/job/:id until a settled payload comes back.
// One response body carrying BOTH `jobId` and the settled result satisfies
// both calls, so every mocked attempt is simply the same response twice
// (POST accept, then the one poll that finds it done).
function fetchOk(payload: { code: string; text?: string }) {
  return {
    ok: true,
    json: async () => ({ jobId: 'job-1', success: true, files: [{ path: '', kind: 'component', code: payload.code }], text: payload.text ?? 'done', usage: { inputTokens: 10, outputTokens: 20, durationMs: 100 } }),
  } as Response;
}

function fetchOkFiles(files: Array<{ path: string; kind: string; code: string }>, text = 'done') {
  return {
    ok: true,
    json: async () => ({ jobId: 'job-1', success: true, files, text, usage: { inputTokens: 10, outputTokens: 20, durationMs: 100 } }),
  } as Response;
}

/** Queue one full job round trip (submit + poll) on the fetch mock. */
function enqueueTurn(fetchMock: ReturnType<typeof vi.fn>, res: Response) {
  fetchMock.mockResolvedValueOnce(res).mockResolvedValueOnce(res);
}

/** POST bodies only — poll GETs carry no body and would JSON.parse-crash. */
function postBodies(fetchMock: ReturnType<typeof vi.fn>): any[] {
  return fetchMock.mock.calls
    .filter((c) => c[1]?.body != null)
    .map((c) => JSON.parse(c[1].body));
}

/** Drive runFreeformEdit under fake timers — the poll loop sleeps
 *  POLL_INTERVAL_MS between requests, which would make every test wait
 *  real seconds otherwise. */
async function runEdit(req: Parameters<typeof runFreeformEdit>[0]) {
  vi.useFakeTimers();
  try {
    let settled = false;
    const p = runFreeformEdit(req).finally(() => { settled = true; });
    while (!settled) await vi.advanceTimersByTimeAsync(500);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

describe('formatBounce', () => {
  it('strips violations down to the wire shape', () => {
    expect(formatBounce([{ code: 'X', message: 'm', tier: 2 }])).toEqual([{ code: 'X', message: 'm' }]);
  });
});

describe('runFreeformEdit', () => {
  beforeEach(() => {
    resetProjectFS(new Map([[FILE, ORIGINAL]]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies a clean first attempt and reports success', async () => {
    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOk({ code: CLEAN, text: 'Built the card' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'card', activeFilePath: FILE, kind: 'component' });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.text).toBe('Built the card');
    // the write pipeline may normalize (e.g. prepend 'use client') — assert content
    expect(projectFS.readFile(FILE)).toContain('data-id="label"');
    expect(projectFS.readFile(FILE)).toContain('motion.div');
  });

  it("injects explicit width/height: 'auto' into sizeless nodes on COMMIT", async () => {
    // CLEAN's card + label both omit width/height — the commit normalizer fills them so
    // the source is never sizeless (make-component / resize need a real value).
    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOk({ code: CLEAN, text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await runEdit({ prompt: 'card', activeFilePath: FILE, kind: 'component' });
    const committed = projectFS.readFile(FILE)!;
    expect((committed.match(/width: 'auto'/g) || []).length).toBe(2);   // card + label
    expect((committed.match(/height: 'auto'/g) || []).length).toBe(2);
    // existing values + the instance spread are preserved
    expect(committed).toContain("padding: '24px'");
    expect(committed).toContain('...style');
  });

  it('bounces violations and converges on attempt 2 — the wire carries the previous attempt + violations', async () => {
    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOk({ code: SINNER }));
    enqueueTurn(fetchMock, fetchOk({ code: CLEAN }));
    vi.stubGlobal('fetch', fetchMock);

    const attempts: number[] = [];
    const result = await runEdit({
      prompt: 'card', activeFilePath: FILE, kind: 'component',
      onAttempt: (a, vs) => { attempts.push(a); expect(vs.length).toBeGreaterThan(0); },
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(attempts).toEqual([1]);
    expect(projectFS.readFile(FILE)).toContain('data-id="label"');
    expect(projectFS.readFile(FILE)).not.toContain('className');

    // second SUBMIT carried the bounce payload (calls interleave with polls)
    const secondBody = postBodies(fetchMock)[1];
    expect(secondBody.previousAttempt).toBe(SINNER);
    expect(secondBody.violations.map((v: { code: string }) => v.code)).toContain('CLASSNAME_STYLING');
  });

  it('gives up after MAX_ATTEMPTS, never writes the file, and reports the violations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fetchOk({ code: SINNER }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'card', activeFilePath: FILE, kind: 'component' });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toContain('after 3 attempts');
    expect(result.violations?.length).toBeGreaterThan(0);
    expect(projectFS.readFile(FILE)).toBe(ORIGINAL); // untouched
  });

  it('discards a passing result if the user switched files mid-generation', async () => {
    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOk({ code: CLEAN }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({
      prompt: 'card', activeFilePath: FILE, kind: 'component',
      isStillActive: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('switched files');
    expect(projectFS.readFile(FILE)).toBe(ORIGINAL); // untouched
  });

  it('multi-file turn: creates the component AND updates the page, atomic write, both gated', async () => {
    const PAGE_PATH = 'app/home/page.client.tsx';
    const PAGE_BEFORE = `'use client';\n\n/** @canvas { "viewports": [], "positions": {} } */\n\nimport React from 'react';\n\nexport default function Page() {\n  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;\n}`;
    const PAGE_AFTER = PAGE_BEFORE
      .replace("import React from 'react';", "import React from 'react';\nimport FlMeBu from '@/components/FlMeBu';")
      .replace('style={{ position: \'relative\', width: \'100%\' }} />', 'style={{ position: \'relative\', width: \'100%\', display: \'flex\', flexDirection: \'column\' }}>\n    <FlMeBu data-id="flower-menu-1" data-name="Flower Menu" style={{ position: \'relative\' }} />\n  </div>');
    resetProjectFS(new Map([[PAGE_PATH, PAGE_BEFORE]]));

    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOkFiles([
      { path: 'components/FlMeBu.tsx', kind: 'component', code: CLEAN.replace(/TestCard/g, 'FlMeBu') },
      { path: PAGE_PATH, kind: 'page', code: PAGE_AFTER },
    ], 'Created the flower menu and placed it'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'make a flower menu component here', activeFilePath: PAGE_PATH, kind: 'page' });

    expect(result.success).toBe(true);
    expect(result.written).toEqual(['components/FlMeBu.tsx', PAGE_PATH]);
    expect(projectFS.readFile('components/FlMeBu.tsx')).toContain('withResponsiveProps(FlMeBu)');
    expect(projectFS.readFile(PAGE_PATH)).toContain("import FlMeBu from '@/components/FlMeBu'");
  });

  it('remaps a phantom page path to the active page (model invented "page.client.tsx")', async () => {
    const PAGE_PATH = 'app/home/page.client.tsx';
    const PAGE_BEFORE = `'use client';\n\n/** @canvas { "viewports": [], "positions": {} } */\n\nimport React from 'react';\n\nexport default function Page() {\n  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;\n}`;
    const PAGE_AFTER = PAGE_BEFORE.replace('width: \'100%\' }} />', 'width: \'100%\', display: \'flex\', flexDirection: \'column\' }}><p data-id="hello" data-name="Hello">Hi</p></div>');
    resetProjectFS(new Map([[PAGE_PATH, PAGE_BEFORE]]));

    const fetchMock = vi.fn();
    enqueueTurn(fetchMock, fetchOkFiles([
      { path: 'page.client.tsx', kind: 'page', code: PAGE_AFTER }, // wrong, invented path
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'add hello', activeFilePath: PAGE_PATH, kind: 'page' });

    expect(result.success).toBe(true);
    expect(result.written).toEqual([PAGE_PATH]);            // remapped, not phantom
    expect(projectFS.readFile('page.client.tsx')).toBeNull(); // no stray file
    expect(projectFS.readFile(PAGE_PATH)).toContain('data-id="hello"');
    // and the request told the server the real path
    const body = postBodies(fetchMock)[0];
    expect(body.currentPath).toBe(PAGE_PATH);
  });

  it('bounces a page that imports a component missing from both the project and the batch', async () => {
    const PAGE_PATH = 'app/home/page.client.tsx';
    const PAGE_BAD = `'use client';\n\n/** @canvas { "viewports": [], "positions": {} } */\n\nimport React from 'react';\nimport GhostComp from '@/components/GhostComp';\n\nexport default function Page() {\n  return <div data-id="root" data-name="Page" style={{ position: 'relative' }}>\n    <GhostComp data-id="ghost-1" data-name="Ghost" style={{ position: 'relative' }} />\n  </div>;\n}`;
    resetProjectFS(new Map([[PAGE_PATH, 'old']]));

    const fetchMock = vi.fn().mockResolvedValue(fetchOkFiles([{ path: PAGE_PATH, kind: 'page', code: PAGE_BAD }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'add ghost', activeFilePath: PAGE_PATH, kind: 'page' });

    expect(result.success).toBe(false);
    expect(result.violations?.some((x) => x.code === 'COMPONENT_IMPORT_MISSING')).toBe(true);
    expect(projectFS.readFile(PAGE_PATH)).toBe('old'); // atomic: nothing written
    // the bounce wire carried the missing-component teaching
    const lastBody = postBodies(fetchMock)[1];
    expect(lastBody.violations.some((x: { code: string }) => x.code === 'COMPONENT_IMPORT_MISSING')).toBe(true);
  });

  it('gates a layout file as a TEMPLATE by path — deleting {children} bounces even when the model calls it a page', async () => {
    const LAYOUT_PATH = 'app/(header)/LayoutClient.tsx';
    const LAYOUT_BEFORE = `'use client';\n\n/** @canvas { "viewports": [], "positions": {} } */\n\nexport default function LayoutClient({ children }: { children: React.ReactNode }) {\n  return <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%' }}>{children}</div>;\n}`;
    const LAYOUT_BROKEN = LAYOUT_BEFORE.replace('{children}', '');
    resetProjectFS(new Map([[LAYOUT_PATH, LAYOUT_BEFORE]]));

    const fetchMock = vi.fn().mockResolvedValue(fetchOkFiles([{ path: LAYOUT_PATH, kind: 'page', code: LAYOUT_BROKEN }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'redesign template', activeFilePath: LAYOUT_PATH, kind: 'page' });

    expect(result.success).toBe(false);
    expect(result.violations?.some((x) => x.code === 'TEMPLATE_CHILDREN_MISSING')).toBe(true);
    expect(projectFS.readFile(LAYOUT_PATH)).toBe(LAYOUT_BEFORE); // slot intact, nothing written
  });

  it('surfaces server errors without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'model exploded' }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runEdit({ prompt: 'card', activeFilePath: FILE, kind: 'component' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('model exploded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── the gate itself (shared by the freeform loop and the MCP bridge) ─────────

import { gateTurnFiles, commitTurnFiles } from './freeform-client';
import { getHistoryState } from '@/code/mutation/history';

describe('gateTurnFiles — path discipline + stateful guards', () => {
  const PAGE_PATH = 'app/page.client.tsx';
  const PAGE = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;
}`;
  const SERVER_LAYOUT = `import './globals.css';
export const metadata = { title: 'Site' };
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}`;

  beforeEach(() => {
    resetProjectFS(new Map([
      [PAGE_PATH, PAGE],
      ['app/layout.tsx', SERVER_LAYOUT],
      ['app/(Header)/LayoutClient.tsx', `'use client';\nexport default function LayoutClient({ children }) { return <div data-id="root">{children}</div>; }`],
    ]));
  });

  it('CLOSES THE TEMPLATE-CLOBBER HOLE: component kind cannot land on a LayoutClient path', () => {
    const { violations } = gateTurnFiles(
      [{ path: 'app/(Header)/LayoutClient.tsx', kind: 'component', code: CLEAN }],
      null,
    );
    expect(violations.map((v) => v.code)).toContain('COMPONENT_PATH_SHAPE');
  });

  it('blocks the server layout.tsx shell from page submissions', () => {
    const { violations } = gateTurnFiles(
      [{ path: 'app/layout.tsx', kind: 'page', code: PAGE }],
      PAGE_PATH,
    );
    expect(violations.map((v) => v.code)).toContain('PROTECTED_PATH');
  });

  it('blocks component writes into builder-owned areas (lib/, icons/)', () => {
    for (const path of ['lib/withResponsiveProps.tsx', 'icons/SeYuSe.tsx']) {
      const { violations } = gateTurnFiles([{ path, kind: 'component', code: CLEAN }], null);
      expect(violations.map((v) => v.code)).toContain('COMPONENT_PATH_SHAPE');
    }
  });

  it('a no-op resubmit of the current page passes with zero violations (prime rule)', () => {
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: PAGE }], PAGE_PATH);
    expect(violations).toEqual([]);
  });

  it('bounces a page rewrite that edits the @canvas block', () => {
    const edited = PAGE.replace('"width": 1440', '"width": 1280');
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: edited }], PAGE_PATH);
    expect(violations.map((v) => v.code)).toContain('CANVAS_CONFIG_DESTROYED');
  });

  it('passes the oracle the file PATH so name/file mismatches bounce', () => {
    const { violations } = gateTurnFiles(
      [{ path: 'components/WrongName.tsx', kind: 'component', code: CLEAN }],
      null,
    );
    expect(violations.map((v) => v.code)).toContain('COMPONENT_NAME_MATCHES_FILE');
  });
});

describe('commitTurnFiles — undo history', () => {
  it('pushes ONE undo entry for the batch (empty-queue flushNow never does)', () => {
    resetProjectFS(new Map());
    const before = getHistoryState().undoSize;
    commitTurnFiles([{ path: 'components/UndoCard.tsx', kind: 'component', code: CLEAN }]);
    const after = getHistoryState();
    expect(after.undoSize).toBe(before + 1);
    expect(after.canUndo).toBe(true);
  });
});

describe('commitTurnFiles — form relay route ensure', () => {
  it('materializes app/api/form/route.ts when a committed file carries data-form', () => {
    resetProjectFS(new Map());
    const FORM_PAGE = CLEAN.replace(
      '<motion.p data-id="label"',
      `<form onSubmit={() => {}} data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"a@b.c"}]}' data-id="contact-form"></form><motion.p data-id="label"`,
    );
    expect(FORM_PAGE).toContain('data-form=');
    commitTurnFiles([{ path: 'app/page.client.tsx', kind: 'page', code: FORM_PAGE }]);
    expect(projectFS.readFile('app/api/form/route.ts')).toContain('REVYME_FORMS_URL');
  });

  it('does NOT create the route for a formless batch', () => {
    resetProjectFS(new Map());
    commitTurnFiles([{ path: 'components/NoForm.tsx', kind: 'component', code: CLEAN.replace(/TestCard/g, 'NoForm') }]);
    expect(projectFS.readFile('app/api/form/route.ts')).toBeNull();
  });
});

describe('commitTurnFiles — fixed-header layoutScroll normalization', () => {
  it('injects layoutScroll + layout="size" conditional on a layout-animated component root', () => {
    resetProjectFS(new Map());
    commitTurnFiles([{ path: 'components/Header.tsx', kind: 'component', code: CLEAN.replace(/TestCard/g, 'Header') }]);
    const out = projectFS.readFile('components/Header.tsx')!;
    expect(out).toContain('layoutScroll={(');
    expect(out).toContain(`? "size" : true}`);
    expect(out).toContain("position === 'fixed'");
  });

  it('leaves a static (non-motion) component root untouched', () => {
    resetProjectFS(new Map());
    // ORIGINAL has a plain <div> root (no motion) — must not get framer-motion props.
    commitTurnFiles([{ path: 'components/Static.tsx', kind: 'component', code: ORIGINAL.replace(/TestCard/g, 'Static') }]);
    const out = projectFS.readFile('components/Static.tsx')!;
    expect(out).not.toContain('layoutScroll');
  });
});

describe('commitTurnFiles — cursor portal auto-mount (layout.tsx is builder-owned)', () => {
  const CURSOR_PAGE_PATH = 'app/page.client.tssx'.replace('tssx', 'tsx');
  const CURSOR_PAGE = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import { withCursor } from '@revyme/runtime';
import Pointer from '@/components/Pointer';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="cta" data-name="CTA" {...withCursor(Pointer, { mode: 'follow' })} style={{ display: 'flex' }} />
  </div>;
}`;

  it('creates app/layout.tsx and mounts <CursorPortal /> when a committed file uses withCursor', () => {
    resetProjectFS(new Map());
    commitTurnFiles([{ path: CURSOR_PAGE_PATH, kind: 'page', code: CURSOR_PAGE }]);
    const layout = projectFS.readFile('app/layout.tsx');
    expect(layout).toBeTruthy();
    expect(layout).toContain('<CursorPortal />');
    expect(layout).toContain("import { CursorPortal } from '@revyme/runtime'");
  });

  it('is idempotent — a second cursor commit leaves exactly one portal', () => {
    resetProjectFS(new Map());
    commitTurnFiles([{ path: CURSOR_PAGE_PATH, kind: 'page', code: CURSOR_PAGE }]);
    commitTurnFiles([{ path: CURSOR_PAGE_PATH, kind: 'page', code: CURSOR_PAGE }]);
    const layout = projectFS.readFile('app/layout.tsx')!;
    expect([...layout.matchAll(/<CursorPortal \/>/g)]).toHaveLength(1);
  });

  it('does not touch layout for cursor-free commits', () => {
    resetProjectFS(new Map());
    commitTurnFiles([{ path: 'components/Plain.tsx', kind: 'component', code: CLEAN.replace(/TestCard/g, 'Plain') }]);
    expect(projectFS.readFile('app/layout.tsx')).toBeNull();
  });
});

describe('gateTurnFiles — UNKNOWN_TOKEN (presets must exist in globals.css)', () => {
  const PAGE_PATH = 'app/page.client.tsx';
  const tokenPage = (value: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', backgroundColor: '${value}' }} />;
}`;

  it('bounces a page referencing a token globals.css does not have', () => {
    resetProjectFS(new Map([[PAGE_PATH, tokenPage('#ffffff')]]));
    const { violations } = gateTurnFiles(
      [{ path: PAGE_PATH, kind: 'page', code: tokenPage('var(--color-ghost)') }], PAGE_PATH,
    );
    expect(violations.map((v) => v.code)).toContain('UNKNOWN_TOKEN');
  });

  it('passes when the token exists', () => {
    resetProjectFS(new Map([
      [PAGE_PATH, tokenPage('#ffffff')],
      ['app/globals.css', ':root {\n  --color-ghost: #efefef;\n}\n'],
    ]));
    const { violations } = gateTurnFiles(
      [{ path: PAGE_PATH, kind: 'page', code: tokenPage('var(--color-ghost)') }], PAGE_PATH,
    );
    expect(violations).toEqual([]);
  });
});

describe('gateTurnFiles — CMS imports must resolve', () => {
  const PAGE_PATH = 'app/page.client.tsx';
  const cmsPage = (slug: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import posts from '@/cms/${slug}.json';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    {posts.map((item, idx) => (<p data-id="row" key={idx} style={{ color: '#111111' }}>{item.title}</p>))}
  </div>;
}`;

  it('bounces an import of a collection that does not exist', () => {
    resetProjectFS(new Map([[PAGE_PATH, `'use client';\nexport default function Page() { return <div data-id="root" />; }`]]));
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: cmsPage('ghost-blog') }], PAGE_PATH);
    expect(violations.map((v) => v.code)).toContain('CMS_IMPORT_MISSING');
  });

  it('passes when the collection exists (and DUP_DATA_ID does not fire on the map template)', () => {
    resetProjectFS(new Map([
      [PAGE_PATH, `'use client';\nexport default function Page() { return <div data-id="root" />; }`],
      ['cms/ghost-blog.json', '[]'],
    ]));
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: cmsPage('ghost-blog') }], PAGE_PATH);
    expect(violations.map((v) => v.code)).not.toContain('CMS_IMPORT_MISSING');
  });

  it('preservation: removing the @cmsPage annotation bounces', () => {
    const detail = `'use client';

/** @canvas { "viewports": [], "positions": {} } */
/** @cmsPage { "collection": "blog", "kind": "detail" } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;
}`;
    resetProjectFS(new Map([['app/blog/[slug]/page.client.tsx', detail]]));
    const { violations } = gateTurnFiles(
      [{ path: 'app/blog/[slug]/page.client.tsx', kind: 'page', code: detail.replace(/\/\*\* @cmsPage[^*]*\*\/\n/, '') }],
      null,
    );
    expect(violations.map((v) => v.code)).toContain('CMS_PAGE_META_DESTROYED');
  });
});
