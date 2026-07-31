// hover-parser.ts — Parse CSS :hover rules from style blocks.
// Extracts [data-id="x"]:hover { ... } rules and returns a Map of nodeId → camelCase property map.
// Strips !important from values.

import { toCamel } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';

/**
 * Parse CSS :hover rules from a style block CSS string.
 * Extracts [data-id="x"]:hover { ... } rules and returns a Map of nodeId → camelCase property map.
 * Strips !important from values.
 */
export function parseHoverRules(css: string): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  if (!css) return result;

  // Match [data-id="nodeId"]:hover { declarations }
  const ruleRx = /\[data-id="([^"]+)"\]:hover\s*\{([^}]*)\}/g;
  let match;
  while ((match = ruleRx.exec(css)) !== null) {
    const nodeId = match[1];
    const declBlock = match[2];
    const props: Record<string, string> = {};

    // Parse declarations: "background-color: #ff0 !important; transform: scale(1.05) !important;"
    const decls = declBlock.split(';').map(d => d.trim()).filter(Boolean);
    for (const decl of decls) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) continue;
      const prop = decl.slice(0, colonIdx).trim();
      let value = decl.slice(colonIdx + 1).trim();
      // Strip !important
      value = value.replace(/\s*!important\s*$/, '').trim();
      if (prop && value) {
        props[toCamel(prop)] = value;
      }
    }

    if (Object.keys(props).length > 0) {
      result.set(nodeId, props);
    }
  }

  trace.fn('hover-parser:parseHoverRules', { ruleCount: result.size });
  return result;
}
