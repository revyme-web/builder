// component-spec/resolve-check.ts — gate 3 (ground truth).
//
// Runs the compiler's output through the canvas's OWN pipeline: it must parse
// (parseJSXToNodes) and every node must resolve cleanly for every variant
// (resolveVariantStyles). "Passes here" == "renders on the canvas", because this
// is the exact code the canvas runs. Anything that fails this never gets committed.

import { trace } from '@/shared/debug-trace';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { resolveVariantStyles } from '@/canvas/Renderer';
import { parseVariantConfig } from '@/code/variants/variant-config';
import type { Violation } from './types';

export interface CompiledFileLite {
  /** Used only for messages. */
  specName?: string;
  filePath: string;
  code: string;
}

/** Returns [] when every file parses and resolves across all its variants. */
export function resolveCheck(files: CompiledFileLite[]): Violation[] {
  const v: Violation[] = [];
  trace.fn('component-spec.resolveCheck', { files: files.length });

  for (const f of files) {
    const where = f.specName ?? f.filePath;

    // structural sanity
    if (!/export default withResponsiveProps\(/.test(f.code)) {
      v.push({ code: 'BAD_EXPORT', component: where, message: `${where}: missing \`export default withResponsiveProps(...)\`.` });
    }

    // must parse
    let nodes: ReturnType<typeof parseJSXToNodes>;
    try {
      nodes = parseJSXToNodes(f.code);
    } catch (err) {
      v.push({ code: 'RESOLVE_FAILED', component: where, message: `${where}: failed to parse — ${(err as Error).message}` });
      continue;
    }
    if (nodes.size === 0) {
      v.push({ code: 'RESOLVE_FAILED', component: where, message: `${where}: parsed to zero nodes.` });
      continue;
    }

    // every node resolves for every variant (component master uses variant name directly)
    const variants = parseVariantConfig(f.code).map((vc) => vc.name);
    const variantList = variants.length > 0 ? variants : ['default'];
    for (const variant of variantList) {
      for (const node of nodes.values()) {
        try {
          const styles = resolveVariantStyles(node, variant);
          if (styles == null || typeof styles !== 'object') {
            v.push({ code: 'RESOLVE_FAILED', component: where, variant, elementId: node.id, message: `${where}: node "${node.id}" did not resolve in variant "${variant}".` });
          }
        } catch (err) {
          v.push({ code: 'RESOLVE_FAILED', component: where, variant, elementId: node.id, message: `${where}: node "${node.id}" threw resolving variant "${variant}" — ${(err as Error).message}` });
        }
      }
    }
  }

  if (v.length > 0) trace.action('component-spec:resolve-check-violations', { count: v.length });
  return v;
}
