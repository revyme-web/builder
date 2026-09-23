// src/ai/agent/tools/built-ins.ts
//
// The Insert panel's built-in code components — ~90 ready-made effects
// (AuroraBackground, AnimatedCounter, TypingEffect, VideoText, …) — were
// invisible to the agent (audit §10 G2): it rebuilt from scratch what one
// drop provides. `list_built_in_components` browses the same registry the
// panel installs from; `add_built_in_component` installs and places one.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { isBranchedRun } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom, listBuiltInCodeComponents, installBuiltInCodeComponent } from '@/code/project/project-fs';
import { addComponentInstanceTool, queueOrderWrites } from './semantic-structure';
import { queueToolMutation, flushTool, getToolNodes, resolveToolFile } from '@/ai/agent/workspace';
import { SECTION_BLUEPRINTS, getSectionBlueprint } from '@/shared/sections-library';
import { blueprintToToolbarItem } from '@/canvas/section-insert';
import { seedFlowChild } from './flow-placement';
import { isPageClientFile } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';
import type { NewNodeDescriptor } from '@/shared/types';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export const listBuiltInComponentsTool: AgentTool = {
  name: 'list_built_in_components',
  description:
    'Browse the ready-made code components the Insert panel offers (backgrounds, text effects, counters, embeds, 3D, …) — one line each: tag, what it does, whether the project already has it. Prefer one of these over writing an effect from scratch. Optional `query` filters by words.',
  inputSchema: { query: z.string().optional() },
  category: 'read',
  async execute(args) {
    const q = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = listBuiltInCodeComponents();
    const hits = q.length ? all.filter((c) => q.every((w) => `${c.tag} ${c.label} ${c.comment}`.toLowerCase().includes(w))) : all;
    return ok({ count: hits.length, components: hits.map((c) => ({ tag: c.tag, label: c.label, comment: c.comment, installed: c.installed })) });
  },
};

export const addBuiltInComponentTool: AgentTool = {
  name: 'add_built_in_component',
  description:
    'Install one of the built-in code components into the project (if not already there) and place an instance of it inside `parent_id` — the Insert panel drop. Its controls are then settable with set_component_prop (get_component lists them).',
  inputSchema: { tag: z.string().describe('the component tag from list_built_in_components, e.g. "AuroraBackground"'), parent_id: z.string().optional(), props: z.record(z.string(), z.unknown()).optional() },
  category: 'semantic',
  async execute(args, ctx) {
    const tag = String(args.tag);
    if (isBranchedRun(ctx)) return fail('add_built_in_component works on the active branch only — run unbranched.');
    const installed = installBuiltInCodeComponent(projectFS, tag);
    if (installed === null) return fail(`"${tag}" is not a built-in component. list_built_in_components shows them.`);
    if (installed) getDefaultStore().set(projectVersionAtom, (v) => v + 1);
    ctx.ensureCheckpoint();
    const placed = await addComponentInstanceTool.execute({ name: tag, ...(args.parent_id ? { parent_id: args.parent_id } : {}), ...(args.props ? { props: args.props } : {}) }, ctx);
    if (placed.isError) return placed;
    const data = JSON.parse((placed.content[0] as { text: string }).text);
    return ok({ ...data, installed: installed === true, path: `components/${tag}.tsx` });
  },
};

// ─── Sections library ────────────────────────────────────────────────────────
//
// Art-directed section blueprints (headers, heroes) the Insert panel drags in.
// Each is page-dialect JSX validated by the oracle in CI, with its fonts. The
// agent gets the same descriptor tree the drop path builds.

type AddNodeChild = { id: string; type: string; name?: string; styles: Record<string, string>; attrs?: Record<string, string>; textContent?: string; children?: AddNodeChild[] };
const toDef = (d: NewNodeDescriptor): AddNodeChild => ({ id: d.id ?? '', type: d.tag, name: d.name, styles: d.styles, attrs: d.attrs, textContent: d.textContent, children: d.children?.map(toDef) });

export const listSectionsTool: AgentTool = {
  name: 'list_sections',
  description: 'The Sections library — art-directed, ready-made page sections (headers, heroes) with their fonts. Insert one with insert_section; then edit it like any layer.',
  inputSchema: { category: z.string().optional().describe('header | hero | …') },
  category: 'read',
  async execute(args) {
    const list = SECTION_BLUEPRINTS.filter((b) => !args.category || b.category === args.category);
    return ok({ sections: list.map((b) => ({ id: b.id, name: b.name, category: b.category, description: b.description, fonts: b.fonts })) });
  },
};

export const insertSectionTool: AgentTool = {
  name: 'insert_section',
  description:
    'Insert a Sections-library blueprint (list_sections) into the page as a real section — the Insert panel\'s drop: the section\'s elements, styles and Google fonts land as editable layers. ' +
    'parent_id defaults to the page root; index places it among the root\'s sections (0 = first, e.g. a header).',
  inputSchema: { section: z.string().describe('blueprint id from list_sections'), parent_id: z.string().optional(), index: z.number().optional() },
  category: 'semantic',
  async execute(args, ctx) {
    const blueprint = getSectionBlueprint(String(args.section));
    if (!blueprint) return fail(`No section "${args.section}". list_sections names them: ${SECTION_BLUEPRINTS.map((b) => b.id).join(', ')}.`);
    if (!isPageClientFile(resolveToolFile(ctx))) return fail('Sections are inserted on a page — set_page a page first.');
    const nodes = getToolNodes(ctx);
    const parentId = (args.parent_id as string | undefined) ?? 'root';
    const parent = nodes.get(parentId);
    if (!parent) return fail(`No node "${parentId}" in the active file.`);
    const item = blueprintToToolbarItem(blueprint.id);
    if (!item) return fail(`The "${blueprint.id}" blueprint could not be parsed.`);
    const children = item.children ? item.children() : [];
    const placed = seedFlowChild({ ...item.defaultStyles }, parent, nodes, args.index as number | undefined);
    const id = children.length && children[0].id ? `section-${blueprint.id}-${Math.random().toString(36).slice(2, 6)}` : `section-${blueprint.id}`;
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'addNode', parentId, index: args.index as number | undefined, node: { id, type: item.elementType, name: item.name, styles: placed.styles, attrs: item.defaultAttrs, textContent: item.textContent, children: children.map(toDef) } });
    queueOrderWrites(ctx, placed.siblings);
    flushTool(ctx);
    trace.action('agent-tool:insert_section', { id, blueprint: blueprint.id, parentId });
    return ok({ node_id: id, section: blueprint.id, name: blueprint.name, fonts: blueprint.fonts, elements: 1 + countDefs(children.map(toDef)) });
  },
};

function countDefs(defs: AddNodeChild[]): number {
  return defs.reduce((n, d) => n + 1 + countDefs(d.children ?? []), 0);
}

export const BUILT_IN_TOOLS: AgentTool[] = [listBuiltInComponentsTool, addBuiltInComponentTool, listSectionsTool, insertSectionTool];
