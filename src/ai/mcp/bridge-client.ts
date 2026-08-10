// mcp/bridge-client.ts — editor side of the Revyme MCP bridge.
//
// The ai-generator server exposes MCP tools (revyme_get_context, revyme_read_file,
// revyme_submit_files, …) but the project files AND the oracle live here in the
// browser. This module opens an EventSource to the server's /bridge/events
// stream, executes each bridged request against the live editor state, and
// POSTs the result back to /bridge/result.
//
// The gate is non-negotiable: submitFiles runs the EXACT same gateTurnFiles /
// commitTurnFiles pair the in-app freeform loop uses — an MCP client can never
// commit a file the vibe panel would have bounced.
//
// Dev-only by design (started behind import.meta.env.DEV): the server bridge is
// single-client and unauthenticated, fine for localhost, wrong for production.

import { getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { projectFS } from '@/code/project/project-fs';
import {
  activeFilePathAtom,
  isComponentFilePath,
  isPageClientFile,
  isLayoutFile,
  isIconSetFilePath,
  listPageFiles,
  createPageFile,
  getPageClientPath,
} from '@/code/project/active-file-store';
import { applyTemplate } from '@/code/project/template-ops';
import { canvasInteractingAtom } from '@/code/stores/store';
import { isTextEditingAtom } from '@/code/stores/editor-store';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { triggerAutosave, flushSaveNow } from '@/backend/autosave';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { getPresetTokens } from '@/code/project/preset-ops';
import { getI18nConfig, addLocale } from '@/code/project/locale-ops';
import { listTranslatableTexts, readTranslationText, commitTranslationText, ensureIntlScaffold } from '@/code/project/translation-ops';
import { scanPresetUsage } from '@/code/stores/preset-store';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { listCollections, getCollectionSchema, getCollectionData, createBlankCollection } from '@/code/project/cms-ops';
import { createDefaultTypoTokens, TYPO_SUFFIXES } from '@/editor/tools/typography-utils';
import { createCmsIndexPageFile, createCmsDetailPageFile } from '@/code/project/cms-page-ops';
import { executeCmsTool } from '@/ai/cms-agent/cms-tool-executors';
import type { PresetToken } from '@/shared/types';
import { gateTurnFiles, commitTurnFiles, formatBounce, type TurnFile } from '@/ai/freeform/freeform-client';
import { creditRead, checkStaleWrites } from './read-tracker';
import { shareComponent } from '@/cloud/components/component-share';
import { hasComponentControls } from '@/code/components/controls-parser';
import { createVectorSetFromSvgs, looksLikeSvg, MAX_ICONS_PER_SET, MAX_SVG_FILE_BYTES, type PreflightSvg } from '@/code/icons/create-vector-set-from-svgs';
import { isComponentUrl, importComponentFromUrl } from '@/cloud/components/component-paste';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

type BridgeHandler = (params: any) => Promise<unknown>;

/** Exported for tests — the dispatch table behind the EventSource. */
export const bridgeHandlers: Record<string, BridgeHandler> = {
  async getContext() {
    const store = getDefaultStore();
    const activeFilePath = store.get(activeFilePathAtom);
    const kind = isComponentFilePath(activeFilePath) ? 'component' : 'page';
    // What KIND of canvas the user is looking at. 'template' = a LayoutClient
    // file (page dialect + the sacred {children} slot — Next.js layout
    // semantics); the slot rule is enforced by the gate either way, this
    // field lets the model understand it up front.
    const surface = isComponentFilePath(activeFilePath) ? 'component'
      : isLayoutFile(activeFilePath) ? 'template'
      : isIconSetFilePath(activeFilePath) ? 'icon-set'
      : 'page';
    const context = {
      activeFilePath,
      kind,
      surface,
      code: projectFS.readFile(activeFilePath),
      pages: listPageFiles(),
      components: projectFS.listFiles('components/'),
      // Design tokens from app/globals.css — the ONLY var(--…) names a
      // submitted file may reference (the gate bounces unknown tokens).
      presets: getPresetTokens().map((t) => ({ name: t.name, value: t.value, category: t.category })),
      // CMS collections — the ONLY '@/cms/<slug>.json' imports that resolve
      // (the gate bounces unknown collections). Manage via revyme_manage_cms.
      collections: listCollections().map((slug) => {
        const schema = getCollectionSchema(slug);
        const items = getCollectionData(slug);
        return {
          slug,
          name: schema?.name ?? slug,
          fields: schema?.fields.map((fd) => ({ id: fd.id, type: fd.type, label: fd.name })) ?? [],
          itemCount: items.length,
          // Locales this collection already has row translations for. Told up
          // front so a multilingual site doesn't get a `language` column and
          // duplicate rows invented for it — the gate rejects that shape, but
          // learning it only on a bounce wastes a turn.
          translatedLocales: [...new Set(items.flatMap((i) => Object.keys(i._i18n ?? {})))],
        };
      }),
    };

    // LOCALIZATION — only when the project actually has more than one locale.
    // A monolingual project gets nothing, so the common case stays quiet.
    try {
      const i18n = getI18nConfig();
      if (i18n.locales.length > 1) {
        (context as Record<string, unknown>).localization = {
          defaultLocale: i18n.defaultLocale,
          locales: i18n.locales.map((l) => l.code),
          note: 'This project is multilingual. UI TEXT is localized with {t(\'<data-id>\')} + messages/<locale>.json. '
            + 'CMS CONTENT is localized ON THE ROW: one row per item with _i18n[locale][field], written via '
            + 'revyme_manage_cms set_item_translation, and rendered by wrapping the collection at the head of the '
            + 'chain — {localizeRows(<collection>, __activeLocale).map((row, idx) => …)} with '
            + "import { localizeRows } from '@revyme/runtime' and const __activeLocale = useLocale(). "
            + 'NEVER add a language/locale field, never duplicate rows per locale, and never filter rows by locale: '
            + 'that produces an array the builder cannot resolve, and the list loses its CMS panel and every field binding.',
        };
      }
    } catch { /* no i18n config yet — monolingual project */ }
    // Credit the active file the client now sees — get_context serves its full
    // code, so a follow-up submit to it is NOT a blind write (the stale-write
    // guard in submitFiles keys off what the bridge has served).
    creditRead(activeFilePath, context.code);
    trace.action('mcp-bridge:get-context', { activeFilePath, kind, surface, pages: context.pages.length, components: context.components.length, presets: context.presets.length });
    return context;
  },

  async listFiles() {
    const files = projectFS.listFiles();
    trace.action('mcp-bridge:list-files', { count: files.length });
    return { files };
  },

  /** Localize an image into the USER's own storage via the SAME quota-enforced
   *  upload path the editor's upload button uses (backend.uploadAsset → POST
   *  /api/upload, credentials included → counts against the website's storage
   *  cap). The bytes arrive base64-encoded because the editor browser can't
   *  fetch cross-origin sources (platform.revyme.app has no CORS): the
   *  ai-generator server downloads the source URL in Node and hands the bytes
   *  here; the editor — the only authed surface that knows the websiteId —
   *  performs the actual upload. Reusable for ANY image (3D asset, external
   *  URL, or a local file the model read as base64). Returns the new CDN URL. */
  async uploadImage(params: { dataBase64?: string; contentType?: string; filename?: string }) {
    if (isViewerMode()) throw new Error('This editor session is view-only — uploads are disabled.');
    const { dataBase64, contentType, filename } = params;
    if (!dataBase64) throw new Error('uploadImage: dataBase64 required');
    const projectId = getProjectId();
    if (projectId === 'local') {
      throw new Error('No website is open in the editor (standalone/local mode has no storage) — open the project in the cloud builder to upload assets.');
    }
    // base64 → bytes → File. atob yields a binary string; copy char codes.
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const type = contentType || 'image/webp';
    const name = filename || `asset.${(type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'}`;
    const file = new File([bytes], name, { type });
    // uploadAsset surfaces the 402 storage-cap message — let it bubble to the
    // MCP caller so the model reports "out of storage" rather than retrying.
    const url = await backend.uploadAsset(projectId, file);
    trace.action('mcp-bridge:upload-image', { name, bytes: bytes.length, projectId, url });
    return { url };
  },

  /** Design-token CRUD — the SAME mutations the editor's preset panels queue
   *  (mirror principle). globals.css is a PROTECTED_PATH for submit; this is
   *  the only writable surface for it. */
  async managePresets(params: {
    action: 'list' | 'set' | 'remove' | 'set_typography';
    tokens?: Array<{ name: string; value: string; category?: PresetToken['category']; label?: string; darkValue?: string }>;
    names?: string[];
    /** set_typography: preset slug, optional tag + per-suffix overrides. */
    name?: string;
    tag?: string;
    values?: Record<string, string>;
  }) {
    const { action } = params;
    if (action === 'list') {
      const tokens = getPresetTokens();
      trace.action('mcp-bridge:presets-list', { count: tokens.length });
      return { tokens };
    }

    if (isViewerMode()) throw new Error('This editor session is view-only — preset writes are disabled.');
    const existing = new Set(getPresetTokens().map((t) => t.name));

    if (action === 'set') {
      if (!params.tokens?.length) throw new Error('managePresets set: tokens[] required');
      const written: string[] = [];
      for (const t of params.tokens) {
        const name = t.name.replace(/^--/, '').trim();
        if (!/^[a-z][a-z0-9-]*$/.test(name)) {
          throw new Error(`Invalid token name "${t.name}" — kebab-case only (e.g. "color-brand-red"). Prefix with the category for clean grouping: color-/typo-/space-/radius-/shadow-/border-.`);
        }
        if (!t.value?.trim()) throw new Error(`Token "${name}" has an empty value.`);
        if (existing.has(name)) {
          queueMutation({ type: 'updatePresetToken', name, value: t.value.trim() });
        } else {
          queueMutation({
            type: 'addPresetToken',
            token: { name, value: t.value.trim(), category: t.category ?? 'other', label: t.label },
          });
        }
        if (t.darkValue?.trim()) {
          queueMutation({ type: 'setDarkTokenValue', tokenName: name, darkValue: t.darkValue.trim() });
        }
        written.push(name);
      }
      flushNow();
      refreshCanvasTokens();
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      trace.action('mcp-bridge:presets-set', { written });
      return { written, tokens: getPresetTokens() };
    }

    // Typography presets are COMPOUND — one preset = a full --typo-<slug>-*
    // family (base props + -md/-sm responsive tiers + unitless min-* breakpoint
    // thresholds + the -tag retag token). Hand-naming the family is the #1 way
    // to break the panel's suffix grouping (lesson 37), so this action builds
    // it from the builder's OWN generator and only accepts overrides keyed by
    // the canonical suffixes.
    if (action === 'set_typography') {
      const name = String(params.name ?? '').replace(/^--/, '').replace(/^typo-/, '').trim();
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(`set_typography requires a kebab-case preset name (e.g. "heading", "body-large") — got "${name}".`);
      }
      const overrides = params.values ?? {};
      const validSuffixes = new Set<string>(TYPO_SUFFIXES);
      for (const k of Object.keys(overrides)) {
        if (!validSuffixes.has(k)) {
          throw new Error(`Unknown typography suffix "${k}". Valid: ${TYPO_SUFFIXES.join(', ')}.`);
        }
      }
      const tag = String(params.tag ?? overrides.tag ?? 'p');
      const family = createDefaultTypoTokens(name, tag);
      // Responsive tiers are not in the default family — add any overridden ones.
      for (const [suffix, value] of Object.entries(overrides)) {
        const tokenName = `typo-${name}-${suffix}`;
        const existing = family.find((tok) => tok.name === tokenName);
        if (existing) existing.value = String(value);
        else family.push({ name: tokenName, value: String(value), category: 'typography' });
      }
      const current = new Set(getPresetTokens().map((tok) => tok.name));
      for (const tok of family) {
        if (current.has(tok.name)) queueMutation({ type: 'updatePresetToken', name: tok.name, value: tok.value });
        else queueMutation({ type: 'addPresetToken', token: tok });
      }
      flushNow();
      refreshCanvasTokens();
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      trace.action('mcp-bridge:typography-preset-set', { name, tokens: family.length });
      return {
        written: family.map((tok) => ({ name: tok.name, value: tok.value })),
        applyGuide: `Apply on a text element: inline style refs fontFamily: 'var(--typo-${name}-font)', fontWeight: 'var(--typo-${name}-weight)', color: 'var(--typo-${name}-color)', textTransform/textDecoration/textShadow likewise, fontSize: 'var(--typo-${name}-size)', letterSpacing: 'var(--typo-${name}-spacing)', lineHeight: 'var(--typo-${name}-line-height)'. Responsive tiers (only when -md/-sm tokens exist) go in the page's @media block: @media (max-width: ${'{min-default − 1}'}px) { [data-id="x"] { font-size: var(--typo-${name}-size-md); } } and the sm tier at (min-md − 1)px.`,
      };
    }

    if (action === 'remove') {
      if (!params.names?.length) throw new Error('managePresets remove: names[] required');
      const usage = scanPresetUsage(projectFS.getSnapshot());
      for (const raw of params.names) {
        const name = raw.replace(/^--/, '').trim();
        if (!existing.has(name)) throw new Error(`Token "${name}" does not exist.`);
        const used = usage.get(name);
        if (used?.length) {
          throw new Error(`Token "${name}" is still used by ${used.length} element(s) (e.g. ${used[0].filePath}). Rebind or remove those usages first — deleting an in-use token leaves dead var() references.`);
        }
      }
      for (const raw of params.names) {
        queueMutation({ type: 'removePresetToken', name: raw.replace(/^--/, '').trim() });
      }
      flushNow();
      refreshCanvasTokens();
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      trace.action('mcp-bridge:presets-removed', { names: params.names });
      return { removed: params.names, tokens: getPresetTokens() };
    }

    throw new Error(`managePresets: unknown action "${action}" — use list | set | remove.`);
  },

  /** Locale + text-translation management — the MCP face of the Localization
   *  view. Routes every write through the SAME pipeline the overlay's rows
   *  use (locale-ops addLocale, translation-ops commitTranslationText), so
   *  MCP translations land in the exact {t()}+messages format the live site
   *  reads. Text only — locale STYLES stay an in-editor affordance. */
  async manageTranslations(params: {
    op: 'get' | 'set_locales' | 'write_texts';
    /** set_locales: locales to add (existing codes are skipped). */
    locales?: Array<{ code: string; label: string }>;
    /** write_texts: the target locale. */
    locale?: string;
    /** write_texts: translated texts keyed by (filePath, nodeId). */
    items?: Array<{ filePath: string; nodeId: string; text: string }>;
  }) {
    const { op } = params;
    const config = getI18nConfig();

    if (op === 'get') {
      const texts = listTranslatableTexts(config.defaultLocale);
      const targets = config.locales.filter((l) => l.code !== config.defaultLocale).map((l) => l.code);
      trace.action('mcp-bridge:translations-get', { texts: texts.length, targets });
      return {
        config,
        texts: texts.map((t) => ({
          filePath: t.filePath, nodeId: t.nodeId, label: t.label, source: t.source,
          translations: Object.fromEntries(targets.map((code) =>
            [code, readTranslationText({ filePath: t.filePath, key: t.nodeId, locale: code }) ?? ''])),
        })),
      };
    }

    // Editor-state gates — same chokepoints as submitFiles: translation
    // writes transform page JSX ({t()} conversion) mid-flight.
    if (isViewerMode()) throw new Error('This editor session is view-only — translation writes are disabled.');
    const store = getDefaultStore();
    if (store.get(canvasInteractingAtom)) throw new Error('The editor is mid-interaction (drag/resize in progress). Retry in a moment.');
    if (store.get(isTextEditingAtom)) throw new Error('A text-editing session is active in the editor. Retry when it ends.');

    if (op === 'set_locales') {
      if (!params.locales?.length) throw new Error('manageTranslations set_locales: locales[] required');
      for (const l of params.locales) {
        if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(l.code)) {
          throw new Error(`Invalid locale code '${l.code}' — use ISO codes like 'fr', 'it', 'pt-BR'.`);
        }
        if (!l.label?.trim()) throw new Error(`Locale '${l.code}' needs a display label (e.g. 'French').`);
        addLocale(l.code, l.label.trim());
      }
      ensureIntlScaffold();
      const next = getI18nConfig();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      triggerAutosave({ force: true });
      await flushSaveNow();
      trace.action('mcp-bridge:translations-locales-set', { locales: next.locales.map((l) => l.code) });
      return { config: next };
    }

    if (op === 'write_texts') {
      const { locale, items } = params;
      if (!locale) throw new Error('manageTranslations write_texts: locale required');
      if (!items?.length) throw new Error('manageTranslations write_texts: items[] required');
      if (!config.locales.some((l) => l.code === locale)) {
        throw new Error(`Locale '${locale}' is not configured — add it first with op 'set_locales'.`);
      }
      if (locale === config.defaultLocale) {
        throw new Error(`'${locale}' is the default locale — write_texts writes TRANSLATIONS. Edit default copy on the canvas or via revyme_submit_files.`);
      }
      // Validate targets against the live enumeration (also supplies the
      // pre-transform seed text for first-time conversions).
      const known = new Map(listTranslatableTexts(config.defaultLocale).map((t) => [`${t.filePath}:${t.nodeId}`, t]));
      let written = 0;
      const unknown: string[] = [];
      for (const item of items) {
        const t = known.get(`${item.filePath}:${item.nodeId}`);
        if (!t) { unknown.push(`${item.filePath}:${item.nodeId}`); continue; }
        if (typeof item.text !== 'string' || !item.text.trim()) continue;
        commitTranslationText({
          filePath: item.filePath, nodeId: item.nodeId, locale,
          defaultLocale: config.defaultLocale, text: item.text,
          fallbackDefaultText: t.fallbackDefaultText,
        });
        written++;
      }
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      triggerAutosave({ force: true });
      await flushSaveNow();
      trace.action('mcp-bridge:translations-written', { locale, written, unknown: unknown.length });
      return {
        written,
        unknown,
        instruction: unknown.length > 0
          ? `${unknown.length} item(s) did not match any translatable text node — call op 'get' for the current (filePath, nodeId) list.`
          : undefined,
      };
    }

    throw new Error(`manageTranslations: unknown op — use get | set_locales | write_texts.`);
  },

  /** CMS collection + page management. Collection CRUD routes through the
   *  SAME executors the in-app CMS agent uses (cms-tool-executors → cms-ops);
   *  create_pages mirrors FileExplorer's addCmsPage (the builder scaffolds —
   *  guaranteed-parseable index/detail pages the model then restyles via
   *  normal submits). */
  async manageCms(params: { action: string; args?: Record<string, unknown> }) {
    const { action, args = {} } = params;
    const READ_ACTIONS = new Set(['list_collections', 'get_collection']);
    // CMS writes go straight to projectFS (createBlankCollection /
    // executeCmsTool → cms-ops.writeFile), BYPASSING the mutation queue — so
    // the queue's onAfterFlush → triggerAutosave never fires and the collection
    // lives only in memory until a reload wipes it (the "I created it but it's
    // gone" bug). Persist explicitly after any mutating CMS action. Debounced
    // + cloud-gated inside triggerAutosave, so it matches the rest of the app.
    // `force: true` bypasses the save-leader gate — a bridge write is an
    // authoritative local commit, not a collaboration peer's change, so it
    // must reach the backend even when this tab isn't the elected leader.
    const persistIfWrite = async () => {
      if (READ_ACTIONS.has(action)) return;
      triggerAutosave({ force: true });
      // Await the actual save — the 2s debounce loses the write if the tab
      // reloads inside the window (see submitFiles' persist note).
      await flushSaveNow();
    };
    const CMS_TOOL_ACTIONS = new Set([
      'list_collections', 'get_collection', 'create_collection', 'rename_collection',
      'delete_collection', 'add_field', 'update_field', 'remove_field',
      'add_item', 'update_item', 'remove_item', 'set_item_translation',
    ]);

    if (!READ_ACTIONS.has(action) && isViewerMode()) {
      throw new Error('This editor session is view-only — CMS writes are disabled.');
    }

    // create_collection bypasses the executor: its active-collection LOCK is a
    // UI-scoping rule for the in-overlay chat panel (cmsEditorCollectionAtom),
    // not a data rule — an MCP client is never scoped to the open panel. Same
    // validated op underneath (createBlankCollection).
    if (action === 'create_collection') {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('create_collection requires a non-empty name.');
      const slug = createBlankCollection(name);
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      await persistIfWrite();
      trace.action('mcp-bridge:cms-collection-created', { slug, name });
      return { success: true, slug, name };
    }

    if (CMS_TOOL_ACTIONS.has(action)) {
      // Errors come back as { error } in the response (the agent's
      // self-correction contract) — pass through so the model can fix its args.
      const result = executeCmsTool(action, args);
      if (!(result.response as any)?.error) await persistIfWrite();
      trace.action('mcp-bridge:cms-tool', { action, error: (result.response as any)?.error });
      return result.response;
    }

    if (action === 'create_pages') {
      const slug = String(args.collection ?? '');
      if (!listCollections().includes(slug)) {
        throw new Error(`Collection "${slug}" does not exist — create it first (create_collection).`);
      }
      const kind = String(args.kind ?? 'both');
      flushNow();
      const written: string[] = [];
      if (kind === 'index' || kind === 'both') written.push(createCmsIndexPageFile(slug));
      if (kind === 'detail' || kind === 'both') written.push(createCmsDetailPageFile(slug));
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      await persistIfWrite();
      trace.action('mcp-bridge:cms-pages-created', { slug, kind, written });
      return { written, note: 'Builder-scaffolded pages — read them and restyle via revyme_submit_files; keep the @cmsPage annotation and the data import/bindings intact.' };
    }

    // create_page — a PLAIN (non-CMS) route. submit_files can only edit an
    // EXISTING page (it remaps phantom paths to the active page / bounces
    // PHANTOM_PAGE_PATH), so a multi-page site needs the routes scaffolded
    // first. Mirrors FileExplorer's createPageFile (server wrapper +
    // page.client.tsx pair). Idempotent: returns the existing path untouched.
    if (action === 'create_page') {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('create_page requires a non-empty `name` (e.g. "Pricing").');
      // Optional TEMPLATE placement: put the page inside an existing route group so
      // it inherits that template's shared chrome (header/footer). Pass `group` = the
      // exact route-group dir from an existing page's path (e.g. "app/(Body)"), or
      // `template` = its friendly name ("Body" → "app/(Body)"). Omit both for a
      // plain top-level route. Validated against the real filesystem so a typo
      // bounces instead of silently scaffolding an orphan route.
      let groupDir: string | undefined;
      const grp = String(args.group ?? '').trim().replace(/\/+$/, '');
      const tpl = String(args.template ?? '').trim();
      if (grp) groupDir = grp;
      else if (tpl) groupDir = `app/(${tpl.replace(/^\(|\)$/g, '')})`;
      if (groupDir) {
        if (!/^app\/\([^)]+\)$/.test(groupDir) || projectFS.listFiles(groupDir + '/').length === 0) {
          throw new Error(`create_page: template group "${groupDir}" not found. Use a route-group dir from an existing page path (e.g. "app/(Body)"), or omit \`group\`/\`template\` for a plain route.`);
        }
      }
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      const baseDir = groupDir || 'app';
      const clientPath = `${baseDir}/${slug}/page.client.tsx`;
      if (projectFS.readFile(clientPath) != null) {
        creditRead(clientPath, projectFS.readFile(clientPath) ?? '');
        return { created: clientPath, existed: true, note: 'Page already exists — submit_files to this EXACT path to fill it.' };
      }
      flushNow();
      const path = createPageFile(name, groupDir);
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      await persistIfWrite();
      // Credit the scaffold so the immediate follow-up submit_files isn't bounced
      // as a blind/stale write (the stale-write guard keys off served reads).
      creditRead(path, projectFS.readFile(path) ?? '');
      trace.action('mcp-bridge:create-page', { name, path, groupDir: groupDir ?? null });
      return { created: path, note: `Empty route scaffolded (server wrapper + page.client.tsx)${groupDir ? ` under template ${groupDir}` : ''}. Now submit_files to this EXACT path to fill it.` };
    }

    // create_template — a Next.js TEMPLATE (route-group layout = shared chrome
    // such as a header + footer wrapped around every assigned page). A template
    // applies to a page only when the page lives INSIDE its route group folder
    // (layouts resolve by directory nesting), and submit_files can neither
    // create a layout file (a new LayoutClient path is phantom-remapped onto the
    // active page) nor move pages (it targets only existing page.client.tsx). So
    // the route group is scaffolded AND the pages are moved into it here, via
    // template-ops.applyTemplate (the same primitives the in-app template picker
    // uses). Route groups are URL-invisible, so the moved pages keep their
    // routes. The model then authors the returned LayoutClient (the shared
    // chrome around one {children}) and strips that chrome from the moved pages.
    if (action === 'create_template') {
      const name = String(args.name ?? '').trim();
      const allPages = listPageFiles();
      let pages: string[];
      const requested = args.pages;
      if (requested == null || requested === 'all') {
        pages = allPages;
      } else if (Array.isArray(requested)) {
        const known = new Set(allPages);
        pages = requested.map((p) => getPageClientPath(String(p))).filter((p) => known.has(p));
      } else {
        throw new Error('create_template `pages` must be "all" (default — every page) or an array of page.client.tsx paths from the project context.');
      }
      flushNow();
      const { layoutClient, moved } = applyTemplate(name, pages); // throws on an invalid name
      const store = getDefaultStore();
      store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
      await persistIfWrite();
      trace.action('mcp-bridge:create-template', { name, layoutClient, movedCount: moved.length });
      return {
        template: name,
        layoutClient,
        moved,
        note: `Template "(${name})" is ready and ${moved.length} page(s) were moved inside it — routes are UNCHANGED (route groups are URL-invisible). NEXT, in this order: (1) revyme_submit_files to "${layoutClient}" — the gate treats it as a TEMPLATE: build the shared chrome (header/footer/background) wrapped around EXACTLY ONE plain {children}, kept as a DIRECT child of the root (never wrap, duplicate, or conditionally render it). (2) Call revyme_get_context (the moved pages have NEW paths), then revyme_submit_files each moved page to REMOVE the header/footer you just centralised into the template.`,
      };
    }

    throw new Error(`manageCms: unknown action "${action}" — use list_collections | get_collection | create_collection | rename_collection | delete_collection | add_field | update_field | remove_field | add_item | update_item | remove_item | set_item_translation | create_pages | create_page | create_template.`);
  },

  async readFile({ path }: { path: string }) {
    const code = projectFS.readFile(path);
    trace.action('mcp-bridge:read-file', { path, found: code != null });
    if (code == null) throw new Error(`File not found: ${path}`);
    // Credit the fresh read so a subsequent submit to this path is allowed (and a
    // stale one — user edited it after this read — is bounced).
    creditRead(path, code);
    return { path, code };
  },

  /** The whole "New Component" modal as one call: run the Copy-URL share
   *  pipeline on a project file, then create/update the marketplace listing
   *  (metadata + pricing + media) via the creator API and optionally submit
   *  it for review. Runs in THIS editor session, so it publishes as whoever
   *  is signed in here — no separate auth. Idempotent: rerunning with the
   *  same name+kind UPDATES the existing listing (metadata applies
   *  instantly; a changed bundle on a LIVE listing is STAGED for re-review
   *  while the live version keeps serving). */
  async publishListing(params: {
    path: string;
    name: string;
    kind?: 'component' | 'vector';
    byline?: string;
    category?: string;
    tags?: string[];
    description?: string;
    pricingType?: 'free' | 'paid';
    priceCents?: number;
    closedSource?: boolean;
    previewUrl?: string;
    thumbnailUrl?: string;
    galleryUrls?: string[];
    publish?: boolean;
  }) {
    const { path, name } = params;
    if (!path || !name) throw new Error('publishListing: `path` and `name` are required.');
    const code = projectFS.readFile(path);
    if (code == null) throw new Error(`File not found: ${path}`);

    const listingKind = params.kind ?? (path.startsWith('icons/') ? 'vector' : 'component');
    if (listingKind !== 'component' && listingKind !== 'vector') {
      throw new Error('publishListing handles components and vectors. Templates and plugins use different share pipelines — publish those from the creator dashboard.');
    }
    // Share kind mirrors the Library panel's Copy URL routing: icon sets →
    // vector, @controls files → code (single-file source), else design
    // (multi-file bundle walked from the path).
    const shareKind: 'code' | 'design' | 'vector' = path.startsWith('icons/')
      ? 'vector'
      : hasComponentControls(code) ? 'code' : 'design';
    const componentName = (path.split('/').pop() || 'Component').replace(/\.tsx?$/, '');

    trace.action('mcp-bridge:publish-listing:share', { path, shareKind, listingKind });
    const share = await shareComponent(componentName, shareKind === 'code' ? code : path, shareKind);
    if (!share.success || !share.url) {
      const deps = share.missingDeps?.length ? ` Missing deps: ${share.missingDeps.join(', ')}.` : '';
      throw new Error(`Share (Copy URL) failed: ${share.error ?? 'unknown error'}.${deps}`);
    }
    const versionHash = share.version ?? (share.url.match(/@([a-f0-9]+)\.js/)?.[1] ?? '');
    if (!versionHash) throw new Error(`Share returned no version hash for ${share.url}`);

    // Whose account? Whoever this editor session is signed in as — the
    // creator API is cookie-authed, so a 401 means "sign in first".
    const listRes = await fetch(`/api/creator/components?kind=${listingKind}`);
    if (listRes.status === 401) {
      throw new Error('Not signed in — listings publish as the account logged into this editor session. Sign in, then retry.');
    }
    if (!listRes.ok) throw new Error(`Could not load your listings (HTTP ${listRes.status}).`);
    const rows = ((await listRes.json())?.components ?? []) as Array<{
      id: string; name: string; status: string; component_url: string;
      thumbnail_url: string | null; pending_status: string | null;
    }>;
    const existing = rows.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());

    const body: Record<string, unknown> = {
      kind: listingKind,
      name,
      component_url: share.url,
      version_hash: versionHash,
    };
    if (params.byline !== undefined) body.byline = params.byline;
    if (params.description !== undefined) body.description = params.description;
    if (params.category !== undefined) body.category = params.category;
    if (params.tags !== undefined) body.tags = params.tags.join(', ');
    if (params.pricingType !== undefined) body.pricing_type = params.pricingType;
    if (params.priceCents !== undefined) body.price_cents = params.priceCents;
    if (params.closedSource !== undefined) body.closed_source = params.closedSource;
    if (params.previewUrl !== undefined) body.preview_url = params.previewUrl;
    if (params.thumbnailUrl !== undefined) body.thumbnail_url = params.thumbnailUrl;
    if (params.galleryUrls !== undefined) body.gallery_urls = params.galleryUrls;

    // Create or update — same choice the dashboard sheet makes.
    const url = existing ? `/api/creator/components/${existing.id}` : '/api/creator/components';
    const method = existing ? 'PATCH' : 'POST';
    const saveRes = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const saved = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) {
      throw new Error(`Listing ${existing ? 'update' : 'create'} failed (HTTP ${saveRes.status}): ${saved?.error ?? saved?.message ?? 'unknown error'}`);
    }
    trace.action('mcp-bridge:publish-listing:saved', { id: saved.id, method, status: saved.status });

    const notes: string[] = [];
    const staged = saved.pending_status === 'pending';
    if (staged) {
      notes.push('This listing is LIVE — the new bundle was staged as a code update and re-enters admin review; the live version keeps serving until it is approved. Metadata changes applied instantly.');
    }

    // Publish (draft/rejected → pending review). The backend requires a
    // thumbnail to publish, so without one we stop at draft with a pointer.
    let finalRow = saved;
    const canPublish = saved.status === 'draft' || saved.status === 'rejected';
    const hasThumb = !!(params.thumbnailUrl ?? existing?.thumbnail_url ?? saved.thumbnail_url);
    if ((params.publish ?? true) && canPublish) {
      if (!hasThumb) {
        notes.push('Saved as DRAFT — a thumbnail is required to publish. Upload one via revyme_upload_asset and rerun with thumbnailUrl.');
      } else {
        const pubRes = await fetch(`/api/creator/components/${saved.id}/publish`, { method: 'POST' });
        const pub = await pubRes.json().catch(() => ({}));
        if (!pubRes.ok) {
          notes.push(`Saved, but publish failed (HTTP ${pubRes.status}): ${pub?.error ?? pub?.message ?? 'unknown error'}`);
        } else {
          finalRow = pub;
          notes.push('Submitted for review — approve it from the admin panel to go live.');
        }
      }
    }

    trace.action('mcp-bridge:publish-listing:done', { id: finalRow.id ?? saved.id, status: finalRow.status ?? saved.status, staged });
    return {
      listingId: finalRow.id ?? saved.id,
      status: finalRow.status ?? saved.status,
      pendingUpdate: staged,
      componentUrl: share.url,
      versionHash,
      action: existing ? 'updated' : 'created',
      notes,
    };
  },

  /** Insert a marketplace component / vector set into the ACTIVE page by
   *  its share URL — the exact pipeline pasting the URL on the canvas
   *  uses (URL import + sized instance at the current selection). The
   *  model can also compose the import + tag itself via submitFiles
   *  (the oracle allows assets.revyme.app bundle imports); this command
   *  is the quick one-shot drop. */
  async insertMarketplaceComponent(params: { url: string }) {
    const url = String(params?.url ?? '').trim();
    if (!url) throw new Error('insertMarketplaceComponent: `url` is required.');
    if (!isComponentUrl(url)) {
      throw new Error('Not a component/vector share URL — expected https://assets.revyme.app/components|vectors/<name>@<hash>.js (find free ones via the marketplace browse tool).');
    }
    if (isViewerMode()) {
      throw new Error('This editor session is view-only — inserting is disabled.');
    }
    const store = getDefaultStore();
    if (store.get(canvasInteractingAtom)) {
      throw new Error('The editor is mid-interaction (drag/resize in progress). Retry in a moment.');
    }
    if (store.get(isTextEditingAtom)) {
      throw new Error('A text-editing session is active in the editor. Retry when it ends.');
    }
    const ok = await importComponentFromUrl(url);
    if (!ok) throw new Error('Insert failed — the URL did not import (see the editor console).');
    triggerAutosave();
    const activeFile = store.get(activeFilePathAtom);
    trace.action('mcp-bridge:insert-marketplace', { url, activeFile });
    return {
      inserted: true,
      activeFile,
      note: url.includes('/vectors/')
        ? "Vector inserted with name=\"icon-1\" — read the active file and change the `name` prop to pick a different icon from the set."
        : 'Component instance inserted on the active page at the current selection.',
    };
  },

  /** Create a vector/icon set in the open project from raw SVG markup —
   *  the EXACT pipeline the canvas drop uses (`createVectorSetFromSvgs`:
   *  native editable-shape transpile with graphic fallback, grid layout,
   *  iconConfig). This is a BUILDER write path, same as dropping files, so
   *  it doesn't go through submitFiles' oracle (which correctly rejects
   *  `icons/` — that area is builder-owned). Returns the new file path for
   *  a follow-up `publishListing` call. */
  async createIconSet(params: { name: string; icons: Array<{ label?: string; text: string }> }) {
    const { name, icons } = params;
    if (!name || !name.trim()) throw new Error('createIconSet: `name` is required.');
    if (!Array.isArray(icons) || icons.length === 0) {
      throw new Error('createIconSet: `icons` must be a non-empty array of { label, text } SVG entries.');
    }
    if (isViewerMode()) {
      throw new Error('This editor session is view-only — creating icon sets is disabled.');
    }
    // Same guardrails as the drop preflight: content-sniff + per-file size
    // cap + per-set count cap (the PreflightSvg[] overload of
    // createVectorSetFromSvgs trusts its input, so enforce here).
    const skipped: string[] = [];
    const valid: PreflightSvg[] = [];
    for (const icon of icons) {
      const label = String(icon?.label || 'Icon');
      const text = typeof icon?.text === 'string' ? icon.text : '';
      if (!looksLikeSvg(text)) { skipped.push(`${label} (not SVG)`); continue; }
      if (text.length > MAX_SVG_FILE_BYTES) { skipped.push(`${label} (over 512KB)`); continue; }
      if (valid.length >= MAX_ICONS_PER_SET) { skipped.push(`${label} (over the ${MAX_ICONS_PER_SET}-icon limit)`); continue; }
      valid.push({ label, text });
    }
    if (valid.length === 0) throw new Error('createIconSet: none of the provided icons contain valid SVG markup.');
    const result = await createVectorSetFromSvgs(name.trim(), valid);
    if (!result) throw new Error('Icon set creation failed — see the editor console for details.');
    trace.action('mcp-bridge:create-icon-set', {
      name, path: result.iconSetFilePath, iconCount: result.iconCount, skipped: skipped.length,
    });
    triggerAutosave();
    return { ...result, skipped };
  },

  /** Dump the editor's debug-trace ring buffer to debug_output/ via the
   *  vite dev plugin — lets an MCP session capture what ACTUALLY happened
   *  right after the user reproduces a bug (drag flap, wrong commit, …)
   *  without touching the Debug toolbar. Dev-only, like the whole bridge. */
  async saveDebugTrace() {
    await trace.saveRecording();
    return { saved: true };
  },

  async submitFiles({ files }: { files: TurnFile[] }) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('submitFiles: empty batch');
    const store = getDefaultStore();
    // Editor-state gates: commits force a full re-render (setForceRender +
    // flushNow), which mid-gesture destroys the drag's DOM anchors and
    // mid-text-edit races the TipTap commit. Viewer sessions never write —
    // same chokepoint discipline as queueMutation's viewer early-return.
    if (isViewerMode()) {
      throw new Error('This editor session is view-only — submitting files is disabled.');
    }
    if (store.get(canvasInteractingAtom)) {
      throw new Error('The editor is mid-interaction (drag/resize in progress). Retry in a moment.');
    }
    if (store.get(isTextEditingAtom)) {
      throw new Error('A text-editing session is active in the editor. Retry when it ends.');
    }
    // STALE-WRITE guard (runs BEFORE the oracle): submit_files is a whole-file
    // replace, and the user edits the live file between MCP calls. Bounce any
    // existing target the client never read, or that changed since it last read —
    // otherwise a stale copy silently clobbers the user's manual edits. Re-read
    // fixes it. New files are exempt (nothing to overwrite).
    const stale = checkStaleWrites(files, (p) => projectFS.readFile(p));
    if (stale.length > 0) {
      trace.action('mcp-bridge:submit-stale', { count: stale.length });
      return {
        committed: false,
        violations: formatBounce(stale),
        instruction: `${stale.length} file(s) are stale or unread. Call revyme_read_file on each, reapply your change to the fresh text, then resubmit the complete file(s).`,
      };
    }

    const activeFilePath = store.get(activeFilePathAtom);
    // The remap safety net only applies when the user is ON a page — an MCP
    // client targeting a page from elsewhere must name an exact existing path.
    const activePagePath = isPageClientFile(activeFilePath) ? activeFilePath : null;
    const { files: gatedFiles, violations } = gateTurnFiles(files, activePagePath);

    if (violations.length > 0) {
      trace.action('mcp-bridge:submit-bounced', { count: violations.length, codes: violations.map((v) => v.code) });
      return {
        committed: false,
        violations: formatBounce(violations),
        instruction: `${violations.length} check(s) failed. Fix ALL of them and resubmit the complete corrected file(s).`,
      };
    }

    const written = commitTurnFiles(gatedFiles);
    // Re-credit each committed path from its LIVE post-commit content (the commit
    // may inject defaults, e.g. 'auto' dims), so a follow-up edit in the same
    // session isn't falsely flagged stale.
    for (const f of gatedFiles) creditRead(f.path, projectFS.readFile(f.path));
    // PERSIST BEFORE RETURNING. The normal flush autosave is 2s-DEBOUNCED —
    // a tab reload inside that window (vite HMR full-reload of a dev-served
    // editor, user F5) drops the pending save (the unload beacon silently
    // rejects large payloads) and the commit silently reverts on reload
    // (the "locale switcher reverted AGAIN" find, 2026-07-22). Awaiting the
    // unconditional save means committed:true = it is IN the backend.
    triggerAutosave({ force: true });
    await flushSaveNow();
    trace.action('mcp-bridge:submit-committed', { written });
    return { committed: true, written };
  },
};

let source: EventSource | null = null;

async function dispatch(raw: string): Promise<void> {
  let id: number | undefined;
  try {
    const msg = JSON.parse(raw) as { id: number; method: string; params?: unknown };
    id = msg.id;
    const handler = bridgeHandlers[msg.method];
    if (!handler) throw new Error(`Unknown bridge method: ${msg.method}`);
    trace.action('mcp-bridge:request', { id: msg.id, method: msg.method });
    const result = await handler(msg.params ?? {});
    await postResult({ id: msg.id, result });
  } catch (err) {
    trace.error('mcp-bridge:request-failed', err);
    if (id != null) await postResult({ id, error: String((err as Error).message ?? err) });
  }
}

async function postResult(body: { id: number; result?: unknown; error?: string }): Promise<void> {
  try {
    await fetch(`${AI_SERVICE_URL}/bridge/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    trace.error('mcp-bridge:post-result-failed', err);
  }
}

/** Connect the editor to the MCP bridge. Idempotent; EventSource auto-reconnects.
 *
 *  HMR-SAFE + PAGE-SINGLETON: a vite hot update re-evaluates this module and
 *  the OLD generation used to stay alive — its EventSource auto-reconnected
 *  forever (the 3s bridge ping-pong in the server log), sometimes WON the
 *  bridge with stale handlers ("Unknown bridge method"), and its closures
 *  held a STALE projectFS whose autosaves resurrected old files (the
 *  repeatedly-reverting LocaleSwitcher, 2026-07-22). The window-level slot
 *  guarantees at most ONE live bridge connection per page across module
 *  generations, and the hot.dispose hook closes ours before a new
 *  generation connects. */
const BRIDGE_WINDOW_KEY = '__revymeMcpBridgeSource';
export function startMcpBridge(): void {
  if (source) return;
  const prev = (window as any)[BRIDGE_WINDOW_KEY] as EventSource | undefined;
  if (prev) {
    try { prev.close(); } catch { /* already dead */ }
    trace.action('mcp-bridge:closed-stale-generation', {});
  }
  trace.action('mcp-bridge:start', { url: AI_SERVICE_URL });
  // Key the connection by project so the multi-tenant bridge routes MCP
  // calls ONLY to this tab's project (production model; 'local' = dev key).
  const bridgeProjectId = getProjectId();
  const bridgeQs = bridgeProjectId && bridgeProjectId !== 'local' ? `?websiteId=${encodeURIComponent(bridgeProjectId)}` : '';
  // withCredentials: the production bridge verifies the tab's session cookie
  // (REVYME_BRIDGE_AUTH) — cookies must flow even if the bridge origin differs.
  source = new EventSource(`${AI_SERVICE_URL}/bridge/events${bridgeQs}`, { withCredentials: true });
  (window as any)[BRIDGE_WINDOW_KEY] = source;
  source.onopen = () => trace.action('mcp-bridge:connected', {});
  source.onmessage = (e) => { void dispatch(e.data); };
  source.onerror = () => trace.action('mcp-bridge:disconnected-retrying', {});
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try { source?.close(); } catch { /* noop */ }
    source = null;
    trace.action('mcp-bridge:hmr-disposed', {});
  });
}

/** Tear down (tests / HMR). */
export function stopMcpBridge(): void {
  if (!source) return;
  source.close();
  source = null;
  trace.action('mcp-bridge:stopped', {});
}
