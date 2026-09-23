// src/ai/agent/tools/i18n.ts
//
// Localization for the ONE agent (audit §9: "the in-app agent cannot make a
// site multilingual at all"). The Localization panel's operations existed —
// `addLocale`, `listTranslatableTexts`, `commitTranslationText` — and were
// reachable only over MCP, where the bridge also dropped the `rich` flag so a
// styled headline lost its marks in translation (audit V1). These tools call
// the same operations and pass the flag.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { flushTool, isBranchedRun } from '@/ai/agent/workspace';
import { projectVersionAtom, installBuiltInCodeComponent, projectFS } from '@/code/project/project-fs';
import { getI18nConfig, addLocale, removeLocale } from '@/code/project/locale-ops';
import { listTranslatableTexts, readTranslationText, commitTranslationText, ensureIntlScaffold } from '@/code/project/translation-ops';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/;
const bump = (): void => { store.set(projectVersionAtom, (v) => v + 1); };

export const setLocalesTool: AgentTool = {
  name: 'set_locales',
  description:
    'Make the site multilingual: add languages (ISO codes with a label — [{code:"fr", label:"French"}]). Sets up the translation scaffold and the /<locale>/ routes; the default language is unchanged. Then translate with translate_texts. Pass remove: ["fr"] to drop a language.',
  inputSchema: {
    add: z.array(z.object({ code: z.string(), label: z.string() })).optional(),
    remove: z.array(z.string()).optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const add = (args.add as { code: string; label: string }[] | undefined) ?? [];
    const remove = (args.remove as string[] | undefined) ?? [];
    if (add.length === 0 && remove.length === 0) return fail('set_locales needs `add` and/or `remove`.');
    for (const l of add) {
      if (!LOCALE_RE.test(l.code)) return fail(`Invalid locale code "${l.code}" — use ISO codes like "fr", "de", "pt-BR".`);
      if (!l.label?.trim()) return fail(`Locale "${l.code}" needs a label (e.g. "French").`);
    }
    if (isBranchedRun(ctx)) return fail('Locales are project-wide and are written on the active branch only — run unbranched.');
    const config = getI18nConfig();
    if (remove.includes(config.defaultLocale)) return fail(`"${config.defaultLocale}" is the default language and cannot be removed.`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    for (const l of add) addLocale(l.code, l.label.trim());
    for (const code of remove) removeLocale(code);
    if (add.length) ensureIntlScaffold();
    bump();
    const next = getI18nConfig();
    trace.action('agent-tool:set_locales', { added: add.map((l) => l.code), removed: remove });
    return ok({ default_locale: next.defaultLocale, locales: next.locales.map((l) => ({ code: l.code, label: l.label })), next: add.length ? 'translate_texts for each new locale; add_language_switcher to let visitors choose' : undefined });
  },
};

export const listTextsTool: AgentTool = {
  name: 'list_texts',
  description:
    'Every translatable text in the project — page and component texts, rich texts (marks kept), component-instance text props — with its current translations. Keys are (file_path, node_id); pass them to translate_texts. Filter by `file_path` to one page.',
  inputSchema: { file_path: z.string().optional() },
  category: 'read',
  async execute(args) {
    const config = getI18nConfig();
    const targets = config.locales.filter((l) => l.code !== config.defaultLocale).map((l) => l.code);
    const texts = listTranslatableTexts(config.defaultLocale).filter((t) => !args.file_path || t.filePath === args.file_path);
    return ok({
      default_locale: config.defaultLocale,
      locales: targets,
      texts: texts.map((t) => ({
        file_path: t.filePath, node_id: t.nodeId, label: t.label, source: t.source,
        ...(t.rich ? { rich: true } : {}),
        ...(t.instanceProp ? { instance_prop: t.instanceProp } : {}),
        translations: Object.fromEntries(targets.map((code) => [code, readTranslationText({ filePath: t.filePath, key: t.nodeId, locale: code }) ?? ''])),
      })),
    });
  },
};

export const translateTextsTool: AgentTool = {
  name: 'translate_texts',
  description:
    'Write translations for ONE locale: items are [{file_path, node_id, text}] from list_texts. Rich texts take inline HTML with the same marks as the source (<strong>, <em>, <span style>) — keep them. Component-instance text props are keyed the same way. The default language is edited on the canvas (set_text), never here.',
  inputSchema: {
    locale: z.string(),
    items: z.array(z.object({ file_path: z.string(), node_id: z.string(), text: z.string() })).min(1),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const locale = String(args.locale);
    const config = getI18nConfig();
    if (!config.locales.some((l) => l.code === locale)) return fail(`Locale "${locale}" is not configured — set_locales first. Configured: ${config.locales.map((l) => l.code).join(', ')}.`);
    if (locale === config.defaultLocale) return fail(`"${locale}" is the default language — edit its copy on the canvas (set_text), translate_texts writes the OTHER languages.`);
    if (isBranchedRun(ctx)) return fail('Translations are written on the active branch only — run unbranched.');
    const known = new Map(listTranslatableTexts(config.defaultLocale).map((t) => [`${t.filePath}:${t.nodeId}`, t]));
    const items = args.items as { file_path: string; node_id: string; text: string }[];
    const unknown: string[] = [];
    let written = 0;
    ctx.ensureCheckpoint();
    flushTool(ctx);
    for (const item of items) {
      const t = known.get(`${item.file_path}:${item.node_id}`);
      if (!t) { unknown.push(`${item.file_path}:${item.node_id}`); continue; }
      if (!item.text.trim()) continue;
      // `rich` forwarded: dropping it flattened a styled headline's marks (audit V1).
      commitTranslationText({ filePath: item.file_path, nodeId: item.node_id, locale, defaultLocale: config.defaultLocale, text: item.text, fallbackDefaultText: t.fallbackDefaultText, rich: t.rich });
      written++;
    }
    bump();
    trace.action('agent-tool:translate_texts', { locale, written, unknown: unknown.length });
    return ok({ locale, written, ...(unknown.length ? { unknown, hint: 'call list_texts for the current (file_path, node_id) keys' } : {}) });
  },
};

export const addLanguageSwitcherTool: AgentTool = {
  name: 'add_language_switcher',
  description: 'Place the built-in language switcher (a LocaleSwitcher code component) inside a parent — usually the header. Installs the component if the project does not have it yet.',
  inputSchema: { parent_id: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    if (getI18nConfig().locales.length < 2) return fail('The site has one language — set_locales first.');
    if (isBranchedRun(ctx)) return fail('add_language_switcher works on the active branch only — run unbranched.');
    ctx.ensureCheckpoint();
    installBuiltInCodeComponent(projectFS, 'LocaleSwitcher');
    bump();
    // Placement goes through the ordinary instance tool so it seeds the layout slot.
    const { addComponentInstanceTool } = await import('./semantic-structure');
    return addComponentInstanceTool.execute({ name: 'LocaleSwitcher', parent_id: String(args.parent_id) }, ctx);
  },
};

export const I18N_TOOLS: AgentTool[] = [setLocalesTool, listTextsTool, translateTextsTool, addLanguageSwitcherTool];
