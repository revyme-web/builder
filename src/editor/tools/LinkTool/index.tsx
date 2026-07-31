// LinkTool — Navigation link manager for the properties panel.
// Handles href, target, smooth scroll, and section/anchor targeting.
// Code-first: produces real <a href="/about#features" target="_blank"> in JSX.
// Adding a link to a non-<a> element converts it via changeTag mutation.

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSection, ToolInput, ControlLabel, ToolSegmentedControl } from '../../controls';
import { YES_NO_OPTIONS } from '../../controls/css-property-options';
import { useControl } from '../../controls/ControlProvider';
import { HoistMenuItemProvider, useHoistMenuItem } from '../../controls/hoist-context';
import type { MenuItem } from '../../controls/control-menu-items';
import { LegacyVariableBoundPill } from '../../controls/VariableBoundPill';
import type { VariableIconKey } from '../../controls/VariableTypeIcon';

/** The variable glyph for a nav attr — matches the variable-modal type icon: href = chain (link), the boolean
 *  toggles = switch, text attrs = T. (Without this every link pill showed the chain icon.) */
function linkAttrIconKey(attrName: string): VariableIconKey {
  if (attrName === 'href') return 'link';
  if (attrName === 'target' || attrName === 'data-smooth-scroll' || attrName === 'data-keep-params') return 'boolean';
  return 'text';
}
import VariableModal from '../../ui/VariableModal';
import { activeFilePathAtom, isComponentLikeFilePath } from '@/code/project/active-file-store';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { parseComponentInfoFromSource } from '@/code/components/component-registry';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getVariableType } from '../../controls/variable-types';
import { getActiveAnimationScope } from '@/editor/tools/AnimationTool/animation-scope-source';
import { setResponsiveInstancePropVarInCode, resetResponsiveInstancePropVarInCode, getResponsiveInstancePropValueAtViewport, getInstancePropBaseValue, setInstancePropBaseInCode, setBoolNavCondForViewport, setBoolNavCondBase, getBoolNavCondBase, getBoolNavCondAtViewport, resetBoolNavCondForViewport, boolNavHasViewportBranches } from '@/code/generation/responsive-instance-prop-vars-gen';
import { modifyProjectFile } from '@/code/project/modify-file';
import type { LinkAttrKind } from '@/code/features/variable-ops';
import { mapItemIndexAtom, mapContextAtom, nodesAtom } from '@/code/stores/store';
import { cmsPageMetaAtom } from '@/code/stores/cms-page-store';
import { queueMutation, queueMutations, flushNow } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import LinkUrlControl, { LinkUrlField } from './LinkUrlControl';
import LinkNewTabControl from './LinkNewTabControl';
import LinkSmoothScrollControl from './LinkSmoothScrollControl';
import { syncLinkHandlerInCode } from '@/code/generation/generator-styles';
import LinkSectionControl from './LinkSectionControl';
import LinkRelControl from './LinkRelControl';
import LinkParamsControl from './LinkParamsControl';
import { parseRelTokens, isUserRelToken } from './link-rel-utils';
import LinkSlugControl, { type CmsNavMode, type SlugVariantContext } from './LinkSlugControl';

/** Slugify an anchor name. NOT cms-ops' slugify: this one hyphenates punctuation ('a.b' -> 'a-b', cms-ops deletes it) and has no 'untitled' fallback — ids/tokens generated here must stay stable. Do not merge (phase-9 9.1c). */
function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Value-column purple pill shown when a nav attribute (Link To / New Tab /
 * Smooth Scroll) IS a component variable. Mirrors `VariableBoundPillView`'s
 * markup so it's pixel-identical to the style-property bound pills. Only ever
 * rendered on a component master, so the purple `--accent-secondary` is
 * unconditional. The × detaches the variable (rewrites the attr back to a
 * literal + drops the prop) via the `removeLinkAttrVariable` mutation.
 */
function LinkVarBoundRow({ label, property, varName, onDetach, overridden, onResetOverride }: {
  label: string; property: string; varName: string; onDetach: () => void;
  /** On a REPLICA, this pill is a per-viewport variable → the LABEL goes purple + "Reset Override". */
  overridden?: boolean; onResetOverride?: () => void;
}) {
  // When wrapped in a HoistMenuItemProvider (a BASE-bound pill on a replica → offer Create/Set Variable so the
  // user can OVERRIDE it per-viewport), the label goes non-plain to surface the chevron menu — same as the
  // live control. The per-viewport pill itself isn't wrapped, so it stays plain (override accent only).
  const hoistItem = useHoistMenuItem();
  trace.fn('LinkVarBoundRow:render', { label, varName, overridden });
  return (
    <div className="flex items-center justify-between w-full">
      {/* A per-viewport (replica) variable shows the override accent + Reset Override on the LABEL, same as
          every other per-replica control. */}
      <ControlLabel label={label} property={property} plain={!hoistItem} overridden={overridden} onResetOverride={onResetOverride} />
      {/* The canonical bound-variable pill — same as every other control: the type glyph (iconKey), click the
          body to open the Variable modal (rename / edit default), × to unbind THIS node (keeps the variable). */}
      <LegacyVariableBoundPill
        property={property}
        propertyLabel={label}
        variableRef={varName}
        currentValue=""
        removeVariable={() => onDetach()}
        iconKey={linkAttrIconKey(property)}
      />
    </div>
  );
}

export default function LinkTool() {
  const { node, nodeId, isReplica, vpWidth } = useControl();
  // The active replica's banded media-query (for per-viewport link variables). Null on the primary.
  const replicaQuery = (() => {
    if (!isReplica) return null;
    const s = getActiveAnimationScope();
    return s && 'query' in s ? s.query : null;
  })();

  // Map context — when inside .map(), href may be bound to a data field
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const mapContext = useAtomValue(mapContextAtom);
  const isInMap = mapItemIndex != null && mapContext != null;

  // Resolve href: from map data if bound, otherwise from node attrs
  const hrefBinding = node?.attrBindings?.find(b => b.property === 'href');
  const mapItem = isInMap ? mapContext.mapData[mapItemIndex] : null;

  const isLink = node?.type === 'a' || node?.type === 'Link' || node?.type === 'MotionLink';
  const href = (isInMap && hrefBinding && mapItem)
    ? (mapItem[hrefBinding.field] ?? '')
    : (node?.attrs?.href ?? '');
  const target = node?.attrs?.target ?? '';
  const smoothScroll = node?.attrs?.['data-smooth-scroll'] ?? '';
  const relValue = node?.attrs?.rel ?? '';
  const keepParams = node?.attrs?.['data-keep-params'] ?? '';
  // CMS detail-page navigation: the `data-cms-nav` marker (set by the Slug
  // control or an Insert-panel prev/next drop) records a prev/next binding.
  const cmsPageMeta = useAtomValue(cmsPageMetaAtom);
  const isDetailPage = cmsPageMeta?.kind === 'detail';
  const navMode = (node?.attrs?.['data-cms-nav'] as CmsNavMode) || 'none';

  // Detect a CMS-backed map ancestor. Walks up from the selected node
  // looking for a wrapper whose `collectionList.source` is a real
  // collection slug (not the `__inline:…` placeholder for inline arrays).
  // When found, the Slug control becomes available on ANY page — picking
  // "This Row" binds the link to that row's item slug, so each rendered
  // map row navigates to its own detail page.
  const nodes = useAtomValue(nodesAtom);
  const cmsMapContext = useMemo(() => {
    if (!node) return null;
    let curr: typeof node | undefined = node;
    while (curr) {
      const src = curr.collectionList?.source;
      if (src && !src.startsWith('__inline:')) {
        return { collection: src, itemVar: curr.collectionList!.itemVar };
      }
      curr = curr.parentId ? nodes.get(curr.parentId) : undefined;
    }
    return null;
  }, [node, nodes]);

  // The collection to drive the Slug control against — detail-page meta
  // wins over an ancestor map (`<a>` on a detail page that happens to be
  // inside a "related posts" inline map should still navigate via
  // `params.slug`, not the row variable). Falls back to the map's
  // collection otherwise.
  const slugCollection = cmsPageMeta?.collection ?? cmsMapContext?.collection ?? '';
  // Which Set-Variable submenu items to show (Current/Prev/Next vs This Row
  // vs both). See `SlugVariantContext` in LinkSlugControl.tsx.
  const slugVariantContext: SlugVariantContext | null = isDetailPage && cmsMapContext
    ? 'both'
    : isDetailPage
      ? 'detail'
      : cmsMapContext
        ? 'row'
        : null;

  // A literal CMS item link is `href="/<collection>/<item-slug>"` — read
  // the slug back out so the Slug control's input shows it. Only when not
  // variable-bound.
  const cmsRoutePrefix = slugCollection ? `/${slugCollection}/` : '';
  const literalSlug = (navMode === 'none' && !!cmsRoutePrefix && href.startsWith(cmsRoutePrefix))
    ? href.slice(cmsRoutePrefix.length)
    : '';
  // A/B test tracking id — `data-revyme-track="<slug>"`. The deployed
  // Worker's inline script (see WORKER_ENTRY in build-project.ts) listens
  // for clicks on any element carrying this attribute and beacons the
  // event back so the A/B test results dashboard can count conversions
  // per variant. The slug is used as the goal-id in the AE event row.
  const trackingId = node?.attrs?.['data-revyme-track'] ?? '';

  const [localTracking, setLocalTracking] = useState(trackingId);

  // Optional controls toggled via the section's `+` menu (Rel / Parameters).
  // A control is shown when manually added OR when its attr is already present
  // (incl. as a variable). Tracking stays always-visible (existing behaviour).
  const [addedControls, setAddedControls] = useState<Set<'rel' | 'params' | 'tracking'>>(new Set());
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // ─── Navigation attribute → variable ───────────────────────────────
  // On a component MASTER, Link To / New Tab / Smooth Scroll can become
  // component variables (props the page instance sets). Tracking + Anchor
  // are intentionally NOT variable-able. The chevron "Create Variable" item
  // is injected via HoistMenuItemProvider so each control's ControlLabel
  // surfaces it; confirming dispatches `createLinkAttrVariable`.
  const activeFile = useAtomValue(activeFilePathAtom);
  // A TEMPLATE behaves like a design-component MASTER for the variable system + master link handling (Create
  // Variable on Link To / New Tab, MotionLink conversion, slug props). Use the component-LIKE check, NOT the
  // narrow `components/`-only `isComponentFilePath` — otherwise "Create Variable" never appeared on a link
  // inside a template (the classic isComponentFileAtom-is-true-for-templates trap). False for plain pages.
  const isComponentFile = isComponentLikeFilePath(activeFile);
  const [linkVar, setLinkVar] = useState<
    { attrName: string; kind: LinkAttrKind; current: string; variableType: 'text' | 'boolean'; propLabel: string; createdName: string } | null
  >(null);
  const pageVariables = useAtomValue(pageVariablesAtom);

  // INSTANT-create flow (design-tool parity, matching ControlLabel's onOpenVariableModal): clicking "Create
  // Variable" creates the variable NOW (auto unique name) + dispatches createLinkAttrVariable, then opens the
  // SAME modal in EDIT mode (nameEditable) focused on the new var for rename — NOT a separate "Create
  // Variable" FORM with a confirm button (the old path the user hit).
  const createLinkVariableInstant = useCallback(
    (attrName: string, kind: LinkAttrKind, current: string, variableType: 'text' | 'boolean', propLabel: string) => {
      if (!nodeId) return;
      const base = attrName === 'href' ? 'linkHref' : attrName === 'target' ? 'openInNewTab'
        : attrName === 'data-revyme-track' ? 'trackingId' : attrName === 'rel' ? 'relTokens'
        : attrName === 'data-keep-params' ? 'keepParams' : 'smoothScroll';
      const taken = new Set(pageVariables.map((v) => v.name));
      let name = base;
      for (let i = 1; taken.has(name); i++) name = `${base}${i}`;
      // PER-VIEWPORT (replica): create the variable as a bare typed param, then bind it for THIS tile ONLY via
      // an inline `href={__mq ? newVar : <current>}` ternary — the primary keeps its value. Same per-viewport
      // rail design components/code-component props use. (href only; the boolean nav attrs put the var INSIDE a
      // ternary, which `setResponsiveInstancePropVarInCode` — wrapping the whole attr — can't bind per-tile.)
      if (replicaQuery && attrName === 'href') {
        const muts: any[] = [
          { type: 'createTypedVariable', name, literalKind: 'string', defaultValue: current },
          { type: 'setComponentPropType', propName: name, varType: 'link' },
        ];
        if (node?.type !== 'MotionLink') muts.push({ type: 'convertToMotionLink', nodeId });
        queueMutations(muts);
        flushNow();
        modifyProjectFile(activeFile, (c) => setResponsiveInstancePropVarInCode(c, nodeId, 'MotionLink', replicaQuery, 'href', name));
        trace.action('link-tool:create-variable-replica', { nodeId, name, query: replicaQuery });
        setLinkVar({ attrName, kind, current, variableType, propLabel, createdName: name });
        return;
      }
      // PER-VIEWPORT (replica) boolean-nav variable (New Tab / Smooth Scroll) — create a bare boolean param,
      // then bind it as THIS tile's condition `(__mq ? newVar : <base>) ? "ON" : undefined`, primary kept.
      if (replicaQuery && (attrName === 'target' || attrName === 'data-smooth-scroll')) {
        const muts: any[] = [{ type: 'createTypedVariable', name, literalKind: 'boolean', defaultValue: current === 'true' ? 'true' : 'false' }];
        if (node?.type !== 'MotionLink') muts.push({ type: 'convertToMotionLink', nodeId });
        queueMutations(muts);
        flushNow();
        modifyProjectFile(activeFile, (c) => {
          let out = setBoolNavCondForViewport(c, nodeId, 'MotionLink', replicaQuery, attrName, name);
          if (attrName === 'data-smooth-scroll') out = syncLinkHandlerInCode(out, nodeId);
          return out;
        });
        trace.action('link-tool:create-boolnav-var-replica', { nodeId, name, attrName, query: replicaQuery });
        setLinkVar({ attrName, kind, current, variableType, propLabel, createdName: name });
        return;
      }
      const mutations: any[] = [];
      const isNavAttr = attrName !== 'data-revyme-track';
      if (isNavAttr && node?.type !== 'MotionLink') mutations.push({ type: 'convertToMotionLink', nodeId });
      mutations.push({ type: 'createLinkAttrVariable', nodeId, attrName, propName: name, kind, defaultValue: current, variableType });
      // A href var is the rich 'link' TYPE (its @pageVariables PRIMITIVE is 'text', but @propMeta carries the
      // real type → the link icon + the page-picker default editor). Without this it showed the "T" text icon.
      if (attrName === 'href') mutations.push({ type: 'setComponentPropType', propName: name, varType: 'link' });
      queueMutations(mutations);
      flushNow();
      trace.action('link-tool:create-variable-instant', { nodeId, attr: attrName, name, kind });
      setLinkVar({ attrName, kind, current, variableType, propLabel, createdName: name });
    },
    [nodeId, node?.type, pageVariables, replicaQuery, activeFile],
  );
  // Note: NOT gated on `isLink`. On a master you can create a nav variable
  // directly on any element — the create flow converts it to a link first
  // (see onCreateVariable). This matches "I open + Navigation and make a
  // variable" without first typing a URL.
  // Existing master variables (params + @propMeta types) — for the "Set Variable" submenu. Re-read on every
  // mutation flush (projectVersion) so a just-created var shows up.
  const projectVersion = useAtomValue(projectVersionAtom);
  const masterVars = useMemo(() => {
    if (!isComponentFile || !activeFile) return [] as { name: string; label: string; varType?: string; default?: string }[];
    const code = projectFS.readFile(activeFile);
    if (!code) return [];
    const props = parseComponentInfoFromSource(activeFile, code, String(code.length))?.props ?? [];
    return props.filter((p) => p.name !== 'children' && p.name !== 'style')
      .map((p) => ({ name: p.name, label: p.label || p.name, varType: p.varType, default: p.defaultValue ?? '' }));
  }, [isComponentFile, activeFile, projectVersion]);

  // The compatible variable FAMILY for a nav attr: href → 'link', the boolean toggles → 'toggle', text → 'plainText'.
  const attrFamily = (attrName: string): string =>
    attrName === 'href' ? 'link'
      : (attrName === 'target' || attrName === 'data-smooth-scroll' || attrName === 'data-keep-params') ? 'toggle'
        : 'plainText';

  // Bind an EXISTING variable to the attr (Set Variable). Reuses createLinkAttrVariable — rewriting the attr
  // to `{var}`; the param + @pageVariables add-ops are idempotent for an already-existing variable.
  const bindLinkVariable = useCallback((attrName: string, kind: LinkAttrKind, variableType: 'text' | 'boolean', varName: string) => {
    if (!nodeId) return;
    // PER-VIEWPORT (replica): bind the existing var for THIS tile only (inline `__mq` ternary), primary kept.
    if (replicaQuery && attrName === 'href') {
      if (node?.type !== 'MotionLink') { queueMutations([{ type: 'convertToMotionLink', nodeId }]); flushNow(); }
      modifyProjectFile(activeFile, (c) => setResponsiveInstancePropVarInCode(c, nodeId, 'MotionLink', replicaQuery, 'href', varName));
      trace.action('link-tool:set-variable-replica', { nodeId, varName, query: replicaQuery });
      return;
    }
    // Boolean nav (New Tab / Smooth Scroll): bind the existing boolean var as THIS tile's condition, primary kept.
    if (replicaQuery && (attrName === 'target' || attrName === 'data-smooth-scroll')) {
      if (node?.type !== 'MotionLink') { queueMutations([{ type: 'convertToMotionLink', nodeId }]); flushNow(); }
      modifyProjectFile(activeFile, (c) => {
        let out = setBoolNavCondForViewport(c, nodeId, 'MotionLink', replicaQuery, attrName, varName);
        if (attrName === 'data-smooth-scroll') out = syncLinkHandlerInCode(out, nodeId);
        return out;
      });
      trace.action('link-tool:set-boolnav-var-replica', { nodeId, varName, attrName, query: replicaQuery });
      return;
    }
    const mutations: any[] = [];
    const isNavAttr = attrName !== 'data-revyme-track';
    if (isNavAttr && node?.type !== 'MotionLink') mutations.push({ type: 'convertToMotionLink', nodeId });
    mutations.push({ type: 'createLinkAttrVariable', nodeId, attrName, propName: varName, kind, defaultValue: '', variableType });
    queueMutations(mutations);
    flushNow();
    trace.action('link-tool:set-variable', { nodeId, attr: attrName, varName });
  }, [nodeId, node?.type, replicaQuery, activeFile]);

  const makeLinkVarItem = useCallback(
    (attrName: string, kind: LinkAttrKind, current: string, variableType: 'text' | 'boolean', propLabel: string): MenuItem[] | null => {
      if (!isComponentFile || !nodeId) return null;
      const items: MenuItem[] = [{
        label: 'Create Variable',
        show: true,
        hoverColor: 'accent-secondary' as const,
        onClick: () => createLinkVariableInstant(attrName, kind, current, variableType, propLabel),
      }];
      // Set Variable — bind an existing variable of the SAME family (a href control offers 'link' vars, …).
      const family = attrFamily(attrName);
      const compatible = masterVars.filter((v) => (getVariableType(v.varType)?.iconKey ?? 'plainText') === family);
      if (compatible.length > 0) {
        items.push({
          label: 'Set Variable',
          show: true,
          hoverColor: 'accent-secondary' as const,
          onClick: () => { /* parent no-op; submenu opens on hover */ },
          submenuItems: compatible.map((v) => ({
            label: v.label,
            show: true,
            hoverColor: 'accent-secondary' as const,
            onClick: () => bindLinkVariable(attrName, kind, variableType, v.name),
          })),
        });
      }
      return items;
    },
    [isComponentFile, nodeId, createLinkVariableInstant, masterVars, bindLinkVariable],
  );

  // ─── Variable-bound nav attrs (master) ─────────────────────────────
  // After a nav attr becomes a component variable, the parser records its
  // value as `var:<propName>` (see parser.ts htmlAttr branch). Detect that
  // and render the purple bound pill instead of the live control.
  // A ternary-gated href (`href={(__mq2 ? branch : base)}`) parses to `var:__mqN` (the media GATE), HIDING the
  // real base. Recover the BASE (else-branch) from code so the PRIMARY still shows its variable/value; `effHref`
  // replaces the mis-parsed node href for primary display + base-var detection.
  const hrefBase = useMemo(() => {
    if (!nodeId || !node?.type) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getInstancePropBaseValue(code, nodeId, node.type, 'href');
  }, [nodeId, node?.type, activeFile, projectVersion]);
  const effHref = hrefBase ? (hrefBase.isVar ? `var:${hrefBase.value}` : hrefBase.value) : href;
  const hrefVar = effHref.startsWith('var:') && !effHref.slice(4).startsWith('__mq') ? effHref.slice(4) : null;
  // New Tab (`target`) lives in a boolean ternary `<cond> ? "_blank" : undefined`, made per-viewport on the
  // CONDITION: `(__mq ? <vpCond> : <baseCond>) ? "_blank" : undefined`. cond = 'true' | 'false' | varName.
  const newTabCondBase = useMemo(() => {
    if (!nodeId || !node?.type) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getBoolNavCondBase(code, nodeId, node.type, 'target'); // 'true' | 'false' | varName | null
  }, [nodeId, node?.type, activeFile, projectVersion]);
  const newTabCondVp = useMemo(() => {
    if (!isReplica || !nodeId || !node?.type || !vpWidth) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getBoolNavCondAtViewport(code, nodeId, node.type, 'target', vpWidth); // 'true'|'false'|varName|null
  }, [isReplica, nodeId, node?.type, vpWidth, activeFile, projectVersion]);
  // The ACTIVE condition for this surface (replica override wins) + whether it's a variable.
  const newTabCond = newTabCondVp ?? newTabCondBase;
  const isToggleCond = (c: string | null) => c === 'true' || c === 'false' || c == null;
  // Base variable name (when the BASE cond is a variable — for the targetVar pill on the primary).
  const targetVar = newTabCondBase && !isToggleCond(newTabCondBase) ? newTabCondBase : null;
  // Per-viewport variable on THIS replica tile (a variable override).
  const newTabVpVar = newTabCondVp && !isToggleCond(newTabCondVp) ? newTabCondVp : null;
  const resetTargetVp = useCallback(() => {
    if (!nodeId || !node?.type || !replicaQuery) return;
    modifyProjectFile(activeFile, (c) => resetBoolNavCondForViewport(c, nodeId, node.type, replicaQuery, 'target'));
    trace.action('link-tool:reset-newtab-replica', { nodeId, query: replicaQuery });
  }, [nodeId, node?.type, replicaQuery, activeFile]);
  // Smooth Scroll (`data-smooth-scroll`) is a boolean nav attr — same inner-condition per-viewport rail as
  // New Tab. cond = 'true' | 'false' | varName.
  const smoothCondBase = useMemo(() => {
    if (!nodeId || !node?.type) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getBoolNavCondBase(code, nodeId, node.type, 'data-smooth-scroll');
  }, [nodeId, node?.type, activeFile, projectVersion]);
  const smoothCondVp = useMemo(() => {
    if (!isReplica || !nodeId || !node?.type || !vpWidth) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getBoolNavCondAtViewport(code, nodeId, node.type, 'data-smooth-scroll', vpWidth);
  }, [isReplica, nodeId, node?.type, vpWidth, activeFile, projectVersion]);
  const smoothVar = smoothCondBase && !isToggleCond(smoothCondBase) ? smoothCondBase : null;
  const smoothVpVar = smoothCondVp && !isToggleCond(smoothCondVp) ? smoothCondVp : null;
  const resetSmoothVp = useCallback(() => {
    if (!nodeId || !node?.type || !replicaQuery) return;
    modifyProjectFile(activeFile, (c) => syncLinkHandlerInCode(resetBoolNavCondForViewport(c, nodeId, node.type, replicaQuery, 'data-smooth-scroll'), nodeId));
    trace.action('link-tool:reset-smooth-replica', { nodeId, query: replicaQuery });
  }, [nodeId, node?.type, replicaQuery, activeFile]);

  // PER-VIEWPORT (replica) href override — the inline `href={(__mq ? branch : base)}` ternary's branch for
  // THIS tile, as { value, isVar }. Read from CODE, NOT the node (the parser doesn't capture link-attr
  // per-viewport state). `isVar` = a per-tile VARIABLE (bound pill); `!isVar` = a per-tile LITERAL override
  // (e.g. after X-ing a base var on a replica → normal input + purple label + Reset Override).
  const hrefVp = useMemo(() => {
    if (!isReplica || !nodeId || !node?.type || !vpWidth) return null;
    const code = projectFS.readFile(activeFile);
    if (!code) return null;
    return getResponsiveInstancePropValueAtViewport(code, nodeId, node.type, vpWidth).get('href') ?? null;
  }, [isReplica, nodeId, node?.type, vpWidth, activeFile, projectVersion]);

  // Reset the per-viewport href branch → revert THIS tile to the primary's href (drops the `__mq` ternary).
  const resetHrefVp = useCallback(() => {
    if (!nodeId || !node?.type || !replicaQuery) return;
    modifyProjectFile(activeFile, (c) => resetResponsiveInstancePropVarInCode(c, nodeId, node.type, replicaQuery, 'href'));
    trace.action('link-tool:reset-href-replica', { nodeId, query: replicaQuery });
  }, [nodeId, node?.type, replicaQuery, activeFile]);

  // Edit the per-viewport LITERAL href on THIS tile (the normal input under a per-tile override) — rewrites
  // just this tile's branch, primary kept.
  const setHrefVpLiteral = useCallback((url: string) => {
    if (!nodeId || !node?.type || !replicaQuery) return;
    modifyProjectFile(activeFile, (c) => setResponsiveInstancePropVarInCode(c, nodeId, node.type, replicaQuery, 'href', JSON.stringify(url)));
    trace.action('link-tool:set-href-literal-replica', { nodeId, query: replicaQuery });
  }, [nodeId, node?.type, replicaQuery, activeFile]);

  const trackingVar = trackingId.startsWith('var:') ? trackingId.slice(4) : null;
  const relVar = relValue.startsWith('var:') ? relValue.slice(4) : null;
  const paramsVar = keepParams.startsWith('var:') ? keepParams.slice(4) : null;
  // A control shows when manually added via the `+` menu OR its attr already
  // exists (literal or variable). For Rel, only USER tokens count as "present"
  // (the auto `noopener noreferrer` on external links shouldn't auto-open Rel).
  const showRel = (!!relValue && !relVar && parseRelTokens(relValue).some(isUserRelToken)) || !!relVar || addedControls.has('rel');
  const showParams = !!keepParams || !!paramsVar || addedControls.has('params');
  const showTracking = !!trackingId || !!trackingVar || addedControls.has('tracking');

  const detachLinkVar = useCallback((attrName: string, propName: string, kind: LinkAttrKind) => {
    if (!nodeId) return;
    // ON A REPLICA: removing the BASE binding would hit EVERY viewport (the bug the user saw). Scope to THIS
    // tile only — diverge it by writing the variable's current value as a per-viewport LITERAL
    // (`href={__mq ? "<value>" : <baseVar>}`), leaving the primary's variable intact. Same as the
    // design/code-component "remove variable on a replica" rule. (href only; boolean attrs handled separately.)
    if (replicaQuery && attrName === 'href') {
      const v = masterVars.find((m) => m.name === propName);
      modifyProjectFile(activeFile, (c) =>
        setResponsiveInstancePropVarInCode(c, nodeId, node?.type ?? 'a', replicaQuery, 'href', JSON.stringify(v?.default ?? '')));
      trace.action('link-tool:detach-variable-replica', { nodeId, propName, query: replicaQuery });
      return;
    }
    // ON THE PRIMARY but the href has PER-VIEWPORT branches (tablet/mobile hold INDIVIDUAL values): removing
    // the whole binding would wipe those configs. Only clear the BASE (else-branch) → the SYNCED viewports
    // (which fell through to the base) drop to a normal empty input, the individual per-tile branches stay
    // INTACT. (Removing from primary updates only the synced replicas; individual settings persist.)
    if (attrName === 'href' && hrefBase) {
      modifyProjectFile(activeFile, (c) => setInstancePropBaseInCode(c, nodeId, node?.type ?? 'a', 'href', '""'));
      trace.action('link-tool:detach-primary-keep-branches', { nodeId, propName });
      return;
    }
    // Boolean nav attrs (New Tab `target`, Smooth Scroll `data-smooth-scroll`) — unbinding the variable = set
    // the condition to No, SCOPED: replica → No on THIS tile (keep base var); primary-with-branches → base No
    // (keep per-tile branches). Smooth also re-syncs the onClick (reads the resolved attr).
    if (attrName === 'target' || attrName === 'data-smooth-scroll') {
      const tag = node?.type ?? 'a';
      const sync = (c: string) => attrName === 'data-smooth-scroll' ? syncLinkHandlerInCode(c, nodeId) : c;
      if (replicaQuery) {
        modifyProjectFile(activeFile, (c) => sync(setBoolNavCondForViewport(c, nodeId, tag, replicaQuery, attrName, 'false')));
        trace.action('link-tool:detach-boolnav-replica', { nodeId, attrName, query: replicaQuery });
        return;
      }
      const code = projectFS.readFile(activeFile) ?? '';
      if (boolNavHasViewportBranches(code, nodeId, tag, attrName)) {
        modifyProjectFile(activeFile, (c) => sync(setBoolNavCondBase(c, nodeId, tag, attrName, 'false')));
        trace.action('link-tool:detach-boolnav-primary-keep-branches', { nodeId, attrName });
        return;
      }
      // No per-viewport branches → unbind wholesale (keep the variable).
    }
    trace.action('link-tool:detach-variable', { nodeId, attrName, propName, kind });
    // The × on the pill (PRIMARY, no per-viewport branches) UNBINDS this node only — keep the variable.
    queueMutation({ type: 'removeLinkAttrVariable', nodeId, attrName, propName, kind, keepVariable: true });
    flushNow();
  }, [nodeId, replicaQuery, masterVars, node?.type, activeFile, hrefBase]);

  // Parse href into page slug + section. A variable-bound href has no
  // literal slug/section to parse — treat as empty so the section/CMS
  // controls don't try to interpret `var:linkHref` as a URL.
  const isExternal = !hrefVar && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:'));
  const [pagePart, sectionPart] = isExternal ? [href, ''] : href.split('#');
  const hasSection = !!sectionPart;

  // Keep tracking id in sync — code-side edits / file switches reset it.
  useEffect(() => { setLocalTracking(trackingId); }, [trackingId]);

  // ─── Handlers ──────────────────────────────────────────────────────

  // Revert a link element back to a plain container when its LAST navigation
  // source is removed (X on the Slug pill, cleared Link To / literal slug). A
  // `<Link>`/`<MotionLink>` with no href CRASHES at SSR — next/link's resolveHref
  // runs formatWithValidation(undefined) → reads `.pathname` of undefined → the
  // deployed Cloudflare Worker throws (Error 1101, blank page). A "link that
  // navigates nowhere" is just a div: rename the tag (MotionLink → motion.div on
  // a master, Link/a → div on a page) and drop the link-reset styles. Adding a
  // slug or any URL re-converts div → Link (handleSlugChange / handleUrlChange).
  const revertLinkToDivMutations = useCallback((): any[] => {
    const t = node?.type;
    const muts: any[] = [];
    if (t === 'MotionLink') muts.push({ type: 'changeTag', nodeId, newTag: 'motion.div' });
    else if (t === 'Link' || t === 'a') muts.push({ type: 'changeTag', nodeId, newTag: 'div' });
    else return muts; // already a non-link — nothing to revert
    // '' removes the property (the textDecoration:none / color:inherit added on link-ify).
    muts.push({ type: 'updateStyles', nodeId, styles: { textDecoration: '', color: '' } });
    return muts;
  }, [node?.type, nodeId]);

  const handleUrlChange = useCallback((newHref: string) => {
    if (!nodeId) return;
    const isExternal = newHref.startsWith('http://') || newHref.startsWith('https://') || newHref.startsWith('mailto:');
    trace.action('link-tool:url-change', { nodeId, href: newHref, isComponentFile, isExternal });

    // Cleared the URL (no CMS-nav binding, not bound to a map data field) → the
    // element navigates nowhere → revert it to a plain container rather than
    // leave a href-less <Link> (which crashes SSR — see revertLinkToDivMutations).
    if (!newHref && navMode === 'none' && !hrefBinding) {
      queueMutations([
        { type: 'updateHtmlAttrs', nodeId, attrs: { href: '' } },
        ...revertLinkToDivMutations(),
      ]);
      return;
    }

    const mutations: any[] = [];
    const currentType = node?.type || 'div';

    if (isComponentFile && !isExternal) {
      // On a component MASTER an internal link must be a `<MotionLink>`
      // (`motion.create(Link)` wrapper) so client-side nav AND the master's
      // framer-motion props (variants/layout/initial/animate) both survive. A
      // plain `<Link>` is NOT a motion component → breaks the variant system.
      if (currentType !== 'MotionLink') {
        mutations.push({ type: 'convertToMotionLink', nodeId });
      }
    } else {
      // Internal links → <Link> (Next.js), external → <a> (full reload is
      // expected for external; motion is preserved via the motion.* re-wrap).
      const targetTag = isExternal ? 'a' : 'Link';
      if (currentType !== targetTag || !isLink) {
        mutations.push({ type: 'changeTag', nodeId, newTag: targetTag });
        mutations.push({ type: 'updateStyles', nodeId, styles: { textDecoration: 'none', color: 'inherit' } });
      }
    }

    // Set href — route through map data if inside .map() with binding
    if (isInMap && hrefBinding && mapContext) {
      const updatedItem = { ...(mapContext.mapData[mapItemIndex!] || {}), [hrefBinding.field]: newHref };
      mutations.push({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex!, item: updatedItem });
    } else {
      const attrs: Record<string, string> = { href: newHref };
      // Auto-add rel for external links
      if (isExternal) {
        attrs.rel = 'noopener noreferrer';
      }
      mutations.push({ type: 'updateHtmlAttrs', nodeId, attrs });
    }

    // (Re)sync the anchor-scroll handler — a new `#anchor` href should scroll
    // on click (instantly, or smoothly if smooth is on) without relying on the
    // unreliable native hash navigation.
    mutations.push({ type: 'syncLinkHandler', nodeId });

    queueMutations(mutations);
  }, [nodeId, isLink, node?.type, isComponentFile, isInMap, hrefBinding, mapContext, mapItemIndex, navMode, revertLinkToDivMutations]);

  const handleNewTabChange = useCallback((newTab: boolean) => {
    if (!nodeId) return;
    trace.action('link-tool:new-tab', { nodeId, newTab, isReplica });
    const cond = newTab ? 'true' : 'false';
    const tag = node?.type ?? 'a';
    // PER-VIEWPORT (replica): write the boolean condition for THIS tile only — primary + other tiles kept.
    if (replicaQuery) {
      modifyProjectFile(activeFile, (c) => setBoolNavCondForViewport(c, nodeId, tag, replicaQuery, 'target', cond));
      return;
    }
    // PRIMARY: if per-viewport branches exist, write ONLY the base condition (keep the per-tile branches);
    // else the plain `target` attr. (Same remove/change-from-primary rule as href — individual tiles stay.)
    const code = projectFS.readFile(activeFile) ?? '';
    if (boolNavHasViewportBranches(code, nodeId, tag, 'target')) {
      modifyProjectFile(activeFile, (c) => setBoolNavCondBase(c, nodeId, tag, 'target', cond));
      return;
    }
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { target: newTab ? '_blank' : '' } });
  }, [nodeId, isReplica, replicaQuery, node?.type, activeFile]);

  const handleSmoothScrollChange = useCallback((smooth: boolean) => {
    if (!nodeId) return;
    trace.action('link-tool:smooth-scroll', { nodeId, smooth, href, isReplica });
    const cond = smooth ? 'true' : 'false';
    const tag = node?.type ?? 'a';
    // PER-VIEWPORT (replica): write the condition for THIS tile, then re-sync the onClick (now reads the
    // resolved `data-smooth-scroll` at runtime — it sees the per-viewport brace and leaves it intact).
    if (replicaQuery) {
      modifyProjectFile(activeFile, (c) => syncLinkHandlerInCode(setBoolNavCondForViewport(c, nodeId, tag, replicaQuery, 'data-smooth-scroll', cond), nodeId));
      return;
    }
    // PRIMARY with per-viewport branches → write the base condition only (keep the per-tile branches).
    const code = projectFS.readFile(activeFile) ?? '';
    if (boolNavHasViewportBranches(code, nodeId, tag, 'data-smooth-scroll')) {
      modifyProjectFile(activeFile, (c) => syncLinkHandlerInCode(setBoolNavCondBase(c, nodeId, tag, 'data-smooth-scroll', cond), nodeId));
      return;
    }
    // Plain (no per-viewport): the existing toggle mutation (literal marker + onClick).
    queueMutation({ type: 'setSmoothScroll', nodeId, enabled: smooth });
  }, [nodeId, href, isReplica, replicaQuery, node?.type, activeFile]);

  // Rel tokens — `rel="nofollow noreferrer …"`. Empty removes the attr.
  const handleRelChange = useCallback((rel: string) => {
    if (!nodeId) return;
    trace.action('link-tool:rel-change', { nodeId, rel });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { rel } });
  }, [nodeId]);

  // Parameters Keep/Ignore — `data-keep-params="true"` (Keep) or removed.
  // The runtime onClick (synced) forwards the current query when on.
  const handleParamsChange = useCallback((keep: boolean) => {
    if (!nodeId) return;
    trace.action('link-tool:params-change', { nodeId, keep });
    queueMutations([
      { type: 'updateHtmlAttrs', nodeId, attrs: { 'data-keep-params': keep ? 'true' : '' } },
      { type: 'syncLinkHandler', nodeId },
    ]);
  }, [nodeId]);

  // Show/hide an optional Link sub-control (Rel / Parameters) from the `+`
  // add-menu. Unchecking clears the literal attr too (a bound variable is
  // detached via its pill ×, not here).
  const toggleOptionalControl = useCallback((key: 'rel' | 'params' | 'tracking', currentlyShown: boolean) => {
    if (!nodeId) return;
    trace.action('link-tool:toggle-optional', { nodeId, key, currentlyShown });
    if (currentlyShown) {
      if (key === 'rel') {
        queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { rel: '' } });
      } else if (key === 'params') {
        queueMutations([
          { type: 'updateHtmlAttrs', nodeId, attrs: { 'data-keep-params': '' } },
          { type: 'syncLinkHandler', nodeId },
        ]);
      } else {
        setLocalTracking('');
        queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { 'data-revyme-track': '' } });
      }
      setAddedControls((prev) => { const n = new Set(prev); n.delete(key); return n; });
    } else {
      setAddedControls((prev) => new Set(prev).add(key));
    }
    setAddMenuOpen(false);
  }, [nodeId]);

  // A/B test tracking id. Writes `data-revyme-track="<slug>"` onto the
  // element. The Worker's inline tracking script (see WORKER_ENTRY)
  // beacons any click on this element to /_revyme/ab/event with this
  // slug as the goal-id — visible per-variant in the A/B Tests results.
  // Empty value removes the attribute (clears the tracking).
  const handleTrackingChange = useCallback((value: string) => {
    if (!nodeId) return;
    const slug = slugify(value);
    setLocalTracking(slug);
    trace.action('link-tool:tracking-change', { nodeId, to: slug });
    queueMutation({
      type: 'updateHtmlAttrs',
      nodeId,
      attrs: { 'data-revyme-track': slug },
    });
  }, [nodeId]);

  const handleSectionChange = useCallback((section: string) => {
    if (!nodeId) return;
    // Build href: use /#section format so it works from any page
    const base = pagePart || '/';
    const newHref = section ? `${base}#${section}` : base;
    trace.action('link-tool:section-change', { nodeId, section, newHref, isInMap });

    if (isInMap && hrefBinding && mapContext) {
      // Map mode: update the data array item's href field
      const updatedItem = { ...(mapContext.mapData[mapItemIndex!] || {}), [hrefBinding.field]: newHref };
      queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex!, item: updatedItem });
    } else {
      // Set the #section href + (re)sync the anchor-scroll handler so the link
      // scrolls to the section on click (instant, or smooth when enabled).
      queueMutations([
        { type: 'updateHtmlAttrs', nodeId, attrs: { href: newHref } },
        { type: 'syncLinkHandler', nodeId },
      ]);
    }
  }, [nodeId, pagePart, isInMap, hrefBinding, mapContext, mapItemIndex]);

  // CMS slug binding. Picks one of:
  //   - Detail page: Current / Previous / Next → resolve via `params.slug`.
  //   - Inside CMS map: This Row → resolve via the iterator var (`item._slug`).
  // Either way: convert to <Link> (if not already) + write the href
  // expression + stamp `data-cms-nav` marker the tool reads back. 'none'
  // clears everything.
  const handleSlugChange = useCallback((mode: CmsNavMode) => {
    if (!nodeId || !slugCollection) return;
    trace.action('link-tool:slug-change', { nodeId, mode, collection: slugCollection });
    const mutations: any[] = [];
    if (mode !== 'none') {
      // Master → MotionLink wrapper (keeps motion/variants); page → <Link>.
      if (isComponentFile) {
        if (node?.type !== 'MotionLink') mutations.push({ type: 'convertToMotionLink', nodeId });
      } else if (node?.type !== 'Link') {
        mutations.push({ type: 'changeTag', nodeId, newTag: 'Link' });
        mutations.push({ type: 'updateStyles', nodeId, styles: { textDecoration: 'none', color: 'inherit' } });
      }
    }
    mutations.push({
      type: 'setCmsNavHref',
      nodeId,
      mode,
      collection: slugCollection,
      // itemVar is required ONLY for 'row' mode. For other modes the
      // generator ignores it. Pulled off the wrapping map's
      // `collectionList.itemVar` (e.g. 'item', 'post', etc.).
      itemVar: cmsMapContext?.itemVar,
    });
    // X on the Slug pill (mode='none') removes the only navigation — while a
    // slug is bound the Link To field is disabled, so nothing else drives the
    // href. `setCmsNavHref` just stripped it, leaving a bare <Link>; revert it
    // to a div (a href-less link crashes SSR). Re-adding a slug re-links it.
    if (mode === 'none') mutations.push(...revertLinkToDivMutations());
    queueMutations(mutations);
  }, [nodeId, node?.type, isComponentFile, slugCollection, cmsMapContext, revertLinkToDivMutations]);

  // Literal CMS item link — a plain string href to one specific item.
  // Works on EITHER a detail page or inside a CMS map — same shape: pick
  // a slug from the collection's autocomplete and the link points at
  // `/<col>/<slug>`. Variable marker cleared because a literal isn't a
  // variable.
  const handleLiteralSlugChange = useCallback((slug: string) => {
    if (!nodeId || !slugCollection) return;
    trace.action('link-tool:literal-slug', { nodeId, slug, collection: slugCollection });
    const mutations: any[] = [];
    if (slug) {
      // Non-empty slug → ensure it's a link, then point it at the item.
      if (isComponentFile) {
        if (node?.type !== 'MotionLink') mutations.push({ type: 'convertToMotionLink', nodeId });
      } else if (node?.type !== 'Link') {
        mutations.push({ type: 'changeTag', nodeId, newTag: 'Link' });
        mutations.push({ type: 'updateStyles', nodeId, styles: { textDecoration: 'none', color: 'inherit' } });
      }
      mutations.push({ type: 'updateHtmlAttrs', nodeId, attrs: { href: `/${slugCollection}/${slug}`, 'data-cms-nav': '' } });
    } else {
      // Cleared the literal slug → navigates nowhere → revert to a plain div
      // (don't leave a href-less <Link>, which crashes SSR).
      mutations.push({ type: 'updateHtmlAttrs', nodeId, attrs: { href: '', 'data-cms-nav': '' } });
      mutations.push(...revertLinkToDivMutations());
    }
    queueMutations(mutations);
  }, [nodeId, node?.type, isComponentFile, slugCollection, revertLinkToDivMutations]);

  trace.fn('LinkTool:render', { nodeId, isLink, href });

  // `+` add-menu — the ONLY header action. Toggles the optional Rel /
  // Parameters / Tracking controls. The Link section itself is always present
  // (Link To / New Tab / Anchor), so there's no add/remove or collapse toggle.
  // Design mirrors the Animation tool's `+` (AddEffectDropdown) exactly:
  // wide hit area + `relative`-anchored `absolute right-0` flyout, 13px items,
  // blue `hover:!bg-[var(--accent)]`, white-on-hover text, backdrop to close.
  // Nothing left to add → hide the `+` entirely (Rel + Parameters + Tracking
  // all already on the link).
  const allOptionalAdded = showRel && showParams && showTracking;
  const addMenuAction = allOptionalAdded ? null : (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setAddMenuOpen((o) => !o); }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add link control"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {addMenuOpen && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setAddMenuOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
            {/* Only controls NOT yet on the link — once added it's shown in the
                section, so it drops off the menu (no checkmark / left gutter). */}
            {(() => {
              const opts = ([['rel', 'Rel', showRel], ['params', 'Parameters', showParams], ['tracking', 'Tracking', showTracking]] as const).filter(([, , shown]) => !shown);
              if (opts.length === 0) {
                return <div className="px-2.5 py-1.5 text-xs text-[var(--text-secondary)] whitespace-nowrap">All controls added</div>;
              }
              return opts.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleOptionalControl(key, false)}
                  className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
                >
                  <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white">{label}</span>
                </button>
              ));
            })()}
          </div>
        </>
      )}
    </div>
  );

  // Check if parent is already a link (nested link warning)
  const isNestedLink = useMemo(() => {
    if (!node?.parentId) return false;
    // Simple check — would need node tree for full check
    return false;
  }, [node]);

  return (
    <ToolSection title="Navigation" collapsible={false} action={addMenuAction}>
      <div className="contents">
        {isNestedLink && (
          <div className="px-2 py-1.5 text-[10px] text-orange-400 bg-orange-500/10 rounded mb-1">
            Warning: nested links are invalid HTML
          </div>
        )}

        {/* Link To — stays visible while a CMS nav binding is active,
            shown grayed out as `/collection/:slug` (the Slug control owns
            the real href then). On a detail page (or inside a CMS map)
            the dropdown gains a "CMS" section for the collection's
            detail route. */}
        {hrefVp?.isVar ? (
          // PER-VIEWPORT variable on THIS replica tile → bound pill + the "Link To" label in purple with the
          // SAME left-chevron + dropdown (Reset Override + Create/Set Variable, all per-tile). Wrapping in
          // HoistMenuItemProvider makes LinkVarBoundRow's label non-plain (standard `<` chevron) — without it,
          // a plain+overridden label rendered the `▾` PlainOverrideLabel instead.
          <HoistMenuItemProvider item={makeLinkVarItem('href', 'string', `var:${hrefVp.value}`, 'text', 'Link To')}>
            <LinkVarBoundRow
              label="Link To"
              property="href"
              varName={hrefVp.value}
              onDetach={resetHrefVp}
              overridden
              onResetOverride={resetHrefVp}
            />
          </HoistMenuItemProvider>
        ) : hrefVp ? (
          // PER-VIEWPORT LITERAL override on THIS tile (e.g. after X-ing a base var on a replica) → the normal
          // href input + the "Link To" label in purple with the SAME left-chevron + dropdown every other row
          // has: Reset Override + Create Variable + Set Variable. Wrapping in HoistMenuItemProvider makes
          // LinkUrlControl's own label non-plain (the standard chevron) and injects Create/Set — which, on a
          // replica, route through createLinkVariableInstant / bindLinkVariable → a per-TILE binding. `overridden`
          // adds the purple accent + Reset Override entry.
          <HoistMenuItemProvider item={makeLinkVarItem('href', 'string', hrefVp.value, 'text', 'Link To')}>
            <LinkUrlControl value={hrefVp.value} onChange={setHrefVpLiteral} overridden onResetOverride={resetHrefVp} />
          </HoistMenuItemProvider>
        ) : hrefVar ? (
          // BASE variable. On a REPLICA, wrap in the menu so the user can OVERRIDE it per-viewport
          // (Create/Set Variable → a per-tile inline ternary); on the primary it's a plain pill.
          isReplica ? (
            <HoistMenuItemProvider item={makeLinkVarItem('href', 'string', `var:${hrefVar}`, 'text', 'Link To')}>
              <LinkVarBoundRow label="Link To" property="href" varName={hrefVar} onDetach={() => detachLinkVar('href', hrefVar, 'string')} />
            </HoistMenuItemProvider>
          ) : (
            <LinkVarBoundRow label="Link To" property="href" varName={hrefVar} onDetach={() => detachLinkVar('href', hrefVar, 'string')} />
          )
        ) : (
          <HoistMenuItemProvider item={makeLinkVarItem('href', 'string', effHref, 'text', 'Link To')}>
            <LinkUrlControl
              value={effHref}
              onChange={handleUrlChange}
              disabled={navMode !== 'none'}
              displayOverride={navMode !== 'none' && slugCollection ? `/${slugCollection}/:slug` : undefined}
              cmsRoutes={slugCollection
                ? [{ slug: `/${slugCollection}/[slug]`, label: `/${slugCollection}/:slug` }]
                : undefined}
            />
          </HoistMenuItemProvider>
        )}

        {/* CMS slug picker — available when on a detail page OR inside a
            CMS-backed map. The variant-context drives which "Set Variable"
            items appear (Current/Prev/Next on detail, "This Row" in a
            map, both when nested). Literal slug autocomplete works in
            either context — pick a specific item from the collection. */}
        {slugVariantContext && slugCollection && (
          <LinkSlugControl
            navMode={navMode}
            literalSlug={literalSlug}
            collection={slugCollection}
            variantContext={slugVariantContext}
            onNavModeChange={handleSlugChange}
            onLiteralSlugChange={handleLiteralSlugChange}
          />
        )}

        {/* Section/anchor selector — shows only when a page URL is set
            (and not when the href itself is a variable). */}
        {!isExternal && href && !hrefVar && navMode === 'none' && (
          <LinkSectionControl
            pageSlug={pagePart || '/'}
            value={sectionPart || ''}
            onChange={handleSectionChange}
          />
        )}

        {/* New tab toggle — only once a link is actually applied (href set or
            an href variable), not by default. The bound pill stays reachable
            whenever a New Tab variable exists. */}
        {newTabVpVar ? (
          // PER-VIEWPORT VARIABLE override on THIS replica tile → bound pill + Reset Override (revert to base).
          <HoistMenuItemProvider item={makeLinkVarItem('target', 'newTab', 'false', 'boolean', 'New Tab')}>
            <LinkVarBoundRow label="New Tab" property="target" varName={newTabVpVar} onDetach={resetTargetVp} overridden onResetOverride={resetTargetVp} />
          </HoistMenuItemProvider>
        ) : (newTabCondVp === 'true' || newTabCondVp === 'false') ? (
          // PER-VIEWPORT TOGGLE override on THIS replica tile → Yes/No + purple label + Reset Override.
          <HoistMenuItemProvider item={makeLinkVarItem('target', 'newTab', newTabCondVp, 'boolean', 'New Tab')}>
            <LinkNewTabControl value={newTabCondVp === 'true'} onChange={handleNewTabChange} overridden onResetOverride={resetTargetVp} />
          </HoistMenuItemProvider>
        ) : targetVar ? (
          // BASE variable (primary, or a replica with no per-viewport override — the menu lets you override it).
          isReplica ? (
            <HoistMenuItemProvider item={makeLinkVarItem('target', 'newTab', 'false', 'boolean', 'New Tab')}>
              <LinkVarBoundRow label="New Tab" property="target" varName={targetVar} onDetach={() => detachLinkVar('target', targetVar, 'newTab')} />
            </HoistMenuItemProvider>
          ) : (
            <LinkVarBoundRow label="New Tab" property="target" varName={targetVar} onDetach={() => detachLinkVar('target', targetVar, 'newTab')} />
          )
        ) : (!!href || !!hrefVar) && (
          // BASE toggle. On a replica, handleNewTabChange writes a per-tile override; on the primary, the attr.
          <HoistMenuItemProvider item={makeLinkVarItem('target', 'newTab', newTabCondBase === 'true' ? 'true' : 'false', 'boolean', 'New Tab')}>
            <LinkNewTabControl value={newTabCondBase === 'true'} onChange={handleNewTabChange} />
          </HoistMenuItemProvider>
        )}

        {/* Smooth scroll toggle. On a page it's only meaningful for anchor
            links (hasSection). On a component MASTER it's always shown for any
            link so it can be turned into a variable (a variable href has no
            literal #section to gate on) — matching New Tab / Link To. Also
            shown whenever already variable-bound so the pill stays reachable. */}
        {smoothVpVar ? (
          // PER-VIEWPORT VARIABLE override (replica) → pill + Reset Override.
          <HoistMenuItemProvider item={makeLinkVarItem('data-smooth-scroll', 'smooth', 'false', 'boolean', 'Smooth Scroll')}>
            <LinkVarBoundRow label="Smooth Scroll" property="data-smooth-scroll" varName={smoothVpVar} onDetach={resetSmoothVp} overridden onResetOverride={resetSmoothVp} />
          </HoistMenuItemProvider>
        ) : (smoothCondVp === 'true' || smoothCondVp === 'false') ? (
          // PER-VIEWPORT TOGGLE override (replica) → Yes/No + purple label + Reset Override.
          <HoistMenuItemProvider item={makeLinkVarItem('data-smooth-scroll', 'smooth', smoothCondVp, 'boolean', 'Smooth Scroll')}>
            <LinkSmoothScrollControl value={smoothCondVp === 'true'} onChange={handleSmoothScrollChange} overridden onResetOverride={resetSmoothVp} />
          </HoistMenuItemProvider>
        ) : smoothVar ? (
          // BASE variable.
          isReplica ? (
            <HoistMenuItemProvider item={makeLinkVarItem('data-smooth-scroll', 'smooth', 'false', 'boolean', 'Smooth Scroll')}>
              <LinkVarBoundRow label="Smooth Scroll" property="data-smooth-scroll" varName={smoothVar} onDetach={() => detachLinkVar('data-smooth-scroll', smoothVar, 'smooth')} />
            </HoistMenuItemProvider>
          ) : (
            <LinkVarBoundRow label="Smooth Scroll" property="data-smooth-scroll" varName={smoothVar} onDetach={() => detachLinkVar('data-smooth-scroll', smoothVar, 'smooth')} />
          )
        ) : (hasSection || (isComponentFile && isLink)) && (
          // BASE toggle.
          <HoistMenuItemProvider item={makeLinkVarItem('data-smooth-scroll', 'smooth', smoothCondBase === 'true' ? 'true' : 'false', 'boolean', 'Smooth Scroll')}>
            <LinkSmoothScrollControl value={smoothCondBase === 'true'} onChange={handleSmoothScrollChange} />
          </HoistMenuItemProvider>
        )}

        {/* Rel — `rel` token list (No Follow / No Referrer / Me / UGC /
            Sponsored). Added via the section's `+` menu. Variable-able. */}
        {relVar ? (
          <LinkVarBoundRow
            label="Rel"
            property="rel"
            varName={relVar}
            onDetach={() => detachLinkVar('rel', relVar, 'string')}
          />
        ) : showRel && (
          <HoistMenuItemProvider item={makeLinkVarItem('rel', 'string', relValue, 'text', 'Rel')}>
            {/* `items-start` pins the label to the top row; `mt-[7px]` on the
                label nudges it to the first token's vertical center (the
                token rows are h-8). Width-neutral — the label keeps its normal
                `-ml-[18px]` footprint so the value column matches other rows
                (a `w-3/4` wrapper would have dropped that, shrinking it). */}
            <div className="flex items-start justify-between w-full [&>:first-child]:mt-[7px]">
              <ControlLabel label="Rel" property="rel" plain={!isComponentFile} />
              <LinkRelControl value={relValue} onChange={handleRelChange} />
            </div>
          </HoistMenuItemProvider>
        )}

        {/* Parameters — Keep/Ignore. Keep forwards the current page's query
            string to the destination (runtime onClick). Variable-able. */}
        {paramsVar ? (
          <LinkVarBoundRow
            label="Parameters"
            property="data-keep-params"
            varName={paramsVar}
            onDetach={() => detachLinkVar('data-keep-params', paramsVar, 'smooth')}
          />
        ) : showParams && (
          <HoistMenuItemProvider item={makeLinkVarItem('data-keep-params', 'smooth', keepParams === 'true' ? 'true' : 'false', 'boolean', 'Parameters')}>
            <LinkParamsControl value={keepParams === 'true'} onChange={handleParamsChange} />
          </HoistMenuItemProvider>
        )}

        {/* Anchor moved to its own "Scroll Section" tool (ScrollSectionTool) —
            it's a scroll-TARGET concept, separate from where an element links
            FROM. */}

        {/* A/B test tracking id — writes data-revyme-track on the element so
            the deployed Worker fires a conversion event per click. Added via
            the `+` menu (not default). Variable-able on a master. */}
        {trackingVar ? (
          <LinkVarBoundRow
            label="Tracking"
            property="data-revyme-track"
            varName={trackingVar}
            onDetach={() => detachLinkVar('data-revyme-track', trackingVar, 'string')}
          />
        ) : showTracking && (
          <HoistMenuItemProvider item={makeLinkVarItem('data-revyme-track', 'string', localTracking, 'text', 'Tracking')}>
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Tracking" property="__tracking-id" plain={!isComponentFile} />
              <div className="flex items-center gap-2 w-full">
                <ToolInput
                  value={localTracking}
                  onChange={handleTrackingChange}
                  placeholder="ID"
                  text
                />
              </div>
            </div>
          </HoistMenuItemProvider>
        )}
      </div>

      {/* Create-variable modal for the nav attribute the user clicked
          "Create Variable" on. Reuses the canonical VariableModal
          ([feedback_variable_modal_reuse]); on confirm it dispatches
          `createLinkAttrVariable` (adds the master prop + rewrites the attr). */}
      {linkVar && nodeId && (
        <VariableModal
          isOpen={true}
          onClose={() => setLinkVar(null)}
          property={linkVar.attrName}
          propertyLabel={linkVar.propLabel}
          currentValue={linkVar.current}
          // EDIT mode on the JUST-created variable (instant-create above) — opens focused on its name for
          // rename, NO "Create Variable" confirm button. `nameEditable` = the reference's "exists with an auto-name,
          // type your real name" UX. The default editor (renderDefaultValue) still shows the real control.
          currentVariableRef={linkVar.createdName}
          nameEditable={true}
          // Render the ACTUAL control as the default-value editor (not a raw
          // text field): href → page picker, rel → token list, newTab/smooth →
          // Yes/No, params → Keep/Ignore. Tracking falls back to the text input.
          renderDefaultValue={
            linkVar.attrName === 'href' ? (value, onChange) => <LinkUrlField value={value} onChange={onChange} />
            : linkVar.attrName === 'rel' ? (value, onChange) => <LinkRelControl value={value} onChange={onChange} />
            : linkVar.attrName === 'data-keep-params' ? (value, onChange) => (
                <ToolSegmentedControl value={value === 'true' ? 'keep' : 'ignore'} onChange={(v) => onChange(v === 'keep' ? 'true' : 'false')} options={[{ value: 'keep', label: 'Keep' }, { value: 'ignore', label: 'Ignore' }]} size="sm" />
              )
            : (linkVar.kind === 'newTab' || linkVar.kind === 'smooth') ? (value, onChange) => (
                <ToolSegmentedControl value={value === 'true' ? 'yes' : 'no'} onChange={(v) => onChange(v === 'yes' ? 'true' : 'false')} options={YES_NO_OPTIONS} size="sm" />
              )
            : undefined
          }
        />
      )}
    </ToolSection>
  );
}
