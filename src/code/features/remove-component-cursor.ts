// remove-component-cursor.ts — "unbind a CURSOR variable at its SOURCE → detach it from every instance".
//
// The cursor-as-variable form is a component PROP like any other, so removing it has to cascade the same
// way `removeComponentPropProjectWide` does. It did not: `CursorTool` only ever rewrote the ACTIVE file,
// so X-ing the cursor pill on a master root stripped the `withCursor(...)` call there and left every
// instance project-wide still carrying `cursor={X} cursorOpts={{…}}` — props pointing at a parameter the
// master no longer declares (live find 2026-07-30, on instances inside a collection list).
//
// Cursor is TWO props, not one: the identifier (`cursor`) and the per-instance behaviour object
// (`cursorOpts`, see `cursorOptsPropName`). A sweep that strips only the first leaves the opts orphaned,
// which is the same bug one level down — both go, together.
//
// Leaf orchestration module (imports mutation-queue + modify-file + pure code helpers) so it avoids the
// mutation-queue ↔ modify-file circular dependency — same shape as remove-component-prop.ts.

import { projectFS } from '../project/project-fs';
import { modifyProjectFile } from '../project/modify-file';
import { flushNow } from '../mutation/mutation-queue';
import { deleteComponentVariableInCode, isComponentPropUsed } from './variable-ops';
import { getComponentExportName } from '../components/component-ops';
import { stripPropFromAllInstancesInCode } from '../components/instance-prop-overrides';
import { getComponentCursorForNode } from '../parsing/cursor-parser';
import { removeComponentCursorInCode, cursorOptsPropName } from '../generation/cursor-gen';
import { getActiveFilePath } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

/**
 * Remove a cursor VARIABLE from a component master and cascade the removal to every instance in the
 * project. Returns `true` when it handled the removal, `false` when the caller should fall back to its
 * plain single-file removal (not a component master, no cursor on the node, or a non-variable cursor —
 * an imported cursor component has no instance props to strip).
 *
 * When other nodes in the master still bind the same prop, the local call is removed but the prop and the
 * instance attrs are KEPT — exactly the last-binding rule `removeComponentPropProjectWide` uses.
 */
export function removeComponentCursorProjectWide(nodeId: string): boolean {
  const activePath = getActiveFilePath();
  // Only real components. Templates/layouts live under app/ and expose no instances to sweep.
  if (!activePath || !activePath.startsWith('components/')) return false;

  flushNow(); // sync projectFS with pending edits before reading the master
  const masterCode = projectFS.readFile(activePath);
  if (!masterCode) return false;

  const cursor = getComponentCursorForNode(masterCode, nodeId);
  // `componentName` holds the PROP identifier when the cursor is a variable.
  if (!cursor || !cursor.isVariable || !cursor.componentName) return false;

  const propName = cursor.componentName;
  const optsName = cursorOptsPropName(propName);
  const componentName = getComponentExportName(masterCode);
  if (!componentName) return false;

  // 1) Master: drop the `withCursor(...)` call on this node.
  const unbound = removeComponentCursorInCode(masterCode, nodeId);

  // Another node in the master still binds it → local unbind only, prop and instances stay.
  if (isComponentPropUsed(unbound, propName)) {
    modifyProjectFile(activePath, () => unbound);
    trace.action('remove-component-cursor:local-unbind', { activePath, nodeId, propName });
    return true;
  }

  // 2) Master: the prop is now dead — drop BOTH params from the signature.
  modifyProjectFile(activePath, () =>
    deleteComponentVariableInCode(deleteComponentVariableInCode(unbound, propName), optsName));

  // 3) Every OTHER project file: strip both attrs from all `<componentName …/>` instances.
  let stripped = 0;
  for (const path of projectFS.listFiles()) {
    if (path === activePath) continue;
    const fileCode = projectFS.readFile(path);
    if (!fileCode || fileCode.indexOf(`<${componentName}`) === -1) continue;
    modifyProjectFile(path, (c) =>
      stripPropFromAllInstancesInCode(stripPropFromAllInstancesInCode(c, componentName, propName), componentName, optsName));
    stripped++;
  }

  trace.action('remove-component-cursor:project-wide', {
    activePath, componentName, propName, optsName, instanceFilesStripped: stripped,
  });
  return true;
}
