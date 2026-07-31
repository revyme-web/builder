// template-apply-merge.test.ts — the layout merge (page + its template's
// LayoutClient) must collapse to a SINGLE viewport root with id `'root'` (the
// template root TAKES OVER the page root) — there is NO separate `'layout::root'`
// node. This is the invariant the TemplatePicker selection re-anchor relies on:
// after assigning a template, selection must point at `'root'`, never the
// (non-existent) `'layout::root'`, or the properties panel blanks / selection-
// dependent UI breaks. Complements store.test.ts by exercising the FULL
// project-parser path (component instances in BOTH the page and the template are
// expanded) — the shape the real editor merges, including a code-component
// (code component) nested in the page and a root-level <style> in both files.

import { describe, test, expect, vi } from 'vitest';
import { parseProjectFile } from '../parsing/project-parser';
import { jsxDataIdIndex } from './store';
import { InMemoryProjectFS } from '../project/project-fs';
import type { CanvasNode } from '../parsing/parser';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// findChildrenParentId — copied verbatim from store.ts (not exported).
function findChildrenParentId(code: string, childrenIdx: number, nodes: Map<string, CanvasNode>): string | null {
  const before = code.slice(0, childrenIdx);
  const after = code.slice(childrenIdx);
  for (const [id, node] of nodes) {
    if (!node.children.length) continue;
    const hasBefore = node.children.some(cid => before.includes(`data-id="${cid}"`));
    const hasAfter = node.children.some(cid => after.includes(`data-id="${cid}"`));
    if (hasBefore && hasAfter) return id;
  }
  for (const [id, node] of nodes) {
    if (!node.parentId && before.includes(`data-id="${id}"`)) return id;
  }
  return null;
}

const PAGE = `'use client';
import { motion } from 'framer-motion';
import StartTrialButton from '@/components/StartTrialButton';
import WeavingWaves from '@/components/WeavingWaves';
export default function Page() {
  return <div data-id="root" data-name="Tools" style={{ position: 'relative', width: '100%', order: '0', backgroundColor: '#fff' }}>
    <div data-id="tl-hero" data-name="Hero" style={{ position: 'relative', width: '100%' }}>
      <div data-id="tl-hero-inner" data-name="Hero Inner" style={{ order: '0' }}>
        <StartTrialButton data-id="StartTrialButton-tools-cta" data-name="Start Trial Button" style={{ order: '0' }}></StartTrialButton>
      </div>
      <WeavingWaves data-id="WeavingWaves-x6" data-name="Weaving Waves" accent="#1e3c1b" style={{ position: 'absolute', order: '1' }}></WeavingWaves>
    </div>
    <div data-id="tl-bento" data-name="Bento Section" style={{ position: 'relative', width: '100%' }}>B</div>
    <div data-id="tl-feature" data-name="Feature Section" style={{ position: 'relative', width: '100%' }}>F</div>
    <style>{\`@media (max-width: 600px){ [data-id="tl-hero-inner"]{ color:red } }\`}</style>
  </div>;
}`;

const LAYOUT = `'use client';
import StartTrialButton from '@/components/StartTrialButton';
import Header from '@/components/Header';
export default function LayoutClient({ children }) {
  // Live-bug trigger: script logic references a POST-slot sibling's data-id
  // in a STRING before the JSX. The splice-index count must ignore it.
  if (typeof document !== 'undefined') {
    const probe = document.querySelector('[data-id="cta"]');
    void probe;
  }
  return <div data-id="root" data-name="Layout" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <style>{\`@media (max-width: 375px){ [data-id="x"]{ color:blue } }\`}</style>
    <Header data-id="Header-29" data-name="Header" style={{ position: 'fixed', order: '-2' }}></Header>
    {children}
    <div data-id="cta" data-name="CTA Section" style={{ position: 'relative', order: '0' }}>
      <StartTrialButton data-id="StartTrialButton-28" data-name="Start Trial Button" style={{ order: '0' }}></StartTrialButton>
    </div>
    <div data-id="footer" data-name="Footer" style={{ position: 'relative', order: '1' }}>Foot</div>
  </div>;
}`;

const HEADER = `import { motion } from 'framer-motion';
function Header({ style }) {
  return <motion.div data-id="hdr-root" data-name="Header Root" layout={true} style={{ width: '100%', height: '60px', ...style }}>
    <p data-id="hdr-logo" data-name="Logo" style={{ order: '0' }}>Logo</p>
  </motion.div>;
}
export default Header;`;

const STB = `import { motion } from 'framer-motion';
function StartTrialButton({ style }) {
  return <motion.div data-id="stb-root" data-name="Btn Root" layout={true} style={{ width: '194px', height: '48px', ...style }}>
    <p data-id="stb-label" data-name="Label" style={{ order: '0' }}>Start</p>
  </motion.div>;
}
export default StartTrialButton;`;

const WEAVING = `/** @controls { "accent": { "type": "color", "label": "Accent" } } */
export default function WeavingWaves({ accent = '#000' }) {
  return null;
}`;

function buildFs(): InMemoryProjectFS {
  return new InMemoryProjectFS(new Map<string, string>([
    ['app/(Body)/tools/page.client.tsx', PAGE],
    ['app/(Body)/LayoutClient.tsx', LAYOUT],
    ['components/Header.tsx', HEADER],
    ['components/StartTrialButton.tsx', STB],
    ['components/WeavingWaves.tsx', WEAVING],
  ]));
}

// Replicate the store.ts nodesAtom layout-merge (page-editing branch).
function mergeReal(fs: InMemoryProjectFS): Map<string, CanvasNode> {
  let cached = parseProjectFile('app/(Body)/tools/page.client.tsx', fs);
  const layoutCode = fs.readFile('app/(Body)/LayoutClient.tsx')!;
  const layoutNodes = parseProjectFile('app/(Body)/LayoutClient.tsx', fs);

  const childrenIdx = layoutCode.indexOf('{children}');
  const childrenParentId = childrenIdx >= 0 ? findChildrenParentId(layoutCode, childrenIdx, layoutNodes) : null;
  if (!childrenParentId) throw new Error('no childrenParentId');

  const origChildren = new Map<string, string[]>();
  for (const [id, node] of layoutNodes) origChildren.set(id, [...node.children]);

  const pageRootIds: string[] = [];
  for (const [id, node] of cached) if (!node.parentId) pageRootIds.push(id);

  cached = new Map(cached);
  let templateRootOrigId: string | null = null;
  for (const [id, n] of layoutNodes) { if (!n.parentId) { templateRootOrigId = id; break; } }
  const primaryPageRootId = pageRootIds[0] ?? null;
  const primaryPageRoot = primaryPageRootId ? cached.get(primaryPageRootId) : null;
  const pageSectionIds = primaryPageRoot ? [...primaryPageRoot.children] : [];
  const childrenParentMergedId = (childrenParentId === templateRootOrigId && primaryPageRootId)
    ? primaryPageRootId : 'layout::' + childrenParentId;

  for (const [origId, node] of layoutNodes) {
    if (node.isCanvasNode) continue;
    const isRoot = origId === templateRootOrigId;
    const newId = (isRoot && primaryPageRootId) ? primaryPageRootId : 'layout::' + origId;
    node.fromLayout = true;
    node.id = newId;
    const kids = (origChildren.get(origId) || []).map(c => 'layout::' + c);
    if (origId === childrenParentId) {
      let insertIdx = 0;
      for (const kidId of (origChildren.get(origId) || [])) {
        const tagIdx = jsxDataIdIndex(layoutCode, kidId);
        if (tagIdx !== -1 && tagIdx < childrenIdx) insertIdx++;
      }
      kids.splice(insertIdx, 0, ...pageSectionIds);
    }
    node.children = kids;
    node.parentId = isRoot ? null : (node.parentId === templateRootOrigId && primaryPageRootId ? primaryPageRootId : 'layout::' + node.parentId);
    cached.set(newId, node);
  }
  for (const secId of pageSectionIds) {
    const sec = cached.get(secId);
    if (sec) { sec.parentId = childrenParentMergedId; sec.styles = { ...(sec.styles ?? {}), order: '' }; cached.set(secId, sec); }
  }
  return cached;
}

describe('layout merge — apply template to a page', () => {
  const merged = mergeReal(buildFs());

  test('collapses to a single viewport root with id `root` (template took over the page root)', () => {
    const roots = [...merged.values()].filter(n => !n.parentId).map(n => n.id);
    expect(roots).toEqual(['root']);
    expect(merged.get('root')?.fromLayout).toBe(true);
  });

  test('there is NO separate `layout::root` node — the re-anchor target must be `root`', () => {
    expect(merged.has('layout::root')).toBe(false);
  });

  test('script-logic data-id strings above the JSX do NOT shift the splice (footer stays after sections)', () => {
    // The LAYOUT fixture's querySelector('[data-id="cta"]') sits BEFORE the
    // {children} slot in the raw code. The old substring count treated 'cta'
    // as a pre-slot sibling, splicing the page sections one slot too far —
    // AFTER the template CTA/footer in the merged children array. At rest
    // flex `order` masked it, but the drag-time layout:: bracket keyed off
    // the array order and skipped the footer (it rode to the top mid-drag).
    const root = merged.get('root')!;
    const kids = root.children;
    const firstSection = kids.indexOf('tl-hero');
    const cta = kids.indexOf('layout::cta');
    const footer = kids.indexOf('layout::footer');
    expect(firstSection).toBeGreaterThan(-1);
    expect(cta).toBeGreaterThan(kids.indexOf('tl-feature'));
    expect(footer).toBeGreaterThan(cta);
    // header stays before the content
    expect(kids.indexOf('layout::Header-29')).toBeLessThan(firstSection);
  });

  test('merged root interleaves template chrome around the page sections, no dangling children', () => {
    const rootKids = merged.get('root')!.children;
    expect(rootKids).toEqual(['layout::Header-29', 'tl-hero', 'tl-bento', 'tl-feature', 'layout::cta', 'layout::footer']);
    // every referenced child resolves (no missing node a Renderer/LayersPanel walk would trip on)
    for (const [, n] of merged) {
      for (const cid of n.children) expect(merged.has(cid)).toBe(true);
    }
  });
});
