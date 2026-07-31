// plugins/sdk-impl/permissions.ts — permissions.* namespace.
//
// `isAllowedTo` checks the calling plugin's manifest against the
// permission gate. Plugins use it to render disabled-state UI for
// methods the user might not have access to (e.g. greying out a
// "Save to project" button when the plugin only has `canvas:read`).
//
// `useIsAllowedTo` (React hook) and `subscribe(methods, handler)`
// are SDK-side wrappers — the runtime injects them. The host only
// needs to expose the imperative `isAllowedTo` here.

import type { RpcHandler } from '../plugin-types';
import { assertCan } from '../permission-gate';

export const permissionsHandlers: Record<string, RpcHandler> = {
  'permissions.isAllowedTo': async (params, ctx): Promise<boolean> => {
    const p = params as { methods?: unknown };
    if (!Array.isArray(p?.methods)) {
      throw new Error('permissions.isAllowedTo: methods array required');
    }
    for (const m of p.methods) {
      if (typeof m !== 'string') return false;
      try { assertCan(ctx.manifest, m); } catch { return false; }
    }
    return true;
  },
};
