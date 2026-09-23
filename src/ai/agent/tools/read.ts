// src/ai/agent/tools/read.ts
//
// Read-only agent tools. Each tool follows the split: a pure projection
// (testable without the store) + an `execute` that reads state and projects.
// All tools are category 'read' and return JSON-serialized text content.
//
// ── Page-tree dialect ──────────────────────────────────────────────────────
//
// The active page is shown to the model as a COMPACT INDENTED TREE, one line
// per node, in document order (a parent always precedes its children; the
// children of one parent follow in their document order):
//
//   <id>  [<type>]  <name>  {<abbrev styles>}  "<text>"
//     <child line, +2 spaces per nesting level>
//
// Compactness rules, each load-bearing for the 6000-char PAGE_TREE_CAP:
//   • Style KEYS are abbreviated via STYLE_SHORTHAND — keys outside the map
//     are printed verbatim.
//   • Style entries whose value equals the CSS / builder default
//     (STYLE_DEFAULTS) are OMITTED — the builder writes `position:
//     'relative'` on virtually every node, so dropping it alone nearly
//     doubles the nodes that fit in a budget.
//   • `name` is printed only when it differs from both the id and the type
//     (a leaf named after its tag adds nothing).
//   • text is truncated to TREE_TEXT_CAP chars and the ellipsis '…' is
//     appended; the full text stays readable via get_node.
//   • attrs are NOT in the tree — get_node is the detail view.
//
// get_node (projectNode) returns the FULL detail of one node: complete
// camelCase style keys with ALL values (nothing abbreviated, nothing
// default-omitted), the complete text (to NODE_DETAIL_TEXT_CAP), attrs,
// children ids, type and name.
//
// Both the prompt's "Current page tree" section and the get_node_tree tool
// project through the SAME `projectNodeTree` — one dialect everywhere.

import { describeVariantAxis } from './components-more';
import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import type { CanvasNode } from '@/code/parsing/parser';
import { getNodesSnapshot, selectedIdsAtom } from '@/code/stores/store';
import {
  interactingViewportIdAtom,
  interactingViewportWidthAtom,
  viewportWidthsAtom,
  viewportsConfigAtom,
} from '@/code/stores/viewport-store';
import {
  activeFilePathAtom,
  getFileDisplayName,
  listPageFiles,
} from '@/code/project/active-file-store';
import { getPresetTokens } from '@/code/project/preset-ops';
import type { PresetToken } from '@/shared/types';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { buildComponentRegistry, type ComponentInfo, type ComponentProp } from '@/code/components/component-registry';
import { parsePropMeta } from '@/code/components/prop-meta';
import { getCollectionSchema, listCollections } from '@/code/project/cms-ops';
import { agentCheckpointsAtom } from '@/code/stores/agent-checkpoints';
import { trace } from '@/shared/debug-trace';
import {
  MIN_CONTRAST_RATIO,
  RENDERED_STYLE_PROPS,
  buildViewportTile,
  contrastRatio,
  formatContrastRatio,
  runDesignAudit,
  type AuditNode,
} from './design-audit';
import { waitForRender, settleObservation } from './wait-for-render';
import {
  collectEpochSnapshot,
  formatEpochEnvelope,
  formatUnmeasured,
  observationStatusWithEpoch,
  type ObservationEpoch,
  type ObservationStatus,
} from './observation-epoch';
import {
  resolveToolFile,
  getToolNodes,
  readToolFile,
  listToolPages,
  getToolTokens,
  canvasBranchGuard,
  branchFsView,
  isBranchedRun,
} from '@/ai/agent/workspace';
import { formatCompositionReport } from './composition';
import { formatNodeNotFound } from '../error-format';

/** Max chars of textContent printed inside the page tree before '…'. */
export const TREE_TEXT_CAP = 40;
/** Max chars of textContent returned by get_node (the detail view). */
export const NODE_DETAIL_TEXT_CAP = 2000;
/** Spaces of indentation per nesting level in the tree. */
export const TREE_INDENT_CHARS = 2;

/**
 * Style keys the tree abbreviates. The map is fixed and documented in the
 * system prompt (prompts/system.ts "Reading the page tree") so the model can
 * translate back to full names when calling set_styles / add_node etc.
 * A key ABSENT from this map is printed verbatim — omission is safe, the
 * abbreviation only ever costs 0–2 chars.
 */
export const STYLE_SHORTHAND: Record<string, string> = {
  alignItems: 'ai',
  backgroundColor: 'bg',
  border: 'bd',
  borderRadius: 'br',
  boxShadow: 'bx',
  color: 'c',
  cursor: 'cur',
  display: 'd',
  flex: 'fl',
  flexDirection: 'fd',
  flexWrap: 'fwp',
  fontSize: 'fs',
  fontWeight: 'fw',
  gap: 'g',
  height: 'h',
  justifyContent: 'jc',
  letterSpacing: 'lsp',
  lineHeight: 'lh',
  margin: 'm',
  marginTop: 'mt',
  maxHeight: 'mxh',
  maxWidth: 'mxw',
  minHeight: 'mnh',
  minWidth: 'mnw',
  objectFit: 'of',
  opacity: 'op',
  order: 'ord',
  overflow: 'ovf',
  padding: 'p',
  position: 'pos',
  textAlign: 'ta',
  textDecoration: 'td',
  transform: 'tf',
  width: 'w',
  zIndex: 'zi',
};

/**
 * Style values OMITTED from the tree because they are the CSS default — the
 * builder's own templates write `position: 'relative'` and `flex: '0 0 auto'`
 * everywhere, and a row of `pos:relative` lines would drown the signal.
 * Omitting a default is safe: the reader infers the standard default.
 * Entry comparison is EXACT string equality (no normalization) — a node that
 * asserts `fontWeight: '400'` keeps printing it.
 */
export const STYLE_DEFAULTS: Record<string, string> = {
  alignItems: 'stretch',
  boxShadow: 'none',
  cursor: 'auto',
  display: 'block',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  fontWeight: 'normal',
  height: 'auto',
  justifyContent: 'flex-start',
  opacity: '1',
  order: '0',
  overflow: 'visible',
  position: 'relative',
  textAlign: 'left',
  textDecoration: 'none',
  width: 'auto',
  zIndex: 'auto',
};

/** Full-detail projection of one node, as returned by get_node. */
export interface NodeDetail {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  children: string[];
  styles: Record<string, string>;
  attrs: Record<string, string>;
  text: string;
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function escapeQuote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Project a single CanvasNode into its full-detail agent-facing shape. */
export function projectNode(node: CanvasNode): NodeDetail {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    parentId: node.parentId,
    children: [...node.children],
    styles: { ...node.styles },
    attrs: { ...node.attrs },
    text: truncate(node.textContent ?? '', NODE_DETAIL_TEXT_CAP),
  };
}

/** The compact one-line tree entry for a node (no indentation, no children). */
export function formatTreeLine(node: CanvasNode): string {
  const parts: string[] = [node.id, `[${node.type}]`];
  if (node.name && node.name !== node.id && node.name !== node.type) parts.push(node.name);

  const styleEntries = [];
  for (const key of Object.keys(node.styles)) {
    const value = node.styles[key];
    if (value === undefined || value === '') continue; // '' means "property deleted"
    if (STYLE_DEFAULTS[key] === value) continue;
    styleEntries.push(`${STYLE_SHORTHAND[key] ?? key}:${value}`);
  }
  if (styleEntries.length > 0) parts.push(`{${styleEntries.join(', ')}}`);

  if (node.textContent) parts.push(`"${escapeQuote(truncate(node.textContent, TREE_TEXT_CAP))}"`);
  return parts.join('  ');
}

/**
 * Project the node map into its compact indented tree text — the string the
 * injector embeds in "## Current page tree" and get_node_tree returns.
 * Document order by construction: DFS from the roots following each node's
 * children array (the parser registers parents before children and keeps
 * sibling order, but the traversal does not depend on map insertion order).
 */
/** A run of at least this many same-shape siblings collapses to "1 + ×N". */
export const TREE_REPEAT_COLLAPSE_MIN = 4;

/** Repeated-shape test for the 2-level collapse (M7 D7): siblings collapse
 *  when they share the same type AND the same children signature (count +
 *  ordered child types). Content differences alone do not break the run — a
 *  grid of cards differs in text, not in structure. */
function areRepeatedSiblings(
  nodes: Map<string, CanvasNode>,
  a: CanvasNode,
  b: CanvasNode,
): boolean {
  if (a.type !== b.type) return false;
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const ca = nodes.get(a.children[i]);
    const cb = nodes.get(b.children[i]);
    if (ca?.type !== cb?.type) return false;
  }
  return true;
}

/** Recursive DFS emitting one line per node, collapsing runs of repeated
 *  same-shape siblings: the FIRST is rendered fully (its own subtree), then a
 *  single summary line lists the collapsed ids so they stay addressable. */
function projectTreeRec(
  nodes: Map<string, CanvasNode>,
  id: string,
  depth: number,
  visited: Set<string>,
  lines: string[],
): void {
  if (visited.has(id)) return;
  visited.add(id);
  const node = nodes.get(id);
  if (!node) return;

  lines.push(' '.repeat(depth * TREE_INDENT_CHARS) + formatTreeLine(node));
  const children = node.children;
  let i = 0;
  while (i < children.length) {
    const childId = children[i];
    const child = nodes.get(childId);
    let runEnd = i;
    if (child) {
      while (
        runEnd + 1 < children.length &&
        nodes.get(children[runEnd + 1]) !== undefined &&
        areRepeatedSiblings(nodes, child, nodes.get(children[runEnd + 1])!)
      ) {
        runEnd++;
      }
    }
    const runLength = runEnd - i + 1;
    if (child && runLength >= TREE_REPEAT_COLLAPSE_MIN) {
      projectTreeRec(nodes, childId, depth + 1, visited, lines);
      const rest = children.slice(i + 1, runEnd + 1);
      lines.push(
        `${' '.repeat((depth + 1) * TREE_INDENT_CHARS)}… ×${runLength - 1} more ${child.type} (same shape): ${rest.join(' ')}`,
      );
      for (const rid of rest) visited.add(rid);
      i = runEnd + 1;
    } else {
      projectTreeRec(nodes, childId, depth + 1, visited, lines);
      i++;
    }
  }
}

export function projectNodeTree(nodes: Map<string, CanvasNode>): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  const roots = [...nodes.values()]
    .filter((n) => !n.parentId || !nodes.has(n.parentId))
    .map((n) => n.id);
  for (const id of roots) projectTreeRec(nodes, id, 0, visited, lines);
  return lines.join('\n');
}

/** Project design tokens into a compact agent-facing shape. */
export function projectTokens(
  tokens: PresetToken[],
): { name: string; value: string; category: string; label?: string }[] {
  return tokens.map((t) => ({
    name: t.name,
    value: t.value,
    category: t.category,
    ...(t.label !== undefined ? { label: t.label } : {}),
  }));
}

/** Group display labels for token categories — lowercase, mirroring the CSS
 *  comment groups they are serialized from (preset-gen.ts CATEGORY_LABELS). */
const TOKEN_CATEGORY_LABELS: Record<PresetToken['category'], string> = {
  color: 'colors',
  typography: 'typography',
  spacing: 'spacing',
  margin: 'margin',
  radius: 'radius',
  shadow: 'shadows',
  border: 'borders',
  image: 'images',
  video: 'videos',
  other: 'other',
};

/**
 * Category order for the grouped tokens section: colors and spacing first —
 * they are the design-critical kinds a token cap must never drop — then the
 * rest in the canonical globals.css order (preset-gen.ts CATEGORY_ORDER).
 */
const TOKEN_CATEGORY_ORDER: PresetToken['category'][] = [
  'color', 'spacing', 'typography', 'margin', 'radius', 'shadow', 'border', 'image', 'video', 'other',
];

/** The section header and usage directive heading every tokens block. */
const DESIGN_TOKENS_HEADER = '## Design tokens — use these before inventing values';
const DESIGN_TOKENS_GUIDE = 'Prefer these tokens over hard-coded values for colors, spacing, radii and type scales.';

/**
 * Format design tokens into the grouped constraint section — one line per
 * category (`colors: color-brand → #6366f1, …`), empty categories omitted.
 * THE one dialect: buildContextBlock embeds it verbatim in the prompt
 * (capped) and get_design_tokens returns it uncapped, so the model always
 * reads the same syntax. A cap cuts whole categories in TOKEN_CATEGORY_ORDER,
 * so colors and spacing survive a budget cut; a truncated section gains a
 * hint pointing at the uncapped tool. Returns '' when there are no tokens.
 */
export function formatDesignTokens(tokens: PresetToken[], cap?: number): string {
  if (tokens.length === 0) return '';

  const limit = cap ?? Infinity;
  const groups = new Map<PresetToken['category'], PresetToken[]>();
  for (const token of tokens) {
    const list = groups.get(token.category) ?? [];
    list.push(token);
    groups.set(token.category, list);
  }

  let remaining = limit;
  let shown = 0;
  const lines: string[] = [];
  for (const category of TOKEN_CATEGORY_ORDER) {
    if (remaining <= 0) break;
    const group = groups.get(category);
    if (!group || group.length === 0) continue;
    const taken = group.slice(0, remaining);
    remaining -= taken.length;
    shown += taken.length;
    lines.push(`${TOKEN_CATEGORY_LABELS[category]}: ${taken.map((t) => `${t.name} → ${t.value}`).join(', ')}`);
  }
  if (shown < tokens.length) lines.push('…(truncated, call get_design_tokens for the full list)');
  return [DESIGN_TOKENS_HEADER, DESIGN_TOKENS_GUIDE, ...lines].join('\n');
}

const store = getDefaultStore();

/** The viewport argument's contract: an id ('desktop' | 'tablet' | 'mobile' |
 *  custom) OR a width in px (reverse-resolved to its viewport). */
export const VIEWPORT_DESCRIBE = 'a viewport id (desktop/tablet/mobile or custom) OR a width in px (1440, 768, 375)';

const NODE_ID_DESCRIBE = 'data-id of the target node';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * P8 (vi): viewport snapshot honoring the run's branch. Off-canvas-branch
 * runs get null rects (never main-canvas measurements of the wrong tree) +
 * an unavailable verdict; otherwise the epoch-stamped shared reader over
 * the run's node map.
 */
function snapshotForViewport(
  ctx: ToolContext | undefined,
  vp: { id: string; width: number | null },
): { nodes: AuditNode[]; epoch: ObservationEpoch; status: ObservationStatus; reason: string; offCanvas: boolean } {
  const guard = canvasBranchGuard(ctx);
  if (guard) {
    const nodes: AuditNode[] = [...getToolNodes(ctx).values()].map((n) => ({
      id: n.id,
      parentId: n.parentId,
      children: [...n.children],
      text: n.textContent ?? '',
      rect: null,
      computed: {},
    }));
    const unmeasured = nodes.map((n) => n.id);
    const epoch: ObservationEpoch = {
      renderSeq: null,
      projectVersionAtFill: null,
      projectVersionNow: null,
      stale: false,
      withRect: 0,
      total: nodes.length,
      unmeasured: unmeasured.slice(0, 20),
      unmeasuredTotal: unmeasured.length,
    };
    return { nodes, epoch, status: guard.status, reason: guard.reason, offCanvas: true };
  }
  const { nodes, epoch } = collectEpochSnapshot(getToolNodes(ctx), vp.id);
  const obs = observationStatusWithEpoch(vp, epoch);
  return { nodes, epoch, status: obs.status, reason: obs.reason, offCanvas: false };
}

export const getActiveFileTool: AgentTool = {
  name: 'get_active_file',
  description: 'Returns the file path of the active page or component.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    return ok({ path: resolveToolFile(ctx) });
  },
};

export const getViewportWidthTool: AgentTool = {
  name: 'get_viewport_width',
  description: 'Returns the active viewport width in px (desktop/tablet/mobile resolved).',
  inputSchema: {},
  category: 'read',
  async execute() {
    return ok({ width: store.get(interactingViewportWidthAtom) });
  },
};

export const getSelectionTool: AgentTool = {
  name: 'get_selection',
  description: 'Returns the ids of the currently selected canvas nodes.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    // Branched runs never see the human selection (decoupled navigation).
    if (ctx?.workspace) return ok({ ids: [] as string[] });
    return ok({ ids: store.get(selectedIdsAtom) });
  },
};

export const getNodeTreeTool: AgentTool = {
  name: 'get_node_tree',
  description:
    'Returns the active page as a compact indented tree — one line per element: id [type] name {abbreviated styles} "text", children indented below their parent, document order. Same format as the page tree in the prompt.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    const snapshot = getToolNodes(ctx);
    const tree = projectNodeTree(snapshot);
    if (snapshot.size === 0 || !tree) {
      return fail(
        'No active page / empty node tree — the active file may be missing or the page has no content. Check the active file path before reading.',
      );
    }
    return ok({ tree });
  },
};

export const getNodeTool: AgentTool = {
  name: 'get_node',
  description:
    'Returns one node by data-id with full detail: unabbreviated camelCase styles (defaults included), full text, attrs and children ids — the tree only shows a summary.',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE) },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const nodeId = args.node_id as string | undefined;
    if (!nodeId) return fail('Missing node_id.');
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(formatNodeNotFound(nodeId, nodes.keys()));
    return ok(projectNode(node));
  },
};

// ─── Rendered-layout observation tools ──────────────────────────────────────
//
// get_layout / get_visuals / audit_design read the RENDERED page through the
// canvas bridge caches (rectCache / computedCache — populated by the sandbox
// iframe via post-message events). All reads are synchronous local map
// lookups: no iframe round-trip, no DOM access from the parent (AGENTS.md
// invariant #1). A node whose rect is not cached yet is 'norect', never an
// error — the cache fills asynchronously after a render.

/**
 * Resolve the viewport a layout tool should read. Accepts a viewport ID
 * ('desktop' | 'tablet' | 'mobile' | custom id) OR a width in px (number or
 * numeric string — reversed to the viewport with that width); defaults to the
 * viewport the user is currently interacting with. `width: null` means the
 * id is unknown — the caller must report UNAVAILABLE, never pending.
 *
 * THE one resolver — the reverse lookup is the same contract everywhere.
 */
export interface ResolvedViewport {
  id: string;
  width: number | null;
}

/** Prefer the primary viewport id when several ids share the same width
 *  (desktop > tablet > mobile > insertion order — deterministic). */
function viewportIdForWidth(px: number, widths: Record<string, number>): { id: string; width: number } | null {
  const matches = Object.entries(widths).filter(([, w]) => w === px);
  if (matches.length === 0) return null;
  for (const preferred of ['desktop', 'tablet', 'mobile']) {
    const hit = matches.find(([key]) => key === preferred);
    if (hit) return { id: hit[0], width: hit[1] };
  }
  return { id: matches[0][0], width: matches[0][1] };
}

/** Pure resolver — testable without the store. `raw` is a model-supplied
 *  viewport value (string id, number px, numeric string, undefined). */
export function resolveViewportQuery(
  raw: unknown,
  interactingId: string,
  widths: Record<string, number>,
): ResolvedViewport {
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
    const px = Number(typeof raw === 'string' ? raw.trim() : raw);
    const match = viewportIdForWidth(px, widths);
    if (match) return match;
    return { id: String(raw), width: null };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const id = raw.trim();
    return { id, width: widths[id] ?? null };
  }
  return { id: interactingId, width: widths[interactingId] ?? null };
}

/** Store-backed resolver for every layout observation tool. */
export function resolveViewportArgs(raw: unknown): ResolvedViewport {
  return resolveViewportQuery(raw, store.get(interactingViewportIdAtom), store.get(viewportWidthsAtom));
}

// Canonical definition lives in observation-epoch.ts (P6 T4); re-exported
// here so existing importers keep working.
export type { ObservationStatus } from './observation-epoch';

/** The observation contract's status: unavailable (unknown viewport id —
 *  change the argument) > pending (no rects cached yet — retry) > ready
 *  (real measurement). Always accompanied by a reason for the model.
 *
 *  LEGACY (pre-P6): `ready` fired as soon as ONE rect was cached, so a
 *  partial snapshot (2/10 measured) reported `ready`. New code uses
 *  `observationStatusWithEpoch` (100 % coverage + fresh epoch required).
 *  Kept for external callers; the read tools no longer use it. */
export function observationStatus(
  vp: ResolvedViewport,
  withRect: number,
): { status: ObservationStatus; reason: string } {
  if (vp.width === null) {
    return {
      status: 'unavailable',
      reason: `Unknown viewport id "${vp.id}" — no width match. Pass 'desktop' | 'tablet' | 'mobile' | a custom viewport id, or a width in px.`,
    };
  }
  if (withRect === 0) {
    return {
      status: 'pending',
      reason: 'No rects cached yet — the canvas may be mid-render; wait a moment and call again.',
    };
  }
  return { status: 'ready', reason: 'Measured from the live canvas cache.' };
}

/** One get_layout line: `<id>  x:0 y:0 w:1440 h:900  visible`. */
function formatLayoutLine(node: AuditNode): string {
  if (!node.rect) return `${node.id}  norect`;
  const { x, y, width, height } = node.rect;
  const status = node.computed.display === 'none' ? 'hidden(display:none)' : 'visible';
  return `${node.id}  x:${Math.round(x)} y:${Math.round(y)} w:${Math.round(width)} h:${Math.round(height)}  ${status}`;
}

/** Abbreviated one-line style projection, reusing the tree's shorthand map. */
function formatStylesLine(computed: Record<string, string>): string {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(computed)) {
    if (value === '' || value === undefined) continue;
    entries.push(`${STYLE_SHORTHAND[key] ?? key}:${value}`);
  }
  return entries.join(', ');
}

export const getLayoutTool: AgentTool = {
  name: 'get_layout',
  description:
    'Returns the measured bounding rects of every rendered node in a viewport — where elements ACTUALLY landed after CSS is applied (flex, container rules, …). One line per node: <id>  x:.. y:.. w:.. h:..  visible|hidden(display:none)|norect. Use it to verify spacing, alignment and stacking. Optional viewport: a viewport id (\'desktop\' (default), \'tablet\', \'mobile\', a custom id) OR a width in px (1440, 768, 375) — a width resolves to the viewport with that width. The output carries status ("ready" | "pending" | "unavailable") with a reason, plus epoch/coverage/unmeasured: status is "ready" only at 100 % coverage on a fresh epoch — a turn is not finished while status is not "ready".',
  inputSchema: { viewport: z.union([z.string(), z.number()]).optional().describe(VIEWPORT_DESCRIBE) },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const vp = resolveViewportArgs(args.viewport);
    const { nodes: snapshot, epoch, status, reason, offCanvas } = snapshotForViewport(ctx, vp);
    const lines = snapshot.map(formatLayoutLine);
    trace.action('agent-tool:get_layout', { viewport: vp.id, nodes: snapshot.length, withRect: epoch.withRect, stale: epoch.stale });
    return ok({
      viewport: vp.id,
      viewport_width: vp.width,
      count: snapshot.length,
      status,
      reason,
      ...formatEpochEnvelope(epoch),
      note:
        vp.width === null
          ? `Unknown viewport id "${vp.id}" — no width match. Pass 'desktop' | 'tablet' | 'mobile' | a custom viewport id, or a width in px.`
          : epoch.withRect === 0
            ? 'No cached rects yet — the canvas may be mid-render; wait a moment and call again.'
            : undefined,
      lines,
    });
  },
};

export const getVisualsTool: AgentTool = {
  name: 'get_visuals',
  description:
    'Returns one node\'s RENDERED (computed) styles — the real applied values, not the declared inline styles: fontSize, color, backgroundColor, display, position, width, height, overflow, opacity, fontWeight, textAlign, lineHeight, borderRadius (abbreviated like the page tree) — plus its measured rect and its WCAG contrast ratio (text color vs background, null when either is unmeasurable). Optional viewport (a viewport id OR a width in px) and props (extra computed properties to read). The output carries status ("ready" | "pending" | "unavailable") with a reason plus epoch/coverage: "ready" only when the node is measured on a fresh epoch — a turn is not finished while status is not "ready".',
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    viewport: z.union([z.string(), z.number()]).optional().describe(VIEWPORT_DESCRIBE),
    props: z.array(z.string()).optional().describe('extra computed properties to read, e.g. lineHeight'),
  },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const nodeId = args.node_id as string;
    const vp = resolveViewportArgs(args.viewport);
    const { nodes: snapshot, epoch, offCanvas } = snapshotForViewport(ctx, vp);
    const node = snapshot.find((n) => n.id === nodeId);
    if (!node) {
      return fail(formatNodeNotFound(nodeId, snapshot.map((n) => n.id)));
    }
    // Off-canvas-branch: no measurement exists (rects would describe the
    // wrong tree) — report unavailable with the node unmeasured.
    if (offCanvas) {
      trace.action('agent-tool:get_visuals', { nodeId, viewport: vp.id, rect: false, stale: false });
      return ok({
        node_id: nodeId,
        viewport: vp.id,
        viewport_width: vp.width,
        status: 'unavailable' as const,
        reason: 'The canvas shows another branch — no live render exists here. Verify with verify_effect (code) or preview the branch.',
        ...formatEpochEnvelope(epoch),
        coverage: { withRect: 0, total: 1 },
        unmeasured: [nodeId],
        unmeasuredTotal: 1,
        rect: null,
        styles: '',
        contrast: null,
      });
    }
    const props = (args.props as string[] | undefined) ?? RENDERED_STYLE_PROPS;
    const computed: Record<string, string> = {};
    for (const p of props) computed[p] = node.computed[p] ?? '';
    const fg = computed.color ?? '';
    const bg = computed.backgroundColor ?? '';
    const ratio = contrastRatio(fg, bg);
    // Single-node verdict on the same contract: known viewport, the node
    // measured, and the epoch fresh — anything else is pending/unavailable.
    const nodeEpoch = {
      ...epoch,
      withRect: node.rect ? 1 : 0,
      total: 1,
      unmeasured: node.rect ? [] : [nodeId],
      unmeasuredTotal: node.rect ? 0 : 1,
    };
    const obs = observationStatusWithEpoch(vp, nodeEpoch);
    trace.action('agent-tool:get_visuals', { nodeId, viewport: vp.id, rect: !!node.rect, stale: epoch.stale });
    return ok({
      node_id: nodeId,
      viewport: vp.id,
      viewport_width: vp.width,
      status: obs.status,
      reason: obs.reason,
      // P6 (M2 review): the envelope speaks at the NODE's scope — coverage
      // 1/1 measured or 0/1 + the node in unmeasured — while the epoch core
      // (renderSeq/versions/stale) stays cache-wide. A viewport-wide
      // coverage next to a node status is a contradiction.
      ...formatEpochEnvelope(epoch),
      coverage: { withRect: node.rect ? 1 : 0, total: 1 },
      unmeasured: node.rect ? [] : [nodeId],
      unmeasuredTotal: node.rect ? 0 : 1,
      rect: node.rect
        ? { x: Math.round(node.rect.x), y: Math.round(node.rect.y), w: Math.round(node.rect.width), h: Math.round(node.rect.height) }
        : null,
      styles: formatStylesLine(computed),
      contrast:
        ratio !== null
          ? { ratio: formatContrastRatio(ratio), fg, bg, minimum: MIN_CONTRAST_RATIO }
          : null,
    });
  },
};

export const auditDesignTool: AgentTool = {
  name: 'audit_design',
  description:
    'Lints the RENDERED layout of a whole viewport against hard design rules and returns one line per violation: sibling OVERLAP (>4px on both axes), child OVERFLOW beyond its parent (>8px), SECTION_DEPASSE_VIEWPORT — a node leaving the viewport TILE (the whole frame) by >8px, which covers a ROOT rendered wider than its configured viewport width and a section that pours off the tile horizontally or below a fixed-height tile (>8px, informational — deliberate overflow art is fine), text CONTRAST below 4.5:1, FONT_SIZE below 12px, EMPTY dead spots (<8×8px with no content), likely text TRUNCATION (heuristic). Call it AFTER creating or editing a section, then fix what it reports. Optional viewport (a viewport id OR a width in px). The output carries status ("ready" | "pending" | "unavailable") with a reason plus epoch/coverage/unmeasured: "ready" only at 100 % coverage on a fresh epoch — "No violations detected." is only ever reported on ready; otherwise the summary says what is NOT measured — a turn is not finished while status is not "ready".',
  inputSchema: { viewport: z.union([z.string(), z.number()]).optional().describe(VIEWPORT_DESCRIBE) },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const vp = resolveViewportArgs(args.viewport);
    const config = store.get(viewportsConfigAtom).find((c) => c.id === vp.id);
    const auditOnce = (snap: ReturnType<typeof collectEpochSnapshot>): {
      status: string;
      reason: string;
      violations: string[];
      summary: string;
      checked: number;
      viewport_rect: unknown;
      epoch: unknown;
      coverage: unknown;
      unmeasured: string[];
      unmeasuredTotal: number;
    } => {
      const tile = buildViewportTile(snap.nodes, vp.width ?? 0, config?.height);
      const findings = runDesignAudit(snap.nodes, tile);
      const obs = observationStatusWithEpoch(vp, snap.epoch);
      const violations = findings.map((f) => `${f.rule}: ${f.message}`);
      // "No violations detected." is a full-coverage fresh-epoch claim —
      // never on a partial or stale snapshot (P6 T4).
      const summary =
        obs.status === 'ready'
          ? violations.length === 0
            ? 'No violations detected.'
            : `${violations.length} violation${violations.length === 1 ? '' : 's'} found.`
          : snap.epoch.withRect === 0
            ? `Not measured: ${snap.epoch.withRect}/${snap.nodes.length} nodes checked.`
            : snap.epoch.stale
              ? `Stale: the project changed since this measurement — re-render pending, ${snap.epoch.withRect}/${snap.nodes.length} nodes checked.` + formatUnmeasured(snap.epoch)
              : `Not measured: ${snap.epoch.withRect}/${snap.nodes.length} nodes checked.` + formatUnmeasured(snap.epoch);
      return {
        status: obs.status,
        reason: obs.reason,
        violations,
        summary,
        checked: snap.epoch.withRect,
        viewport_rect: tile,
        ...formatEpochEnvelope(snap.epoch),
      };
    };

    let snap = snapshotForViewport(ctx, vp);
    let out = auditOnce(snap);
    if (out.status !== 'ready' && vp.width !== null && !snap.offCanvas) {
      // Wait briefly for rects to fill before reporting pending — a read that
      // can be served after ~1s should not immediately say "come back later".
      // P6: wait on ANY non-ready (empty, partial or stale), not just empty.
      // Off-canvas-branch: no wait — no render will ever fill these rects.
      // A STALE snapshot is re-measured first (settleObservation): waiting
      // alone returned the same stale rects instantly and the turn ended on
      // the done-guard over a measurement of the agent's own edit.
      await settleObservation({ vpId: vp.id });
      snap = snapshotForViewport(ctx, vp);
      out = auditOnce(snap);
    }
    trace.action('agent-tool:audit_design', {
      viewport: vp.id,
      checked: out.checked,
      status: out.status,
      violations: out.violations.length,
    });
    return ok({
      viewport: vp.id,
      viewport_width: vp.width,
      ...out,
    });
  },
};

export const getCompositionTool: AgentTool = {
  name: 'get_composition',
  description:
    'Returns a STRUCTURAL summary of a viewport\'s rendered composition — what the layout MEANS, not its raw numbers: the visual regions (each with its span and share of the page height), each region\'s horizontal balance (centered / left-heavy / right-heavy), sibling alignment (aligned rows, aligned columns, equal widths/heights), column proportions (balanced 50/50 vs imbalanced 80/20), the type hierarchy (a healthy descending scale or a FLAT one), and abnormally large empty gaps. One line per constat, prefixed `regions:` / `balance:` / `alignment:` / `proportion:` / `type:` / `gap:`. Call it to UNDERSTAND a composition: before redesigning a section, after building one, or when the user says "make it nicer". Optional viewport (a viewport id OR a width in px). The output carries status ("ready" | "pending" | "unavailable") with a reason plus epoch/coverage/unmeasured — a turn is not finished while status is not "ready".',
  inputSchema: { viewport: z.union([z.string(), z.number()]).optional().describe(VIEWPORT_DESCRIBE) },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const vp = resolveViewportArgs(args.viewport);
    const { nodes: snapshot, epoch, status, reason } = snapshotForViewport(ctx, vp);
    const lines = formatCompositionReport(snapshot);
    trace.action('agent-tool:get_composition', {
      viewport: vp.id,
      nodes: snapshot.length,
      withRect: epoch.withRect,
      constats: lines.length,
      stale: epoch.stale,
    });
    return ok({
      viewport: vp.id,
      viewport_width: vp.width,
      count: snapshot.length,
      status,
      reason,
      ...formatEpochEnvelope(epoch),
      note:
        vp.width === null
          ? `Unknown viewport id "${vp.id}" — no width match. Pass 'desktop' | 'tablet' | 'mobile' | a custom viewport id, or a width in px.`
          : epoch.withRect === 0
            ? 'No cached rects yet — the canvas may be mid-render; wait a moment and call again.'
            : undefined,
      lines,
    });
  },
};

export const listPagesTool: AgentTool = {
  name: 'list_pages',
  description: 'Lists all pages of the project with their route names.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    return ok(listToolPages(ctx).map((p) => ({ path: p, name: getFileDisplayName(p) })));
  },
};

export const listComponentsTool: AgentTool = {
  name: 'list_components',
  description: 'Lists all project components with their file paths.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    // Branched runs read the branch registry (no version cache — the cache
    // is keyed by the global version and would serve the wrong map).
    // Presence-based (isolation A): bound even when the human visits.
    const branched = isBranchedRun(ctx);
    const registry = branched
      ? buildComponentRegistry(branchFsView(ctx!.workspace!.branchId))
      : buildComponentRegistry(projectFS, store.get(projectVersionAtom));
    return ok(
      Array.from(registry.values()).map((c) => ({ name: c.name, filePath: c.filePath })),
    );
  },
};

// ─── Component detail ───────────────────────────────────────────────────────
//
// get_component formats one registry entry as a compact line-per-prop text
// (not raw JSON), documented in the tool's description so the model can read
// it back:
//
//   Hero  (components/Hero.tsx)  —  3 props
//     title     type: text     default: "Build"               required: false
//     theme     type: option   default: "primary"             options: primary|dark
//     onTap     type: any      default: NONE (REQUIRED)
//
// VarTypes the builder knows (varType comes from the `@propMeta` block of the
// component file; absent → the prop's type is inferred by the default's shape):
//   text/string → any string          number  → "16", "0.5"    (string literal)
//   option      → ONE of `options:`      boolean/toggle → "true" | "false"
//   color       → a design token var(--x) or hex/rgb string
//   border      → a CSS border shorthand ("1px solid #eee")
//   font        → a font-family stack ("Inter, sans-serif")
//   anything else → free-form; follow the shape of the default

/** True when `defaultValue === null` — the prop is required (no declared default). */
function propIsRequired(p: ComponentProp): boolean {
  return p.defaultValue === null;
}

/** One `get_component` prop line: `name  type: ..  default: ..  options: ..  description?`. */
export function formatPropLine(p: ComponentProp, options: string[] = []): string {
  const type = p.varType ?? 'any';
  const def = propIsRequired(p)
    ? 'NONE (REQUIRED)'
    : JSON.stringify(p.defaultValue);
  const parts = [`${p.name}  type: ${type}`, `default: ${def}`];
  if (options.length > 0) parts.push(`options: ${options.join('|')}`);
  if (p.description) parts.push(`description: ${JSON.stringify(p.description)}`);
  return parts.join('  ');
}

/** The full component block — header line + one line per prop. */
export function formatComponentDetail(info: ComponentInfo, optionsByProp: Record<string, string[]> = {}): string {
  const header = `${info.name}  (${info.filePath})  —  ${info.props.length} prop${info.props.length === 1 ? '' : 's'}`;
  const lines = info.props.map((p) => `  ${formatPropLine(p, optionsByProp[p.name])}`);
  return [header, ...lines].join('\n');
}

/**
 * Read every 'option'-typed prop's choice list from the component source's
 * `@propMeta` block. The registry carries varType but not the option list —
 * that lives in the component file (prop-meta.ts). Pure over the source
 * string; {} when the file is unavailable or declares no options.
 */
export function readComponentPropOptions(code: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const meta = parsePropMeta(code);
  for (const [propName, entry] of Object.entries(meta)) {
    if (entry.type === 'option' && Array.isArray(entry.options) && entry.options.length > 0) {
      out[propName] = entry.options;
    }
  }
  return out;
}

/**
 * Up to 3 close component-name candidates for a "did you mean". Exact
 * case-insensitive hit first, then prefix matches (shortest first), then small
 * Levenshtein distances (≤3). Empty when nothing is close.
 */
export function suggestComponentNames(registryNames: string[], query: string): string[] {
  const q = query.toLowerCase();
  const caseHit = registryNames.find((n) => n.toLowerCase() === q);
  if (caseHit) return [caseHit];
  const prefixes = registryNames
    .filter((n) => n.toLowerCase().startsWith(q))
    .sort((a, b) => a.length - b.length);
  if (prefixes.length > 0) return prefixes.slice(0, 3);
  const scored = registryNames
    .map((n) => ({ n, d: levenshtein(n.toLowerCase(), q) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, 3).map((x) => x.n);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = new Array(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j < cols; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[cols - 1];
}

export const getComponentTool: AgentTool = {
  name: 'get_component',
  description:
    'Reads ONE project component in full: file path plus a line per prop — `name  type: <varType|any>  default: <"…"|NONE (REQUIRED)>  options: <a|b>` with an optional `description: …`. Types: text/string → a string; number → its string literal ("16", "0.5"); boolean/toggle → "true" or "false"; option → one of the listed options; color → a design token (`var(--x)`) or hex; border → a CSS shorthand. Call it BEFORE instantiating a component you haven\'t read — it teaches which props exist, which are required (default NONE (REQUIRED)), and which choices an option prop accepts.',
  inputSchema: { name: z.string().describe('component name, e.g. Hero') },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const name = (args.name as string | undefined)?.trim();
    if (!name) return fail('Missing component name.');
    const branched = isBranchedRun(ctx);
    const registry = branched
      ? buildComponentRegistry(branchFsView(ctx!.workspace!.branchId))
      : buildComponentRegistry(projectFS, store.get(projectVersionAtom));
    const info = registry.get(name);
    if (!info) {
      const hit = suggestComponentNames(Array.from(registry.keys()), name);
      trace.action('agent-tool:get_component-miss', { name, components: registry.size });
      return fail(
        hit.length > 0
          ? `No component named "${name}". Did you mean: ${hit.join(', ')}?`
          : `No component named "${name}". The project has ${registry.size} component(s) — call list_components to see them.`,
      );
    }
    const code = readToolFile(ctx, info.filePath);
    const options = code ? readComponentPropOptions(code) : {};
    trace.action('agent-tool:get_component', { name: info.name, propCount: info.props.length, optionProps: Object.keys(options).length });
    // Variants and connections too — the agent could style a variant it had no
    // way to discover (audit G5), and connections were invisible entirely.
    const axis = code ? describeVariantAxis(code) : '';
    return { content: [{ type: 'text', text: axis ? `${formatComponentDetail(info, options)}\n${axis}` : formatComponentDetail(info, options) }] };
  },
};

export const getDesignTokensTool: AgentTool = {
  name: 'get_design_tokens',
  description:
    'Returns ALL the project design tokens, grouped by category — the same format as the "## Design tokens" section in the prompt, minus the prompt\'s cap: `colors: color-brand → #6366f1, …`, `spacing: …`, `typography: …`. Call it when the section is truncated or a token you need is missing from it.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    return { content: [{ type: 'text', text: formatDesignTokens(getToolTokens(ctx)) }] };
  },
};

export const listCollectionsTool: AgentTool = {
  name: 'list_collections',
  description: 'Lists all CMS collections with their fields.',
  inputSchema: {},
  category: 'read',
  async execute(_args: Record<string, unknown>, ctx?: ToolContext) {
    // Isolation A: bound runs read the pinned branch's collections.
    const pin = ctx?.workspace?.branchId;
    const collections = [];
    for (const slug of listCollections()) {
      const schema = getCollectionSchema(slug);
      if (!schema) continue;
      collections.push({
        slug: schema.slug,
        name: schema.name,
        fields: schema.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
      });
    }
    return ok(collections);
  },
};

// ─── Bounded source + sealed-turn diff (P7 §9(v)) ────────────────────────────
//
// read_source: the exact bytes behind the projections, for precision work the
// tree/get_node cannot express (debugging a bounce, matching generated code).
// Bounded by lines AND chars (truncated flag when cut); project source files
// only — never secrets, never outside paths.
//
// turn_diff: READ-ONLY viewer over SEALED turn checkpoints (the same id
// deltas the Changes panel shows). No snapshots, no revert path — display
// only (D-T4: the running turn seals at done, so mid-turn it is not listed).
// This is the sanctioned turn_diff-RO surface (Porte 7 §9(v)/§11) : category
// 'read', zero writes, enforced by the G2 CI-grep exemption (no
// restoreSnapshot/write in this file).

/** Max lines / chars a single read_source call returns. */
export const READ_SOURCE_CAP_LINES = 400;
export const READ_SOURCE_CAP_CHARS = 12000;

/** Project source files only — no secrets, no outside paths. */
const READABLE_SOURCE_RE = /\.(tsx|ts|css|json)$/;

function clampLine(n: unknown, fallback: number, min: number, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(max, Math.max(min, v));
}

export const readSourceTool: AgentTool = {
  name: 'read_source',
  description:
    'Read bounded raw source of a project file (active file by default) — the exact bytes behind the tree/get_node projections, for precision work they cannot express. Capped at 400 lines / 12000 chars (truncated flag when cut, re-read with from_line/to_line). Project files only (.tsx/.ts/.css/.json); secrets and outside paths are refused.',
  inputSchema: {
    path: z.string().optional().describe('project file path, e.g. app/page.client.tsx (default: active file)'),
    from_line: z.number().optional().describe('1-based first line (default 1)'),
    to_line: z.number().optional().describe('1-based last line, inclusive (default: end of file)'),
  },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const rawPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : resolveToolFile(ctx);
    const path = rawPath.replace(/^\.\//, '').replace(/^\//, '');
    if (path.includes('..') || path.startsWith('.') || !READABLE_SOURCE_RE.test(path)) {
      return fail(`Refused path "${rawPath}" — read_source serves project source files only (.tsx/.ts/.css/.json, no secrets, no outside paths).`);
    }
    const code = readToolFile(ctx, path);
    if (code == null) return fail(`No such project file "${path}".`);
    const lines = code.split('\n');
    const total = lines.length;
    const from = clampLine(args.from_line, 1, 1, Math.max(1, total));
    let to = clampLine(args.to_line, total, from, Math.max(from, total));
    let truncated = false;
    if (to - from + 1 > READ_SOURCE_CAP_LINES) {
      to = from + READ_SOURCE_CAP_LINES - 1;
      truncated = true;
    }
    let content = lines.slice(from - 1, to).join('\n');
    if (content.length > READ_SOURCE_CAP_CHARS) {
      content = content.slice(0, READ_SOURCE_CAP_CHARS);
      truncated = true;
    }
    trace.action('agent-tool:read_source', { path, from, to, total, truncated });
    return ok({ path, from_line: from, to_line: to, total_lines: total, truncated, content });
  },
};

export const turnDiffTool: AgentTool = {
  name: 'turn_diff',
  description:
    'Read-only view of a SEALED turn’s file changes (per-file added/removed/changed data-ids) — the same deltas the Changes panel shows. Defaults to the last sealed turn; pass run_key (run-N) for an earlier one. The running turn seals at done, so mid-turn it is not listed yet. No snapshots, no revert path — display only.',
  inputSchema: {
    run_key: z.string().optional().describe('sealed turn key, e.g. run-3 (default: last sealed turn)'),
  },
  category: 'read',
  async execute(args, ctx?: ToolContext) {
    const sealed = store.get(agentCheckpointsAtom);
    if (sealed.size === 0) {
      return fail('No sealed turns yet — run the agent first; the running turn seals at done.');
    }
    // Isolation A: a bound run only ever sees its own branch's sealed turns
    // (presence-based) — never main's, never another branch's. Unbound runs
    // keep the legacy global view.
    const pin = ctx?.workspace?.branchId ?? null;
    const keys = [...sealed.keys()].filter((k) => !pin || sealed.get(k)?.branchId === pin);
    if (keys.length === 0) {
      return fail(`No sealed turns on branch "${pin}" yet — the running turn seals at done.`);
    }
    const key = typeof args.run_key === 'string' && args.run_key.trim() !== '' ? args.run_key.trim() : keys[keys.length - 1];
    const entry = sealed.get(key);
    if (!entry || (pin && entry.branchId !== pin)) {
      return fail(`No sealed turn "${key}" on branch "${pin}" — sealed turns on this branch: ${keys.join(', ') || '(none)'}.`);
    }
    trace.action('agent-tool:turn_diff', { runKey: key, files: entry.changes.length });
    return ok({
      scope: key === keys[keys.length - 1] ? 'last-sealed-turn' : 'sealed-turn',
      run_key: key,
      run_id: entry.runId ?? null,
      aborted: entry.aborted ?? false,
      changes: entry.changes.map((c) => ({ path: c.path, added: c.addedIds, removed: c.removedIds, changed: c.changedIds })),
    });
  },
};

export const READ_TOOLS: AgentTool[] = [
  getActiveFileTool,
  getViewportWidthTool,
  getSelectionTool,
  getNodeTreeTool,
  getNodeTool,
  getLayoutTool,
  getVisualsTool,
  auditDesignTool,
  getCompositionTool,
  listPagesTool,
  listComponentsTool,
  getComponentTool,
  getDesignTokensTool,
  listCollectionsTool,
  readSourceTool,
  turnDiffTool,
];