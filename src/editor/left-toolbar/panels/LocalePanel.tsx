// LocalePanel.tsx — Localization panel matching the old builder's locale management design.
// Header with title + add button, "Manage Translations" button, language list with
// ellipsis menu (set default / delete), delete confirmation via ConfirmDialog.

import { useState, useCallback, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { i18nConfigAtom, activeLocaleAtom } from '@/code/stores/locale-store';
import { removeLocale, saveI18nConfig, getI18nConfig } from '@/code/project/locale-ops';
import { projectVersionAtom } from '@/code/project/project-fs';
import AddLocaleModal from './locale/AddLocaleModal';
import type { LocaleConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { leftPanelAtom, translationsOverlayOpenAtom } from '@/code/stores/left-panel-store';
import SectionLabel from '@/design-system/SectionLabel';
import AddButton from '@/design-system/AddButton';
import SidebarRow from '@/design-system/SidebarRow';
import ConfirmDialog from '@/design-system/ConfirmDialog';
import SearchBar from '@/design-system/SearchBar';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { FlagIcon, localeToCC } from '@/shared/flag-icon';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useLocaleRefresh() {
  const bumpVersion = useSetAtom(projectVersionAtom);
  return useCallback(() => {
    bumpVersion(v => v + 1);
    trace.action('locale-panel:refresh');
  }, [bumpVersion]);
}

function sortLocales(locales: LocaleConfig[], defaultCode: string): LocaleConfig[] {
  return [...locales].sort((a, b) => {
    if (a.code === defaultCode) return -1;
    if (b.code === defaultCode) return 1;
    return a.label.localeCompare(b.label);
  });
}


// ─── Main Panel ──────────────────────────────────────────────────────────────

export default function LocalePanel() {
  const config = useAtomValue(i18nConfigAtom);
  const [activeLocale, setActiveLocale] = useAtom(activeLocaleAtom);
  const setTranslationsOpen = useSetAtom(translationsOverlayOpenAtom);
  const refresh = useLocaleRefresh();

  const [showAddModal, setShowAddModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocaleConfig | null>(null);
  // Top-of-panel search query — matches the SearchBar + divider chrome
  // the Library / CMS / Pages / Layers panels use. Filters the language
  // list below by label OR locale code (case-insensitive) so "fr",
  // "French", and "français" all find the same row.
  const [searchQuery, setSearchQuery] = useState('');

  trace.fn('LocalePanel.render', {
    localeCount: config.locales.length,
    defaultLocale: config.defaultLocale,
    searchQuery,
  });

  const sortedLocales = useMemo(
    () => sortLocales(config.locales, config.defaultLocale),
    [config.locales, config.defaultLocale],
  );

  // Apply search filter AFTER sort so the default row keeps its top
  // position when it matches the query. Empty query is a no-op (returns
  // the sorted list untouched).
  const q = searchQuery.trim().toLowerCase();
  const filteredLocales = useMemo(() => {
    if (!q) return sortedLocales;
    return sortedLocales.filter(l =>
      l.label.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
    );
  }, [sortedLocales, q]);

  const hasMultipleLocales = config.locales.length >= 2;
  const hasAnyLocales = config.locales.length > 0;

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleSetDefault = useCallback((code: string) => {
    trace.action('locale-panel:set-default', { code });
    const cfg = getI18nConfig();
    cfg.defaultLocale = code;
    saveI18nConfig(cfg);
    setActiveLocale(code);
    refresh();
  }, [refresh, setActiveLocale]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    trace.action('locale-panel:delete-confirm', { code: deleteTarget.code });
    removeLocale(deleteTarget.code);
    refresh();
    setDeleteTarget(null);
  }, [deleteTarget, refresh]);

  const handleManageTranslations = useCallback(() => {
    trace.action('locale-panel:open-translations-overlay');
    setTranslationsOpen(true);
  }, [setTranslationsOpen]);

  const handleAddLocaleClose = useCallback(() => {
    setShowAddModal(false);
    refresh();
  }, [refresh]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Top-of-panel search — matches Library / CMS chrome (SearchBar +
          thin divider) for consistent header pattern across left-toolbar
          panels. Spacing math is identical: pt-3 / pb-1.5 / mt-1.5 / mb-0
          so the divider docks directly against the SectionLabel below. */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <SearchBar
          value={searchQuery}
          onChange={(v) => {
            trace.action('locale-panel:search', { query: v });
            setSearchQuery(v);
          }}
          placeholder="Search languages…"
        />
      </div>
      <div data-tool-divider className="h-px bg-[var(--border-light)] mx-3 mt-1.5 mb-0" />

      <SectionLabel size="md" right={
        <AddButton onClick={() => { setShowAddModal(true); trace.action('locale-panel:open-add-modal'); }} title="Add language" />
      }>Localization</SectionLabel>

      {/* Manage Translations Button (2+ locales) */}
      {hasMultipleLocales && (
        <div className="px-3 mb-1.5">
          <button
            onClick={handleManageTranslations}
            className="w-full h-7 bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium cut-corners hover:opacity-90 transition-opacity cursor-pointer"
          >
            Manage Translations
          </button>
        </div>
      )}

      {/* Language List */}
      <div className="flex-1 overflow-y-auto px-2">
        {filteredLocales.length === 0 ? (
          // Two empty-states, same shape as CmsPanel: "no languages at
          // all" (onboarding copy) vs "search hid them all" (search-only
          // copy, no CTA — the user is trying to find one, not add).
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-disabled)]">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span className="text-xs text-[var(--text-disabled)]">
              {hasAnyLocales ? 'No languages match' : 'No languages added'}
            </span>
          </div>
        ) : (
          <div className="flex flex-col">
            {filteredLocales.map(locale => {
              const isDefault = locale.code === config.defaultLocale;
              const menuItems: DropdownMenuEntry[] = [
                {
                  id: 'set-default',
                  label: 'Set as Default',
                  disabled: isDefault,
                  onClick: () => handleSetDefault(locale.code),
                },
                {
                  id: 'delete',
                  label: 'Delete',
                  disabled: isDefault,
                  onClick: () => setDeleteTarget(locale),
                },
              ];

              return (
                <SidebarRow
                  key={locale.code}
                  icon={<FlagIcon code={localeToCC(locale.code)} className="text-sm" />}
                  label={locale.label}
                  iconColor="inherit"
                  isActive={locale.code === activeLocale}
                  onClick={() => { setActiveLocale(locale.code); trace.action('locale-panel:switch', { code: locale.code }); }}
                  menuItems={menuItems}
                  right={isDefault ? (
                    <span className="text-[9px] bg-[var(--accent)]/10 text-[var(--accent-text)] px-1.5 rounded-full shrink-0 font-medium leading-[18px]">
                      Default
                    </span>
                  ) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        title="Delete Locale?"
        message={deleteTarget ? `Are you sure you want to delete "${deleteTarget.label}" (${deleteTarget.code})? All translations for this locale will be removed.` : ''}
        confirmLabel="Delete"
        danger
      />

      {/* Add Language Modal */}
      <AddLocaleModal
        isOpen={showAddModal}
        onClose={handleAddLocaleClose}
        existingCodes={config.locales.map(l => l.code)}
        existingLocales={config.locales}
      />
    </div>
  );
}
