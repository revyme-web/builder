// element-wrapper.ts — runtime wrapper tags that sit DIRECTLY around one
// canvas element and add no editable node of their own:
//
//   <Override with={withX}><motion.div data-id="card-1" …/></Override>
//   <RevymeTicker speed={80}><div data-id="logos" …>…</div></RevymeTicker>
//
// Rather than teach every generator (move, reorder, delete, conditional
// visibility, wrap, …) about each wrapper, the mutation queue LIFTS the
// wrappers off the file before a mutation runs and RESTORES each one around
// the same data-id afterwards. Generators see the plain JSX they were written
// for; a deleted element simply has nothing to restore onto.
//
// Shared by code-override-gen.ts and ticker-gen.ts.

import { trace } from '@/shared/debug-trace';
import { findSubtreeRange, findTagClose, findMatchingCloseTagIndex } from './generator-utils';

/** data-id → the verbatim opening tag of the wrapper that wrapped it. */
export type LiftedWrappers = Map<string, string>;

/** Strip every `<tag>` wrapper, remembering which element each one wrapped. */
export function liftElementWrappers(code: string, tag: string): { code: string; lifted: LiftedWrappers } {
  const lifted: LiftedWrappers = new Map();
  const open = `<${tag}`;
  if (!code.includes(open)) return { code, lifted };
  let out = code;
  // Last to first so earlier offsets stay valid; nested wrappers (one on an
  // element inside another wrapped element) unwrap inner-first.
  let from = out.length;
  for (;;) {
    const at = out.lastIndexOf(open, from);
    if (at < 0) break;
    from = at - 1;
    const after = out[at + open.length];
    if (after !== ' ' && after !== '\n' && after !== '\t' && after !== '>') continue;
    const openEnd = findTagClose(out, at + open.length);
    if (openEnd < 0 || out[openEnd - 1] === '/') continue;
    const close = findMatchingCloseTagIndex(out, tag, openEnd + 1);
    if (close < 0) continue;
    const inner = out.slice(openEnd + 1, close);
    const id = /^\s*<[A-Za-z][\w.]*\b[^]*?\bdata-id="([^"]+)"/.exec(inner)?.[1];
    if (!id) continue;
    lifted.set(id, out.slice(at, openEnd + 1));
    out = out.slice(0, at) + inner.trim() + out.slice(close + `</${tag}>`.length);
  }
  return { code: out, lifted };
}

/** Re-wrap each lifted element that still exists. */
export function restoreElementWrappers(code: string, lifted: LiftedWrappers, tag: string): string {
  let out = code;
  for (const [id, openTag] of lifted) {
    const range = findSubtreeRange(out, id);
    if (!range) {
      trace.action('element-wrapper:dropped-with-element', { tag, nodeId: id });
      continue;
    }
    out = out.slice(0, range.start) + openTag + out.slice(range.start, range.end) + `</${tag}>` + out.slice(range.end);
  }
  return out;
}

/** Keep `name` in the file's `@revyme/runtime` import exactly while `<name>`
 *  is used. syncImports rebuilds the same line on a flush; writers outside the
 *  queue (paste, direct generator calls) need it now. */
export function ensureRuntimeWrapperImport(code: string, name: string): string {
  const line = /import\s*\{([^}]*)\}\s*from\s*['"]@revyme\/runtime['"];?/.exec(code);
  const has = (specs: string) => new RegExp(`\\b${name}\\b`).test(specs);
  if (!new RegExp(`<${name}[\\s>]`).test(code)) {
    // Last wrapper gone: drop the now-unused specifier (or the whole line).
    if (!line || !has(line[1])) return code;
    const rest = line[1].split(',').map((x) => x.trim()).filter((x) => x && x !== name);
    return rest.length
      ? code.replace(line[0], `import { ${rest.join(', ')} } from '@revyme/runtime';`)
      : code.replace(new RegExp(`${line[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[ \t]*\n?`), '');
  }
  if (line) {
    if (has(line[1])) return code;
    return code.replace(line[0], `import { ${[...line[1].split(',').map((x) => x.trim()).filter(Boolean), name].join(', ')} } from '@revyme/runtime';`);
  }
  const lastImport = [...code.matchAll(/^import\b[^;]*;[ \t]*\n/gm)].pop();
  const at = lastImport ? lastImport.index! + lastImport[0].length : (/^(['"])use client\1;?\s*\n/.exec(code)?.[0].length ?? 0);
  return code.slice(0, at) + `import { ${name} } from '@revyme/runtime';\n` + code.slice(at);
}
