// src/ai/agent/tools/semantic-property.ts
//
// Property (semantic) agent tools. Each tool follows the write path:
// ensureCheckpoint() → build a Mutation → queueToolMutation(ctx) → flushTool(ctx).
// queueToolMutation routes through the run's workspace (P8): branched runs
// scope {author, file, branchId} to their branch map; unbranched runs flush
// bare (legacy exact). All tools are category 'semantic' and return
// JSON-serialized text content.
// Never writes ProjectFS directly — the mutation queue owns the write path.

import { z } from 'zod';
import { queueToolMutation, flushTool, getToolTokens } from '@/ai/agent/workspace';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { coerceRecord } from './coerce';

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Record styles/attrs tolérant (coercition modèle) : un modèle peut envoyer
 * `styles` comme JSON string ou avec des valeurs numériques — le preprocess
 * répare au plus près du schéma, le zod ne rejette plus le tool_call entier.
 */
const recordSchema = z.preprocess(coerceRecord, z.record(z.string(), z.string()));

const stylesSchema = recordSchema.describe(
  'camelCase CSS properties, e.g. { padding: "64px", backgroundColor: "#6366f1" }; pass "" as a value to REMOVE that property',
);
const attrsSchema = recordSchema.describe('HTML attributes as {name: value} strings — src, href, alt, ...');

const NODE_ID_DESCRIBE = 'data-id of the target node';

export const setStylesTool: AgentTool = {
  name: 'set_styles',
  description:
    'Set CSS styles (camelCase) on a node. Pass "" to REMOVE a property. Optional viewport = breakpoint width in px (e.g. 768 for tablet) for a responsive override; omit for base/desktop.',
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    styles: stylesSchema,
    viewport: z
      .number()
      .optional()
      .describe('breakpoint width in px for a responsive override (e.g. 768 for tablet); omit for base/desktop'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const nodeId = args.node_id as string;
    const styles = args.styles as Record<string, string>;
    if (typeof args.viewport === 'number') {
      queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId, maxWidth: args.viewport, styles });
    } else {
      queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    }
    flushTool(ctx);
    return ok({ applied: Object.keys(styles).length, viewport: args.viewport ?? null });
  },
};

export const setTextTool: AgentTool = {
  name: 'set_text',
  description:
    'Set the plain text content of a node — inserted as plain text, no HTML or markup (use set_rich_text for rich content).',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE), text: z.string().describe('plain text content, no HTML') },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateText', nodeId: args.node_id as string, text: args.text as string });
    flushTool(ctx);
    return ok({});
  },
};

export const setRichTextTool: AgentTool = {
  name: 'set_rich_text',
  description:
    "REPLACES the node's entire subtree with rich-text HTML (TipTap-style: <p>, <span>, <br/>) — destructive: all existing children are removed. Use set_text for plain text.",
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE), html: z.string().describe("TipTap-style rich HTML: <p>, <span>, <br/>") },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateChildrenHTML', nodeId: args.node_id as string, html: args.html as string });
    flushTool(ctx);
    return ok({});
  },
};

export const setAttrTool: AgentTool = {
  name: 'set_attr',
  description:
    'Set HTML attributes on a node (src, href, alt...). Pass "" to remove an attribute. The node-identity attributes (data-id, data-name, id) are reserved and cannot be set here — the write does not land (silently in direct mode, with a batch rollback); choose the id at creation time via add_node id.',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE), attrs: attrsSchema },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateHtmlAttrs', nodeId: args.node_id as string, attrs: args.attrs as Record<string, string> });
    flushTool(ctx);
    return ok({});
  },
};

export const changeTagTool: AgentTool = {
  name: 'change_tag',
  description: 'Change the HTML tag of a node (e.g. div → section).',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE), tag: z.string().describe('new HTML tag, e.g. section') },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'changeTag', nodeId: args.node_id as string, newTag: args.tag as string });
    flushTool(ctx);
    return ok({});
  },
};

// ─── set_token (P7 §9(v)) ─────────────────────────────────────────────────
// Targeted design-token value write through the SAME queue mutation the
// panels use — no direct ProjectFS write. Two FIGÉE boundaries hold:
//   • existing tokens ONLY: an unknown name is a pedagogical refusal (call
//     get_design_tokens for the list) — never an orphan token, never a
//     silent no-op (updatePresetTokenInCSS would pass through unchanged);
//   • no propagation rewrite: usages reference var(--name) and follow the
//     value at render (rewriting call sites is Porte 8 or refused).
export const setTokenTool: AgentTool = {
  name: 'set_token',
  description:
    'Set the value of an EXISTING design token (e.g. color-brand → #4f46e5) — every var(--name) usage follows at render, no propagation rewrite. Unknown names are refused (orphan tokens forbidden) — call get_design_tokens for the list. Batchable like any value setter.',
  inputSchema: {
    name: z.string().describe('token name with or without the -- prefix, e.g. color-brand (must already exist)'),
    value: z.string().describe('new literal value, e.g. #4f46e5 (non-empty, no expressions)'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const rawName = ((args.name as string | undefined) ?? '').trim().replace(/^--/, '');
    const value = ((args.value as string | undefined) ?? '').trim();
    if (!rawName) return fail('Missing token name.');
    if (!value) return fail('Missing value — pass a non-empty literal (no expressions).');
    // M3: values interpolate raw into CSS — refuse breakout characters
    // (rule termination, new rules, tags). Panel-validated literals only.
    if (/[{};<>\n\r]/.test(value)) {
      return fail(`Invalid value "${value}" — plain literals only (no braces, semicolons, tags or newlines).`);
    }
    const known = new Map(getToolTokens(ctx).map((t) => [t.name, t.value]));
    if (!known.has(rawName)) {
      return fail(
        `Unknown token "${rawName}" — orphan tokens are forbidden. Call get_design_tokens for the existing list.`,
      );
    }
    const previous = known.get(rawName);
    queueToolMutation(ctx, { type: 'updatePresetToken', name: rawName, value });
    flushTool(ctx);
    return ok({ name: rawName, value, previous });
  },
};

export const PROPERTY_TOOLS: AgentTool[] = [
  setStylesTool,
  setTextTool,
  setRichTextTool,
  setAttrTool,
  changeTagTool,
  setTokenTool,
];
