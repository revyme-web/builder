// cascade-delete-variable.ts — "delete a variable → erase its hoist trail UP the chain".
//
// Deleting a component variable in its master (Variables modal → Remove) erases it from THAT
// file — but the HOIST TRAIL that fed it survives: every instance keeps passing
// `prop={pageVar}`, the instancing file keeps the now-unconsumed page/template variable, and a
// template's `__templateProps` keeps the per-route values — so the Template tool still renders
// an input for a variable that no longer exists anywhere (user report 2026-07-27: the header's
// `content` / "poon2" pill survived in the Body template + Template tool after deletion).
//
// This walks UP from the master:
//   1. strip `prop={…}` (and its per-viewport data-responsive overrides) from every
//      `<Component …/>` instance project-wide;
//   2. any BARE identifier those instances were passing (`content={content}`) whose variable
//      now has NO other use in that file is deleted there too, via the same full pipeline the
//      modal delete uses (param + references + @propMeta + __templateProps + @pageVariables);
//   3. if that file is itself a component, the walk continues to ITS instances — the chain can
//      be arbitrarily deep (component → wrapper component → template), so this is a worklist
//      with a visited set and a depth cap.
// A variable still used elsewhere in its file is left alone — only the DEAD trail is erased.
//
// Leaf orchestration module (imports mutation-queue + modify-file + pure helpers), same shape
// as remove-component-prop.ts, to avoid the mutation-queue ↔ modify-file circular dependency.

import { projectFS } from '../project/project-fs';
import { modifyProjectFile } from '../project/modify-file';
import { flushNow } from '../mutation/mutation-queue';
import { getComponentExportName } from '../components/component-ops';
import { stripPropFromAllInstancesInCode, collectInstancePropIdentifiers } from '../components/instance-prop-overrides';
import { isComponentPropUsed } from './variable-ops';
import { getPageVariables } from './page-variables';
import { applyDeleteVariablePipeline } from './delete-variable-pipeline';
import { trace } from '@/shared/debug-trace';

/** Chains deeper than this are pathological — stop rather than loop. */
const MAX_DEPTH = 5;

/**
 * Is `name` still meaningfully used in this file? The template route-map reassignment
 * (`x = __tp.x ?? x;`, incl. the `__mq`-gated per-viewport form) is PLUMBING, not a use — it
 * exists to feed the variable, so it must not keep the variable alive. Strip those lines first,
 * then ask babel whether the function param still has references. Conservative: an unparsable
 * file or a non-param identifier reads as "used" (no cascade).
 */
export function isVariableStillUsed(code: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutPlumbing = code.replace(new RegExp(`\\n?[ \\t]*${esc} = [^\\n]*__tp[^\\n]*;`, 'g'), '');
  return isComponentPropUsed(withoutPlumbing, name);
}

/**
 * Erase the hoist trail of a just-deleted variable, starting at its master file. Call AFTER
 * queueing the master's own `deleteComponentVariable` mutation — this flushes first, so the
 * walk always reads post-delete code.
 */
export function cascadeDeleteVariableUp(masterPath: string, propName: string): void {
  flushNow();
  const worklist: Array<{ path: string; prop: string; depth: number }> = [{ path: masterPath, prop: propName, depth: 0 }];
  const visited = new Set<string>([`${masterPath}::${propName}`]);
  while (worklist.length) {
    const { path, prop, depth } = worklist.shift()!;
    if (depth >= MAX_DEPTH) {
      trace.error('cascade-delete-variable:depth-cap', { path, prop, depth });
      continue;
    }
    const masterCode = projectFS.readFile(path);
    if (!masterCode) continue;
    const componentName = getComponentExportName(masterCode);
    if (!componentName) continue; // pages have no tag instances — nothing above them
    for (const filePath of projectFS.listFiles()) {
      if (filePath === path) continue;
      const fileCode = projectFS.readFile(filePath);
      if (!fileCode || fileCode.indexOf(`<${componentName}`) === -1) continue;
      // The bare identifiers the instances were passing — captured BEFORE the strip.
      const bound = collectInstancePropIdentifiers(fileCode, componentName, prop);
      const stripped = modifyProjectFile(filePath, (c) => stripPropFromAllInstancesInCode(c, componentName, prop));
      trace.action('cascade-delete-variable:strip-instances', { filePath, componentName, prop, bound });
      if (stripped == null) continue;
      for (const varName of bound) {
        if (isVariableStillUsed(stripped, varName)) {
          trace.action('cascade-delete-variable:var-still-used', { filePath, varName });
          continue;
        }
        const declared = getPageVariables(stripped).find((v) => v.name === varName);
        modifyProjectFile(filePath, (c) => applyDeleteVariablePipeline(c, varName, declared?.default));
        trace.action('cascade-delete-variable:deleted-upstream-var', { filePath, varName, depth: depth + 1 });
        const key = `${filePath}::${varName}`;
        if (!visited.has(key)) {
          visited.add(key);
          worklist.push({ path: filePath, prop: varName, depth: depth + 1 });
        }
      }
    }
  }
}
