// src/ai/agent/tools/viewports.ts
//
// Breakpoints (audit §7): list them, add one, change a width, remove one —
// the "+" on a viewport tile, the Size panel's breakpoint input and Delete on
// a replica root. Each write is the same sequence those surfaces run, in the
// same ORDER (the band rewrite runs BEFORE the @canvas config write — see
// SizeTool's comment: the rewrite normalises stray bands onto the FILE's keys).

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { flushTool, isBranchedRun, resolveToolFile, getToolCode } from '@/ai/agent/workspace';
import { projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { parseCanvasConfig, updateCanvasConfigInCode } from '@/code/project/canvas-config';
import { viewportsConfigAtom, viewportWidthsAtom, syncViewportWidths, getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { addResponsiveBreakpoint, copyContainerRulesToNewWidth } from '@/code/generation/generator-styles';
import { applyViewportWidthChange } from '@/code/generation/viewport-width-rewrite';
import { removeReplicaViewport } from '@/canvas/commands';
import { VIEWPORT_GAP } from '@/shared/constants';
import type { ViewportConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function viewports(ctx: ToolContext): ViewportConfig[] {
  const cfg = parseCanvasConfig(getToolCode(ctx));
  return cfg?.viewports?.length ? cfg.viewports : (store.get(viewportsConfigAtom) as ViewportConfig[]);
}

function describe(list: ViewportConfig[]): { id: string; label: string; width: number; primary: boolean }[] {
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((v) => ({ id: v.id, label: v.label, width: v.width, primary: !!v.isPrimary }));
}

/** Resolve a viewport by id, label or width. */
function findViewport(list: ViewportConfig[], raw: unknown): ViewportConfig | undefined {
  if (typeof raw === 'number') return list.find((v) => v.width === raw);
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^\d+$/.test(s)) return list.find((v) => v.width === Number(s));
  return list.find((v) => v.id.toLowerCase() === s || v.label.toLowerCase() === s);
}

function syncWidths(list: ViewportConfig[]): void {
  const widths = Object.fromEntries(list.map((v) => [v.id, v.width]));
  syncViewportWidths(widths);
  store.set(viewportWidthsAtom, widths);
}

// ─── list_viewports ──────────────────────────────────────────────────────────

export const listViewportsTool: AgentTool = {
  name: 'list_viewports',
  description: 'The breakpoints (viewports) of the active file: id, label, width, which is primary. Responsive overrides key on these widths.',
  inputSchema: {},
  category: 'read',
  async execute(_args, ctx) {
    return ok({ file: resolveToolFile(ctx), viewports: describe(viewports(ctx)) });
  },
};

// ─── add_viewport ────────────────────────────────────────────────────────────

export const addViewportTool: AgentTool = {
  name: 'add_viewport',
  description:
    'Add a BREAKPOINT to the active file — the "+" on a viewport tile: a new replica at the given width, seeded with the overrides of the next-larger breakpoint so it opens looking like what already rendered at that width. ' +
    'Then style it with viewport-scoped writes (set_styles {viewport}). Widths must be unique.',
  inputSchema: {
    label: z.string().describe('e.g. "Laptop", "Small tablet"'),
    width: z.number().int().min(200).max(4000),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('add_viewport works on the active branch only — run unbranched.');
    const list = viewports(ctx);
    const width = Number(args.width);
    const label = String(args.label).trim();
    if (!label) return fail('Pass a label.');
    if (list.some((v) => v.width === width)) return fail(`A breakpoint of ${width}px already exists (${findViewport(list, width)!.id}).`);
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'viewport';
    let id = base;
    for (let n = 2; list.some((v) => v.id === id); n++) id = `${base}-${n}`;
    const active = resolveToolFile(ctx);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const cfg = parseCanvasConfig(getToolCode(ctx));
    const positions = cfg?.positions ?? Object.fromEntries(list.map((v) => [v.id, { x: v.x ?? 0, y: v.y ?? 0 }]));
    const rightmost = list.reduce((max, v) => Math.max(max, (positions[v.id]?.x ?? v.x ?? 0) + v.width), 0);
    const source = list.find((v) => v.isPrimary) ?? list[0];
    const next: ViewportConfig = { id, label, width, isPrimary: false, order: list.length, x: rightmost + VIEWPORT_GAP, y: 0, ...(typeof source?.height === 'number' && source.height > 0 ? { height: source.height } : {}) };
    const all = [...list, next];
    syncWidths(all);
    const widths = getSortedBreakpointWidths();
    const larger = [...widths].sort((a, b) => a - b).find((w) => w > width);
    const seed = larger ?? source.width;
    modifyProjectFile(active, (code) => {
      let out = code;
      if (seed > 0 && seed !== width) out = copyContainerRulesToNewWidth(out, seed, width);
      out = addResponsiveBreakpoint(out, width, source.width, widths);
      const c = parseCanvasConfig(out) ?? { viewports: list, positions };
      return updateCanvasConfigInCode(out, { ...c, viewports: [...c.viewports.filter((v) => v.id !== id), next], positions: { ...c.positions, [id]: { x: next.x ?? 0, y: 0 } } });
    });
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:add_viewport', { id, width, seed });
    return ok({ added: { id, label, width }, seeded_from: seed, viewports: describe(all) });
  },
};

// ─── set_viewport_width ──────────────────────────────────────────────────────

export const setViewportWidthTool: AgentTool = {
  name: 'set_viewport_width',
  description: 'Change a breakpoint\'s WIDTH (the Size panel\'s breakpoint input): every override keyed on the old width — style bands, animation gates, responsive instance props, per-breakpoint text — moves to the new one.',
  inputSchema: { viewport: z.string().describe('id, label or current width'), width: z.number().int().min(200).max(4000) },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('set_viewport_width works on the active branch only — run unbranched.');
    const list = viewports(ctx);
    const vp = findViewport(list, args.viewport);
    if (!vp) return fail(`No breakpoint "${args.viewport}". Breakpoints: ${describe(list).map((v) => `${v.id} ${v.width}px`).join(', ')}.`);
    const width = Number(args.width);
    if (vp.width === width) return ok({ viewport: vp.id, width, changed: false });
    if (list.some((v) => v.id !== vp.id && v.width === width)) return fail(`${width}px is already ${findViewport(list, width)!.id}'s width.`);
    const active = resolveToolFile(ctx);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const all = list.map((v) => (v.id === vp.id ? { ...v, width } : v));
    // Same order as the Size panel: widths first (the rewrite reads them),
    // then the source rewrite, then the @canvas config.
    syncWidths(all);
    applyViewportWidthChange(active, vp.id, vp.width, width);
    modifyProjectFile(active, (code) => {
      const c = parseCanvasConfig(code);
      return c ? updateCanvasConfigInCode(code, { ...c, viewports: c.viewports.map((v) => (v.id === vp.id ? { ...v, width } : v)) }) : code;
    });
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:set_viewport_width', { id: vp.id, from: vp.width, to: width });
    return ok({ viewport: vp.id, from: vp.width, width, changed: true });
  },
};

// ─── remove_viewport ─────────────────────────────────────────────────────────

export const removeViewportTool: AgentTool = {
  name: 'remove_viewport',
  description: 'Remove a breakpoint from the active file with every override authored for it. The primary breakpoint cannot be removed.',
  inputSchema: { viewport: z.string().describe('id, label or width') },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('remove_viewport works on the active branch only — run unbranched.');
    const list = viewports(ctx);
    const vp = findViewport(list, args.viewport);
    if (!vp) return fail(`No breakpoint "${args.viewport}".`);
    if (vp.isPrimary) return fail(`${vp.id} is the primary breakpoint — it cannot be removed.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    removeReplicaViewport(resolveToolFile(ctx), vp.id);
    syncWidths(list.filter((v) => v.id !== vp.id));
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:remove_viewport', { id: vp.id, width: vp.width });
    return ok({ removed: vp.id, viewports: describe(list.filter((v) => v.id !== vp.id)) });
  },
};

export const VIEWPORT_TOOLS: AgentTool[] = [listViewportsTool, addViewportTool, setViewportWidthTool, removeViewportTool];
