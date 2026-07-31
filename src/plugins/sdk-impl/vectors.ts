// plugins/sdk-impl/vectors.ts — vectors.* (icon sets) namespace.

import { projectFS } from '@/code/project/project-fs';
import { parseIconSetDisplayName } from '@/code/icons/icon-set-template';
import { parseIconSetConfig } from '@/code/icons/icon-set-config';
import { addIconToSet } from '@/code/icons/icon-set-ops';
import { isIconSetFilePath } from '@/code/project/active-file-store';
import type { VectorSetInfo } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

export const vectorsHandlers: Record<string, RpcHandler> = {
  'vectors.list': async (): Promise<VectorSetInfo[]> => {
    // No dedicated listIconSetFiles export — filter projectFS by path.
    const out: VectorSetInfo[] = [];
    for (const path of projectFS.listFiles()) {
      if (!path.startsWith('icons/') || !path.endsWith('.tsx')) continue;
      const code = projectFS.readFile(path);
      if (!code) continue;
      out.push({
        path,
        name: parseIconSetDisplayName(code) ?? path,
        variantCount: parseIconSetConfig(code).length,
      });
    }
    return out;
  },

  'vectors.addVariant': async (params): Promise<string> => {
    const p = params as { setPath?: unknown; opts?: { displayName?: string; svgJSX?: string } };
    if (typeof p?.setPath !== 'string' || !isIconSetFilePath(p.setPath)) {
      throw new Error('vectors.addVariant: setPath must point to icons/*.tsx');
    }
    const result = addIconToSet(p.setPath, {
      displayName: p.opts?.displayName,
      svgJSX: p.opts?.svgJSX,
    });
    if (!result) throw new Error('vectors.addVariant: failed');
    return result.iconId;
  },
};
