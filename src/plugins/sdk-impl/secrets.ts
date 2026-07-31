// plugins/sdk-impl/secrets.ts — secrets.* namespace.
//
// Encrypted localStorage vault for plugin-private API keys / tokens.
// Stored as `revyme:secrets:<pluginId>:<key>` with XOR + base64
// encryption. NOT cryptographically strong — it stops casual
// inspection of localStorage from leaking API keys to anyone with
// devtools open. When the cloud backend lands, secrets move to
// per-user encrypted server storage; the SDK shape stays identical.
//
// Request flow:
//   - `secrets.request(key, opts)` → modal prompt → encrypted store
//   - `secrets.use(key)` → returns the value
//   - `secrets.list()` → registered key NAMES (never values)
//   - `secrets.revoke(key)` → drops the entry
//
// Pass 2 uses `window.prompt` for the request UI. Pass 3 will swap
// in a proper modal with description, copy-paste protection, etc.

import type { RpcHandler } from '../plugin-types';
import { trace } from '@/shared/debug-trace';

const PREFIX = 'revyme:secrets:';
const VAULT_KEY_BYTES = 'revyme-vault-rotate-on-publish';

function xorEncrypt(plain: string): string {
  let out = '';
  for (let i = 0; i < plain.length; i++) {
    out += String.fromCharCode(plain.charCodeAt(i) ^ VAULT_KEY_BYTES.charCodeAt(i % VAULT_KEY_BYTES.length));
  }
  return btoa(out);
}

function xorDecrypt(cipher: string): string {
  try {
    const raw = atob(cipher);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ VAULT_KEY_BYTES.charCodeAt(i % VAULT_KEY_BYTES.length));
    }
    return out;
  } catch {
    return '';
  }
}

const storageKey = (pluginId: string, k: string) => `${PREFIX}${pluginId}:${k}`;

function promptForSecret(key: string, opts: { label: string; description?: string }): string | null {
  const message = `Plugin requests secret "${key}":\n\n${opts.label}\n${opts.description ?? ''}\n\n(Empty cancels)`;
   
  const v = window.prompt(message, '');
  return v && v.length > 0 ? v : null;
}

export const secretsHandlers: Record<string, RpcHandler> = {
  'secrets.request': async (params, ctx): Promise<void> => {
    const p = params as { key?: unknown; opts?: { label?: string; description?: string } };
    if (typeof p?.key !== 'string') throw new Error('secrets.request: key required');
    if (!p?.opts?.label) throw new Error('secrets.request: opts.label required');
    // Idempotent: if a value is already stored for this key, don't re-prompt.
    if (localStorage.getItem(storageKey(ctx.manifest.id, p.key))) return;
    const value = promptForSecret(p.key, { label: p.opts.label, description: p.opts.description });
    if (value == null) throw new Error('secrets.request: user cancelled');
    localStorage.setItem(storageKey(ctx.manifest.id, p.key), xorEncrypt(value));
    trace.action('plugin:secrets.request:stored', { pluginId: ctx.manifest.id, key: p.key });
  },

  'secrets.use': async (params, ctx): Promise<string> => {
    const p = params as { key?: unknown };
    if (typeof p?.key !== 'string') throw new Error('secrets.use: key required');
    const stored = localStorage.getItem(storageKey(ctx.manifest.id, p.key));
    if (!stored) throw new Error(`secrets.use: no secret stored for "${p.key}" — call secrets.request first`);
    return xorDecrypt(stored);
  },

  'secrets.list': async (_params, ctx): Promise<string[]> => {
    const prefix = `${PREFIX}${ctx.manifest.id}:`;
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  },

  'secrets.revoke': async (params, ctx): Promise<void> => {
    const p = params as { key?: unknown };
    if (typeof p?.key !== 'string') throw new Error('secrets.revoke: key required');
    localStorage.removeItem(storageKey(ctx.manifest.id, p.key));
  },
};
