// src/ai/agent/tools/component-golden.test.ts
//
// GOLDEN FILES for the component-instance tools (add_component_instance,
// set_component_prop). The unit contract lives in semantic-structure.test.ts
// (mutation shape, prop filtering, required-prop reporting, error paths).
// THIS suite proves what the produced MUTATIONS become in the project:
//
//   tool.execute()             (REAL — ./semantic-structure)
//     → captured Mutation     (queue entry points are mocked + spied)
//     → REAL generator        (addNodeInCode / updateHtmlAttrsInCode /
//                              removeNodeInCode)
//     → REAL import sync      (syncImports — the queue's drop-path step that
//                              materializes `import Hero from '@/components/Hero';`)
//     → REAL oracle           (gateTurnFiles + formatBounce — the same gate
//                              whole-file.ts and the MCP apply path run)
//
// No component-registry mock, no project-fs mock, no oracle mock. The only
// seams are: capture the queue (its own suite covers internals), stub
// `generateNodeId` for a deterministic data-id (the goldens assert byte-exact
// JSX rows), and give `getNodesSnapshot` an explicit map (parent_id is always
// passed explicitly here; the fallback resolution is unit-tested already).
//
// POSITION CONTRACT — fixed (Tech Lead, 2026-08-09): the tool used to emit
//   `style={{}}` — NO position — so the oracle bounced fresh instances with
//   NODE_MISSING_POSITION (the same rule that makes the editor's own drop
//   path write `position: 'relative'` on every new instance; see
//   canvas/commands.ts "instance carries position:relative + order + flex").
//   The tool now writes `position: 'relative'` explicitly; case 1 asserts the
//   instance PASSES the gate (violations length 0).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { atom } from 'jotai';
import { resetProjectFS } from '@/code/project/project-fs';
import { gateTurnFiles, formatBounce } from '@/code/oracle/gate';
import { queueMutation, flushNow, syncImports, type Mutation } from '@/code/mutation/mutation-queue';
import { addNodeInCode, removeNodeInCode } from '@/code/generation/generator-crud';
import { updateHtmlAttrsInCode } from '@/code/generation/generator-attrs';
import { generateNodeId } from '@/shared/id-utils';
import { getNodesSnapshot } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ToolContext } from '@/ai/agent';
import { addComponentInstanceTool, setComponentPropTool } from './semantic-structure';

vi.mock('@/code/mutation/mutation-queue', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/code/mutation/mutation-queue')>();
  return { ...mod, queueMutation: vi.fn(), flushNow: vi.fn() };
});

vi.mock('@/shared/id-utils', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/shared/id-utils')>();
  return { ...mod, generateNodeId: vi.fn() };
});

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
  selectedIdsAtom: atom<string[]>([]),
}));

type AddNodeMutation = Extract<Mutation, { type: 'addNode' }>;
type UpdateAttrsMutation = Extract<Mutation, { type: 'updateHtmlAttrs' }>;

const CANVAS = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;

const HOME_PATH = 'app/page.client.tsx';
const HERO_PATH = 'components/Hero.tsx';

const codes = (vs: { code: string }[]): string[] => vs.map((v) => v.code);

/** Deterministic `data-id` sequence: frm-1, frm-2, … */
let nextId = 0;
function resetIds(): void {
  nextId = 0;
  vi.mocked(generateNodeId).mockImplementation((prefix = 'frame') => `${prefix}-${++nextId}`);
}

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function lastMutation(): Mutation {
  const calls = vi.mocked(queueMutation).mock.calls;
  return calls[calls.length - 1][0] as Mutation;
}

/** Full page file with a root that can host the instance, valid per the gate. */
function pageFile(body: string): string {
  return `'use client';

${CANVAS}

import React from 'react';

export default function Page() {
  return (
${body}
  );
}`;
}

const HERO_PAGE_BODY = `    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}></div>`;

/** A component that parses into the REAL registry with 3 declared props:
 *  `title`/`variant` have defaults; `image` is REQUIRED (no default). */
const HERO_SOURCE = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @propMeta {"title":{"type":"text","description":"Main heading"},"variant":{"type":"option","options":["light","dark"],"description":"Color theme"},"image":{"type":"image","description":"Cover image"}} */
function Hero({ title = 'Build', variant = 'light', image }: { title?: string; variant?: string; image?: string; style?: React.CSSProperties }) {
  return (
    <motion.section data-id="hero-s" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', padding: '80px 40px', ...style }}>
      <motion.h2 data-id="hero-t" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', margin: '0px', fontSize: '32px' }}>{title}</motion.h2>
    </motion.section>
  );
}
export default withResponsiveProps(Hero);
`;

/** Page with an ALREADY-VALID instance on it (position in style + the import
 *  present) — the state the editor's own drop produces. set_component_prop
 *  edits must round-trip through the gate cleanly from here. */
function instancePage(): string {
  return `'use client';

${CANVAS}

import React from 'react';
import Hero from '@/components/Hero';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
      <Hero data-id="hero-1" data-name="Hero" title="Build" variant="light" style={{ position: 'relative', order: '0', flex: '0 0 auto' }}></Hero>
    </div>
  );
}`;
}

/** The queue's REAL write-back steps for ONE captured mutation, applied to
 *  the "before" file. Returns the file as it would hit the oracle. */
function applyMutation(before: string, m: Mutation): string {
  let code = before;
  if (m.type === 'addNode') {
    code = addNodeInCode(code, m.parentId, m.node as never, m.index);
  } else if (m.type === 'updateHtmlAttrs') {
    code = updateHtmlAttrsInCode(code, m.nodeId, m.attrs);
  } else if (m.type === 'removeNode') {
    code = removeNodeInCode(code, m.nodeId);
  }
  return syncImports(code);
}

/** Seed the live project with `seed`, submit an edited page file to the REAL
 *  oracle gate — the exact path page edits go through in whole-file.ts. */
function runBounce(seed: Map<string, string>, submitted: string): { code: string; message: string }[] {
  resetProjectFS(seed);
  const { violations } = gateTurnFiles([{ path: HOME_PATH, kind: 'page', code: submitted }], null);
  return formatBounce(violations);
}

const seeded = new Map<string, string>([
  [HOME_PATH, pageFile(HERO_PAGE_BODY)],
  [HERO_PATH, HERO_SOURCE],
]);

describe('component golden — add_component_instance through the REAL write path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIds();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('case 1 — instance becomes real JSX + component import; the oracle accepts the positioned instance', async () => {
    resetProjectFS(seeded);

    // The REAL registry parses the seeded Hero.tsx and drives the plumbing.
    const result = await addComponentInstanceTool.execute(
      { name: 'Hero', parent_id: 'root', props: { title: 'Welcome', variant: 'light', image: '/hero.jpg' } },
      makeCtx(),
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('root');
    expect(m.node.type).toBe('Hero');
    expect(m.node.name).toBe('Hero');
    expect(m.node.styles).toEqual({ position: 'relative' });
    expect(m.node.attrs).toEqual({ title: 'Welcome', variant: 'light', image: '/hero.jpg' });
    expect(m.node.id).toBe('frame-1');
    expect(JSON.parse((result.content[0] as any).text)).toEqual({
      node_id: 'frame-1',
      component: 'Hero',
      props_applied: ['title', 'variant', 'image'],
      dropped_props: [],
      missing_required: [],
    });

    // The REAL write path: generator + the auto-injected import row.
    const after = applyMutation(pageFile(HERO_PAGE_BODY), m);
    expect(after).toContain(
      `<Hero data-id="frame-1" data-name="Hero" title="Welcome" variant="light" image="/hero.jpg" style={{position: 'relative'}}></Hero>`,
    );
    expect(after).toContain("import Hero from '@/components/Hero';");

    // The REAL gate on the written file. The tool writes explicit
    // `position: 'relative'` (like the editor's drop path) so the instance
    // PASSES — the oracle must not bounce it (NODE_MISSING_POSITION).
    const violations = runBounce(seeded, after).filter((v) => v.code === 'NODE_MISSING_POSITION');
    expect(violations).toHaveLength(0);
  });

  it('case 2 — only DECLARED props are written; structural + unknown names stay out of the file and are reported', async () => {
    resetProjectFS(seeded);

    const result = await addComponentInstanceTool.execute(
      { name: 'Hero', parent_id: 'root', props: { title: 'Nope', style: { color: 'red' }, ref: 'x', bogus: 1 } },
      makeCtx(),
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.attrs).toEqual({ title: 'Nope' });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.props_applied).toEqual(['title']);
    expect(parsed.dropped_props).toEqual(['style', 'ref', 'bogus']);
    expect(parsed.missing_required).toEqual(['image']);
    expect(result.isError).toBeUndefined();

    const after = applyMutation(pageFile(HERO_PAGE_BODY), m);
    expect(after).toContain('title="Nope"');
    // None of the refused props surface as attributes in the file — the
    // instance still carries only its own placement style.
    expect(after).toContain('<Hero data-id="frame-1" data-name="Hero" title="Nope" style={{position: \'relative\'}}></Hero>');
    for (const ghost of ['bogus', 'ref=']) expect(after).not.toContain(ghost);
  });

  it('case 3 — unknown component name fails clean, nothing queued', async () => {
    resetProjectFS(seeded);
    const result = await addComponentInstanceTool.execute({ name: 'Ghost', parent_id: 'root' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
  });
});

describe('component golden — set_component_prop through the REAL write path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIds();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('case 1 — editing a prop of a VALID instance: new value in code, gate stays clean', async () => {
    const seeded = new Map<string, string>([
      [HOME_PATH, instancePage()],
      [HERO_PATH, HERO_SOURCE],
    ]);
    resetProjectFS(seeded);

    const result = await setComponentPropTool.execute(
      { node_id: 'hero-1', component_name: 'Hero', prop: 'title', value: 'Hello again' },
      makeCtx(),
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
    const m = lastMutation() as UpdateAttrsMutation;
    expect(m).toEqual({ type: 'updateHtmlAttrs', nodeId: 'hero-1', attrs: { title: 'Hello again' } });

    const after = applyMutation(instancePage(), m);
    expect(after).toContain('title="Hello again"');
    expect(after).not.toContain(`title="Build"`);

    // No NEW node → nothing for the position rules to hunt; the edit is
    // precisely the delta a normal page edit carries.
    const bounced = runBounce(seeded, after);
    expect(codes(bounced)).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it('case 2 — value "" REMOVES the attribute from the code (absence, not empty string)', async () => {
    const seeded = new Map<string, string>([
      [HOME_PATH, instancePage()],
      [HERO_PATH, HERO_SOURCE],
    ]);
    resetProjectFS(seeded);

    await setComponentPropTool.execute(
      { node_id: 'hero-1', component_name: 'Hero', prop: 'title', value: '' },
      makeCtx(),
    );
    const m = lastMutation() as UpdateAttrsMutation;
    expect(m).toEqual({ type: 'updateHtmlAttrs', nodeId: 'hero-1', attrs: { title: '' } });

    const after = applyMutation(instancePage(), m);
    expect(after).not.toContain('title=');
    expect(after).toContain('data-id="hero-1"');
    // Component falls back to its internal default at runtime; the file stays
    // gate-clean.
    const bounced = runBounce(seeded, after);
    expect(bounced).toEqual([]);
  });

  it('case 3 — structural props are refused by the tool itself', async () => {
    resetProjectFS(seeded);
    const result = await setComponentPropTool.execute(
      { node_id: 'anything', component_name: 'Hero', prop: 'style', value: 'x' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('case 4 — the written prop reads back through the real canvas parser', async () => {
    const { parseJSXToNodes } = await import('@/code/parsing/parser');
    const seeded = new Map<string, string>([
      [HOME_PATH, instancePage()],
      [HERO_PATH, HERO_SOURCE],
    ]);
    resetProjectFS(seeded);

    await setComponentPropTool.execute(
      { node_id: 'hero-1', component_name: 'Hero', prop: 'variant', value: 'dark' },
      makeCtx(),
    );
    const m = lastMutation() as UpdateAttrsMutation;
    const after = applyMutation(instancePage(), m);

    // The canvas's own read-side contract: parse the evolved file back into
    // nodes and find the instance with its prop.
    const nodes = parseJSXToNodes(after);
    const hero = nodes.get('hero-1');
    expect(hero).toBeTruthy();
    expect(hero!.type).toBe('Hero');
    expect(hero!.attrs?.variant).toBe('dark');
  });
});