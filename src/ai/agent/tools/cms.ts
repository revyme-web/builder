// src/ai/agent/tools/cms.ts
//
// The CMS, for the ONE agent. These used to belong to a separate CMS agent
// with its own loop, prompt and model (src/ai/cms-agent) — so a collection
// could only be built from the CMS panel, the page agent could bind a list but
// not create the collection it needed, and "make a blog: the collection AND
// the page" was two conversations with two assistants that could not see each
// other's work.
//
// Every tool delegates to `executeCmsTool`, the SAME validated path the old
// agent and the human CMS editor drive (cms-ops): the pure-text rule, the
// no-"language"-field rule and field-id resolution live there once, not in a
// second copy here. What this file adds is the agent's dialect — snake_case
// arguments, `cms_` names that cannot collide with the canvas tools, a
// checkpoint so a run is one undo step — and one bulk tool.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { executeCmsTool } from '@/ai/cms-agent/cms-tool-executors';
import { createBlankCollection } from '@/code/project/cms-ops';
import { projectVersionAtom } from '@/code/project/project-fs';

const FIELD_TYPES = [
  'text', 'textarea', 'richtext', 'number', 'boolean', 'date', 'image',
  'file', 'url', 'link', 'color', 'enum', 'tags', 'slug',
  'reference', 'multi-reference',
] as const;

const collectionArg = z.string().optional()
  .describe('collection slug — omit for the collection the user has open in the CMS');

/** The executors speak the OLD agent's dialect in their messages (bare tool
 *  names, camelCase arguments). A model told to "call get_collection" when the
 *  tool is `cms_get_collection` loses a round trip to an unknown-tool bounce. */
const LEGACY_NAMES: [RegExp, string][] = [
  [/\b(get_collection|create_collection|rename_collection|delete_collection|add_field|update_field|remove_field|add_item|update_item|remove_item|set_item_translation)\b/g, 'cms_$1'],
  [/\bitemId\b/g, 'item_id'],
  [/\bfieldId\b/g, 'field_id'],
  [/\breferenceCollection\b/g, 'reference_collection'],
];
export function toAgentDialect(text: string): string {
  // `cms_cms_x` if a message already used the new name — collapse it.
  return LEGACY_NAMES.reduce((t, [re, to]) => t.replace(re, to), text).replace(/\bcms_cms_/g, 'cms_');
}

function reply(response: Record<string, unknown>, isError: boolean): AgentToolResult {
  return { content: [{ type: 'text', text: toAgentDialect(JSON.stringify(response)) }], ...(isError ? { isError: true } : {}) };
}

/** Writes go to the branch the human is on, through cms-ops — the same limit,
 *  for the same reason, as apply_file_edit on a branch-bound run. */
function refuseIfBound(ctx: ToolContext | undefined): AgentToolResult | null {
  if (!ctx?.workspace) return null;
  return reply({ error: `CMS edits target the active branch only (this run is on "${ctx.workspace.branchId}").` }, true);
}

function run(name: string, args: Record<string, unknown>, ctx: ToolContext | undefined, mutates: boolean): AgentToolResult {
  if (mutates) {
    const refused = refuseIfBound(ctx);
    if (refused) return refused;
    ctx?.ensureCheckpoint();
  }
  const { response, isError } = executeCmsTool(name, args);
  return reply(response, isError);
}

const fieldShape = {
  name: z.string().describe('display name, e.g. "Cover Image"'),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional().describe('choices, for an "enum" field'),
  reference_collection: z.string().optional().describe('target collection slug, for reference / multi-reference'),
};

export const cmsGetCollectionTool: AgentTool = {
  name: 'cms_get_collection',
  description:
    'One collection in full: its schema (every field with id, name, type) and ALL of its items, keyed by field id. Call it before editing items so you know the field ids, and once after a run of changes to confirm what is there.',
  inputSchema: { collection: collectionArg },
  category: 'cms',
  async execute(args, ctx) { return run('get_collection', { collection: args.collection }, ctx, false); },
};

export const cmsCreateCollectionTool: AgentTool = {
  name: 'cms_create_collection',
  description:
    'Create a new, empty collection (it starts with one "Title" text field). Returns its slug — pass that slug as `collection` to cms_add_field / cms_add_items to build it out.',
  inputSchema: { name: z.string().describe('display name, e.g. "Blog Posts"') },
  category: 'cms',
  async execute(args, ctx) {
    const refused = refuseIfBound(ctx);
    if (refused) return refused;
    const name = String(args.name ?? '').trim();
    if (!name) return reply({ error: 'cms_create_collection requires a non-empty name.' }, true);
    // NOT the legacy executor: it refuses while a collection is open ("this
    // chat is locked to the active collection"). That was the old per-panel
    // fence. Focus is soft now — with Posts open, "add an Authors collection
    // and reference it" is an ordinary request.
    ctx?.ensureCheckpoint();
    try {
      const slug = createBlankCollection(name);
      getDefaultStore().set(projectVersionAtom, (v) => v + 1);
      return reply({ success: true, slug, name }, false);
    } catch (err) {
      return reply({ error: err instanceof Error ? err.message : String(err) }, true);
    }
  },
};

export const cmsRenameCollectionTool: AgentTool = {
  name: 'cms_rename_collection',
  description: "Change a collection's display name. Its slug (its id) is unchanged.",
  inputSchema: { collection: collectionArg, name: z.string() },
  category: 'cms',
  async execute(args, ctx) { return run('rename_collection', { collection: args.collection, name: args.name }, ctx, true); },
};

export const cmsDeleteCollectionTool: AgentTool = {
  name: 'cms_delete_collection',
  description:
    'Delete a collection, all of its items, and every binding to it on every page. ONLY when the user explicitly asked for this collection to be deleted. The slug is required — it never defaults.',
  inputSchema: { collection: z.string().describe('slug of the collection to delete') },
  category: 'cms',
  async execute(args, ctx) { return run('delete_collection', { collection: args.collection }, ctx, true); },
};

export const cmsAddFieldTool: AgentTool = {
  name: 'cms_add_field',
  description:
    'Add a field to a collection\'s schema. Returns the generated `field_id` — that id (not the name) is the key for item values.',
  inputSchema: { collection: collectionArg, ...fieldShape },
  category: 'cms',
  async execute(args, ctx) {
    return run('add_field', {
      collection: args.collection, name: args.name, type: args.type, required: args.required,
      options: args.options, referenceCollection: args.reference_collection,
    }, ctx, true);
  },
};

export const cmsUpdateFieldTool: AgentTool = {
  name: 'cms_update_field',
  description: "Change an existing field's name, type, required flag, options or reference target. Only what you pass changes.",
  inputSchema: {
    collection: collectionArg,
    field_id: z.string().describe('the field id (from the context or cms_get_collection)'),
    name: fieldShape.name.optional(),
    type: fieldShape.type.optional(),
    required: fieldShape.required,
    options: fieldShape.options,
    reference_collection: fieldShape.reference_collection,
  },
  category: 'cms',
  async execute(args, ctx) {
    return run('update_field', {
      collection: args.collection, fieldId: args.field_id, name: args.name, type: args.type,
      required: args.required, options: args.options, referenceCollection: args.reference_collection,
    }, ctx, true);
  },
};

export const cmsRemoveFieldTool: AgentTool = {
  name: 'cms_remove_field',
  description: "Remove a field from a collection's schema — its values are lost on every item. ONLY when the user asked for it.",
  inputSchema: { collection: collectionArg, field_id: z.string() },
  category: 'cms',
  async execute(args, ctx) { return run('remove_field', { collection: args.collection, fieldId: args.field_id }, ctx, true); },
};

const valuesArg = z.record(z.string(), z.unknown())
  .describe('FIELD ID → value. Text is PURE text (no HTML/Markdown). boolean fields take true/false; tags / multi-reference take string arrays.');

export const cmsAddItemsTool: AgentTool = {
  name: 'cms_add_items',
  description:
    'Add one or MANY items to a collection in a single call — `items` is a list of field-id → value maps. Use this for any batch ("8 blog posts") instead of a call per item. Items land as drafts. Returns each new item id; if some were rejected, the ones before and after them still landed and the reply says which failed and why.',
  inputSchema: { collection: collectionArg, items: z.array(valuesArg).min(1).max(50) },
  category: 'cms',
  async execute(args, ctx) {
    const refused = refuseIfBound(ctx);
    if (refused) return refused;
    ctx?.ensureCheckpoint();
    const items = (args.items as Record<string, unknown>[]) ?? [];
    const added: { index: number; item_id: unknown; item_slug: unknown }[] = [];
    const failed: { index: number; error: unknown }[] = [];
    items.forEach((values, index) => {
      const { response, isError } = executeCmsTool('add_item', { collection: args.collection, values });
      if (isError) failed.push({ index, error: response.error });
      else added.push({ index, item_id: response.itemId, item_slug: response.itemSlug });
    });
    // Honest about a partial landing: not atomic, and saying "failed" when 7
    // of 8 rows exist would make the model add those 7 again.
    return reply({ added: added.length, failed: failed.length, items: added, ...(failed.length ? { errors: failed } : {}) }, added.length === 0);
  },
};

export const cmsUpdateItemTool: AgentTool = {
  name: 'cms_update_item',
  description: 'Change fields on an existing item. `values` is PARTIAL — only the fields you want to change.',
  inputSchema: { collection: collectionArg, item_id: z.string().describe('the item _id (from cms_get_collection)'), values: valuesArg },
  category: 'cms',
  async execute(args, ctx) { return run('update_item', { collection: args.collection, itemId: args.item_id, values: args.values }, ctx, true); },
};

export const cmsRemoveItemTool: AgentTool = {
  name: 'cms_remove_item',
  description: 'Delete one item from a collection by its id. ONLY when the user asked for it.',
  inputSchema: { collection: collectionArg, item_id: z.string() },
  category: 'cms',
  async execute(args, ctx) { return run('remove_item', { collection: args.collection, itemId: args.item_id }, ctx, true); },
};

export const cmsSetItemTranslationTool: AgentTool = {
  name: 'cms_set_item_translation',
  description:
    'Translate ONE field of ONE item into ONE locale — the ONLY way to localize collection content. A translated collection keeps one row per item; NEVER add a "language" field and NEVER duplicate rows per locale. Untranslated fields fall back to the base row. An empty `value` clears the translation.',
  inputSchema: {
    collection: collectionArg,
    item_id: z.string(),
    locale: z.string().describe('target locale code, e.g. "fr"'),
    field: z.string().describe('FIELD ID to translate — not the display name'),
    value: z.string(),
  },
  category: 'cms',
  async execute(args, ctx) {
    return run('set_item_translation', {
      collection: args.collection, itemId: args.item_id, locale: args.locale, field: args.field, value: args.value,
    }, ctx, true);
  },
};

export const CMS_TOOLS: AgentTool[] = [
  cmsGetCollectionTool, cmsCreateCollectionTool, cmsRenameCollectionTool, cmsDeleteCollectionTool,
  cmsAddFieldTool, cmsUpdateFieldTool, cmsRemoveFieldTool,
  cmsAddItemsTool, cmsUpdateItemTool, cmsRemoveItemTool, cmsSetItemTranslationTool,
];
