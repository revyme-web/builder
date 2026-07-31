// cms-tool-schemas.ts — Gemini FunctionDeclaration[] for the CMS agent.
//
// The AI's vocabulary for working with CMS collections. Every tool is a
// thin wrapper over a `cms-ops.ts` function — the SAME path the human CMS
// editor drives — so the AI edits collections through validated ops, never
// raw JSON. Each schema name MUST have a matching executor in
// cms-tool-executors.ts.
//
// Tools that take an optional `collection` slug default to the collection
// currently open in the CMS editor overlay. `create_collection` returns a
// slug the agent then passes explicitly to build a brand-new collection.

import type { ToolSchema } from '../page-agent/tool-schemas';

// Every CMS field type — mirrors FieldDefinition['type'] in shared/types.ts.
const FIELD_TYPE_VALUES = [
  'text', 'textarea', 'richtext', 'number', 'boolean', 'date', 'image',
  'file', 'url', 'link', 'color', 'enum', 'tags', 'slug',
  'reference', 'multi-reference',
];

/** Slug of the collection the tool acts on — omit to use the active one. */
const COLLECTION_PROP = {
  collection: {
    type: 'string',
    description: 'Collection slug. Omit to target the collection currently open in the editor.',
  },
};

export const CMS_AGENT_TOOLS: ToolSchema[] = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: 'list_collections',
    description:
      'List every collection in the project — slug, display name, field count and item count. Call this to see what collections exist before creating or editing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_collection',
    description:
      'Get one collection in full: its schema (every field with id, name, type) and all of its items. Items are objects keyed by field id. Call this before editing so you know the field ids. Cheap — call again after mutations to verify.',
    parameters: { type: 'object', properties: { ...COLLECTION_PROP } },
  },

  // ── Collection-level ──────────────────────────────────────────────────────
  {
    name: 'create_collection',
    description:
      'Create a new, empty collection (it starts with one "Title" text field). Returns its slug — pass that slug to add_field / add_item to build it out.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "Blog Posts".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_collection',
    description: "Change a collection's display name. The slug (its id) is unchanged.",
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        name: { type: 'string', description: 'New display name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_collection',
    description:
      'Delete a collection and all of its items. Destructive and not undoable — only call this when the user explicitly asks to delete a collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Slug of the collection to delete.' },
      },
      required: ['collection'],
    },
  },

  // ── Fields (schema) ───────────────────────────────────────────────────────
  {
    name: 'add_field',
    description:
      'Add a field to a collection\'s schema. Returns the generated field id — use it as the key when you add_item values. For an "enum" field pass `options`; for a "reference"/"multi-reference" field pass `referenceCollection`.',
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        name: { type: 'string', description: 'Field display name, e.g. "Cover Image".' },
        type: { type: 'string', enum: FIELD_TYPE_VALUES, description: 'Field type.' },
        required: { type: 'boolean', description: 'Whether the field is required.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Choices for an "enum" field.',
        },
        referenceCollection: {
          type: 'string',
          description: 'Target collection slug for a "reference" / "multi-reference" field.',
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'update_field',
    description: "Change an existing field's name, type, required flag, options or reference target.",
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        fieldId: { type: 'string', description: 'The id of the field to change (from get_collection).' },
        name: { type: 'string' },
        type: { type: 'string', enum: FIELD_TYPE_VALUES },
        required: { type: 'boolean' },
        options: { type: 'array', items: { type: 'string' } },
        referenceCollection: { type: 'string' },
      },
      required: ['fieldId'],
    },
  },
  {
    name: 'remove_field',
    description: "Remove a field from a collection's schema.",
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        fieldId: { type: 'string', description: 'The id of the field to remove.' },
      },
      required: ['fieldId'],
    },
  },

  // ── Items (content) ───────────────────────────────────────────────────────
  {
    name: 'add_item',
    description:
      'Add an item to a collection. `values` is an object keyed by FIELD ID (not name) — e.g. { "title": "My Post", "excerpt": "..." }. Boolean fields take true/false, tags/multi-reference take string arrays. Returns the new item id.',
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        values: {
          type: 'object',
          description: 'Field id → value map for the new item.',
        },
      },
      required: ['values'],
    },
  },
  {
    name: 'update_item',
    description:
      'Update fields on an existing item. `values` is a partial field id → value map — only the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        itemId: { type: 'string', description: 'The _id of the item (from get_collection).' },
        values: { type: 'object', description: 'Field id → value map of changes.' },
      },
      required: ['itemId', 'values'],
    },
  },
  {
    name: 'remove_item',
    description: 'Delete an item from a collection by its id.',
    parameters: {
      type: 'object',
      properties: {
        ...COLLECTION_PROP,
        itemId: { type: 'string', description: 'The _id of the item to delete.' },
      },
      required: ['itemId'],
    },
  },
];
