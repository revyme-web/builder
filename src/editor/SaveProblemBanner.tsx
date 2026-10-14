// SaveProblemBanner.tsx — the one place a failing save is visible.
//
// Saves are silent when they work. When they don't, the editor used to stay
// silent too: the status atom flipped to 'error' and nothing rendered it, so
// a project the database refused (2026-10-12, a 16 MB row limit) looked
// perfectly fine while every change lived only in the tab's memory. Two
// states surface here:
//   · conflict — another tab or device saved a newer version after this tab
//     loaded it (save-revision.ts). The user chooses: reload (take theirs) or
//     overwrite (keep this tab's copy).
//   · error    — the save itself failed (backend, network, payload). Retries
//     run automatically; the user can also retry now.

import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { saveErrorAtom, saveStatusAtom } from '@/backend/save-store';
import { flushSaveNow, overwriteAfterConflict, reloadAfterConflict } from '@/backend/autosave';
import { trace } from '@/shared/debug-trace';

const buttonStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
};

export default function SaveProblemBanner() {
  const status = useAtomValue(saveStatusAtom);
  const error = useAtomValue(saveErrorAtom);
  const [busy, setBusy] = useState(false);
  if (status !== 'conflict' && status !== 'error') return null;

  const run = (label: string, fn: () => Promise<unknown> | void) => async () => {
    if (busy) return;
    setBusy(true);
    trace.action('save-banner:action', { label, status });
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div
      data-testid="save-problem-banner"
      role="alert"
      style={{
        position: 'fixed',
        // Above the viewer / agent / offline pills (bottom: 68) so a save
        // problem during an agent run is not hidden behind its banner.
        bottom: 104,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'min(720px, calc(100vw - 32px))',
        padding: '8px 12px',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-light)',
        borderRadius: 10,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
        color: 'var(--text-primary)',
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span style={{ width: 8, height: 8, flex: '0 0 auto', borderRadius: 999, background: '#f87171' }} />
      {status === 'conflict' ? (
        <>
          <span style={{ lineHeight: 1.35 }}>
            This project was changed in another tab or device. This tab's changes are not being saved.
          </span>
          <button type="button" style={buttonStyle} disabled={busy} onClick={run('reload', reloadAfterConflict)}>
            Reload latest
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            title="Replace the newer version with this tab's copy"
            onClick={run('overwrite', overwriteAfterConflict)}
          >
            Keep this tab's version
          </button>
        </>
      ) : (
        <>
          <span style={{ lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={error ?? undefined}>
            Changes are not being saved{error ? ` — ${error}` : ''}
          </span>
          <button type="button" style={buttonStyle} disabled={busy} onClick={run('retry', flushSaveNow)}>
            Retry now
          </button>
        </>
      )}
    </div>
  );
}
