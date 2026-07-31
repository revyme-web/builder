// KeyboardShortcutsModal.tsx — standard overview of every registered
// keyboard shortcut. Opened from the logo menu (View → Keyboard shortcuts).
// Reads the LIVE KeyboardManager registry at open time, so rows always match
// what's actually registered in canvas/shortcuts.ts — no hand-curated list.

import { useMemo } from 'react';
import { useAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import { keyboard } from '@/canvas/KeyboardManager';
import { shortcutsModalOpenAtom } from '@/code/stores/editor-store';
import { buildHelpSections } from './shortcut-help';
import { trace } from '@/shared/debug-trace';

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

function KeyChip({ children }: { children: string }) {
  return (
    <kbd className="min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded bg-[var(--bg-active)] text-[10px] font-medium text-[var(--text-secondary)] font-sans">
      {children}
    </kbd>
  );
}

export default function KeyboardShortcutsModal() {
  const [isOpen, setIsOpen] = useAtom(shortcutsModalOpenAtom);

  // Snapshot the registry when the modal opens (registrations are stable
  // while the canvas is mounted; re-reading per open keeps it fresh after
  // HMR or future dynamic registrations).
  const sections = useMemo(() => {
    if (!isOpen) return [];
    const built = buildHelpSections(keyboard.getAll(), isMacPlatform());
    trace.action('shortcuts-modal:open', { sectionCount: built.length, total: built.reduce((n, s) => n + s.shortcuts.length, 0) });
    return built;
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Keyboard Shortcuts" width={880}>
      {/* CSS multi-columns (not grid) so unequal-height sections pack
          masonry-style like the reference's panel; break-inside keeps a section
          from splitting across columns. */}
      <div className="columns-3 gap-8 p-5">
        {sections.map((section) => (
          <div key={section.title} className="break-inside-avoid mb-6">
            <div className="text-xs font-bold text-[var(--text-primary)] pb-2 mb-2 border-b border-[var(--border-light)]">
              {section.title}
            </div>
            <div className="space-y-1.5">
              {section.shortcuts.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-[var(--text-secondary)] truncate" title={s.label}>{s.label}</span>
                  <span className="flex items-center gap-0.5 shrink-0">
                    {[...s.mods, ...s.keys].map((chip, i) => <KeyChip key={i}>{chip}</KeyChip>)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
