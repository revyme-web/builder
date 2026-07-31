// plugins/sdk-impl/text.ts — text.* namespace.
//
// Reads / writes text content of nodes on the active page. `addText`
// creates a new text node under the page root.

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { addNodeInCode, updateNodeTextInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import type { RpcHandler } from '../plugin-types';
import { makeNodeId } from './_id-gen';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

export const textHandlers: Record<string, RpcHandler> = {
  'text.getText': async (params): Promise<string> => {
    const p = params as { nodeId?: unknown };
    if (typeof p?.nodeId !== 'string') throw new Error('text.getText: nodeId required');
    const node = store.get(nodesAtom).get(p.nodeId);
    if (!node) throw new Error(`text.getText: node not found: ${p.nodeId}`);
    return node.textContent ?? '';
  },

  'text.setText': async (params): Promise<void> => {
    const p = params as { nodeId?: unknown; text?: unknown };
    if (typeof p?.nodeId !== 'string' || typeof p?.text !== 'string') {
      throw new Error('text.setText: nodeId + text required');
    }
    const filePath = store.get(activeFilePathAtom);
    modifyProjectFile(filePath, (code) => updateNodeTextInCode(code, p.nodeId as string, p.text as string));
    trace.action('plugin:text.setText', { nodeId: p.nodeId, len: (p.text as string).length });
  },

  'text.addText': async (params): Promise<string> => {
    const p = params as { text?: unknown; opts?: { styles?: Record<string, string> } };
    if (typeof p?.text !== 'string') throw new Error('text.addText: text required');
    let rootId: string | null = null;
    for (const [id, node] of store.get(nodesAtom)) {
      if (!node.parentId) { rootId = id; break; }
    }
    if (!rootId) throw new Error('text.addText: active page has no root');
    const id = makeNodeId('text');
    const def: AddNodeDef = {
      id,
      type: 'p',
      styles: p.opts?.styles ?? {},
      textContent: p.text,
    };
    const filePath = store.get(activeFilePathAtom);
    modifyProjectFile(filePath, (code) => addNodeInCode(code, rootId as string, def));
    trace.action('plugin:text.addText', { id, len: p.text.length });
    return id;
  },
};
