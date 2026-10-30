// src/ai/agent/tools/semantic-property.ts
//
// Property (semantic) agent tools. Each tool follows the write path:
// ensureCheckpoint() → build a Mutation → queueToolMutation(ctx) → flushTool(ctx).
// queueToolMutation routes through the run's workspace (P8): branched runs
// scope {author, file, branchId} to their branch map; unbranched runs flush
// bare (legacy exact). All tools are category 'semantic' and return
// JSON-serialized text content.
// Never writes ProjectFS directly — the mutation queue owns the write path.

import { viewportKeyWidth, viewportForArg } from './viewport-arg';
import { z } from 'zod';
import { queueToolMutation, flushTool, getToolTokens, isBranchedRun, resolveToolFile } from '@/ai/agent/workspace';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { coerceRecord } from './coerce';
import { getDefaultStore } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { getI18nConfig } from '@/code/project/locale-ops';
import { commitTranslationText } from '@/code/project/translation-ops';
import { activeLocaleAtom, localeOverridesAtom } from '@/code/stores/locale-store';

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
    'Set CSS styles (camelCase) on a node. Pass "" to REMOVE a property. Optional viewport = breakpoint width in px (e.g. 810 for tablet) for a responsive override; omit for base/desktop.',
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    styles: stylesSchema,
    viewport: z
      .number()
      .optional()
      .describe('breakpoint width in px for a responsive override (e.g. 810 for tablet); omit for base/desktop'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const nodeId = args.node_id as string;
    const styles = args.styles as Record<string, string>;
    const keyWidth = viewportKeyWidth(args.viewport);
    if (keyWidth !== undefined) {
      queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId, maxWidth: keyWidth, styles });
    } else {
      queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    }
    flushTool(ctx);
    return ok({ applied: Object.keys(styles).length, viewport: args.viewport ?? null });
  },
};

/** Is `nodeId` a TRANSLATED text in `filePath` — its JSX child `{t('id')}`
 *  (or a rich `t.raw` message), its words in messages/<locale>.json? */
function translatedText(filePath: string, nodeId: string): { rich: boolean } | null {
  const code = filePath ? projectFS.readFile(filePath) : null;
  if (!code) return null;
  let node;
  try { node = parseJSXToNodes(code).get(nodeId); } catch { return null; }
  if (!node?.translationKey) return null;
  return { rich: !!node.richTranslation };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const setTextTool: AgentTool = {
  name: 'set_text',
  description:
    'Set the plain text content of a node — inserted as plain text, no HTML or markup (use set_rich_text for rich content). '
    + 'On a translated site this is how the DEFAULT language\'s copy changes: a text whose words live in messages/<default>.json is updated there (translate_texts writes the other languages).',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE), text: z.string().describe('plain text content, no HTML') },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const text = args.text as string;
    // TRANSLATED text: the JSX child is `{t('id')}` and the words live in
    // messages/<default>.json. `updateText` finds no JSXText to replace and
    // APPENDS one beside the t() call, so the element renders both — the
    // Content panel's 2026-08-09 bug, which the panel fixed and this tool
    // never got (customer's agent, 2026-10-30: "set_text only appends").
    // Write the default-locale message, exactly as the panel does.
    const filePath = resolveToolFile(ctx);
    const translated = translatedText(filePath, nodeId);
    if (translated) {
      if (isBranchedRun(ctx)) return fail('This text is translated (its words live in messages/*.json), which is written on the active branch only — run unbranched.');
      ctx.ensureCheckpoint();
      flushTool(ctx);
      const { defaultLocale } = getI18nConfig();
      commitTranslationText({
        filePath, nodeId, locale: defaultLocale, defaultLocale,
        text: translated.rich ? escapeHtml(text) : text, rich: translated.rich,
      });
      // messages/*.json is outside the parse→render loop — the JSX did not
      // change, so nothing would repaint the node. Mirror like the panel.
      const store = getDefaultStore();
      if (!translated.rich && store.get(activeLocaleAtom) === defaultLocale) {
        const next = new Map(store.get(localeOverridesAtom));
        next.set(nodeId, { ...(next.get(nodeId) ?? {}), text });
        store.set(localeOverridesAtom, next);
      }
      return ok({ updated: `messages/${defaultLocale}.json`, locale: defaultLocale });
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateText', nodeId, text });
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
