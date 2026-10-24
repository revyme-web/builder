// code-override-gen.ts — code overrides on canvas elements.
//
// Source shape (runtime `Override`, see runtime/src/code-override.tsx):
//
//   import { withMouseDistanceHeight } from '@/overrides/MouseHeight';
//   …
//   <Override with={withMouseDistanceHeight}>
//     <motion.div data-id="card-1" style={{…}} />
//   </Override>
//
// The wrapper sits DIRECTLY around one element and adds no DOM. The parser
// looks through it (node.codeOverrides), the canvas never runs it.
//
// Carrying the wrapper through every structural edit: the mutation queue LIFTS
// every `<Override>` off the file before a mutation runs and RESTORES it around
// the same data-id afterwards (element-wrapper.ts, shared with the Ticker
// effect's `<RevymeTicker>`).
//
// Override files live in `overrides/*.tsx` and export `withX(Component)`.

import { trace } from '@/shared/debug-trace';
import { findSubtreeRange } from './generator-utils';
import { liftElementWrappers, restoreElementWrappers, ensureRuntimeWrapperImport, type LiftedWrappers } from './element-wrapper';

export const OVERRIDES_DIR = 'overrides/';

/** data-id → the verbatim `<Override …>` opening tag that wrapped it. */
export type LiftedOverrides = LiftedWrappers;

/** Strip every `<Override>` wrapper, remembering which element each one wrapped. */
export function liftCodeOverrides(code: string): { code: string; lifted: LiftedOverrides } {
  return liftElementWrappers(code, 'Override');
}

/** Re-wrap each lifted element that still exists. */
export function restoreCodeOverrides(code: string, lifted: LiftedOverrides): string {
  return restoreElementWrappers(code, lifted, 'Override');
}

/** Override identifiers in a `<Override with={…}>` opening tag. */
export function overrideNamesInOpenTag(openTag: string): string[] {
  const m = /\bwith=\{\s*(\[[^]*?\]|[\w$.]+)\s*\}/.exec(openTag);
  if (!m) return [];
  const raw = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  return raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(s));
}

/** `withX` names exported by an override file: `export function withX(Component)` or an arrow const. */
export function listOverrideExports(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:\(|[A-Za-z_$][\w$]*\s*=>)/g)) names.add(m[1]);
  return [...names];
}

/** `overrides/MouseHeight.tsx` → `@/overrides/MouseHeight`. */
export function overrideImportPath(filePath: string): string {
  return '@/' + filePath.replace(/\.(tsx?|jsx?)$/, '');
}

export interface CodeOverrideRef {
  /** Project path of the override file, e.g. `overrides/MouseHeight.tsx`. */
  file: string;
  /** Exported override name, e.g. `withMouseDistanceHeight`. */
  name: string;
}

/**
 * Set (or clear, with an empty list) the overrides on one element and keep the
 * `@/overrides/*` imports in sync. Import names collide across files only if
 * two files export the same name; the second is aliased `name_File`.
 */
export function setCodeOverridesInCode(code: string, nodeId: string, overrides: CodeOverrideRef[]): string {
  trace.fn('generator.setCodeOverridesInCode', { nodeId, overrides });
  const { code: plain, lifted } = liftCodeOverrides(code);
  let out = plain;
  if (!findSubtreeRange(out, nodeId)) return code;

  const locals: string[] = [];
  for (const ref of overrides) {
    const { code: withImport, local } = ensureOverrideImport(out, ref);
    out = withImport;
    locals.push(local);
  }
  if (locals.length === 0) lifted.delete(nodeId);
  else lifted.set(nodeId, `<Override with={${locals.length === 1 ? locals[0] : `[${locals.join(', ')}]`}}>`);

  out = restoreCodeOverrides(out, lifted);
  return ensureRuntimeOverrideImport(pruneUnusedOverrideImports(out));
}

/** `Override` from `@revyme/runtime` while the file uses the wrapper. syncImports
 *  rebuilds the same line on a flush; writers outside the queue (paste) need it now. */
export function ensureRuntimeOverrideImport(code: string): string {
  return ensureRuntimeWrapperImport(code, 'Override');
}

function ensureOverrideImport(code: string, ref: CodeOverrideRef): { code: string; local: string } {
  const path = overrideImportPath(ref.file);
  const esc = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const existing = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"];?`).exec(code);
  if (existing) {
    for (const spec of existing[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [imported, alias] = spec.split(/\s+as\s+/);
      if (imported === ref.name) return { code, local: alias ?? imported };
    }
  }
  // A same-named import from another module → alias this one.
  const taken = new RegExp(`\\b(?:import|const|let|var|function)\\b[^;\\n]*\\b${ref.name}\\b`).test(code);
  const fileBase = ref.file.split('/').pop()!.replace(/\.\w+$/, '').replace(/\W/g, '_');
  const local = taken && !existing ? `${ref.name}_${fileBase}` : ref.name;
  const spec = local === ref.name ? ref.name : `${ref.name} as ${local}`;
  if (existing) {
    const specs = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    const line = `import { ${[...specs, spec].join(', ')} } from '${path}';`;
    return { code: code.replace(existing[0], line), local };
  }
  const line = `import { ${spec} } from '${path}';\n`;
  const lastImport = [...code.matchAll(/^import\b[^;]*;[ \t]*\n/gm)].pop();
  const at = lastImport ? lastImport.index! + lastImport[0].length : (/^(['"])use client\1;?\s*\n/.exec(code)?.[0].length ?? 0);
  return { code: code.slice(0, at) + line + code.slice(at), local };
}

/** Drop `@/overrides/*` import specifiers no `<Override with>` references any more. */
export function pruneUnusedOverrideImports(code: string): string {
  return code.replace(/import\s*\{([^}]*)\}\s*from\s*(['"])@\/overrides\/[^'"]+\2;?[ \t]*\n?/g, (whole, specs: string) => {
    const kept = specs.split(',').map((s) => s.trim()).filter(Boolean).filter((spec) => {
      const local = spec.split(/\s+as\s+/).pop()!;
      const body = code.replace(whole, '');
      return new RegExp(`\\b${local.replace(/\$/g, '\\$')}\\b`).test(body);
    });
    if (kept.length === 0) return '';
    return whole.replace(/\{[^}]*\}/, `{ ${kept.join(', ')} }`);
  });
}

/** Resolve the element's current overrides back to file + export via the file's imports. */
export function readCodeOverrides(code: string, nodeId: string): CodeOverrideRef[] {
  const { lifted } = liftCodeOverrides(code);
  const tag = lifted.get(nodeId);
  if (!tag) return [];
  return overrideNamesInOpenTag(tag).map((local) => resolveOverrideLocal(code, local)).filter((r): r is CodeOverrideRef => !!r);
}

export function resolveOverrideLocal(code: string, local: string): CodeOverrideRef | null {
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])@\/(overrides\/[^'"]+)\2/g)) {
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [imported, alias] = spec.split(/\s+as\s+/);
      if ((alias ?? imported) === local) return { file: `${m[3]}.tsx`, name: imported };
    }
  }
  return null;
}
