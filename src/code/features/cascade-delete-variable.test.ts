import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O singletons; every code transform underneath (strip, pipeline, page-variables,
// template-route map) is REAL, so the cascade's decisions and rewrites are the production ones.
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
vi.mock('../project/project-fs', () => ({ projectFS: { readFile: vi.fn(), writeFile: vi.fn(), listFiles: vi.fn(() => []) } }));
vi.mock('../mutation/mutation-queue', () => ({ queueMutation: vi.fn(), flushNow: vi.fn() }));
vi.mock('../project/modify-file', () => ({ modifyProjectFile: vi.fn() }));

import { cascadeDeleteVariableUp, isVariableStillUsed } from './cascade-delete-variable';
import { applyDeleteVariablePipeline } from './delete-variable-pipeline';
import { collectInstancePropIdentifiers } from '../components/instance-prop-overrides';
import { projectFS } from '../project/project-fs';
import { modifyProjectFile } from '../project/modify-file';

const mockFS = vi.mocked(projectFS);
const mockModify = vi.mocked(modifyProjectFile);

// The header master AFTER the modal's own delete removed the `content` prop — the cascade
// only reads it for the export name.
const MASTER_POST_DELETE = `'use client';
/** @name "Header" */
function KaFiBi({ style, initialVariant = 'default' }) {
  return <motion.div data-id="root" style={{ ...style }} />;
}
export default withResponsiveProps(KaFiBi);`;

// The Body template: hoisted page variable `content` feeding ONLY the header instance, with a
// per-route Template-tool value in __templateProps — the exact shape from the user's report.
const LAYOUT = `'use client';
/** @pageVariables {
  "variables": [
    { "name": "content", "type": "text", "default": "About" }
  ]
} */
import KaFiBi from '@/components/KaFiBi';
const __templateProps = {"/":{"content":"megapoon2"}};
const __matchTemplateRoute = (__p) => __templateProps[__p] ?? {};
export default function LayoutClient({ children, content = "About" }) {
  const __tp = __matchTemplateRoute(usePathname());
  content = __tp.content ?? content;
  return <div data-id="root">
    <KaFiBi data-responsive='{"375":{"initialVariant":"mobile"},"768":{"content":"tabpoon"},"_bp":[375,768,1440]}' data-id="KaFiBi-1" data-name="Header" content={content}></KaFiBi>
    {children}
  </div>;
}`;

function seed(files: Record<string, string>): Record<string, string> {
  const store = { ...files };
  mockFS.listFiles.mockImplementation(() => Object.keys(store));
  mockFS.readFile.mockImplementation((p: string) => store[p]);
  mockModify.mockImplementation((p: string, fn: (c: string) => string) => { store[p] = fn(store[p]); return store[p]; });
  return store;
}

beforeEach(() => vi.clearAllMocks());

describe('cascadeDeleteVariableUp — erase the hoist trail above a deleted component variable', () => {
  it('strips the instance attr AND deletes the orphaned template variable (param, @pageVariables, __templateProps, reassignment)', () => {
    const store = seed({
      'components/KaFiBi.tsx': MASTER_POST_DELETE,
      'app/(Body)/LayoutClient.tsx': LAYOUT,
      'app/(Body)/page.client.tsx': `export default function Page() { return <main data-id="root" />; }`,
    });
    cascadeDeleteVariableUp('components/KaFiBi.tsx', 'content');
    const layout = store['app/(Body)/LayoutClient.tsx'];
    expect(layout).not.toMatch(/<KaFiBi[^>]*content=/);          // instance attr gone
    expect(layout).not.toMatch(/"content":"tabpoon"/);            // per-viewport data-responsive value gone
    expect(layout).toMatch(/"initialVariant":"mobile"/);          // unrelated responsive entry kept
    expect(layout).not.toMatch(/content = "About"/);              // param gone
    expect(layout).not.toMatch(/__tp\.content/);                  // route-map reassignment gone
    expect(layout).not.toMatch(/"content":"megapoon2"/);          // Template-tool route value gone
    expect(layout).not.toMatch(/@pageVariables[\s\S]*"content"/); // modal entry gone
    // untouched files stay untouched
    expect(mockModify).not.toHaveBeenCalledWith('app/(Body)/page.client.tsx', expect.anything());
  });

  it('variable still used elsewhere in the file → attr stripped, variable KEPT', () => {
    const layoutUsing = LAYOUT.replace('{children}', '{children}<p data-id="t">{content}</p>');
    const store = seed({
      'components/KaFiBi.tsx': MASTER_POST_DELETE,
      'app/(Body)/LayoutClient.tsx': layoutUsing,
    });
    cascadeDeleteVariableUp('components/KaFiBi.tsx', 'content');
    const layout = store['app/(Body)/LayoutClient.tsx'];
    expect(layout).not.toMatch(/<KaFiBi[^>]*content=/);   // attr still stripped
    expect(layout).toMatch(/content = "About"/);          // variable survives (still bound to the <p>)
    expect(layout).toMatch(/"content":"megapoon2"/);      // route value survives with it
    expect(layout).toMatch(/@pageVariables[\s\S]*"content"/);
  });

  it('literal instance value (no hoisted variable) → strip only, nothing else deleted', () => {
    const literalLayout = LAYOUT.replace('content={content}', 'content="hardcoded"');
    const store = seed({
      'components/KaFiBi.tsx': MASTER_POST_DELETE,
      'app/(Body)/LayoutClient.tsx': literalLayout,
    });
    cascadeDeleteVariableUp('components/KaFiBi.tsx', 'content');
    const layout = store['app/(Body)/LayoutClient.tsx'];
    expect(layout).not.toMatch(/<KaFiBi[^>]*content=/);
    expect(layout).toMatch(/content = "About"/); // the (unrelated) page var was not cascaded
  });

  it('walks MULTI-LEVEL chains: component → wrapper component → page', () => {
    // Wrapper component hoists KaFiBi's content into its own `label` prop.
    const wrapper = `/** @name "Wrap" */
import KaFiBi from '@/components/KaFiBi';
function Wrap({ style, label = "About" }) {
  return <motion.div data-id="root" style={{ ...style }}><KaFiBi data-id="k" content={label} /></motion.div>;
}
export default withResponsiveProps(Wrap);`;
    const page = `import Wrap from '@/components/Wrap';
export default function Page({ label = "About" }) {
  return <main data-id="root"><Wrap data-id="w" label={label} /></main>;
}`;
    const store = seed({
      'components/KaFiBi.tsx': MASTER_POST_DELETE,
      'components/Wrap.tsx': wrapper,
      'app/page.client.tsx': page,
    });
    cascadeDeleteVariableUp('components/KaFiBi.tsx', 'content');
    expect(store['components/Wrap.tsx']).not.toMatch(/content=\{label\}/); // level 1 strip
    expect(store['components/Wrap.tsx']).not.toMatch(/label = "About"/);   // level 1 var deleted
    expect(store['app/page.client.tsx']).not.toMatch(/label=\{label\}/);   // level 2 strip
    expect(store['app/page.client.tsx']).not.toMatch(/label = "About"/);   // level 2 var deleted
  });
});

describe('isVariableStillUsed — route-map plumbing is not a use', () => {
  it('reassignment-only variable reads as unused', () => {
    const code = `export default function L({ content = "About" }) {
  const __tp = __matchTemplateRoute(usePathname());
  content = __tp.content ?? content;
  return <div data-id="root" />;
}`;
    expect(isVariableStillUsed(code, 'content')).toBe(false);
  });
  it('a real binding keeps it alive', () => {
    const code = `export default function L({ content = "About" }) {
  content = __tp.content ?? content;
  return <p data-id="t">{content}</p>;
}`;
    expect(isVariableStillUsed(code, 'content')).toBe(true);
  });
});

describe('applyDeleteVariablePipeline — one call erases a template variable from a file', () => {
  it('removes param, reassignment, @pageVariables entry and __templateProps values', () => {
    const out = applyDeleteVariablePipeline(LAYOUT.replace('content={content}', ''), 'content', 'About');
    expect(out).not.toMatch(/content = "About"/);
    expect(out).not.toMatch(/__tp\.content/);
    expect(out).not.toMatch(/"content":"megapoon2"/);
    expect(out).not.toMatch(/@pageVariables[\s\S]*"content"/);
  });
});

describe('collectInstancePropIdentifiers', () => {
  it('collects bare identifiers, ignores literals and complex expressions', () => {
    const code = `<div>
  <KaFiBi data-id="a" content={content} />
  <KaFiBi data-id="b" content="literal" />
  <KaFiBi data-id="c" content={cond ? a : b} />
  <Other data-id="d" content={other} />
</div>`;
    expect(collectInstancePropIdentifiers(code, 'KaFiBi', 'content')).toEqual(['content']);
  });
});
