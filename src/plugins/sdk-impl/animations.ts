// plugins/sdk-impl/animations.ts — animations.* namespace.

import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { keyframeNamesAtom } from '@/code/stores/animation-store';
import type { GsapAnimation, KeyframeAnimation } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

export const animationsHandlers: Record<string, RpcHandler> = {
  'animations.listKeyframes': async (): Promise<KeyframeAnimation[]> => {
    const filePath = store.get(activeFilePathAtom);
    return store.get(keyframeNamesAtom).map((name) => ({ name, path: filePath }));
  },

  // GSAP was removed from the product. The published @revyme/plugin-sdk
  // still declares `animations.listGsap()`, so keep the RPC shape and
  // return an empty list until the next SDK major drops the method.
  'animations.listGsap': async (): Promise<GsapAnimation[]> => [],
};
