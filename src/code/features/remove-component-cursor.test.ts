import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O singletons; use the REAL pure code helpers (cursor parser/generator,
// isComponentPropUsed, getComponentExportName, stripPropFromAllInstancesInCode) so the
// orchestration's decisions are real. Mirrors remove-component-prop.test.ts.
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({ getActiveFilePath: vi.fn() }));
vi.mock('../project/project-fs', () => ({ projectFS: { readFile: vi.fn(), writeFile: vi.fn(), listFiles: vi.fn(() => []) } }));
vi.mock('../mutation/mutation-queue', () => ({ queueMutation: vi.fn(), flushNow: vi.fn() }));
vi.mock('../project/modify-file', () => ({ modifyProjectFile: vi.fn() }));

import { removeComponentCursorProjectWide } from './remove-component-cursor';
import { getActiveFilePath } from '@/canvas/node-ops';
import { projectFS } from '../project/project-fs';
import { modifyProjectFile } from '../project/modify-file';

const mockActive = vi.mocked(getActiveFilePath);
const mockFS = vi.mocked(projectFS);
const mockModify = vi.mocked(modifyProjectFile);

// ZoGaCo master: the root binds a CURSOR VARIABLE (`cursor` prop + `cursorOpts` forward).
const MASTER = `function ZoGaCo({ style, cursor, cursorOpts = {}, title }) {
  return <motion.div data-id="r" {...withCursor(cursor, { mode: "follow", ...cursorOpts })} style={{ ...style }}>{title}</motion.div>;
}
export default withResponsiveProps(ZoGaCo);`;

// A master where a SECOND node also binds the same cursor prop.
const MASTER_TWO = `function ZoGaCo({ style, cursor, cursorOpts = {}, title }) {
  return <motion.div data-id="r" {...withCursor(cursor, { mode: "follow", ...cursorOpts })} style={{ ...style }}><motion.div data-id="i" {...withCursor(cursor, { mode: "replace" })} style={{}} />{title}</motion.div>;
}
export default withResponsiveProps(ZoGaCo);`;

// The reported shape: instances inside a collection list carry BOTH attrs, and the opts
// value holds a NESTED transition object — a flat fixture here is what let the
// stray-brace corruption ship (see instance-prop-overrides.test.ts).
const PAGE = `export default function Page() {
  return <div>{projects.map((item, idx) => (
    <ZoGaCo cursorOpts={{"mode":"follow","side":"bottom","align":"center","transition":{"type":"spring","stiffness":300,"damping":30}}} cursor={JiViVu} key={idx} data-id="proj-row" title={item.title} />
  ))}<Other cursor={JiViVu} /></div>;
}`;
const CLEAN = `export default function Other() { return <main>no instances here</main>; }`;

function seed(activePath: string, master = MASTER) {
  mockActive.mockReturnValue(activePath);
  mockFS.listFiles.mockReturnValue(['components/ZoGaCo.tsx', 'app/page.client.tsx', 'app/other.tsx']);
  mockFS.readFile.mockImplementation((p: string) =>
    p === 'components/ZoGaCo.tsx' ? master : p === 'app/page.client.tsx' ? PAGE : CLEAN);
  const writes: Record<string, string> = {};
  mockModify.mockImplementation((p: string, fn: (c: string) => string) => {
    writes[p] = fn(mockFS.readFile(p) as string); return writes[p];
  });
  return writes;
}

describe('removeComponentCursorProjectWide — unbind cursor at source → strip every instance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('strips BOTH cursor and cursorOpts from every instance (the reported bug)', () => {
    const writes = seed('components/ZoGaCo.tsx');
    expect(removeComponentCursorProjectWide('r')).toBe(true);

    const page = writes['app/page.client.tsx'];
    expect(page).toBeDefined();
    expect(page).not.toMatch(/<ZoGaCo[^>]*\scursor=/);      // identifier gone
    expect(page).not.toMatch(/<ZoGaCo[^>]*cursorOpts=/);    // opts gone too — orphaned opts is the same bug
    expect(page).toMatch(/<ZoGaCo[^>]*title=\{item\.title\}/); // unrelated props untouched
    expect(page).toMatch(/<Other cursor=\{JiViVu\}/);           // different component untouched
    expect((page.match(/\{/g) || []).length).toBe((page.match(/\}/g) || []).length); // no stray closers
  });

  it('drops both params from the master signature and the withCursor call', () => {
    const writes = seed('components/ZoGaCo.tsx');
    removeComponentCursorProjectWide('r');
    const master = writes['components/ZoGaCo.tsx'];
    expect(master).not.toContain('withCursor');
    expect(master).not.toMatch(/[{,]\s*cursor\s*[,}]/);
    expect(master).not.toContain('cursorOpts');
  });

  it('another node still binds the prop → local unbind only, instances KEPT', () => {
    const writes = seed('components/ZoGaCo.tsx', MASTER_TWO);
    expect(removeComponentCursorProjectWide('r')).toBe(true);
    const master = writes['components/ZoGaCo.tsx'];
    expect(master).toContain('withCursor');           // the second node's call survives
    expect(master).toContain('cursor');               // prop still declared
    expect(writes['app/page.client.tsx']).toBeUndefined(); // instances not swept
  });

  it('files without an instance are never rewritten', () => {
    seed('components/ZoGaCo.tsx');
    removeComponentCursorProjectWide('r');
    expect(mockModify).not.toHaveBeenCalledWith('app/other.tsx', expect.anything());
  });

  it('NOT a component master (page/template) → no cascade, returns false', () => {
    seed('app/page.client.tsx');
    expect(removeComponentCursorProjectWide('r')).toBe(false);
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('node has no cursor → returns false so the caller falls back', () => {
    seed('components/ZoGaCo.tsx');
    expect(removeComponentCursorProjectWide('nope')).toBe(false);
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('a plain imported-component cursor has no instance props → returns false', () => {
    const imported = `import Cur from '@/components/Cur';
function ZoGaCo({ style }) {
  return <motion.div data-id="r" {...withCursor(Cur, { mode: "follow" })} style={{ ...style }} />;
}
export default withResponsiveProps(ZoGaCo);`;
    seed('components/ZoGaCo.tsx', imported);
    expect(removeComponentCursorProjectWide('r')).toBe(false);
    expect(mockModify).not.toHaveBeenCalled();
  });
});
