import { describe, it, expect } from 'vitest';
import {
  resolveAgentSurface, skillForSurface, surfaceForRequest, describeSurface, type SurfaceState,
} from './surface';
import { registerBeforeAgentTurn, runBeforeAgentTurn } from './turn-hooks';

const base: SurfaceState = {
  activeFilePath: 'app/page.client.tsx', componentEditorFile: null,
  cmsOpen: false, cmsCollection: null, cmsExpandedItem: null, cmsFocusedField: null,
};

describe('resolveAgentSurface', () => {
  it('is the canvas when no overlay is open', () => {
    expect(resolveAgentSurface(base)).toEqual({ kind: 'canvas', filePath: 'app/page.client.tsx' });
  });

  // THE BUG THIS PREVENTS: the agent was only ever told the ACTIVE FILE, which
  // does not change when an overlay opens — mounted in the component editor it
  // would have edited the page underneath.
  it('is the code component, not the page underneath it', () => {
    const s = resolveAgentSurface({ ...base, componentEditorFile: 'components/Galaxy.tsx' });
    expect(s).toEqual({ kind: 'code-component', filePath: 'components/Galaxy.tsx' });
  });

  it('is the CMS with whatever is open in it', () => {
    const s = resolveAgentSurface({ ...base, cmsOpen: true, cmsCollection: 'blog', cmsExpandedItem: 'i1', cmsFocusedField: 'title' });
    expect(s).toEqual({ kind: 'cms', collection: 'blog', expandedItemId: 'i1', focusedFieldId: 'title' });
  });

  it('a CMS with no collection picked is still the CMS', () => {
    expect(resolveAgentSurface({ ...base, cmsOpen: true }).kind).toBe('cms');
  });

  it('the component editor outranks the CMS it was opened from', () => {
    const s = resolveAgentSurface({ ...base, cmsOpen: true, cmsCollection: 'blog', componentEditorFile: 'components/X.tsx' });
    expect(s.kind).toBe('code-component');
  });

  it('a stale CMS collection does not make a closed CMS the surface', () => {
    expect(resolveAgentSurface({ ...base, cmsOpen: false, cmsCollection: 'blog' }).kind).toBe('canvas');
  });
});

describe('skills per surface', () => {
  it('attaches a manual to the overlays and none to the canvas', () => {
    expect(skillForSurface({ kind: 'canvas', filePath: 'a' })).toBeNull();
    expect(skillForSurface({ kind: 'code-component', filePath: 'a' })).toBe('code-component');
    expect(skillForSurface({ kind: 'cms', collection: null, expandedItemId: null, focusedFieldId: null })).toBe('cms');
  });
  it('the request carries names only', () => {
    expect(surfaceForRequest({ kind: 'code-component', filePath: 'components/X.tsx' })).toEqual({ kind: 'code-component', skill: 'code-component' });
  });
});

describe('describeSurface', () => {
  const cc = { kind: 'code-component' as const, filePath: 'components/Galaxy.tsx' };

  it('names the file, the tools and the path to use', () => {
    const text = describeSurface(cc, { codeComponent: { label: 'Galaxy', lines: 212, controls: [{ key: 'speed', type: 'slider' }], previewProps: { speed: 2 } } });
    expect(text).toContain('components/Galaxy.tsx');
    expect(text).toContain('read_source');
    expect(text).toContain('apply_file_edit');
    expect(text).toContain('speed (slider)');
    expect(text).toContain('{"speed":2}');
  });

  // SOFT focus is the decision: a default, never a fence.
  it('states a DEFAULT, not a restriction', () => {
    for (const text of [
      describeSurface(cc),
      describeSurface({ kind: 'cms', collection: 'blog', expandedItemId: null, focusedFieldId: null }, { cms: { name: 'Blog', slug: 'blog', fields: [], itemCount: 0 } }),
    ]) {
      expect(text).toMatch(/unless they say otherwise/);
      expect(text).not.toMatch(/\b(never|must not|forbidden|cannot)\b/i);
    }
  });

  it('still describes the surface when the file could not be read', () => {
    expect(describeSurface(cc, { codeComponent: null })).toContain('components/Galaxy.tsx');
  });

  it('gives the CMS its field IDS — the tools key values by id, not name', () => {
    const text = describeSurface(
      { kind: 'cms', collection: 'blog', expandedItemId: 'i1', focusedFieldId: 'f2' },
      { cms: { name: 'Blog Posts', slug: 'blog', itemCount: 3, expandedItemTitle: 'Hello', focusedFieldName: 'Body',
        fields: [{ id: 'f1', name: 'Title', type: 'text' }, { id: 'f2', name: 'Body', type: 'richtext' }] } },
    );
    expect(text).toContain('"Blog Posts" (slug `blog`): 2 fields, 3 items');
    expect(text).toContain('f2 · Body · richtext');
    expect(text).toContain('Open item: "Hello", in the field "Body"');
  });

  it('caps a huge props object instead of spending the context on it', () => {
    const text = describeSurface(cc, { codeComponent: { label: 'X', lines: 1, controls: [], previewProps: { blob: 'y'.repeat(5000) } } });
    expect(text.length).toBeLessThan(2000);
  });

  it('an empty CMS says how to start', () => {
    const text = describeSurface({ kind: 'cms', collection: null, expandedItemId: null, focusedFieldId: null });
    expect(text).toContain('cms_create_collection');
  });
});

describe('before-turn hooks', () => {
  it('run in registration order and unregister cleanly', () => {
    const calls: string[] = [];
    const offA = registerBeforeAgentTurn(() => calls.push('a'));
    const offB = registerBeforeAgentTurn(() => calls.push('b'));
    runBeforeAgentTurn();
    offA();
    runBeforeAgentTurn();
    offB();
    runBeforeAgentTurn();
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('a hook that throws never costs the user their message', () => {
    const calls: string[] = [];
    const off1 = registerBeforeAgentTurn(() => { throw new Error('boom'); });
    const off2 = registerBeforeAgentTurn(() => calls.push('after'));
    expect(() => runBeforeAgentTurn()).not.toThrow();
    expect(calls).toEqual(['after']);
    off1(); off2();
  });
});

describe('the plugin editor and icon sets — one chat everywhere', () => {
  it('the plugin editor is its own surface, over whatever is underneath, and brings the plugin manual', () => {
    const s = resolveAgentSurface({ ...base, cmsOpen: true, pluginEditorFile: 'plugins/Counter.tsx' });
    expect(s).toEqual({ kind: 'plugin', filePath: 'plugins/Counter.tsx' });
    expect(surfaceForRequest(s)).toEqual({ kind: 'plugin', skill: 'plugin' });
  });

  it('an icon set open on the canvas is the icon-set surface (no manual — its tools say it all)', () => {
    const s = resolveAgentSurface({ ...base, activeFilePath: 'icons/Social.tsx' });
    expect(s).toEqual({ kind: 'icon-set', filePath: 'icons/Social.tsx' });
    expect(skillForSurface(s)).toBeNull();
    // A component or page is not an icon set.
    expect(resolveAgentSurface({ ...base, activeFilePath: 'components/Card.tsx' }).kind).toBe('canvas');
  });

  it('says what a bare request means there, and which tools do it', () => {
    const plugin = describeSurface({ kind: 'plugin', filePath: 'plugins/Counter.tsx' }, { plugin: { name: 'Counter', lines: 40 } });
    expect(plugin).toContain('plugins/Counter.tsx');
    expect(plugin).toContain('write_plugin');
    expect(plugin).toContain('`plugin` manual');
    const set = describeSurface({ kind: 'icon-set', filePath: 'icons/Social.tsx' }, { iconSet: { name: 'Social', icons: ['x', 'github'] } });
    expect(set).toContain('2 icons: x, github');
    expect(set).toContain('add_icons_to_set');
    expect(set).toContain('unless they say otherwise');
  });
});
