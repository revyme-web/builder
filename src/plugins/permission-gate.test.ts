// plugins/permission-gate.test.ts — Pass 1 gate behavior.
//
// Pass 1 contract:
//   - Methods not in the map are unconditionally allowed.
//   - Methods in the map require the manifest to declare the
//     corresponding permission. Pass 1 has no install dialog yet, so
//     "manifest declares X" = "user agreed to X" (proxy assumption,
//     replaced in Pass 3 by an actual grants store).
//   - Unknown methods don't throw here — the router catches and
//     returns NOT_IMPLEMENTED. The gate's job is permission only.

import { describe, it, expect } from 'vitest';
import { assertCan, PermissionDeniedError } from './permission-gate';
import type { PluginManifest } from '@revyme/plugin-sdk';

const baseManifest: PluginManifest = {
  id: 'com.acme.test',
  name: 'Test',
  version: '1.0.0',
  entry: 'index.html',
  sdkVersion: '^1.0.0',
  mode: 'panel',
  permissions: [],
};

describe('assertCan', () => {
  it('throws when the manifest lacks the required permission', () => {
    expect(() => assertCan(baseManifest, 'canvas.setSelection')).toThrow(PermissionDeniedError);
  });

  it('passes when the manifest declares the required permission', () => {
    const m: PluginManifest = { ...baseManifest, permissions: ['canvas:write'] };
    expect(() => assertCan(m, 'canvas.setSelection')).not.toThrow();
  });

  it('passes for methods not in the permission map (no perm required)', () => {
    expect(() => assertCan(baseManifest, 'ui.notify')).not.toThrow();
    expect(() => assertCan(baseManifest, 'ui.show')).not.toThrow();
  });

  it('PermissionDeniedError carries the required permission + method', () => {
    try {
      assertCan(baseManifest, 'canvas.setSelection');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as PermissionDeniedError;
      expect(err.required).toBe('canvas:write');
      expect(err.method).toBe('canvas.setSelection');
    }
  });

  it('canvas read methods require canvas:read', () => {
    expect(() => assertCan(baseManifest, 'canvas.getSelection')).toThrow(/canvas:read/);
    expect(() => assertCan({ ...baseManifest, permissions: ['canvas:read'] }, 'canvas.getSelection')).not.toThrow();
    expect(() => assertCan({ ...baseManifest, permissions: ['canvas:read'] }, 'canvas.getNode')).not.toThrow();
    expect(() => assertCan({ ...baseManifest, permissions: ['canvas:read'] }, 'canvas.getRect')).not.toThrow();
  });
});
