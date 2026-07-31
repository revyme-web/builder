// cms-tool-executors.ts — Browser-side executors for the CMS agent tools.
//
// Each name matches a schema in cms-tool-schemas.ts. Every executor is a
// thin call into cms-ops.ts — the SAME validated path the human CMS editor
// drives — then bumps `projectVersionAtom` so the derived collection atoms
// (and the open editor overlay) re-read from ProjectFS.
//
// `executeCmsTool()` wraps each in a try/catch that turns a thrown error
// into `{ error }`, which becomes the functionResponse fed back to Gemini
// so the agent can self-correct.

import { getDefaultStore } from 'jotai';
import { projectVersionAtom } from '@/code/project/project-fs';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import {
  listCollections,
  getCollectionSchema,
  getCollectionData,
  createBlankCollection,
  renameCollection,
  cascadeDeleteCollection,
  addCollectionField,
  updateCollectionField,
  removeCollectionField,
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
  resolveItemValues,
} from '@/code/project/cms-ops';
import type { FieldDefinition } from '@/shared/types';
import type { ToolResult } from '../page-agent/tool-executors';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Re-derive the CMS atoms (and refresh the editor overlay) after a write. */
function bumpVersion(): void {
  store.set(projectVersionAtom, v => v + 1);
}

/** The collection a tool acts on — its explicit `collection` arg, else the
 *  one open in the CMS editor overlay. Throws a clear error if neither. */
function resolveCollection(args: any): string {
  const slug = (typeof args?.collection === 'string' && args.collection)
    || store.get(cmsEditorCollectionAtom);
  if (!slug) {
    throw new Error('No `collection` given and no collection is open. Pass a collection slug.');
  }
  return slug;
}

/** Assert a collection exists, returning its schema. */
function requireSchema(slug: string) {
  const schema = getCollectionSchema(slug);
  if (!schema) {
    throw new Error(`Collection "${slug}" not found. Call list_collections to see valid slugs.`);
  }
  return schema;
}

/** HTML/JSX tag shape (`<h2>`, `</p>`, `<span style=…>`). A bare `<` in prose
 *  ("a < b") never matches — the guard needs a tag-opening letter. */
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/;

/** CMS field values are PURE TEXT — reject any HTML/JSX markup. Styling
 *  belongs on the CANVAS (the elements the field is bound to), never inside
 *  the data: markup in a field renders as literal tags in plain bindings,
 *  the CMS editor shows unreadable soup, and translations/AI passes mangle
 *  it (user rule 2026-07-30). Paragraphs = blank lines. */
function assertPureTextValues(values: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(values)) {
    if (field.startsWith('_')) continue;
    if (typeof value !== 'string') continue;
    const m = HTML_TAG_RE.exec(value);
    if (m) {
      throw new Error(
        `CMS field "${field}" contains HTML markup ("${m[0]}") — field values must be PURE text. ` +
        `Styling lives on the canvas elements the field is bound to, never in the data. ` +
        `Write plain text and separate paragraphs with blank lines.`,
      );
    }
  }
}

// ─── Executors ──────────────────────────────────────────────────────────────

const EXECUTORS: Record<string, (args: any) => Record<string, any>> = {
  // ── Read ──
  list_collections: () => {
    const collections = listCollections().map(slug => {
      const schema = getCollectionSchema(slug);
      return {
        slug,
        name: schema?.name ?? slug,
        fieldCount: schema?.fields.length ?? 0,
        itemCount: getCollectionData(slug).length,
      };
    });
    return { collections };
  },

  get_collection: (args) => {
    const slug = resolveCollection(args);
    const schema = requireSchema(slug);
    return { slug, name: schema.name, fields: schema.fields, items: getCollectionData(slug) };
  },

  // ── Collection-level ──
  create_collection: (args) => {
    // Hard refusal when the chat is scoped to an active collection. The
    // tool is already stripped from the schema in that case (see
    // cms-agent-client.ts), so this is belt-and-suspenders: if the model
    // still emits the call, the error is fed back so it self-corrects
    // into add_field/add_item on the active collection.
    const active = store.get(cmsEditorCollectionAtom);
    if (active) {
      throw new Error(
        `Cannot create a new collection: this chat is locked to the active collection "${active}". ` +
        `Use add_field / add_item to edit it, or tell the user to open the CMS root to create a new collection.`,
      );
    }
    const name = String(args.name ?? '').trim();
    if (!name) throw new Error('create_collection requires a non-empty name.');
    const slug = createBlankCollection(name);
    bumpVersion();
    return { success: true, slug, name };
  },

  rename_collection: (args) => {
    const slug = resolveCollection(args);
    requireSchema(slug);
    const name = String(args.name ?? '').trim();
    if (!name) throw new Error('rename_collection requires a non-empty name.');
    renameCollection(slug, name);
    bumpVersion();
    return { success: true, slug, name };
  },

  delete_collection: (args) => {
    const slug = String(args.collection ?? '').trim();
    if (!slug) throw new Error('delete_collection requires an explicit collection slug.');
    requireSchema(slug);
    const removed = cascadeDeleteCollection(slug);
    bumpVersion();
    return { success: true, slug, ...removed };
  },

  // ── Fields ──
  add_field: (args) => {
    const slug = resolveCollection(args);
    requireSchema(slug);
    if (!args.name || !args.type) throw new Error('add_field requires `name` and `type`.');
    const fieldId = addCollectionField(slug, {
      name: String(args.name),
      type: args.type,
      required: !!args.required,
      options: Array.isArray(args.options) ? args.options.map(String) : undefined,
      referenceCollection: args.referenceCollection ? String(args.referenceCollection) : undefined,
    });
    if (!fieldId) throw new Error(`Could not add the field to "${slug}".`);
    bumpVersion();
    return { success: true, collection: slug, fieldId };
  },

  update_field: (args) => {
    const slug = resolveCollection(args);
    if (!args.fieldId) throw new Error('update_field requires `fieldId`.');
    const patch: Partial<FieldDefinition> = {};
    if (args.name !== undefined) patch.name = String(args.name);
    if (args.type !== undefined) patch.type = args.type;
    if (args.required !== undefined) patch.required = !!args.required;
    if (args.options !== undefined) patch.options = Array.isArray(args.options) ? args.options.map(String) : [];
    if (args.referenceCollection !== undefined) patch.referenceCollection = String(args.referenceCollection);
    const ok = updateCollectionField(slug, String(args.fieldId), patch);
    if (!ok) throw new Error(`No field "${args.fieldId}" in "${slug}". Call get_collection.`);
    bumpVersion();
    return { success: true, collection: slug, fieldId: args.fieldId };
  },

  remove_field: (args) => {
    const slug = resolveCollection(args);
    if (!args.fieldId) throw new Error('remove_field requires `fieldId`.');
    const ok = removeCollectionField(slug, String(args.fieldId));
    if (!ok) throw new Error(`No field "${args.fieldId}" in "${slug}". Call get_collection.`);
    bumpVersion();
    return { success: true, collection: slug, fieldId: args.fieldId };
  },

  // ── Items ──
  add_item: (args) => {
    const slug = resolveCollection(args);
    const schema = requireSchema(slug);
    const rawValues = (args.values && typeof args.values === 'object' && !Array.isArray(args.values))
      ? args.values
      : {};
    // Resolve value keys onto real field ids — throws on an unknown key so
    // the agent can't silently write to a field that doesn't exist.
    const values = resolveItemValues(schema, rawValues);
    assertPureTextValues(values);
    const item = addCollectionItem(slug, { ...values, _status: 'draft' });
    bumpVersion();
    return { success: true, collection: slug, itemId: item._id, itemSlug: item._slug };
  },

  update_item: (args) => {
    const slug = resolveCollection(args);
    const schema = requireSchema(slug);
    if (!args.itemId) throw new Error('update_item requires `itemId`.');
    if (!getCollectionData(slug).some(i => i._id === args.itemId)) {
      throw new Error(`No item "${args.itemId}" in "${slug}". Call get_collection.`);
    }
    const rawValues = (args.values && typeof args.values === 'object' && !Array.isArray(args.values))
      ? args.values
      : {};
    const values = resolveItemValues(schema, rawValues);
    assertPureTextValues(values);
    updateCollectionItem(slug, String(args.itemId), values);
    bumpVersion();
    return { success: true, collection: slug, itemId: args.itemId };
  },

  remove_item: (args) => {
    const slug = resolveCollection(args);
    if (!args.itemId) throw new Error('remove_item requires `itemId`.');
    if (!getCollectionData(slug).some(i => i._id === args.itemId)) {
      throw new Error(`No item "${args.itemId}" in "${slug}". Call get_collection.`);
    }
    removeCollectionItem(slug, String(args.itemId));
    bumpVersion();
    return { success: true, collection: slug, itemId: args.itemId };
  },
};

// ─── Public dispatch ────────────────────────────────────────────────────────

/**
 * Execute one CMS tool call against cms-ops. Never throws — a thrown error
 * becomes `{ error }` so the agentic loop can feed it back to the model.
 */
export function executeCmsTool(name: string, args: any): ToolResult {
  trace.action('cms-agent:tool-call', { name, args });
  const executor = EXECUTORS[name];
  if (!executor) {
    trace.error('cms-agent:unknown-tool', { name });
    return { response: { error: `Unknown tool: ${name}` }, isError: true };
  }
  try {
    const response = executor(args ?? {}) ?? { success: true };
    const isError = 'error' in response;
    trace.action('cms-agent:tool-result', { name, isError });
    return { response, isError };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    trace.error('cms-agent:tool-error', { name, message });
    return { response: { error: message }, isError: true };
  }
}
