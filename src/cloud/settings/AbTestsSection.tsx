// AbTestsSection.tsx — A/B test management for the current site.
//
// Plan-aware:
//   Free / Lite                — locked upsell pointing to Plans tab.
//   Pro                        — full management; 1 running test cap enforced server-side.
//   Studio                     — same as Pro + audience filter UI + multiple concurrent tests.
//
// The variant authoring (clicking into a test to edit variant trees in the
// canvas) is NOT in this file — that's a future editor-side feature. This
// component handles: list, create, start/pause/conclude, delete, view results
// (placeholder for now; live AE data lands when the Worker runtime ships).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAtomValue, useSetAtom } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { Skeleton } from '@/editor/overlays/settings-shared';
import { settingsSectionAtom, selectedAbTestPageAtom } from '@/code/stores/website-settings-store';
import PageAbTestDetail, { type AbTestRow as DetailRow } from './ab-tests/PageAbTestDetail';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { ConfirmModalShell, ModalCancelButton, RowActionsMenu, useEscapeToClose } from './shared';

type AbStatus = 'draft' | 'running' | 'paused' | 'concluded';

interface AbVariant {
  id: string;
  name: string;
  weight: number;
}

interface AbGoal {
  id: string;
  type: 'click' | 'visit' | 'submit';
  name?: string;
  selector?: string;
}

interface AbTestRow {
  id: string;
  website_id: string;
  page_path: string;
  name: string;
  status: AbStatus;
  variants: AbVariant[];
  goals: AbGoal[];
  audience: unknown | null;
  winner: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  tests: AbTestRow[];
  canManage: boolean;
  isStudio: boolean;
  caps: { maxVariants: number; maxGoals: number; maxConcurrent: number };
}

interface AbTestsSectionProps {
  websiteId: string;
}

export default function AbTestsSection({ websiteId }: AbTestsSectionProps) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [detailTest, setDetailTest] = useState<AbTestRow | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'start' | 'pause' | 'resume' | 'conclude' | 'delete'; test: AbTestRow }
    | null
  >(null);
  const setActiveSection = useSetAtom(settingsSectionAtom);
  const selectedPage = useAtomValue(selectedAbTestPageAtom);

  // Track first-time fetch so subsequent refreshes can be silent (no
  // skeleton flash) — the action handlers already wrote the new state
  // locally via applyLocal, and we just want to reconcile with the
  // server in the background.
  const initialLoadDoneRef = useRef(false);

  const refresh = useCallback(async (silent = initialLoadDoneRef.current) => {
    if (!websiteId) return;
    trace.fn('ab-section:fetch', { websiteId, silent });
    if (!silent) setLoading(true);
    try {
      const r = await fetch(`/api/ab-tests?websiteId=${websiteId}`);
      if (r.ok) setData(await r.json());
    } catch (e) {
      trace.error('ab-section:fetch', e);
    } finally {
      if (!silent) setLoading(false);
      initialLoadDoneRef.current = true;
    }
  }, [websiteId]);

  /** Apply an optimistic patch to a single test in local state — call
   *  this BEFORE firing the PATCH so the UI flips instantly. The
   *  background refresh later reconciles with whatever the server
   *  actually wrote (timestamps, normalized weights, etc.). */
  const applyLocal = useCallback((testId: string, patch: Partial<AbTestRow>) => {
    setData(prev => prev ? {
      ...prev,
      tests: prev.tests.map(t => t.id === testId ? { ...t, ...patch } as AbTestRow : t),
    } : prev);
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);

  // External create events (e.g. FileExplorer's "New A/B test…" on a page
  // row dispatches `ab-tests-changed` after the POST resolves). Refresh
  // so the new row appears here without the user having to switch tabs.
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener('ab-tests-changed', onChanged);
    return () => window.removeEventListener('ab-tests-changed', onChanged);
  }, [refresh]);

  const handleStateChange = useCallback(
    async (testId: string, action: 'start' | 'pause' | 'resume' | 'conclude'): Promise<boolean> => {
      try {
        setBusyId(testId);
        const r = await fetch(`/api/ab-tests/${testId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'conclude' ? { winner: null } : {}),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => null);
          alert(err?.error?.message ?? `${action} failed`);
          return false;
        }
        return true;
      } catch (e) {
        trace.error(`ab-section:${action}`, e);
        return false;
      }
    },
    [],
  );

  const handleDelete = useCallback(async (testId: string): Promise<boolean> => {
    try {
      setBusyId(testId);
      const r = await fetch(`/api/ab-tests/${testId}`, { method: 'DELETE' });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Delete failed');
        return false;
      }
      return true;
    } catch (e) {
      trace.error('ab-section:delete', e);
      return false;
    }
  }, []);

  // Surface load errors but otherwise let the partial-skeleton paths
  // below carry the loading state — the user keeps seeing the section
  // chrome (heading, description, list outline) instead of a full
  // skeleton blob replacing everything.
  if (!loading && !data) {
    return <p className="text-sm text-[var(--text-secondary)]">Couldn't load A/B tests.</p>;
  }

  // Free / Lite — locked upsell. Only render once we've confirmed the
  // plan; during the initial fetch we don't yet know whether to show
  // the upsell or the management view, so fall through to the
  // structural shell below.
  if (data && !data.canManage) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">A/B testing</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            Run experiments on your pages to find what converts best. Split traffic between variants and pick a winner based on real visitor behavior.
          </p>
        </div>
        <button
          onClick={() => setActiveSection('plans')}
          className="w-full px-4 py-3 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 cut-corners text-sm text-[var(--text-primary)] hover:from-blue-500/15 hover:to-purple-500/15 transition-colors text-left cursor-pointer"
        >
          Upgrade to Pro for A/B testing →
        </button>
      </div>
    );
  }

  const allTests = data?.tests ?? [];
  const isStudio = data?.isStudio ?? false;

  // ─── Per-page detail view ─────────────────────────────────────────
  // When the user picks a page from the sidebar's "A/B Tests" group we
  // hand the work off to PageAbTestDetail — a focused per-page layout
  // with variants table on the left and Steps / Filters / Options on
  // the right. The flat list below is reserved for the "show all" view
  // (parent A/B Tests row).
  if (selectedPage) {
    const tests = allTests.filter(t => t.page_path === selectedPage);
    return (
      <PageAbTestDetail
        pagePath={selectedPage}
        tests={tests as DetailRow[]}
        canManage={data?.canManage ?? false}
        isStudio={data?.isStudio ?? false}
        maxGoals={data?.caps?.maxGoals ?? 1}
        loading={loading}
        onRefresh={refresh}
        onLocalUpdate={applyLocal as (testId: string, patch: Partial<DetailRow>) => void}
      />
    );
  }

  const tests = allTests;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">A/B testing</h3>
        <p className="text-xs text-[var(--text-secondary)]">
          {isStudio
            ? 'Run unlimited concurrent experiments. Track conversion goals, segment by audience, and let the system declare winners.'
            : 'Run one experiment at a time. Upgrade to Studio for concurrent tests, audience segmentation, and auto-winner.'}
        </p>
      </div>

      {loading ? (
        // Skeleton rows — sized to match a real test row so the layout
        // doesn't jump when the data arrives.
        <ul className="space-y-2">
          <li className="flex items-center justify-between gap-3 px-4 py-3 bg-black/[0.04] dark:bg-white/5 border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)]">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-2.5 w-56" />
            </div>
            <Skeleton className="h-[30px] w-[110px] cut-corners" />
          </li>
          <li className="flex items-center justify-between gap-3 px-4 py-3 bg-black/[0.04] dark:bg-white/5 border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)]">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-48" />
            </div>
            <Skeleton className="h-[30px] w-[110px] cut-corners" />
          </li>
        </ul>
      ) : tests.length === 0 ? (
        // Same minimal hairline pattern as the rest of the settings
        // sections — no grey filled card, just a top/bottom border on
        // a flat row of body text.
        <div className="py-4 border-t border-b border-[var(--border-light)]">
          <p className="text-sm text-[var(--text-secondary)]">
            No A/B tests yet. Create one from the Pages panel — right-click any page → <b>New A/B test…</b>
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tests.map((test) => (
            <AbTestRowItem
              key={test.id}
              test={test}
              busy={busyId === test.id}
              isMenuOpen={openMenuId === test.id}
              onToggleMenu={() => setOpenMenuId((cur) => cur === test.id ? null : test.id)}
              onCloseMenu={() => setOpenMenuId(null)}
              onOpenDetail={() => setDetailTest(test)}
              onStart={() => { setOpenMenuId(null); setConfirm({ kind: 'start', test }); }}
              onPause={() => { setOpenMenuId(null); setConfirm({ kind: 'pause', test }); }}
              onResume={() => { setOpenMenuId(null); setConfirm({ kind: 'resume', test }); }}
              onConclude={() => { setOpenMenuId(null); setConfirm({ kind: 'conclude', test }); }}
              onDelete={() => { setOpenMenuId(null); setConfirm({ kind: 'delete', test }); }}
            />
          ))}
        </ul>
      )}

      {!isStudio && tests.length > 0 && (
        <button
          onClick={() => setActiveSection('plans')}
          className="w-full px-4 py-3 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 cut-corners text-sm text-[var(--text-primary)] hover:from-blue-500/15 hover:to-purple-500/15 transition-colors text-left cursor-pointer"
        >
          Upgrade to Studio for unlimited concurrent tests + audience segmentation →
        </button>
      )}


      <ActionConfirmModal
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onRun={async () => {
          if (!confirm) return;
          let ok = false;
          if (confirm.kind === 'delete') ok = await handleDelete(confirm.test.id);
          else ok = await handleStateChange(confirm.test.id, confirm.kind);
          setBusyId(null);
          setConfirm(null);
          if (ok) await refresh();
        }}
      />

      {detailTest && (
        <TestDetailModal
          test={detailTest}
          onClose={() => setDetailTest(null)}
          onRefresh={async () => { await refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────

interface AbTestRowItemProps {
  test: AbTestRow;
  busy: boolean;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOpenDetail: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onConclude: () => void;
  onDelete: () => void;
}

const STATUS_PILL: Record<AbStatus, { label: string; bg: string; text: string }> = {
  draft:     { label: 'Draft',     bg: 'bg-neutral-500/15',  text: 'text-neutral-400' },
  running:   { label: 'Running',   bg: 'bg-emerald-500/15',  text: 'text-emerald-400' },
  paused:    { label: 'Paused',    bg: 'bg-amber-500/15',    text: 'text-amber-400' },
  concluded: { label: 'Concluded', bg: 'bg-blue-500/15',     text: 'text-blue-400' },
};

function AbTestRowItem({
  test, busy, isMenuOpen, onToggleMenu, onCloseMenu, onOpenDetail,
  onStart, onPause, onResume, onConclude, onDelete,
}: AbTestRowItemProps) {
  const pill = STATUS_PILL[test.status];

  const items: DropdownMenuEntry[] = [
    { id: 'view', label: 'View results', onClick: onOpenDetail },
    { type: 'separator' },
    ...(test.status === 'draft' || test.status === 'paused'
      ? [{ id: 'start', label: test.status === 'paused' ? 'Resume test' : 'Start test', onClick: test.status === 'paused' ? onResume : onStart }]
      : []),
    ...(test.status === 'running'
      ? [{ id: 'pause', label: 'Pause test', onClick: onPause }]
      : []),
    ...(test.status !== 'concluded'
      ? [{ id: 'conclude', label: 'Conclude test', onClick: onConclude }]
      : []),
    { type: 'separator' },
    { id: 'delete', label: 'Delete test', onClick: onDelete },
  ];

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 bg-black/[0.04] dark:bg-white/5 border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)]">
      <button
        type="button"
        onClick={onOpenDetail}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{test.name}</p>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${pill.bg} ${pill.text}`}>
            {test.status === 'running' && (
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
            )}
            {pill.label}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] truncate">
          {test.page_path}{' '}·{' '}
          {test.variants.length} variant{test.variants.length === 1 ? '' : 's'}{' '}·{' '}
          {test.goals.length} goal{test.goals.length === 1 ? '' : 's'}
        </p>
      </button>
      <div className="flex items-center gap-2 flex-shrink-0">
        <RowActionsMenu
          items={items}
          isOpen={isMenuOpen}
          disabled={busy}
          onToggle={onToggleMenu}
          onClose={onCloseMenu}
        />
      </div>
    </li>
  );
}


// ─── Action confirm modal ──────────────────────────────────────────────────

interface ActionConfirm {
  kind: 'start' | 'pause' | 'resume' | 'conclude' | 'delete';
  test: AbTestRow;
}
interface ActionConfirmModalProps {
  confirm: ActionConfirm | null;
  onCancel: () => void;
  onRun: () => Promise<void>;
}

function ActionConfirmModal({ confirm, onCancel, onRun }: ActionConfirmModalProps) {
  const [running, setRunning] = useState(false);

  useEffect(() => { if (!confirm) setRunning(false); }, [confirm]);
  useEscapeToClose(!!confirm, running, onCancel);

  if (!confirm) return null;

  const k = confirm.kind;
  const title =
    k === 'start' ? 'Start this A/B test?'
    : k === 'pause' ? 'Pause this A/B test?'
    : k === 'resume' ? 'Resume this A/B test?'
    : k === 'conclude' ? 'Conclude this A/B test?'
    : 'Delete this A/B test?';
  const body =
    k === 'start'
      ? `${confirm.test.name} will start splitting traffic across its ${confirm.test.variants.length} variants on ${confirm.test.page_path}.`
      : k === 'pause'
        ? `${confirm.test.name} will stop splitting traffic. All visitors will see the baseline. Resume any time.`
      : k === 'resume'
        ? `${confirm.test.name} will resume splitting traffic to all variants.`
      : k === 'conclude'
        ? `${confirm.test.name} will be marked concluded. Traffic stops splitting; results stay viewable. This is irreversible — create a new test if you need to re-run.`
        : `${confirm.test.name} will be permanently removed along with its variant configuration. Conversion data stays in your analytics.`;
  const submit =
    k === 'start' ? 'Start test'
    : k === 'pause' ? 'Pause test'
    : k === 'resume' ? 'Resume test'
    : k === 'conclude' ? 'Conclude test'
    : 'Delete test';

  return (
    <ConfirmModalShell
      open
      locked={running}
      onCancel={onCancel}
      title={title}
      closeButtonClassName="p-1 hover:bg-[var(--bg-hover)] cut-corners cursor-pointer disabled:opacity-30"
    >
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{body}</p>
      <div className="flex items-center gap-2">
        <ModalCancelButton
          onClick={onCancel}
          disabled={running}
          className="flex-1 h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] cut-corners cursor-pointer disabled:opacity-30"
        />
        <button
          onClick={async () => { setRunning(true); try { await onRun(); } catch { setRunning(false); } }}
          disabled={running}
          className={`flex-1 h-8 px-3 text-xs cut-corners font-medium flex items-center justify-center text-[var(--accent-fg)] disabled:opacity-60 cursor-pointer ${
            k === 'delete' ? 'bg-red-500/90 hover:bg-red-500' : 'bg-[var(--accent)] hover:opacity-90'
          }`}
        >
          {running ? `${submit.replace(/e$/, '')}ing…` : submit}
        </button>
      </div>
    </ConfirmModalShell>
  );
}

// ─── Test detail modal ────────────────────────────────────────────────────
//
// Click into a test to see its config + (placeholder) results. Real AE-
// powered results numbers land when the Worker runtime ships in Phase 5.
// Until then we render the variant list with dashes — the structure is in
// place for live numbers to drop in.

interface TestDetailModalProps {
  test: AbTestRow;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

function TestDetailModal({ test, onClose }: TestDetailModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const pill = STATUS_PILL[test.status];
  const variantColors = ['#3b82f6', '#a855f7', '#10b981', '#f97316', '#ef4444', '#06b6d4', '#eab308', '#ec4899', '#84cc16', '#6366f1'];

  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{ zIndex: 99999 }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 bg-black/50"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15 }}
          className="relative w-[720px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-hidden bg-[var(--bg-surface)] cut-corners cut-lg shadow-2xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-light)]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">{test.name}</h3>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${pill.bg} ${pill.text}`}>
                  {pill.label}
                </span>
              </div>
              <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                {test.page_path}{test.started_at ? ` · Started ${new Date(test.started_at).toLocaleDateString()}` : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-[var(--bg-hover)] cut-corners cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Status block — winner / summary */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Status</p>
                <p className="text-xs font-semibold text-[var(--text-primary)] mt-1">{pill.label}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Winner</p>
                <p className="text-xs font-semibold text-[var(--text-primary)] mt-1">
                  {test.winner
                    ? test.variants.find((v) => v.id === test.winner)?.name ?? test.winner
                    : test.status === 'concluded' ? '—' : 'Pending'}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Summary</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                  {test.status === 'draft'
                    ? 'Test is not running yet. Start it from the Actions menu.'
                    : test.status === 'running'
                      ? 'Collecting data. Results below update every 30 seconds.'
                      : test.status === 'paused'
                        ? 'Test is paused. Traffic flows to the baseline.'
                        : 'Test concluded. Results are frozen.'}
                </p>
              </div>
            </div>

            {/* Variants table — placeholder until Phase 5/6 ship */}
            <div className="space-y-2">
              <div className="grid grid-cols-[1.5fr_repeat(5,1fr)] gap-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                <div>Variant</div>
                <div className="text-right">Views</div>
                <div className="text-right">Events</div>
                <div className="text-right">Conversion</div>
                <div className="text-right">Lift</div>
                <div className="text-right">Best</div>
              </div>
              {test.variants.map((v, i) => (
                <div
                  key={v.id}
                  className="grid grid-cols-[1.5fr_repeat(5,1fr)] gap-2 px-3 py-2 bg-black/[0.04] dark:bg-white/5 border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)] text-xs text-[var(--text-secondary)] tabular-nums"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: variantColors[i % variantColors.length] }} />
                    <span className="text-[var(--text-primary)] font-medium truncate">{v.name}</span>
                    <span className="text-[var(--text-tertiary)] text-[10px]">{v.weight}%</span>
                  </div>
                  <div className="text-right">—</div>
                  <div className="text-right">—</div>
                  <div className="text-right">—</div>
                  <div className="text-right">—</div>
                  <div className="text-right">—</div>
                </div>
              ))}
              <p className="text-[10px] text-[var(--text-tertiary)] mt-2 px-1">
                Live results land here once the Worker runtime is wired. Pre-Phase-5 builds show dashes; the table structure is ready.
              </p>
            </div>

            {/* Goals */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Conversion goals</p>
              {test.goals.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">
                  No goals defined. Add tracked elements in the canvas (right-click → Track as conversion) to record what counts as a "win".
                </p>
              ) : (
                <ul className="space-y-1">
                  {test.goals.map((g) => (
                    <li key={g.id} className="text-xs text-[var(--text-primary)] font-mono px-2 py-1 bg-black/[0.04] dark:bg-white/5 rounded">
                      <span className="text-[var(--text-tertiary)]">{g.type}:</span> {g.name || g.selector || g.id}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
