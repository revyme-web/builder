// section-insert.ts — Sections-library insert path.
//
// A blueprint is page-dialect JSX source (shared/sections-library). Insert
// parses it with the REAL parser inside a minimal page scaffold, converts
// the parsed nodes to a flat ClipboardNode tree, and hands it to
// `insertNodes()` — the same paste-engine pipe Ctrl+V uses. That buys id
// regeneration, smart placement (sibling of the selected section, or
// visible-center canvas drop when nothing is selected), undo, and full
// panel editability with zero blueprint-specific write paths.
//
// Fonts: font-preload only scans the project on load/page-switch, so a
// blueprint that introduces a new Google font would paint in the fallback
// stack until reload. Each blueprint declares its families; insert loads
// them into the canvas iframe (loadGoogleFont) AND heals the globals.css
// @import (ensureGoogleFontImport) so preview/publish resolve them too.

import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';
import type { ClipboardNode } from '@/code/features/paste-engine/types';
import { insertNodes } from '@/canvas/insertion-bridge';
import type { ToolbarItem } from '@/canvas/drag/toolbar-item-config';
import {
  getSectionBlueprint,
  wrapBlueprintInPage,
  sectionItemId,
  type SectionBlueprint,
} from '@/shared/sections-library';
import { loadGoogleFont } from '@/shared/font-loader';
import { ensureGoogleFontImport } from '@/code/project/preset-ops';
import { generateNodeId } from '@/shared/id-utils';
import type { NewNodeDescriptor } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

/** Families with a real Google Fonts face. System stacks (ui-monospace,
 *  Menlo, …) and generic keywords need no loading and must not be sent to
 *  the fonts API. Blueprints only list loadable families, but guard anyway. */
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'system-ui', 'ui-monospace', 'ui-serif', 'ui-sans-serif',
]);

/** Parse a blueprint's scaffolded source once and hand back the section
 *  root + the full node map. Null on parse failure / missing root — both
 *  library-authoring bugs, caught in CI by the oracle test, so runtime
 *  just traces and bails. */
function parseBlueprint(blueprint: SectionBlueprint): { root: CanvasNode; nodes: Map<string, CanvasNode> } | null {
  let parsed: Map<string, CanvasNode>;
  try {
    parsed = parseJSXToNodes(wrapBlueprintInPage(blueprint.source));
  } catch (err) {
    trace.error('section-insert:parse-failed', { id: blueprint.id, message: (err as Error).message });
    return null;
  }
  const scaffoldRoot = parsed.get('root');
  const rootId = scaffoldRoot?.children[0];
  const rootNode = rootId ? parsed.get(rootId) : undefined;
  if (!rootNode) {
    trace.error('section-insert:no-section-root', { id: blueprint.id });
    return null;
  }
  return { root: rootNode, nodes: parsed };
}

/** Load the blueprint's Google fonts into the canvas + heal the globals.css
 *  @import (see module header). Called at drag start AND click insert. */
function loadBlueprintFonts(blueprint: SectionBlueprint): void {
  for (const family of blueprint.fonts) {
    if (GENERIC_FAMILIES.has(family)) continue;
    void loadGoogleFont(family);
    ensureGoogleFontImport(family);
  }
}

/**
 * Parse a blueprint's source into the flat ClipboardNode list insertNodes
 * expects (root first, parentId null on the root). Returns [] on
 * library-authoring bugs (see parseBlueprint).
 */
export function blueprintToClipboardNodes(blueprint: SectionBlueprint): ClipboardNode[] {
  const result = parseBlueprint(blueprint);
  if (!result) return [];
  const { root: rootNode, nodes: parsed } = result;

  const out: ClipboardNode[] = [];
  const walk = (nodeId: string, isRoot: boolean) => {
    const node = parsed.get(nodeId);
    if (!node) return;
    out.push({
      id: node.id,
      type: node.type,
      parentId: isRoot ? null : node.parentId,
      children: [...node.children],
      order: node.order ?? 0,
      styles: { ...node.styles },
      attrs: { ...node.attrs },
      name: node.name,
      textContent: node.textContent,
      hasMixedContent: node.hasMixedContent,
      isCanvasNode: false,
      ...(isRoot ? { computedDimensions: { ...blueprint.canvasSize } } : {}),
    });
    for (const childId of node.children) walk(childId, false);
  };
  walk(rootNode.id, true);
  return out;
}

/**
 * Insert a library section onto the active page. Returns the created root
 * ids ([] on failure). Placement follows the paste rules: with a section
 * selected the blueprint lands as its sibling; with nothing selected it
 * drops at visible-center (materialised to `canvasSize` px).
 */
export function insertSectionBlueprint(blueprintId: string): string[] {
  const blueprint = getSectionBlueprint(blueprintId);
  if (!blueprint) {
    trace.error('section-insert:unknown-blueprint', { blueprintId });
    return [];
  }

  loadBlueprintFonts(blueprint);

  const nodes = blueprintToClipboardNodes(blueprint);
  if (nodes.length === 0) return [];

  const created = insertNodes(nodes);
  trace.action('section-insert:inserted', {
    blueprintId,
    nodeCount: nodes.length,
    createdRoots: created,
  });
  return created;
}

// ─── Toolbar drag path ──────────────────────────────────────────────────────
//
// The Insert panel drags sections exactly like every other element card.
// A blueprint converts to a ToolbarItem (same shape the plugin SDK's
// startLayoutDrag builds), so the DragCoordinator's toolbar strategy does
// the rest: ghost, drop lines, reparent, layout normalisation, addNode.

/** data-id prefix per tag class — matches the friendly-name conventions the
 *  toolbar catalogue uses (`frame-…`, `text-…`, `shape-…`). */
function idPrefixForTag(tag: string): string {
  if (tag === 'div') return 'frame';
  if (/^(p|span|h[1-6])$/.test(tag)) return 'text';
  if (tag === 'svg' || tag === 'path') return 'shape';
  return tag;
}

/** Rebuild a parsed subtree as a NewNodeDescriptor with FRESH ids. The
 *  toolbar path (unlike paste) uses descriptor ids verbatim, so every drop
 *  must mint new ones or a second insert would collide. */
function toDescriptor(node: CanvasNode, nodes: Map<string, CanvasNode>): NewNodeDescriptor {
  return {
    tag: node.type,
    id: generateNodeId(idPrefixForTag(node.type)),
    name: node.name || undefined,
    styles: { ...node.styles },
    attrs: Object.keys(node.attrs).length > 0 ? { ...node.attrs } : undefined,
    textContent: node.textContent || undefined,
    children: node.children.length > 0
      ? node.children.map((childId) => toDescriptor(nodes.get(childId)!, nodes))
      : undefined,
  };
}

/**
 * Build the ToolbarItem for a section blueprint drag. Parsed fresh per drag
 * start (cheap — a few ms) and the children factory mints new ids on every
 * call. Also loads the blueprint's fonts, since a drag IS insert intent.
 * Null on unknown id or authoring bugs (traced in parseBlueprint).
 */
export function blueprintToToolbarItem(blueprintId: string): ToolbarItem | null {
  const blueprint = getSectionBlueprint(blueprintId);
  if (!blueprint) {
    trace.error('section-insert:unknown-blueprint', { blueprintId });
    return null;
  }
  const result = parseBlueprint(blueprint);
  if (!result) return null;
  const { root, nodes } = result;

  loadBlueprintFonts(blueprint);

  // The strategy owns the root's drop context: it re-derives position for
  // canvas/absolute drops and the reorder machinery owns flow order — a
  // carried `order: '0'` from the blueprint would only fight it.
  const rootStyles = { ...root.styles };
  delete rootStyles.order;

  return {
    id: sectionItemId(blueprint.id),
    elementType: root.type,
    name: root.name || blueprint.name,
    defaultStyles: rootStyles,
    defaultAttrs: Object.keys(root.attrs).length > 0 ? { ...root.attrs } : undefined,
    textContent: root.textContent || undefined,
    children: root.children.length > 0
      ? () => root.children.map((childId) => toDescriptor(nodes.get(childId)!, nodes))
      : undefined,
    ghostSize: {
      width: parseInt(blueprint.canvasSize.width, 10) || 1280,
      height: parseInt(blueprint.canvasSize.height, 10) || 400,
    },
  };
}
