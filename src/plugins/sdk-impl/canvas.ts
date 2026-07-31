// plugins/sdk-impl/canvas.ts — canvas.* namespace.
//
// Reads + tree traversal + mutations. Every method here delegates
// to the SAME Revyme primitives the rest of the editor uses, so
// plugin operations look indistinguishable from user actions to
// the undo stack and selection overlay.
//
// Mutation methods (`addNode`, `cloneNode`, `setParent`,
// `setAttributes`, `removeNode`) all run through `modifyProjectFile`
// on the active page — it flushes pending mutations first and only
// re-syncs the mutation queue's code base when the written file IS
// the active page, which keeps these writes from corrupting other
// files when the user has the editor open on something other than
// the active page.

import { getDefaultStore } from 'jotai';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectFS } from '@/code/project/project-fs';
import { findNodeRect, getContentRoot, removeNode, updateNodeStyles, getViewportPrefix as viewportPrefixFor } from '@/canvas/node-ops';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { addNodeInCode, moveNodeInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import { zoomToFitNodes } from '@/canvas/transform';
import { toCamel } from '@/shared/css-utils';
import type { NodeInfo, NodeRect } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';
import { makeNodeId } from './_id-gen';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function getViewportPrefix(): string {
  const vp = store.get(interactingViewportIdAtom);
  return viewportPrefixFor(vp);
}

interface InternalNodeFields {
  id: string;
  type: string;
  name?: string;
  parentId?: string | null;
  styles?: Record<string, string>;
}

function toNodeInfo(node: InternalNodeFields | undefined): NodeInfo | null {
  if (!node) return null;
  return {
    id: node.id,
    tag: node.type,
    name: node.name ?? node.type,
    parentId: node.parentId ?? null,
    styles: { ...(node.styles ?? {}) },
  };
}

/** Convert kebab-case style keys to camelCase. JSX style objects
 *  require valid JS identifiers — `'background-color'` becomes
 *  `'backgroundColor'`. Plugin authors can write either form;
 *  camel is canonical. */
function normalizeStyleKeys(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    out[toCamel(k)] = v;
  }
  return out;
}

export const canvasHandlers: Record<string, RpcHandler> = {
  // ─── Selection ─────────────────────────────────────────────────────────
  'canvas.getSelection': async (): Promise<string[]> => [...store.get(selectedIdsAtom)],

  'canvas.setSelection': async (params): Promise<void> => {
    const p = params as { ids?: unknown };
    if (!Array.isArray(p?.ids) || !p.ids.every((x) => typeof x === 'string')) {
      throw new Error('canvas.setSelection: ids must be a string array');
    }
    store.set(selectedIdsAtom, p.ids as string[]);
  },

  // ─── Node lookup ───────────────────────────────────────────────────────
  'canvas.getNode': async (params): Promise<NodeInfo | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.getNode: id required');
    return toNodeInfo(store.get(nodesAtom).get(p.id));
  },

  'canvas.getRect': async (params): Promise<NodeRect | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.getRect: id required');
    const r = findNodeRect(p.id, 'desktop');
    if (!r) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  },

  // ─── Tree traversal ────────────────────────────────────────────────────
  'canvas.getParent': async (params): Promise<string | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.getParent: id required');
    return store.get(nodesAtom).get(p.id)?.parentId ?? null;
  },

  'canvas.getChildren': async (params): Promise<string[]> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.getChildren: id required');
    const node = store.get(nodesAtom).get(p.id);
    return node?.children ? [...node.children] : [];
  },

  'canvas.getNodesWithType': async (params): Promise<string[]> => {
    const p = params as { tag?: unknown };
    if (typeof p?.tag !== 'string') throw new Error('canvas.getNodesWithType: tag required');
    const matches: string[] = [];
    for (const [id, node] of store.get(nodesAtom)) {
      if (node.type === p.tag) matches.push(id);
    }
    return matches;
  },

  'canvas.getNodesWithAttribute': async (params): Promise<string[]> => {
    const p = params as { attr?: unknown; value?: unknown };
    if (typeof p?.attr !== 'string') throw new Error('canvas.getNodesWithAttribute: attr required');
    const matches: string[] = [];
    for (const [id, node] of store.get(nodesAtom)) {
      // REAL JSX attributes first (data-* etc.) — the method's documented
      // purpose. Plugins use unique data markers to find nodes they just
      // dropped (a layout drag can't return the new node's id).
      const attrs = (node.attrs ?? {}) as Record<string, string>;
      if (p.attr in attrs) {
        if (typeof p.value !== 'string' || attrs[p.attr] === p.value) matches.push(id);
        continue;
      }
      const styles = (node.styles ?? {}) as Record<string, string>;
      if (p.attr in styles) {
        if (typeof p.value !== 'string' || styles[p.attr] === p.value) matches.push(id);
        continue;
      }
      if (p.attr === 'name' && (typeof p.value !== 'string' || node.name === p.value)) matches.push(id);
      else if (p.attr === 'tag' && (typeof p.value !== 'string' || node.type === p.value)) matches.push(id);
    }
    // CODE FALLBACK for the just-dropped window. The imperative-first drop
    // path injects the new node into the cache with EMPTY attrs and DEFERS
    // the full parse fan-out — the model can lag the code by seconds (or
    // until the next gesture). A plugin's post-drop marker poll runs exactly
    // in that window, so `data-brandlogo`-style lookups came back empty
    // forever and repairs never applied (live find 2026-07-28). The CODE is
    // the source of truth — scan it for the attr and lift the data-id.
    if (matches.length === 0 && typeof p.value === 'string') {
      const code = projectFS.readFile(store.get(activeFilePathAtom)) ?? '';
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const needle = new RegExp(`${esc(p.attr)}="${esc(p.value)}"`, 'g');
      let m: RegExpExecArray | null;
      while ((m = needle.exec(code)) !== null) {
        const tagStart = code.lastIndexOf('<', m.index);
        const tagEnd = code.indexOf('>', m.index);
        if (tagStart === -1 || tagEnd === -1) continue;
        const idm = /data-id="([^"]+)"/.exec(code.slice(tagStart, tagEnd + 1));
        if (idm && !matches.includes(idm[1])) matches.push(idm[1]);
      }
      if (matches.length) trace.action('plugin:canvas.getNodesWithAttribute:code-fallback', { attr: p.attr, matches });
    }
    return matches;
  },

  // ─── Mutation ──────────────────────────────────────────────────────────
  'canvas.setAttributes': async (params): Promise<void> => {
    const p = params as { id?: unknown; attrs?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.setAttributes: id required');
    if (!p.attrs || typeof p.attrs !== 'object') {
      throw new Error('canvas.setAttributes: attrs object required');
    }
    const attrs = p.attrs as { styles?: unknown };
    if (!attrs.styles || typeof attrs.styles !== 'object') {
      throw new Error('canvas.setAttributes: only `styles` is wired (Pass 2)');
    }
    const styles = normalizeStyleKeys(attrs.styles as Record<string, string>);
    const contentEl = getContentRoot();
    if (!contentEl) throw new Error('canvas.setAttributes: canvas not mounted');
    updateNodeStyles({ id: p.id, styles, contentEl, viewportPrefix: getViewportPrefix() });
    trace.action('plugin:canvas.setAttributes', { id: p.id, keys: Object.keys(styles) });
  },

  'canvas.removeNode': async (params): Promise<void> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.removeNode: id required');
    const contentEl = getContentRoot();
    if (!contentEl) throw new Error('canvas.removeNode: canvas not mounted');
    removeNode({ id: p.id, contentEl, viewportPrefix: getViewportPrefix() });
  },

  'canvas.addNode': async (params): Promise<string> => {
    const p = params as { parentId?: unknown; spec?: unknown };
    if (typeof p?.parentId !== 'string') throw new Error('canvas.addNode: parentId required');
    const spec = p.spec as { tag?: string; name?: string; styles?: Record<string, string>; insertIndex?: number };
    if (!spec || typeof spec.tag !== 'string') throw new Error('canvas.addNode: spec.tag required');
    const id = makeNodeId(spec.tag);
    const def: AddNodeDef = {
      id,
      type: spec.tag,
      styles: normalizeStyleKeys(spec.styles ?? {}),
      name: spec.name,
    };
    const filePath = store.get(activeFilePathAtom);
    modifyProjectFile(filePath, (code) => addNodeInCode(code, p.parentId as string, def, spec.insertIndex));
    trace.action('plugin:canvas.addNode', { parentId: p.parentId, id, tag: spec.tag });
    return id;
  },

  'canvas.cloneNode': async (params): Promise<string> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('canvas.cloneNode: id required');
    const node = store.get(nodesAtom).get(p.id);
    if (!node) throw new Error(`canvas.cloneNode: node not found: ${p.id}`);
    if (!node.parentId) throw new Error('canvas.cloneNode: cannot clone the viewport root');
    const newId = makeNodeId(node.type);
    const def: AddNodeDef = {
      id: newId,
      type: node.type,
      styles: { ...(node.styles ?? {}) },
      name: node.name,
    };
    const filePath = store.get(activeFilePathAtom);
    modifyProjectFile(filePath, (code) => addNodeInCode(code, node.parentId as string, def));
    return newId;
  },

  'canvas.setParent': async (params): Promise<void> => {
    const p = params as { id?: unknown; parentId?: unknown; insertIndex?: unknown };
    if (typeof p?.id !== 'string' || typeof p?.parentId !== 'string') {
      throw new Error('canvas.setParent: id + parentId required');
    }
    const idx = typeof p.insertIndex === 'number' ? p.insertIndex : 0;
    const filePath = store.get(activeFilePathAtom);
    // moveNodeInCode signature: (code, nodeId, newParentId, styleChanges?, insertIndex?, canvasNode?)
    // — the 4th positional arg is `styleChanges`, NOT `insertIndex`. Pass undefined.
    modifyProjectFile(filePath, (code) =>
      moveNodeInCode(code, p.id as string, p.parentId as string, undefined, idx),
    );
  },

  'canvas.zoomIntoView': async (params): Promise<void> => {
    const p = params as { idOrIds?: unknown };
    const ids = Array.isArray(p?.idOrIds)
      ? (p.idOrIds as string[])
      : typeof p?.idOrIds === 'string' ? [p.idOrIds] : [];
    if (ids.length === 0) throw new Error('canvas.zoomIntoView: idOrIds required');
    const contentEl = getContentRoot();
    if (!contentEl) throw new Error('canvas.zoomIntoView: canvas not mounted');
    const prefix = getViewportPrefix();
    zoomToFitNodes(contentEl, ids.map((i) => `${prefix}${i}`), true);
  },
};
