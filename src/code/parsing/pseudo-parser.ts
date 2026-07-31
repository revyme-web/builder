// pseudo-parser.ts — Parse CSS ::before/::after rules from style blocks.

import { toCamel } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';

export interface PseudoStyles {
  before?: Record<string, string>;
  after?: Record<string, string>;
}

export function parsePseudoRules(css: string): Map<string, PseudoStyles> {
  const result = new Map<string, PseudoStyles>();
  if (!css) return result;

  const ruleRx = /\[data-id="([^"]+)"\]::(before|after)\s*\{([^}]*)\}/g;
  let match;
  while ((match = ruleRx.exec(css)) !== null) {
    const nodeId = match[1];
    const pseudo = match[2] as 'before' | 'after';
    const declBlock = match[3];
    const props: Record<string, string> = {};

    const decls = declBlock.split(';').map(d => d.trim()).filter(Boolean);
    for (const decl of decls) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) continue;
      const prop = decl.slice(0, colonIdx).trim();
      let value = decl.slice(colonIdx + 1).trim();
      value = value.replace(/\s*!important\s*$/, '').trim();
      if (prop && value) {
        props[toCamel(prop)] = value;
      }
    }

    if (Object.keys(props).length > 0) {
      const existing = result.get(nodeId) || {};
      existing[pseudo] = props;
      result.set(nodeId, existing);
    }
  }

  trace.fn('pseudo-parser:parsePseudoRules', { ruleCount: result.size });
  return result;
}
