// plugins/sdk-impl/variables.ts — variables.* namespace.
//
// Variables in Revyme are typed JSX-level constants declared in
// the active file. We expose `list` (read names from binding metadata
// the parser already extracts); `get` and `set` defer until the
// SDK passes per-component context, since variables are scoped to
// their declaring component.

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

interface BindingsBag {
  attrBindings?: Record<string, string>;
  styleBindings?: Record<string, string>;
  propBindings?: Record<string, string>;
}

export const variablesHandlers: Record<string, RpcHandler> = {
  'variables.list': async () => {
    // Walk every node, collecting unique variable names referenced
    // via attr / style / prop bindings. The parser populates these
    // when it sees `prop={varName}` or `style={{ color: themeColor }}`.
    const names = new Set<string>();
    for (const node of store.get(nodesAtom).values()) {
      const n = node as unknown as BindingsBag;
      for (const map of [n.attrBindings, n.styleBindings, n.propBindings]) {
        if (!map) continue;
        for (const v of Object.values(map)) {
          if (typeof v === 'string') names.add(v);
        }
      }
    }
    return Array.from(names).map((name) => ({ name, value: null, type: 'string' as const }));
  },

  'variables.get': async () => {
    throw new Error(
      'NOT_IMPLEMENTED:variables.get (variables are scoped to their declaring component; ' +
        'wiring this needs per-component context the SDK doesn\'t pass yet)',
    );
  },

  'variables.set': async () => {
    throw new Error(
      'NOT_IMPLEMENTED:variables.set (needs source-AST rewrite — see variables.get)',
    );
  },
};
