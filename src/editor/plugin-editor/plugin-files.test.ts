import { describe, test, expect, beforeEach } from 'vitest';
import {
  createPluginFile,
  renamePluginFile,
  getPluginDisplayName,
  deriveTier2Manifest,
  readPluginSource,
  listPluginFiles,
  pluginPathToInternalName,
} from './plugin-files';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

beforeEach(() => {
  resetProjectFS();
});

describe('renamePluginFile — @name annotation (no file move)', () => {
  test('rename writes an @name annotation, leaves the path/id intact', () => {
    const path = createPluginFile('Scroll Sequence'); // plugins/ScrollSequence.tsx
    expect(path).toBe('plugins/ScrollSequence.tsx');
    expect(getPluginDisplayName(path)).toBe('ScrollSequence'); // basename fallback

    renamePluginFile(path, 'My Cool Plugin');

    // Same file path — folder placement, open-editor ref, manifest id all stable.
    expect(listPluginFiles()).toEqual([path]);
    expect(projectFS.exists(path)).toBe(true);
    // Display label now comes from @name.
    expect(getPluginDisplayName(path)).toBe('My Cool Plugin');
    expect(readPluginSource(path)).toContain('/** @name "My Cool Plugin" */');
  });

  test('the derived manifest id stays path-based; only the name follows @name', () => {
    const path = createPluginFile('Scroll Sequence'); // → plugins/ScrollSequence.tsx
    expect(deriveTier2Manifest(path).id).toBe('local.scrollsequence');
    expect(deriveTier2Manifest(path).name).toBe('ScrollSequence');

    renamePluginFile(path, 'Renamed');
    expect(deriveTier2Manifest(path).id).toBe('local.scrollsequence'); // unchanged
    expect(deriveTier2Manifest(path).name).toBe('Renamed');            // follows @name
  });

  test('re-rename replaces the existing annotation (no duplicates)', () => {
    const path = createPluginFile('Thing');
    renamePluginFile(path, 'First');
    renamePluginFile(path, 'Second');
    const src = readPluginSource(path);
    expect(getPluginDisplayName(path)).toBe('Second');
    expect((src.match(/@name/g) || []).length).toBe(1);
  });

  test('empty / whitespace name is ignored', () => {
    const path = createPluginFile('Keep');
    renamePluginFile(path, '   ');
    expect(getPluginDisplayName(path)).toBe('Keep');
    expect(readPluginSource(path)).not.toContain('@name');
  });

  test('non-plugin paths are a no-op', () => {
    projectFS.writeFile('components/Foo.tsx', '// x');
    renamePluginFile('components/Foo.tsx', 'Nope');
    expect(projectFS.readFile('components/Foo.tsx')).toBe('// x');
  });

  test('getPluginDisplayName falls back to the basename when no @name', () => {
    const path = createPluginFile('Fallback');
    expect(getPluginDisplayName(path)).toBe(pluginPathToInternalName(path));
  });
});
