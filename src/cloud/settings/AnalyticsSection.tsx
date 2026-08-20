// AnalyticsSection.tsx — Site analytics: visitors, views, charts, data tables.
// Extracted from SettingsOverlay for plugin-based registration.
//
// Plan gating (Spotify model): Free shows the chart + totals only; the
// 30/90-day range buttons and the breakdown grid (pages/countries/sources/
// devices) get locked overlays prompting to upgrade to Lite.

import React, { useState, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { settingsSectionAtom } from '@/code/stores/website-settings-store';
import { Skeleton } from '@/editor/overlays/settings-shared';
import { trace } from '@/shared/debug-trace';

// ─── Inline helpers ────────────────────────────────────────────────────────

const LoadingSpinner = ({ size = 'sm', className = '' }: { size?: 'sm' | 'md'; className?: string }) => (
  <svg className={`animate-spin ${size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} ${className}`} viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// ─── AnalyticsSection ───────────────────────────────────────────────────────

interface AnalyticsSectionProps {
  websiteId: string;
}

export default function AnalyticsSection({ websiteId }: AnalyticsSectionProps) {
  const setActiveSection = useSetAtom(settingsSectionAtom);

  // ─── State ─────────────────────────────────────────────────────────
  const [siteAnalytics, setSiteAnalytics] = useState<{
    totalViews: number;
    uniqueVisitors: number;
    topPages: Array<{ path: string; views: number }>;
    topCountries: Array<{ country: string; views: number }>;
    topSources: Array<{ source: string; views: number }>;
    topDevices: Array<{ device: string; views: number }>;
    viewsByDay: Array<{ date: string; views: number }>;
    advanced: boolean;
  } | null>(null);
  const [siteAnalyticsLoading, setSiteAnalyticsLoading] = useState(true);
  const [siteAnalyticsTimeRange, setSiteAnalyticsTimeRange] = useState<7 | 30 | 90>(7);

  // Advanced = Lite or higher. Free sees a curtailed view.
  //
  // While the fetch is in flight `siteAnalytics` is null, so we default
  // to `true` — this keeps the curtailed/upsell UI hidden until we
  // actually know the plan. Otherwise an already-Pro user would flash
  // a misleading "Upgrade to Lite" panel during the load.
  const isAdvanced = siteAnalytics?.advanced ?? true;

  // ─── Fetch analytics ──────────────────────────────────────────────

  useEffect(() => {
    if (!websiteId) return;
    trace.fn('analytics-section:fetch', { websiteId, range: siteAnalyticsTimeRange });

    const fetchSiteAnalytics = async () => {
      setSiteAnalyticsLoading(true);
      try {
        const response = await fetch(`/api/analytics?websiteId=${websiteId}&days=${siteAnalyticsTimeRange}`);
        if (response.ok) {
          const data = await response.json();
          setSiteAnalytics(data);
        }
      } catch (error) {
        trace.error('analytics-section:fetch', error);
      } finally {
        setSiteAnalyticsLoading(false);
      }
    };
    fetchSiteAnalytics();
  }, [websiteId, siteAnalyticsTimeRange]);

  // No early-return loading/empty branches — the page chrome (Analytics
  // header, time-range buttons, summary tiles, breakdown panels) is
  // static and renders immediately. Tiles + chart skeleton the dynamic
  // numbers inside while siteAnalyticsLoading is true (handled below
  // by conditionally rendering values vs. <Skeleton/>).
  if (!siteAnalyticsLoading && !siteAnalytics) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-[var(--text-tertiary)]">No analytics data available</p>
      </div>
    );
  }

  // ─── Chart data ────────────────────────────────────────────────────
  // Default to empty arrays during the initial fetch so the
  // breakdown panels render their "no data yet" placeholder instead
  // of crashing on null access.
  const maxPageViews = Math.max(...(siteAnalytics?.topPages?.map(p => p.views) || [1]));
  const maxSourceViews = Math.max(...(siteAnalytics?.topSources?.map(s => s.views) || [1]));
  const maxCountryViews = Math.max(...(siteAnalytics?.topCountries?.map(c => c.views) || [1]));
  const maxDeviceViews = Math.max(...(siteAnalytics?.topDevices?.map(d => d.views) || [1]));

  // Flat bar table — no card wrapper, no inner padding. Same chrome as
  // an A/B test's variants table: section label on top in 10px caps,
  // rows are flush-left text + flush-right number with a subtle bar
  // sliver behind them showing the share-of-max.
  const renderBarTable = (title: string, data: any[], maxValue: number, valueKey: string, countKey: string) => (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">{title}</p>
      <div className="space-y-px">
        {data.length > 0 ? data.slice(0, 7).map((item: any, i: number) => {
          const percentage = maxValue > 0 ? (item[countKey] / maxValue) * 100 : 0;
          return (
            <div key={i} className="relative group">
              <div className="absolute left-0 top-0 h-full bg-white/[0.04] cut-corners transition-all duration-300" style={{ width: `${percentage}%` }} />
              <div className="relative flex items-center justify-between py-1.5 px-2 cut-corners hover:bg-white/5 transition-colors">
                <span className="text-xs text-[var(--text-primary)] truncate">{item[valueKey]}</span>
                <span className="text-xs font-medium text-[var(--text-secondary)] ml-2 tabular-nums">{item[countKey]}</span>
              </div>
            </div>
          );
        }) : (
          <p className="text-xs text-[var(--text-tertiary)] py-4">No data yet</p>
        )}
      </div>
    </div>
  );

  // Views chart
  const viewsData = siteAnalytics?.viewsByDay || [];
  const maxViews = Math.max(...viewsData.map(d => d.views), 1);
  const chartHeight = 200;
  const chartPadding = 20;
  const chartPoints = viewsData.map((item, i) => ({
    x: viewsData.length > 1 ? (i / (viewsData.length - 1)) * 100 : 50,
    y: chartHeight - (item.views / maxViews) * (chartHeight - chartPadding * 2) - chartPadding,
    views: item.views, date: item.date,
  }));
  let smoothPath = '';
  let smoothAreaPath = '';
  if (chartPoints.length > 0) {
    smoothPath = `M ${chartPoints[0].x} ${chartPoints[0].y}`;
    smoothAreaPath = `M 0 ${chartHeight} L 0 ${chartPoints[0].y}`;
    for (let i = 0; i < chartPoints.length - 1; i++) {
      const c = chartPoints[i], n = chartPoints[i + 1];
      const mx = (c.x + n.x) / 2, my = (c.y + n.y) / 2;
      smoothPath += ` Q ${c.x} ${c.y}, ${mx} ${my} Q ${n.x} ${n.y}, ${n.x} ${n.y}`;
      smoothAreaPath += ` Q ${c.x} ${c.y}, ${mx} ${my} Q ${n.x} ${n.y}, ${n.x} ${n.y}`;
    }
    smoothAreaPath += ` L 100 ${chartHeight} Z`;
  }

  // ─── Render ────────────────────────────────────────────────────────

  // Flat, no-card layout. Same rules as PageAbTestDetail: sections are
  // separated by hairline `border-b border-[var(--border-light)]` only,
  // never enclosed in cards/panels. Section labels are 10px uppercase
  // (`text-tertiary`). Values are the focal point — no chrome competing
  // with them. Hardcoded text (section labels, range buttons) renders
  // immediately; only the dynamic values fall back to skeletons so the
  // layout doesn't reflow on load.
  return (
    <div>
      {/* Header — page title + range selector. Borderless to match the
          A/B detail page's top header row. The bottom border of this
          row is provided by the stats-overview row below (pb-6 +
          border-b), keeping the dividing line consistent. */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Analytics</h3>
          <p className="text-xs text-[var(--text-secondary)]">Traffic across this site.</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {[{ label: '7 days', value: 7 }, { label: '30 days', value: 30 }, { label: '90 days', value: 90 }].map((range) => {
            // Free tier locks the 30/90 buttons. They render with a small
            // "Lite" badge so the upsell is obvious without an extra
            // tooltip.
            const locked = !isAdvanced && range.value !== 7;
            const active = siteAnalyticsTimeRange === range.value;
            return (
              <button
                key={range.value}
                type="button"
                onClick={() => locked ? setActiveSection('plans') : setSiteAnalyticsTimeRange(range.value as 7 | 30 | 90)}
                title={locked ? 'Upgrade to Lite for longer windows' : undefined}
                className={`h-8 px-3 text-xs font-medium cut-corners transition-colors cursor-pointer ${
                  active
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                } ${locked ? 'opacity-70' : ''}`}
              >
                {range.label}
                {locked && (
                  <span className="ml-1.5 text-[9px] font-semibold text-[var(--accent-text)] uppercase tracking-wide">Lite</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Stats Overview — flat 4-column row, same idiom as A/B's
          Status / Winner / Summary header strip. Labels in 10px caps,
          values in text-2xl with a stable line-height so the skeleton
          → real-value swap is a no-shift transition. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pb-6 border-b border-[var(--border-light)]">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Unique Visitors</p>
          {siteAnalyticsLoading
            ? <Skeleton className="h-7 w-20" />
            : <div className="text-2xl font-bold text-[var(--text-primary)] leading-7 tabular-nums">{siteAnalytics?.uniqueVisitors.toLocaleString()}</div>}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Total Views</p>
          {siteAnalyticsLoading
            ? <Skeleton className="h-7 w-20" />
            : <div className="text-2xl font-bold text-[var(--text-primary)] leading-7 tabular-nums">{siteAnalytics?.totalViews.toLocaleString()}</div>}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Avg. per Visitor</p>
          {siteAnalyticsLoading
            ? <Skeleton className="h-7 w-16" />
            : <div className="text-2xl font-bold text-[var(--text-primary)] leading-7 tabular-nums">
                {(siteAnalytics?.uniqueVisitors ?? 0) > 0 ? ((siteAnalytics?.totalViews ?? 0) / (siteAnalytics?.uniqueVisitors ?? 1)).toFixed(1) : '0'}
              </div>}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">Top Source</p>
          {siteAnalyticsLoading
            ? <Skeleton className="h-7 w-24" />
            : <div className="text-2xl font-bold text-[var(--text-primary)] leading-7 truncate">
                {siteAnalytics?.topSources?.[0]?.source || '—'}
              </div>}
        </div>
      </div>

      {/* Views Over Time — flat section, no card. The chart paints on
          the page background directly; the only chrome is the section
          label + the small "Peak" annotation. */}
      {viewsData.length > 0 && (
        <div className="py-6 border-b border-[var(--border-light)]">
          <div className="flex items-baseline justify-between mb-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Views Over Time</p>
            <p className="text-[10px] text-[var(--text-tertiary)] tabular-nums">Peak: {maxViews} views</p>
          </div>
          <div className="relative">
            <svg viewBox={`0 0 100 ${chartHeight}`} preserveAspectRatio="none" className="w-full" style={{ height: '200px' }}>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => (
                <line key={i} x1="0" y1={chartPadding + (chartHeight - chartPadding * 2) * ratio} x2="100" y2={chartPadding + (chartHeight - chartPadding * 2) * ratio} stroke="var(--border-light)" strokeWidth="0.2" opacity="0.6" />
              ))}
              <defs>
                <linearGradient id="analyticsAreaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path d={smoothAreaPath} fill="url(#analyticsAreaGradient)" />
              <path d={smoothPath} fill="none" stroke="#6366f1" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round" />
              {chartPoints.map((point, i) => (
                <circle key={i} cx={point.x} cy={point.y} r="0.8" fill="#6366f1" />
              ))}
            </svg>
            <div className="flex justify-between mt-3 px-1">
              <span className="text-[10px] text-[var(--text-tertiary)]">{new Date(viewsData[0]?.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              <span className="text-[10px] text-[var(--text-tertiary)]">{new Date(viewsData[Math.floor(viewsData.length / 2)]?.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              <span className="text-[10px] text-[var(--text-tertiary)]">{new Date(viewsData[viewsData.length - 1]?.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
          </div>
        </div>
      )}

      {/* Breakdowns — flat 2-column grid. No card chrome, no inner
          borders. Skeleton state mirrors the same layout 1:1 so the
          page doesn't reshuffle when /api/analytics resolves. */}
      <div className="py-6">
        {siteAnalyticsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            {['Pages', 'Sources', 'Countries', 'Devices'].map((title) => (
              <div key={title}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">{title}</p>
                <div className="space-y-px">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-3 w-8 ml-2" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : isAdvanced ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            {renderBarTable('Pages', siteAnalytics?.topPages || [], maxPageViews, 'path', 'views')}
            {renderBarTable('Sources', siteAnalytics?.topSources || [], maxSourceViews, 'source', 'views')}
            {renderBarTable('Countries', siteAnalytics?.topCountries || [], maxCountryViews, 'country', 'views')}
            {renderBarTable('Devices', siteAnalytics?.topDevices || [], maxDeviceViews, 'device', 'views')}
          </div>
        ) : (
          <div className="relative">
            {/* Blurred placeholder grid — same flat layout as the
                real tables, just dimmed and pointer-disabled. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8 blur-sm pointer-events-none select-none opacity-50">
              {['Pages', 'Sources', 'Countries', 'Devices'].map((title) => (
                <div key={title}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">{title}</p>
                  <div className="space-y-px">
                    {[60, 40, 30, 20].map((w, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 px-2">
                        <div className="h-3 bg-white/10 rounded" style={{ width: `${w}%` }} />
                        <div className="h-3 w-8 bg-white/10 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* Upsell card — kept as a card on purpose because it's a
                callout layered ON TOP of the dimmed content. The page
                itself stays flat. */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="max-w-md text-center bg-[var(--bg-surface)] border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)] cut-lg px-6 py-5 shadow-xl">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-text)] mb-2">
                  Advanced analytics
                </div>
                <h3 className="text-base font-semibold text-[var(--text-primary)] mb-2">
                  Unlock traffic breakdowns
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mb-4 leading-relaxed">
                  See top pages, traffic sources, countries, and devices.
                  90-day retention. Available on Lite and above.
                </p>
                <button
                  onClick={() => setActiveSection('plans')}
                  className="h-8 px-4 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 cut-corners cursor-pointer"
                >
                  Upgrade to Lite
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
