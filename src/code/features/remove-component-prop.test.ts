import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O singletons; use the REAL pure code helpers (removeVariableInCode, isComponentPropUsed,
// getComponentExportName, stripPropFromAllInstancesInCode) so the orchestration's decisions are real.
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({ getActiveFilePath: vi.fn() }));
vi.mock('../project/project-fs', () => ({ projectFS: { readFile: vi.fn(), writeFile: vi.fn(), listFiles: vi.fn(() => []) } }));
vi.mock('../mutation/mutation-queue', () => ({ queueMutation: vi.fn(), flushNow: vi.fn() }));
vi.mock('../project/modify-file', () => ({ modifyProjectFile: vi.fn() }));

import { removeComponentPropProjectWide } from './remove-component-prop';
import { getActiveFilePath } from '@/canvas/node-ops';
import { projectFS } from '../project/project-fs';
import { queueMutation } from '../mutation/mutation-queue';
import { modifyProjectFile } from '../project/modify-file';

const mockActive = vi.mocked(getActiveFilePath);
const mockFS = vi.mocked(projectFS);
const mockQueue = vi.mocked(queueMutation);
const mockModify = vi.mocked(modifyProjectFile);

// KuWoCo master: `hide` drives the inner frame's display (its ONLY use).
const MASTER = `function KuWoCo({ style, hide = false, padding = "0px" }) {
  return <motion.div data-id="r" style={{ ...style }}><motion.div data-id="i" style={{ display: hide ? "none" : "", padding }} /></motion.div>;
}
export default withResponsiveProps(KuWoCo);`;
const LAYOUT = `export default function LayoutClient({ hide = "false" }) {
  return <div><KuWoCo data-id="x" hide={hide} padding={padding} /><Other hide={hide} /></div>;
}`;
const PAGE = `export default function Page() { return <main>no instances here</main>; }`;

function seed(activePath: string) {
  mockActive.mockReturnValue(activePath);
  mockFS.listFiles.mockReturnValue(['components/KuWoCo.tsx', 'app/layout-client.tsx', 'app/page.tsx']);
  mockFS.readFile.mockImplementation((p: string) =>
    p === 'components/KuWoCo.tsx' ? MASTER : p === 'app/layout-client.tsx' ? LAYOUT : PAGE);
  const writes: Record<string, string> = {};
  mockModify.mockImplementation((p: string, fn: (c: string) => string) => { writes[p] = fn(mockFS.readFile(p) as string); return writes[p]; });
  return writes;
}

describe('removeComponentPropProjectWide — remove prop at source → strip every instance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('last use in a master → removes the prop + strips it from every instance file (variable untouched)', () => {
    const writes = seed('components/KuWoCo.tsx');
    const handled = removeComponentPropProjectWide('i', 'display', 'hide', '');
    expect(handled).toBe(true);
    // master prop removed via deleteProp:true mutation
    expect(mockQueue).toHaveBeenCalledWith(expect.objectContaining({ propName: 'hide', deleteProp: true }));
    // the instance file with <KuWoCo> got its hide stripped; padding + Other untouched
    expect(writes['app/layout-client.tsx']).toBeDefined();
    expect(writes['app/layout-client.tsx']).not.toMatch(/<KuWoCo[^>]*hide=/);
    expect(writes['app/layout-client.tsx']).toMatch(/<KuWoCo data-id="x" padding=\{padding\}/);
    expect(writes['app/layout-client.tsx']).toMatch(/<Other hide=\{hide\}/); // different component untouched
    // the page (no <KuWoCo>) was NOT modified
    expect(mockModify).not.toHaveBeenCalledWith('app/page.tsx', expect.anything());
  });

  it('NOT a component master (template/page) → no cascade, returns false', () => {
    seed('app/(Body)/LayoutClient.tsx');
    expect(removeComponentPropProjectWide('i', 'display', 'hide', '')).toBe(false);
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('prop still used by another node → no cascade, returns false (caller does normal unbind)', () => {
    const MASTER2 = `function KuWoCo({ style, hide = false }) {
      return <motion.div data-id="r" style={{ ...style }}><motion.div data-id="i" style={{ display: hide ? "none" : "" }} /><motion.div data-id="j" style={{ opacity: hide ? 0 : 1 }} /></motion.div>;
    }
    export default withResponsiveProps(KuWoCo);`;
    mockActive.mockReturnValue('components/KuWoCo.tsx');
    mockFS.readFile.mockReturnValue(MASTER2);
    // unbinding node 'i' still leaves node 'j' using `hide` → not last use.
    expect(removeComponentPropProjectWide('i', 'display', 'hide', '')).toBe(false);
    expect(mockModify).not.toHaveBeenCalled();
  });
});
