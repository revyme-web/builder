// src/ai/agent/tools/forms-text.ts
//
// Text on a breakpoint, pseudo-state styling, attribute translation, native
// form fields, form-state placement, background video and the publish check —
// the audit's remaining "no tool" rows in §6 (typography), §9 (i18n / forms)
// and §11 (assets / publish). Every write is a panel's own generator: the
// Content control's per-viewport text, the Styles panel's :hover / :focus
// rules, the Input tool's localized attrs, the Form State tool, the Fill
// panel's video, the oracle the publish path runs.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode, isBranchedRun, resolveToolFile } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import type { ViewportConfig } from '@/shared/types';
import { getI18nConfig } from '@/code/project/locale-ops';
import { commitTranslationAttr } from '@/code/project/translation-ops';
import { enclosingFormIdInCode, formStateVar } from '@/code/generation/form-state-gen';
// Pure config helpers (no React), despite living beside the panel.
import { readFormConfig, serializeFormConfig, newDestId, type FormDestination } from '@/editor/tools/FormTool/form-config';
import { checkFile } from '@/code/oracle/check-file';
import type { FileKind } from '@/code/oracle/checks/shared';
import { oracleFileKind, isBuilderMaterializedFile } from '@/code/oracle/file-kind';
import { generateNodeId } from '@/shared/id-utils';
import { calculateFitViewBox } from '@/code/generation/fit-text-gen';
import { isFitSize } from '@/shared/constants';
import { findNodeComputedStyle, getInteractingViewport } from '@/canvas/node-ops';
import { seedFlowChild } from './flow-placement';
import { queueOrderWrites } from './semantic-structure';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'button', 'label', 'li', 'blockquote', 'figcaption', 'strong', 'em', 'small', 'div']);

// ─── set_text_on_breakpoint ──────────────────────────────────────────────────

export const setTextOnBreakpointTool: AgentTool = {
  name: 'set_text_on_breakpoint',
  description:
    'Different TEXT on one breakpoint — "on mobile the headline says just Plan & ship". The Content control\'s per-viewport text: the desktop copy stays the base, the breakpoint gets an override the text tool shows and edits. ' +
    'viewport is the breakpoint width in px (375 for mobile); pass text "" to remove the override.',
  inputSchema: {
    node_id: z.string(),
    viewport: z.number().describe('breakpoint width in px, e.g. 375'),
    text: z.string().describe('the text on that breakpoint; "" removes the override'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (!TEXT_TAGS.has(node.type.replace(/^motion\./, '')) || !node.textContent) return fail(`"${nodeId}" is not a text element.`);
    const viewports = store.get(viewportsConfigAtom) as ViewportConfig[];
    const primary = viewports.find((v) => v.isPrimary) ?? viewports[0];
    const vp = viewports.find((v) => v.width === Number(args.viewport));
    if (!vp) return fail(`No breakpoint of ${args.viewport}px. Breakpoints: ${viewports.map((v) => `${v.id} ${v.width}px`).join(', ')}.`);
    if (vp.id === primary.id) return fail(`${vp.width}px is the primary breakpoint — its text is the base: set_text.`);
    ctx.ensureCheckpoint();
    const text = String(args.text);
    queueToolMutation(ctx, text === ''
      ? { type: 'removeTextOverride', nodeId, vpWidth: vp.width, primaryWidth: primary.width }
      : { type: 'updateTextOverride', nodeId, vpWidth: vp.width, primaryWidth: primary.width, text });
    flushTool(ctx);
    trace.action('agent-tool:set_text_on_breakpoint', { nodeId, viewport: vp.width, removed: text === '' });
    return ok({ node_id: nodeId, viewport: vp.id, width: vp.width, text: text || null });
  },
};

// ─── set_text_fit ────────────────────────────────────────────────────────────

/** The FIT wrapper of a node (the node itself, or the svg around it), and the inner text. */
function fitPair(nodes: Map<string, import('@/code/parsing/parser').CanvasNode>, id: string): { wrapper: string; text: string } | null {
  const node = nodes.get(id);
  if (!node) return null;
  const isWrapper = (n: typeof node | undefined) => !!n && n.type === 'svg' && n.id.endsWith('-svg');
  let wrapper = isWrapper(node) ? node : undefined;
  if (!wrapper && node.parentId) {
    const p = nodes.get(node.parentId);
    if (isWrapper(p)) wrapper = p;
    else if (p?.type === 'foreignObject' && p.parentId && isWrapper(nodes.get(p.parentId))) wrapper = nodes.get(p.parentId);
  }
  if (!wrapper) return null;
  for (const childId of wrapper.children) {
    const child = nodes.get(childId);
    if (child?.type === 'foreignObject') { const inner = child.children[0]; if (inner) return { wrapper: wrapper.id, text: inner }; }
    else if (child) return { wrapper: wrapper.id, text: child.id };
  }
  return null;
}

export const setTextFitTool: AgentTool = {
  name: 'set_text_fit',
  description:
    'FIT text — the Text panel\'s Fit size mode: the text scales to fill its box\'s width (a display headline that always spans the column, on every breakpoint). ' +
    'fit true measures the text and wraps it in the Fit svg the panel edits; a hug width is baked to px first (a Fit needs a fixed or % width). fit false unwraps and keeps the visual size as px. size_pct (Fit %, default 100) scales the text inside the box.',
  inputSchema: {
    node_id: z.string().describe('the text element (or its Fit wrapper)'),
    fit: z.boolean(),
    size_pct: z.number().min(1).max(100).optional().describe('the text\'s scale within the box, 100 = full fit'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const id = String(args.node_id);
    const nodes = getToolNodes(ctx);
    const node = nodes.get(id);
    if (!node) return fail(`No node "${id}" in the active file.`);
    const pair = fitPair(nodes, id);
    const { vpId } = getInteractingViewport();
    if (args.fit) {
      if (pair) {
        if (typeof args.size_pct !== 'number') return ok({ node_id: id, fit: true, note: 'already a Fit text' });
        ctx.ensureCheckpoint();
        queueToolMutation(ctx, { type: 'updateStyles', nodeId: pair.text, styles: { transform: args.size_pct === 100 ? '' : `scale(${(args.size_pct / 100).toFixed(3)})` } });
        flushTool(ctx);
        return ok({ node_id: id, fit: true, size_pct: args.size_pct });
      }
      if (!TEXT_TAGS.has(node.type.replace(/^motion\./, '')) || !node.textContent?.trim()) return fail(`"${id}" is not a text element.`);
      if (/^[A-Z]/.test(node.type)) return fail(`"${id}" is a component instance — fit a text element.`);
      // The panel's DOM measurement; outside a real browser (no layout engine)
      // it returns a sliver, so fall back to a font-metric estimate that the
      // next real edit re-fits (fit-measure re-runs on every metric change).
      let viewBox = calculateFitViewBox(node.textContent, node.styles);
      if (!(viewBox.width > 20) || viewBox.fontSize > 1000) {
        const fontSize = parseFloat(node.styles.fontSize ?? '') || 48;
        const lines = node.textContent.split(/\n/).map((l) => l.trim()).filter(Boolean);
        const longest = Math.max(1, ...lines.map((l) => l.length));
        const lineHeight = parseFloat(node.styles.lineHeight ?? '') || 1.1;
        viewBox = { width: Math.ceil(longest * fontSize * 0.55) + 10, height: Math.ceil(fontSize * lineHeight * Math.max(1, lines.length)), fontSize: Math.round(fontSize), marginTop: 0 };
      }
      // A hug width cannot host a Fit (the box the text scales into must be
      // fixed or relative): bake the painted px width, like the panel.
      let bakedWidth: string | undefined;
      if (isFitSize(node.styles.width)) {
        const px = parseFloat(findNodeComputedStyle(id, vpId, 'width')) || 0;
        bakedWidth = px > 0 ? `${Math.round(px)}px` : '100%';
      }
      ctx.ensureCheckpoint();
      flushTool(ctx);
      queueToolMutation(ctx, { type: 'wrapFitText', nodeId: id, viewBox, width: bakedWidth });
      if (typeof args.size_pct === 'number' && args.size_pct !== 100) queueToolMutation(ctx, { type: 'updateStyles', nodeId: id, styles: { transform: `scale(${(args.size_pct / 100).toFixed(3)})` } });
      flushTool(ctx);
      trace.action('agent-tool:set_text_fit', { id, viewBox, bakedWidth });
      return ok({ node_id: id, fit: true, wrapper: `${id}-svg`, view_box: viewBox, width: bakedWidth ?? node.styles.width ?? null, note: 'the wrapper is the layer now (its width is the box); the text keeps its id inside' });
    }
    if (!pair) return ok({ node_id: id, fit: false, note: 'not a Fit text' });
    // Unfit: the fit fontSize is in viewBox units — convert to the visual px so
    // the text keeps its on-screen size (the panel's own math).
    const textNode = nodes.get(pair.text);
    const unitPx = parseFloat(textNode?.styles?.fontSize ?? '') || 16;
    const vbW = parseFloat(String(nodes.get(pair.wrapper)?.attrs?.viewBox ?? '').split(/\s+/)[2] ?? '') || 0;
    const wrapperW = parseFloat(findNodeComputedStyle(pair.wrapper, vpId, 'width')) || parseFloat(nodes.get(pair.wrapper)?.styles?.width ?? '') || 0;
    const scale = parseFloat((textNode?.styles?.transform ?? '').match(/scale\(([\d.]+)\)/)?.[1] ?? '1') || 1;
    const visualPx = vbW > 0 && wrapperW > 0 ? unitPx * (wrapperW / vbW) * scale : unitPx;
    ctx.ensureCheckpoint();
    flushTool(ctx);
    queueToolMutation(ctx, { type: 'unwrapFitText', nodeId: pair.text });
    queueToolMutation(ctx, { type: 'updateStyles', nodeId: pair.text, styles: { fontSize: `${Math.round(visualPx)}px`, transform: '' } });
    flushTool(ctx);
    trace.action('agent-tool:set_text_fit', { id, fit: false, visualPx });
    return ok({ node_id: pair.text, fit: false, font_size: `${Math.round(visualPx)}px` });
  },
};

// ─── set_pseudo_style ────────────────────────────────────────────────────────

const PSEUDOS = ['hover', 'focus', 'checked', 'placeholder', 'before', 'after'] as const;

export const setPseudoStyleTool: AgentTool = {
  name: 'set_pseudo_style',
  description:
    'Style a pseudo-state or pseudo-element — :hover, :focus, :checked, ::placeholder, ::before, ::after — as CSS the Styles panel reads back ("inputs get a blue border when focused", "placeholder text grey"). ' +
    'Written as a [data-id] rule in the page\'s style block. Pass "" for a property to remove it; all "" removes the rule. For a hover on a component use variants (create_variant hover) — for a plain element :hover here is the same write as the Styles panel\'s Hover row.',
  inputSchema: {
    node_id: z.string(),
    pseudo: z.enum(PSEUDOS),
    styles: z.record(z.string(), z.string()).describe('camelCase CSS properties, e.g. {"borderColor": "#2563eb", "outline": "none"}'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (/^[A-Z]/.test(node.type)) return fail(`"${nodeId}" is a component instance — style its master (set_variant / create_variant hover), not a pseudo rule on the wrapper.`);
    const styles = args.styles as Record<string, string>;
    if (!styles || Object.keys(styles).length === 0) return fail('Pass at least one style.');
    const pseudo = args.pseudo as (typeof PSEUDOS)[number];
    if (pseudo === 'placeholder' && !['input', 'textarea'].includes(node.type.replace(/^motion\./, ''))) return fail(`::placeholder only applies to an <input> or <textarea>; "${nodeId}" is a <${node.type}>.`);
    if (pseudo === 'checked' && node.type.replace(/^motion\./, '') !== 'input') return fail(`:checked only applies to a checkbox / radio <input>.`);
    ctx.ensureCheckpoint();
    const allEmpty = Object.values(styles).every((v) => v === '');
    if (pseudo === 'hover') queueToolMutation(ctx, allEmpty ? { type: 'removeCssHover', nodeId } : { type: 'updateCssHover', nodeId, styles });
    else queueToolMutation(ctx, allEmpty ? { type: 'removePseudo', nodeId, pseudo } : { type: 'updatePseudoStyle', nodeId, pseudo, styles });
    flushTool(ctx);
    trace.action('agent-tool:set_pseudo_style', { nodeId, pseudo, props: Object.keys(styles) });
    return ok({ node_id: nodeId, pseudo, styles: allEmpty ? null : styles });
  },
};

// ─── translate_attribute ─────────────────────────────────────────────────────

const TRANSLATABLE_ATTRS = ['placeholder', 'alt', 'title', 'aria-label', 'value'] as const;

export const translateAttributeTool: AgentTool = {
  name: 'translate_attribute',
  description:
    'Translate an ATTRIBUTE — an input placeholder, an image alt, a title or aria-label — into one configured language (set_locales first). The Input tool\'s localized attr: the default language keeps its value, the other languages read theirs from the message dictionary. ' +
    'Texts are translate_texts; this is for attributes only.',
  inputSchema: {
    node_id: z.string(),
    attr: z.enum(TRANSLATABLE_ATTRS),
    locale: z.string(),
    text: z.string(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const attr = String(args.attr);
    const cfg = getI18nConfig();
    const locale = String(args.locale);
    if (!cfg.locales.some((l) => l.code === locale)) return fail(`Locale "${locale}" is not configured — set_locales first. Configured: ${cfg.locales.map((l) => l.code).join(', ')}.`);
    if (locale === cfg.defaultLocale) return fail(`"${locale}" is the default language — set the attribute itself (set_attr).`);
    const current = node.attrs?.[attr];
    const transformed = node.attrTranslationKeys?.[attr] !== undefined;
    if (!transformed && !current) return fail(`"${nodeId}" has no ${attr} to translate — set_attr it in the default language first.`);
    if (isBranchedRun(ctx)) return fail('Translations are written on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    flushTool(ctx);
    commitTranslationAttr({ filePath: resolveToolFile(ctx), nodeId, attr, locale, defaultLocale: cfg.defaultLocale, text: String(args.text), transformed, fallbackDefaultValue: current });
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:translate_attribute', { nodeId, attr, locale });
    return ok({ node_id: nodeId, attr, locale, text: args.text });
  },
};

// ─── add_form_field ──────────────────────────────────────────────────────────

const FIELD_TYPES = ['text', 'email', 'tel', 'url', 'number', 'password', 'date', 'checkbox', 'radio', 'textarea', 'select'] as const;

/** The form element enclosing a node (the node itself when it is the form). */
function enclosingForm(ctx: ToolContext, nodeId: string): string | null {
  const code = getToolCode(ctx);
  const nodes = getToolNodes(ctx);
  const node = nodes.get(nodeId);
  if (node && /^(motion\.)?form$/.test(node.type)) return nodeId;
  return enclosingFormIdInCode(code, nodeId);
}

export const addFormFieldTool: AgentTool = {
  name: 'add_form_field',
  description:
    'Add a NATIVE form field with its label inside a <form> — the Insert panel\'s field: a labelled input / textarea / select / checkbox / radio with the `name` the submission collects, placed as a layout child. ' +
    'parent_id must be the form or an element inside it (fields outside a form never submit — the oracle refuses them). type: text | email | tel | url | number | password | date | checkbox | radio | textarea | select (options for select / radio). Returns the field ids.',
  inputSchema: {
    parent_id: z.string().describe('the <form> or a container inside it'),
    type: z.enum(FIELD_TYPES),
    name: z.string().describe('submission key, e.g. "email"'),
    label: z.string().describe('visible label text'),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional().describe('choices for select / radio'),
    index: z.number().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const parentId = String(args.parent_id);
    const nodes = getToolNodes(ctx);
    const parent = nodes.get(parentId);
    if (!parent) return fail(`No node "${parentId}" in the active file.`);
    const formId = enclosingForm(ctx, parentId);
    if (!formId) return fail(`"${parentId}" is not inside a <form> — fields outside a form never submit. Create the form first (add_node tag "form", then set_form_destination) or pick a container inside it.`);
    const name = String(args.name).trim();
    if (!/^[a-zA-Z][\w-]*$/.test(name)) return fail(`"${name}" is not a valid field name (letters, digits, - and _).`);
    const type = args.type as (typeof FIELD_TYPES)[number];
    const options = (args.options as string[] | undefined) ?? [];
    if ((type === 'select' || type === 'radio') && options.length === 0) return fail(`${type} needs options.`);
    ctx.ensureCheckpoint();
    const fieldId = generateNodeId(`field-${name}`);
    const inputId = generateNodeId(`${name}-input`);
    const labelId = generateNodeId(`${name}-label`);
    const inline = type === 'checkbox';
    // Column fields stretch by default (no alignItems — 'stretch' is not in the Align control).
    const wrapStyles = seedFlowChild({ position: 'relative', display: 'flex', flexDirection: inline ? 'row' : 'column', ...(inline ? { alignItems: 'center' } : {}), gap: inline ? '8px' : '6px', width: '100%' }, parent, nodes, args.index as number | undefined);
    queueToolMutation(ctx, { type: 'addNode', parentId, index: args.index as number | undefined, node: { id: fieldId, type: 'div', name: `${args.label} field`, styles: wrapStyles.styles } });
    queueOrderWrites(ctx, wrapStyles.siblings);
    const labelStyles = { position: 'relative', fontSize: '14px', fontWeight: '500', flex: '0 0 auto', order: inline ? '1' : '0' } as Record<string, string>;
    const controlStyles = { position: 'relative', width: inline ? 'auto' : '100%', flex: '0 0 auto', order: inline ? '0' : '1', ...(type === 'checkbox' || type === 'radio' ? {} : { padding: '10px 12px', fontSize: '14px', borderRadius: '8px', border: '1px solid #d4d4d8', backgroundColor: '#ffffff' }) } as Record<string, string>;
    const common: Record<string, string> = { name, ...(args.required ? { required: 'true' } : {}) };
    if (type === 'radio') {
      queueToolMutation(ctx, { type: 'addNode', parentId: fieldId, node: { id: labelId, type: 'span', name: 'Label', styles: labelStyles, textContent: String(args.label) } });
      options.forEach((opt, i) => {
        const rowId = generateNodeId(`${name}-option`);
        queueToolMutation(ctx, { type: 'addNode', parentId: fieldId, node: { id: rowId, type: 'label', name: opt, styles: { position: 'relative', display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto', order: String(i + 1) } } });
        queueToolMutation(ctx, { type: 'addNode', parentId: rowId, node: { id: generateNodeId(`${name}-radio`), type: 'input', name: `${opt} radio`, styles: { position: 'relative', flex: '0 0 auto', order: '0' }, attrs: { ...common, type: 'radio', value: opt } } });
        queueToolMutation(ctx, { type: 'addNode', parentId: rowId, node: { id: generateNodeId(`${name}-text`), type: 'span', name: opt, styles: { position: 'relative', fontSize: '14px', flex: '0 0 auto', order: '1' }, textContent: opt } });
      });
    } else {
      queueToolMutation(ctx, { type: 'addNode', parentId: fieldId, node: { id: labelId, type: 'label', name: 'Label', styles: labelStyles, attrs: { htmlFor: inputId }, textContent: String(args.label) } });
      const tag = type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input';
      const attrs: Record<string, string> = { ...common, id: inputId, ...(tag === 'input' ? { type } : {}), ...(args.placeholder && tag !== 'select' ? { placeholder: String(args.placeholder) } : {}) };
      queueToolMutation(ctx, { type: 'addNode', parentId: fieldId, node: { id: inputId, type: tag, name: `${args.label} ${tag}`, styles: type === 'textarea' ? { ...controlStyles, minHeight: '120px', resize: 'vertical' } : controlStyles, attrs } });
      if (tag === 'select') {
        options.forEach((opt, i) => queueToolMutation(ctx, { type: 'addNode', parentId: inputId, node: { id: generateNodeId(`${name}-opt`), type: 'option', name: opt, styles: {}, attrs: { value: opt }, textContent: opt } }));
      }
    }
    flushTool(ctx);
    trace.action('agent-tool:add_form_field', { formId, parentId, type, name });
    return ok({ form: formId, field: fieldId, label: labelId, control: type === 'radio' ? null : inputId, name, type });
  },
};

// ─── set_form_destination ────────────────────────────────────────────────────

export const setFormDestinationTool: AgentTool = {
  name: 'set_form_destination',
  description:
    'Where a form\'s submissions GO — the Form tool\'s Send To: email recipients (with subject), webhooks, a success redirect, spam filtering. Without a destination a form submits nowhere (the oracle blocks it). ' +
    'node_id is the <form>. Passing destinations REPLACES the list; omit a field to keep it. This also wires the submit handler and the relay route.',
  inputSchema: {
    node_id: z.string().describe('the <form> element'),
    emails: z.array(z.object({ recipient: z.string(), subject: z.string().optional(), name: z.string().optional() })).optional().describe('email destinations'),
    webhooks: z.array(z.object({ url: z.string(), secret: z.string().optional() })).optional(),
    redirect: z.string().optional().describe('success page ("/thank-you") or URL; "" clears'),
    antispam: z.enum(['block', 'pass', 'off']).optional().describe('basic spam filter: block drops spam, pass forwards it labelled'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (!/^(motion\.)?form$/.test(node.type)) return fail(`"${nodeId}" is a <${node.type}>, not a <form>. Make the wrapper a form (change_tag "form") or pass the form's id.`);
    const config = readFormConfig(node.attrs?.['data-form']);
    const emails = args.emails as { recipient: string; subject?: string; name?: string }[] | undefined;
    const webhooks = args.webhooks as { url: string; secret?: string }[] | undefined;
    if (emails || webhooks) {
      const next: FormDestination[] = [];
      for (const e of emails ?? []) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.recipient)) return fail(`"${e.recipient}" is not an email address.`);
        next.push({ id: newDestId(), type: 'email', recipient: e.recipient, ...(e.subject ? { subject: e.subject } : {}), ...(e.name ? { name: e.name } : {}) });
      }
      for (const w of webhooks ?? []) {
        if (!/^https:\/\//.test(w.url)) return fail(`Webhook "${w.url}" must be an https:// URL.`);
        next.push({ id: newDestId(), type: 'webhook', url: w.url, ...(w.secret ? { secret: w.secret } : {}) });
      }
      config.sendTo = next;
    }
    if (typeof args.redirect === 'string') config.redirect = args.redirect || undefined;
    if (args.antispam) config.antispam = args.antispam === 'off' ? null : { mode: 'basic', filtering: args.antispam as 'block' | 'pass' };
    if (config.sendTo.length === 0) return fail('A form needs at least one destination — pass emails or webhooks.');
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateHtmlAttrs', nodeId, attrs: { 'data-form': serializeFormConfig(config) } });
    flushTool(ctx);
    trace.action('agent-tool:set_form_destination', { nodeId, destinations: config.sendTo.length, redirect: !!config.redirect });
    return ok({ form: nodeId, send_to: config.sendTo.map((d) => (d.type === 'email' ? `email ${d.recipient}` : d.type === 'webhook' ? `webhook ${d.url}` : d.type)), redirect: config.redirect ?? null, antispam: config.antispam?.filtering ?? 'off', next: 'add_form_field for the fields, add_submit_button for the button' });
  },
};

// ─── add_submit_button ───────────────────────────────────────────────────────

export const addSubmitButtonTool: AgentTool = {
  name: 'add_submit_button',
  description:
    'Give a form its SUBMIT BUTTON as the builder\'s Form Submit component — a button instance with loading / success / error variants the form drives automatically (spinner while sending, "Sent" on success). ' +
    'parent_id is the form or a container inside it. Use it instead of a plain <button>: only this instance can be mapped with set_form.',
  inputSchema: {
    parent_id: z.string(),
    label: z.string().optional().describe('button text, default "Send"'),
    index: z.number().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const parentId = String(args.parent_id);
    const nodes = getToolNodes(ctx);
    if (!nodes.get(parentId)) return fail(`No node "${parentId}" in the active file.`);
    const formId = enclosingForm(ctx, parentId);
    if (!formId) return fail(`"${parentId}" is not inside a <form>.`);
    if (isBranchedRun(ctx)) return fail('add_submit_button works on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    // The Form tool materializes the master on first use; the instance goes
    // through the ordinary placement so it seeds its layout slot.
    const { ensureFormSubmitComponentFile } = await import('@/code/generation/form-submit-gen');
    ensureFormSubmitComponentFile();
    store.set(projectVersionAtom, (v) => v + 1);
    const { addComponentInstanceTool } = await import('./semantic-structure');
    const placed = await addComponentInstanceTool.execute({ name: 'FormSubmit', parent_id: parentId, index: args.index, props: args.label ? { label: String(args.label) } : {} }, ctx);
    if (placed.isError) return placed;
    const first = placed.content[0];
    const instanceId = (() => { try { const j = first.type === 'text' ? JSON.parse(first.text) : {}; return j.id ?? j.node_id; } catch { return undefined; } })();
    trace.action('agent-tool:add_submit_button', { formId, parentId, instanceId });
    return ok({ form: formId, button: instanceId ?? null, state_variable: formStateVar(formId), next: 'set_form on the button maps loading / success / error to its variants (they exist already)' });
  },
};

// ─── set_background_video ────────────────────────────────────────────────────

export const setBackgroundVideoTool: AgentTool = {
  name: 'set_background_video',
  description:
    'Fill an element with a looping BACKGROUND VIDEO — the Fill panel\'s Video: a muted, autoplaying, inline video behind the element\'s content (object-fit cover), with an optional poster. Pass src "" to remove it. Content stays on top; give the element a height.',
  inputSchema: {
    node_id: z.string(),
    src: z.string().describe('video URL (mp4 / webm); "" removes the video'),
    poster: z.string().optional(),
    object_fit: z.enum(['cover', 'contain']).optional(),
    loop: z.boolean().optional().describe('default true'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (/^[A-Z]/.test(node.type)) return fail(`"${nodeId}" is a component instance — put the video on an element inside the master or on a plain container.`);
    const src = String(args.src);
    ctx.ensureCheckpoint();
    if (src === '') {
      queueToolMutation(ctx, { type: 'removeVideoFill', nodeId });
    } else {
      if (!/^(https?:\/\/|\/)/.test(src)) return fail(`"${src}" is not a URL — use https://… or a project path.`);
      queueToolMutation(ctx, { type: 'setVideoFill', nodeId, opts: { src, autoPlay: true, muted: true, loop: args.loop !== false, playsInline: true, controls: false, objectFit: (args.object_fit as 'cover' | 'contain' | undefined) ?? 'cover', poster: (args.poster as string | undefined) ?? '' } });
    }
    flushTool(ctx);
    trace.action('agent-tool:set_background_video', { nodeId, removed: src === '' });
    return ok({ node_id: nodeId, video: src || null });
  },
};

// ─── check_project ───────────────────────────────────────────────────────────

const kindOf = oracleFileKind;

export const checkProjectTool: AgentTool = {
  name: 'check_project',
  description:
    'PUBLISH CHECK: run the builder\'s rule engine over every page, template and component and report what would break or drift (crash, unparseable, invisible to a panel) with file, line and the fix. ' +
    'Call it before saying a site is ready, or when the user asks whether it can be published. Blocking = tier 3 (the file would not build); the rest are dialect drift the panels cannot edit.',
  inputSchema: { path: z.string().optional().describe('one file to check; omit for the whole project') },
  category: 'read',
  async execute(args) {
    const only = args.path ? String(args.path) : null;
    const files = only ? [only] : projectFS.listFiles();
    const report: { file: string; kind: FileKind; violations: { code: string; tier: number; line?: number; element?: string; message: string }[] }[] = [];
    let checked = 0;
    for (const path of files) {
      const code = projectFS.readFile(path);
      if (code == null) { if (only) return fail(`No file "${path}".`); continue; }
      const kind = kindOf(path, code);
      if (!kind || isBuilderMaterializedFile(code)) continue;
      checked++;
      let violations: ReturnType<typeof checkFile> = [];
      try { violations = checkFile(code, { kind, path }); } catch (err) { violations = [{ code: 'SYNTAX_ERROR', tier: 3, message: String(err) }]; }
      if (violations.length) report.push({ file: path, kind, violations: violations.map((v) => ({ code: v.code, tier: v.tier, line: v.line, element: v.elementId ?? undefined, message: v.message.slice(0, 300) })) });
    }
    const blocking = report.reduce((n, f) => n + f.violations.filter((v) => v.tier >= 3).length, 0);
    const drift = report.reduce((n, f) => n + f.violations.filter((v) => v.tier < 3).length, 0);
    trace.action('agent-tool:check_project', { checked, files: report.length, blocking, drift });
    return ok({ checked_files: checked, ready: blocking === 0, blocking, drift, files: report, next: blocking ? 'fix the blocking rows first (apply_file_edit or the semantic tool named in the message), then check_project again' : drift ? 'the site builds; the drift rows are edits no panel can read back — fix what the user will want to edit' : 'nothing to fix' });
  },
};

export const FORMS_TEXT_TOOLS: AgentTool[] = [setTextOnBreakpointTool, setTextFitTool, setPseudoStyleTool, translateAttributeTool, setFormDestinationTool, addFormFieldTool, addSubmitButtonTool, setBackgroundVideoTool, checkProjectTool];
