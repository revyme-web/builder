// src/ai/agent/tools/cms-more.ts
//
// What a collection LIST can be told to do (audit §5): which items, in which
// order, how many, paged; how a row reaches its detail page; the detail and
// index pages themselves; unbinding; reordering items and fields; a component
// prop fed from a field. All of it existed as builder operations — the
// Collection List panel's `updateCollectionConfig` / `setPagination`, the
// nav-link write, `createCms*PageFile`, `reorderCollection*` — and none of it
// was reachable by the agent, which could bind a list and then only say "the
// 6 newest posts" in prose.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode, isBranchedRun, resolveToolFile } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { listCollections, getCollectionSchema, getCollectionData, reorderCollectionItems, reorderCollectionFields, duplicateCollection } from '@/code/project/cms-ops';
import { createCmsIndexPageFile, createCmsDetailPageFile } from '@/code/project/cms-page-ops';
import { getEnclosingMapIteratorForNode, getEnclosingMapSourceForNode } from '@/code/generation/map-gen';
import { setInstanceProp } from '@/editor/tools/ComponentPropsTool/instance-props';
import { SEARCH_FIELD_PLACEHOLDER } from '@/code/generation/cms-search-field-gen';
import { parsePageVariables } from '@/code/features/page-variables';
import { isComponentFilePath } from '@/code/project/file-path-kind';
import { getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { paginationStateVar } from '@/code/generation/cms-pagination-gen';
import type { ResponsiveListConfig } from '@/code/generation/cms-responsive-gen';
import type { FilterGroup, SortConfig } from '@/shared/types';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'exists', 'between'] as const;

/** The collection a `.map()` reads, by the identifier at the head of its source. */
function collectionOfMap(code: string, nodeId: string): { slug: string; itemVar: string } | null {
  const src = getEnclosingMapSourceForNode(code, nodeId);
  if (!src) return null;
  const known = new Set(listCollections());
  for (const ident of src.sourceExpr.match(/[A-Za-z_$][\w$]*/g) ?? []) if (known.has(ident)) return { slug: ident, itemVar: src.iterVar };
  return null;
}

/** The LIST CONTAINER for a node: the container itself, or the container of
 *  the bound list a node sits in. The panel keys list config by the container
 *  (the parent whose children are the `.map()`). */
function listContainerFor(ctx: ToolContext, nodeId: string): { containerId: string; slug: string; itemVar: string } | { error: string } {
  const code = getToolCode(ctx);
  const nodes = getToolNodes(ctx);
  const node = nodes.get(nodeId);
  if (!node) return { error: `No node "${nodeId}" in the active file.` };
  // A node inside the map → its container is the nearest ancestor whose `.map()` this is.
  const inMap = collectionOfMap(code, nodeId);
  if (inMap) {
    let cur = node;
    while (cur.parentId) {
      const p = nodes.get(cur.parentId);
      if (!p) break;
      if (!getEnclosingMapIteratorForNode(code, p.id)) return { containerId: p.id, ...inMap };
      cur = p;
    }
    return { containerId: node.parentId ?? node.id, ...inMap };
  }
  // The container itself: its first child is inside the map.
  const first = node.children[0];
  const viaChild = first ? collectionOfMap(code, first) : null;
  if (viaChild) return { containerId: nodeId, ...viaChild };
  return { error: `"${nodeId}" is not a bound collection list (no .map() on a collection under it). Bind one first with bind_cms_list.` };
}

function fieldIds(slug: string): string[] {
  return getCollectionSchema(slug)?.fields.map((f) => f.id) ?? [];
}

export const setListConfigTool: AgentTool = {
  name: 'set_list_config',
  description:
    'Configure a bound collection LIST — the Collection List panel: which items (filter), in what order (sort), how many (limit / offset). node_id is the list container or any node inside it. ' +
    'filters: [{field, operator, value}] joined by combinator "and" | "or"; operators equals | not_equals | contains | not_contains | gt | gte | lt | lte | in | not_in | exists | between ([min, max]). ' +
    'sort: [{field, direction: "asc" | "desc"}] — "newest first" is [{field: "date", direction: "desc"}]. Pass an empty filters list / sort list / limit 0 to clear. Fields are ids (cms_get_collection).',
  inputSchema: {
    node_id: z.string(),
    filters: z.array(z.object({ field: z.string(), operator: z.enum(OPERATORS), value: z.unknown().optional() })).optional(),
    combinator: z.enum(['and', 'or']).optional(),
    sort: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) })).optional(),
    limit: z.number().optional().describe('max items, 0 = no limit'),
    offset: z.number().optional().describe('skip the first N'),
    viewport: z.number().optional().describe('breakpoint width in px (e.g. 375) to scope the FILTER / SORT to that breakpoint only — the base stays; limit / offset are not per breakpoint'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const list = listContainerFor(ctx, String(args.node_id));
    if ('error' in list) return fail(list.error);
    if (typeof args.viewport === 'number') return setListConfigOnBreakpoint(args, ctx, list);
    const ids = new Set(fieldIds(list.slug));
    const filters = (args.filters as { field: string; operator: (typeof OPERATORS)[number]; value?: unknown }[] | undefined);
    const sort = (args.sort as SortConfig[] | undefined);
    for (const f of [...(filters ?? []), ...(sort ?? [])]) {
      if (!ids.has(f.field) && !f.field.startsWith('_')) return fail(`"${f.field}" is not a field of ${list.slug}. Fields: ${[...ids].join(', ')}.`);
    }
    const filterGroup: FilterGroup | undefined = filters === undefined ? undefined : { combinator: (args.combinator as 'and' | 'or') ?? 'and', filters: filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value ?? null })) };
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, {
      type: 'updateCollectionConfig', parentId: list.containerId,
      filterGroup: filterGroup && filterGroup.filters.length > 0 ? filterGroup : undefined,
      sort: sort && sort.length > 0 ? sort : undefined,
      limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined,
      offset: typeof args.offset === 'number' && args.offset > 0 ? args.offset : undefined,
    });
    flushTool(ctx);
    trace.action('agent-tool:set_list_config', { container: list.containerId, slug: list.slug, filters: filters?.length ?? 0, sort: sort?.length ?? 0, limit: args.limit ?? null });
    return ok({ list: list.containerId, collection: list.slug, filters: filterGroup?.filters.length ?? 0, sort: sort ?? [], limit: args.limit ?? null, offset: args.offset ?? null });
  },
};

/** The panel's responsive commit: the base + this breakpoint's partial (filter /
 *  sort) through `setListResponsiveConfig`, which upgrades the list to the
 *  config-as-data shape the Renderer resolves per viewport. */
function setListConfigOnBreakpoint(args: Record<string, unknown>, ctx: ToolContext, list: { containerId: string; slug: string }): AgentToolResult {
  const width = Number(args.viewport);
  const widths = getSortedBreakpointWidths();
  if (!widths.includes(width)) return fail(`No breakpoint of ${width}px. Breakpoints: ${widths.join(', ')}.`);
  const primary = Math.max(...widths);
  if (width === primary) return fail(`${width}px is the primary breakpoint — its config is the base (omit viewport).`);
  if (typeof args.limit === 'number' || typeof args.offset === 'number') return fail('limit / offset are not per breakpoint — only filters and sort are. Set them without viewport.');
  const container = getToolNodes(ctx).get(list.containerId);
  const cl = container?.collectionList;
  if (!cl) return fail(`"${list.containerId}" is not a bound list.`);
  const ids = new Set(fieldIds(list.slug));
  const filters = args.filters as { field: string; operator: (typeof OPERATORS)[number]; value?: unknown }[] | undefined;
  const sort = args.sort as SortConfig[] | undefined;
  for (const f of [...(filters ?? []), ...(sort ?? [])]) {
    if (!ids.has(f.field) && !f.field.startsWith('_')) return fail(`"${f.field}" is not a field of ${list.slug}. Fields: ${[...ids].join(', ')}.`);
  }
  const partial: { filterGroup?: FilterGroup | null; sort?: SortConfig[] | null } = { ...(cl.responsive?.[String(width)] ?? {}) };
  if (filters !== undefined) partial.filterGroup = filters.length ? { combinator: (args.combinator as 'and' | 'or') ?? 'and', filters: filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value ?? null })) } : null;
  if (sort !== undefined) partial.sort = sort.length ? sort : null;
  const clean = (d: { filterGroup?: FilterGroup | null; sort?: SortConfig[] | null }) => {
    const out: { filterGroup?: FilterGroup; sort?: SortConfig[] } = {};
    if (d.filterGroup && d.filterGroup.filters.length) out.filterGroup = d.filterGroup;
    if (d.sort && d.sort.length) out.sort = d.sort;
    return out;
  };
  const viewport: Record<string, { filterGroup?: FilterGroup; sort?: SortConfig[] }> = {};
  for (const [k, d] of Object.entries(cl.responsive ?? {})) { const c = clean(d ?? {}); if (Object.keys(c).length) viewport[k] = c; }
  const mine = clean(partial);
  if (Object.keys(mine).length) viewport[String(width)] = mine; else delete viewport[String(width)];
  const variants: Record<string, { filterGroup?: FilterGroup; sort?: SortConfig[] }> = {};
  for (const [k, d] of Object.entries(cl.variantConfigs ?? {})) { const c = clean(d ?? {}); if (Object.keys(c).length) variants[k] = c; }
  const config: ResponsiveListConfig = { base: { filterGroup: cl.filterGroup ?? null, sort: cl.sort ?? [] }, viewport, variants };
  ctx.ensureCheckpoint();
  queueToolMutation(ctx, {
    type: 'setListResponsiveConfig', parentId: list.containerId, slug: list.slug, config,
    limit: cl.limit ?? null, offset: cl.offset ?? null,
    paginationVar: cl.pagination ? paginationStateVar(list.containerId) : null,
    variantArg: isComponentFilePath(resolveToolFile(ctx)) ? 'initialVariant' : undefined,
    vpWidths: widths,
  });
  flushTool(ctx);
  trace.action('agent-tool:set_list_config:breakpoint', { container: list.containerId, width, filters: filters?.length ?? 0, sort: sort?.length ?? 0 });
  return ok({ list: list.containerId, collection: list.slug, viewport: width, filters: mine.filterGroup?.filters.length ?? 0, sort: mine.sort ?? [], overrides: Object.keys(viewport).map(Number) });
}

// ─── change_list_source ──────────────────────────────────────────────────────

export const changeListSourceTool: AgentTool = {
  name: 'change_list_source',
  description:
    'Point a bound collection LIST at a DIFFERENT collection ("make this list show Team instead of Blog"). The Collection List panel\'s source switch: the .map() and import move to the new collection and each bound field is re-mapped to the new schema\'s field of the same id, else the first field of the same type — check the result and bind_cms_field what did not map.',
  inputSchema: { node_id: z.string().describe('the list container or any node inside it'), collection_slug: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const list = listContainerFor(ctx, String(args.node_id));
    if ('error' in list) return fail(list.error);
    const newSlug = String(args.collection_slug);
    if (newSlug === list.slug) return fail(`The list already shows ${newSlug}.`);
    const oldSchema = getCollectionSchema(list.slug);
    const newSchema = getCollectionSchema(newSlug);
    if (!newSchema) return fail(`No collection "${newSlug}". Collections: ${listCollections().join(', ')}.`);
    const bucket = (t: string) => (['text', 'textarea', 'slug', 'tags', 'enum'].includes(t) ? 'text' : ['image', 'file'].includes(t) ? 'image' : ['number', 'date', 'boolean'].includes(t) ? t : t);
    const remap: Record<string, string> = {};
    const consumed = new Set<string>();
    for (const f of oldSchema?.fields ?? []) {
      const same = newSchema.fields.find((n) => n.id === f.id && bucket(n.type) === bucket(f.type));
      const pick = same ?? newSchema.fields.find((n) => bucket(n.type) === bucket(f.type) && !consumed.has(n.id));
      if (pick) { remap[f.id] = pick.id; consumed.add(pick.id); }
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'changeCollectionSource', parentNodeId: list.containerId, newSlug, fieldRemap: remap });
    flushTool(ctx);
    const unmapped = (oldSchema?.fields ?? []).filter((f) => !remap[f.id]).map((f) => f.id);
    trace.action('agent-tool:change_list_source', { container: list.containerId, from: list.slug, to: newSlug, remapped: Object.keys(remap).length });
    return ok({ list: list.containerId, from: list.slug, to: newSlug, field_map: remap, ...(unmapped.length ? { unmapped, hint: 'bind_cms_field these nodes to a field of the new collection' } : {}) });
  },
};

export const setPaginationTool: AgentTool = {
  name: 'set_pagination',
  description: 'Page a bound collection list: mode "loadMore" (a button reveals the next page) or "infinite" (reveals on scroll), per_page items at a time. Pass mode "none" to remove pagination.',
  inputSchema: {
    node_id: z.string().describe('the list container or any node inside it'),
    mode: z.enum(['loadMore', 'infinite', 'none']),
    per_page: z.number().optional().describe('items per page (default 6)'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const list = listContainerFor(ctx, String(args.node_id));
    if ('error' in list) return fail(list.error);
    ctx.ensureCheckpoint();
    if (args.mode === 'none') queueToolMutation(ctx, { type: 'removePagination', parentId: list.containerId });
    else queueToolMutation(ctx, { type: 'setPagination', parentId: list.containerId, mode: args.mode as 'loadMore' | 'infinite', perPage: Math.max(1, Math.floor(Number(args.per_page ?? 6))) });
    flushTool(ctx);
    return ok({ list: list.containerId, mode: args.mode, per_page: args.mode === 'none' ? null : Number(args.per_page ?? 6) });
  },
};

export const linkRowsToPagesTool: AgentTool = {
  name: 'link_rows_to_pages',
  description:
    'Make each row of a bound list open ITS item\'s detail page — the row becomes a link to /<collection>/<slug>. node_id is the template row (or a link element inside it). The collection needs a detail page (create_collection_pages) and a slug field.',
  inputSchema: { node_id: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const code = getToolCode(ctx);
    const inMap = collectionOfMap(code, nodeId);
    if (!inMap) return fail(`"${nodeId}" is not inside a bound collection list.`);
    const node = getToolNodes(ctx).get(nodeId);
    const onMaster = /^components\//.test(resolveToolFile(ctx));
    ctx.ensureCheckpoint();
    // The Link tool's sequence: a navigating row is a <Link> on a page (a
    // <MotionLink> on a master, so its motion survives) — THEN the CMS href.
    if (onMaster) {
      if (node?.type !== 'MotionLink') queueToolMutation(ctx, { type: 'convertToMotionLink', nodeId });
    } else if (node?.type !== 'Link') {
      queueToolMutation(ctx, { type: 'changeTag', nodeId, newTag: 'Link' });
      queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: { textDecoration: 'none', color: 'inherit' } });
    }
    queueToolMutation(ctx, { type: 'setCmsNavHref', nodeId, mode: 'row', collection: inMap.slug, itemVar: inMap.itemVar });
    flushTool(ctx);
    return ok({ node_id: nodeId, collection: inMap.slug, href: `/${inMap.slug}/<item slug>` });
  },
};

export const createCollectionPagesTool: AgentTool = {
  name: 'create_collection_pages',
  description:
    'Scaffold the pages a collection needs — the builder\'s own templates: kind "detail" (one page per item at /<collection>/[slug]), "index" (a list page at /<collection>), or "both". Then restyle them with the semantic tools; keep the @cmsPage annotation and the bindings.',
  inputSchema: { collection: z.string().describe('collection slug'), kind: z.enum(['detail', 'index', 'both']).optional() },
  category: 'semantic',
  async execute(args, ctx) {
    const slug = String(args.collection);
    if (!listCollections().includes(slug)) return fail(`Collection "${slug}" does not exist — cms_create_collection first.`);
    if (isBranchedRun(ctx)) return fail('create_collection_pages writes the active branch only — run unbranched.');
    const kind = String(args.kind ?? 'both');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const written: string[] = [];
    if (kind === 'index' || kind === 'both') written.push(createCmsIndexPageFile(slug));
    if (kind === 'detail' || kind === 'both') written.push(createCmsDetailPageFile(slug));
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:create_collection_pages', { slug, kind, written });
    return ok({ collection: slug, written, note: 'Builder-scaffolded pages — open one with set_page and restyle it; keep the @cmsPage annotation and the data bindings.' });
  },
};

export const unbindCmsFieldTool: AgentTool = {
  name: 'unbind_cms_field',
  description: 'Stop a node\'s property following a CMS field and give it a static value again — the inverse of bind_cms_field. property is "text", an attribute (src, href) or a style property.',
  inputSchema: { node_id: z.string(), property: z.string(), value: z.string().optional().describe('the static value to put back (default: empty)') },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    if (!getToolNodes(ctx).has(nodeId)) return fail(`No node "${nodeId}" in the active file.`);
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'unbindField', nodeId, property: String(args.property), staticValue: String(args.value ?? '') });
    flushTool(ctx);
    return ok({ node_id: nodeId, property: args.property, value: args.value ?? '' });
  },
};

export const cmsReorderItemsTool: AgentTool = {
  name: 'cms_reorder_items',
  description: 'Set the order of a collection\'s items — pass every item id in the wanted order (cms_get_collection lists them). The manual order a list shows when it has no sort.',
  inputSchema: { collection: z.string().optional(), item_ids: z.array(z.string()).min(1) },
  category: 'cms',
  async execute(args, ctx) {
    const slug = String(args.collection ?? store.get(cmsEditorCollectionAtom) ?? '');
    if (!slug || !listCollections().includes(slug)) return fail(`Pass a collection slug (list_collections).`);
    const ids = (args.item_ids as string[]).map(String);
    const have = getCollectionData(slug).map((i) => i._id);
    const missing = have.filter((id) => !ids.includes(id));
    const unknown = ids.filter((id) => !have.includes(id));
    if (unknown.length) return fail(`Not items of ${slug}: ${unknown.join(', ')}.`);
    if (missing.length) return fail(`Every item must be listed — missing: ${missing.join(', ')}.`);
    if (isBranchedRun(ctx)) return fail('CMS edits target the active branch only.');
    ctx.ensureCheckpoint();
    reorderCollectionItems(slug, ids);
    store.set(projectVersionAtom, (v) => v + 1);
    return ok({ collection: slug, order: ids });
  },
};

export const cmsReorderFieldsTool: AgentTool = {
  name: 'cms_reorder_fields',
  description: 'Set the order of a collection\'s fields (the title stays first) — pass every field id in the wanted order.',
  inputSchema: { collection: z.string().optional(), field_ids: z.array(z.string()).min(1) },
  category: 'cms',
  async execute(args, ctx) {
    const slug = String(args.collection ?? store.get(cmsEditorCollectionAtom) ?? '');
    if (!slug || !listCollections().includes(slug)) return fail(`Pass a collection slug (list_collections).`);
    const ids = (args.field_ids as string[]).map(String);
    const have = fieldIds(slug);
    const unknown = ids.filter((id) => !have.includes(id));
    if (unknown.length) return fail(`Not fields of ${slug}: ${unknown.join(', ')}. Fields: ${have.join(', ')}.`);
    if (isBranchedRun(ctx)) return fail('CMS edits target the active branch only.');
    ctx.ensureCheckpoint();
    const done = reorderCollectionFields(slug, ids);
    if (!done) return fail(`Could not reorder the fields of ${slug}.`);
    store.set(projectVersionAtom, (v) => v + 1);
    return ok({ collection: slug, order: fieldIds(slug) });
  },
};

export const cmsDuplicateCollectionTool: AgentTool = {
  name: 'cms_duplicate_collection',
  description: 'Copy a collection — schema and items — into a new one. Returns the new slug.',
  inputSchema: { collection: z.string() },
  category: 'cms',
  async execute(args, ctx) {
    const slug = String(args.collection);
    if (!listCollections().includes(slug)) return fail(`No collection "${slug}".`);
    if (isBranchedRun(ctx)) return fail('CMS edits target the active branch only.');
    ctx.ensureCheckpoint();
    const copy = duplicateCollection(slug);
    if (!copy) return fail(`Could not duplicate ${slug}.`);
    store.set(projectVersionAtom, (v) => v + 1);
    return ok({ source: slug, slug: copy, name: getCollectionSchema(copy)?.name });
  },
};

export const bindCmsPropTool: AgentTool = {
  name: 'bind_cms_prop',
  description:
    'Feed a COMPONENT INSTANCE\'s prop from a CMS field — for an instance placed inside a bound list (the template row is a Card component, its title prop shows each post\'s title). prop is a declared prop (get_component); field_id from cms_get_collection. For an image field on an image prop the URL is passed through as-is.',
  inputSchema: { node_id: z.string().describe('the component instance inside the list'), component_name: z.string(), prop: z.string(), field_id: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const code = getToolCode(ctx);
    const inMap = collectionOfMap(code, nodeId);
    if (!inMap) return fail(`"${nodeId}" is not inside a bound collection list — bind_cms_list first.`);
    const fid = String(args.field_id);
    if (!fieldIds(inMap.slug).includes(fid)) return fail(`"${fid}" is not a field of ${inMap.slug}. Fields: ${fieldIds(inMap.slug).join(', ')}.`);
    if (isBranchedRun(ctx)) return fail('bind_cms_prop writes the active branch only — run unbranched.');
    const active = resolveToolFile(ctx);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wrote = modifyProjectFile(active, (c) => setInstanceProp(c, nodeId, String(args.component_name), String(args.prop), `${inMap.itemVar}.${fid}`, true));
    if (wrote === null) return fail(`Could not write ${active}.`);
    return ok({ node_id: nodeId, prop: args.prop, bound_to: `${inMap.itemVar}.${fid}`, collection: inMap.slug });
  },
};

// ─── add_list_search ─────────────────────────────────────────────────────────

export const addListSearchTool: AgentTool = {
  name: 'add_list_search',
  description:
    'Add a live SEARCH FIELD to a bound collection list — the Collection List panel\'s "Search field": a labelled text input placed just before the list, bound to a page variable, plus a "contains" filter on the given field that reads it as the visitor types (URL-shareable via ?<param>=). ' +
    'node_id is the list container or any node inside it; field is the collection field id to search (a text field — title, name, author…).',
  inputSchema: {
    node_id: z.string(),
    field: z.string().describe('collection field id to search in (cms_get_collection lists them)'),
    placeholder: z.string().optional().describe('input placeholder, default "Search..."'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const list = listContainerFor(ctx, String(args.node_id));
    if ('error' in list) return fail(list.error);
    const schema = getCollectionSchema(list.slug);
    const field = schema?.fields.find((f) => f.id === String(args.field));
    if (!field) return fail(`"${args.field}" is not a field of ${list.slug}. Fields: ${fieldIds(list.slug).join(', ')}.`);
    if (!['text', 'textarea', 'slug', 'tags'].includes(field.type)) return fail(`"${field.id}" is a ${field.type} field — search works on text fields (${schema!.fields.filter((f) => ['text', 'textarea', 'slug', 'tags'].includes(f.type)).map((f) => f.id).join(', ') || 'none'}).`);
    const code = getToolCode(ctx);
    const nodes = getToolNodes(ctx);
    const container = nodes.get(list.containerId);
    const existing = container?.collectionList?.filterGroup;
    if (existing?.filters.some((f) => f.valueSource === 'searchField' && f.field === field.id)) return fail(`${list.containerId} already has a search field on "${field.id}".`);
    // The panel's naming: a unique camelCase page variable + a unique frame id + a clean query param.
    const pascal = field.id.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    const taken = new Set([...(parsePageVariables(code)?.variables ?? []).map((v) => v.name), ...[...code.matchAll(/data-search-field="([^"]+)"/g)].map((m) => m[1])]);
    let varName = `search${pascal || 'Field'}`;
    for (let n = 2; taken.has(varName); n++) varName = `search${pascal || 'Field'}${n}`;
    let frameId = `search-${list.containerId}-${field.id}`;
    for (let n = 2; code.includes(`data-id="${frameId}"`); n++) frameId = `search-${list.containerId}-${field.id}-${n}`;
    const usedParams = new Set((parsePageVariables(code)?.variables ?? []).map((v) => v.queryParam).filter(Boolean) as string[]);
    const paramBase = field.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'search';
    let queryParam = paramBase;
    for (let n = 2; usedParams.has(queryParam); n++) queryParam = `${paramBase}-${n}`;
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'addCollectionSearchField', parentId: list.containerId, varName, frameId, fieldLabel: field.name, placeholder: (args.placeholder as string | undefined) ?? SEARCH_FIELD_PLACEHOLDER, isComponentFile: isComponentFilePath(resolveToolFile(ctx)), queryParam });
    const filters = [...(existing?.filters ?? []), { field: field.id, operator: 'contains' as const, value: '', valueSource: 'searchField' as const, valueVar: varName }];
    queueToolMutation(ctx, { type: 'updateCollectionConfig', parentId: list.containerId, filterGroup: { combinator: existing?.combinator ?? 'and', filters } });
    flushTool(ctx);
    trace.action('agent-tool:add_list_search', { container: list.containerId, field: field.id, varName, frameId });
    return ok({ list: list.containerId, field: field.id, input_frame: frameId, variable: varName, query_param: queryParam });
  },
};

export const CMS_MORE_TOOLS: AgentTool[] = [addListSearchTool, changeListSourceTool, 
  setListConfigTool, setPaginationTool, linkRowsToPagesTool, createCollectionPagesTool, unbindCmsFieldTool,
  cmsReorderItemsTool, cmsReorderFieldsTool, cmsDuplicateCollectionTool, bindCmsPropTool,
];
