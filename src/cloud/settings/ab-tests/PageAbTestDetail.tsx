// PageAbTestDetail.tsx — Per-page A/B test management view.
//
// Renders when the user picks a page from the settings sidebar's "A/B
// Tests" group. Replaces the old flat "list of all tests" view with a
// focused page-scoped layout:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ Home                                                            │
//   │ Tests on this page · 2                                          │
//   ├──────────────────────────────────────┬──────────────────────────┤
//   │  Test card 1                         │  Steps        +          │
//   │  ┌──────────────────────────────┐    │   View Home   [pageview] │
//   │  │ Status / Winner / Summary    │    │   Click CTA   [click]    │
//   │  │ Variants table               │    │                          │
//   │  └──────────────────────────────┘    │  Filters      +          │
//   │                                      │   Device  desktop        │
//   │  Test card 2 …                       │                          │
//   │                                      │  Options                 │
//   │                                      │   Distribution  Even     │
//   └──────────────────────────────────────┴──────────────────────────┘
//
// One Steps / Filters / Options column drives ONE selected test (the
// most recently created by default). The user can pick another test via
// a top tab strip if the page carries more than one — multi-test pages
// happen in practice while a user is exploring, and we don't want to
// hide the others. The same column is used for the actual config edits;
// the test card's variants table on the left is read-mostly (status,
// progress, results placeholders).

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { trace } from '@/shared/debug-trace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { filePathToAbPagePath } from '@/code/project/active-file-store';
import { useAtomValue, useSetAtom } from 'jotai';
import { settingsSectionAtom } from '@/code/stores/website-settings-store';
import ToolSection from '@/editor/controls/ToolSection';
import ToolDivider from '@/editor/controls/ToolDivider';
import { Skeleton } from '@/editor/overlays/settings-shared';
import ToolPopup, { useToolPopup } from '@/editor/ui/ToolPopup';
import ToolRow from '@/editor/controls/ToolRow';
import ToolInput from '@/editor/controls/ToolInput';
import ToolSelect from '@/editor/controls/ToolSelect';
import { audienceIsEmpty, normalizeAudience } from './audience-match';
import { COUNTRY_BY_CODE, searchCountries } from './countries';

// ─── Types (mirror AbTestsSection's shapes so we don't pull a cycle) ────────

type AbStatus = 'draft' | 'running' | 'paused' | 'concluded';

import type { AbAudience, AbAudienceDevice } from './audience-match';

interface AbVariant { id: string; name: string; weight: number }

type AbGoalType = 'click' | 'visit' | 'submit' | 'custom';

interface AbGoal {
  id: string;
  /** Goal kind. `visit` = pageview, `submit` = form submit, `custom` =
   *  named event the user fires with `revyme.track('id')`. */
  type: AbGoalType;
  /** Friendly label shown in lists ("View Home", "Click CTA"). */
  name?: string;
  /** For `click` + `submit` + `custom` — the tracking ID the visitor's
   *  page emits to satisfy this goal. */
  trackingId?: string;
  /** For `visit` — the page path being viewed. */
  pagePath?: string;
}

export interface AbTestRow {
  id: string;
  website_id: string;
  page_path: string;
  name: string;
  status: AbStatus;
  variants: AbVariant[];
  goals: AbGoal[];
  audience: AbAudience | null;
  winner: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert the API page path ("page", "about/page", "blog/post-1/page")
 *  to the friendly leaf-only label ("Home", "about", "post-1"). Header
 *  slots and chip-like surfaces have no room for the full path, and
 *  the leaf segment is what uniquely identifies the page in context
 *  (parent folders are repeated in the sidebar tree). Full path stays
 *  available via the raw `pagePath` prop for tooltips / detail copy. */
function pageLabel(pagePath: string): string {
  if (pagePath === 'page') return 'Home';
  // Strip the trailing `/page` route file segment, then take the
  // last path component. `blog/post-1/page` → `post-1`.
  const trimmed = pagePath.endsWith('/page')
    ? pagePath.slice(0, -'/page'.length)
    : pagePath;
  const segments = trimmed.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : trimmed;
}

const STATUS_PILL: Record<AbStatus, { label: string; bg: string; text: string }> = {
  draft:     { label: 'Draft',     bg: 'bg-neutral-500/15', text: 'text-neutral-400' },
  running:   { label: 'Running',   bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  paused:    { label: 'Paused',    bg: 'bg-amber-500/15',   text: 'text-amber-400'   },
  concluded: { label: 'Concluded', bg: 'bg-blue-500/15',    text: 'text-blue-400'    },
};

/** Resolve a per-goal conversion count from the backend's byGoal map.
 *
 *  Click / submit / custom goals are recorded by the inline tracking
 *  beacon with the FREE-FORM trackingId the user put in their
 *  data-revyme-track attribute (e.g. "poon") — not the goal's
 *  auto-generated id (e.g. "g_abc123"). Visit goals are recorded by
 *  the worker's path-matching handler with the actual goal.id. We try
 *  both keys here so the dashboard renders correctly regardless of
 *  which branch fired the conversion. Returns 0 when neither matches. */
function lookupGoalCount(
  byGoal: Record<string, number> | undefined,
  goal: AbGoal,
): number {
  if (!byGoal) return 0;
  const idCount = byGoal[goal.id] ?? 0;
  if (idCount > 0) return idCount;
  // Fallback to trackingId for click/submit/custom rows recorded
  // before the worker started rewriting goalId on the way in.
  if (goal.type !== 'visit' && goal.trackingId) {
    return byGoal[goal.trackingId] ?? 0;
  }
  return 0;
}

const GOAL_TYPE_LABEL: Record<AbGoalType, string> = {
  visit:  'Pageview',
  click:  'Click',
  submit: 'Form Submit',
  custom: 'Custom',
};

const VARIANT_COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f97316', '#ef4444', '#06b6d4', '#eab308', '#ec4899', '#84cc16', '#6366f1'];

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  pagePath: string;
  tests: AbTestRow[];
  /** Reconciles local state with the server. Always called silently
   *  AFTER an optimistic update so the user never sees a skeleton flash
   *  between action and re-render. */
  onRefresh: () => Promise<void> | void;
  /** Optimistic local patch — flips the UI instantly without waiting
   *  for the network. Called before fetch() in every action handler so
   *  Pause / Resume / Start / save-goals / save-weights all feel snappy. */
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
  /** True when the active plan can mutate tests (Pro+); used to gate
   *  Start / Add Step / etc. UI. */
  canManage: boolean;
  /** Studio = unlimited concurrent tests + higher goal cap. Drives the
   *  upgrade copy when the Pro user hits the goal-count limit. */
  isStudio: boolean;
  /** Max conversion goals per test for the active plan (Pro = 1,
   *  Studio = 3). Stepspanel uses this to swap the + behaviour: under
   *  the cap it opens the editor; at the cap it opens an inline
   *  upgrade prompt. */
  maxGoals: number;
  /** Parent is still doing its initial fetch — we render the page
   *  chrome but skeleton anything driven by the (still-empty) tests
   *  array so the user sees the layout immediately instead of an
   *  "empty page" flash. */
  loading?: boolean;
}

// ─── Main component ────────────────────────────────────────────────────────

export default function PageAbTestDetail({ pagePath, tests, onRefresh, onLocalUpdate, canManage, isStudio, maxGoals, loading = false }: Props) {
  // The "selected" test the right column edits — defaults to the most
  // recently updated so the user lands on whatever they were last
  // working with.
  const sortedTests = [...tests].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const [activeId, setActiveId] = useState<string | null>(sortedTests[0]?.id ?? null);

  // Keep activeId pinned to a still-existing test as the list churns
  // (e.g. delete from elsewhere → atom refresh → tests array changes).
  useEffect(() => {
    if (!sortedTests.some(t => t.id === activeId)) {
      setActiveId(sortedTests[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tests.map(t => t.id).join(',')]);

  const activeTest = sortedTests.find(t => t.id === activeId) ?? null;

  trace.fn('PageAbTestDetail:render', {
    pagePath, testCount: tests.length, activeId,
  });

  if (sortedTests.length === 0) {
    return (
      <div className="h-full flex">
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-hide px-10 py-8">
          <Header pagePath={pagePath} count={loading ? null : 0} />
          {loading ? (
            // Skeleton card — same shape as a real TestCard so the
            // layout doesn't jump when the data lands.
            <SkeletonTestCard />
          ) : (
            <div className="mt-4 px-4 py-6 bg-black/[0.04] dark:bg-white/5 border border-[var(--control-border)] rounded-lg text-center">
              <p className="text-sm text-[var(--text-secondary)]">
                No A/B tests on this page yet.
              </p>
            </div>
          )}
        </div>
        <RightPanel
          test={null}
          canManage={false}
          isStudio={isStudio}
          maxGoals={maxGoals}
          onRefresh={onRefresh}
          onLocalUpdate={onLocalUpdate}
          loading={loading}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* ─── Main column — page-level overview + selected test card ──── */}
      <div className="flex-1 min-w-0 overflow-y-auto scrollbar-hide px-10 py-8 space-y-4">
        {/* Top row: page header on the left, action buttons (Start /
            Pause / Resume) on the right. Mirrors the reference's pattern
            where the test-state controls sit at the top of the page
            opposite the page title. During loading we render
            skeleton buttons of the same h-8 footprint so the header
            row doesn't shift when actions appear. */}
        <div className="flex items-start justify-between gap-4">
          <Header pagePath={pagePath} count={loading ? null : sortedTests.length} />
          {loading
            ? <SkeletonTestActions />
            : activeTest && canManage && (
                <TestActions
                  test={activeTest}
                  onRefresh={onRefresh}
                  onLocalUpdate={onLocalUpdate}
                />
              )}
        </div>

        {sortedTests.length > 1 && (
          <TestTabs
            tests={sortedTests}
            activeId={activeId}
            onPick={setActiveId}
          />
        )}

        {activeTest && (
          <TestCard
            test={activeTest}
            canManage={canManage}
          />
        )}
      </div>

      {/* ─── Right rail — matches the canvas PropertiesPanel exactly:
            260 px, border-left, --bg-surface, own scroll. Tools (Steps,
            Options, Filters) render as ToolSection so the visual
            language is identical to the editor's right panel. ──────── */}
      <RightPanel
        test={activeTest}
        canManage={canManage}
        isStudio={isStudio}
        maxGoals={maxGoals}
        onRefresh={onRefresh}
        onLocalUpdate={onLocalUpdate}
      />
    </div>
  );
}

// ─── Right panel (260px, mirrors editor's PropertiesPanel chrome) ──────────

function RightPanel({
  test, canManage, isStudio, maxGoals, onRefresh, onLocalUpdate, loading = false,
}: {
  test: AbTestRow | null;
  canManage: boolean;
  isStudio: boolean;
  maxGoals: number;
  onRefresh: () => Promise<void> | void;
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
  loading?: boolean;
}) {
  return (
    <div
      className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] overflow-y-auto scrollbar-hide flex flex-col"
    >
      <div className="mb-1.5" />
      {test ? (
        <>
          <StepsPanel test={test} canManage={canManage} isStudio={isStudio} maxGoals={maxGoals} onRefresh={onRefresh} onLocalUpdate={onLocalUpdate} />
          <ToolDivider />
          <OptionsPanel test={test} canManage={canManage} onRefresh={onRefresh} onLocalUpdate={onLocalUpdate} />
          <ToolDivider />
          <FiltersPanel
            test={test}
            canManage={canManage}
            isStudio={isStudio}
            onRefresh={onRefresh}
            onLocalUpdate={onLocalUpdate}
          />
        </>
      ) : loading ? (
        // Skeleton sections — same shape + section headers as the real
        // Steps / Options / Filters tools so the rail doesn't shift
        // when the test row arrives.
        <>
          <SkeletonToolSection title="Steps" rows={2} />
          <ToolDivider />
          <SkeletonToolSection title="Options" rows={1} />
          <ToolDivider />
          <SkeletonToolSection title="Filters" rows={1} />
        </>
      ) : (
        <div className="px-4 py-3">
          <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
            Add a test on this page to configure events, distribution, and filters.
          </p>
        </div>
      )}
    </div>
  );
}

function SkeletonToolSection({ title, rows }: { title: string; rows: number }) {
  return (
    <ToolSection title={title} collapsible={false}>
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full rounded-md" />
        ))}
      </div>
    </ToolSection>
  );
}

// ─── Project page list (for the Pageview goal dropdown) ────────────────────

/** Scan every project source file for `data-revyme-track="<id>"`
 *  attribute values and return them sorted + de-duplicated. Powers the
 *  Tracking-ID autocomplete in the step editor — the user can pick an
 *  ID that's already wired up to something on the page instead of
 *  re-typing it (and risking a typo that silently breaks the goal).
 *
 *  Reactive to projectVersionAtom so an ID added on the canvas via the
 *  Link tool shows up in the dropdown the next time the popover opens.
 *  Custom goals fired via `revyme.track('id')` can't be statically
 *  detected (would need JS parsing), so this list only covers
 *  click/submit goals — typing a fresh ID is still always allowed. */
function useProjectTrackingIds(): string[] {
  const version = useAtomValue(projectVersionAtom);
  return useMemo(() => {
    void version;
    const seen = new Set<string>();
    const re = /data-revyme-track\s*=\s*["']([^"']+)["']/g;
    for (const f of projectFS.listFiles()) {
      if (!/\.(tsx?|jsx?|html?)$/.test(f)) continue;
      const code = projectFS.readFile(f);
      if (!code) continue;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        if (m[1]) seen.add(m[1]);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [version]);
}

/** Read all `app/**\/page.tsx` files from ProjectFS and return their api
 *  page_path + a friendly label. Reactive to project version so newly
 *  created/renamed pages show up immediately. */
function useProjectPages(): Array<{ apiPath: string; label: string }> {
  const version = useAtomValue(projectVersionAtom);
  return useMemo(() => {
    void version;  // re-runs on each bump
    const seen = new Set<string>();
    const out: Array<{ apiPath: string; label: string }> = [];
    for (const f of projectFS.listFiles()) {
      if (!f.startsWith('app/') || !f.endsWith('/page.tsx') && f !== 'app/page.tsx') continue;
      const apiPath = filePathToAbPagePath(f);
      if (seen.has(apiPath)) continue;
      seen.add(apiPath);
      out.push({ apiPath, label: pageLabel(apiPath) });
    }
    out.sort((a, b) => {
      // Home first, then alphabetic.
      if (a.apiPath === 'page') return -1;
      if (b.apiPath === 'page') return 1;
      return a.label.localeCompare(b.label);
    });
    return out;
  }, [version]);
}

// ─── Header ────────────────────────────────────────────────────────────────

function Header({ pagePath, count }: { pagePath: string; count: number | null }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
        {pageLabel(pagePath)}
      </h3>
      {count === null
        ? <Skeleton className="h-3 w-32" />
        : <p className="text-xs text-[var(--text-secondary)]">
            {count} test{count === 1 ? '' : 's'} on this page.
          </p>}
    </div>
  );
}

/** Skeleton placeholder for the action button row in the page
 *  header — same h-8 + px-4 footprint as the real Start / Pause /
 *  Resume button so the header doesn't shift when it appears. */
function SkeletonTestActions() {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <Skeleton className="h-8 w-[88px] rounded-md" />
    </div>
  );
}

/** Loading shell — mirrors the real TestCard flat layout 1:1 so the
 *  page doesn't reshuffle when /api/ab-tests resolves. Hardcoded
 *  labels (STATUS / WINNER / SUMMARY / EVENTS / VARIANT / VIEWS /
 *  EVENTS / CONVERSION / LIFT / BEST) render immediately — only the
 *  values, the test name pill, and the goal tile contents fall back
 *  to skeleton bars while the fetch is in flight. */
function SkeletonTestCard() {
  return (
    <div className="flex flex-col">
      {/* Test name + status pill — heights match real (text-base
          = 24px line-height for the name, ~20px pill). */}
      <div className="flex items-center gap-2 mb-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-5 w-16 rounded" />
      </div>

      {/* Status / Winner / Summary — labels visible, values skeletoned.
          Value heights match real (text-sm = 20px line-height,
          summary text-xs leading-relaxed ~18px per line). */}
      <div className="grid grid-cols-3 gap-6 pb-6 border-b border-[var(--border-light)]">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Status</p>
          <Skeleton className="h-5 w-20" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Winner</p>
          <Skeleton className="h-5 w-24" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Summary</p>
          <div className="space-y-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>

      {/* Events row — section label always visible. One placeholder
          goal tile + the "+ Create step" card so the grid renders at
          full height immediately. */}
      <div className="py-6 border-b border-[var(--border-light)]">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
          Events
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <div className="min-w-0 px-4 py-4 border border-[var(--control-border)] rounded-md">
            <div className="flex items-center justify-between gap-2 mb-1">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-4 rounded" />
            </div>
            <Skeleton className="h-4 w-28 mb-3" />
            <Skeleton className="h-8 w-12 mb-3" />
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
          <button
            type="button"
            disabled
            className="h-full min-h-[140px] px-4 py-6 bg-transparent border border-dashed border-[var(--control-border)] rounded-md flex items-center justify-center opacity-50 cursor-not-allowed"
          >
            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-[var(--bg-hover)] rounded-md text-xs font-medium text-[var(--text-primary)]">
              + Create step
            </span>
          </button>
        </div>
      </div>

      {/* Variants table — column headers + 2 placeholder rows. Headers
          + the dash placeholders for each metric column render
          immediately (matches the post-load empty state — newly-
          started tests also show dashes until the first exposure). */}
      <div className="py-6 border-b border-[var(--border-light)]">
        <div className="grid grid-cols-[2fr_repeat(5,1fr)] gap-2 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
          <div>Variant</div>
          <div className="text-right">Views</div>
          <div className="text-right">Events</div>
          <div className="text-right">Conversion</div>
          <div className="text-right">Lift</div>
          <div className="text-right">Best</div>
        </div>
        {[0, 1].map(i => (
          <div
            key={i}
            className="grid grid-cols-[2fr_repeat(5,1fr)] gap-2 px-3 py-3 text-xs text-[var(--text-secondary)] tabular-nums border-b border-[var(--border-light)] last:border-b-0"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Skeleton className="w-2 h-2 rounded-full" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="text-right">—</div>
            <div className="text-right">—</div>
            <div className="text-right">—</div>
            <div className="text-right">—</div>
            <div className="text-right">—</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Test tab strip (only renders when > 1 test on the page) ───────────────

function TestTabs({
  tests, activeId, onPick,
}: {
  tests: AbTestRow[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[var(--control-border)]">
      {tests.map(t => {
        const isActive = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
              isActive
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span className="truncate max-w-[140px] inline-block align-middle">
              {t.name || 'Untitled'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Test card (left column) ───────────────────────────────────────────────

interface VariantResults {
  variantId: string;
  views: number;
  events: number;
  conversion: number;
  /** Conversion counts pivoted per goal id — drives the named-event
   *  tiles between the status row and the variants table. */
  byGoal: Record<string, number>;
}
interface TestResults {
  testId: string;
  variants: VariantResults[];
  best: string | null;
}

function TestCard({
  test, canManage,
}: {
  test: AbTestRow;
  canManage: boolean;
}) {
  const pill = STATUS_PILL[test.status];

  // ─── Live results — fetched from /api/ab-tests/:id/results which
  // runs an AE SQL query under the hood. Polled while the card is
  // visible AND the test isn't concluded (concluded results are
  // frozen). Errors are swallowed silently into the empty-state so a
  // transient AE blip doesn't replace the card with an error blob.
  const [results, setResults] = useState<TestResults | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/ab-tests/${test.id}/results`);
        if (!r.ok || cancelled) return;
        const j = await r.json() as TestResults;
        if (!cancelled) setResults(j);
      } catch (e) {
        trace.error('TestCard:results-fetch', e);
      }
    };
    void load();
    // Don't poll concluded tests — their AE numbers are frozen, and a
    // refresh would just hammer the SQL endpoint with no payoff.
    if (test.status === 'concluded') return () => { cancelled = true; };
    const t = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [test.id, test.status]);

  // Per-variant lookup so the table render stays O(1) per row.
  const resultsByVariant = useMemo(() => {
    const m = new Map<string, VariantResults>();
    for (const v of results?.variants ?? []) m.set(v.variantId, v);
    return m;
  }, [results]);

  // Lift vs baseline (variant 'a'). Returns null when baseline has no
  // views (lift is undefined) or for the baseline row itself.
  const baselineRate = resultsByVariant.get('a')?.conversion ?? 0;
  const formatLift = (variantId: string, rate: number): string => {
    if (variantId === 'a' || baselineRate === 0) return '—';
    const lift = (rate - baselineRate) / baselineRate;
    const sign = lift > 0 ? '+' : '';
    return `${sign}${(lift * 100).toFixed(1)}%`;
  };

  // (stateChange action handler lives in TestActions now — see the
  // page-header row in PageAbTestDetail.)

  return (
    // Flat layout — no enclosing card. Sections are separated by
    // hairline dividers so they breathe instead of feeling cramped
    // inside one big box. Matches the reference's A/B-test detail page
    // pattern (status block / events row / variants table all flow
    // top-to-bottom on the same background).
    <div className="flex flex-col">
      {/* Test name + status pill at the top, no card chrome. */}
      <div className="flex items-center gap-2 mb-6">
        <h4 className="text-base font-semibold text-[var(--text-primary)] truncate">{test.name || 'Untitled test'}</h4>
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

      {/* Status / Winner / Summary — 3-col row, no card around it.
          Headings sit on top of larger value text. Breathing room
          between sections via the parent's flex-col + dividers. */}
      <div className="grid grid-cols-3 gap-6 pb-6 border-b border-[var(--border-light)]">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Status</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">{pill.label}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Winner</p>
          <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {test.winner
              ? test.variants.find(v => v.id === test.winner)?.name ?? test.winner
              : test.status === 'concluded' ? 'No winner' : 'Pending'}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Summary</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            {test.status === 'draft' && 'Test is not running yet. Start it to begin collecting traffic.'}
            {test.status === 'running' && 'Collecting data. Results update every 30 seconds.'}
            {test.status === 'paused' && 'Test is paused. Traffic flows to baseline only.'}
            {test.status === 'concluded' && 'Test concluded. Results are frozen.'}
          </p>
        </div>
      </div>

      {/* Events row — flat grid where the "Create step" placeholder
          lives as a regular grid item alongside the real event tiles.
          Same width + height as the actual cards (grid auto-sizes
          them in lockstep) so the empty + always-add slot reads as
          a peer of the existing events, not a separate row.

          Click dispatches a window event the right rail listens for —
          opens the same EditStepPopover as the + button in the rail. */}
      <div className="py-6 border-b border-[var(--border-light)]">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
          Events
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {test.goals.map(g => {
            const totalForGoal = test.variants.reduce((sum, v) => {
              return sum + lookupGoalCount(resultsByVariant.get(v.id)?.byGoal, g);
            }, 0);
            return (
              <GoalTile
                key={g.id}
                goal={g}
                total={totalForGoal}
                variants={test.variants}
                resultsByVariant={resultsByVariant}
                loading={results === null}
              />
            );
          })}
          {/* Hide the dashed `+ Create step` placeholder while the test
              is running (or otherwise locked) — adding events mid-run
              would invalidate the data already collected, and the
              backend would reject the PATCH anyway. The user has to
              pause first; the Steps panel header (right rail) shows the
              "Pause the test to edit properties" notice. */}
          {canManage && !editLockReason(test) && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('ab-test:add-event', { detail: { testId: test.id } }))}
              className="group h-full min-h-[140px] px-4 py-6 bg-transparent border border-dashed border-[var(--control-border)] rounded-md flex items-center justify-center hover:border-[var(--text-tertiary)] transition-colors cursor-pointer"
            >
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-[var(--bg-hover)] group-hover:bg-[var(--grid-line)] rounded-md text-xs font-medium text-[var(--text-primary)] transition-colors">
                + Create step
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Variants table — flat, no cards on rows. The "VARIANT"
          column header already labels the section, so the parent
          "VARIANTS" caption was redundant; dropped it. Hairline
          divider between rows lets the eye scan columns without the
          visual weight of each row being its own outlined box. */}
      <div className="py-6 border-b border-[var(--border-light)]">
        <div className="grid grid-cols-[2fr_repeat(5,1fr)] gap-2 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
          <div>Variant</div>
          <div className="text-right">Views</div>
          <div className="text-right">Events</div>
          <div className="text-right">Conversion</div>
          <div className="text-right">Lift</div>
          <div className="text-right">Best</div>
        </div>
        {test.variants.map((v, i) => {
          const r = resultsByVariant.get(v.id);
          const views = r?.views ?? 0;
          const events = r?.events ?? 0;
          const conv = r?.conversion ?? 0;
          const isBest = results?.best === v.id;
          const fmt = (n: number) => views === 0 ? '—' : n.toLocaleString();
          const fmtPct = (rate: number) => views === 0 ? '—' : `${(rate * 100).toFixed(1)}%`;
          return (
            <div
              key={v.id}
              className="grid grid-cols-[2fr_repeat(5,1fr)] gap-2 px-3 py-3 text-xs text-[var(--text-secondary)] tabular-nums border-b border-[var(--border-light)] last:border-b-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: VARIANT_COLORS[i % VARIANT_COLORS.length] }} />
                <span className="text-[var(--text-primary)] font-medium truncate">{v.name}</span>
                <span className="text-[var(--text-tertiary)] text-[10px]">{v.weight}%</span>
              </div>
              <div className="text-right">{fmt(views)}</div>
              <div className="text-right">{fmt(events)}</div>
              <div className="text-right">{fmtPct(conv)}</div>
              <div className="text-right">{views === 0 ? '—' : formatLift(v.id, conv)}</div>
              <div className="text-right">
                {isBest
                  ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">Best</span>
                  : '—'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action row moved up to the page header — see TestActions
          rendered next to Header in PageAbTestDetail's main column. */}
    </div>
  );
}

/** Status-change action buttons (Start / Pause / Resume) for the
 *  currently-active test.
 *
 *  Lifecycle is `draft → running ↔ paused`. There is no Conclude
 *  affordance — the reference's model (which Revyme aligns with) treats Stop /
 *  Pause as the soft-terminal state. Rename + Delete live on the row
 *  ellipsis in the A/B Tests sidebar (not duplicated here).
 *  Legacy DB rows with status = 'concluded' still render their pill
 *  correctly, but new tests never reach that state from the UI. */
function TestActions({
  test, onRefresh, onLocalUpdate,
}: {
  test: AbTestRow;
  onRefresh: () => Promise<void> | void;
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
}) {
  const stateChange = useCallback(
    async (action: 'start' | 'pause' | 'resume') => {
      trace.action('TestActions:state-change', { id: test.id, action });
      const now = new Date().toISOString();
      const prev = { status: test.status, started_at: test.started_at, ended_at: test.ended_at };
      const optimisticStatus: AbStatus =
        action === 'start' || action === 'resume' ? 'running' :
        'paused';
      onLocalUpdate(test.id, {
        status: optimisticStatus,
        ...(action === 'start' && !test.started_at ? { started_at: now } : {}),
      });
      try {
        const r = await fetch(`/api/ab-tests/${test.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r.ok) {
          onLocalUpdate(test.id, prev);
          const err = await r.json().catch(() => null);
          alert(err?.error?.message ?? `${action} failed`);
          return;
        }
        void onRefresh();
      } catch (e) {
        onLocalUpdate(test.id, prev);
        trace.error('TestActions:state-change', e);
      }
    },
    [test.id, test.status, test.started_at, test.ended_at, onRefresh, onLocalUpdate],
  );

  return (
    <div className="flex items-center gap-2 shrink-0">
      {(test.status === 'draft' || test.status === 'paused') && (
        <button
          type="button"
          onClick={() => stateChange(test.status === 'paused' ? 'resume' : 'start')}
          className="h-8 px-4 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-md cursor-pointer"
        >
          {test.status === 'paused' ? 'Resume test' : 'Start test'}
        </button>
      )}
      {test.status === 'running' && (
        <button
          type="button"
          onClick={() => stateChange('pause')}
          className="h-8 px-4 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-md cursor-pointer"
        >
          Pause
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--text-primary)] mt-1 truncate">{value}</p>
    </div>
  );
}

// ─── Goal tile — one card per configured step, surfaces the event
// name + total count + per-variant attribution bar so the user can
// see which event is firing and which variant is winning that event
// at a glance. Mirrors the reference's events row.

function GoalTile({
  goal, total, variants, resultsByVariant, loading = false,
}: {
  goal: AbGoal;
  total: number;
  variants: AbVariant[];
  resultsByVariant: Map<string, VariantResults>;
  /** True while the /results poll hasn't returned yet — keeps the
   *  number + per-variant bars in skeleton state so we don't flash a
   *  misleading "0" before the actual count lands. */
  loading?: boolean;
}) {
  // Friendly target text — what the goal is actually tracking.
  // Pageview goals show the page URL; click/submit/custom show the
  // tracking id. Helps the user disambiguate when several events
  // share the same display name.
  const target =
    goal.type === 'visit'
      ? (goal.pagePath ? pageLabel(goal.pagePath) : '—')
      : (goal.trackingId || '—');

  return (
    // Subtle outlined tile — matches the "+ Create step" dashed
    // placeholder's footprint so the events grid reads as a row of
    // peer cards. Border is the same --control-border the page uses
    // for hairlines elsewhere; padding matches the placeholder so
    // tiles + placeholder line up perfectly.
    <div className="min-w-0 px-4 py-4 border border-[var(--control-border)] rounded-md">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate" title={goal.name || target}>
          {goal.name || target}
        </span>
        <span className="shrink-0">
          <GoalTypeIcon type={goal.type} />
        </span>
      </div>
      <p className="text-[10px] text-[var(--text-tertiary)] mb-3 truncate" title={target}>
        {GOAL_TYPE_LABEL[goal.type]} · {target}
      </p>
      {loading
        ? <Skeleton className="h-7 w-12 mb-3" />
        : <p className="text-2xl font-bold text-[var(--text-primary)] tabular-nums mb-3">
            {total.toLocaleString()}
          </p>}
      {/* Per-variant attribution bar — single horizontal bar where each
          segment's width is that variant's share of this goal's total
          events. Reads as "which variant is driving most of this
          event" without needing a separate legend column. */}
      <div className="space-y-1.5">
        {variants.map((v, i) => {
          const count = lookupGoalCount(resultsByVariant.get(v.id)?.byGoal, goal);
          const pct = total > 0 ? (count / total) * 100 : 0;
          const color = VARIANT_COLORS[i % VARIANT_COLORS.length]!;
          return (
            <div key={v.id} className="flex items-center gap-2 text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="text-[var(--text-secondary)] truncate flex-1 min-w-0" title={v.name}>
                {v.name}
              </span>
              <div className="w-12 h-1.5 rounded-full bg-[var(--grid-line)] overflow-hidden shrink-0">
                {!loading && (
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                )}
              </div>
              {loading
                ? <Skeleton className="h-3 w-6" />
                : <span className="text-[var(--text-secondary)] tabular-nums w-6 text-right shrink-0">
                    {count}
                  </span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Right column: Steps panel ─────────────────────────────────────────────

/** Returns a UI-friendly reason the user can't edit goals / variants /
 *  audience right now, or null when edits are allowed. The backend
 *  enforces the same rules (running tests get 400; concluded tests are
 *  immutable) but we surface the message inline so the user doesn't
 *  hit a browser `alert()` after clicking save. */
function editLockReason(test: AbTestRow): string | null {
  if (test.status === 'running')   return 'Pause the test to edit properties.';
  if (test.status === 'concluded') return 'Concluded tests are read-only.';
  return null;
}

function StepsPanel({
  test, canManage, isStudio, maxGoals, onRefresh, onLocalUpdate,
}: {
  test: AbTestRow;
  canManage: boolean;
  isStudio: boolean;
  maxGoals: number;
  onRefresh: () => Promise<void> | void;
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
}) {
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<AbGoal | 'new' | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const lockReason = editLockReason(test);
  const canEdit = canManage && !lockReason;
  // Plan cap — Pro = 1 goal, Studio = 3. Click + at the cap opens an
  // upgrade prompt instead of the editor (Pro only — Studio is already
  // at the ceiling and gets a different copy line below).
  const atCap = test.goals.length >= maxGoals;

  // Listen for the main column's "+ Create event" placeholder click —
  // fires when the TestCard's empty-events placeholder is pressed.
  // Same gate logic as the inline + button: at the goal cap pro users
  // get the upgrade popover, studio at cap is a no-op.
  const upgradeOnCapForCallback = atCap && !isStudio;
  useEffect(() => {
    const onAddEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { testId?: string } | undefined;
      if (detail?.testId !== test.id) return;
      if (!canEdit) return;
      if (upgradeOnCapForCallback) { setShowUpgrade(true); return; }
      if (atCap) return;
      setEditing('new');
    };
    window.addEventListener('ab-test:add-event', onAddEvent);
    return () => window.removeEventListener('ab-test:add-event', onAddEvent);
  }, [test.id, canEdit, atCap, upgradeOnCapForCallback]);

  const saveGoals = useCallback(async (goals: AbGoal[]) => {
    trace.action('StepsPanel:save', { testId: test.id, count: goals.length });
    // Optimistic — list updates instantly + popup closes; the PATCH
    // happens in the background, silent refresh reconciles.
    const prevGoals = test.goals;
    onLocalUpdate(test.id, { goals });
    setEditing(null);
    try {
      const r = await fetch(`/api/ab-tests/${test.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals }),
      });
      if (!r.ok) {
        onLocalUpdate(test.id, { goals: prevGoals });
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Could not save event');
        return;
      }
      void onRefresh();
    } catch (e) {
      onLocalUpdate(test.id, { goals: prevGoals });
      trace.error('StepsPanel:save', e);
    }
  }, [test.id, test.goals, onRefresh, onLocalUpdate]);

  // Upgrade-prompt for Pro users hitting the goal cap. Studio is
  // already at the ceiling so we just disable the + with a static
  // tooltip instead of offering "upgrade to Studio".
  const upgradeOnCap = atCap && !isStudio;

  return (
    <ToolSection
      title="Steps"
      collapsible={false}
      action={canManage ? (
        <button
          ref={addBtnRef}
          type="button"
          onClick={() => {
            if (!canEdit) return;
            if (upgradeOnCap) { setShowUpgrade(true); return; }
            if (atCap) return;  // Studio at cap — no-op
            setEditing('new');
          }}
          disabled={!canEdit || (atCap && isStudio)}
          title={
            lockReason
              ?? (atCap && isStudio ? 'You\'ve reached the goal limit on this test' : 'Add event')
          }
          className={`w-5 h-5 flex items-center justify-center rounded text-[var(--text-secondary)] ${
            canEdit && !(atCap && isStudio)
              ? 'hover:text-[var(--text-primary)] hover:bg-black/[0.06] dark:hover:bg-white/10 cursor-pointer'
              : 'opacity-40 cursor-not-allowed'
          }`}
        >
          <PlusIcon />
        </button>
      ) : undefined}
    >
     <div className="flex flex-col gap-2 pt-1">
      {/* Single top-of-section lock notice — replaces the per-row
          hover tooltips that cluttered the list while running. */}
      {canManage && lockReason && (
        <p className="text-[11px] text-amber-400/90 leading-relaxed">
          {lockReason}
        </p>
      )}

      {test.goals.length === 0 ? (
        <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
          {canManage ? 'No events yet. Add one to track when a variant converts.' : 'No events.'}
        </p>
      ) : (
        // Flat list — no grey filled pills, just hairline-separated
        // rows like the rest of the settings UI. Hover gets a subtle
        // bg highlight rather than changing the entire row's chrome.
        <ul className="flex flex-col">
          {test.goals.map(g => (
            <li key={g.id} className="border-b border-[var(--border-light)] last:border-b-0">
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => { if (canEdit) setEditing(g); }}
                className={`w-full flex items-center justify-between gap-2 -mx-1 px-1 py-2 rounded-md text-xs transition-colors ${
                  canEdit
                    ? 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer'
                    : 'cursor-default'
                }`}
              >
                <span className="text-[var(--text-primary)] truncate">
                  {g.name || (g.type === 'visit' ? pageLabel(g.pagePath ?? '') : g.trackingId) || 'Untitled'}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                  {GOAL_TYPE_LABEL[g.type]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        // `key` remounts EditStepPopover when the user clicks a
        // different step while the popover is already open — without
        // it the popover keeps the FIRST step's internal state (name /
        // type / pagePath / trackingId all seeded via useState on
        // mount only) and the user has to close + reopen to see the
        // new row's values.
        <EditStepPopover
          key={editing === 'new' ? 'new' : editing.id}
          anchorRef={addBtnRef}
          initial={editing === 'new' ? null : editing}
          lockReason={lockReason}
          onCancel={() => setEditing(null)}
          onSave={(goal) => {
            const next = editing === 'new'
              ? [...test.goals, goal]
              : test.goals.map(g => g.id === goal.id ? goal : g);
            void saveGoals(next);
          }}
          onDelete={editing === 'new' ? undefined : (id) => {
            void saveGoals(test.goals.filter(g => g.id !== id));
          }}
        />
      )}

      {showUpgrade && (
        <UpgradeGoalCapPopover
          anchorRef={addBtnRef}
          currentMax={maxGoals}
          onCancel={() => setShowUpgrade(false)}
          onUpgrade={() => {
            setShowUpgrade(false);
            setSettingsSection('plans');
          }}
        />
      )}
     </div>
    </ToolSection>
  );
}

/** Upgrade prompt that pops out from the Steps + button when a Pro
 *  user tries to add a goal past their plan cap. Replaces the old
 *  browser `alert('Pro allows 1 goal...')` that fired AFTER they'd
 *  filled out the editor — now they never get to fill it out. */
function UpgradeGoalCapPopover({
  anchorRef, currentMax, onCancel, onUpgrade,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  currentMax: number;
  onCancel: () => void;
  onUpgrade: () => void;
}) {
  return (
    <ToolPopup
      isOpen
      onClose={onCancel}
      title="Upgrade plan"
      anchorRef={anchorRef}
      width={260}
    >
      <div className="px-3 py-3 flex flex-col gap-3">
        <p className="text-xs text-[var(--text-primary)] leading-relaxed">
          You've reached {currentMax} goal{currentMax === 1 ? '' : 's'} on the Pro plan. Upgrade to Studio for unlimited conversion goals per test.
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer"
        >
          Upgrade
        </button>
      </div>
    </ToolPopup>
  );
}

// ─── Right column: Options ─────────────────────────────────────────────────

/** Distribution is "even" when every variant carries the same weight
 *  to within ±1 (the backend normalizer absorbs the rounding remainder
 *  onto the first variant, so 33/33/34 should still read as "Even"). */
function isEvenDistribution(variants: AbVariant[]): boolean {
  if (variants.length === 0) return true;
  const target = 100 / variants.length;
  return variants.every(v => Math.abs(v.weight - target) <= 1);
}

function evenWeights(n: number): number[] {
  if (n === 0) return [];
  const base = Math.floor(100 / n);
  const out = Array(n).fill(base);
  out[0] += 100 - base * n;  // absorb rounding remainder onto the first variant
  return out;
}

function OptionsPanel({
  test, canManage, onRefresh, onLocalUpdate,
}: {
  test: AbTestRow;
  canManage: boolean;
  onRefresh: () => Promise<void> | void;
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
}) {
  // Local draft weights so dragging the slider stays smooth (60fps) —
  // we PATCH on pointer-up rather than per-frame. `key`'d by test.id so
  // switching tests via the tab strip resets the draft cleanly.
  const [draft, setDraft] = useState<number[]>(test.variants.map(v => v.weight));
  useEffect(() => {
    setDraft(test.variants.map(v => v.weight));
  }, [test.id, test.variants.map(v => v.weight).join(',')]);

  // Derived: drives the "Make even" button's disabled state (no-op
  // when the variants are already at 100/N within rounding tolerance).
  const isEven = isEvenDistribution(test.variants);

  const saveWeights = useCallback(async (weights: number[]) => {
    trace.action('OptionsPanel:save-weights', { testId: test.id, weights });
    const prevVariants = test.variants;
    const nextVariants = test.variants.map((v, i) => ({ ...v, weight: weights[i] ?? 0 }));
    // Optimistic — the slider already shows the new split via local
    // draft state; this update keeps the parent list in sync so other
    // mounts (e.g. tab strip) reflect the change without a re-fetch.
    onLocalUpdate(test.id, { variants: nextVariants });
    try {
      const r = await fetch(`/api/ab-tests/${test.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: nextVariants }),
      });
      if (!r.ok) {
        onLocalUpdate(test.id, { variants: prevVariants });
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Could not save distribution');
        return;
      }
      void onRefresh();
    } catch (e) {
      onLocalUpdate(test.id, { variants: prevVariants });
      trace.error('OptionsPanel:save-weights', e);
    }
  }, [test.id, test.variants, onRefresh, onLocalUpdate]);

  const lockReason = editLockReason(test);
  const canEdit = canManage && !lockReason;

  const makeEven = () => {
    if (!canEdit) return;
    const w = evenWeights(test.variants.length);
    setDraft(w);
    void saveWeights(w);
  };

  return (
    <ToolSection title="Options" collapsible={false}>
     <div className="flex flex-col gap-1.5 pt-1">
      {/* Single top-of-section lock notice. */}
      {canManage && lockReason && (
        <p className="text-[11px] text-amber-400/90 leading-relaxed">
          {lockReason}
        </p>
      )}
      {/* Distribution row — ToolRow label + a Make-even button that
          fills the right column like the Edit list button in the
          Filters popover. Same h-8 / rounded-lg / w-full so the
          Options panel reads at the same visual weight as the rest
          of the rail's controls. */}
      <ToolRow label="Distribution">
        <button
          type="button"
          onClick={makeEven}
          disabled={!canEdit || isEven}
          title={
            lockReason
              ?? (isEven ? 'Already even' : 'Reset to an even split across variants')
          }
          className="w-full h-8 px-2 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] border border-[var(--control-border)] rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Make even
        </button>
      </ToolRow>

      {test.variants.length >= 2 && (
        <div className="pt-3 pb-1">
          <DistributionSlider
            variants={test.variants}
            weights={draft}
            disabled={!canEdit}
            onPreview={setDraft}
            onCommit={(weights) => {
              setDraft(weights);
              void saveWeights(weights);
            }}
          />
        </div>
      )}

      {/* Variant list with live percentages — hairline-separated rows
          like the Steps / Filters lists for visual consistency. */}
      <ul className="flex flex-col">
        {test.variants.map((v, i) => (
          <li key={v.id} className="flex items-center gap-2 text-xs py-2 border-b border-[var(--border-light)] last:border-b-0">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: VARIANT_COLORS[i % VARIANT_COLORS.length] }}
            />
            <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{v.name}</span>
            <span className="text-[var(--text-tertiary)] text-[10px] tabular-nums shrink-0">
              {Math.round(draft[i] ?? v.weight)}%
            </span>
          </li>
        ))}
      </ul>
     </div>
    </ToolSection>
  );
}

// ─── Distribution slider (N-1 thumbs across [0, 100]) ──────────────────────

function DistributionSlider({
  variants, weights, disabled, onPreview, onCommit,
}: {
  variants: AbVariant[];
  weights: number[];
  disabled: boolean;
  /** Called every pointer-move with the in-flight weights — no PATCH. */
  onPreview: (weights: number[]) => void;
  /** Called once on pointer-up with the final weights — triggers the PATCH. */
  onCommit: (weights: number[]) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ thumbIndex: number; startWeights: number[] } | null>(null);

  // Cumulative thumb positions: thumbs[i] = sum of weights[0..=i]. With N
  // variants there are N-1 draggable thumbs (the last cumulative is fixed
  // at 100). Always read from `weights` so dragging shows the in-flight
  // value, not the committed one.
  const cumulative = weights.reduce<number[]>((acc, w) => {
    acc.push((acc[acc.length - 1] ?? 0) + w);
    return acc;
  }, []);
  const thumbs = cumulative.slice(0, -1);  // drop the trailing 100

  const onThumbDown = useCallback((thumbIndex: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const track = trackRef.current;
    if (!track) return;
    dragRef.current = { thumbIndex, startWeights: [...weights] };

    // Closure-local snapshot of the most recent weights we emitted — the
    // up handler reads from here so it doesn't race React's re-render
    // updating any external ref.
    let latest = [...weights];
    let moved = false;

    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const r = track.getBoundingClientRect();
      const raw = ((ev.clientX - r.left) / r.width) * 100;
      const clamped = Math.max(0, Math.min(100, raw));
      const rounded = Math.round(clamped);

      // Build cumulative from startWeights then update the dragged thumb,
      // re-derive weights, clamp neighbours so no segment goes negative.
      const start = dragRef.current.startWeights;
      const startCum = start.reduce<number[]>((acc, w) => {
        acc.push((acc[acc.length - 1] ?? 0) + w);
        return acc;
      }, []);
      const startThumbs = startCum.slice(0, -1);
      const min = thumbIndex === 0 ? 0 : startThumbs[thumbIndex - 1]!;
      const max = thumbIndex === startThumbs.length - 1 ? 100 : startThumbs[thumbIndex + 1]!;
      const next = Math.max(min, Math.min(max, rounded));

      const nextThumbs = [...startThumbs];
      nextThumbs[thumbIndex] = next;
      // Re-derive weights from the (possibly clamped) thumb positions.
      const nextWeights: number[] = [];
      let prev = 0;
      for (const t of nextThumbs) {
        nextWeights.push(t - prev);
        prev = t;
      }
      nextWeights.push(100 - prev);
      latest = nextWeights;
      moved = true;
      onPreview(nextWeights);
    };

    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // Skip the PATCH on a pure click (no drag) — keeps the network
      // quiet for accidental taps and lets a click-without-drag act as
      // a no-op rather than redundantly re-saving the same weights.
      if (moved) onCommit(latest);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }, [disabled, weights, onPreview, onCommit]);

  // Gradient stripe — solid color per variant, hard stops at the thumb
  // positions so the bar reads as a stack of segments.
  const gradient = (() => {
    const stops: string[] = [];
    let cur = 0;
    weights.forEach((w, i) => {
      const color = VARIANT_COLORS[i % VARIANT_COLORS.length];
      stops.push(`${color} ${cur}%`);
      cur += w;
      stops.push(`${color} ${cur}%`);
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  })();

  return (
    <div className="px-1">
      <div
        ref={trackRef}
        className="relative h-2 rounded-full"
        style={{ background: gradient }}
      >
        {thumbs.map((pos, i) => (
          <button
            key={i}
            type="button"
            onPointerDown={onThumbDown(i)}
            disabled={disabled}
            aria-label={`Distribution thumb ${i + 1}`}
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow-md ring-2 ring-[var(--bg-surface)] ${
              disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing hover:scale-110'
            } transition-transform`}
            style={{ left: `${pos}%` }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Right column: Filters (audience segmentation, Studio-only) ────────────

/** One UI row per populated audience dimension. The audience JSON is
 *  flat (`{ country, device, source, cookie }`) but the UI treats each
 *  dimension as a separately-editable entry so the Studio user can add /
 *  remove dimensions one at a time. */
type FilterDimension = 'country' | 'device' | 'source' | 'cookie';

const FILTER_LABEL: Record<FilterDimension, string> = {
  country: 'Country',
  device:  'Device',
  source:  'Source',
  cookie:  'Cookie',
};

interface FilterRow {
  dimension: FilterDimension;
  /** Human-readable summary rendered next to the dimension label. */
  summary: string;
}

function audienceRows(audience: AbAudience | null): FilterRow[] {
  if (!audience) return [];
  const rows: FilterRow[] = [];
  if (audience.country?.length) rows.push({ dimension: 'country', summary: audience.country.join(', ') });
  if (audience.device?.length)  rows.push({ dimension: 'device',  summary: audience.device.join(', ') });
  if (audience.source?.length)  rows.push({ dimension: 'source',  summary: audience.source.join(', ') });
  if (audience.cookie?.trim())  rows.push({ dimension: 'cookie',  summary: audience.cookie });
  return rows;
}

function FiltersPanel({
  test, canManage, isStudio, onRefresh, onLocalUpdate,
}: {
  test: AbTestRow;
  canManage: boolean;
  isStudio: boolean;
  onRefresh: () => Promise<void> | void;
  onLocalUpdate: (testId: string, patch: Partial<AbTestRow>) => void;
}) {
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<FilterDimension | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const setSettingsSection = useSetAtom(settingsSectionAtom);

  const lockReason = editLockReason(test);
  const canEdit = canManage && isStudio && !lockReason;
  const rows = audienceRows(test.audience);
  // All four dimensions filled — clicking + is a no-op, same UX as Steps
  // at-cap (Studio there gets the disabled state).
  const atCap = rows.length >= 4;
  // Pro users see a locked + that opens an upgrade popover; the panel
  // copy line below also nudges toward Studio.
  const upgradeOnClick = canManage && !isStudio && !lockReason;

  const saveAudience = useCallback(async (next: AbAudience | null) => {
    const normalized = normalizeAudience(next);
    trace.action('FiltersPanel:save', { testId: test.id, audience: normalized });
    const prev = test.audience;
    onLocalUpdate(test.id, { audience: normalized });
    setEditing(null);
    try {
      const r = await fetch(`/api/ab-tests/${test.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience: normalized }),
      });
      if (!r.ok) {
        onLocalUpdate(test.id, { audience: prev });
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Could not save filter');
        return;
      }
      void onRefresh();
    } catch (e) {
      onLocalUpdate(test.id, { audience: prev });
      trace.error('FiltersPanel:save', e);
    }
  }, [test.id, test.audience, onRefresh, onLocalUpdate]);

  const removeDimension = (dim: FilterDimension) => {
    const cur = test.audience ?? {};
    const next: AbAudience = { ...cur };
    delete next[dim];
    void saveAudience(audienceIsEmpty(next) ? null : next);
  };

  return (
    <ToolSection
      title="Filters"
      collapsible={false}
      action={canManage ? (
        <button
          ref={addBtnRef}
          type="button"
          onClick={() => {
            if (upgradeOnClick) { setShowUpgrade(true); return; }
            if (!canEdit) return;
            if (atCap) return;
            // Pick the first dimension that's not already configured —
            // user can swap to a different one inside the popover.
            const taken = new Set(rows.map(r => r.dimension));
            const next = (['country', 'device', 'source', 'cookie'] as FilterDimension[])
              .find(d => !taken.has(d));
            setEditing(next ?? 'country');
          }}
          disabled={!canManage || (isStudio && (!!lockReason || atCap))}
          title={
            !isStudio
              ? 'Audience filters require Studio'
              : lockReason
                ?? (atCap ? 'All dimensions configured' : 'Add filter')
          }
          className={`w-5 h-5 flex items-center justify-center rounded text-[var(--text-secondary)] ${
            canEdit && !atCap
              ? 'hover:text-[var(--text-primary)] hover:bg-black/[0.06] dark:hover:bg-white/10 cursor-pointer'
              : upgradeOnClick
                ? 'hover:text-[var(--text-primary)] hover:bg-black/[0.06] dark:hover:bg-white/10 cursor-pointer'
                : 'opacity-40 cursor-not-allowed'
          }`}
        >
          <PlusIcon />
        </button>
      ) : undefined}
    >
     <div className="flex flex-col gap-2 pt-1">
      {/* Single top-of-section lock notice — covers every row. */}
      {canManage && lockReason && (
        <p className="text-[11px] text-amber-400/90 leading-relaxed">
          {lockReason}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
          {isStudio
            ? 'No filters yet. Add one to segment by device, country, referrer, or cookie.'
            : 'Segment by Device / Country / Source / Cookie. Available on Studio.'}
        </p>
      ) : (
        // Same minimal hairline pattern as StepsPanel — no grey pills,
        // just rows separated by 1px lines.
        <ul className="flex flex-col">
          {rows.map(r => (
            <li key={r.dimension} className="border-b border-[var(--border-light)] last:border-b-0">
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => { if (canEdit) setEditing(r.dimension); }}
                className={`w-full flex items-center justify-between gap-2 -mx-1 px-1 py-2 rounded-md text-xs transition-colors ${
                  canEdit
                    ? 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer'
                    : 'cursor-default'
                }`}
              >
                <span className="text-[var(--text-primary)] truncate">
                  {FILTER_LABEL[r.dimension]}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 truncate max-w-[100px]" title={r.summary}>
                  {r.summary}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && canEdit && (
        // Same key trick as StepsPanel — clicking a different filter
        // row while the popover is open must remount the editor so
        // the per-dimension inputs (countryCodes / deviceSet / etc.)
        // reseed from the newly-selected dimension's audience values
        // instead of holding the previous row's state.
        <EditFilterPopover
          key={editing}
          anchorRef={addBtnRef}
          dimension={editing}
          audience={test.audience}
          existingDimensions={new Set(rows.map(r => r.dimension))}
          lockReason={lockReason}
          onCancel={() => setEditing(null)}
          onSave={(next) => { void saveAudience(next); }}
          onDelete={() => removeDimension(editing)}
        />
      )}

      {showUpgrade && (
        <UpgradeFiltersPopover
          anchorRef={addBtnRef}
          onCancel={() => setShowUpgrade(false)}
          onUpgrade={() => {
            setShowUpgrade(false);
            setSettingsSection('plans');
          }}
        />
      )}
     </div>
    </ToolSection>
  );
}

/** Upgrade prompt for Pro users hitting the Filters + button. Mirrors
 *  UpgradeGoalCapPopover; the only difference is copy. */
function UpgradeFiltersPopover({
  anchorRef, onCancel, onUpgrade,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onUpgrade: () => void;
}) {
  return (
    <ToolPopup
      isOpen
      onClose={onCancel}
      title="Upgrade plan"
      anchorRef={anchorRef}
      width={260}
    >
      <div className="px-3 py-3 flex flex-col gap-3">
        <p className="text-xs text-[var(--text-primary)] leading-relaxed">
          Audience filters segment traffic by country, device, referrer, or cookie. Upgrade to Studio to use them.
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer"
        >
          Upgrade
        </button>
      </div>
    </ToolPopup>
  );
}

/** Per-dimension editor. Dimension Select on top lets the user swap
 *  between Country / Device / Source / Cookie without closing the
 *  popover; the body swaps to match. On Save we merge the edit back
 *  into the existing audience JSON. */
function EditFilterPopover({
  anchorRef, dimension: initialDimension, audience, existingDimensions, lockReason, onCancel, onSave, onDelete,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  dimension: FilterDimension;
  audience: AbAudience | null;
  /** Dimensions already configured — used by the dimension picker to
   *  disable rows the user would otherwise overwrite. The currently-
   *  editing dimension is allowed through (it's the one being changed). */
  existingDimensions: Set<FilterDimension>;
  lockReason: string | null;
  onCancel: () => void;
  onSave: (audience: AbAudience | null) => void;
  /** Only present when editing an EXISTING dimension. New-dimension
   *  flow hides the Delete button (there's nothing to delete yet). */
  onDelete?: () => void;
}) {
  const [dimension, setDimension] = useState<FilterDimension>(initialDimension);
  const seed = audience ?? {};
  // Country edits go through a slide-in subpanel (CountryPicker) with a
  // searchable list — too many options for an inline text field. The
  // state here is the canonical selection; CountryRow renders chips +
  // the "Edit list" button that pushes the picker.
  const [countryCodes, setCountryCodes] = useState<string[]>(seed.country ?? []);
  const [deviceSet, setDeviceSet] = useState<Set<AbAudienceDevice>>(new Set(seed.device ?? []));
  const [sourceText, setSourceText] = useState((seed.source ?? []).join(', '));
  const [cookieText, setCookieText] = useState(seed.cookie ?? '');

  const isExisting = existingDimensions.has(initialDimension);

  // Validity per dimension — Save is disabled until the user has put
  // something in the active field. Cookie validation requires `name=value`
  // shape (a bare name without an `=` is meaningless to the worker).
  const valid = (() => {
    if (dimension === 'country') return countryCodes.length > 0;
    if (dimension === 'device')  return deviceSet.size > 0;
    if (dimension === 'source')  return parseCommaList(sourceText).length > 0;
    if (dimension === 'cookie')  return /^[^=\s]+=.+/.test(cookieText.trim());
    return false;
  })();

  const submit = () => {
    if (!valid) return;
    // Start from the existing audience and overlay the edited dimension.
    // If the user swapped dimensions inside the popover (e.g. opened
    // for "country", picked "device"), we still only write the picked one.
    const next: AbAudience = { ...(audience ?? {}) };
    // Clear the dimension we OPENED with — if the user swapped, we're
    // replacing the open one with a different dimension, so the original
    // shouldn't linger.
    if (initialDimension !== dimension) delete next[initialDimension];
    if (dimension === 'country') next.country = countryCodes;
    if (dimension === 'device')  next.device  = [...deviceSet];
    if (dimension === 'source')  next.source  = parseCommaList(sourceText).map(s => s.toLowerCase());
    if (dimension === 'cookie')  next.cookie  = cookieText.trim();
    onSave(next);
  };

  const dimensionOptions = (['country', 'device', 'source', 'cookie'] as FilterDimension[]).map(d => ({
    value: d,
    label: FILTER_LABEL[d] + (
      // Mark dimensions other than the one we opened with as "(in use)"
      // when they're already configured — the user can still pick them,
      // but they'll be overwritten on save.
      d !== initialDimension && existingDimensions.has(d) ? ' (replace)' : ''
    ),
  }));

  return (
    <ToolPopup
      isOpen
      onClose={onCancel}
      title={isExisting ? 'Edit filter' : 'New filter'}
      anchorRef={anchorRef}
      width={260}
    >
      {/* No `px-3 py-3` wrapper here — ToolPopup already supplies that
          via its inner panel chrome. The extra padding doubled the gap
          between rows and made the popover feel airy. We just stack
          rows directly with `gap-2` so every gap (between form rows AND
          before the action row) is the same 8px. */}
      <div className="flex flex-col gap-2">
        <ToolRow label="Dimension">
          <ToolSelect
            value={dimension}
            onChange={(v) => setDimension(v as FilterDimension)}
            options={dimensionOptions}
          />
        </ToolRow>

        {dimension === 'country' && (
          <CountryRow codes={countryCodes} onChange={setCountryCodes} />
        )}

        {dimension === 'device' && (
          // Custom row: "Devices" label top-aligned on the left, stacked
          // Mobile/Tablet/Desktop column on the right. Mirrors ToolRow's
          // 3/4 + full split (and matching `text-[11px] font-bold` label
          // styling) so it sits in line with the Dimension row above —
          // just with `items-start` instead of center so the label
          // anchors to the first row in the stack.
          <div className="flex items-start justify-between w-full">
            <div className="w-3/4 select-none pt-1.5">
              <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                Devices
              </span>
            </div>
            <div className="flex flex-col gap-1 w-full">
              {(['mobile', 'tablet', 'desktop'] as AbAudienceDevice[]).map(d => {
                const active = deviceSet.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      const next = new Set(deviceSet);
                      if (active) next.delete(d); else next.add(d);
                      setDeviceSet(next);
                    }}
                    className={`w-full flex items-center gap-2 h-8 px-2 text-xs rounded-md cursor-pointer border transition-colors ${
                      active
                        ? 'bg-[var(--accent)]/15 border-[var(--accent)] text-[var(--text-primary)]'
                        : 'bg-[var(--grid-line)] border-[var(--control-border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-[3px] flex items-center justify-center border ${
                        active
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-fg)]'
                          : 'border-[var(--control-border)]'
                      }`}
                    >
                      {active && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span>{d[0].toUpperCase() + d.slice(1)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {dimension === 'source' && (
          <ToolRow label="Hosts">
            <ToolInput value={sourceText} onChange={setSourceText} text />
          </ToolRow>
        )}
        {dimension === 'source' && (
          <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed -mt-1">
            Referrer hostnames, comma-separated. Example: <span className="font-mono">google.com, x.com</span>
          </p>
        )}

        {dimension === 'cookie' && (
          <ToolRow label="Match">
            <ToolInput value={cookieText} onChange={setCookieText} text />
          </ToolRow>
        )}
        {dimension === 'cookie' && (
          <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed -mt-1">
            Exact <span className="font-mono">name=value</span> the visitor must carry.
          </p>
        )}

        {lockReason && (
          <p className="text-[11px] text-amber-400/90 leading-relaxed mt-1">
            {lockReason}
          </p>
        )}

        {/* Same ToolRow geometry as the Dimension / Countries / Device
            rows above. Delete (or Cancel for new filter) sits in the
            label column (w-3/4); Save sits in the content column
            (w-full) so it aligns under the inputs above. */}
        <div className="flex items-center justify-between w-full">
          {/* `pr-2` eats from the Delete column's content area only —
              the column basis stays at w-3/4, so flex-shrink gives
              the right column the exact same ~57% width as the
              inputs above (no offset to Save). The 8px appears as a
              visible gap between Delete and Save. */}
          <div className="w-3/4 pr-2">
            {isExisting && onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={!!lockReason}
                title={lockReason ?? undefined}
                className="w-full h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete
              </button>
            ) : (
              <button
                type="button"
                onClick={onCancel}
                className="w-full h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-lg)] cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 w-full">
            <button
              type="button"
              onClick={submit}
              disabled={!valid || !!lockReason}
              title={lockReason ?? undefined}
              className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </ToolPopup>
  );
}

function parseCommaList(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(',')) {
    const v = part.trim();
    if (v.length > 0) seen.add(v);
  }
  return [...seen];
}

// ─── Country row + picker ──────────────────────────────────────────────────

/** Country dimension row inside EditFilterPopover. Renders selected
 *  countries as chips (with full English names) and a button that
 *  pushes the search/multi-select picker into the ToolPopup's panel
 *  stack — the picker slides in from the right just like the rest of
 *  the canvas tools' sub-editors (ColorPicker, etc.). */
function CountryRow({
  codes, onChange,
}: {
  codes: string[];
  onChange: (codes: string[]) => void;
}) {
  const { pushPanel } = useToolPopup();

  const openPicker = () => {
    // Render-function form so the picker re-reads `codes` from parent
    // state on each ToolPopup render — the picker itself owns the
    // checkbox state, but propagating it up here keeps the popover's
    // Save flow and the chip preview in sync without an extra refresh.
    pushPanel('Countries', () => (
      <CountryPicker initial={codes} onChange={onChange} />
    ));
  };

  // The Edit-list button and each selected-country pill all stack in
  // the right column at the same width + height (h-8) as the Dimension
  // dropdown above. We use ToolRow for the labelled button row so it
  // visually aligns with Dimension, then render each selected country
  // as its own labelless ToolRow-shaped row beneath it.
  return (
    <div className="flex flex-col gap-1.5">
      <ToolRow label="Countries">
        <button
          type="button"
          onClick={openPicker}
          className="w-full h-8 px-2 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] border border-[var(--control-border)] rounded-[var(--radius-lg)] cursor-pointer flex items-center justify-between"
        >
          <span>{codes.length === 0 ? 'Choose…' : 'Edit list'}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </ToolRow>

      {codes.map(code => (
        // Inline ToolRow's exact geometry (w-3/4 label slot + flex
        // items-center gap-2 w-full content wrapper) so the chip sits
        // pixel-aligned with the Edit list button above. Extra `min-w-0`
        // on the right wrapper is what ToolRow itself doesn't have —
        // and it's the missing piece that lets `truncate` actually clip
        // long country names ("American Samoa") instead of expanding
        // the row beyond its siblings.
        <div key={code} className="flex items-center justify-between w-full">
          <div className="w-3/4 select-none" aria-hidden />
          <div className="flex items-center gap-2 w-full min-w-0">
            <div className="w-full min-w-0 h-8 pl-2 pr-1 flex items-center gap-2 bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-xs text-[var(--text-primary)] overflow-hidden">
              <span className="font-mono text-[var(--text-secondary)] w-6 shrink-0">{code}</span>
              <span
                className="flex-1 min-w-0 truncate"
                title={COUNTRY_BY_CODE[code] ?? code}
              >
                {COUNTRY_BY_CODE[code] ?? code}
              </span>
              <button
                type="button"
                onClick={() => onChange(codes.filter(c => c !== code))}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
                aria-label={`Remove ${code}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Searchable multi-select country list. Pushed into ToolPopup as a
 *  sub-panel via pushPanel; the popup's built-in back arrow returns to
 *  the EditFilterPopover root. Owns its own selection state seeded once
 *  from `initial`; every toggle is reported back via `onChange` so the
 *  parent's chip preview stays live. */
function CountryPicker({
  initial, onChange,
}: {
  initial: string[];
  onChange: (codes: string[]) => void;
}) {
  // Local working selection — Set for O(1) toggle. Seeded from `initial`
  // once at mount. Subsequent prop changes don't re-seed (the user is
  // actively editing; we'd thrash their work).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the search field on push. The popup's height-spring runs
  // for ~350ms; focusing after a rAF keeps it from competing with the
  // slide animation.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const toggle = (code: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      onChange([...next]);
      return next;
    });
  };

  const results = searchCountries(query);
  const selectedCount = selected.size;

  return (
    // Bare column — ToolPopup already adds `px-3 pb-3 pt-1` chrome
    // around panel content. Same reason as EditFilterPopover above.
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] pointer-events-none"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or code…"
          className="w-full h-8 pl-7 pr-2 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors"
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
        <span>{results.length} {results.length === 1 ? 'country' : 'countries'}</span>
        <span>{selectedCount} selected</span>
      </div>

      <div className="max-h-[280px] overflow-y-auto -mx-1 px-1">
        {results.length === 0 ? (
          <p className="text-[11px] text-[var(--text-tertiary)] py-4 text-center">
            No match for &ldquo;{query}&rdquo;
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {results.map(c => {
              const active = selected.has(c.code);
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => toggle(c.code)}
                    className={`w-full flex items-center gap-2 h-7 px-2 text-xs rounded-md cursor-pointer transition-colors ${
                      active
                        ? 'bg-[var(--accent)]/15 text-[var(--text-primary)]'
                        : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-[3px] flex items-center justify-center border ${
                        active
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-fg)]'
                          : 'border-[var(--control-border)]'
                      }`}
                    >
                      {active && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] w-6">{c.code}</span>
                    <span className="truncate text-left flex-1">{c.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}


function FilterDimensionIcon({ dim }: { dim: FilterDimension }) {
  const color =
    dim === 'country' ? '#3b82f6' :
    dim === 'device'  ? '#10b981' :
    dim === 'source'  ? '#f97316' :
                        '#a855f7';
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] shrink-0"
      style={{ backgroundColor: color + '22', color }}
    >
      {dim === 'country' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M2 12H22" /><path d="M12 2A15.3 15.3 0 0116 12 15.3 15.3 0 0112 22 15.3 15.3 0 018 12 15.3 15.3 0 0112 2Z" />
        </svg>
      )}
      {dim === 'device' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18H12" />
        </svg>
      )}
      {dim === 'source' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13A5 5 0 0010 21H14A5 5 0 0014 13M14 11A5 5 0 0014 3H10A5 5 0 0010 11" />
        </svg>
      )}
      {dim === 'cookie' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><circle cx="9" cy="10" r="0.5" /><circle cx="15" cy="14" r="0.5" /><circle cx="9" cy="15" r="0.5" />
        </svg>
      )}
    </span>
  );
}

// ─── Edit step popover ─────────────────────────────────────────────────────

/** ToolPopup-based step editor. Matches the rest of the canvas tools'
 *  popup UX: opens a 260-px floating panel anchored to the trigger, slides
 *  in from below, ESC + outside-click + back-arrow close it. Uses
 *  ToolRow / ToolInput / ToolSelect so the form rows are visually
 *  identical to e.g. SizeTool's width/height row. */
function EditStepPopover({
  anchorRef, initial, lockReason, onCancel, onSave, onDelete,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  initial: AbGoal | null;
  /** When set, Save + Delete are disabled and an inline notice tells
   *  the user why (e.g. "Pause the test to edit."). The popover stays
   *  open as a read-only view so the user can still see what's
   *  configured. */
  lockReason: string | null;
  onCancel: () => void;
  onSave: (goal: AbGoal) => void;
  onDelete?: (id: string) => void;
}) {
  const pages = useProjectPages();
  const trackingIds = useProjectTrackingIds();
  const datalistId = React.useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AbGoalType>(initial?.type ?? 'visit');
  const [pagePathInput, setPagePathInput] = useState(
    initial?.pagePath ?? pages[0]?.apiPath ?? '',
  );
  const [trackingId, setTrackingId] = useState(initial?.trackingId ?? '');

  const valid = type === 'visit'
    ? pagePathInput.trim().length > 0
    : trackingId.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSave({
      id: initial?.id ?? `g_${Math.random().toString(36).slice(2, 10)}`,
      type,
      name: name.trim() || undefined,
      pagePath: type === 'visit' ? pagePathInput.trim() : undefined,
      trackingId: type !== 'visit' ? trackingId.trim() : undefined,
    });
  };

  return (
    <ToolPopup
      isOpen
      onClose={onCancel}
      title={initial ? 'Edit step' : 'New step'}
      anchorRef={anchorRef}
      width={260}
    >
      {/* Same fix as EditFilterPopover / CountryPicker: ToolPopup
          already wraps panel content in `px-3 pb-3 pt-1`, so an inner
          `px-3 py-3` doubled the padding and made the popup feel airy.
          `gap-2` keeps every row spacing (incl. before the action row)
          at a consistent 8px. */}
      <div className="flex flex-col gap-2">
        <ToolRow label="Name">
          <ToolInput
            value={name}
            onChange={setName}
            text
          />
        </ToolRow>

        <ToolRow label="Type">
          <ToolSelect
            value={type}
            onChange={(v) => setType(v as AbGoalType)}
            options={[
              { value: 'visit',  label: 'Pageview'    },
              { value: 'click',  label: 'Click'       },
              { value: 'submit', label: 'Form Submit' },
              { value: 'custom', label: 'Custom'      },
            ]}
          />
        </ToolRow>

        {type === 'visit' ? (
          <ToolRow label="Page">
            <ToolSelect
              value={pagePathInput}
              onChange={setPagePathInput}
              options={pages.length === 0
                ? [{ value: '', label: '(no pages)' }]
                : pages.map(p => ({ value: p.apiPath, label: p.label }))
              }
            />
          </ToolRow>
        ) : (
          <ToolRow label={type === 'submit' ? 'Form ID' : 'Tracking ID'}>
            <div className="relative w-full">
              {/* Combobox: free type + native dropdown of every
                  data-revyme-track value found in the project. The
                  native <datalist> renders an OS-styled menu under the
                  input so we don't need to ship a custom popover. */}
              <input
                type="text"
                list={trackingIds.length > 0 ? datalistId : undefined}
                value={trackingId}
                onChange={(e) => setTrackingId(e.target.value)}
                placeholder={type === 'click' ? 'cta-hero' : type === 'submit' ? 'signup-form' : 'purchase-complete'}
                className="w-full h-8 pl-2 pr-2 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors"
              />
              {trackingIds.length > 0 && (
                <datalist id={datalistId}>
                  {trackingIds.map(id => <option key={id} value={id} />)}
                </datalist>
              )}
            </div>
          </ToolRow>
        )}

        {lockReason && (
          <p className="text-[11px] text-amber-400/90 leading-relaxed mt-1">
            {lockReason}
          </p>
        )}

        {/* Footer — same ToolRow geometry as the Name / Type / Page
            rows above. Delete (or Cancel for new steps) sits in the
            label column (w-3/4 basis → ~43% after flex-shrink); Save
            sits in the content column (w-full basis → ~57%). That
            makes the action row visually align with the form rows
            above — Save sits exactly under the inputs. */}
        <div className="flex items-center justify-between w-full">
          {/* `pr-2` eats from the Delete column's content area only —
              the column basis stays at w-3/4, so flex-shrink gives
              the right column the exact same ~57% width as the
              inputs above (no offset to Save). The 8px appears as a
              visible gap between Delete and Save. */}
          <div className="w-3/4 pr-2">
            {initial && onDelete ? (
              <button
                type="button"
                onClick={() => onDelete(initial.id)}
                disabled={!!lockReason}
                title={lockReason ?? undefined}
                className="w-full h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete
              </button>
            ) : (
              <button
                type="button"
                onClick={onCancel}
                className="w-full h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-lg)] cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 w-full">
            <button
              type="button"
              onClick={submit}
              disabled={!valid || !!lockReason}
              title={lockReason ?? undefined}
              className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </ToolPopup>
  );
}

// ─── Icons (inline so we don't pull in @/shared/icons for two glyphs) ──────

function GoalTypeIcon({ type }: { type: AbGoalType }) {
  const color =
    type === 'visit'  ? '#3b82f6' :
    type === 'click'  ? '#10b981' :
    type === 'submit' ? '#f97316' :
                        '#a855f7';
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] shrink-0"
      style={{ backgroundColor: color + '22', color }}
    >
      {type === 'visit' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12L5 10L12 4L19 10L21 12" /><path d="M5 10V20H19V10" />
        </svg>
      )}
      {type === 'click' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11L4 6L9 1" /><path d="M20 21V11A4 4 0 0016 7H4" />
        </svg>
      )}
      {type === 'submit' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10H21" />
        </svg>
      )}
      {type === 'custom' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
      )}
    </span>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

