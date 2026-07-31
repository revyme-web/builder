// translation-ops.ts — shared commit primitive for per-locale TEXT edits
// (localization overhaul Phase 2, docs/localization/overhaul-plan.md).
//
// Used by the TranslationPanel (per-locale text areas in translation mode);
// mirrors the canvas text-edit controller's locale pipeline for the
// primary-viewport case:
//   · default locale, untransformed node → plain JSX text update
//   · default locale, transformed node   → messages/{default}.json
//   · non-default locale                 → transform JSX to {t('id')}
//                                          + seed default + messages/{locale}.json

import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { filePathToSlug } from '@/code/project/active-file-store';
import {
  transformTextToTranslation,
  transformAttrToTranslation,
  transformRunToTranslation,
  attrMessageKey,
  setMessageValue,
  getMessageValue,
  nodeHasTranslationCall,
} from '@/code/generation/i18n-gen';
import { extractTextRuns, replaceRunWithText, nodeInnerSpan, RUN_KEY_RE } from '@/code/parsing/rich-text-runs';
import { updateNodeTextInCode } from '@/code/generation/generator-crud';
import { updateHtmlAttrsInCode } from '@/code/generation/generator-attrs';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { isTextTag } from '@/shared/constants';
import { getI18nConfig } from '@/code/project/locale-ops';
import { findInstanceTag } from '@/code/components/instance-prop-overrides';
import { parsePropMeta } from '@/code/components/prop-meta';
import { parseScopedScalarExpr } from '@/code/generation/scoped-expr';
import { setLocaleInstancePropInCode, setInstancePropBaseInCode } from '@/code/generation/responsive-instance-prop-vars-gen';
import { buildProvidersSource, looksGeneratedProviders } from '@/code/project/providers-gen';
import { syncLocaleRoutes } from '@/code/project/locale-route-ops';
import { trace } from '@/shared/debug-trace';

// ─── Enumeration ────────────────────────────────────────────────────────────

export interface TranslatableText {
  filePath: string;
  kind: 'page' | 'component';
  nodeId: string;
  /** Display label — the node's data-name, falling back to its tag. */
  label: string;
  /** Default-locale text (messages value for transformed nodes, JSX text otherwise). */
  source: string;
  /** Pre-transform JSX text — the commitTranslationText seed fallback. */
  fallbackDefaultText: string;
  /** Set for component-INSTANCE plainText-prop rows (per-instance variable
   *  texts are translatable). `nodeId` is the composite
   *  `<instanceId>#<prop>`; reads/writes route through the scoped
   *  instance-prop expression, not messages/t(). */
  instanceProp?: { componentName: string; prop: string };
}

// ─── Instance plainText props ───────────────────────────────────────────────

/** Split a composite `<instanceId>#<prop>` row key. Null for plain node ids. */
function splitInstancePropKey(key: string): { instanceId: string; prop: string } | null {
  const i = key.indexOf('#');
  return i === -1 ? null : { instanceId: key.slice(0, i), prop: key.slice(i + 1) };
}

/** The raw attr expression for a prop on an instance tag, or null when absent. */
function readInstanceAttrRaw(code: string, instanceId: string, componentName: string, prop: string): string | null {
  const tag = findInstanceTag(code, instanceId, componentName);
  if (!tag) return null;
  const content = code.slice(tag.tagStart, tag.tagEnd);
  const m = content.match(new RegExp(`\\s${prop}=(?:"([^"]*)"|\\{((?:[^{}]|\\{[^{}]*\\})+)\\})`));
  if (!m) return null;
  return m[1] !== undefined ? JSON.stringify(m[1]) : m[2].trim();
}

const unqLit = (v: string): string | null => {
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/);
  return m ? (m[1] ?? m[2] ?? '') : null;
};

/** The instance's DEFAULT-locale value for a plainText prop: attr base branch
 *  → master signature default. */
function readInstancePropBase(hostCode: string, instanceId: string, componentName: string, prop: string, compCode: string): string {
  const masterDefault = compCode.match(new RegExp(`[{,\\s]${prop}\\s*=\\s*"([^"]*)"`))?.[1] ?? '';
  const raw = readInstanceAttrRaw(hostCode, instanceId, componentName, prop);
  if (raw == null) return masterDefault;
  const direct = unqLit(raw);
  if (direct !== null) return direct;
  if (/__activeLocale|__mq/.test(raw)) {
    const base = parseScopedScalarExpr(hostCode, raw).base;
    if (base === 'undefined') return masterDefault;
    return unqLit(base) ?? masterDefault;
  }
  return masterDefault;
}

/** A locale's value for an instance plainText prop (global, unbanded scope). */
function readInstancePropLocaleText(hostCode: string, instanceId: string, componentName: string, prop: string, locale: string): string | null {
  const raw = readInstanceAttrRaw(hostCode, instanceId, componentName, prop);
  if (raw == null || !raw.includes('__activeLocale')) return null;
  for (const r of parseScopedScalarExpr(hostCode, raw).responsive) {
    if ('locale' in r.scope && r.scope.locale === locale && !r.scope.query) {
      const v = unqLit(r.value);
      if (v !== null && r.value !== 'undefined') return v;
    }
  }
  return null;
}

/** Enumerate every translatable TEXT node across pages + components — the
 *  single source the Localization overlay's rows AND the MCP translations
 *  bridge share. Translatable = already-transformed ({t('id')} present) OR a
 *  plain text tag with literal content (no text variable / CMS binding). */
export function listTranslatableTexts(defaultLocale: string): TranslatableText[] {
  const out: TranslatableText[] = [];
  const files = projectFS.listFiles().filter(f =>
    f.endsWith('page.client.tsx') || (f.startsWith('components/') && f.endsWith('.tsx')));
  for (const filePath of files) {
    const code = projectFS.readFile(filePath);
    if (!code) continue;
    const kind: TranslatableText['kind'] = filePath.startsWith('components/') ? 'component' : 'page';
    let nodes;
    try { nodes = parseJSXToNodes(code); } catch { continue; }
    for (const [nodeId, node] of nodes) {
      // RICH TEXT (mixed content) — never surface the raw inner JSX (`<span
      // style={{…}}>…`, the user-reported markup leak). Each visible text RUN
      // is its own row under `<nodeId>__r<index>`; a run already transformed
      // to {t('key')} keeps its persisted key so edits can't re-key it.
      if (node.hasMixedContent && node.textContent?.trim() && !node.textVariable && !node.binding
          && isTextTag(node.type)) {
        const runs = extractTextRuns(node.textContent);
        runs.forEach((run, i) => {
          const key = run.key ?? `${nodeId}__r${i}`;
          const source = run.key
            ? (readTranslationText({ filePath, key, locale: defaultLocale }) ?? '')
            : run.text;
          if (!source.trim()) return;
          out.push({
            filePath, kind, nodeId: key,
            label: `${node.name || node.type}${runs.length > 1 ? ` · ${i + 1}` : ''}`,
            source,
            fallbackDefaultText: source,
          });
        });
        continue;
      }
      const translatable = node.translationKey
        || (isTextTag(node.type) && node.textContent?.trim() && !node.textVariable && !node.binding);
      if (!translatable) continue;
      const source = node.translationKey
        ? (readTranslationText({ filePath, key: nodeId, locale: defaultLocale }) ?? node.textContent ?? '')
        : (node.textContent ?? '');
      out.push({
        filePath, kind, nodeId,
        label: node.name || node.type,
        source,
        fallbackDefaultText: node.textContent ?? '',
      });
    }
    // Component-INSTANCE plainText props: a master whose text
    // is variable-bound ({content}) has NO literal text node — the per-
    // instance prop VALUES are the user-visible copy, so each instance gets a
    // row per plainText prop. Detected via the host file's component imports
    // (covers nested instances inside other component masters too).
    const importRe = /import\s+(\w+)\s+from\s+['"]@\/components\/([\w-]+)['"]/g;
    let im: RegExpExecArray | null;
    while ((im = importRe.exec(code)) !== null) {
      const compName = im[1];
      const compPath = `components/${im[2]}.tsx`;
      const compCode = projectFS.readFile(compPath);
      if (!compCode) continue;
      const meta = parsePropMeta(compCode);
      const textProps = Object.entries(meta).filter(([, e]) => e.type === 'plainText');
      if (textProps.length === 0) continue;
      const tagRe = new RegExp(`<${compName}\\b[^>]*data-id="([^"]+)"[^>]*>`, 'g');
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(code)) !== null) {
        const instanceId = tm[1];
        // data-name sits anywhere on the tag — a lazy optional group inside
        // tagRe gets SKIPPED by the engine, so read it from the matched text.
        const instName = tm[0].match(/data-name="([^"]*)"/)?.[1];
        for (const [prop, entry] of textProps) {
          const source = readInstancePropBase(code, instanceId, compName, prop, compCode);
          if (!source.trim()) continue;
          out.push({
            filePath, kind,
            nodeId: `${instanceId}#${prop}`,
            label: `${instName || compName} · ${entry.label || prop}`,
            source,
            fallbackDefaultText: source,
            instanceProp: { componentName: compName, prop },
          });
        }
      }
    }
  }
  trace.fn('listTranslatableTexts', { files: files.length, texts: out.length });
  return out;
}

export function commitTranslationText(opts: {
  filePath: string;
  nodeId: string;
  /** Locale being edited. */
  locale: string;
  defaultLocale: string;
  text: string;
  /** Pre-edit default-locale text (parsed node textContent) — the seed
   *  fallback when the JSX transform can't capture the original. */
  fallbackDefaultText?: string;
}): void {
  const { filePath, nodeId, locale, defaultLocale, text } = opts;

  // RICH-TEXT RUN key (`<hostId>__r<index>`) — route to the run pipeline:
  //   · default locale, untransformed run → in-place text splice in the JSX
  //   · default locale, transformed run   → messages/{default}.json
  //   · non-default locale                → transform THAT run to {t('key')}
  //                                         + seed default + messages/{locale}
  const runMatch = RUN_KEY_RE.exec(nodeId);
  if (runMatch) {
    commitRichRunTranslation({
      filePath, hostId: runMatch[1], runIndex: parseInt(runMatch[2], 10),
      key: nodeId, locale, defaultLocale, text,
      fallbackDefaultText: opts.fallbackDefaultText ?? '',
    });
    return;
  }
  const inst = splitInstancePropKey(nodeId);
  if (inst) {
    // Instance plainText prop — route through the scoped instance-prop
    // expression (the same rail the ComponentPropsTool pill writes).
    modifyProjectFile(filePath, (code) => {
      const tagName = code.match(new RegExp(`<(\\w+)\\b[^>]*data-id="${inst.instanceId}"`))?.[1];
      if (!tagName) return code;
      if (locale === defaultLocale) {
        const raw = readInstanceAttrRaw(code, inst.instanceId, tagName, inst.prop);
        if (raw != null && /__activeLocale|__mq/.test(raw)) {
          return setInstancePropBaseInCode(code, inst.instanceId, tagName, inst.prop, JSON.stringify(text));
        }
        // Plain (or absent) attr — set/replace the literal on the tag.
        const tag = findInstanceTag(code, inst.instanceId, tagName);
        if (!tag) return code;
        const content = code.slice(tag.tagStart, tag.tagEnd);
        const attrRe = new RegExp(`(\\s${inst.prop}=)(?:"[^"]*"|\\{(?:[^{}]|\\{[^{}]*\\})+\\})`);
        const next = attrRe.test(content)
          ? content.replace(attrRe, `$1${JSON.stringify(text)}`)
          : content.replace(new RegExp(`(<${tagName}\\b)`), `$1 ${inst.prop}=${JSON.stringify(text)}`);
        return code.slice(0, tag.tagStart) + next + code.slice(tag.tagEnd);
      }
      return setLocaleInstancePropInCode(code, inst.instanceId, tagName, inst.prop, locale, text);
    });
    trace.fn('commitTranslationText:instance-prop', { nodeId, locale, text: text.slice(0, 40) });
    return;
  }
  const namespace = filePathToSlug(filePath);
  const key = nodeId;
  trace.fn('commitTranslationText', { nodeId, locale, defaultLocale, namespace, text: text.slice(0, 40) });
  ensureIntlScaffold();

  if (locale === defaultLocale) {
    const sourceCode = projectFS.readFile(filePath) ?? '';
    if (sourceCode && nodeHasTranslationCall(sourceCode, nodeId)) {
      // Transformed node — the default text lives in messages, not JSX.
      const msgPath = `messages/${defaultLocale}.json`;
      const raw = projectFS.readFile(msgPath) ?? '{}';
      projectFS.writeFile(msgPath, setMessageValue(raw, namespace, key, text));
      trace.action('commitTranslationText:default-message', { nodeId, namespace });
    } else {
      // Untransformed node — the default text IS the JSX text.
      modifyProjectFile(filePath, (code) => updateNodeTextInCode(code, nodeId, text));
      trace.action('commitTranslationText:default-jsx', { nodeId });
    }
    return;
  }

  // Non-default locale: ensure the JSX carries {t('id')} + the default
  // message is seeded, then write the translation.
  modifyProjectFile(filePath, (currentCode) => {
    const result = transformTextToTranslation(currentCode, nodeId, key, namespace);
    const seedText = (result.changed && result.originalText)
      ? result.originalText
      : (opts.fallbackDefaultText ?? '');
    if (seedText) {
      const defaultMsgPath = `messages/${defaultLocale}.json`;
      const defaultMsgRaw = projectFS.readFile(defaultMsgPath) ?? '{}';
      if (getMessageValue(defaultMsgRaw, namespace, key) === null) {
        projectFS.writeFile(defaultMsgPath, setMessageValue(defaultMsgRaw, namespace, key, seedText));
        trace.action('commitTranslationText:seed-default', { nodeId, namespace });
      }
    }
    return result.code;
  });
  const msgPath = `messages/${locale}.json`;
  const raw = projectFS.readFile(msgPath) ?? '{}';
  projectFS.writeFile(msgPath, setMessageValue(raw, namespace, key, text));
  trace.action('commitTranslationText:locale-message', { nodeId, locale, namespace });
}

/** Rich-text RUN commit — see the dispatch note in commitTranslationText. */
function commitRichRunTranslation(opts: {
  filePath: string;
  hostId: string;
  runIndex: number;
  /** Full message key (`<hostId>__r<index>`). */
  key: string;
  locale: string;
  defaultLocale: string;
  text: string;
  fallbackDefaultText: string;
}): void {
  const { filePath, hostId, runIndex, key, locale, defaultLocale, text } = opts;
  const namespace = filePathToSlug(filePath);
  trace.fn('commitRichRunTranslation', { hostId, runIndex, locale, text: text.slice(0, 40) });
  ensureIntlScaffold();

  /** The current run for `key` in this code — matched by persisted key first
   *  (edit-drift-proof), then by document index. */
  const findRun = (code: string) => {
    const span = nodeInnerSpan(code, hostId);
    if (!span) return null;
    const inner = code.slice(span.start, span.end);
    const runs = extractTextRuns(inner);
    const run = runs.find((r) => r.key === key) ?? runs[runIndex] ?? null;
    return run ? { span, inner, run } : null;
  };

  if (locale === defaultLocale) {
    const code = projectFS.readFile(filePath) ?? '';
    const found = findRun(code);
    if (found?.run.key) {
      // Transformed run — the default text lives in messages.
      const msgPath = `messages/${defaultLocale}.json`;
      const raw = projectFS.readFile(msgPath) ?? '{}';
      projectFS.writeFile(msgPath, setMessageValue(raw, namespace, key, text));
      trace.action('commitRichRun:default-message', { hostId, key });
    } else {
      // Untransformed — splice the run's text in place (spans untouched).
      modifyProjectFile(filePath, (currentCode) => {
        const f = findRun(currentCode);
        if (!f || f.run.key) return currentCode;
        const newInner = replaceRunWithText(f.inner, f.run, text);
        return currentCode.slice(0, f.span.start) + newInner + currentCode.slice(f.span.end);
      });
      trace.action('commitRichRun:default-jsx', { hostId, runIndex });
    }
    return;
  }

  // Non-default locale: transform THAT run to {t('key')} (idempotent), seed
  // the default message with the original run text, write the translation.
  modifyProjectFile(filePath, (currentCode) => {
    const f = findRun(currentCode);
    if (f && !f.run.key) {
      const result = transformRunToTranslation(currentCode, hostId, runIndex, key, namespace);
      const seed = (result.changed && result.originalText) ? result.originalText : opts.fallbackDefaultText;
      if (seed) {
        const defaultMsgPath = `messages/${defaultLocale}.json`;
        const defaultMsgRaw = projectFS.readFile(defaultMsgPath) ?? '{}';
        if (getMessageValue(defaultMsgRaw, namespace, key) === null) {
          projectFS.writeFile(defaultMsgPath, setMessageValue(defaultMsgRaw, namespace, key, seed));
          trace.action('commitRichRun:seed-default', { hostId, key });
        }
      }
      return result.changed ? result.code : currentCode;
    }
    return currentCode;
  });
  const msgPath = `messages/${locale}.json`;
  const raw = projectFS.readFile(msgPath) ?? '{}';
  projectFS.writeFile(msgPath, setMessageValue(raw, namespace, key, text));
  trace.action('commitRichRun:locale-message', { hostId, key, locale });
}

/** Per-locale commit for a translatable ATTR (input placeholder, alt, …).
 *  `transformed` = the attr already carries a translation call
 *  (node.attrTranslationKeys has it). */
export function commitTranslationAttr(opts: {
  filePath: string;
  nodeId: string;
  attr: string;
  locale: string;
  defaultLocale: string;
  text: string;
  transformed: boolean;
  /** Pre-edit attr value (node.attrs[attr]) — seed fallback. */
  fallbackDefaultValue?: string;
}): void {
  const { filePath, nodeId, attr, locale, defaultLocale, text, transformed } = opts;
  const namespace = filePathToSlug(filePath);
  const key = attrMessageKey(nodeId, attr);
  trace.fn('commitTranslationAttr', { nodeId, attr, locale, transformed });

  if (locale === defaultLocale && !transformed) {
    // Plain attr update — no translation machinery yet.
    modifyProjectFile(filePath, (code) => updateHtmlAttrsInCode(code, nodeId, { [attr]: text }));
    return;
  }

  if (locale !== defaultLocale && !transformed) {
    // First translation for this attr: rewrite to {t('key')} + seed default.
    modifyProjectFile(filePath, (currentCode) => {
      const result = transformAttrToTranslation(currentCode, nodeId, attr, namespace);
      const seed = (result.changed && result.originalValue) ? result.originalValue : (opts.fallbackDefaultValue ?? '');
      if (seed) {
        const defaultMsgPath = `messages/${defaultLocale}.json`;
        const raw = projectFS.readFile(defaultMsgPath) ?? '{}';
        if (getMessageValue(raw, namespace, key) === null) {
          projectFS.writeFile(defaultMsgPath, setMessageValue(raw, namespace, key, seed));
        }
      }
      return result.code;
    });
  }

  const msgPath = `messages/${locale}.json`;
  const raw = projectFS.readFile(msgPath) ?? '{}';
  projectFS.writeFile(msgPath, setMessageValue(raw, namespace, key, text));
  trace.action('commitTranslationAttr:message', { nodeId, attr, locale, namespace });
}

/** Ensure the next-intl runtime scaffold exists and the ROOT LAYOUT wraps
 *  children in <Providers> — a bare layout (older createEmptyProject /
 *  imported projects) made every localized page crash with "context from
 *  NextIntlClientProvider was not found" in preview and on the live build.
 *  Idempotent; called at project load and before every translation write. */
export function ensureIntlScaffold(): void {
  const config = getI18nConfig();
  // providers.tsx — GENERATED from the i18n config (see providers-gen.ts).
  // Seed when missing; regenerate when an editor-generated version drifted
  // (locale added/removed, older template). Hand-written providers survive.
  const expectedProviders = buildProvidersSource(config);
  const currentProviders = projectFS.readFile('app/providers.tsx');
  if (currentProviders == null) {
    projectFS.writeFile('app/providers.tsx', expectedProviders);
    trace.action('ensureIntlScaffold:providers-seeded', {});
  } else if (currentProviders !== expectedProviders && looksGeneratedProviders(currentProviders)) {
    projectFS.writeFile('app/providers.tsx', expectedProviders);
    trace.action('ensureIntlScaffold:providers-regenerated', { locales: config.locales.map(l => l.code) });
  }
  // Per-locale route wrappers (/fr/... URLs) — see locale-route-ops.ts.
  syncLocaleRoutes(config);
  // Seed a messages file for EVERY configured locale (plus the legacy en/fr/es
  // trio for projects without a config) — an 'it'/'de'/… locale added later
  // must not 404 its messages import on the live build.
  const configured = config.locales.map(l => `messages/${l.code}.json`);
  for (const f of new Set(['messages/en.json', 'messages/fr.json', 'messages/es.json', ...configured])) {
    if (!projectFS.readFile(f)) projectFS.writeFile(f, '{}');
  }
  // Root layout — inject the Providers import + wrap when missing.
  const layout = projectFS.readFile('app/layout.tsx');
  if (layout && !layout.includes('Providers')) {
    let healed = layout;
    if (!healed.includes("./providers")) {
      healed = healed.replace(/^(import[^\n]*\n)/, `$1import { Providers } from './providers';\n`);
    }
    // Wrap the body children: <body>{children}</body> (with optional attrs).
    healed = healed.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/, (_m, open, inner, close) =>
      `${open}<Providers>${inner}</Providers>${close}`);
    if (healed !== layout && healed.includes('<Providers>')) {
      projectFS.writeFile('app/layout.tsx', healed);
      trace.action('ensureIntlScaffold:layout-healed', {});
    }
  }
}

/** One-shot migration of the DEPRECATED `i18n/{locale}.json` text overrides
 *  into the messages/*.json + `{t()}` pipeline (localization overhaul
 *  Phase 5). The legacy layer was canvas-only — translations saved through
 *  the old Manage Translations overlay never reached the live site. Runs at
 *  project load; idempotent (migrated files get their `pages` emptied;
 *  `collections` is left for the CMS phase). Style/visible overrides are
 *  dropped — they never shipped anywhere. */
export function migrateLegacyLocaleTextOverrides(config: { defaultLocale: string; locales: { code: string }[] }): void {
  for (const l of config.locales) {
    if (l.code === config.defaultLocale) continue;
    const legacyPath = `i18n/${l.code}.json`;
    const raw = projectFS.readFile(legacyPath);
    if (!raw) continue;
    let parsed: { pages?: Record<string, Record<string, { text?: string; textOverrides?: Record<string, string> }>>; collections?: unknown };
    try { parsed = JSON.parse(raw); } catch { continue; }
    const pages = parsed?.pages;
    if (!pages || Object.keys(pages).length === 0) continue;

    let migrated = 0;
    for (const [filePath, nodeOverrides] of Object.entries(pages)) {
      if (!projectFS.readFile(filePath)) continue;
      const namespace = filePathToSlug(filePath);
      for (const [nodeId, override] of Object.entries(nodeOverrides)) {
        if (override.text) {
          const existing = readTranslationText({ filePath, key: nodeId, locale: l.code });
          if (existing === null) {
            commitTranslationText({
              filePath, nodeId, locale: l.code,
              defaultLocale: config.defaultLocale, text: override.text,
            });
            migrated++;
          }
        }
        if (override.textOverrides) {
          const msgPath = `messages/${l.code}.json`;
          for (const [vpWidth, text] of Object.entries(override.textOverrides)) {
            const key = `${nodeId}__${vpWidth}`;
            let cur = projectFS.readFile(msgPath) ?? '{}';
            if (getMessageValue(cur, namespace, key) === null) {
              projectFS.writeFile(msgPath, setMessageValue(cur, namespace, key, text));
              migrated++;
            }
          }
        }
      }
    }
    // Retire the migrated page overrides — keep collections untouched.
    projectFS.writeFile(legacyPath, JSON.stringify({ pages: {}, collections: (parsed as any).collections ?? {} }, null, 2));
    trace.action('migrateLegacyLocaleTextOverrides', { locale: l.code, migrated });
  }
}

/** Read the stored text for (nodeId, locale): messages value, or for the
 *  default locale of an untransformed node, null (caller falls back to the
 *  parsed node textContent). */
export function readTranslationText(opts: {
  filePath: string;
  /** Message key — the nodeId for text, `attrMessageKey(...)` for attrs,
   *  `<instanceId>#<prop>` for instance plainText props. */
  key: string;
  locale: string;
}): string | null {
  const inst = splitInstancePropKey(opts.key);
  if (inst) {
    // Instance plainText prop — the translation lives in the scoped attr
    // expression on the instance tag, not in messages/.
    const hostCode = projectFS.readFile(opts.filePath);
    if (!hostCode) return null;
    const tagName = hostCode.match(new RegExp(`<(\\w+)\\b[^>]*data-id="${inst.instanceId}"`))?.[1];
    if (!tagName) return null;
    return readInstancePropLocaleText(hostCode, inst.instanceId, tagName, inst.prop, opts.locale);
  }
  const namespace = filePathToSlug(opts.filePath);
  const raw = projectFS.readFile(`messages/${opts.locale}.json`);
  if (!raw) return null;
  return getMessageValue(raw, namespace, opts.key);
}
