// src/ai/agent/tools/composition.ts
//
// Chantier Q5-A — STRUCTURAL visual perception without pixels. Where the
// linter (design-audit.ts, audit_design) measures WHAT IS WRONG — overlaps,
// contrast, truncation — these analyses say what a composition MEANS: where
// the visual regions are, whether each one is horizontally balanced, how
// siblings align, whether column proportions are in balance, whether the
// type hierarchy has contrast, and where dead space sits. Everything derives
// from the flat AuditNode[] fixture that collectLayoutSnapshot produces
// (rects in parent screen space + computed styles from the bridge caches) —
// pure functions, ~0 tokens, no store, no bridge, no DOM, every model can
// read them.
//
// Each analysis is a pure function returning STRUCTURED constats (kind +
// message + optional regionId); the tool (get_composition in read.ts)
// formats them as one compact line per constat. The linter answers "what is
// broken?", these answer "what does it look like?" — the missing layer
// between raw rect numbers and an agent that can say "the hero is centered
// but the features section leans left".

import type { AuditNode, LayoutRect } from './design-audit';

/** One visual region: a top-level section of the page (direct child of a
 *  root node) with a measurable rect. Percentages relate to the page's
 *  content height (max bottom edge over all measured nodes). */
export interface RegionInfo {
  id: string;
  rect: LayoutRect;
  /** 0..100 — where the region's top sits in the page. */
  topPct: number;
  /** 0..100 — where the region's bottom sits in the page. */
  bottomPct: number;
  /** 0..100 — the region's share of the page height. */
  heightPct: number;
}

/** One structured constat of an analysis — kind is machine-readable,
 *  message is the agent-facing line (the formatter prefixes `kind: `). */
export interface CompositionFinding {
  kind: 'balance' | 'alignment' | 'proportion' | 'type' | 'gap';
  /** Region the constat is about (region-scoped kinds only). */
  regionId?: string;
  message: string;
}

// ─── Tunables (exported so the perception thresholds stay adjustable
// ─── without surgery, same pattern as the design-audit constants) ──────────

/** Px slop when judging "same edge / same width / same height" between
 *  siblings and "same row" between column children. */
export const ALIGNMENT_TOLERANCE_PX = 8;
/** COM drift vs the region center beyond this fraction of the region width
 *  counts as left-heavy / right-heavy; within, the region is centered. */
export const BALANCE_TOLERANCE_RATIO = 0.05;
/** A column width off the equal share by more than this fraction (of the
 *  occupied span) makes the row "imbalanced". 0.15 → 60/40 passes, 80/20
 *  fails (each is 10% / 30% off a 50/50 share). */
export const PROPORTION_TOLERANCE = 0.15;
/** A type scale step (larger ÷ smaller) below this ratio is a "compressed"
 *  scale — sizes too close to create contrast. 1.2 ≈ a minor-third step. */
export const TYPE_SCALE_MIN_STEP = 1.2;
/** A gap between consecutive regions larger than this fraction of the page
 *  height is an abnormally large empty gap. */
export const GAP_MAX_RATIO = 0.15;
/** Regions / sides smaller than this (px) are decorations, not layout
 *  elements — never region candidates. */
export const MIN_REGION_SIZE_PX = 16;
/** Cap on regions printed in the `regions:` line (long pages). */
export const MAX_REGIONS_IN_LINE = 5;
/** Cap on type sizes printed in a `type:` line. */
export const TYPE_SCALE_MAX_SIZES = 6;

// ─── Shared geometry helpers (pure) ────────────────────────────────────────

function pageHeightOf(nodes: AuditNode[]): number {
  let max = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    max = Math.max(max, n.rect.y + n.rect.height);
  }
  return max;
}

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

/** The measured children of one node: ids resolved, rect-guarded. */
function childrenWithRects(nodes: AuditNode[], parentId: string): AuditNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const parent = byId.get(parentId);
  if (!parent) return [];
  const out: AuditNode[] = [];
  for (const cid of parent.children) {
    const child = byId.get(cid);
    if (child && child.rect && child.rect.width > 0 && child.rect.height > 0) out.push(child);
  }
  return out;
}

/** Render a font size without float noise: 14.5 → '14.5', 14 → '14'. */
function formatSize(px: number): string {
  return String(Number(px.toFixed(1)));
}

// ─── Regions ────────────────────────────────────────────────────────────────

/** Detect the page's visual regions: direct children of the root nodes that
 *  measure like sections (≥ MIN_REGION_SIZE_PX both ways), sorted top-down,
 *  each annotated with its span and its share of the page height. The same
 *  list feeds every region-scoped analysis below — computed once per
 *  snapshot by the caller (the tool), never re-derived. */
export function detectRegions(nodes: AuditNode[]): RegionInfo[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const roots = new Set(
    nodes
      .filter((n) => n.parentId === null || !byId.has(n.parentId))
      .map((n) => n.id),
  );
  const pageHeight = pageHeightOf(nodes);
  const regions: RegionInfo[] = [];
  for (const n of nodes) {
    if (!n.parentId || !roots.has(n.parentId)) continue;
    if (!n.rect || n.rect.width < MIN_REGION_SIZE_PX || n.rect.height < MIN_REGION_SIZE_PX) continue;
    regions.push({
      id: n.id,
      rect: n.rect,
      topPct: pct(n.rect.y, pageHeight),
      bottomPct: pct(n.rect.y + n.rect.height, pageHeight),
      heightPct: pct(n.rect.height, pageHeight),
    });
  }
  regions.sort((a, b) => a.rect.y - b.rect.y);
  return regions;
}

// ─── Balance ────────────────────────────────────────────────────────────────

/** Per-region horizontal balance: the area-weighted center of mass (mean x
 *  of the children) vs the region's own center. A drift beyond
 *  BALANCE_TOLERANCE_RATIO of the region width is left-heavy / right-heavy;
 *  within it, centered. Regions without measurable children are skipped. */
export function balanceAnalysis(
  nodes: AuditNode[],
  regions: RegionInfo[],
): CompositionFinding[] {
  const findings: CompositionFinding[] = [];
  for (const region of regions) {
    const children = childrenWithRects(nodes, region.id);
    if (children.length === 0) continue;
    let areaSum = 0;
    let momentSum = 0;
    for (const c of children) {
      const r = c.rect!;
      const area = r.width * r.height;
      areaSum += area;
      momentSum += (r.x + r.width / 2) * area;
    }
    const centerX = region.rect.x + region.rect.width / 2;
    const comX = areaSum > 0 ? momentSum / areaSum : centerX;
    const drift = (comX - centerX) / region.rect.width;
    const verdict =
      drift > BALANCE_TOLERANCE_RATIO
        ? 'right-heavy'
        : drift < -BALANCE_TOLERANCE_RATIO
          ? 'left-heavy'
          : 'centered';
    findings.push({
      kind: 'balance',
      regionId: region.id,
      message:
        verdict === 'centered'
          ? `${region.id} centered`
          : `${region.id} ${verdict} (COM ~${Math.round(comX)}px vs center ${Math.round(centerX)}px)`,
    });
  }
  return findings;
}

// ─── Alignment ──────────────────────────────────────────────────────────────

/** Per-region sibling alignment: do the children share a top edge (aligned
 *  row), a left edge (aligned column), equal widths, equal heights? With ≥2
 *  children and none of the four, the constat says the children are
 *  staggered. Regions with fewer than two measured children are skipped. */
export function alignmentAnalysis(
  nodes: AuditNode[],
  regions: RegionInfo[],
): CompositionFinding[] {
  const findings: CompositionFinding[] = [];
  for (const region of regions) {
    const children = childrenWithRects(nodes, region.id);
    if (children.length < 2) continue;
    const lefts = children.map((c) => c.rect!.x);
    const tops = children.map((c) => c.rect!.y);
    const widths = children.map((c) => c.rect!.width);
    const heights = children.map((c) => c.rect!.height);
    const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);
    const shared: string[] = [];
    if (spread(tops) <= ALIGNMENT_TOLERANCE_PX) shared.push('share the same top edge (aligned row)');
    if (spread(lefts) <= ALIGNMENT_TOLERANCE_PX) shared.push('share the same left edge (aligned column)');
    if (spread(widths) <= ALIGNMENT_TOLERANCE_PX) shared.push(`equal-width siblings (${Math.round(widths[0])}px)`);
    if (spread(heights) <= ALIGNMENT_TOLERANCE_PX) shared.push('equal-height siblings');
    if (shared.length === 0) shared.push('share no edge — staggered children');
    for (const phrase of shared) {
      findings.push({ kind: 'alignment', regionId: region.id, message: `${region.id} ${phrase}` });
    }
  }
  return findings;
}

// ─── Proportion ─────────────────────────────────────────────────────────────

/** Per-region column balance: children sitting on the same row are measured
 *  against the span they occupy. Each width within PROPORTION_TOLERANCE of
 *  the equal share → balanced ("50/50", "33/33/33"); otherwise imbalanced
 *  ("80/20") with the offending widths named. Rows with a single child are
 *  skipped (no proportion to judge). */
export function proportionAnalysis(
  nodes: AuditNode[],
  regions: RegionInfo[],
): CompositionFinding[] {
  const findings: CompositionFinding[] = [];
  for (const region of regions) {
    const children = childrenWithRects(nodes, region.id);
    if (children.length < 2) continue;
    const rows: AuditNode[][] = [];
    for (const child of children) {
      const cy = child.rect!.y + child.rect!.height / 2;
      let placed = false;
      for (const row of rows) {
        const rowCy = row[0].rect!.y + row[0].rect!.height / 2;
        if (Math.abs(cy - rowCy) <= 2 * ALIGNMENT_TOLERANCE_PX) {
          row.push(child);
          placed = true;
          break;
        }
      }
      if (!placed) rows.push([child]);
    }
    const widest = rows
      .filter((row) => row.length >= 2)
      .sort((a, b) => b.length - a.length)[0];
    if (!widest) continue;
    const span =
      Math.max(...widest.map((c) => c.rect!.x + c.rect!.width)) -
      Math.min(...widest.map((c) => c.rect!.x));
    if (span <= 0) continue;
    const sorted = [...widest].sort((a, b) => b.rect!.width - a.rect!.width);
    const shares = sorted.map((c) => c.rect!.width / span);
    const balanced = shares.every((s) => Math.abs(s - 1 / sorted.length) <= PROPORTION_TOLERANCE);
    const pcts = shares.map((s) => Math.round(s * 100));
    findings.push({
      kind: 'proportion',
      regionId: region.id,
      message: `${region.id} columns ${pcts.join('/')} — ${balanced ? 'balanced' : 'imbalanced'} (${sorted.map((c) => `${c.id} ${Math.round(c.rect!.width)}px`).join(' vs ')})`,
    });
  }
  return findings;
}

// ─── Type hierarchy ─────────────────────────────────────────────────────────

/** The page's type scale: distinct computed fontSizes across ALL text nodes
 *  (not per region — a scale is a page-level property). One distinct size →
 *  FLAT (no contrast at all); steps ≥ TYPE_SCALE_MIN_STEP between consecutive
 *  sizes → healthy; any smaller step → compressed. Skips pages where no text
 *  node has a measurable fontSize (unmeasured ≠ flat). */
export function typeHierarchy(nodes: AuditNode[]): CompositionFinding[] {
  const sizes = new Set<number>();
  for (const n of nodes) {
    if (!n.text.trim()) continue;
    const px = parseFloat(n.computed.fontSize);
    if (!Number.isFinite(px) || px <= 0) continue;
    sizes.add(px);
  }
  if (sizes.size === 0) return [];
  const sorted = [...sizes].sort((a, b) => b - a).slice(0, TYPE_SCALE_MAX_SIZES);
  if (sorted.length === 1) {
    return [
      {
        kind: 'type',
        message: `FLAT — every text node is ${formatSize(sorted[0])} (no size contrast at all)`,
      },
    ];
  }
  const compressed = sorted.some((s, i) => i > 0 && sorted[i - 1] / s < TYPE_SCALE_MIN_STEP);
  const scale = sorted.map(formatSize).join(' → ');
  return [
    {
      kind: 'type',
      message: compressed
        ? `compressed scale ${scale} (steps under ${TYPE_SCALE_MIN_STEP}×)`
        : `healthy scale ${scale} (each step ≥ ${TYPE_SCALE_MIN_STEP}×)`,
    },
  ];
}

// ─── Empty gaps ─────────────────────────────────────────────────────────────

/** Vertical dead space between consecutive regions: a gap larger than
 *  GAP_MAX_RATIO of the page height is an abnormal empty gap (an accidental
 *  push below the fold, a padding stack, a vanished region). */
export function gapAnalysis(
  nodes: AuditNode[],
  regions: RegionInfo[],
): CompositionFinding[] {
  const findings: CompositionFinding[] = [];
  if (regions.length < 2) return findings;
  const pageHeight = pageHeightOf(nodes);
  for (let i = 1; i < regions.length; i++) {
    const prev = regions[i - 1];
    const next = regions[i];
    const gap = next.rect.y - (prev.rect.y + prev.rect.height);
    if (gap > pageHeight * GAP_MAX_RATIO) {
      findings.push({
        kind: 'gap',
        message: `${Math.round(gap)}px empty gap (${pct(gap, pageHeight)}% of page height) between ${prev.id} and ${next.id}`,
      });
    }
  }
  return findings;
}

// ─── The report the tool returns ────────────────────────────────────────────

/**
 * The get_composition output: one compact line per constat, in a fixed
 * order determined by the analyses (regions → balance → alignment →
 * proportion → type → gaps). Each line is `kind: message`. Empty
 * snapshots (no rects yet — headless or mid-render) yield exactly the
 * `regions: none` line, which the tool's `note` reinforces.
 */
export function formatCompositionReport(snapshot: AuditNode[]): string[] {
  const regions = detectRegions(snapshot);
  const lines: string[] = [];
  if (regions.length === 0) {
    lines.push('regions: none (no measured sections with rects)');
  } else {
    const shown = regions.slice(0, MAX_REGIONS_IN_LINE);
    const hidden = regions.length - shown.length;
    lines.push(
      `regions: ${shown
        .map((r) => `${r.id} y:${Math.round(r.rect.y)}-${Math.round(r.rect.y + r.rect.height)} (${r.heightPct}%)`)
        .join(', ')}${hidden > 0 ? ` …(+${hidden} more)` : ''}`,
    );
  }
  const findings: CompositionFinding[] = [
    ...balanceAnalysis(snapshot, regions),
    ...alignmentAnalysis(snapshot, regions),
    ...proportionAnalysis(snapshot, regions),
    ...typeHierarchy(snapshot),
    ...gapAnalysis(snapshot, regions),
  ];
  for (const f of findings) lines.push(`${f.kind}: ${f.message}`);
  return lines;
}