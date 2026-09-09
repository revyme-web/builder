// instance-replica-visibility.ts — the replica-entry visibility recipe for
// COMPONENT INSTANCES (design-component instances and code components) on a
// PAGE file.
//
// Every node entering a non-primary viewport gets the documented pair: an
// inline `display: 'none'` (the base — it is the ONLY thing that can hide the
// primary range, because a band keyed at the primary width is dropped by the
// generator's `normalizeResponsiveBandKeys` on every write) plus the entered
// band's `display: <original> !important` unhide. Instances used to skip BOTH
// halves on the theory that the bounded per-viewport @media hides "cover the
// primary range" — they never did, so a component dragged into tablet hid on
// mobile and stayed visible on desktop (2026-09-09).
//
// Instances now take the same pair. What differs is the UNHIDE VALUE:
//   · canvas: the instance tag renders as a WRAPPER <div>. Its inline display
//     passes through only as `none` (Renderer allow-list), its band display
//     lands through the @container rule, and `unset !important` collapses a
//     div to `inline` (0×0 box). The inner root never receives the tag's
//     `display:none` — expandComponent skips it, the wrapper owns hiding.
//   · live: the instance's `style` spreads LAST onto the master ROOT, and the
//     band rule targets that same root (`{...rest}` carries the data-id). The
//     unhide therefore has to restore the ROOT's own display — `block` on a
//     flex root would break its layout on the very viewport it shows on.
// Hence: the master root's display → else `block` (a code component's root is
// a plain element we can't see; `block` is the canvas container's natural
// display and the only safe guess).
import type { CanvasNode } from '@/code/parsing/parser';
import type { ProjectFS } from '@/code/project/project-fs';
import { projectFS } from '@/code/project/project-fs';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { readMasterRootDisplay } from '@/code/parsing/project-parser';
import { trace } from '@/shared/debug-trace';

/** The fields the recipe reads — satisfied by CanvasNode, ClipboardNode and
 *  the ad-hoc descriptor the toolbar drop builds. */
export interface InstanceLikeNode {
  type: string;
  styles?: Record<string, string>;
  isComponentInstance?: boolean;
  isCodeComponent?: boolean;
  componentFile?: string | null;
  componentInstanceId?: string | null;
  children?: string[];
}

/** A cached node the expanded root can be read from. */
interface RootLookupNode {
  styles?: Record<string, string>;
  componentInstanceId?: string | null;
  isComponentRoot?: boolean;
}

/** True for a design-component instance tag or a code-component tag. A
 *  `componentFile` WITHOUT `componentInstanceId` is the instance tag itself
 *  (descendants of an expansion carry the instance id). */
export function isInstanceLike(node: InstanceLikeNode | null | undefined): boolean {
  if (!node) return false;
  if (node.isComponentInstance === true || node.isCodeComponent === true) return true;
  return !!node.componentFile && !node.componentInstanceId;
}

/** A display value the unhide can restore. `none` defeats the unhide; the
 *  keyword resets collapse the canvas wrapper to `inline`. */
function usable(d: string | null | undefined): d is string {
  return !!d && d !== 'none' && d !== 'auto' && d !== 'unset' && d !== 'initial' && d !== 'inherit' && d !== 'revert';
}

/**
 * The `display` the entered band restores for an instance entering a replica.
 * Resolution order: the tag's own authored display → the expanded root in the
 * node cache → the master file's root → `block`.
 */
export function instanceReplicaUnhideDisplay(
  node: InstanceLikeNode,
  nodes?: Map<string, RootLookupNode> | null,
  fs: ProjectFS = projectFS,
): string {
  let source = 'block-fallback';
  let display: string | undefined;
  const own = node.styles?.display;
  if (usable(own)) {
    display = own; source = 'own';
  }
  if (!display && nodes && node.children?.length) {
    // The expanded root is the instance's first (and only) child in the cache.
    for (const cid of node.children) {
      const child = nodes.get(cid);
      if (!child || !(child.isComponentRoot || child.componentInstanceId)) continue;
      if (usable(child.styles?.display)) { display = child.styles!.display; source = 'expanded-root'; }
      break;
    }
  }
  if (!display && !node.isCodeComponent) {
    const file = node.componentFile
      || (/^[A-Z]/.test(node.type) ? buildComponentRegistry(fs).get(node.type)?.filePath : undefined);
    if (file && !/^https?:/i.test(file)) {
      const d = readMasterRootDisplay(fs, file);
      if (usable(d)) { display = d; source = 'master-file'; }
    }
  }
  const result = display ?? 'block';
  trace.action('instance-replica-visibility:unhide-display', { type: node.type, display: result, source });
  return result;
}
