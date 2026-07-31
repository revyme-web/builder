// sketch-anim-gen.ts — Codegen for sketch draw animations.
//
// The orchestrator is in `@revyme/runtime` (`playSketchDraw`). This
// generator only injects:
//
//   • an import for `playSketchDraw` from `@revyme/runtime`
//   • an import for `useEffect` from `react`
//   • one `useEffect` block per sketch wrapper inside the page
//     component, calling `playSketchDraw(el, options)` with the
//     options object inline so the user can read + edit the config
//     directly in source.
//
// Each block is wrapped in marker comments so subsequent updates and
// the removal path can rewrite it without an AST round-trip.

import {
  parseSketchAnimConfig,
  type SketchAnimConfig,
  DEFAULT_SKETCH_ANIM,
} from './sketch-anim-config';
import { trace } from '@/shared/debug-trace';
import { ensureNamedImport } from '@/code/generation/generator-utils';

const blockBegin = (id: string) => `// __SKETCH_ANIM_BLOCK_BEGIN__ ${id}`;
const blockEnd = (id: string) => `// __SKETCH_ANIM_BLOCK_END__ ${id}`;
const blockBeginRe = (id: string) => new RegExp(`\\s*//\\s*__SKETCH_ANIM_BLOCK_BEGIN__\\s+${escapeRe(id)}[^\\n]*`);
const blockEndRe = (id: string) => new RegExp(`\\s*//\\s*__SKETCH_ANIM_BLOCK_END__\\s+${escapeRe(id)}[^\\n]*`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeIdForRef(id: string): string {
  return id.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function configToInlineLiteral(config: SketchAnimConfig): string {
  // Pretty-print the options object so the user can read and edit it
  // directly in the source. Two-space indent, deterministic key order.
  const t = config.transition;
  const transition = t.type === 'spring'
    ? `{ type: 'spring'${t.stiffness !== undefined ? `, stiffness: ${t.stiffness}` : ''}${t.damping !== undefined ? `, damping: ${t.damping}` : ''}${t.mass !== undefined ? `, mass: ${t.mass}` : ''} }`
    : `{ type: 'tween', duration: ${t.duration ?? 1}, ease: '${t.ease ?? 'easeOut'}' }`;
  return `{
      trigger: '${config.trigger}',
      mode: '${config.mode}',
      durationScale: ${config.durationScale},
      stagger: ${config.stagger},
      transition: ${transition},
    }`;
}

// ─── Imports ────────────────────────────────────────────────────────────────

/** Make sure `useEffect` (from react) and `playSketchDraw` (from
 *  `@revyme/runtime`) are imported. Idempotent. */
function ensureImports(code: string): string {
  let next = code;
  // useEffect from react
  next = ensureNamedImport(next, 'react', ['useEffect']);
  // playSketchDraw from @revyme/runtime
  next = ensureNamedImport(next, '@revyme/runtime', ['playSketchDraw']);
  return next;
}

/** Strip the `playSketchDraw` import if no animation blocks remain.
 *  Conservative — leaves `useEffect` alone (other features may use it). */
function pruneImportsIfUnused(code: string): string {
  if (code.includes('__SKETCH_ANIM_BLOCK_BEGIN__')) return code;
  let next = code;
  const runtimeImportRe = /import\s+\{([^}]*)\}\s+from\s+['"]@revyme\/runtime['"]\s*;?\s*\n?/;
  const r = next.match(runtimeImportRe);
  if (!r) return next;
  const remaining = r[1].split(',').map(s => s.trim()).filter(s => s && s !== 'playSketchDraw');
  if (remaining.length === 0) {
    next = next.replace(runtimeImportRe, '');
  } else {
    next = next.replace(runtimeImportRe, `import { ${remaining.join(', ')} } from '@revyme/runtime';\n`);
  }
  return next;
}

// ─── Code transforms ────────────────────────────────────────────────────────

function setBlock(code: string, wrapperId: string, config: SketchAnimConfig): string {
  const sanId = sanitizeIdForRef(wrapperId);
  const inline = configToInlineLiteral(config);
  const blockBody =
    `${blockBegin(wrapperId)}\n` +
    `  useEffect(() => {\n` +
    `    const __wrapper_${sanId} = document.querySelector('[data-id="${wrapperId}"]');\n` +
    `    return playSketchDraw(__wrapper_${sanId}, ${inline});\n` +
    `  }, []);\n` +
    `  ${blockEnd(wrapperId)}`;

  // Replace existing block for this wrapper if present.
  const beginRe = blockBeginRe(wrapperId);
  const beginMatch = code.match(beginRe);
  if (beginMatch && beginMatch.index !== undefined) {
    const startIdx = beginMatch.index;
    const afterBegin = code.slice(startIdx);
    const endMatch = afterBegin.match(blockEndRe(wrapperId));
    if (endMatch && endMatch.index !== undefined) {
      const endIdx = startIdx + endMatch.index + endMatch[0].length;
      return code.slice(0, startIdx) + blockBody + code.slice(endIdx);
    }
  }

  // Fresh block — insert right after the page component's opening `{`.
  const exportRe = /export\s+default\s+function\s+\w+\s*\([^)]*\)\s*\{/;
  const m = code.match(exportRe);
  if (!m || m.index === undefined) {
    trace.error('sketch-anim-gen.setBlock:no-component-fn', {});
    return code;
  }
  const insertAt = m.index + m[0].length;
  return code.slice(0, insertAt) + `\n  ${blockBody}\n` + code.slice(insertAt);
}

function removeBlock(code: string, wrapperId: string): string {
  const beginRe = blockBeginRe(wrapperId);
  const beginMatch = code.match(beginRe);
  if (!beginMatch || beginMatch.index === undefined) return code;
  const startIdx = beginMatch.index;
  const afterBegin = code.slice(startIdx);
  const endMatch = afterBegin.match(blockEndRe(wrapperId));
  if (!endMatch || endMatch.index === undefined) return code;
  const endIdx = startIdx + endMatch.index + endMatch[0].length;
  // Trim leading whitespace + trailing newline so we don't leave a
  // blank line behind.
  let from = startIdx;
  while (from > 0 && (code[from - 1] === ' ' || code[from - 1] === '\t')) from--;
  if (code[from - 1] === '\n') from--;
  let to = endIdx;
  while (to < code.length && (code[to] === ' ' || code[to] === '\t')) to++;
  return code.slice(0, from) + code.slice(to);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function setSketchAnimInCode(
  code: string,
  nodeId: string,
  config: SketchAnimConfig,
): string {
  trace.fn('sketch-anim-gen.setSketchAnimInCode', { nodeId, config });
  let next = ensureImports(code);
  next = setBlock(next, nodeId, config);
  return next;
}

export function removeSketchAnimInCode(code: string, nodeId: string): string {
  trace.fn('sketch-anim-gen.removeSketchAnimInCode', { nodeId });
  let next = removeBlock(code, nodeId);
  next = pruneImportsIfUnused(next);
  return next;
}

export function createDefaultSketchAnim(): SketchAnimConfig {
  return { ...DEFAULT_SKETCH_ANIM };
}

// ─── Parsing back ───────────────────────────────────────────────────────────

const RX_OPTS_FOR_ID = (id: string) => new RegExp(
  `__SKETCH_ANIM_BLOCK_BEGIN__\\s+${escapeRe(id)}[\\s\\S]*?playSketchDraw\\s*\\([^,]+,\\s*(\\{[\\s\\S]*?\\})\\s*\\)\\s*;?[\\s\\S]*?__SKETCH_ANIM_BLOCK_END__\\s+${escapeRe(id)}`,
);

export function readSketchAnimFromCode(code: string, nodeId: string): SketchAnimConfig | null {
  const m = code.match(RX_OPTS_FOR_ID(nodeId));
  if (!m) return null;
  const literal = m[1];
  // Convert JS object literal → JSON: quote keys, swap single→double
  // quotes, drop trailing commas. Sufficient for our well-formed
  // emitter — we control both ends.
  const json = literal
    .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/'([^']*)'/g, '"$1"')
    .replace(/,\s*(\}|\])/g, '$1');
  try {
    const parsed = JSON.parse(json);
    return parseSketchAnimConfig(JSON.stringify(parsed));
  } catch {
    return null;
  }
}

/** All wrapper ids that have an animation block in source. */
export function listSketchAnimsInCode(code: string): string[] {
  const re = /__SKETCH_ANIM_BLOCK_BEGIN__\s+(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}
