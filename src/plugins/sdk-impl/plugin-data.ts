// plugins/sdk-impl/plugin-data.ts — pluginData.* namespace.
//
// Per-plugin localStorage KV. Keys are namespaced by the calling
// plugin's manifest id so plugin A can't read plugin B's data.
// Stored as `revyme:plugin-data:<pluginId>:<key>`.
//
// Why localStorage and not projectFS: plugin data is per-USER, not
// per-PROJECT. Moving the project across machines should NOT carry
// plugin-private storage with it. When the cloud version ships,
// this moves to per-user server storage; the SDK shape stays.

import type { RpcHandler } from '../plugin-types';
import { trace } from '@/shared/debug-trace';

const PREFIX = 'revyme:plugin-data:';

const key = (pluginId: string, k: string) => `${PREFIX}${pluginId}:${k}`;

function listKeys(pluginId: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const prefix = `${PREFIX}${pluginId}:`;
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

export const pluginDataHandlers: Record<string, RpcHandler> = {
  'pluginData.get': async (params, ctx): Promise<string | null> => {
    const p = params as { key?: unknown };
    if (typeof p?.key !== 'string') throw new Error('pluginData.get: key required');
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key(ctx.manifest.id, p.key));
  },

  'pluginData.set': async (params, ctx): Promise<void> => {
    const p = params as { key?: unknown; value?: unknown };
    if (typeof p?.key !== 'string') throw new Error('pluginData.set: key must be a string');
    if (typeof p?.value !== 'string') throw new Error('pluginData.set: value must be a string');
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key(ctx.manifest.id, p.key), p.value);
    trace.action('plugin:pluginData.set', { pluginId: ctx.manifest.id, key: p.key });
  },

  'pluginData.delete': async (params, ctx): Promise<void> => {
    const p = params as { key?: unknown };
    if (typeof p?.key !== 'string') throw new Error('pluginData.delete: key required');
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key(ctx.manifest.id, p.key));
  },

  'pluginData.keys': async (_params, ctx): Promise<string[]> => listKeys(ctx.manifest.id),
};
