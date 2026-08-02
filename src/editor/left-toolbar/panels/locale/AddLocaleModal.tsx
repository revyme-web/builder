// AddLocaleModal.tsx — Two-column modal for adding a new locale.
// Left column: searchable language list. Right column: preview + config form.
// Matches the old builder's Add Language modal design.

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { addLocale } from '@/code/project/locale-ops';
import { projectVersionAtom } from '@/code/project/project-fs';
import Modal from '@/design-system/Modal';
import languages from './languages.json';
import type { LocaleConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { FlagIcon, emojiFlagToCC } from '@/shared/flag-icon';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LanguageEntry {
  code: string;
  name: string;
  endonym: string;
  flag: string;
}

interface AddLocaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Locale codes already in the project (to filter them out). */
  existingCodes: string[];
  /** Existing locale configs (for fallback dropdown). */
  existingLocales: LocaleConfig[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AddLocaleModal({ isOpen, onClose, existingCodes, existingLocales }: AddLocaleModalProps) {
  const bumpVersion = useSetAtom(projectVersionAtom);

  // UI state
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LanguageEntry | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [fallback, setFallback] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  trace.fn('AddLocaleModal.render', { isOpen, search, selected: selected?.code ?? null });

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelected(null);
      setName('');
      setSlug('');
      setFallback('');
      // Auto-focus search after mount
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [isOpen]);

  // ─── Filtered language list ────────────────────────────────────────────────

  const filteredLanguages = useMemo(() => {
    const existing = new Set(existingCodes.map(c => c.toLowerCase()));
    const q = search.toLowerCase().trim();
    return (languages as LanguageEntry[]).filter(lang => {
      // Exclude already-added locales
      if (existing.has(lang.code.toLowerCase())) return false;
      // Match against name, code, or endonym
      if (!q) return true;
      return (
        lang.name.toLowerCase().includes(q) ||
        lang.code.toLowerCase().includes(q) ||
        lang.endonym.toLowerCase().includes(q)
      );
    });
  }, [search, existingCodes]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleSelectLanguage = useCallback((lang: LanguageEntry) => {
    trace.action('add-locale-modal:select-language', { code: lang.code, name: lang.name });
    setSelected(lang);
    setName(lang.name);
    setSlug(lang.code.toLowerCase());
    setFallback('');
  }, []);

  const handleSlugChange = useCallback((value: string) => {
    // Force lowercase, strip spaces
    setSlug(value.toLowerCase().replace(/\s+/g, '-'));
  }, []);

  const handleAdd = useCallback(() => {
    const trimSlug = slug.trim();
    const trimName = name.trim();
    if (!trimSlug || !trimName) return;

    trace.action('add-locale-modal:add-locale', { code: trimSlug, label: trimName, fallback: fallback || undefined });
    addLocale(trimSlug, trimName, undefined, fallback || undefined);
    bumpVersion(v => v + 1);
    onClose();
  }, [slug, name, fallback, bumpVersion, onClose]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Language" width={700}>
      <div className="flex h-[500px]">
        {/* ── Left Column: Language Search + List ────────────────────────── */}
        <div className="w-80 flex flex-col border-r border-[var(--border-light)]">
          {/* Search input */}
          <div className="p-3 border-b border-[var(--border-light)]">
            <div className="relative">
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-disabled)]"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search languages..."
                className="w-full h-[var(--control-height)] pl-8 pr-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* Language list */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            {filteredLanguages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs text-[var(--text-disabled)]">No matching languages</span>
              </div>
            ) : (
              filteredLanguages.map(lang => {
                const isSelected = selected?.code === lang.code;
                return (
                  <button
                    key={lang.code}
                    onClick={() => handleSelectLanguage(lang)}
                    className={`flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--accent)]/10'
                        : 'hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <FlagIcon code={emojiFlagToCC(lang.flag)} className="text-base" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium text-[var(--text-primary)] truncate">{lang.name}</span>
                      <span className="text-[10px] text-[var(--text-disabled)] truncate">{lang.endonym}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right Column: Config Form ──────────────────────────────────── */}
        <div className="flex-1 flex flex-col">
          {!selected ? (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-[var(--text-disabled)]">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <span className="text-xs">Select a language</span>
              </div>
            </div>
          ) : (
            <>
              {/* Form content */}
              <div className="flex-1 p-5 flex flex-col gap-4 overflow-y-auto scrollbar-hide">
                {/* Preview card */}
                <div className="flex items-center gap-3 p-3 bg-[var(--grid-line)] rounded-lg border border-[var(--border-light)]">
                  <FlagIcon code={emojiFlagToCC(selected.flag)} className="text-2xl" />
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{selected.name}</span>
                    <span className="text-xs text-[var(--text-disabled)]">{selected.endonym}</span>
                  </div>
                </div>

                {/* Name input */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)] focus:outline-none transition-colors"
                  />
                </div>

                {/* Slug input */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    Slug
                  </label>
                  <input
                    type="text"
                    value={slug}
                    onChange={e => handleSlugChange(e.target.value)}
                    className="w-full h-[var(--control-height)] px-3 text-xs font-mono bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)] focus:outline-none transition-colors"
                  />
                  <span className="text-[10px] text-[var(--text-disabled)]">
                    Used in URLs and file names
                  </span>
                </div>

                {/* Fallback locale dropdown (only if other locales exist) */}
                {existingLocales.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                      Fallback Locale
                    </label>
                    <select
                      value={fallback}
                      onChange={e => setFallback(e.target.value)}
                      className="w-full h-[var(--control-height)] px-2 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none transition-colors cursor-pointer"
                    >
                      <option value="">None</option>
                      {existingLocales.map(l => (
                        <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-[var(--text-disabled)]">
                      Missing translations will fall back to this locale
                    </span>
                  </div>
                )}
              </div>

              {/* Bottom action buttons */}
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-light)]">
                <button
                  onClick={onClose}
                  className="h-[var(--control-height)] px-4 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] text-[var(--text-primary)] rounded-[var(--radius-md)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!slug.trim() || !name.trim()}
                  className="h-8 px-4 text-xs bg-[var(--accent)] text-[var(--accent-fg)] rounded-[var(--radius-md)] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-medium"
                >
                  Add Language
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
