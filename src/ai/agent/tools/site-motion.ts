// src/ai/agent/tools/site-motion.ts
//
// Site- and page-level motion the Animation panel's "+" offers and the agent
// could not reach (audit §8): smooth scrolling (Lenis, per page or site-wide),
// page transitions (View Transitions between routes), a component cursor, and
// Glide (a shared layout spring so siblings animate when one resizes). Plus
// the page templates page transitions depend on. Every write is the panel's
// own op — smooth-scroll-ops, page-effects-ops, cursor-gen, glide-gen,
// template-ops — so the panels read the result back as their own.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode, isBranchedRun, resolveToolFile } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { isComponentFilePath } from '@/code/project/file-path-kind';
import { getLayoutForPage, getLayoutClientPath, isPageClientFile as isPageFilePath, listPageFiles } from '@/code/project/active-file-store';
import { getSmoothScrollForPage, setSmoothScrollForPage, setSmoothScrollForPages, removeSmoothScrollForPage } from '@/code/project/smooth-scroll-ops';
import { createDefaultSmoothScroll } from '@/code/project/smooth-scroll-config';
import { getEffectsForPage, setPageEffectForPage, removePageEffectForPage, routeForPage } from '@/code/project/page-effects-ops';
import type { PageEffect } from '@/code/project/page-effects-config';
import { PRESETS, applyPreset } from '@/code/generation/view-transition-css';
import { addComponentCursorInCode, removeComponentCursorInCode, ensureCursorPortalInLayout } from '@/code/generation/cursor-gen';
import { getComponentCursorForNode } from '@/code/parsing/cursor-parser';
import { ensureLayoutFile } from '@/code/generation/metadata-gen';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { listTemplates, createTemplate, assignTemplate, validateTemplateName } from '@/code/project/template-ops';
import { activatePageForAgent } from './set-page';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
const bump = (): void => { store.set(projectVersionAtom, (v) => v + 1); };

/** The page file a page-level write targets: the argument, else the active page. */
function targetPage(ctx: ToolContext, raw: unknown): { path: string } | { error: string } {
  const path = typeof raw === 'string' && raw.trim() ? raw.trim() : resolveToolFile(ctx);
  if (!projectFS.exists(path)) return { error: `No file "${path}". list_pages names the pages.` };
  if (!isPageFilePath(path)) return { error: `"${path}" is not a page — this setting is per page (or site-wide with all_pages).` };
  return { path };
}

// ─── set_smooth_scroll ───────────────────────────────────────────────────────

export const setSmoothScrollTool: AgentTool = {
  name: 'set_smooth_scroll',
  description:
    'Turn SMOOTH SCROLLING on or off (Lenis — the Animation panel\'s Smooth Scroll): for the active page, a given page, or all_pages. intensity 1–30 (12 = the default 1.2s feel), smooth_touch for touch devices, orientation vertical | horizontal. ' +
    'Pass enabled false to go back to native scrolling on that page.',
  inputSchema: {
    enabled: z.boolean(),
    page: z.string().optional().describe('page file (default: the active page)'),
    all_pages: z.boolean().optional().describe('apply to every page of the site'),
    intensity: z.number().min(1).max(30).optional(),
    smooth_touch: z.boolean().optional(),
    orientation: z.enum(['vertical', 'horizontal']).optional(),
    infinite: z.boolean().optional().describe('loop the page end back to the top'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('set_smooth_scroll writes site config on the active branch only — run unbranched.');
    const pages = args.all_pages ? listPageFiles() : [];
    const one = args.all_pages ? null : targetPage(ctx, args.page);
    if (one && 'error' in one) return fail(one.error);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const base = one ? (getSmoothScrollForPage(one.path).own ?? createDefaultSmoothScroll()) : createDefaultSmoothScroll();
    const cfg = {
      ...base,
      enabled: Boolean(args.enabled),
      ...(typeof args.intensity === 'number' ? { intensity: Math.round(args.intensity) } : {}),
      ...(typeof args.smooth_touch === 'boolean' ? { smoothTouch: args.smooth_touch } : {}),
      ...(args.orientation ? { orientation: args.orientation as 'vertical' | 'horizontal' } : {}),
      ...(typeof args.infinite === 'boolean' ? { infinite: args.infinite } : {}),
    };
    if (one) {
      if (!cfg.enabled && !getSmoothScrollForPage(one.path).own) removeSmoothScrollForPage(one.path);
      else setSmoothScrollForPage(one.path, cfg);
    } else {
      if (pages.length === 0) return fail('No pages found.');
      setSmoothScrollForPages(pages, cfg);
    }
    bump();
    trace.action('agent-tool:set_smooth_scroll', { page: one?.path ?? 'all', enabled: cfg.enabled, intensity: cfg.intensity });
    return ok({ scope: one ? one.path : `${pages.length} pages`, enabled: cfg.enabled, intensity: cfg.intensity, smooth_touch: cfg.smoothTouch, orientation: cfg.orientation });
  },
};

// ─── set_page_transition ─────────────────────────────────────────────────────

const PRESET_NAMES = Object.keys(PRESETS);

export const setPageTransitionTool: AgentTool = {
  name: 'set_page_transition',
  description:
    'Animate the change between PAGES (View Transitions — the Animation panel\'s Page Transition): a preset for how this page leaves and the next enters. ' +
    `Presets: ${PRESET_NAMES.join(' | ')}. target "all" = every navigation from this page (on the home page: the site default), or a route ("/about") for one destination. Pass preset "none" to remove. ` +
    'Page transitions live in the page\'s TEMPLATE layout — pages must be in a template (create_template / assign_template); the tool says so when they are not.',
  inputSchema: {
    preset: z.string().describe(`${PRESET_NAMES.join(' | ')} | none`),
    target: z.string().optional().describe('"all" (default) or a destination route like "/about"'),
    page: z.string().optional().describe('source page file (default: the active page)'),
    duration: z.number().optional().describe('seconds, default 0.4'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('set_page_transition writes the template on the active branch only — run unbranched.');
    const page = targetPage(ctx, args.page);
    if ('error' in page) return fail(page.error);
    const preset = String(args.preset);
    const target = (args.target as string | undefined)?.trim() || 'all';
    if (preset !== 'none' && !PRESETS[preset]) return fail(`Unknown preset "${preset}". Presets: ${PRESET_NAMES.join(', ')}, or none.`);
    const layout = getLayoutForPage(page.path);
    if (!layout || !projectFS.exists(getLayoutClientPath(layout))) {
      return fail(`${page.path} is not in a template, so it has no layout to carry a page transition. Create one (create_template {name}) and assign_template the pages that should transition, then call this again.`);
    }
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (preset === 'none') {
      removePageEffectForPage(page.path, target);
      bump();
      return ok({ page: page.path, target, removed: true });
    }
    const sides = applyPreset(preset);
    if (typeof args.duration === 'number') {
      for (const side of [sides.exit, sides.enter]) if (side) side.transition.duration = Math.max(0.05, args.duration);
    }
    const effect: PageEffect = { preset, target, ...sides };
    if (!setPageEffectForPage(page.path, effect)) return fail(`Could not write the page transition for ${page.path}.`);
    bump();
    trace.action('agent-tool:set_page_transition', { page: page.path, preset, target });
    return ok({ page: page.path, route: routeForPage(page.path), preset, target, effects: getEffectsForPage(page.path).map((e) => `${e.preset} → ${e.target}`) });
  },
};

// ─── set_cursor ──────────────────────────────────────────────────────────────

export const setCursorTool: AgentTool = {
  name: 'set_cursor',
  description:
    'A CUSTOM CURSOR over an element (the Cursor tool\'s Component cursor): a project component (a design component, e.g. a round "View" badge) follows or replaces the pointer while it is over node_id. ' +
    'mode follow (component near the pointer, side/offset) or replace (hides the native cursor, component centred). Pass component "" to remove. For a plain CSS cursor (pointer, grab…) use set_styles {cursor}.',
  inputSchema: {
    node_id: z.string(),
    component: z.string().describe('component name from list_components; "" removes the cursor'),
    mode: z.enum(['follow', 'replace']).optional(),
    side: z.enum(['top', 'bottom', 'left', 'right']).optional(),
    offset_x: z.number().optional(),
    offset_y: z.number().optional(),
    variant: z.string().optional().describe('variant of the cursor component to show'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const active = resolveToolFile(ctx);
    if (isComponentFilePath(active)) return fail('Inside a component master a cursor is a VARIABLE the instance fills — set it on the page instance instead.');
    if (isBranchedRun(ctx)) return fail('set_cursor works on the active branch only — run unbranched.');
    const name = String(args.component).trim();
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (name === '') {
      if (!getComponentCursorForNode(getToolCode(ctx), nodeId)) return fail(`"${nodeId}" has no component cursor.`);
      modifyProjectFile(active, (c) => removeComponentCursorInCode(c, nodeId));
      bump();
      return ok({ node_id: nodeId, cursor: null });
    }
    const info = buildComponentRegistry(projectFS, store.get(projectVersionAtom)).get(name);
    if (!info) return fail(`No component named "${name}". list_components names them.`);
    const mode = (args.mode as 'follow' | 'replace' | undefined) ?? 'follow';
    modifyProjectFile(active, (c) => addComponentCursorInCode(c, nodeId, {
      componentName: name,
      componentImportPath: `@/${info.filePath.replace(/\.tsx$/, '')}`,
      mode,
      side: (args.side as 'top' | 'bottom' | 'left' | 'right' | undefined) ?? 'bottom',
      align: 'center',
      offsetX: (args.offset_x as number | undefined) ?? 0,
      offsetY: (args.offset_y as number | undefined) ?? 0,
      transition: { type: 'spring', stiffness: 300, damping: 30 },
      enterExit: false,
      ...(args.variant ? { variant: String(args.variant) } : {}),
    }));
    // The portal the cursor draws into lives in the root layout (created when
    // the project has none) — exactly what the Cursor tool does.
    if (!projectFS.exists('app/layout.tsx')) projectFS.writeFile('app/layout.tsx', ensureLayoutFile());
    modifyProjectFile('app/layout.tsx', (c) => ensureCursorPortalInLayout(c));
    bump();
    trace.action('agent-tool:set_cursor', { nodeId, component: name, mode });
    return ok({ node_id: nodeId, cursor: name, mode });
  },
};

// ─── set_glide ───────────────────────────────────────────────────────────────

export const setGlideTool: AgentTool = {
  name: 'set_glide',
  description:
    'GLIDE (the Animation panel\'s Flow): the children of a container animate smoothly to their new place when one of them resizes, appears or reorders — an accordion opening, cards re-sorting. ' +
    'node_id is the CONTAINER. Spring by default; pass enabled false to remove.',
  inputSchema: {
    node_id: z.string().describe('the container whose children glide'),
    enabled: z.boolean().optional().describe('default true'),
    duration: z.number().optional().describe('seconds, default 0.5'),
    bounce: z.number().min(0).max(1).optional().describe('0 = no overshoot, default 0.25'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (/^[A-Z]/.test(node.type)) return fail(`"${nodeId}" is a component instance — glide its master's container, or a plain container on the page.`);
    if (node.children.length < 2) return fail(`"${nodeId}" has ${node.children.length} child — glide is about siblings moving together; pick a container with several children.`);
    ctx.ensureCheckpoint();
    if (args.enabled === false) {
      queueToolMutation(ctx, { type: 'removeGlide', nodeId });
    } else {
      queueToolMutation(ctx, { type: 'updateGlide', nodeId, spec: { transition: { type: 'spring', duration: String((args.duration as number | undefined) ?? 0.5), bounce: String((args.bounce as number | undefined) ?? 0.25), delay: '0' } } });
    }
    flushTool(ctx);
    trace.action('agent-tool:set_glide', { nodeId, enabled: args.enabled !== false });
    return ok({ node_id: nodeId, glide: args.enabled !== false });
  },
};

// ─── templates ───────────────────────────────────────────────────────────────

export const listTemplatesTool: AgentTool = {
  name: 'list_templates',
  description: 'The page TEMPLATES (route groups with a shared layout — header, footer, page transitions) and which pages use each.',
  inputSchema: {},
  category: 'read',
  async execute() {
    const pages = listPageFiles();
    return ok({ templates: listTemplates().map((t) => ({ name: t.name, layout: t.clientPath, pages: pages.filter((p) => p.startsWith(`app/(${t.name})/`)) })) });
  },
};

export const createTemplateTool: AgentTool = {
  name: 'create_template',
  description:
    'Create a page TEMPLATE — a shared layout (route group) whose chrome wraps every page assigned to it: site header, footer, page transitions. Returns the layout file to edit (its <Slot> is where pages render). Then assign_template the pages.',
  inputSchema: { name: z.string().describe('template name, e.g. "site", "blog"'), pages: z.array(z.string()).optional().describe('page files to move into it right away') },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('create_template works on the active branch only — run unbranched.');
    const name = String(args.name).trim();
    const problem = validateTemplateName(name);
    if (problem) return fail(problem);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const layout = createTemplate(name);
    if (!layout) return fail(`Could not create the template "${name}".`);
    const moved: Record<string, string> = {};
    const active = resolveToolFile(ctx);
    for (const p of (args.pages as string[] | undefined) ?? []) {
      if (!projectFS.exists(p) || !isPageFilePath(p)) return fail(`No page "${p}".`);
      moved[p] = assignTemplate(p, name);
      if (p === active && moved[p] !== p) activatePageForAgent(moved[p]);
    }
    bump();
    trace.action('agent-tool:create_template', { name, pages: Object.keys(moved).length });
    return ok({ template: name, layout, pages: moved, next: 'edit the layout (set_page then add_node / add_component_instance around its Slot); assign_template for more pages' });
  },
};

export const assignTemplateTool: AgentTool = {
  name: 'assign_template',
  description: 'Put a page in a TEMPLATE (its file moves into the template\'s route group; the URL is unchanged) — or take it out with template "". Returns the page\'s new file path.',
  inputSchema: { page: z.string().describe('page file, e.g. app/about/page.client.tsx'), template: z.string().describe('template name from list_templates; "" removes the page from its template') },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('assign_template works on the active branch only — run unbranched.');
    const page = String(args.page);
    if (!projectFS.exists(page) || !isPageFilePath(page)) return fail(`No page "${page}".`);
    const template = String(args.template).trim();
    if (template && !listTemplates().some((t) => t.name === template)) return fail(`No template "${template}". list_templates names them (create_template makes one).`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wasActive = resolveToolFile(ctx) === page;
    const next = assignTemplate(page, template || null);
    if (next === page && template) return fail(`Could not move ${page} into "${template}" (a page with that route already exists there, or it is already in it).`);
    // The page the user is on moved: follow it, or the next write lands on
    // the old path and recreates the file.
    if (wasActive && next !== page) activatePageForAgent(next);
    bump();
    trace.action('agent-tool:assign_template', { page, template, next });
    return ok({ page: next, template: template || null, moved: next !== page });
  },
};

export const SITE_MOTION_TOOLS: AgentTool[] = [setSmoothScrollTool, setPageTransitionTool, setCursorTool, setGlideTool, listTemplatesTool, createTemplateTool, assignTemplateTool];
