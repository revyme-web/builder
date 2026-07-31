// remove-component-prop.ts — "remove a variable/prop at its SOURCE → detach it from every instance".
//
// When you X a component PROP pill inside the component MASTER (e.g. the Hide/border/padding pill on a
// node), and that was the prop's LAST binding, the reference removes the prop from the component AND strips
// `prop={…}` from every instance project-wide — so no instance points at a prop that no longer exists.
// The page/template VARIABLE that was bound on those instances STAYS in the Variables modal (it just
// becomes unused); only the instance ATTR is removed.
//
// This is a leaf orchestration module (imports mutation-queue + modify-file + the pure code helpers) so
// it avoids the mutation-queue ↔ modify-file circular dependency. Called from ControlProvider.removeVariable.

import { projectFS } from '../project/project-fs';
import { modifyProjectFile } from '../project/modify-file';
import { queueMutation, flushNow } from '../mutation/mutation-queue';
import { removeVariableInCode, isComponentPropUsed } from './variable-ops';
import { getComponentExportName } from '../components/component-ops';
import { stripPropFromAllInstancesInCode } from '../components/instance-prop-overrides';
import { getActiveFilePath } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

/**
 * If the active file is a component MASTER and removing this node's binding leaves the prop UNUSED,
 * drop the prop from the component signature AND strip it from every `<Component … prop={…}/>` instance
 * across the project. Returns `true` when it handled the removal (cascaded), `false` otherwise — the
 * caller should then fall back to its normal single-node unbind (which keeps the prop for other nodes).
 *
 * The page/template VARIABLE bound on the instances is intentionally left untouched (stays in the modal).
 */
export function removeComponentPropProjectWide(
  nodeId: string,
  styleProperty: string,
  propName: string,
  defaultValue: string,
): boolean {
  const activePath = getActiveFilePath();
  // Only real components (components/*). Templates/layouts live under app/ — excluded so this never
  // fires for a page/template variable (isComponentFileAtom is TRUE for templates — the classic trap).
  if (!activePath || !activePath.startsWith('components/')) return false;

  flushNow(); // sync projectFS with any pending edits before we read the master
  const masterCode = projectFS.readFile(activePath);
  if (!masterCode) return false;

  // Last-use check: simulate the unbind (keep prop) and see whether the param still has references.
  const unbound = removeVariableInCode(masterCode, nodeId, styleProperty, propName, defaultValue, false);
  if (isComponentPropUsed(unbound, propName)) return false; // other nodes still use it → normal unbind

  const componentName = getComponentExportName(masterCode);
  if (!componentName) return false;

  // 1) Master: unbind THIS node + drop the now-unused prop from the signature (deleteProp=true).
  queueMutation({ type: 'removeVariable', nodeId, styleProperty, propName, defaultValue, deleteProp: true });
  flushNow();

  // 2) Every OTHER project file: strip the prop from all `<componentName …/>` instances. Safe + project-wide.
  let stripped = 0;
  for (const path of projectFS.listFiles()) {
    if (path === activePath) continue;
    const fileCode = projectFS.readFile(path);
    if (!fileCode || fileCode.indexOf(`<${componentName}`) === -1) continue;
    modifyProjectFile(path, (c) => stripPropFromAllInstancesInCode(c, componentName, propName));
    stripped++;
  }

  trace.action('remove-component-prop:project-wide', { activePath, componentName, propName, instanceFilesStripped: stripped });
  return true;
}
