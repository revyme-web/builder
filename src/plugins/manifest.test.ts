// plugins/manifest.test.ts — manifest parser regression tests.
//
// The parser is the trust boundary between unsigned plugin manifests
// and the host runtime. A malformed manifest must NEVER produce a
// "successful" PluginManifest — silent acceptance leads to undefined
// permission / mode behavior downstream.

import { describe, it, expect } from 'vitest';
import { parseManifest, parseManifestJson, ManifestParseError } from './manifest';

const VALID_BASE = {
  id: 'com.acme.gradient',
  name: 'Gradient Pack',
  version: '1.0.0',
  entry: 'index.html',
  sdkVersion: '^1.0.0',
  mode: 'panel',
  permissions: ['canvas:read', 'canvas:write'],
};

describe('parseManifest — happy path', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseManifest(VALID_BASE);
    expect(m.id).toBe('com.acme.gradient');
    expect(m.mode).toBe('panel');
    expect(m.permissions).toEqual(['canvas:read', 'canvas:write']);
  });

  it('preserves optional string fields when present', () => {
    const m = parseManifest({ ...VALID_BASE, author: 'Acme Inc', description: 'Pretty', icon: 'palette' });
    expect(m.author).toBe('Acme Inc');
    expect(m.description).toBe('Pretty');
    expect(m.icon).toBe('palette');
  });

  it('drops empty optional string fields (no carry-forward of empties)', () => {
    const m = parseManifest({ ...VALID_BASE, author: '', description: '   ' });
    expect(m.author).toBeUndefined();
    expect(m.description).toBeUndefined();
  });

  it('accepts every documented mode', () => {
    for (const mode of ['panel', 'floating', 'modal', 'headless', 'contextMenu']) {
      const m = parseManifest({ ...VALID_BASE, mode });
      expect(m.mode).toBe(mode);
    }
  });

  it('strips unknown top-level fields (forward compat)', () => {
    const m = parseManifest({ ...VALID_BASE, futureField: { stuff: 1 } });
    // Type narrows away unknown keys; just confirm parse didn't throw
    // and required fields stayed put.
    expect(m.id).toBe('com.acme.gradient');
    expect((m as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('parses ui sub-object with numeric fields', () => {
    const m = parseManifest({
      ...VALID_BASE,
      ui: { defaultWidth: 400, defaultHeight: 600, minWidth: 300, minHeight: 400 },
    });
    expect(m.ui).toEqual({ defaultWidth: 400, defaultHeight: 600, minWidth: 300, minHeight: 400 });
  });

  it('drops the ui object entirely when all fields are non-numeric', () => {
    const m = parseManifest({ ...VALID_BASE, ui: { defaultWidth: 'big' } });
    expect(m.ui).toBeUndefined();
  });

  it('deduplicates permissions and trims whitespace', () => {
    const m = parseManifest({ ...VALID_BASE, permissions: ['canvas:read', '  canvas:read ', '', 'canvas:write'] });
    expect(m.permissions).toEqual(['canvas:read', 'canvas:write']);
  });
});

describe('parseManifest — failure cases', () => {
  it('throws when not an object', () => {
    expect(() => parseManifest('string')).toThrow(ManifestParseError);
    expect(() => parseManifest([])).toThrow(ManifestParseError);
    expect(() => parseManifest(null)).toThrow(ManifestParseError);
  });

  it('throws when required string fields are missing', () => {
    for (const key of ['id', 'name', 'version', 'entry', 'sdkVersion', 'mode']) {
      const bad = { ...VALID_BASE };
      delete (bad as Record<string, unknown>)[key];
      expect(() => parseManifest(bad), `missing ${key}`).toThrow(ManifestParseError);
    }
  });

  it('throws when id is not reverse-DNS', () => {
    expect(() => parseManifest({ ...VALID_BASE, id: 'just-a-name' })).toThrow(/reverse-DNS/);
    expect(() => parseManifest({ ...VALID_BASE, id: 'com.acme name' })).toThrow(/reverse-DNS/);
  });

  it('throws on unknown mode', () => {
    expect(() => parseManifest({ ...VALID_BASE, mode: 'fullscreen' })).toThrow(/mode must be one of/);
  });

  it('throws when permissions is not an array', () => {
    expect(() => parseManifest({ ...VALID_BASE, permissions: 'canvas:read' })).toThrow(/array/);
  });

  it('throws when a permission entry is not a string', () => {
    expect(() => parseManifest({ ...VALID_BASE, permissions: ['canvas:read', 42] })).toThrow(/permissions\[1\]/);
  });
});

describe('parseManifestJson', () => {
  it('parses valid JSON', () => {
    const m = parseManifestJson(JSON.stringify(VALID_BASE));
    expect(m.id).toBe('com.acme.gradient');
  });

  it('throws ManifestParseError on invalid JSON', () => {
    expect(() => parseManifestJson('{not-json}')).toThrow(ManifestParseError);
  });
});
