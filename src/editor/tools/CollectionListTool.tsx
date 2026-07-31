// CollectionListTool.tsx — Properties panel tool for nodes with collectionList.
// Shows source collection dropdown, filter rows, sort, and limit controls.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { collectionSchemasAtom } from '@/code/stores/cms-store';
import { useControl } from '../controls/ControlProvider';
import { ToolSection, ToolSelect, ToolInput, ControlLabel, ControlActionRow } from '../controls';
import { queueMutation, flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { forceCanvasRender } from '@/canvas/node-ops';
import { codeAtom, isComponentFileAtom } from '@/code/stores/store';
import { isReplicaViewportAtom, interactingViewportWidthAtom, isComponentVariantViewportAtom, activeComponentVariantAtom, getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { useStore } from 'jotai';
import { listCollections, getCollectionSchema } from '@/code/project/cms-ops';
import { paginationStateVar } from '@/code/generation/cms-pagination-gen';
import { SEARCH_FIELD_PLACEHOLDER } from '@/code/generation/cms-search-field-gen';
import { parsePageVariables } from '@/code/features/page-variables';
import type { ResponsiveListConfig } from '@/code/generation/cms-responsive-gen';
import type { FilterConfig, FilterGroup, SortConfig, CollectionSchema, PaginationConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import FilterControl from './CollectionList/FilterControl';
import SortControl from './CollectionList/SortControl';
import { COLLECTION_VALUE_CLS, fieldsForSortFilter } from './CollectionList/cms-filter-utils';
import PaginationControl from './CollectionList/PaginationControl';

// Mirrors the Animation/Layout tool add-dropdown item styling.
const ADD_ITEM = 'group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap';
const ADD_ITEM_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-white';

/** The "+" on the Collection List section header → a native floating dropdown
 *  (like the Animation tool's +) to add the "Limit to" / "Start Offset" rows
 *  (hidden by default). Only offers controls not already shown. */
function ContentAddMenu({ showLimit, showOffset, onAdd }: {
  showLimit: boolean;
  showOffset: boolean;
  onAdd: (which: 'limit' | 'offset') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const items: Array<{ key: 'limit' | 'offset'; label: string }> = [];
  if (!showLimit) items.push({ key: 'limit', label: 'Limit to' });
  if (!showOffset) items.push({ key: 'offset', label: 'Start Offset' });
  if (items.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }} title="Add limit / offset"
        className="flex items-center justify-center cursor-pointer group text-[var(--text-primary)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
            {items.map(it => (
              <button key={it.key} type="button" className={ADD_ITEM}
                onClick={() => { onAdd(it.key); setOpen(false); }}>
                <span className={ADD_ITEM_LABEL}>{it.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── CollectionListTool ───────────────────────────────────────────────────────

type Dims = { filterGroup?: FilterGroup | null; sort?: SortConfig[] | null };

export default function CollectionListTool() {
  const { node } = useControl();
  const schemas = useAtomValue(collectionSchemasAtom);
  // Axis routing (mirrors the CMS-binding control routing): a non-default variant
  // artboard edits the per-variant config; a replica edits the per-viewport config;
  // primary/default edits the base.
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const isVariantVp = useAtomValue(isComponentVariantViewportAtom);
  const activeVariant = useAtomValue(activeComponentVariantAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);

  if (!node?.collectionList) return null;

  const cl = node.collectionList;
  const { source, filterGroup, sort: initSort, limit: initLimit, offset: initOffset, pagination } = cl;
  const schema = schemas.get(source) ?? getCollectionSchema(source);

  const axis: 'variant' | 'viewport' | 'base' =
    (isComponentFile && isVariantVp && activeVariant && activeVariant !== 'default') ? 'variant'
    : (isReplica && vpWidth) ? 'viewport'
    : 'base';
  const axisKey = axis === 'variant' ? activeVariant! : axis === 'viewport' ? String(vpWidth) : 'base';

  // Base dims (from the inline chain / config base).
  const baseFilterGroup = filterGroup ?? null;
  const baseSort: SortConfig[] = Array.isArray(initSort) ? initSort : initSort ? [initSort] : [];

  // Display = the active axis's override (per dim) ?? base. Absent dim → inherits base.
  const override: Dims | undefined = axis === 'variant' ? cl.variantConfigs?.[axisKey]
    : axis === 'viewport' ? cl.responsive?.[axisKey] : undefined;
  const dispFilterGroup = (override && 'filterGroup' in override ? override.filterGroup : baseFilterGroup) ?? null;
  const dispSort = (override && 'sort' in override ? override.sort : baseSort) ?? [];

  trace.fn('CollectionListTool.render', { nodeId: node.id, source, axis, axisKey, fieldCount: schema?.fields.length ?? 0 });

  return (
    <CollectionListToolInner
      key={`${node.id}:${source}:${axisKey}`} // remount on source OR axis switch — re-seed state
      nodeId={node.id}
      source={source}
      schema={schema}
      schemas={schemas}
      axis={axis}
      axisKey={axisKey}
      variantArg={isComponentFile ? 'initialVariant' : undefined}
      vpWidths={getSortedBreakpointWidths()}
      baseFilterGroup={baseFilterGroup}
      baseSort={baseSort}
      responsive={cl.responsive ?? null}
      variantConfigs={cl.variantConfigs ?? null}
      initialFilters={dispFilterGroup?.filters ?? []}
      initialCombinator={dispFilterGroup?.combinator ?? 'and'}
      initialSort={dispSort}
      initialLimit={initLimit != null ? String(initLimit) : ''}
      initialOffset={initOffset != null && initOffset > 0 ? String(initOffset) : ''}
      pagination={pagination ?? null}
    />
  );
}

// ─── Inner Component ──────────────────────────────────────────────────────────

interface InnerProps {
  nodeId: string;
  source: string;
  schema: CollectionSchema | null;
  schemas: Map<string, CollectionSchema>;
  /** Which config axis edits target: per-variant artboard / per-viewport replica / base. */
  axis: 'variant' | 'viewport' | 'base';
  /** The override key for the active axis (variant name / breakpoint width / 'base'). */
  axisKey: string;
  /** Variant discriminator identifier in scope (component files) — for codegen. */
  variantArg?: string;
  /** All viewport breakpoint widths (synced into the resolver's vpWidths arg). */
  vpWidths: number[];
  /** Base config dims (apply when axis === 'base' or as inheritance source). */
  baseFilterGroup: FilterGroup | null;
  baseSort: SortConfig[];
  /** Existing per-viewport / per-variant overrides (preserved across edits). */
  responsive: Record<string, Dims> | null;
  variantConfigs: Record<string, Dims> | null;
  initialFilters: FilterConfig[];
  initialCombinator: 'and' | 'or';
  initialSort: SortConfig[];
  initialLimit: string;
  initialOffset: string;
  pagination: PaginationConfig | null;
}

function CollectionListToolInner({ nodeId, source, schema, schemas, axis, axisKey, variantArg, vpWidths, baseFilterGroup, baseSort, responsive, variantConfigs, initialFilters, initialCombinator, initialSort, initialLimit, initialOffset, pagination }: InnerProps) {
  // Seed local state from the parser's read-back so the panel reflects
  // what's actually in the JSX. Re-mount key in the wrapper resets these
  // when the user switches source — fresh slate per collection.
  const [filters, setFilters] = useState<FilterConfig[]>(initialFilters);
  const [combinator, setCombinator] = useState<'and' | 'or'>(initialCombinator);
  const [sort, setSort] = useState<SortConfig[]>(initialSort);
  const [limit, setLimit] = useState<string>(initialLimit);
  const [offset, setOffset] = useState<string>(initialOffset);
  // "Limit to" / "Start Offset" are added via the section + dropdown (the reference
  // parity) — shown once added or when a value already exists.
  const [showLimit, setShowLimit] = useState<boolean>(initialLimit !== '');
  const [showOffset, setShowOffset] = useState<boolean>(initialOffset !== '');
  const jotaiStore = useStore();

  // EXTERNAL code changes (undo/redo, MCP commits, collab) re-parse the
  // node and hand this component fresh initial* props — re-seed the local
  // state when the PARSED config actually changed, or the panel keeps
  // showing e.g. a sort entry the undo just removed until a page switch
  // remounts it. Own commits are safe: they round-trip through the parser
  // to the exact values already in local state, so the re-seed is
  // value-identical (never clobbers mid-interaction state the way a naive
  // reset-on-value effect would — see MaskControl's identity-gate lesson).
  const parsedKey = JSON.stringify([initialFilters, initialCombinator, initialSort, initialLimit, initialOffset]);
  const prevParsedRef = useRef(parsedKey);
  useEffect(() => {
    if (prevParsedRef.current === parsedKey) return;
    prevParsedRef.current = parsedKey;
    trace.action('collection-list-tool:reseed-from-parse', { nodeId });
    setFilters(initialFilters);
    setCombinator(initialCombinator);
    setSort(initialSort);
    setLimit(initialLimit);
    setOffset(initialOffset);
    setShowLimit(initialLimit !== '');
    setShowOffset(initialOffset !== '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedKey]);

  const collectionSlugs = useMemo(() => listCollections(), [schemas]);

  // Source change — repoint the .map() at a different collection AND
  // try to carry every existing binding over to a same-typed field in
  // the new schema, so swapping "Blog Posts" → "Team Members" doesn't
  // leave `item.title` pointing at a missing field. We build the remap
  // by walking the OLD schema's fields and pairing each with the FIRST
  // unconsumed NEW-schema field of the same type. Type-compatible
  // groups (text/textarea/richtext, image/file) share a bucket so a
  // `text` field can land on a `richtext` slot when nothing exact
  // exists. Fields with no compatible partner are left referencing
  // their old name — same the reference compromise; user re-binds manually.
  const handleSourceChange = useCallback((newSlug: string) => {
    if (!newSlug || newSlug === source) return;
    const oldSchema = schemas.get(source);
    const newSchema = schemas.get(newSlug);
    const remap: Record<string, string> = {};
    if (oldSchema && newSchema) {
      const typeBucket = (t: string): string => {
        if (t === 'text' || t === 'textarea' || t === 'richtext' || t === 'slug') return 'text';
        if (t === 'image' || t === 'file') return 'image';
        if (t === 'link' || t === 'url') return 'link';
        return t;
      };
      const consumed = new Set<string>();
      for (const oldField of oldSchema.fields) {
        // Prefer same id if it exists with a compatible type (the user
        // probably meant the same thing).
        const sameId = newSchema.fields.find(
          f => f.id === oldField.id && typeBucket(f.type) === typeBucket(oldField.type),
        );
        if (sameId) {
          remap[oldField.id] = sameId.id;
          consumed.add(sameId.id);
          continue;
        }
        const candidate = newSchema.fields.find(
          f => typeBucket(f.type) === typeBucket(oldField.type) && !consumed.has(f.id),
        );
        if (candidate) {
          remap[oldField.id] = candidate.id;
          consumed.add(candidate.id);
        }
      }
    }
    trace.action('collection-list-tool:change-source', { nodeId, from: source, to: newSlug, remap });
    syncQueueCode(jotaiStore.get(codeAtom));
    queueMutation({ type: 'changeCollectionSource', parentNodeId: nodeId, newSlug, fieldRemap: remap });
    flushNow();
  }, [nodeId, source, schemas, jotaiStore]);

  // Drop dims that resolve to "empty" (no filters / no sort keys) — an empty
  // override dim means INHERIT base, so it isn't carried.
  const stripEmptyDims = (d: Dims | undefined): Dims => {
    const out: Dims = {};
    if (d && 'filterGroup' in d && d.filterGroup && d.filterGroup.filters.length > 0) out.filterGroup = d.filterGroup;
    if (d && 'sort' in d && d.sort && d.sort.length > 0) out.sort = d.sort;
    return out;
  };

  // Commit the FULL next config. No overrides remain → route to the existing
  // inline-chain `updateCollectionConfig` (byte-identical, unchanged behavior).
  // Any override → route to the responsive writer (upgrades to config-as-data).
  const commit = useCallback((
    nextBaseFilter: FilterGroup | null,
    nextBaseSort: SortConfig[],
    nextResp: Record<string, Dims>,
    nextVar: Record<string, Dims>,
    newLimit: string,
    newOffset: string,
  ) => {
    const limitNum = newLimit ? parseInt(newLimit, 10) : undefined;
    const offsetNum = newOffset ? parseInt(newOffset, 10) : undefined;
    const cleanMap = (m: Record<string, Dims>): Record<string, Dims> => {
      const out: Record<string, Dims> = {};
      for (const k of Object.keys(m)) { const d = stripEmptyDims(m[k]); if (Object.keys(d).length > 0) out[k] = d; }
      return out;
    };
    const resp = cleanMap(nextResp);
    const vars = cleanMap(nextVar);
    const anyOverrides = Object.keys(resp).length > 0 || Object.keys(vars).length > 0;
    // Is the list ALREADY in the `__applyListConfig(...)` upgraded shape? If so we
    // must route the DOWNGRADE (last override removed) through setListResponsiveConfig
    // too — updateCollectionConfig can't read the upgraded chain head (findCollectionChainHead
    // returns null) so it would leave a broken `__applyListConfig` + stale const → the
    // list "disappears". Only a NEVER-upgraded, no-override edit uses the inline path.
    const wasUpgraded = (!!responsive && Object.keys(responsive).length > 0) || (!!variantConfigs && Object.keys(variantConfigs).length > 0);
    trace.action('collection-list-tool:commit', { nodeId, axis, axisKey, anyOverrides, wasUpgraded, limit: limitNum, offset: offsetNum });
    if (!anyOverrides && !wasUpgraded) {
      queueMutation({
        type: 'updateCollectionConfig', parentId: nodeId,
        filterGroup: nextBaseFilter ?? undefined,
        sort: nextBaseSort.length ? nextBaseSort : undefined,
        limit: limitNum, offset: offsetNum,
      });
      // Same sync-render trio as the responsive path below (and the Pagination
      // Items handler): flushNow writes the new limit into code → nodesAtom
      // re-parses → forceCanvasRender re-runs applyChainConfig with the fresh
      // slice → the ghost-count mismatch triggers the row rebuild. Without it
      // this early return left the canvas on the ASYNC RAF flush and the
      // ghost rebuild raced — "Limit to" changes sometimes didn't repaint
      // until an unrelated drag forced a render (live find 2026-07-07).
      flushNow();
      forceCanvasRender();
      return;
    }
    const config: ResponsiveListConfig = {
      base: { filterGroup: nextBaseFilter, sort: nextBaseSort },
      viewport: resp,
      variants: vars,
    };
    queueMutation({
      type: 'setListResponsiveConfig', parentId: nodeId, slug: source, config,
      limit: limitNum ?? null, offset: offsetNum ?? null,
      paginationVar: pagination ? paginationStateVar(nodeId) : null,
      variantArg, vpWidths,
    });
    flushNow();
    forceCanvasRender();
  }, [nodeId, axis, axisKey, source, pagination, variantArg, vpWidths, responsive, variantConfigs]);

  // Apply ONE dim (filterGroup or sort) to the ACTIVE axis, preserving the other
  // dim + all other overrides (partial-override inheritance).
  const applyDimEdit = useCallback((dim: 'filterGroup' | 'sort', value: FilterGroup | null | SortConfig[]) => {
    let nextBaseFilter = baseFilterGroup;
    let nextBaseSort = baseSort;
    const nextResp: Record<string, Dims> = { ...(responsive ?? {}) };
    const nextVar: Record<string, Dims> = { ...(variantConfigs ?? {}) };
    if (axis === 'base') {
      if (dim === 'filterGroup') nextBaseFilter = value as FilterGroup | null;
      else nextBaseSort = value as SortConfig[];
    } else if (axis === 'viewport') {
      nextResp[axisKey] = { ...(nextResp[axisKey] ?? {}), [dim]: value };
    } else {
      nextVar[axisKey] = { ...(nextVar[axisKey] ?? {}), [dim]: value };
    }
    commit(nextBaseFilter, nextBaseSort, nextResp, nextVar, limit, offset);
  }, [axis, axisKey, baseFilterGroup, baseSort, responsive, variantConfigs, limit, offset, commit]);

  // Single handler driving the FilterControl popup (rows + Match All/Any).
  const handleFilterGroupChange = useCallback((fg: FilterGroup | null) => {
    setFilters(fg?.filters ?? []);
    setCombinator(fg?.combinator ?? 'and');
    applyDimEdit('filterGroup', fg);
  }, [applyDimEdit]);

  // ─── Dynamic "Search Field" (design-tool parity) ───────────────────────────────
  // Picking Dynamic → Search Field on a TEXT field: create a text page variable
  // + a bound search <input> just before the list (own mutation), then add the
  // dynamic filter (`valueSource:'searchField'`) through the normal config path.
  // Both queue, then ONE flush applies them in order so the var name stays
  // consistent. Page base context only (search binds to a PAGE variable).
  const handleAddSearchField = useCallback((fieldId: string) => {
    const code = jotaiStore.get(codeAtom);
    // Unique camelCase var name (e.g. `searchAuthor`, `searchAuthor2`).
    const pascal = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    // Unique vs declared page vars AND any data-search-field marker already on the
    // page (incl. a MISSING pasted one) — else a new search field for the same field
    // would reuse the marker's name and both inputs would bind to one var.
    const existingVars = new Set([
      ...(parsePageVariables(code)?.variables ?? []).map(v => v.name),
      ...[...code.matchAll(/data-search-field="([^"]+)"/g)].map(m => m[1]),
    ]);
    const base = 'search' + (pascal(fieldId) || 'Field');
    let varName = base;
    for (let n = 2; existingVars.has(varName); n++) varName = base + n;
    // Unique frame data-id (the search field is a frame: label + input).
    let frameId = `search-${nodeId}-${fieldId}`;
    for (let n = 2; code.includes(`data-id="${frameId}"`); n++) frameId = `search-${nodeId}-${fieldId}-${n}`;
    // The field's human name → the label text above the input (Title / Author / …).
    const fieldLabel = fieldsForSortFilter(schema).find(f => f.id === fieldId)?.name ?? fieldId;
    // URL-shareable query param (design-tool parity) — a clean slug of the field,
    // unique vs existing params so two search fields don't collide.
    const usedParams = new Set((parsePageVariables(code)?.variables ?? []).map(v => v.queryParam).filter(Boolean) as string[]);
    const paramBase = fieldId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'search';
    let queryParam = paramBase;
    for (let n = 2; usedParams.has(queryParam); n++) queryParam = `${paramBase}-${n}`;

    trace.action('collection-list-tool:add-search-field', { nodeId, fieldId, varName, frameId, fieldLabel, queryParam });
    syncQueueCode(code);
    queueMutation({ type: 'addCollectionSearchField', parentId: nodeId, varName, frameId, fieldLabel, placeholder: SEARCH_FIELD_PLACEHOLDER, isComponentFile: !!variantArg, queryParam });

    // Add the dynamic filter (predicate reads the var) via the normal commit path.
    const newFilter: FilterConfig = { field: fieldId, operator: 'contains', value: '', valueSource: 'searchField', valueVar: varName };
    const nextFilters = [...filters, newFilter];
    setFilters(nextFilters);
    applyDimEdit('filterGroup', { combinator, filters: nextFilters });

    flushNow();
    forceCanvasRender();
  }, [jotaiStore, nodeId, variantArg, filters, combinator, applyDimEdit, schema]);

  // ─── Sort handler (multi-rule, driven by SortControl popup) ──────────

  const handleSortChange = useCallback((newSort: SortConfig[]) => {
    trace.action('collection-list-tool:update-sort', { nodeId, rules: newSort.length });
    setSort(newSort);
    applyDimEdit('sort', newSort);
  }, [nodeId, applyDimEdit]);

  // ─── Limit / Offset handlers (GLOBAL — not axis-routed in v1) ──────────

  const handleLimitChange = useCallback((val: string) => {
    trace.action('collection-list-tool:update-limit', { nodeId, limit: val });
    setLimit(val);
    commit(baseFilterGroup, baseSort, { ...(responsive ?? {}) }, { ...(variantConfigs ?? {}) }, val, offset);
  }, [nodeId, baseFilterGroup, baseSort, responsive, variantConfigs, offset, commit]);

  const handleOffsetChange = useCallback((val: string) => {
    trace.action('collection-list-tool:update-offset', { nodeId, offset: val });
    setOffset(val);
    commit(baseFilterGroup, baseSort, { ...(responsive ?? {}) }, { ...(variantConfigs ?? {}) }, limit, val);
  }, [nodeId, baseFilterGroup, baseSort, responsive, variantConfigs, limit, commit]);

  // Remove a "Limit to" / "Start Offset" control: clear its value + hide the row.
  const removeLimit = useCallback(() => { setShowLimit(false); handleLimitChange(''); }, [handleLimitChange]);
  const removeOffset = useCallback(() => { setShowOffset(false); handleOffsetChange(''); }, [handleOffsetChange]);

  // Source + Pagination are PRIMARY-ONLY (design-tool parity): editable only on the
  // primary viewport / default variant. On a replica/variant they show read-only.
  const isPrimaryContext = axis === 'base';

  // ─── Per-axis override indicators + Reset Override (accent label) ──────
  // On a replica / variant artboard, a dim that the active axis explicitly
  // carries is "overridden" → accent label + Reset Override (revert to base).
  const activeOverride: Dims | undefined = axis === 'variant' ? variantConfigs?.[axisKey]
    : axis === 'viewport' ? responsive?.[axisKey] : undefined;
  const filterOverridden = !!activeOverride && 'filterGroup' in activeOverride;
  const sortOverridden = !!activeOverride && 'sort' in activeOverride;

  // Reset = drop the dim from the active axis (empty → inherits base) + restore
  // the displayed buffer to base so the popup reflects the revert immediately.
  const resetFilterOverride = useCallback(() => {
    setFilters(baseFilterGroup?.filters ?? []);
    setCombinator(baseFilterGroup?.combinator ?? 'and');
    applyDimEdit('filterGroup', null);
  }, [baseFilterGroup, applyDimEdit]);
  const resetSortOverride = useCallback(() => {
    setSort(baseSort);
    applyDimEdit('sort', []);
  }, [baseSort, applyDimEdit]);

  // ─── Pagination handlers (own mutation — adds slice/button/useState) ──────

  const handleSetPagination = useCallback((mode: 'loadMore' | 'infinite', perPage: number) => {
    trace.action('collection-list-tool:set-pagination', { nodeId, mode, perPage });
    queueMutation({ type: 'setPagination', parentId: nodeId, mode, perPage });
    flushNow();
    // The canvas previews page 1 (data.slice(0, perPage) in applyChainConfig).
    // Changing the item count alters the ghost count, but the nodes-atom render
    // can be skipped/debounced — force a full rebuild so the list instantly
    // drops to `perPage` rows instead of needing a drag to refresh.
    forceCanvasRender();
  }, [nodeId]);

  const handleRemovePagination = useCallback(() => {
    trace.action('collection-list-tool:remove-pagination', { nodeId });
    queueMutation({ type: 'removePagination', parentId: nodeId });
    flushNow();
    forceCanvasRender();
  }, [nodeId]);

  return (
    <ToolSection
      title="Collection List"
      action={<ContentAddMenu showLimit={showLimit} showOffset={showOffset} onAdd={(w) => (w === 'limit' ? setShowLimit(true) : setShowOffset(true))} />}
    >
      {/* Source — ToolSelect directly (matches the Filters/Sorting/Pagination
          value-column width; the old gap-2 wrapper made it a few px narrower). */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Source" property="collectionSource" plain />
        <ToolSelect
          value={source}
          onChange={handleSourceChange}
          disabled={!isPrimaryContext}
          className={COLLECTION_VALUE_CLS}
          options={collectionSlugs.map(s => {
            const sch = schemas.get(s);
            return { value: s, label: sch?.name ?? s };
          })}
        />
      </div>

      {/* Filters — popup with Match All/Any + addable type-aware condition rows. */}
      <FilterControl
        schema={schema}
        filterGroup={filters.length > 0 ? { combinator, filters } : null}
        onChange={handleFilterGroupChange}
        overridden={filterOverridden}
        onResetOverride={filterOverridden ? resetFilterOverride : undefined}
        allowDynamic={axis === 'base' && !variantArg}
        onAddSearchField={handleAddSearchField}
      />

      {/* Sort — popup with N type-aware sort rules (precedence = order). */}
      <SortControl
        schema={schema}
        sort={sort}
        onChange={handleSortChange}
        overridden={sortOverridden}
        onResetOverride={sortOverridden ? resetSortOverride : undefined}
      />

      {/* Pagination — Load More / Infinite Scroll. PRIMARY-ONLY (add/remove on the
          primary; read-only on a replica/variant, where it only appears if set on primary). */}
      <PaginationControl pagination={pagination} onSet={handleSetPagination} onRemove={handleRemovePagination} editable={isPrimaryContext} />

      {/* Limit to — added via the section + (hidden by default). */}
      {showLimit && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Limit to" property="collectionLimit" plain />
          <div className={`flex items-center gap-2 ${COLLECTION_VALUE_CLS}`}>
            <ToolInput value={limit} onChange={handleLimitChange} className="!w-16 shrink-0" />
            <ControlActionRow center onClick={removeLimit}>Remove</ControlActionRow>
          </div>
        </div>
      )}

      {/* Start Offset — added via the section + (hidden by default). */}
      {showOffset && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Start Offset" property="collectionOffset" plain />
          <div className={`flex items-center gap-2 ${COLLECTION_VALUE_CLS}`}>
            <ToolInput value={offset} onChange={handleOffsetChange} className="!w-16 shrink-0" />
            <ControlActionRow center onClick={removeOffset}>Remove</ControlActionRow>
          </div>
        </div>
      )}
    </ToolSection>
  );
}
