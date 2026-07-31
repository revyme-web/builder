// replace-component-gen.ts — swap a component INSTANCE (design or code) for a
// different component, in place.
//
// What it KEEPS on the new instance tag: the `data-id` (so it's the same node),
// the inline `style={{…}}` (position + width/height — "keep the size intact"),
// `data-pinned`, and any React `key`. What it DROPS: the OLD component's
// specific props — `data-responsive` (variant map), variant/CMS bindings,
// code-component control props — because the NEW component has its own props and
// defaults; carrying the old ones over would set invalid variants / leave junk.
// `data-name` is updated to the new component's display name.
//
// Imports are NOT touched here — the caller registers this mutation as
// import-affecting so `syncImports` adds the new component's import and prunes
// the old one when its last instance is gone (see mutation-queue IMPORT_AFFECTING_TYPES).

import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex, findTagClose, findMatchingCloseTagIndex } from './generator-utils';

/** Extract a full `style={…}` / `style={{…}}` attribute string, brace-balanced. */
function extractStyleAttr(openTag: string): string {
  const m = openTag.match(/\bstyle=\{/);
  if (!m || m.index == null) return '';
  const braceStart = openTag.indexOf('{', m.index);
  let depth = 0;
  for (let i = braceStart; i < openTag.length; i++) {
    const c = openTag[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return openTag.slice(m.index, i + 1);
    }
  }
  return '';
}

/** Depth-tracked matching `</tag>` finder — thin span adapter over the shared
 *  findMatchingCloseTagIndex (generator-utils). */
function findMatchingClose(code: string, tag: string, from: number): { start: number; end: number } | null {
  const start = findMatchingCloseTagIndex(code, tag, from);
  return start === -1 ? null : { start, end: start + `</${tag}>`.length };
}

export function replaceComponentInstanceInCode(
  code: string,
  opts: { nodeId: string; newTag: string; newDisplayName: string },
): string {
  const { nodeId, newTag, newDisplayName } = opts;
  trace.fn('generator.replaceComponentInstance', { nodeId, newTag });

  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;
  const tagStart = code.lastIndexOf('<', idIndex);
  if (tagStart === -1) return code;
  const tagEnd = findTagClose(code, tagStart); // index of the opening tag's '>'
  if (tagEnd === -1) return code;

  const oldTagMatch = code.slice(tagStart + 1, tagStart + 80).match(/^([\w.-]+)/);
  if (!oldTagMatch) return code;
  const oldTag = oldTagMatch[1];

  const openTag = code.slice(tagStart, tagEnd + 1);
  const selfClosing = code[tagEnd - 1] === '/';

  // Kept-as-authored attributes.
  const styleAttr = extractStyleAttr(openTag);
  const keyAttr = openTag.match(/\bkey=\{[^}]*\}/)?.[0] ?? '';
  const pinnedAttr = openTag.match(/\bdata-pinned="[^"]*"/)?.[0] ?? '';

  const esc = (s: string) => s.replace(/"/g, '&quot;');
  const newOpenInner = [
    `<${newTag}`,
    keyAttr,
    `data-id="${nodeId}"`,
    `data-name="${esc(newDisplayName)}"`,
    pinnedAttr,
    styleAttr,
  ].filter(Boolean).join(' ');

  if (selfClosing) {
    return code.slice(0, tagStart) + newOpenInner + ' />' + code.slice(tagEnd + 1);
  }

  // Open + close form (`<Tag …></Tag>` or with slot children) — rename the
  // matching close tag and keep whatever children were inside.
  const closeSpan = findMatchingClose(code, oldTag, tagEnd + 1);
  if (!closeSpan) {
    // Couldn't pair the close — fall back to swapping just the opening tag.
    return code.slice(0, tagStart) + newOpenInner + '>' + code.slice(tagEnd + 1);
  }
  return (
    code.slice(0, tagStart) + newOpenInner + '>' +
    code.slice(tagEnd + 1, closeSpan.start) +
    `</${newTag}>` +
    code.slice(closeSpan.end)
  );
}
