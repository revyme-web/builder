// src/ai/agent/tools/tokens.ts
//
// Design tokens and typography presets (audit §6 G3, G4). The agent could
// UPDATE a token that existed and nothing else: no way to create one (so it
// hard-coded hex per node), remove one, give one a dark value, load a web
// font, or make a text style. Every write here is the MCP bridge's / the
// panel's own sequence over the same mutations — `addPresetToken`,
// `updatePresetToken`, `setDarkTokenValue`, `createDefaultTypoTokens`, the
// TypographyPresetControl's apply — so the agent's tokens are the user's tokens.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, isBranchedRun } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getPresetTokens, ensureGoogleFontImport } from '@/code/project/preset-ops';
import { scanPresetUsage } from '@/code/stores/preset-store';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import {
  TYPO_SUFFIXES, TYPO_VAR_PROP_MAP, RESPONSIVE_PROPS, createDefaultTypoTokens, groupTypoTokens, getTypoTag, getTypoTokenValue,
} from '@/editor/tools/typography-utils';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const CATEGORIES = ['color', 'typography', 'spacing', 'margin', 'radius', 'shadow', 'border', 'image', 'video', 'other'] as const;
const TOKEN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** The category a name's prefix implies (`color-brand` → color), as the
 *  tokens panel groups them. */
export function categoryFromName(name: string): PresetToken['category'] | null {
  const m = /^(color|typo|space|margin|radius|shadow|border|image|video)-/.exec(name);
  if (!m) return null;
  return ({ typo: 'typography', space: 'spacing' } as Record<string, PresetToken['category']>)[m[1]] ?? (m[1] as PresetToken['category']);
}

function bump(): void {
  refreshCanvasTokens();
  store.set(projectVersionAtom, (v) => v + 1);
}

export const createTokenTool: AgentTool = {
  name: 'create_token',
  description:
    'Create a design token (a CSS variable in the project\'s presets) — or update it if it exists. Name it kebab-case with its category prefix so it groups in the panel: color-accent, space-section, radius-card, shadow-soft, typo-… ' +
    'Then use it as var(--name) in styles, so one change follows everywhere. Optional dark_value for dark mode. get_design_tokens lists what exists.',
  inputSchema: {
    name: z.string().describe('kebab-case with category prefix, e.g. "color-accent"'),
    value: z.string().describe('the CSS value, e.g. "#f97316", "24px", "0px 8px 24px rgba(0,0,0,0.12)"'),
    category: z.enum(CATEGORIES).optional().describe('defaults to what the prefix implies'),
    label: z.string().optional().describe('display name in the panel'),
    dark_value: z.string().optional().describe('value in dark mode'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const name = String(args.name).replace(/^--/, '').trim();
    if (!TOKEN_NAME_RE.test(name)) return fail(`Invalid token name "${name}" — kebab-case only, prefixed with its category (color-/typo-/space-/radius-/shadow-/border-).`);
    const value = String(args.value ?? '').trim();
    if (!value) return fail('A token needs a value.');
    if (isBranchedRun(ctx)) return fail('Tokens are project-wide and are written on the active branch only — run unbranched.');
    const category = (args.category as PresetToken['category'] | undefined) ?? categoryFromName(name) ?? 'other';
    const existing = new Set(getPresetTokens().map((t) => t.name));
    ctx.ensureCheckpoint();
    if (existing.has(name)) queueToolMutation(ctx, { type: 'updatePresetToken', name, value });
    else queueToolMutation(ctx, { type: 'addPresetToken', token: { name, value, category, ...(args.label ? { label: String(args.label) } : {}) } });
    if (args.dark_value) queueToolMutation(ctx, { type: 'setDarkTokenValue', tokenName: name, darkValue: String(args.dark_value).trim() });
    flushTool(ctx);
    bump();
    trace.action('agent-tool:create_token', { name, category, created: !existing.has(name) });
    return ok({ name, value, category, use_as: `var(--${name})`, created: !existing.has(name) });
  },
};

export const removeTokenTool: AgentTool = {
  name: 'remove_token',
  description: 'Delete a design token. Refused while any element still uses it (a dead var() reference paints nothing) — the reply says where; rebind those first.',
  inputSchema: { name: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const name = String(args.name).replace(/^--/, '').trim();
    if (!getPresetTokens().some((t) => t.name === name)) return fail(`No token "${name}". get_design_tokens lists them.`);
    if (isBranchedRun(ctx)) return fail('Tokens are written on the active branch only — run unbranched.');
    const used = scanPresetUsage(projectFS.getSnapshot()).get(name);
    if (used?.length) {
      return fail(`"${name}" is still used by ${used.length} element(s) (e.g. ${used[0].filePath}${used[0].nodeId ? ` · ${used[0].nodeId}` : ''}). Rebind or restyle those first, then remove it.`);
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'removePresetToken', name });
    flushTool(ctx);
    bump();
    return ok({ removed: name });
  },
};

export const setDarkTokenTool: AgentTool = {
  name: 'set_dark_token',
  description: 'Give an existing token its DARK-MODE value (`:root.dark`), e.g. color-surface → #0b0b0f. The light value is unchanged.',
  inputSchema: { name: z.string(), dark_value: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const name = String(args.name).replace(/^--/, '').trim();
    if (!getPresetTokens().some((t) => t.name === name)) return fail(`No token "${name}". Create it first with create_token.`);
    if (isBranchedRun(ctx)) return fail('Tokens are written on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'setDarkTokenValue', tokenName: name, darkValue: String(args.dark_value).trim() });
    flushTool(ctx);
    bump();
    return ok({ name, dark_value: String(args.dark_value).trim() });
  },
};

const TYPO_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'li'] as const;

export const setTypographyPresetTool: AgentTool = {
  name: 'set_typography_preset',
  description:
    'Create or update a TYPOGRAPHY PRESET (a text style: "Heading", "Body") — one family of tokens the Text Style panel groups (font, weight, size, line-height, spacing, color, and optional responsive size-md / size-sm tiers). ' +
    'name is kebab-case ("heading", "body-large"); tag is the element it renders as; values are keyed by suffix: font, weight, size, line-height (unitless), spacing, color, transform, decoration, shadow, size-md, size-sm, line-height-md, line-height-sm, spacing-md, spacing-sm, min-default, min-md. ' +
    'Then put it on text with apply_typography_preset. Never hand-write typo-* tokens — the family has to be built as a whole.',
  inputSchema: {
    name: z.string().describe('preset slug, kebab-case, e.g. "heading"'),
    tag: z.enum(TYPO_TAGS).optional().describe('element the preset renders as (default p)'),
    values: z.record(z.string(), z.string()).optional().describe('suffix → value overrides, e.g. {"size":"48px","weight":"700","line-height":"1.1","font":"Inter, sans-serif"}'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const name = String(args.name).replace(/^--/, '').replace(/^typo-/, '').trim();
    if (!TOKEN_NAME_RE.test(name)) return fail(`set_typography_preset needs a kebab-case name ("heading", "body-large") — got "${name}".`);
    const overrides = (args.values as Record<string, string> | undefined) ?? {};
    const valid = new Set<string>(TYPO_SUFFIXES);
    for (const k of Object.keys(overrides)) if (!valid.has(k)) return fail(`Unknown typography suffix "${k}". Valid: ${TYPO_SUFFIXES.join(', ')}.`);
    if (overrides['line-height'] && /px|em|rem|%/.test(overrides['line-height'])) return fail("line-height must be a unitless ratio ('1.2') — never px.");
    if (isBranchedRun(ctx)) return fail('Presets are written on the active branch only — run unbranched.');
    const tag = String(args.tag ?? overrides.tag ?? 'p');
    const family = createDefaultTypoTokens(name, tag);
    for (const [suffix, value] of Object.entries(overrides)) {
      const tokenName = `typo-${name}-${suffix}`;
      const existing = family.find((t) => t.name === tokenName);
      if (existing) existing.value = String(value);
      else family.push({ name: tokenName, value: String(value), category: 'typography' });
    }
    if (overrides.font) ensureGoogleFontImport(String(overrides.font));
    const current = new Set(getPresetTokens().map((t) => t.name));
    ctx.ensureCheckpoint();
    for (const t of family) {
      if (current.has(t.name)) queueToolMutation(ctx, { type: 'updatePresetToken', name: t.name, value: t.value });
      else queueToolMutation(ctx, { type: 'addPresetToken', token: t });
    }
    flushTool(ctx);
    bump();
    trace.action('agent-tool:set_typography_preset', { name, tag, tokens: family.length });
    return ok({ preset: name, tag, tokens: family.map((t) => ({ name: t.name, value: t.value })), next: `apply_typography_preset on each text node that should use it` });
  },
};

const RETAGGABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'a', 'label', 'li']);

export const applyTypographyPresetTool: AgentTool = {
  name: 'apply_typography_preset',
  description:
    'Put a typography preset on a text element — the Text Style panel\'s apply: every bound property becomes var(--typo-<preset>-…), the element is retagged to the preset\'s tag (p → h2), and responsive tiers land as breakpoint rules. One call per node. get_design_tokens shows the presets (typography group).',
  inputSchema: { node_id: z.string(), preset: z.string().describe('preset slug, e.g. "heading"') },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const preset = String(args.preset).replace(/^--/, '').replace(/^typo-/, '').trim();
    const group = groupTypoTokens(getPresetTokens()).find((g) => g.name === preset);
    if (!group) {
      const names = groupTypoTokens(getPresetTokens()).map((g) => g.name);
      return fail(`No typography preset "${preset}".${names.length ? ` Presets: ${names.join(', ')}.` : ' Create one with set_typography_preset.'}`);
    }
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    ctx.ensureCheckpoint();
    const styles: Record<string, string> = {};
    for (const [suffix, cssProp] of Object.entries(TYPO_VAR_PROP_MAP)) {
      if (group.tokens.some((t) => t.name.endsWith(`-${suffix}`))) styles[cssProp] = `var(--typo-${group.name}-${suffix})`;
    }
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    const presetTag = getTypoTag(group);
    const currentTag = (node.type || '').toLowerCase();
    if (presetTag !== currentTag && RETAGGABLE.has(currentTag)) queueToolMutation(ctx, { type: 'changeTag', nodeId, newTag: presetTag });
    queueToolMutation(ctx, { type: 'clearContainerStyles', nodeId });
    const minDefault = parseInt(getTypoTokenValue(group, 'min-default') || '1200', 10);
    const minMd = parseInt(getTypoTokenValue(group, 'min-md') || '600', 10);
    for (const { tier, maxWidth } of [{ tier: 'md', maxWidth: minDefault - 1 }, { tier: 'sm', maxWidth: minMd - 1 }]) {
      if (maxWidth <= 0) continue;
      const tierStyles: Record<string, string> = {};
      for (const [propSuffix, cssProp] of Object.entries(RESPONSIVE_PROPS)) {
        if (group.tokens.some((t) => t.name.endsWith(`-${propSuffix}-${tier}`))) tierStyles[cssProp] = `var(--typo-${group.name}-${propSuffix}-${tier})`;
      }
      if (Object.keys(tierStyles).length) queueToolMutation(ctx, { type: 'updateContainerStyle', nodeId, maxWidth, styles: tierStyles });
    }
    flushTool(ctx);
    return ok({ node_id: nodeId, preset: group.name, tag: presetTag, bound: Object.keys(styles) });
  },
};

export const setFontTool: AgentTool = {
  name: 'set_font',
  description:
    'Use a web font on an element — and actually LOAD it: a Google Font is imported into the project once (system fonts need nothing). Writes fontFamily on the node. For the whole site, prefer a typography preset with a `font` value (set_typography_preset), then apply it.',
  inputSchema: {
    node_id: z.string(),
    family: z.string().describe('font family, e.g. "Inter", "Playfair Display" — a Google Fonts name, or a system font'),
    fallback: z.string().optional().describe('generic fallback: sans-serif (default), serif, monospace'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const family = String(args.family).replace(/['"]/g, '').trim();
    if (!family) return fail('set_font needs a family.');
    if (!getToolNodes(ctx).has(nodeId)) return fail(`No node "${nodeId}" in the active file.`);
    const fallback = String(args.fallback ?? 'sans-serif');
    const value = /\s/.test(family) ? `'${family}', ${fallback}` : `${family}, ${fallback}`;
    ctx.ensureCheckpoint();
    if (!isBranchedRun(ctx)) ensureGoogleFontImport(value);
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: { fontFamily: value } });
    flushTool(ctx);
    bump();
    return ok({ node_id: nodeId, fontFamily: value, loaded: !isBranchedRun(ctx) });
  },
};

export const TOKEN_TOOLS: AgentTool[] = [createTokenTool, removeTokenTool, setDarkTokenTool, setTypographyPresetTool, applyTypographyPresetTool, setFontTool];
