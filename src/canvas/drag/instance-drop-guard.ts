// instance-drop-guard.ts — "can this node be a drop parent?" for anything a
// component MASTER owns.
//
// A component instance's children live in the component file, so neither the
// instance tag nor any element of its expansion (`<instanceId>:<masterNodeId>`)
// can ever receive a drop. The drag strategies used to rely solely on
// `hitIsOverComponentInstance`, which deliberately does NOT block an
// out-of-flow instance — an absolute overlay must be seen THROUGH to the
// container behind it. Seeing through has to mean SKIP: without this rule the
// hit loop fell past the wrapper and adopted one of the instance's own
// internals as the parent, drawing an insert line inside a card of a
// collection list (report 2026-09-09).

import { stripGhostSuffix } from '@/shared/ghost-id';

/** A node the MASTER owns: the instance tag itself, or any element of its
 *  expansion (`<instanceId>:<masterNodeId>`, carrying `componentInstanceId`).
 *  None of them can ever be a drop parent — their children live in the
 *  component file, not this page.
 *
 *  `hitIsOverComponentInstance` deliberately does NOT block an out-of-flow
 *  instance (an absolute overlay must be seen THROUGH to the container
 *  behind). That let the loop fall past the wrapper and then accept one of the
 *  instance's own internals as the parent — the drop line appeared inside a
 *  card of a collection list (report 2026-09-09). Seeing through means SKIP,
 *  so every instance-owned hit is now rejected explicitly. */
export function isInstanceOwnedNode(
  rawHitId: string,
  node: { componentInstanceId?: string | null; componentFile?: string | null; isComponentInstance?: boolean; isCodeComponent?: boolean } | null | undefined,
): boolean {
  if (!node) return false;
  if (node.componentInstanceId) return true;                       // expanded internal
  if (node.componentFile || node.isComponentInstance === true || node.isCodeComponent === true) return true; // the tag
  // Belt: the expansion id form, for a node the model shape didn't flag.
  const id = stripGhostSuffix(rawHitId);
  return id.includes(':') && !id.startsWith('layout::');
}

