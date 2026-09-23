// src/ai/agent/tools/icons.ts
//
// Icons (audit §10 G7, §11): find one in the Iconify libraries the command
// palette searches, place it as an EDITABLE vector (the builder's shape
// grammar — a wrapper svg holding `<path data-id="…-g0">` children, what a
// palette insert or an SVG drop produces), or turn several SVGs into an icon
// set (`icons/<set>.tsx`) the Insert panel lists.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, isBranchedRun } from '@/ai/agent/workspace';
import { decomposeSvgDropToShapes } from '@/canvas/drag/svg-drop-shapes';
import { createVectorSetFromSvgs, looksLikeSvg, svgIntrinsicSize, wrapSvgForIconCard } from '@/code/icons/create-vector-set-from-svgs';
import { addIconToSet, removeIconFromSet } from '@/code/icons/icon-set-ops';
import { parseIconSetConfig } from '@/code/icons/icon-set-config';
import { ICON_CARD_W, ICON_CARD_H } from '@/code/icons/icon-set-template';
import { convertSvgToEditableShapes } from '@/code/svg/svg-import';
import { isIconSetFilePath } from '@/code/project/file-path-kind';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectFS } from '@/code/project/project-fs';
import { getDefaultStore } from 'jotai';
import { generateNodeId } from '@/shared/id-utils';
import { seedFlowChild } from './flow-placement';
import { queueOrderWrites } from './semantic-structure';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** The libraries the command palette searches (useIconSearch.ts). */
export const ICON_LIBRARIES = ['lucide', 'heroicons', 'tabler', 'ph', 'material-symbols', 'fa6-solid', 'bi', 'pixelarticons', 'pepicons-pop', 'game-icons'] as const;

const ICONIFY = 'https://api.iconify.design';

/** `<svg …>inner</svg>` → its viewBox and inner markup. */
function parseSvg(text: string): { viewBox: string; inner: string } | null {
  const m = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  if (!m) return null;
  const vb = text.match(/viewBox="([^"]+)"/)?.[1];
  const w = text.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)/)?.[1];
  const h = text.match(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)/)?.[1];
  return { viewBox: vb ?? (w && h ? `0 0 ${w} ${h}` : '0 0 24 24'), inner: m[1].trim() };
}

// ─── search_icons ────────────────────────────────────────────────────────────

export const searchIconsTool: AgentTool = {
  name: 'search_icons',
  description:
    `Find icons by keyword across the icon libraries the editor's palette searches (${ICON_LIBRARIES.slice(0, 5).join(', ')}, …). ` +
    'Returns icon names like "lucide:menu" for add_icon. Prefer one library per site for a consistent look.',
  inputSchema: {
    query: z.string(),
    library: z.enum(ICON_LIBRARIES).optional().describe('one library; omit to search the main ones'),
    limit: z.number().int().min(1).max(60).optional(),
  },
  category: 'read',
  async execute(args, ctx) {
    const query = String(args.query).trim();
    if (query.length < 2) return fail('Pass at least two characters.');
    const libs = args.library ? [String(args.library)] : ['lucide', 'heroicons', 'tabler', 'ph', 'material-symbols'];
    const limit = (args.limit as number | undefined) ?? 24;
    try {
      const perLib = await Promise.all(libs.map(async (prefix) => {
        const res = await fetch(`${ICONIFY}/search?query=${encodeURIComponent(query)}&prefix=${prefix}&limit=${Math.min(50, limit)}`, { signal: ctx?.signal });
        if (!res.ok) return [] as string[];
        const json = await res.json() as { icons?: string[] };
        return json.icons ?? [];
      }));
      const icons = perLib.flat().slice(0, limit);
      trace.action('agent-tool:search_icons', { query, libs: libs.length, results: icons.length });
      return ok({ query, icons, next: icons.length ? 'add_icon {icon, parent_id}' : 'try another word or library' });
    } catch (err) {
      return fail(`Could not reach the icon search: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ─── add_icon ────────────────────────────────────────────────────────────────

export const addIconTool: AgentTool = {
  name: 'add_icon',
  description:
    'Place an ICON as an editable vector — the palette\'s icon insert: pass icon ("lucide:menu", from search_icons) to fetch it, or svg (raw <svg> markup you have) to use it directly. ' +
    'The icon becomes a shape the Fill / Stroke panels edit (monochrome icons paint with currentColor, so set_styles {color} tints them). size in px (default 24).',
  inputSchema: {
    parent_id: z.string(),
    icon: z.string().optional().describe('"library:name" from search_icons'),
    svg: z.string().optional().describe('raw <svg …>…</svg> markup instead of icon'),
    name: z.string().optional(),
    size: z.number().int().min(4).max(2000).optional(),
    color: z.string().optional().describe('CSS colour for currentColor icons, e.g. "#111827" or var(--token)'),
    index: z.number().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const parentId = String(args.parent_id);
    const nodes = getToolNodes(ctx);
    const parent = nodes.get(parentId);
    if (!parent) return fail(`No node "${parentId}" in the active file.`);
    if (/^[A-Z]/.test(parent.type)) return fail(`"${parentId}" is a component instance — place the icon inside its master or beside it.`);
    let markup = typeof args.svg === 'string' ? args.svg.trim() : '';
    const iconName = typeof args.icon === 'string' ? args.icon.trim() : '';
    if (!markup && !iconName) return fail('Pass icon (from search_icons) or svg markup.');
    if (!markup) {
      if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(iconName)) return fail(`"${iconName}" is not an icon name — expected "library:name" (search_icons).`);
      try {
        const res = await fetch(`${ICONIFY}/${iconName}.svg`, { signal: ctx?.signal });
        if (!res.ok) return fail(`No icon "${iconName}" (${res.status}) — search_icons to find the exact name.`);
        markup = await res.text();
      } catch (err) {
        return fail(`Could not fetch the icon: ${err instanceof Error ? err.message : String(err)}. Pass svg markup instead.`);
      }
    }
    if (!looksLikeSvg(markup)) return fail('That is not SVG markup.');
    // Monochrome icon packs paint black; currentColor lets the colour style
    // tint them (the palette insert does the same). On the WHOLE markup: icon
    // packs declare the paint on the root <svg>, which the shapes inherit.
    markup = markup
      .replace(/<defs>\s*<style>[^<]*<\/style>\s*<\/defs>/gi, '')
      .replace(/fill="(#000|#000000|black)"/gi, 'fill="currentColor"')
      .replace(/stroke="(#000|#000000|black)"/gi, 'stroke="currentColor"');
    const parsed = parseSvg(markup);
    if (!parsed) return fail('Could not read the <svg> element.');
    const inner = parsed.inner;
    const size = (args.size as number | undefined) ?? 24;
    const id = generateNodeId('icon');
    const name = (args.name as string | undefined) ?? (iconName ? iconName.split(':')[1].replace(/-/g, ' ') : 'Icon');
    // The decomposer needs a viewBox on the root; give it the parsed one when the markup only carried width/height.
    const withViewBox = /<svg\b[^>]*viewBox=/i.test(markup) ? markup : markup.replace(/<svg\b/i, `<svg viewBox="${parsed.viewBox}"`);
    const dec = decomposeSvgDropToShapes(withViewBox, id, name, size, size);
    const styles = seedFlowChild({ position: 'relative', width: `${dec?.box.w ?? size}px`, height: `${dec?.box.h ?? size}px`, overflow: 'visible', ...(args.color ? { color: String(args.color) } : {}) }, parent, nodes, args.index as number | undefined);
    type Def = { id: string; type: string; name?: string; styles: Record<string, string>; attrs?: Record<string, string>; children?: Def[] };
    const toDef = (d: { tag: string; id?: string; name?: string; styles: Record<string, string>; attrs?: Record<string, string>; children?: unknown[] }): Def => ({ id: d.id ?? generateNodeId('shape'), type: d.tag, name: d.name, styles: d.styles, attrs: d.attrs, children: (d.children as typeof d[] | undefined)?.map(toDef) });
    ctx.ensureCheckpoint();
    if (dec && dec.children.length > 0) {
      queueToolMutation(ctx, { type: 'addNode', parentId, index: args.index as number | undefined, node: { id, type: 'svg', name, styles: styles.styles, attrs: dec.attrs, children: dec.children.map(toDef) } });
    } else {
      // Gradients / masks / text: keep the drawing as flat markup (renders, not shape-editable) — the same fallback as a drop.
      queueToolMutation(ctx, { type: 'addNode', parentId, index: args.index as number | undefined, node: { id, type: 'svg', name, styles: styles.styles, attrs: { viewBox: parsed.viewBox, xmlns: 'http://www.w3.org/2000/svg' }, textContent: inner } });
    }
    queueOrderWrites(ctx, styles.siblings);
    flushTool(ctx);
    trace.action('agent-tool:add_icon', { id, icon: iconName || 'svg', editable: !!(dec && dec.children.length) });
    return ok({ node_id: id, icon: iconName || null, shapes: dec?.children.length ?? 0, editable: !!(dec && dec.children.length), size: dec?.box ?? { w: size, h: size } });
  },
};

// ─── create_icon_set ─────────────────────────────────────────────────────────

export const createIconSetTool: AgentTool = {
  name: 'create_icon_set',
  description:
    'Make an ICON SET from SVGs — a vector component (icons/<set>.tsx) with one variant per icon, listed in the Insert panel and reusable across pages (Icon Sets). Pass icons: [{name, svg}] (raw markup, or fetch them with the icon names from search_icons by passing icon instead of svg). Returns the set file.',
  inputSchema: {
    name: z.string().describe('set name, e.g. "Social icons"'),
    icons: z.array(z.object({ name: z.string(), svg: z.string().optional(), icon: z.string().optional().describe('"library:name" to fetch') })).min(1),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('create_icon_set works on the active branch only — run unbranched.');
    const items = args.icons as { name: string; svg?: string; icon?: string }[];
    const svgs: { label: string; text: string }[] = [];
    for (const it of items) {
      let text = it.svg?.trim() ?? '';
      if (!text && it.icon) {
        try {
          const res = await fetch(`${ICONIFY}/${it.icon.trim()}.svg`, { signal: ctx?.signal });
          if (!res.ok) return fail(`No icon "${it.icon}" (${res.status}).`);
          text = await res.text();
        } catch (err) {
          return fail(`Could not fetch "${it.icon}": ${err instanceof Error ? err.message : String(err)}.`);
        }
      }
      if (!looksLikeSvg(text)) return fail(`"${it.name}" is not SVG markup.`);
      svgs.push({ label: it.name, text });
    }
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const result = await createVectorSetFromSvgs(String(args.name), svgs);
    if (!result) return fail('Could not build the icon set.');
    trace.action('agent-tool:create_icon_set', { set: result.iconSetName, icons: result.iconCount });
    return ok({ set: result.iconSetName, file: result.iconSetFilePath, icons: result.iconCount, next: `add_component_instance {name: "${result.iconSetName}", props: {initialVariant: "<icon name>"}} places one icon` });
  },
};

// ─── add_icons_to_set / remove_icon_from_set ────────────────────────────────
// Growing the set that is OPEN (the icon-set surface: "add a heart", "a set of
// 6 people icons"). The old icon-set chat rewrote the whole file with
// unchecked model output; this goes through the same path as the canvas's own
// "+ Vector" and the plugin SDK's vectors.addVariant (icon-set-ops.ts
// addIconToSet), each SVG turned into editable shapes like a dropped file.

/** The set a call means: the one named, else the one open. */
function targetSet(arg: unknown): string | null {
  const named = typeof arg === 'string' && arg.trim() ? arg.trim() : '';
  const path = named
    ? (named.startsWith('icons/') ? named : `icons/${named.replace(/\.tsx$/, '')}.tsx`)
    : (getDefaultStore().get(activeFilePathAtom) ?? '');
  return isIconSetFilePath(path) && projectFS.readFile(path) != null ? path : null;
}

async function svgFor(item: { svg?: string; icon?: string }, signal?: AbortSignal): Promise<string | { error: string }> {
  let text = item.svg?.trim() ?? '';
  if (!text && item.icon) {
    try {
      const res = await fetch(`${ICONIFY}/${item.icon.trim()}.svg`, { signal });
      if (!res.ok) return { error: `No icon "${item.icon}" (${res.status}).` };
      text = await res.text();
    } catch (err) {
      return { error: `Could not fetch "${item.icon}": ${err instanceof Error ? err.message : String(err)}.` };
    }
  }
  return looksLikeSvg(text) ? text : { error: 'not SVG markup' };
}

export const addIconsToSetTool: AgentTool = {
  name: 'add_icons_to_set',
  description:
    'Add icons to an ICON SET — the one open on the canvas by default (icons/<set>.tsx). Each icon: {name, icon} with a library name from search_icons ("lucide:heart"), or {name, svg} with SVG markup you write. ' +
    'Keep the set consistent: same library / stroke weight / fill style as the icons it already has. Each lands as its own card with editable shapes.',
  inputSchema: {
    set: z.string().optional().describe('the set file (icons/<Set>.tsx) or its name — default: the set open on the canvas'),
    icons: z.array(z.object({ name: z.string(), icon: z.string().optional(), svg: z.string().optional() })).min(1).max(40),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('add_icons_to_set works on the active branch only — run unbranched.');
    const set = targetSet(args.set);
    if (!set) return fail('No icon set to add to — open one (icons/*.tsx) or pass `set`; create_icon_set makes a new one.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const added: { id: string; name: string; editable: boolean }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const items = args.icons as { name: string; icon?: string; svg?: string }[];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const text = await svgFor(it, ctx?.signal);
      if (typeof text !== 'string') { skipped.push({ name: it.name, reason: text.error }); continue; }
      const { w, h } = svgIntrinsicSize(text);
      const cardW = ICON_CARD_W;
      const cardH = Math.max(96, Math.min(ICON_CARD_H, Math.round((ICON_CARD_W * h) / w) || ICON_CARD_H));
      // Ids inside the icon only need to be unique in the file; the card's
      // own id comes from addIconToSet.
      const shapeIds = `icon-add-${Date.now().toString(36)}-${i}`;
      const converted = convertSvgToEditableShapes(text, { iconId: shapeIds, displayName: it.name, cardW, cardH });
      const svgJSX = converted?.jsx ?? wrapSvgForIconCard(text, shapeIds, it.name, cardW, cardH);
      const result = addIconToSet(set, { displayName: it.name, svgJSX, size: { width: cardW, height: cardH } });
      if (!result) { skipped.push({ name: it.name, reason: 'the set file could not be updated' }); continue; }
      added.push({ id: result.iconId, name: it.name, editable: !!converted });
    }
    trace.action('agent-tool:add_icons_to_set', { set, added: added.length, skipped: skipped.length });
    if (added.length === 0) return fail(`No icon was added: ${skipped.map((s) => `${s.name} — ${s.reason}`).join('; ')}`);
    return ok({ set, added, ...(skipped.length ? { skipped } : {}), icons_in_set: parseIconSetConfig(projectFS.readFile(set) ?? '').length });
  },
};

export const removeIconFromSetTool: AgentTool = {
  name: 'remove_icon_from_set',
  description: 'Remove one icon from an icon set (the one open by default) by its id ("icon-3") or its name. A set keeps at least one icon.',
  inputSchema: {
    set: z.string().optional().describe('the set file or name — default: the set open on the canvas'),
    icon: z.string().describe('the icon id ("icon-3") or name ("Heart")'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('remove_icon_from_set works on the active branch only — run unbranched.');
    const set = targetSet(args.set);
    if (!set) return fail('No icon set open — open one (icons/*.tsx) or pass `set`.');
    const want = String(args.icon).trim();
    const configs = parseIconSetConfig(projectFS.readFile(set) ?? '');
    const hit = configs.find((c) => c.name === want) ?? configs.find((c) => (c.label ?? '').toLowerCase() === want.toLowerCase());
    if (!hit) return fail(`No icon "${want}" in ${set} — it has: ${configs.map((c) => `${c.name} (${c.label})`).join(', ')}.`);
    if (configs.length <= 1) return fail('A set keeps at least one icon — delete the whole set instead.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (!removeIconFromSet(set, hit.name)) return fail(`Could not remove ${hit.name}.`);
    trace.action('agent-tool:remove_icon_from_set', { set, icon: hit.name });
    return ok({ set, removed: hit.name, name: hit.label, icons_in_set: configs.length - 1 });
  },
};

export const ICON_TOOLS: AgentTool[] = [searchIconsTool, addIconTool, createIconSetTool, addIconsToSetTool, removeIconFromSetTool];
