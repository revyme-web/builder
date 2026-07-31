// plugins/sdk-impl/handlers.test.ts — covers the per-method correctness
// for handlers across the small namespaces (mode, user, project,
// pluginData, pages). The router glue is covered by `router.test.ts`;
// these tests focus on individual handler behavior without the
// round-trip.

import { describe, it, expect, beforeEach } from 'vitest';
import { metaHandlers } from './meta';
import { pluginDataHandlers } from './plugin-data';
import { pagesHandlers } from './pages';
import type { PluginManifest } from '@revyme/plugin-sdk';

const TEST_MANIFEST: PluginManifest = {
  id: 'com.acme.test',
  name: 'Test',
  version: '1.0.0',
  entry: 'index.html',
  sdkVersion: '^1.0.0',
  mode: 'panel',
  permissions: [],
};

const ctx = (overrides: Partial<PluginManifest> = {}) => ({
  manifest: { ...TEST_MANIFEST, ...overrides },
});

describe('mode.current', () => {
  it('returns "canvas" — the default runtime mode', async () => {
    const result = await metaHandlers['mode.current']({}, ctx());
    expect(result).toBe('canvas');
  });
});

describe('user.getCurrentUser', () => {
  it('returns a non-null placeholder user (no auth in Pass 1)', async () => {
    const user = await metaHandlers['user.getCurrentUser']({}, ctx());
    expect(user).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      avatarUrl: null,
      initials: expect.stringMatching(/^[A-Z]{2}$/),
    });
  });
});

describe('project.getProjectInfo', () => {
  it('returns a stable shape with name + id', async () => {
    const info = await metaHandlers['project.getProjectInfo']({}, ctx());
    expect(info).toMatchObject({
      name: expect.any(String),
      id: expect.any(String),
    });
  });
});

describe('project.getPublishInfo', () => {
  it('returns null url + null publishedAt when unpublished', async () => {
    const info = await metaHandlers['project.getPublishInfo']({}, ctx());
    expect(info).toEqual({ url: null, publishedAt: null });
  });
});

describe('pluginData — per-plugin localStorage isolation', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('round-trips a value through set + get', async () => {
    await pluginDataHandlers['pluginData.set']({ key: 'foo', value: 'bar' }, ctx());
    const v = await pluginDataHandlers['pluginData.get']({ key: 'foo' }, ctx());
    expect(v).toBe('bar');
  });

  it('returns null for unset keys', async () => {
    const v = await pluginDataHandlers['pluginData.get']({ key: 'never-set' }, ctx());
    expect(v).toBeNull();
  });

  it('isolates values across plugin ids', async () => {
    await pluginDataHandlers['pluginData.set']({ key: 'k', value: 'plugin-a-value' }, ctx({ id: 'com.acme.a' }));
    await pluginDataHandlers['pluginData.set']({ key: 'k', value: 'plugin-b-value' }, ctx({ id: 'com.acme.b' }));
    const a = await pluginDataHandlers['pluginData.get']({ key: 'k' }, ctx({ id: 'com.acme.a' }));
    const b = await pluginDataHandlers['pluginData.get']({ key: 'k' }, ctx({ id: 'com.acme.b' }));
    expect(a).toBe('plugin-a-value');
    expect(b).toBe('plugin-b-value');
  });

  it('keys() returns only this plugin\'s keys', async () => {
    await pluginDataHandlers['pluginData.set']({ key: 'one', value: '1' }, ctx({ id: 'com.acme.a' }));
    await pluginDataHandlers['pluginData.set']({ key: 'two', value: '2' }, ctx({ id: 'com.acme.a' }));
    await pluginDataHandlers['pluginData.set']({ key: 'leak', value: 'x' }, ctx({ id: 'com.other.b' }));
    const keys = await pluginDataHandlers['pluginData.keys']({}, ctx({ id: 'com.acme.a' }));
    expect((keys as string[]).sort()).toEqual(['one', 'two']);
  });

  it('delete() removes a single key without touching others', async () => {
    await pluginDataHandlers['pluginData.set']({ key: 'a', value: '1' }, ctx());
    await pluginDataHandlers['pluginData.set']({ key: 'b', value: '2' }, ctx());
    await pluginDataHandlers['pluginData.delete']({ key: 'a' }, ctx());
    const a = await pluginDataHandlers['pluginData.get']({ key: 'a' }, ctx());
    const b = await pluginDataHandlers['pluginData.get']({ key: 'b' }, ctx());
    expect(a).toBeNull();
    expect(b).toBe('2');
  });

  it('throws on non-string key', async () => {
    await expect(pluginDataHandlers['pluginData.set']({ key: 123, value: 'x' }, ctx())).rejects.toThrow(/key/);
  });

  it('throws on non-string value (only strings allowed for stable serialization)', async () => {
    await expect(pluginDataHandlers['pluginData.set']({ key: 'k', value: { obj: true } }, ctx())).rejects.toThrow(/value/);
  });
});

describe('pages.list', () => {
  it('returns an array with PageInfo shape', async () => {
    const pages = await pagesHandlers['pages.list']({}, ctx());
    expect(Array.isArray(pages)).toBe(true);
    if ((pages as unknown[]).length > 0) {
      expect((pages as unknown[])[0]).toMatchObject({
        path: expect.any(String),
        name: expect.any(String),
        slug: expect.any(String),
        isHome: expect.any(Boolean),
      });
    }
  });
});

describe('pages.switch — input validation', () => {
  it('throws on non-string path', async () => {
    await expect(pagesHandlers['pages.switch']({ path: 42 }, ctx())).rejects.toThrow(/path/);
  });

  it('throws when the path is not a page (e.g. a component file)', async () => {
    await expect(
      pagesHandlers['pages.switch']({ path: 'components/Foo.tsx' }, ctx()),
    ).rejects.toThrow(/not a page path/);
  });
});
