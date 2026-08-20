// TranslationsOverlay.tsx — the LOCALIZATION VIEW (rewritten during the
// localization overhaul). Full-workspace overlay matching the CMS editor
// overlay's geometry (header top/left:308/h:52 + body below), NOT a centered
// modal. One scroll pane of accordion sections:
//   · every PAGE (its translatable text nodes)
//   · every DESIGN COMPONENT
//   · every CMS COLLECTION (items' text-type fields)
// Rows are source→target: left = default-locale text (muted, read-only),
// right = the target locale's translation (commits on blur through the
// messages/{t()} pipeline — the same storage the live site reads).
// Target locale == activeLocaleAtom, so clicking a language in the
// Localization panel switches the whole view live. `?localization=<code>`
// is mirrored into the URL while open.

import { useState, useCallback, useMemo, useEffect, useRef, type JSX } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { i18nConfigAtom, activeLocaleAtom } from '@/code/stores/locale-store';
import { translationsOverlayOpenAtom } from '@/code/stores/left-panel-store';
import { commitTranslationText, readTranslationText, listTranslatableTexts } from '@/code/project/translation-ops';
import { getCollectionItemTranslation, setCollectionItemTranslation } from '@/code/project/cms-ops';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getFileDisplayName, getPageSlug } from '@/code/project/active-file-store';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import { estimateTranslate, runAiTranslate, type TranslateItem } from '@/ai/translate-client';
import { getCreditsState, refreshCredits, openWorkspaceCreditsPage } from '@/code/stores/credits-store';
import Breadcrumb from '@/design-system/Breadcrumb';
import { PageHomeIcon, PageDocumentIcon } from '@/shared/icons';
import { DesignComponentIcon } from '@/editor/left-toolbar/panels/LibraryPanel/items/ComponentRow';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Row {
  key: string;                    // unique row key
  label: string;                  // small label above the source text
  source: string;                 // default-locale text
  read: (locale: string) => string;   // stored target translation ('' = none)
  write: (locale: string, text: string) => void;
}

interface Section {
  id: string;
  kind: 'page' | 'component' | 'cms';
  label: string;
  rows: Row[];
}

const SECTION_ICONS: Record<Section['kind'], JSX.Element> = {
  page: <PageDocumentIcon size={13} />,
  // The SAME purple diamond icon the Library panel's Components section uses
  // (SidebarRow's accent-secondary default) — one component identity everywhere.
  component: <span style={{ color: 'var(--accent-secondary, #a78bfa)', display: 'inline-flex' }}><DesignComponentIcon /></span>,
  cms: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>,
};

// ─── URL sync (mirrors syncUrlToCms's replaceState convention) ──────────────

function syncUrlToLocalization(target: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (target) url.searchParams.set('localization', target);
    else url.searchParams.delete('localization');
    window.history.replaceState({}, '', url.toString());
  } catch { /* ignore */ }
}

// ─── The overlay ────────────────────────────────────────────────────────────

export default function TranslationsOverlay() {
  const [isOpen, setOpen] = useAtom(translationsOverlayOpenAtom);
  const config = useAtomValue(i18nConfigAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  const projectVersion = useAtomValue(projectVersionAtom);
  const bumpProjectVersion = useSetAtom(projectVersionAtom);
  const schemas = useAtomValue(collectionSchemasAtom);
  const cmsData = useAtomValue(collectionDataAtom);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Bump to re-read stored translations after a row commit.
  const [savedTick, setSavedTick] = useState(0);
  // AI Translate flow: idle → estimating → confirm (quote shown) → running.
  const [aiState, setAiState] = useState<
    | { step: 'idle' }
    | { step: 'estimating' }
    | { step: 'confirm'; credits: number; itemCount: number }
    | { step: 'running'; itemCount: number }
    | { step: 'error'; message: string; outOfCredits?: boolean }
  >({ step: 'idle' });

  const defaultLocale = config?.defaultLocale ?? 'en';
  const targets = (config?.locales ?? []).filter(l => l.code !== defaultLocale);
  // Target = the active locale when non-default, else the first target.
  const target = activeLocale !== defaultLocale ? activeLocale : (targets[0]?.code ?? null);
  const defaultLabel = config?.locales.find(l => l.code === defaultLocale)?.label ?? defaultLocale;
  const targetLabel = targets.find(l => l.code === target)?.label ?? target ?? '';

  // URL mirror while open.
  useEffect(() => {
    if (isOpen && target) syncUrlToLocalization(target);
    return () => { if (isOpen) syncUrlToLocalization(null); };
  }, [isOpen, target]);

  // ── Build sections: pages + components + CMS collections ────────────────
  const sections = useMemo<Section[]>(() => {
    if (!isOpen) return [];
    const out: Section[] = [];
    // Shared enumeration (also used by the MCP translations bridge) — group
    // the flat entry list back into per-file sections.
    const byFile = new Map<string, { kind: Section['kind']; rows: Row[] }>();
    for (const t of listTranslatableTexts(defaultLocale)) {
      const { filePath, nodeId } = t;
      let bucket = byFile.get(filePath);
      if (!bucket) { bucket = { kind: t.kind, rows: [] }; byFile.set(filePath, bucket); }
      bucket.rows.push({
        key: `${filePath}:${nodeId}`,
        label: t.label,
        source: t.source,
        read: (loc) => readTranslationText({ filePath, key: nodeId, locale: loc }) ?? '',
        write: (loc, text) => commitTranslationText({
          filePath, nodeId, locale: loc, defaultLocale, text,
          fallbackDefaultText: t.fallbackDefaultText,
        }),
      });
    }
    for (const [filePath, { kind, rows }] of byFile) {
      out.push({
        id: filePath,
        kind,
        label: kind === 'page'
          ? (() => { const slug = getPageSlug(filePath); return (!slug || slug === '/') ? 'Home' : slug; })()
          : getFileDisplayName(filePath),
        rows,
      });
    }
    // CMS collections — items' text-type field values.
    for (const [slug, schema] of schemas) {
      const textFields = (schema?.fields ?? []).filter((f: { type: string }) =>
        f.type === 'text' || f.type === 'textarea' || f.type === 'richtext');
      const items = (cmsData.get(slug) ?? []) as unknown as Array<Record<string, unknown> & { _id: string }>;
      if (textFields.length === 0 || items.length === 0) continue;
      const rows: Row[] = [];
      for (const item of items) {
        for (const field of textFields) {
          const source = String(item[field.id] ?? '');
          if (!source.trim()) continue;
          rows.push({
            key: `cms:${slug}:${item._id}:${field.id}`,
            label: `${String(item.title ?? item._id)} · ${field.name}`,
            source,
            // Translations live ON the row (`_i18n`) — the same place
            // `localizeRows` reads them at runtime, so what you type here is
            // literally what the published site resolves.
            read: (loc) => getCollectionItemTranslation(slug, item._id, loc, field.id),
            write: (loc, text) => {
              setCollectionItemTranslation(slug, item._id, loc, field.id, text);
              // `cms/<slug>.json` changed — bump so the canvas re-derives
              // `localizedCollectionDataAtom` and the row updates live.
              bumpProjectVersion((v: number) => v + 1);
            },
          });
        }
      }
      if (rows.length > 0) {
        out.push({ id: `cms:${slug}`, kind: 'cms', label: schema?.name ?? slug, rows });
      }
    }
    trace.fn('LocalizationOverlay:sections', { count: out.length, projectVersion });
    return out;
  }, [isOpen, schemas, cmsData, defaultLocale, projectVersion]);

  const filtered = useMemo(() => {
    if (!search.trim()) return sections;
    const q = search.toLowerCase();
    return sections
      .map(s => ({ ...s, rows: s.rows.filter(r => r.source.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)) }))
      .filter(s => s.rows.length > 0);
  }, [sections, search]);

  /** Rows still missing a translation for the current target. */
  const pendingRows = useMemo(() => {
    void savedTick;
    if (!target) return [] as { row: Row; item: TranslateItem }[];
    const out: { row: Row; item: TranslateItem }[] = [];
    for (const s of sections) {
      for (const row of s.rows) {
        if (!row.source.trim()) continue;
        if (row.read(target)) continue;
        out.push({ row, item: { key: row.key, text: row.source } });
      }
    }
    return out;
  }, [sections, target, savedTick]);

  const handleAiEstimate = useCallback(async () => {
    if (pendingRows.length === 0 || !target) return;
    setAiState({ step: 'estimating' });
    trace.action('LocalizationOverlay:ai-estimate', { pending: pendingRows.length, target });
    const est = await estimateTranslate(pendingRows.map(p => p.item));
    if (!est) { setAiState({ step: 'error', message: 'Could not reach the AI service.' }); return; }
    setAiState({ step: 'confirm', credits: est.credits, itemCount: pendingRows.length });
  }, [pendingRows, target]);

  const handleAiRun = useCallback(async () => {
    if (!target) return;
    const batch = pendingRows;
    setAiState({ step: 'running', itemCount: batch.length });
    trace.action('LocalizationOverlay:ai-run', { items: batch.length, target });
    const result = await runAiTranslate({
      items: batch.map(p => p.item),
      sourceLocale: defaultLabel,
      targetLocale: targetLabel || target,
      workspaceId: getCreditsState()?.workspaceId,
    });
    if (!result.success) {
      setAiState({ step: 'error', message: result.error, outOfCredits: result.outOfCredits });
      return;
    }
    let written = 0;
    for (const { row } of batch) {
      const text = result.translations[row.key];
      if (typeof text === 'string' && text.trim()) { row.write(target, text); written++; }
    }
    trace.action('LocalizationOverlay:ai-written', { written });
    setSavedTick(t => t + 1);
    setAiState({ step: 'idle' });
    window.setTimeout(() => { void refreshCredits(); }, 1200);
  }, [pendingRows, target, defaultLabel, targetLabel]);

  const handleClose = useCallback(() => {
    setOpen(false);
    syncUrlToLocalization(null);
    trace.action('LocalizationOverlay:close');
  }, [setOpen]);

  // Escape closes.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;
  if (!target) {
    return createPortal(
      <div className="fixed z-[9000] bg-[var(--bg-panel)] flex items-center justify-center text-xs text-[var(--text-disabled)]" style={{ top: 52, left: 308, right: 0, bottom: 0 }}>
        Add a second language in the Localization panel first.
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div data-localization-overlay data-app-undo>
      {/* Header bar — CMS-overlay geometry */}
      <div
        className="fixed z-[10000] border-b border-[var(--border-light)] bg-[var(--bg-surface)] flex items-center gap-3 px-4"
        style={{ top: 0, left: 308, right: 260, height: 52 }}
      >
        <Breadcrumb segments={[
          {
            label: 'Back',
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>,
            onClick: handleClose,
          },
          { label: 'Localization', color: 'var(--accent-text)' },
        ]} />
        {/* Target-locale picking lives in the LEFT PANEL (activeLocaleAtom) —
            a header duplicate was just noise (removed 2026-07-23). Breadcrumb
            left, AI Translate + search right-aligned against the header's
            right edge, which stops at the app RightHeader (Settings/Publish
            stay visible — CMS-editor geometry). No × (Back / panel switch
            closes). */}
        <div className="flex-1" />
        {/* AI Translate — quote-then-confirm; billed like every Vibe call. */}
        <div className="relative">
          <button
            onClick={() => {
              if (aiState.step === 'confirm' || aiState.step === 'error') setAiState({ step: 'idle' });
              else void handleAiEstimate();
            }}
            disabled={aiState.step === 'estimating' || aiState.step === 'running' || pendingRows.length === 0}
            data-ai-translate
            className="flex items-center gap-1.5 px-3 h-8 cut-corners text-xs font-medium bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-40 cursor-pointer disabled:cursor-default transition-opacity"
            title={pendingRows.length === 0 ? 'Everything is translated' : `Translate ${pendingRows.length} missing strings with AI`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
            {aiState.step === 'estimating' ? 'Estimating…'
              : aiState.step === 'running' ? `Translating ${aiState.itemCount}…`
              : 'AI Translate'}
          </button>
          {(aiState.step === 'confirm' || aiState.step === 'error') && (
            <div
              data-ai-translate-confirm
              className="absolute right-0 top-10 z-[10001] w-[240px] p-3 cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] bg-[var(--bg-surface)] border border-[var(--border-light)] shadow-2xl flex flex-col gap-2.5"
            >
              {aiState.step === 'confirm' ? (
                <>
                  <div className="text-xs text-[var(--text-primary)] font-medium">
                    Translate {aiState.itemCount} strings to {targetLabel}
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    Estimated cost: <span className="text-[var(--text-primary)] font-semibold">~{aiState.credits} credits</span>
                    {getCreditsState()?.balance != null && (
                      <> · balance {getCreditsState()!.balance}</>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setAiState({ step: 'idle' })} className="flex-1 h-7 cut-corners text-xs bg-[var(--bg-hover)] text-[var(--text-primary)] cursor-pointer">Cancel</button>
                    <button onClick={() => void handleAiRun()} data-ai-translate-run className="flex-1 h-7 cut-corners text-xs bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer">Translate</button>
                  </div>
                </>
              ) : aiState.outOfCredits ? (
                <>
                  <div className="text-xs text-[var(--text-primary)] font-medium">Out of credits</div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    Top up your workspace credits to keep using AI.
                  </div>
                  <button
                    onClick={() => { openWorkspaceCreditsPage(); setAiState({ step: 'idle' }); }}
                    data-ai-translate-topup
                    className="w-full h-7 cut-corners text-xs font-medium bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 cursor-pointer transition-opacity"
                  >
                    Top Up
                  </button>
                </>
              ) : (
                <div className="text-[11px] text-[var(--text-danger,#ff6b6b)]">{aiState.message}</div>
              )}
            </div>
          )}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search text…"
          className="w-[220px] h-[var(--control-height)] px-2.5 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none transition-colors"
        />
      </div>

      {/* Body — column headers + accordion scroll pane */}
      <div className="fixed z-[9000] bg-[var(--bg-panel)] flex flex-col" style={{ top: 52, left: 308, right: 0, bottom: 0 }}>
        <div className="grid grid-cols-2 gap-6 px-6 py-2.5 border-b border-[var(--border-light)] shrink-0">
          <span className="text-xs text-[var(--text-disabled)]">{defaultLabel}</span>
          <span className="text-xs text-[var(--text-disabled)]">{targetLabel}</span>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-40 text-xs text-[var(--text-disabled)]">
              No translatable text found.
            </div>
          )}
          {filtered.map(section => (
            <SectionBlock
              key={section.id}
              section={section}
              collapsed={collapsed.has(section.id)}
              onToggle={() => setCollapsed(prev => {
                const next = new Set(prev);
                if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                return next;
              })}
              target={target}
              savedTick={savedTick}
              onSaved={() => setSavedTick(t => t + 1)}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Section + rows ─────────────────────────────────────────────────────────

function SectionBlock({ section, collapsed, onToggle, target, savedTick, onSaved }: {
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
  target: string;
  savedTick: number;
  onSaved: () => void;
}) {
  return (
    <div data-localization-section={section.id}>
      <button
        onClick={onToggle}
        className="sticky top-0 z-10 flex items-center gap-2.5 w-full px-6 py-2.5 [background:linear-gradient(var(--bg-hover),var(--bg-hover)),var(--bg-panel)] border-y border-[var(--border-light)] transition-colors cursor-pointer text-left focus:outline-none"
      >
        <span className={`text-[var(--text-secondary)] transition-transform ${collapsed ? '' : 'rotate-90'}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </span>
        <span className="text-[var(--text-secondary)]">
          {section.kind === 'page' && (section.label === '/' || section.label === 'Home')
            ? <PageHomeIcon size={13} />
            : SECTION_ICONS[section.kind]}
        </span>
        <span className="text-xs font-semibold text-[var(--text-primary)] truncate flex-1">{section.label}</span>
        <span className="text-[10px] text-[var(--text-disabled)]">{section.rows.length}</span>
      </button>
      {!collapsed && section.rows.map(row => (
        <TranslationRow key={`${row.key}:${target}:${savedTick}`} row={row} target={target} onSaved={onSaved} />
      ))}
    </div>
  );
}

function TranslationRow({ row, target, onSaved }: { row: Row; target: string; onSaved: () => void }) {
  const stored = row.read(target);
  const [value, setValue] = useState(stored);
  // Adopt the stored value when it changes UNDER the draft — undo/redo and AI
  // Translate both rewrite messages while this row stays mounted, and without
  // this the textarea kept showing the text that was just undone.
  //
  // Render-phase, keyed on the last value we adopted rather than on an effect:
  // an effect keyed to `[stored]` re-runs on the row's OWN commit too, and
  // clobbers the draft with a value that is briefly stale — the value-sync
  // trap this codebase has hit before. Comparing against what we last adopted
  // makes a self-commit a no-op (the draft already equals the new stored).
  const adoptedRef = useRef(stored);
  if (stored !== adoptedRef.current) {
    adoptedRef.current = stored;
    setValue(stored);
  }
  const commit = () => {
    if (value === stored) return;
    trace.action('LocalizationOverlay:commit', { key: row.key, target, text: value.slice(0, 40) });
    row.write(target, value);
    onSaved();
  };
  return (
    <div className="grid grid-cols-2 gap-6 px-6 py-3 border-b border-[var(--border-light)] items-start" data-localization-row={row.key}>
      <div className="min-w-0">
        <div className="text-[10px] text-[var(--text-disabled)] mb-1">{row.label}</div>
        <div className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">{row.source}</div>
      </div>
      <div className="min-w-0">
        <textarea
          value={value}
          placeholder={row.source}
          rows={Math.max(1, Math.ceil((value || row.source).length / 60))}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); (e.target as HTMLTextAreaElement).blur(); }
            // Everything else is stopped so canvas shortcuts can't fire while
            // typing — EXCEPT undo/redo, which must reach the window listener
            // (React's stopPropagation calls through to the native event, so
            // stopping here severed Cmd+Z entirely). KeyboardManager lets it
            // past its text-field guard via this overlay's `data-app-undo`.
            if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) return;
            e.stopPropagation();
          }}
          className="w-full px-2.5 py-2 text-sm bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none transition-colors resize-none leading-relaxed"
        />
      </div>
    </div>
  );
}
