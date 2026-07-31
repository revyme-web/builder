// plugins/sdk-impl/pages.ts — pages.* namespace.

import { getDefaultStore } from 'jotai';
import {
  activeFilePathAtom,
  switchActiveFile,
  listPageFiles,
  getFileDisplayName,
  getPageSlug,
  createPageFile,
} from '@/code/project/active-file-store';
import { syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import type { RpcHandler } from '../plugin-types';
import type { PageInfo } from '@revyme/plugin-sdk';

const store = getDefaultStore();

// Accept either half of the page pair (server wrapper or client body)
// so plugins can ask "is this a page path?" with whatever shape they
// hold. `listPageFiles` returns the canonical .client.tsx entries.
const isPagePath = (path: string) =>
  path.startsWith('app/') && (path.endsWith('/page.client.tsx') || path.endsWith('/page.tsx'));

export const pagesHandlers: Record<string, RpcHandler> = {
  'pages.list': async (): Promise<PageInfo[]> =>
    listPageFiles().map((path) => ({
      path,
      name: getFileDisplayName(path),
      slug: getPageSlug(path),
      isHome: path === 'app/page.client.tsx',
    })),

  'pages.getActive': async (): Promise<string | null> => {
    const path = store.get(activeFilePathAtom);
    return isPagePath(path) ? path : null;
  },

  'pages.create': async (params): Promise<string> => {
    const p = params as { name?: unknown; slug?: unknown };
    if (typeof p?.name !== 'string' || typeof p?.slug !== 'string') {
      throw new Error('pages.create: name + slug (strings) required');
    }
    // `createPageFile` in Revyme uses the name as the file basename
    // and computes the slug from the path. We pass the user-supplied
    // name; slug is derived implicitly. Future: honor the supplied
    // slug explicitly when active-file-store grows that knob.
    return createPageFile(p.name);
  },

  'pages.switch': async (params): Promise<void> => {
    const p = params as { path?: unknown };
    if (typeof p?.path !== 'string') throw new Error('pages.switch: path must be a string');
    if (!isPagePath(p.path)) throw new Error(`pages.switch: not a page path: ${p.path}`);
    const from = store.get(activeFilePathAtom);
    switchActiveFile(
      from,
      p.path,
      {
        setActiveFile: (next: string) => store.set(activeFilePathAtom, next),
        setSelectedIds: (ids: string[]) => store.set(selectedIdsAtom, ids),
        setUpdatingFromCanvas: (v: boolean) => store.set(updatingFromCanvasAtom, v),
      },
      { syncQueueCode, flushNow },
    );
  },
};
