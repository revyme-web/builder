// ContentControl.tsx — Text content editor atom.
// Reads from node.textContent (strips HTML), writes via queueMutation({ type: 'updateText' }).
// Map-aware: reads/writes from map JSON data when a ghost or template is selected.
// Disabled when TipTap is editing.
// Responsive-aware: when the user is on a non-primary viewport AND the node
// has a `textOverrides` entry for that viewport's bucket, displays + writes
// to the per-viewport variant via `updateTextOverride`.

import { ToolInput, ControlLabel } from '../../../controls';
import { LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { CmsBoundPill, CmsMissingPill } from '../../../controls/CmsBoundPill';
import { useControl } from '../../../controls/ControlProvider';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useAtomValue, useAtom } from 'jotai';
import { mapItemIndexAtom, mapContextAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { resolveCmsRowValues } from '@/code/generation/cms-row-resolve';
import { interactingViewportIdAtom, viewportsConfigAtom } from '@/code/stores/viewport-store';
import { activeLocaleAtom, isDefaultLocaleAtom, localeOverridesAtom } from '@/code/stores/locale-store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { setNodeOverride } from '@/code/project/locale-ops';
import { isPrimaryViewport } from '@/canvas/node-ops';
import { propagateToGhosts } from '@/code/generation/map-ghost-propagate';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getContentRoot } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

export function ContentControl() {
  const text = useTextStyles();
  const { node, getValueSource, removeVariable, cmsBinding } = useControl();
  // FIT SVG wrapper: the selection is the `<svg>` wrapper (empty textContent) —
  // the actual text lives in the inner <p> inside its <foreignObject>. Resolve it
  // so Content READS + WRITES the real text (otherwise the field is blank in FIT
  // mode). Mirrors the wrapper→inner resolution in ControlProvider/PropertiesPanel.
  const fitTextNode = useNodesComputed((nodes) => {
    if (node?.type !== 'svg' || !node.id?.endsWith('-svg')) return null;
    for (const childId of node.children ?? []) {
      const child = nodes.get(childId);
      if (child?.type === 'foreignObject') {
        for (const innerId of child.children ?? []) {
          const inner = nodes.get(innerId);
          if (inner) return inner;
        }
      } else if (child) {
        return child; // parser may collapse the foreignObject → direct inner child
      }
    }
    return null;
  }, [node]);
  const textNode = fitTextNode ?? node;
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const mapContext = useAtomValue(mapContextAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  const viewports = useAtomValue(viewportsConfigAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const [localeOverrides, setLocaleOverrides] = useAtom(localeOverridesAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);

  // Locale text override: when the user is on a non-default locale, the
  // canonical text comes from `i18n/{locale}.json` (loaded into the atom),
  // not from the node's `textContent` (which is the default-locale JSX).
  // Writes also need to go to the locale file so we don't blow away the
  // English source while editing the French translation.
  const localeTextOverride = !isDefaultLocale && node
    ? localeOverrides.get(node.id)?.text
    : undefined;
  const isLocaleOverride = localeTextOverride !== undefined;

  // Determine if this node has a text binding in a map context
  const textField = node?.binding?.property === 'text' ? node.binding.field : null;
  const isMapText = textField != null && mapContext != null && mapItemIndex != null;

  // Resolve which viewport bucket the user is currently focused on. The
  // `interactingViewportIdAtom` follows whichever viewport last received a
  // click / hover / select. When the user picks the tablet replica, the
  // Content control should show the tablet override (if any) and route
  // writes to that override — not silently rewrite the desktop primary.
  const primaryVp = viewports.find((v) => v.isPrimary) ?? viewports[0];
  const interactingVp = viewports.find((v) => v.id === interactingVpId) ?? primaryVp;
  const isNonPrimaryVp = !!interactingVp && !!primaryVp && interactingVp.id !== primaryVp.id;
  const primaryWidth = primaryVp?.width ?? 1440;
  const interactingWidth = interactingVp?.width ?? primaryWidth;

  // Bucket the interacting viewport's width into the override map. Same
  // algorithm `useResponsiveText` and the renderer use, so the input
  // shows what the user actually sees on screen.
  function resolveForViewport(rawText: string): { value: string; isOverride: boolean } {
    // FIT text: overrides live on the INNER <p> (textNode), not the svg wrapper.
    if (!isNonPrimaryVp || !textNode?.textOverrides) return { value: rawText, isOverride: false };
    const sortedAsc = viewports
      .map((v) => v.width)
      .filter((w) => Number.isFinite(w) && w > 0)
      .sort((a, b) => a - b);
    let bucket: number | null = null;
    for (const vw of sortedAsc) {
      if (interactingWidth <= vw) { bucket = vw; break; }
    }
    if (bucket !== null) {
      const o = textNode.textOverrides[String(bucket)];
      if (typeof o === 'string') return { value: o, isOverride: true };
    }
    return { value: rawText, isOverride: false };
  }

  // Per-variant text resolution (component master files). Source:
  //   `{variant === 'X' ? 'A' : 'B'}` → parser stores
  //   `conditionalText = { 'X': 'A', 'default': 'B' }` and the default
  //   branch in `textContent`. On the primary variant the existing
  //   `textContent` path already returns the right value (the 'default'
  //   branch). On a non-primary variant we have to look up the matching
  //   key — otherwise the input shows the default's `​` placeholder
  //   instead of the actual per-variant text the user authored.
  //
  // `interactingVpId` for component files is the variant name
  // (e.g. 'desktop' for the primary, 'variant-1' for a named variant).
  // The conditionalText map uses 'default' for the primary, so apply
  // the same desktop→default mapping the rest of the system uses.
  const isOnComponentMaster = isComponentFilePath(activeFilePath);
  const variantKey = interactingVpId === 'desktop' ? 'default' : interactingVpId;
  const isOnNonPrimaryVariant = isOnComponentMaster && !isPrimaryViewport(interactingVpId);
  const variantText = (isOnComponentMaster && node?.conditionalText)
    ? node.conditionalText[variantKey]
    : undefined;
  const hasVariantTextEntry = variantText !== undefined;
  // Per-variant CMS binding override (variantBindings.text). A `{value}` literal
  // (unbind→default on this variant) shows as an editable per-variant literal here;
  // a `{field}` rebind is surfaced by the CMS pill above (getBindingForProperty).
  const variantCmsEntry = (isOnComponentMaster && node?.variantBindings?.text)
    ? node.variantBindings.text[variantKey]
    : undefined;
  const variantCmsLiteral = variantCmsEntry && 'value' in variantCmsEntry ? variantCmsEntry.value : undefined;

  // The row value behind a CMS text binding — see the branch that uses it.
  // Computed through the node map so it re-resolves when the collection data or
  // the previewed row changes.
  const cmsRowText = useNodesComputed<string>((nodes) => {
    if (textNode?.binding?.property !== 'text') return '';
    return resolveCmsRowValues(textNode, nodes).__text ?? '';
  }, [textNode]);

  let displayValue: string;
  let isOverride = false;
  if (isMapText) {
    // Read from map JSON data for the selected item
    const itemData = mapContext.mapData[mapItemIndex] || {};
    displayValue = (itemData[textField] || '').replace(/<[^>]*>/g, '');
  } else if (isLocaleOverride) {
    // Non-default locale with an override: show the translation from the
    // i18n file (already in the atom), with the orange override indicator.
    displayValue = (localeTextOverride || '').replace(/<[^>]*>/g, '');
    isOverride = true;
  } else if (isOnNonPrimaryVariant && hasVariantTextEntry) {
    // Variant-specific text — show the branch value for THIS variant
    // (could be the same as default or different). Mark as override so
    // the label shows the accent indicator, mirroring how vp text
    // overrides show.
    displayValue = (variantText || '').replace(/<[^>]*>/g, '');
    isOverride = true;
  } else if (isOnNonPrimaryVariant && variantCmsLiteral !== undefined) {
    // Per-variant CMS unbind→default: the binding was removed on THIS variant,
    // leaving an editable literal. Show it as direct text + the override accent.
    displayValue = variantCmsLiteral.replace(/<[^>]*>/g, '');
    isOverride = true;
  } else if (textNode?.binding?.property === 'text') {
    // CMS-BOUND TEXT. The JSX carries `{item.field}`, so `textContent` is EMPTY
    // — the value the user sees is produced at render time from the collection
    // row. Falling through to the branch below therefore resolved to '', and
    // since this value is what the pill hands `unbindField` as its static
    // fallback, pressing × wrote an EMPTY string: the paragraph vanished
    // instead of keeping the words that were on screen (user report
    // 2026-08-08). `resolveCmsRowValues` is the same resolver the copy/detach
    // paths use to bake a row's values onto a clone, so unbind now leaves
    // exactly what the row was displaying.
    displayValue = (cmsRowText || '').replace(/<[^>]*>/g, '');
  } else {
    const rawText = textNode?.textContent || '';
    const resolved = resolveForViewport(rawText);
    displayValue = resolved.value.replace(/<[^>]*>/g, '');
    isOverride = resolved.isOverride;
  }

  trace.fn('ContentControl:render', { nodeId: node?.id, displayLength: displayValue.length, isEditing: text.isEditing, isMapText });

  // Detached CMS text (design-tool parity): the `{item.field}` text binding was dragged
  // OUT of its `.map()` and stashed as `data-cms-orphan="__text:field"` (the live
  // ref would crash at module scope). Show the blue "Missing" pill — identical to a
  // component-instance Missing prop — NOT the static placeholder text. The × clears
  // the stash (text reverts to a plain editable placeholder); dragging back into a
  // collection re-binds it.
  const textOrphanField = node?.orphanBindings?.find((o) => o.prop === '__text')?.field ?? null;
  if (textOrphanField && node) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Content" property="textContent" />
        <CmsMissingPill
          field={textOrphanField}
          onClear={() => queueMutation({ type: 'clearCmsOrphan', nodeId: node.id, propName: '__text' })}
        />
      </div>
    );
  }

  // CMS binding takes priority — when this Content is fed by `{item.title}`
  // (or any other field), show the blue ⚡-pill instead of the text input.
  // `cmsBinding` only exists when the selected node is inside a `.map()`
  // over a CMS collection, so this short-circuits cleanly elsewhere.
  // `getBindingForProperty('textContent')` handles the text/textContent
  // alias internally, no need to check both keys here.
  if (cmsBinding?.getBindingForProperty('textContent')) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Content" property="textContent" />
        <CmsBoundPill property="textContent" fallbackValue={displayValue} />
      </div>
    );
  }

  // textContent is a first-class variable property — Create Variable from
  // the dropdown wraps the JSX text in `{propName}` and adds the prop. The
  // legacy ControlProvider routes property === 'textContent' to the
  // text-variable AST helpers instead of the style-variable ones.
  // When bound, swap the text input for the purple value-column pill.
  const textVarSource = getValueSource('textContent');
  const isTextVar = textVarSource.source === 'prop' && !!textVarSource.ref;
  if (isTextVar) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Content" property="textContent" />
        <LegacyVariableBoundPill
          property="textContent"
          propertyLabel="Content"
          variableRef={textVarSource.ref!}
          currentValue={displayValue}
          removeVariable={removeVariable}
        />
      </div>
    );
  }

  // Whether this node already has any per-viewport overrides — used along
  // with `isNonPrimaryVp` to decide whether to route a primary-viewport
  // edit through `updateTextOverride` (preserves the multi-variant call) or
  // the simpler `updateText` path (plain text element).
  // FIT text: the commit controller writes overrides on the INNER <p> id — read them there too.
  const hasAnyOverrides = !!textNode?.textOverrides && Object.keys(textNode.textOverrides).length > 0;

  // Reset Override on the Content label:
  //   - Locale override: drop `text` from the i18n/{locale}.json node entry.
  //   - Responsive override: drop the bucket from `useResponsiveText`.
  // The default ControlLabel handler (`updateStyle('textContent', '')`)
  // wouldn't work either way — textContent doesn't live in the @media
  // style map.
  const handleResetOverride = () => {
    if (!node) return;
    if (!isOverride) return;
    if (isLocaleOverride) {
      trace.action('content-control:resetLocaleTextOverride', { nodeId: node.id, locale: activeLocale });
      const existing = localeOverrides.get(node.id) || {};
      // Pass empty string so locale-ops marks the entry empty + cleans up.
      setNodeOverride(activeLocale, activeFilePath, node.id, { text: '' });
      const next = new Map(localeOverrides);
      const stillHasStyles = !!existing.styles && Object.keys(existing.styles).length > 0;
      if (!stillHasStyles && existing.visible === undefined) {
        next.delete(node.id);
      } else {
        next.set(node.id, { ...existing, text: undefined });
      }
      setLocaleOverrides(next);
      return;
    }
    // Variant text override on a component master: collapse this
    // variant's branch back into the default by writing the default's
    // value to this variant. Cleaner than removing the branch entirely
    // (which would require AST surgery that the variant-text generator
    // doesn't support today); the user just sees the default text
    // shown again, and the input no longer carries the override
    // indicator.
    // Per-variant CMS override: reset = clear this variant's branch → revert to the
    // BASE binding (e.g. item.bio) on this variant. Mirrors the variable detach reset.
    if (isOnNonPrimaryVariant && variantCmsEntry && cmsBinding) {
      trace.action('content-control:resetVariantCmsText', { nodeId: node.id, variantName: variantKey });
      queueMutation({ type: 'setVariantCmsText', nodeId: node.id, variantName: variantKey, itemVar: cmsBinding.itemVar, override: { kind: 'clear' } });
      return;
    }
    if (isOnNonPrimaryVariant && hasVariantTextEntry) {
      const defaultText = node.conditionalText?.default ?? node.textContent ?? '';
      trace.action('content-control:resetVariantText', {
        nodeId: node.id, variantName: variantKey,
      });
      queueMutation({
        type: 'updateVariantText',
        nodeId: node.id,
        variantName: variantKey,
        text: defaultText,
      });
      return;
    }
    trace.action('content-control:resetOverride', { nodeId: textNode!.id, vpWidth: interactingWidth });
    queueMutation({
      type: 'removeTextOverride',
      nodeId: textNode!.id,
      vpWidth: interactingWidth,
      primaryWidth,
    });
    // FIT text: also drop THIS breakpoint's fit overrides — the base fit numbers
    // (fontSize/marginTop @media pair + the viewBox ternary branch) are exactly
    // right for the primary text at any width (fit is width-relative), so the
    // tile falls back cleanly instead of rendering primary text in the stale
    // override box. Empty value = remove (both writers).
    if (fitTextNode) {
      queueMutation({ type: 'updateContainerStyle', nodeId: fitTextNode.id, maxWidth: interactingWidth, styles: { fontSize: '', marginTop: '' } });
      queueMutation({ type: 'setResponsiveAttr', nodeId: `${fitTextNode.id}-svg`, vpWidth: interactingWidth, attr: 'viewBox', value: '', baseValue: '' });
    }
  };

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel
        label="Content"
        property="textContent"
        overridden={isOverride}
        onResetOverride={handleResetOverride}
      />
      <ToolInput
        value={displayValue}
        onChange={(v) => {
          if (!node) return;
          if (isMapText) {
            // Write to map JSON data
            const itemData = { ...(mapContext.mapData[mapItemIndex] || {}) };
            const oldVal = itemData[textField];
            itemData[textField] = v;
            queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex, item: itemData });
            if (mapItemIndex === 0) {
              propagateToGhosts(mapContext.varName, textField, oldVal, v, mapContext.mapData);
            }
            // Imperative DOM update on the element
            const contentEl = getContentRoot();
            if (contentEl) {
              const suffix = mapItemIndex > 0 ? `__${mapItemIndex}` : '';
              const el = contentEl.querySelector(`[data-node-id="${node.id}${suffix}"]`) as HTMLElement;
              if (el) el.textContent = v;
            }
            trace.action('content-control:map-updateText', { nodeId: node.id, mapItemIndex, textField, newText: v });
            return;
          }
          // Locale routing: when the user is on a non-default locale, the
          // edit is a translation — write to `i18n/{locale}.json`, not JSX.
          // This keeps the source-of-truth English text intact. The atom
          // update is mirrored so the canvas Renderer picks up the change
          // immediately (it merges localeOverridesAtom into the rendered DOM).
          if (!isDefaultLocale) {
            trace.action('content-control:locale-updateText', {
              nodeId: node.id, locale: activeLocale, newText: v,
            });
            setNodeOverride(activeLocale, activeFilePath, node.id, { text: v });
            const next = new Map(localeOverrides);
            const existing = next.get(node.id) || {};
            next.set(node.id, { ...existing, text: v });
            setLocaleOverrides(next);
            return;
          }
          // Per-variant text on a component master: edit on a non-
          // primary variant goes to the matching ternary branch via
          // `updateVariantText`. If the node doesn't have a variant
          // ternary yet, the generator wraps the JSX text into one.
          // Same routing rule as variant style writes.
          //
          // EXCEPT when the node is solo on this variant
          // (`data-replica-solo` set): fall through to the plain
          // `updateText` path below so the master baseline text
          // carries what the user typed. Same contract as the
          // TipTap commit path — solo nodes build the master
          // values, not per-variant overrides.
          // Per-variant CMS override: editing the literal stays a per-variant override
          // (preserves the base item.field binding on other variants).
          if (isOnNonPrimaryVariant && variantCmsEntry && cmsBinding) {
            trace.action('content-control:updateVariantCmsText', { nodeId: node.id, variantName: variantKey, newText: v });
            queueMutation({ type: 'setVariantCmsText', nodeId: node.id, variantName: variantKey, itemVar: cmsBinding.itemVar, override: { kind: 'literal', value: v } });
            return;
          }
          const isSoloOnVariant = !!node.attrs?.['data-replica-solo'];
          // Route through updateVariantText for a non-primary variant OR whenever the node ALREADY has a
          // per-variant ternary — including the PRIMARY (variantKey='default' → edits the fallback only).
          // Plain `updateText` would replace the whole child, wiping the ternary + every variant's binding,
          // which is why typing on the primary "did nothing" / lost the variable.
          const hasVariantTernary = isOnComponentMaster && !!node.conditionalText;
          if (!isSoloOnVariant && (isOnNonPrimaryVariant || hasVariantTernary)) {
            trace.action('content-control:updateVariantText', {
              nodeId: node.id, variantName: variantKey, newText: v,
            });
            queueMutation({
              type: 'updateVariantText',
              nodeId: node.id,
              variantName: variantKey,
              text: v,
            });
            return;
          }

          // Solo-replica redirect: a node carrying
          // `data-replica-solo="<vpId>"` was born on this replica only
          // (canvas-node drop / creator / dblclick-empty-frame). The
          // contract is "every edit during solo builds the MASTER" —
          // text content included. Bypass the `useResponsiveText`
          // per-vp routing and write to base text directly, so future
          // unhide on other vps inherits the typed text for free.
          const isSoloRedirect = !!node.attrs?.['data-replica-solo'];

          // Responsive routing: edit on a non-primary viewport (or any edit
          // when overrides already exist) goes through `updateTextOverride`
          // so the right `useResponsiveText` slot is updated. Otherwise the
          // plain `updateText` path keeps simple text elements clean.
          if (!isSoloRedirect && (isNonPrimaryVp || hasAnyOverrides)) {
            trace.action('content-control:updateTextOverride', {
              nodeId: textNode!.id, vpWidth: interactingWidth, primaryWidth, newText: v,
            });
            queueMutation({
              type: 'updateTextOverride',
              nodeId: textNode!.id,
              vpWidth: interactingWidth,
              primaryWidth,
              text: v,
            });
          } else {
            // node is non-null here (guarded above) → textNode (= inner FIT text ?? node) is too.
            trace.action('content-control:updateText', { nodeId: textNode!.id, newText: v, soloRedirect: isSoloRedirect });
            queueMutation({ type: 'updateText', nodeId: textNode!.id, text: v });
          }
        }}
        text
        disabled={text.isEditing}
      />
    </div>
  );
}
