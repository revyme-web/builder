// plugins/sdk-impl/sketches.ts — sketches.* namespace.

import type { SketchSetInfo } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

// Sketch sets were removed from the product. The published
// @revyme/plugin-sdk still declares the sketches.* namespace, so keep
// each RPC method's shape and return empty/no-op values until the next
// SDK major drops the namespace. (Same pattern as animations.listGsap.)
export const sketchesHandlers: Record<string, RpcHandler> = {
  'sketches.list': async (): Promise<SketchSetInfo[]> => [],

  'sketches.addVariant': async (): Promise<string> => {
    throw new Error('sketches.addVariant: sketch sets were removed from the product');
  },
};
