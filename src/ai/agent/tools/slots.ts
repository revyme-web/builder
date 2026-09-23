// src/ai/agent/tools/slots.ts
//
// Code-component SLOTS: a `"type": "slot"` control on a code component takes
// CONNECTED CANVAS NODES as its children (Carousel slides, LensBox content,
// Marquee items). The canvas shows the connection as a gesture; here it is a
// call. The write is the Slot control's own (slot-ops.ts): the canvas node is
// hoisted to `const cn_<id> = (<div data-canvas-node …/>)` and referenced
// as `{cn_<id>}` inside the instance — real JSX composition the live site
// renders verbatim. Inline children of a slot component are INVISIBLE on
// the canvas (oracle SLOT_COMPONENT_INLINE_CHILDREN) — connect, never nest.

import { z } from 'zod';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode, resolveToolFile } from '@/ai/agent/workspace';
import { projectFS } from '@/code/project/project-fs';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { getSlotConnections } from '@/code/generation/slot-ops';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

interface SlotInfo { instance: string; component: string; slot: string; label: string; max: number | 'infinite'; connected: string[] }

/** The slot control of an instance's master (a code component with `"type": "slot"`). */
function slotOf(ctx: ToolContext, instanceId: string): SlotInfo | { error: string } {
  const nodes = getToolNodes(ctx);
  const node = nodes.get(instanceId);
  if (!node) return { error: `No node "${instanceId}" in the active file.` };
  const tag = node.type;
  if (!/^[A-Z]/.test(tag) || tag.startsWith('motion.')) return { error: `"${instanceId}" is a plain <${tag}>, not a component instance.` };
  const code = getToolCode(ctx);
  const spec = extractImports(code).get(tag);
  const path = spec ? resolveImportPath(spec, resolveToolFile(ctx)) : null;
  const master = path ? projectFS.readFile(path) : null;
  if (!path || !master) return { error: `Could not find the master of ${tag}.` };
  const meta = parseComponentControlsMeta(master);
  if (!meta) return { error: `${tag} is a design component — it has no slots. Slots are a code-component control; its children are placed with add_node inside the master.` };
  const entry = Object.entries(meta.controls).find(([, c]) => c.type === 'slot');
  if (!entry) return { error: `${tag} declares no slot control. Its controls: ${Object.keys(meta.controls).join(', ') || 'none'}. (A slot is "children": { "type": "slot", "label": "…", "slotMax": 1 | "infinite" } in @controls.)` };
  const [slot, def] = entry;
  return { instance: instanceId, component: tag, slot, label: def.label, max: def.slotMax ?? 'infinite', connected: getSlotConnections(code, instanceId) };
}

/** Canvas nodes that can be connected: free-canvas nodes without a parent (the Slot control's own candidate list). */
function candidates(ctx: ToolContext): string[] {
  return [...getToolNodes(ctx).values()].filter((n) => n.isCanvasNode && !n.parentId).map((n) => n.id);
}

// ─── get_slots ───────────────────────────────────────────────────────────────

export const getSlotsTool: AgentTool = {
  name: 'get_slots',
  description: 'A code-component instance\'s SLOT (children control): its label, how many nodes it takes, what is connected, and which free-canvas nodes could be connected (add_canvas_node makes one).',
  inputSchema: { node_id: z.string().describe('the instance') },
  category: 'read',
  async execute(args, ctx) {
    const slot = slotOf(ctx, String(args.node_id));
    if ('error' in slot) return fail(slot.error);
    return ok({ ...slot, candidates: candidates(ctx).filter((id) => !slot.connected.includes(id)) });
  },
};

// ─── connect_slot ────────────────────────────────────────────────────────────

export const connectSlotTool: AgentTool = {
  name: 'connect_slot',
  description:
    'Connect a FREE-CANVAS NODE into a code component\'s slot — the canvas connection gesture: "put this card in the carousel", "this image in the lens box". ' +
    'The node must be a canvas node without a parent (add_canvas_node creates one; design it there, then connect). It renders inside the component on the canvas AND on the site; one node can feed several slots. A slotMax 1 slot replaces its content.',
  inputSchema: {
    node_id: z.string().describe('the code-component instance'),
    canvas_node_id: z.string().describe('a free-canvas node (data-canvas-node)'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const instanceId = String(args.node_id);
    const canvasId = String(args.canvas_node_id);
    const slot = slotOf(ctx, instanceId);
    if ('error' in slot) return fail(slot.error);
    const pool = candidates(ctx);
    if (!pool.includes(canvasId)) {
      const node = getToolNodes(ctx).get(canvasId);
      return fail(node
        ? `"${canvasId}" is not a free-canvas node (it sits inside "${node.parentId}"). Slot content lives on the canvas: add_canvas_node, build it, then connect it.`
        : `No node "${canvasId}". Free-canvas nodes available: ${pool.join(', ') || 'none — add_canvas_node first'}.`);
    }
    if (slot.connected.includes(canvasId)) return ok({ ...slot, note: 'already connected' });
    if (slot.max !== 'infinite' && slot.connected.length >= slot.max) {
      if (slot.max === 1) {
        ctx.ensureCheckpoint();
        for (const id of slot.connected) queueToolMutation(ctx, { type: 'disconnectSlot', componentId: instanceId, canvasNodeId: id });
      } else {
        return fail(`${slot.component}'s ${slot.label} slot takes ${slot.max} nodes and is full (${slot.connected.join(', ')}). disconnect_slot one first.`);
      }
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'connectSlot', componentId: instanceId, canvasNodeId: canvasId });
    flushTool(ctx);
    trace.action('agent-tool:connect_slot', { instanceId, canvasId });
    return ok({ instance: instanceId, component: slot.component, slot: slot.slot, connected: getSlotConnections(getToolCode(ctx), instanceId) });
  },
};

// ─── disconnect_slot ─────────────────────────────────────────────────────────

export const disconnectSlotTool: AgentTool = {
  name: 'disconnect_slot',
  description: 'Take a canvas node out of a code component\'s slot. The node goes back to the free canvas (delete_node removes it for good).',
  inputSchema: { node_id: z.string().describe('the instance'), canvas_node_id: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const instanceId = String(args.node_id);
    const canvasId = String(args.canvas_node_id);
    const slot = slotOf(ctx, instanceId);
    if ('error' in slot) return fail(slot.error);
    if (!slot.connected.includes(canvasId)) return fail(`"${canvasId}" is not connected to ${instanceId}. Connected: ${slot.connected.join(', ') || 'nothing'}.`);
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'disconnectSlot', componentId: instanceId, canvasNodeId: canvasId });
    flushTool(ctx);
    trace.action('agent-tool:disconnect_slot', { instanceId, canvasId });
    return ok({ instance: instanceId, connected: getSlotConnections(getToolCode(ctx), instanceId) });
  },
};

// ─── reorder_slot ────────────────────────────────────────────────────────────

export const reorderSlotTool: AgentTool = {
  name: 'reorder_slot',
  description: 'Change the order of the nodes connected to a multi-node slot (slide order in a carousel): move the node at from_index to to_index.',
  inputSchema: { node_id: z.string().describe('the instance'), from_index: z.number().int().min(0), to_index: z.number().int().min(0) },
  category: 'semantic',
  async execute(args, ctx) {
    const instanceId = String(args.node_id);
    const slot = slotOf(ctx, instanceId);
    if ('error' in slot) return fail(slot.error);
    const from = Number(args.from_index), to = Number(args.to_index);
    if (from >= slot.connected.length || to >= slot.connected.length) return fail(`Indices out of range — ${slot.connected.length} node(s) connected: ${slot.connected.join(', ')}.`);
    if (from === to) return ok({ instance: instanceId, connected: slot.connected, note: 'already there' });
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'reorderSlot', componentId: instanceId, fromIndex: from, toIndex: to });
    flushTool(ctx);
    trace.action('agent-tool:reorder_slot', { instanceId, from, to });
    return ok({ instance: instanceId, connected: getSlotConnections(getToolCode(ctx), instanceId) });
  },
};

export const SLOT_TOOLS: AgentTool[] = [getSlotsTool, connectSlotTool, disconnectSlotTool, reorderSlotTool];
