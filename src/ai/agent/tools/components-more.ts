// src/ai/agent/tools/components-more.ts
//
// The half of the variant system the agent could not reach (audit §4 G2, G3,
// G4, G6): variants could be CREATED and STYLED but never SHOWN on an instance,
// never wired to a trigger, never renamed or removed. Every write here is the
// panel's own — the same generators ComponentPropsTool, the Connections modal
// and the variant bar call — so what the agent produces is what a hand edit
// produces.

import { z } from 'zod';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { getToolNodes, resolveToolFile, getToolCode, isBranchedRun, flushTool } from '@/ai/agent/workspace';
import { modifyProjectFile } from '@/code/project/modify-file';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getDefaultStore } from 'jotai';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { parseConnections, addConnection, removeConnection, type ConnectionTrigger } from '@/code/variants/connection-config';
import { renameVariant, removeVariant } from '@/code/variants/variant-ops';
import { setResponsiveOverride } from '@/code/components/instance-prop-overrides';
import { setVariantVisibilityInCode } from '@/code/generation/variant-visibility-gen';
import { detachInstance } from '@/code/components/component-ops';
import { createTextVariableInCode, createVariableInCode } from '@/code/features/variable-ops';
import { setPropTypeInCode, parsePropMeta } from '@/code/components/prop-meta';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { toKebab } from '@/shared/css-utils';
// Pure string helpers (imports only from code/), despite living beside the panel.
import { setConditionalInstanceProp, setInstanceProp, parseInstanceProps } from '@/editor/tools/ComponentPropsTool/instance-props';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** A component's master file by NAME — `list_components` names. */
function masterByName(name: string): { path: string; code: string } | null {
  const registry = buildComponentRegistry(projectFS, store.get(projectVersionAtom));
  const info = registry.get(name);
  if (!info) return null;
  const code = projectFS.readFile(info.filePath);
  return code ? { path: info.filePath, code } : null;
}

/** The master behind a page-side INSTANCE tag (`<PrimaryButton …>`). */
/** The file an instance lives in: the active file, or a master when the
 *  instance is NESTED inside another component ("inside the card, show the
 *  small version of the button"). */
function hostFor(ctx: ToolContext, inside?: unknown): { path: string; code: string; nodes: Map<string, import('@/code/parsing/parser').CanvasNode> } | { error: string } {
  if (typeof inside === 'string' && inside.trim()) {
    const master = masterByName(inside.trim());
    if (!master) return { error: `No component named "${inside}". list_components names them.` };
    return { path: master.path, code: master.code, nodes: parseJSXToNodes(master.code) };
  }
  return { path: resolveToolFile(ctx), code: getToolCode(ctx), nodes: getToolNodes(ctx) };
}

function masterForInstance(ctx: ToolContext, nodeId: string, inside?: unknown): { tag: string; path: string; code: string; host: string } | { error: string } {
  const host = hostFor(ctx, inside);
  if ('error' in host) return host;
  const node = host.nodes.get(nodeId);
  if (!node) return { error: `No node "${nodeId}" in ${host.path}.` };
  const tag = node.type;
  if (!/^[A-Z]/.test(tag) || tag.startsWith('motion.') || tag === 'MotionLink') {
    return { error: `"${nodeId}" is a plain <${tag}>, not a component instance. Variants live on components: extract it first (extract_component), then call this on the instance.` };
  }
  const active = host.path;
  const spec = extractImports(host.code).get(tag);
  const path = spec ? resolveImportPath(spec, active) : null;
  const code = path ? projectFS.readFile(path) : null;
  if (!path || !code) return { error: `Could not find the master of ${tag} (no import in ${active}).` };
  if (isCodeComponentSource(code)) return { error: `${tag} is a CODE component — it has controls, not variants (set_component_prop).` };
  return { tag, path, code, host: active };
}

export const VARIANT_NAME_HELP = 'variant NAME as declared in the master (get_component lists them), e.g. "default", "featured", "default-hover"';

const TRIGGERS = ['click', 'clickStart', 'mouseEnter', 'mouseLeave', 'inView', 'afterDelay'] as const;

// ─── show_variant ─────────────────────────────────────────────────────────────

export const showVariantTool: AgentTool = {
  name: 'show_variant',
  description:
    'Choose which VARIANT a component INSTANCE shows (`initialVariant`) — the same write as the variant picker in the instance\'s properties. ' +
    'node_id is the page-side instance; variant is a name from get_component. Optional viewport (breakpoint width in px, e.g. 375) shows that variant on THAT breakpoint only — the desktop keeps its own ("use the phone variant on mobile"). ' +
    'Pass variant "default" (no viewport) to reset. This is display; to make a trigger switch variants use add_connection.',
  inputSchema: {
    node_id: z.string().describe('data-id of the component instance'),
    variant: z.string().describe(VARIANT_NAME_HELP),
    viewport: z.number().optional().describe('breakpoint width in px to scope the choice to (omit for the base / desktop)'),
    inside: z.string().optional().describe('master name when the instance sits INSIDE another component (get_component lists its elements) — "inside the Card, show the small Button"'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const variant = String(args.variant);
    const master = masterForInstance(ctx, nodeId, args.inside);
    if ('error' in master) return fail(master.error);
    const names = parseVariantConfig(master.code).map((v) => v.name);
    if (!names.includes(variant)) return fail(`"${variant}" is not a variant of ${master.tag}. Its variants: ${names.join(', ')}.`);
    if (isBranchedRun(ctx)) return fail('show_variant writes the active branch only — run unbranched.');
    const active = master.host;
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const viewport = typeof args.viewport === 'number' ? args.viewport : undefined;
    const wrote = modifyProjectFile(active, (code) => {
      if (viewport !== undefined) {
        // Per-breakpoint: an override keyed by width, the base value left alone.
        const rawBase = parseInstanceProps(code, nodeId, master.tag).get('initialVariant');
        const baseVal = rawBase && names.includes(rawBase) ? rawBase : 'default';
        return setResponsiveOverride(code, nodeId, master.tag, viewport, 'initialVariant', variant, baseVal);
      }
      return variant === 'default'
        ? setConditionalInstanceProp(code, nodeId, master.tag, 'initialVariant', 'default', variant)
        : setInstanceProp(code, nodeId, master.tag, 'initialVariant', variant, false);
    });
    if (wrote === null) return fail(`Could not write ${active}.`);
    trace.action('agent-tool:show_variant', { nodeId, variant, viewport: viewport ?? null });
    return ok({ node_id: nodeId, component: master.tag, variant, viewport: viewport ?? null, file: active });
  },
};

// ─── add_connection / remove_connection ──────────────────────────────────────

export const addConnectionTool: AgentTool = {
  name: 'add_connection',
  description:
    'Wire a TRIGGER to a variant switch on a design component — the Connections write: "clicking the burger opens the drawer". ' +
    'component is the name from list_components; from → to are variant names; trigger is click | clickStart | mouseEnter | mouseLeave | inView | afterDelay (with delay in seconds). ' +
    'Optional source_node (a data-id INSIDE the master) makes only that element the trigger — omit it and the whole component root triggers. ' +
    'A hover state usually wants two connections (mouseEnter to it, mouseLeave back), or use create_variant with interaction "hover" which wires both.',
  inputSchema: {
    component: z.string().describe('component name from list_components'),
    from: z.string().describe(`variant the trigger fires IN — ${VARIANT_NAME_HELP}`),
    to: z.string().describe('variant to switch TO'),
    trigger: z.enum(TRIGGERS),
    delay: z.number().optional().describe('seconds, for afterDelay (0-2)'),
    source_node: z.string().optional().describe('data-id inside the master that carries the trigger; omit for the root'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}" — call list_components.`);
    if (isCodeComponentSource(master.code)) return fail(`${args.component} is a code component — it has no variants to connect.`);
    const names = parseVariantConfig(master.code).map((v) => v.name);
    for (const v of [String(args.from), String(args.to)]) {
      if (!names.includes(v)) return fail(`"${v}" is not a variant of ${args.component}. Its variants: ${names.join(', ')}.`);
    }
    if (args.source_node && !new RegExp(`data-id="${String(args.source_node)}"`).test(master.code)) {
      return fail(`No element "${args.source_node}" inside ${master.path}. read_source it to find the trigger element's data-id.`);
    }
    if (isBranchedRun(ctx)) return fail('add_connection writes the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const connections = addConnection(master.path, String(args.from), String(args.to), args.trigger as ConnectionTrigger, args.delay as number | undefined, args.source_node as string | undefined);
    trace.action('agent-tool:add_connection', { component: args.component, from: args.from, to: args.to, trigger: args.trigger });
    return ok({ component: args.component, master_path: master.path, connections });
  },
};

export const removeConnectionTool: AgentTool = {
  name: 'remove_connection',
  description: 'Remove a connection (from → to, optionally narrowed by trigger / source_node) from a design component. get_component lists the current connections.',
  inputSchema: {
    component: z.string(),
    from: z.string(),
    to: z.string(),
    trigger: z.enum(TRIGGERS).optional(),
    source_node: z.string().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}".`);
    if (isBranchedRun(ctx)) return fail('remove_connection writes the active branch only — run unbranched.');
    const before = parseConnections(master.code).length;
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const connections = removeConnection(master.path, String(args.from), String(args.to), {
      ...(args.trigger ? { trigger: args.trigger as ConnectionTrigger } : {}),
      ...(args.source_node !== undefined ? { sourceNode: String(args.source_node) } : {}),
    });
    if (connections.length === before) return fail(`No connection ${args.from} → ${args.to}${args.trigger ? ` on ${args.trigger}` : ''} found on ${args.component}. get_component lists them.`);
    return ok({ component: args.component, removed: before - connections.length, connections });
  },
};

// ─── rename_variant / remove_variant ─────────────────────────────────────────

export const renameVariantTool: AgentTool = {
  name: 'rename_variant',
  description: 'Change a variant\'s LABEL (what the panel shows). Its name — the key every binding uses — never changes.',
  inputSchema: { component: z.string(), variant: z.string().describe(VARIANT_NAME_HELP), label: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}".`);
    if (isBranchedRun(ctx)) return fail('rename_variant writes the active branch only — run unbranched.');
    if (!parseVariantConfig(master.code).some((v) => v.name === args.variant)) return fail(`"${args.variant}" is not a variant of ${args.component}.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const out = renameVariant(master.path, String(args.variant), String(args.label));
    if (!out) return fail(`Could not rename "${args.variant}".`);
    return ok({ component: args.component, variant: args.variant, label: args.label });
  },
};

export const removeVariantTool: AgentTool = {
  name: 'remove_variant',
  description:
    'Delete a variant from a design component — its styles, connections and any instance showing it fall back to the primary. Cannot remove the primary. ONLY when the user asked for it.',
  inputSchema: { component: z.string(), variant: z.string().describe(VARIANT_NAME_HELP) },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}".`);
    if (isBranchedRun(ctx)) return fail('remove_variant writes the active branch only — run unbranched.');
    const cfg = parseVariantConfig(master.code).find((v) => v.name === args.variant);
    if (!cfg) return fail(`"${args.variant}" is not a variant of ${args.component}.`);
    if (cfg.isPrimary) return fail(`"${args.variant}" is the primary variant — it cannot be removed.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const out = removeVariant(master.path, String(args.variant));
    if (!out) return fail(`Could not remove "${args.variant}".`);
    return ok({ component: args.component, removed: args.variant, variants: out.map((v) => v.name) });
  },
};

// ─── set_variant_visibility ─────────────────────────────────────────────────

export const setVariantVisibilityTool: AgentTool = {
  name: 'set_variant_visibility',
  description:
    'Show or hide an element INSIDE a component master on specific variants — "the close button only shows in the open state". ' +
    'The Layers eye\'s write: the element is wrapped in <AnimatePresence> and rendered only on the variants where it is visible (no display:none). ' +
    'component = master name, node_id = the element inside the master (get_component lists them), hidden_on = variant names it is hidden on ([] shows it everywhere).',
  inputSchema: {
    component: z.string(),
    node_id: z.string().describe('data-id of an element inside the master'),
    hidden_on: z.array(z.string()).describe('variant names the element is hidden on; [] = visible on every variant'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}". list_components names them.`);
    if (isCodeComponentSource(master.code)) return fail(`${args.component} is a CODE component — it has no variants.`);
    const variants = parseVariantConfig(master.code).map((v) => v.name);
    if (variants.length === 0) return fail(`${args.component} has no variants yet — create_variant first.`);
    const hiddenOn = (args.hidden_on as string[]) ?? [];
    for (const v of hiddenOn) if (!variants.includes(v)) return fail(`"${v}" is not a variant of ${args.component}. Variants: ${variants.join(', ')}.`);
    const nodeId = String(args.node_id);
    const inner = parseJSXToNodes(master.code).get(nodeId);
    if (!inner) return fail(`No element "${nodeId}" inside ${args.component}.`);
    if (!inner.parentId) return fail(`"${nodeId}" is the master's root — hide an element inside it, or hide the instance on the page.`);
    if (isBranchedRun(ctx)) return fail('set_variant_visibility writes the master on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const wrote = modifyProjectFile(master.path, (code) => setVariantVisibilityInCode(code, nodeId, hiddenOn, variants));
    if (!wrote) return fail(`Could not update the visibility of "${nodeId}" (the master rejected the write).`);
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:set_variant_visibility', { component: args.component, nodeId, hiddenOn });
    return ok({ component: args.component, node_id: nodeId, hidden_on: hiddenOn, visible_on: variants.filter((v) => !hiddenOn.includes(v)) });
  },
};

// ─── detach_instance ─────────────────────────────────────────────────────────

export const detachInstanceTool: AgentTool = {
  name: 'detach_instance',
  description:
    'Detach a component INSTANCE into plain elements on the page (the context menu\'s "Detach instance"): the variant it shows is baked in, props become literal values, the elements get fresh data-ids and the master is untouched. ' +
    'Use it when ONE occurrence must diverge from the component for good; to change one field prefer set_component_prop, to add a state prefer create_variant. Returns the new root id.',
  inputSchema: { node_id: z.string().describe('data-id of the instance on the page') },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const master = masterForInstance(ctx, nodeId);
    if ('error' in master) return fail(master.error);
    if (isBranchedRun(ctx)) return fail('detach_instance works on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const active = resolveToolFile(ctx);
    const variant = node.attrs?.initialVariant || 'default';
    const out: { rootId?: string } = {};
    const next = detachInstance(active, nodeId, master.path, variant, out);
    if (!next) return fail(`Could not detach "${nodeId}" (${master.tag}).`);
    modifyProjectFile(active, () => next);
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:detach_instance', { nodeId, component: master.tag, variant, rootId: out.rootId });
    return ok({ detached: nodeId, component: master.tag, baked_variant: variant, root_id: out.rootId ?? null, note: 'the instance id is gone — address the elements by the new ids (get_node_tree)' });
  },
};

// ─── add_component_prop ──────────────────────────────────────────────────────

const PROP_VAR_TYPES: Record<string, string> = { text: 'plainText', number: 'number', boolean: 'toggle', color: 'color' };

export const addComponentPropTool: AgentTool = {
  name: 'add_component_prop',
  description:
    'Declare a new PROP (variable) on an EXISTING component master and bind it — the Variables panel\'s "Set variable": ' +
    'bind "text" turns an element\'s text into {prop} (a text prop, translatable and set per instance); bind a CSS property name (backgroundColor, color, borderRadius, gap…) turns that style value into the prop. ' +
    'The current value becomes the default. Then set it per instance with set_component_prop. Pass component (master name), node_id (element inside the master), name (camelCase), bind.',
  inputSchema: {
    component: z.string(),
    node_id: z.string().describe('data-id of the element inside the master whose text / style value becomes the prop'),
    name: z.string().describe('camelCase prop name, e.g. "title", "accentColor"'),
    bind: z.string().describe('"text" for the element\'s text, or a camelCase CSS property (backgroundColor, color, gap, borderRadius, fontSize, opacity, …)'),
    default: z.string().optional().describe('default value; omitted = the element\'s current value'),
    type: z.enum(['text', 'number', 'boolean', 'color']).optional().describe('the variable type for a style binding (defaults: color for colour properties, number for numeric ones, else text)'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const master = masterByName(String(args.component));
    if (!master) return fail(`No component named "${args.component}". list_components names them.`);
    if (isCodeComponentSource(master.code)) return fail(`${args.component} is a CODE component — its props are its @controls (edit the file with apply_file_edit).`);
    const name = String(args.name).trim();
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return fail(`"${name}" is not a camelCase identifier (e.g. "title", "accentColor").`);
    if (name === 'initialVariant' || name === 'style' || name === 'children') return fail(`"${name}" is reserved on every master.`);
    if (parsePropMeta(master.code)[name] || new RegExp(`\\b${name}\\s*=`).test(master.code.slice(0, master.code.indexOf('return')))) return fail(`${args.component} already declares "${name}" — pick another name or set_component_prop it.`);
    const nodeId = String(args.node_id);
    const inner = parseJSXToNodes(master.code).get(nodeId);
    if (!inner) return fail(`No element "${nodeId}" inside ${args.component}.`);
    const bind = String(args.bind);
    if (isBranchedRun(ctx)) return fail('add_component_prop writes the master on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    let varType: string;
    let defaultValue: string;
    if (bind === 'text') {
      if (!inner.textContent?.trim()) return fail(`"${nodeId}" has no text to bind — bind a style property, or pick a text element.`);
      varType = 'plainText';
      defaultValue = (args.default as string | undefined) ?? inner.textContent;
      const wrote = modifyProjectFile(master.path, (code) => setPropTypeInCode(createTextVariableInCode(code, nodeId, name, defaultValue), name, varType));
      if (!wrote) return fail(`Could not bind the text of "${nodeId}" to "${name}".`);
    } else {
      if (!/^[a-z][A-Za-z]*$/.test(bind)) return fail(`bind must be "text" or a camelCase CSS property, not "${bind}".`);
      const current = inner.styles?.[bind] ?? '';
      defaultValue = (args.default as string | undefined) ?? current;
      if (!defaultValue) return fail(`"${nodeId}" has no ${bind} — pass a default, or set_variant it first.`);
      const explicit = args.type as keyof typeof PROP_VAR_TYPES | undefined;
      const inferred = /color|background$/i.test(bind) ? 'color' : /^(opacity|gap|zIndex|flexGrow|order|lineHeight)$/.test(bind) || /^-?\d+(\.\d+)?$/.test(defaultValue) ? 'number' : 'text';
      varType = PROP_VAR_TYPES[explicit ?? inferred];
      const literalKind = varType === 'number' && /^-?\d+(\.\d+)?$/.test(defaultValue) ? 'number' : 'string';
      const wrote = modifyProjectFile(master.path, (code) => createVariableInCode(code, nodeId, bind, name, defaultValue, undefined, literalKind));
      if (!wrote) return fail(`Could not bind ${bind} of "${nodeId}" to "${name}".`);
      modifyProjectFile(master.path, (code) => setPropTypeInCode(code, name, varType));
    }
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:add_component_prop', { component: args.component, nodeId, name, bind, varType });
    return ok({ component: args.component, prop: name, type: varType, bound_to: bind === 'text' ? `${nodeId} text` : `${nodeId} ${toKebab(bind)}`, default: defaultValue, next: `set_component_prop on each instance to vary it` });
  },
};

export const COMPONENT_MORE_TOOLS: AgentTool[] = [showVariantTool, addConnectionTool, removeConnectionTool, renameVariantTool, removeVariantTool, setVariantVisibilityTool, detachInstanceTool, addComponentPropTool];

/** Variants + connections of a master, for get_component. */
export function describeVariantAxis(code: string): string {
  if (isCodeComponentSource(code)) return '';
  const variants = parseVariantConfig(code);
  if (variants.length === 0) return '';
  const lines = ['variants:'];
  for (const v of variants) {
    const bits = [v.isPrimary ? 'primary' : '', v.interactionType ? `${v.interactionType} state of ${v.parentVariant ?? '?'}` : ''].filter(Boolean);
    lines.push(`  ${v.name}${v.label && v.label !== v.name ? `  "${v.label}"` : ''}${bits.length ? `  (${bits.join(', ')})` : ''}`);
  }
  const connections = parseConnections(code);
  lines.push(connections.length === 0 ? 'connections: none' : 'connections:');
  for (const c of connections) {
    lines.push(`  ${c.from} → ${c.to}  on ${c.trigger}${c.delay ? ` after ${c.delay}s` : ''}${c.sourceNode ? `  from "${c.sourceNode}"` : ''}`);
  }
  return lines.join('\n');
}
