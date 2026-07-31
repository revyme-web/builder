// plugin-types.ts — Shared plugin RPC types (leaf module). `RpcHandler`
// lives here (not router.ts) so the 20+ sdk-impl handler modules can type
// against it without a router ↔ sdk-impl import cycle (router imports every
// handler map). router.ts re-exports both for existing callers.

import type { PluginManifest } from '@revyme/plugin-sdk';

/**
 * Context passed to every handler. Carries the calling plugin's
 * manifest so handlers like `pluginData.*` and `secrets.*` can scope
 * data per plugin id. Most handlers don't need it and ignore the arg.
 */
export interface RpcHandlerContext {
  manifest: PluginManifest;
}

/** Signature every SDK method handler conforms to. */
export type RpcHandler = (params: unknown, ctx: RpcHandlerContext) => Promise<unknown>;
