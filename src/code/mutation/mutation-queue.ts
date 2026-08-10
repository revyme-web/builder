// mutation-queue.ts — Centralized async code mutation pipeline.
//
// EVERY canvas-initiated code change goes through here. No exceptions.
// This guarantees:
//   1. DOM updates are instant (caller does it before queueing)
//   2. Code mutations never block the main thread
//   3. Multiple rapid mutations are batched
//   4. The code string stays in sync (eventually consistent)
//
// Usage:
//   import { queueMutation } from './mutation/mutation-queue';
//   // DOM already updated by the drag/resize/etc system
//   queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { left: '50px' } });
//
// The queue processes mutations in order, applies them to the code string,
// and flushes to codeAtom when idle.

import { getAllCachedNodes, getNodeFromCache, canvasInteractingAtom, setPreferCacheSnapshot } from '@/code/stores/store';
import { registerExternalWriteRefresh } from './external-write-registry';
import { sanitizeDataName } from '@/shared/id-utils';
import { canvasRootFlowReset } from '@/shared/flex-helpers';
// Layering note: the queue reaching into canvas/ is unusual, but the drag
// gate below is precisely about CANVAS ELEMENT DRAGS (not sliders/resizes —
// those use canvasInteractingAtom). drag-state-store is a leaf module.
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { isViewerMode } from '../stores/viewer-mode-store';
const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;
import {
  updateNodeInCode,
  reorderNodeInCode,
  moveNodeInCode,
  flattenVariantConditionalStylesInCode,
  resolveMediaGateTernariesInCode,
  inlineCanvasNodePropRefsInCode,
  stripCanvasNodeMotionRefsInCode,
  stashCanvasNodeConnectionsInCode,
  updateNodeTextInCode,
  updateVariantTextInCode,
  setVariantTextBindingInCode,
  setVariantStyleBindingInCode,
  detachTextVariableForVariantInCode,
  updateNodeChildrenFromHTML,
  htmlToPlainTextLines,
  replaceNodeTextContent,
  stripInlineSpanStyleInCode,
  healDanglingModuleJsxInCode,
  healStyleBlockSelectorAttrsInCode,
  addNodeInCode,
  addCanvasNodeInCode,
  removeNodeInCode,
} from '../generation/generator-crud';
import {
  updateContainerQueryStyle,
  clearContainerStylesForNode,
  clearContainerStylesInSubtree,
  stripPositionalContainerStyles,
  stripPositionalVariantStyles,
  updateVariantStyleInCode,
  setConditionalOrderInCode,
  setConditionalStyleInCode,
  updateBorderOverlayStyle,
  removeBorderOverlayStyle,
  healSparseVariantDefaults,
  healStrandedVariantShorthands,
  normalizeResponsiveBandKeys,
} from '../generation/generator-styles';
import { setVariantVisibilityInCode } from '../generation/variant-visibility-gen';
import {
  updateSvgAttrsInCode,
  addSvgChildInCode,
  removeSvgChildInCode,
  replaceSvgInnerInCode,
} from '../generation/generator-attrs';
// Sketch animation generators are imported separately because they live
// in `code/sketch/`, not `code/generation/`.
import {
  setVideoFillInCode,
  removeVideoFillInCode,
} from '../generation/generator-video';
import {
  updateMotionPropInCode,
  setMotionPropScopedValue,
  removeMotionPropScopeBranch,
  removeMotionPropFromCode,
  updateScrollAnimInCode,
  removeScrollAnimFromCode,
  updateScrollDirectionAnimInCode,
  removeScrollDirectionFromCode,
  updateScrollSpeedInCode,
  removeScrollSpeedFromCode,
  setLoopInCode,
  composeAllScrollAppearConflicts,
  decomposeAllScrollConflicts,
} from '../generation/generator-motion';
import { setScrollVariantInCode, dormantizeScrollVariant, rehydrateScrollVariant, removeScrollVariantFromVarRefs } from '../generation/scroll-variant-gen';
import { removeTemplateVarFromCode } from '../generation/template-route-gen';
import { setInstanceFxInCode, dormantizeInstanceFx, rehydrateInstanceFx, stripDeadFxStyleRefs } from '../generation/instance-fx-gen';
import { setScrollFxInCode, removeScrollSpeedScopeBranch, dormantizeScrollFx, rehydrateScrollFx, writeCanvasNodeScrollFx, updateVariantEntryTransition, setElementTransitionVar, setVariantTransitionPropVar, setMotionConfigBaseVar, readTransitionVarRef } from '../generation/generator-motion';
import { setGlideInCode, hasGlide, getGlide } from '../generation/glide-gen';
import { wireFormSubmitInCode, ensureFormRouteFile } from '../generation/form-gen';
import {
  convertSubmitButtonInCode,
  ensureFormSubmitComponentFile,
  ensureFormSubmitSpinnerFile,
} from '../generation/form-submit-gen';
import {
  setFormStateMappingInCode,
  dormantizeFormStateBinding,
  rehydrateFormStateBinding,
  healOrphanedFormStateBindings,
  healMissingFormStateDeclarations,
  dormantizeFormBindingsInCanvas,
  formStateVar,
  formStateSetter,
  type FormStateMapping,
} from '../generation/form-state-gen';
import { setResponsiveAttrInCode, setVariantAttrInCode, setResponsiveAttrBaseInCode } from '../generation/responsive-attrs-gen';
import { findJSXDataIdIndex, findTagClose } from '../generation/generator-utils';
import { replaceComponentInstanceInCode } from '@/code/generation/replace-component-gen';
import {
  updateHtmlAttrsInCode,
  stripDataResponsiveInSubtree,
  changeTagInCode,
  convertToMotionLinkInCode,
} from '../generation/generator-attrs';
import {
  updateHoverStyleInCode,
  removeHoverStyleInCode,
  setSmoothScrollInCode,
  syncLinkHandlerInCode,
  updatePseudoStyleInCode,
  removePseudoStyleInCode,
} from '../generation/generator-styles';
import { createVariableInCode, createConditionalVariableInCode, removeVariableInCode, createTextVariableInCode, removeTextVariableInCode, bindTextNodeAsPageVarInCode, bindTextVariableForVariantInCode, createLinkAttrVariableInCode, removeLinkAttrVariableInCode, setBorderOverlayVariableForVariant, setInlineVariableForVariant, removeVariantStyleVariableInCode, setComponentPropDefaultInCode, createTypedVariableInCode, addBarePropToFunctionInCode, deleteComponentVariableInCode, renameComponentVariableInCode } from '../features/variable-ops';
import { addPageVariableInCode, removePageVariableInCode, updatePageVariableInCode } from '../features/page-variables';
import { applyDeleteVariablePipeline } from '../features/delete-variable-pipeline';
import { setPropDescriptionInCode, setPropTypeInCode, setPropOptionsInCode, setPropLabelInCode, setPropNumberMetaInCode, setPropVariantOfInCode, getPropType, getPropDescription, getPropOptions, getPropLabel, getPropVariantOf } from '../components/prop-meta';
import { ensureLayoutRootOnComponentRoot } from '../components/component-ops';
import { hoistInstancePropInCode } from '../features/hoist-prop';
import type { PageVariable } from '../features/page-variables';
import { bindStyleToPageVariableInCode, unbindStyleFromPageVariableInCode, syncPageVariableHooks, dormantizePageVarBindingsInCanvas, neutralizeMissingSearchFieldsInCode, renamePageVariableHookInCode } from '../generation/page-variables-gen';
import { setResponsiveStyleVariableInCode, resetResponsiveStyleVariableInCode, setResponsiveStyleBaseInCode } from '../generation/responsive-style-vars-gen';
import { setResponsiveTextVariableInCode, resetResponsiveTextVariableInCode, setResponsiveTextBaseInCode } from '../generation/responsive-text-vars-gen';
import { addPageInteractionInCode, removePageInteractionInCode } from '../generation/page-interactions-gen';
import { addCloseOverlayInCode, removeCloseOverlayInCode, setCloseOverlayDelayInCode, overlayCloseSetter } from '../generation/close-overlay-gen';
import type { InteractionTrigger } from '../features/page-interactions';
import { makeIntoMapInCode, addMapItemInCode, removeMapItemInCode, updateMapItemInCode, addMapFieldInCode, bindStyleToMapInCode, unbindStyleFromMapInCode, bindPropToMapInCode, unbindPropFromMapInCode, bindToCmsCollectionInCode, unbindFromCmsCollectionInCode, changeCollectionSourceInCode, bindCmsFieldOnDropInCode, bindCmsNavLinkOnDropInCode, setCmsNavHrefInCode, getEnclosingMapIteratorForNode } from '../generation/map-gen';
import { dormantizeCmsBindings, rehydrateCmsBindings, clearCmsOrphanInCode, healDanglingCanvasNodeBindings, detachCmsSubtreeWithValues } from '../generation/cms-detach-gen';
import { resolveCmsRowForNodeInCode } from '../generation/cms-row-resolve';
import { dormantizeComponentVarBindings, rehydrateComponentVarBindings, clearVarOrphanInCode, isCanvasNode } from '../generation/component-var-detach-gen';
import { dormantizeTranslationBinding, rehydrateTranslationBinding } from '../generation/i18n-gen';
import { localizeCollectionListsInCode } from '../generation/cms-locale-gen';
import { readTranslationText } from '../project/translation-ops';
import { getI18nConfig } from '../project/locale-ops';
import { filePathToSlug } from '../project/active-file-store';
import { connectSlotInCode, disconnectSlotInCode, reorderSlotInCode, getAllSlotConnections } from '../generation/slot-ops';
import {
  createCollectionListInCode, bindFieldInCode, unbindFieldInCode,
  updateCollectionListConfigInCode,
} from '../generation/cms-gen';
import { setPaginationInCode, removePaginationInCode, ensureLoadMoreComponentFile, ensureSpinnerComponentFile, readPaginationMarker, pruneOrphanedPaginationHooks } from '../generation/cms-pagination-gen';
import { addSearchFieldInCode, setSearchInputVariableInCode } from '../generation/cms-search-field-gen';
import { writeResponsiveListConfigInCode, type ResponsiveListConfig } from '../generation/cms-responsive-gen';
import { duplicateCollectionListToCanvasInCode } from '../generation/cms-paste-gen';
import { setInstanceEventDelayInCode, setInstanceEventCloseHandlerInCode, removeInstanceEventHandlerInCode } from '../generation/instance-event-gen';
import { updateLocaleStyleInCode } from '../generation/locale-gen';
import { setLocaleInstancePropInCode, setInstancePropBaseInCode } from '../generation/responsive-instance-prop-vars-gen';
import { updateMetadataInCode, updateSiteConfigInCode, ensureLayoutFile } from '../generation/metadata-gen';
import { addPresetToken, updatePresetToken, removePresetToken, setDarkTokenValue } from '../project/preset-ops';
import { updateKeyframeInTokensCSS, removeKeyframeFromTokensCSS } from '../project/keyframe-ops';
import { addTextAnimInCode, updateTextAnimInCode, removeTextAnimFromCode, nodeHasTextAnim, readTextAnimConfig } from '../generation/text-anim-gen';
import { setTextOverrideInCode, removeTextOverrideInCode } from '../generation/text-override-gen';
import { parseCanvasConfig } from '../project/canvas-config';
import { DEFAULT_VIEWPORTS } from '../stores/viewport-store';
import { createOverlayInCode, createCanvasOverlayInCode, cloneOverlayToCanvasTriggerInCode, updateOverlayPositionInCode, updateOverlayConfigInCode, updateOverlayTriggerInCode, removeOverlayInCode, extractOverlayToCanvasInCode, rehydrateOverlayFromCanvasInCode, healDanglingOverlayState, pruneOverlayDuplicatesInCode, liftNestedCanvasOverlaysToRoot, stripOverlaysNestedInOverlaysInCode, syncOverlayAppearTransformInCode, healMissingOverlayEffectsInCode, healUnwrappedOverlayInCode, healMisplacedOverlayInCode } from '../generation/overlay-gen';
import { setChildEventFireInCode, removeChildEventFireInCode, type EventFireTrigger } from '../generation/event-fire-gen';
import { parseOverlayTriggerCalls } from '../parsing/overlay-parser';
import { wrapInFitSVGInCode, unwrapFitSVGInCode } from '../generation/fit-text-gen';
import { removeDanglingConnectionsInCode, healDriftedConnectionHandlersInCode } from '../variants/connection-config';
import { setSketchAnimInCode, removeSketchAnimInCode } from '../sketch/sketch-anim-gen';
import { projectFS, projectVersionAtom, installBuiltInCodeComponent } from '../project/project-fs';
import { clearCanvasStyles } from '@/canvas/node-ops';
import type { PresetToken } from '@/shared/types';

// ─── Mutation Types ────────────────────────────────────────────────────────

export type Mutation =
  // ─── Style mutations ────────────────────────────────────────────────────
  /** Update inline CSS styles on any element. Styles use camelCase property names (e.g. backgroundColor). Empty string removes a property. */
  | { type: 'updateStyles'; nodeId: string; styles: Record<string, string> }
  /** Update styles for a specific @container breakpoint width on an element. */
  | { type: 'updateContainerStyle'; nodeId: string; maxWidth: number; styles: Record<string, string> }
  /** Remove all @container style overrides for an element. */
  | { type: 'clearContainerStyles'; nodeId: string }
  /** Drop only the out-of-flow placement keys (position/insets) from an element's
   *  OTHER tiles — every @media band on a page, every variant entry in a
   *  component. Queued when a child becomes a flow item in the primary tile, so
   *  a replica can't keep offsetting it with a stale `left`. */
  | { type: 'stripPositionalTileOverrides'; nodeId: string }
  /** Update styles for a specific viewport variant (e.g. tablet/mobile overrides). */
  | { type: 'updateVariantStyle'; nodeId: string; variantName: string; styles: Record<string, string> }
  /** Set per-variant visibility via the AnimatePresence + conditional render
   *  pattern. `hiddenVariants` = the FULL list of variants where the element
   *  is hidden (caller computes this from the prior state + the current
   *  toggle, doesn't pass deltas). Empty list → unwraps to plain rendering. */
  | { type: 'setVariantVisibility'; nodeId: string; hiddenVariants: string[]; allVariants: string[] }
  /** Set conditional order in style based on variant state (for layout FLIP reorder). */
  | { type: 'setConditionalOrder'; nodeId: string; orderMap: Record<string, number> }
  /** Set a layout-affecting style prop as an inline `style` ternary keyed on the
   *  variant (so framer-motion `layout` FLIP engages instead of snapping). */
  | { type: 'setConditionalStyle'; nodeId: string; prop: string; variantName: string; value: string }
  /** Update styles for a specific locale (i18n per-locale style overrides). */
  | { type: 'updateLocaleStyle'; nodeId: string; locale: string; styles: Record<string, string>; maxWidth?: number; variantName?: string }
  | { type: 'updateLocaleInstanceProp'; nodeId: string; componentName: string; prop: string; locale: string; value: string | null; bandQuery?: string }
  | { type: 'updateInstancePropBase'; nodeId: string; componentName: string; prop: string; value: string }
  // ─── Structure mutations ────────────────────────────────────────────────
  /** Insert a new element inside a parent. Requires unique id. Index is optional insert position. */
  | { type: 'addNode'; parentId: string; node: { id: string; type: string; styles: Record<string, string>; attrs?: Record<string, string>; name?: string; textContent?: string; children?: any[] }; index?: number }
  /** Add a new absolute-positioned element to the canvas root (no parent). */
  | { type: 'addCanvasNode'; node: { id: string; type: string; styles: Record<string, string>; attrs?: Record<string, string>; name?: string; textContent?: string; children?: any[] } }
  /** Replica drag-out of a CMS collection list: COPY the literal `.map()` subtree
   *  into `canvasNodes` (id-renamed by `suffix`, map + bindings preserved). The
   *  original stays in the page; the caller hides it on the source replica. */
  | { type: 'duplicateCollectionToCanvas'; nodeId: string; source: string; suffix: string; styles: Record<string, string> }
  /** Move an element to a new position within its parent (reorder children). */
  | { type: 'reorder'; nodeId: string; parentId: string; index: number }
  /** Move an element to a different parent. Optionally update styles and set insert index. */
  | { type: 'move'; nodeId: string; newParentId: string | null; styles?: Record<string, string>; index?: number; insertBeforeId?: string; canvasNode?: boolean; sourceVpWidth?: number; sourceVariant?: string }
  /** Delete an element and all its children. */
  | { type: 'removeNode'; nodeId: string }
  /** Set the data-name attribute on an element (display name in layers panel). */
  | { type: 'renameNode'; nodeId: string; name: string }
  // ─── Text mutations ─────────────────────────────────────────────────────
  /** Update the text content of an element. Supports plain text and HTML. */
  | { type: 'updateText'; nodeId: string; text: string }
  /** Per-variant text on a design-component master — stores the text as a
   *  `{variant === 'x' ? 'a' : 'b'}` ternary child for the given variant. */
  | { type: 'updateVariantText'; nodeId: string; variantName: string; text: string }
  | { type: 'detachTextVariableForVariant'; nodeId: string; variantName: string; propName: string; literal: string }
  | { type: 'bindTextVariableForVariant'; nodeId: string; variantName: string; propName: string; propDefault: string }
  /** Replace all children of an element with parsed HTML content. */
  | { type: 'updateChildrenHTML'; nodeId: string; html: string }
  /** Flatten a per-span text mark (color, fontWeight, …) on a rich-text node:
   *  strip `property` from every inline `<span>` in the node's content so the
   *  node's own `style.{property}` wins (the reference "change style on whole node
   *  overrides mixed runs"). Paired with a normal `updateStyles` write to the
   *  `<p>` itself; see useTextStyles `set` (node mode). */
  | { type: 'stripInlineSpanStyle'; nodeId: string; property: string }
  /** Set (or add, or remove) a per-viewport text override on an element.
   *  Wraps the element's text in `useResponsiveText('primary', { vpWidth:
   *  text })` on first use; subsequent edits update the matching width key
   *  in the overrides object (or the primary string when `vpWidth ===
   *  primaryWidth`). Empty `text` removes that width's override; if no
   *  overrides remain the call unwraps back to plain JSXText. */
  | { type: 'updateTextOverride'; nodeId: string; vpWidth: number; primaryWidth: number; text: string }
  /** Remove a per-viewport text override (equivalent to passing
   *  `text: ''` to `updateTextOverride`). */
  | { type: 'removeTextOverride'; nodeId: string; vpWidth: number; primaryWidth: number }
  // ─── Variable mutations ─────────────────────────────────────────────────
  /**
   * Extract an inline style value into a component prop (variable). Creates
   * the prop definition and replaces the inline value with a reference.
   *
   * `clearLonghands` is used by compound atoms (Border) to drop per-side
   * longhand props from the JSX style object so the bound shorthand isn't
   * shadowed by leftover values. No-op for simple-value variables.
   */
  | { type: 'createVariable'; nodeId: string; styleProperty: string; propName: string; defaultValue: string; clearLonghands?: string[]; literalKind?: 'string' | 'number' | 'boolean'; varType?: string }
  | { type: 'createConditionalVariable'; nodeId: string; styleProperty: string; propName: string; consequent: string; alternate: string; boolDefault: string; varType?: string }
  | { type: 'setVariantBorderVariable'; nodeId: string; propName: string; variantName: string; defaultValue: string }
  | { type: 'setVariantInlineVariable'; nodeId: string; cssProp: string; propName: string; variantName: string; elseValue: string; defaultValue: string; elseIsIdentifier?: boolean }
  // Remove a per-variant style-variable OVERRIDE — drop `<variant>`'s branch from the inline ternary
  // so that variant reverts to the base binding. See removeVariantStyleVariableInCode.
  | { type: 'removeVariantStyleVariable'; nodeId: string; cssProp: string; variantName: string }
  /** Update a component variable's (prop's) default value in the function signature. */
  | { type: 'setComponentPropDefault'; propName: string; newDefault: string; literalKind?: 'string' | 'number' | 'boolean' }
  | { type: 'setComponentPropDescription'; propName: string; description: string }
  | { type: 'createTypedVariable'; name: string; varType: string; literalKind: 'string' | 'number' | 'boolean'; defaultValue: string }
  | { type: 'setChildEventFire'; childId: string; trigger: EventFireTrigger; eventVar: string; delay?: number; variantName?: string }
  | { type: 'removeChildEventFire'; childId: string; trigger: EventFireTrigger; variantName?: string }
  | { type: 'setComponentPropOptions'; propName: string; options: string[]; locked?: boolean }
  // Stamp a variable's @propMeta editor TYPE (e.g. 'option' for a select-control property) so the
  // VariableModal renders the right control PERSISTENTLY — independent of whether it's bound to a node.
  | { type: 'setComponentPropType'; propName: string; varType: string }
  | { type: 'deleteComponentVariable'; propName: string; defaultValue?: string }
  | { type: 'renameComponentVariable'; oldName: string; newName: string }
  | { type: 'setComponentPropLabel'; propName: string; label: string }
  | { type: 'setComponentPropVariantOf'; propName: string; componentTag: string }
  | { type: 'setComponentPropNumberMeta'; propName: string; meta: { min?: number | null; max?: number | null; step?: number | null; unit?: string | null; control?: 'slider' | 'stepper' | null } }
  /** Remove a component prop and restore the inline style value. */
  | { type: 'removeVariable'; nodeId: string; styleProperty: string; propName: string; defaultValue: string; deleteProp?: boolean }
  | { type: 'createTransitionVariable'; nodeId: string; mode: 'motionConfig' | 'variantEntry' | 'elementProp'; variantName: string | null; propName: string; defaultValue: string; onRoot?: boolean }
  /**
   * Replace an element's text children with `{propName}` and add the prop to
   * the function signature. Twin of `createVariable` for text content
   * instead of style values.
   */
  | { type: 'createTextVariable'; nodeId: string; propName: string; defaultValue: string }
  /** Inline a text variable back to literal JSX text + remove the prop. */
  | { type: 'removeTextVariable'; nodeId: string; propName: string; defaultValue: string; deleteProp?: boolean }
  /** PAGE text variable: bind a text node to a settable @pageVariables state var (useState),
   *  not a read-only @propMeta prop — so it's settable via the Interactions tool. */
  | { type: 'createTextPageVariable'; nodeId: string; propName: string; defaultValue?: string }
  /** Inline a page text variable back to literal text + drop the @pageVariables entry + hook. */
  | { type: 'removeTextPageVariable'; nodeId: string; propName: string; defaultValue?: string }
  // ─── Page variable mutations ────────────────────────────────────────────
  /** Declare a new page-level variable in the @pageVariables annotation block. */
  | { type: 'addPageVariable'; variable: PageVariable }
  /**
   * Hoist a nested-instance prop into the parent component's signature
   * as a controllable variable. Reads the current literal value of
   * `propName` on the instance with `instanceNodeId`, adds a
   * `@pageVariables` entry under `variable.name`, adds the prop to the
   * parent function's destructured params with the chosen default, and
   * rewrites EVERY `<componentName>` instance in the same file whose
   * `propName` literal matches — those siblings fold under the same
   * shared variable. Implemented in `features/hoist-prop.ts`. The
   * annotation entry is editor metadata; the destructured param is what
   * carries the runtime semantics — two intentional storage layers.
   */
  | { type: 'hoistInstanceProp'; instanceNodeId: string; componentName: string; propName: string; variable: { name: string; type: import('../features/page-variables').PageVariableType; default: string; description?: string }; scope?: import('../generation/generator-motion').SerScope | null }
  /** Turn a navigation attribute (href / target / data-smooth-scroll) on an
   *  `<a>`/`<Link>` into a component variable — adds a destructured prop and
   *  rewrites the attribute to reference it. See `createLinkAttrVariableInCode`. */
  | { type: 'createLinkAttrVariable'; nodeId: string; attrName: string; propName: string; kind: import('../features/variable-ops').LinkAttrKind; defaultValue: string; variableType: import('../features/page-variables').PageVariableType }
  /** Inverse of createLinkAttrVariable — detach the nav-attr variable: rewrite
   *  the attribute back to a literal and drop the prop + @pageVariables entry. */
  | { type: 'removeLinkAttrVariable'; nodeId: string; attrName: string; propName: string; kind: import('../features/variable-ops').LinkAttrKind; keepVariable?: boolean }
  /** Update an existing page variable (rename, change default, type, queryParam). */
  | { type: 'updatePageVariable'; oldName: string; updates: Partial<PageVariable> }
  /** Remove a page variable. The annotation block is dropped when the last variable goes. */
  | { type: 'removePageVariable'; name: string }
  /**
   * Bind a node's style property to a page variable: replaces the inline
   * literal with a JSX identifier (`opacity: 0.5` → `opacity: fadeVar`).
   * Auto-syncs useState declarations after writing.
   */
  | { type: 'bindStylePageVariable'; nodeId: string; styleProperty: string; varName: string }
  /**
   * Reverse of bindStylePageVariable. Replaces the identifier with a literal
   * value (typically the variable's current default). Empty `literalValue`
   * deletes the property entirely (matches the empty-string convention).
   */
  | { type: 'unbindStylePageVariable'; nodeId: string; styleProperty: string; literalValue: string }
  /**
   * Bind a style prop to a page variable PER-VIEWPORT on a normal node (a replica tile): writes
   * an inline `useMediaQuery`-gated identifier ternary `prop: (__mqN ? overrideVar : baseExpr)`.
   * `baseFallback` seeds the ternary fallback only when the prop has no existing value (otherwise
   * the current value/binding is read from code and kept). The viewport analog of the per-variant
   * style-variable binding. See responsive-style-vars-gen.ts.
   */
  | { type: 'bindResponsiveStyleVariable'; nodeId: string; vpWidth: number; styleProperty: string; varName: string; baseFallback: string }
  /** Reverse: drop a viewport's per-viewport variable branch (revert that tile to the cascaded base). */
  | { type: 'unbindResponsiveStyleVariable'; nodeId: string; vpWidth: number; styleProperty: string }
  /**
   * Replace the BASE branch of a per-viewport style ternary (`__mq ? override : base`) with a new
   * expression — used when the base VARIABLE is removed on the PRIMARY tile (the value is a ternary,
   * so the plain unbind can't find the identifier). Keeps the per-viewport overrides.
   */
  | { type: 'setResponsiveStyleBase'; nodeId: string; styleProperty: string; newBase: string }
  // Per-VIEWPORT TEXT-content variable on a template/page node — the text analog of the three above
  // (`{__mqN ? branch : base}` JSX-child ternary). `branch` is a var identifier (bind) OR a quoted
  // string literal (a frozen value, used by per-viewport REMOVE). See responsive-text-vars-gen.ts.
  | { type: 'bindResponsiveTextVariable'; nodeId: string; vpWidth: number; branch: string; baseFallback: string }
  | { type: 'unbindResponsiveTextVariable'; nodeId: string; vpWidth: number }
  | { type: 'setResponsiveTextBase'; nodeId: string; newBase: string }
  /**
   * Ensure a TEMPLATE variable is a function PARAM (+ @propMeta type) so it appears in the Template
   * tool and supports per-route overrides — converting a redundant `useState` a per-viewport var may
   * have landed as. Idempotent: keeps an existing param. Templates read vars as props, not useState.
   */
  | { type: 'ensureTemplateVarParam'; name: string; defaultValue: string; varType: string; literalKind: 'string' | 'number' | 'boolean' }
  /**
   * Add (or update) a "Set Variable" interaction on a node: writes
   * `onClick={() => setX(value)}` (or merges into the existing handler).
   * Updating an existing setter for the same varName replaces only its value.
   */
  | { type: 'addPageInteraction'; nodeId: string; trigger: InteractionTrigger; varName: string; value: string }
  /**
   * Remove a "Set Variable" interaction. Drops the call from the handler;
   * removes the whole event-handler attribute when nothing's left.
   */
  | { type: 'removePageInteraction'; nodeId: string; trigger: InteractionTrigger; varName: string }
  | { type: 'addCloseOverlay'; nodeId: string; trigger: InteractionTrigger; overlayId: string }
  | { type: 'removeCloseOverlay'; nodeId: string; trigger: InteractionTrigger; overlayId: string }
  | { type: 'setCloseOverlayDelay'; nodeId: string; trigger: InteractionTrigger; overlayId: string; delay: number }
  /** Map form lifecycle states (loading/success/error/disabled) → an instance's variants. */
  | { type: 'setFormStateMapping'; nodeId: string; stateVar: string; mapping: FormStateMapping }
  /** Per-VIEWPORT responsive raw-element attr override (value '' clears it). */
  | { type: 'setResponsiveAttr'; nodeId: string; vpWidth: number; attr: string; value: string; baseValue: string }
  | { type: 'setResponsiveAttrBase'; nodeId: string; attr: string; value: string }
  /** Per-VARIANT responsive raw-element attr override (value '' clears it). */
  | { type: 'setVariantAttr'; nodeId: string; variant: string; attr: string; value: string; baseValue: string }
  // ─── Border / SVG mutations ─────────────────────────────────────────────
  /** Set a CSS ::after pseudo-element overlay for complex borders (gradient borders, multi-layer). */
  | { type: 'updateBorderOverlay'; nodeId: string; afterCSS: string }
  /** Remove the ::after border overlay from an element. */
  | { type: 'removeBorderOverlay'; nodeId: string }
  /** Update arbitrary HTML attributes (aria-label, role, tabindex, etc.) on any element. Empty string removes the attribute. */
  | { type: 'updateHtmlAttrs'; nodeId: string; attrs: Record<string, string> }
  /** Set/clear a CMS navigation binding on an element — writes an expression-valued `href` resolving the current/adjacent detail item, plus the `data-cms-nav` marker. `mode: 'none'` clears it. */
  | { type: 'setCmsNavHref'; nodeId: string; mode: 'self' | 'prev' | 'next' | 'row' | 'none'; collection: string; itemVar?: string }
  // Code-component slots — connect/disconnect a canvas node into a
  // component's `slot` control (becomes a real JSX child).
  | { type: 'connectSlot'; componentId: string; canvasNodeId: string }
  | { type: 'disconnectSlot'; componentId: string; canvasNodeId: string }
  | { type: 'reorderSlot'; componentId: string; fromIndex: number; toIndex: number }
  /** Rename the HTML tag of an element (e.g. div → section). Updates both opening and closing tags. */
  | { type: 'changeTag'; nodeId: string; newTag: string }
  | { type: 'replaceComponentInstance'; nodeId: string; newTag: string; newDisplayName: string; width?: string; height?: string }
  /** Convert an element on a component master into a `<MotionLink>`
   *  (`motion.create(Link)` wrapper) — client-side nav + keeps motion props. */
  | { type: 'convertToMotionLink'; nodeId: string }
  /** (Re)sync the anchor-scroll onClick on a link after its href/section/smooth
   *  changed — so any `#anchor` link scrolls (instant, or smooth when on). */
  | { type: 'syncLinkHandler'; nodeId: string }
  /** Update SVG-specific attributes (viewBox, fill, stroke, d, etc.) on an SVG element. childIndex targets Nth shape child (default: first). */
  | { type: 'updateSvgAttrs'; nodeId: string; attrs: Record<string, string>; childIndex?: number }
  /** Append a new SVG shape child element inside an SVG wrapper. */
  | { type: 'addSvgChild'; nodeId: string; childJSX: string }
  /** Remove the Nth shape child from an SVG wrapper. */
  | { type: 'removeSvgChild'; nodeId: string; childIndex: number }
  /** Insert or partial-update the `<video data-bg-video>` first child on the host element.
   *  Idempotent: existing bg-video gets the provided fields patched; otherwise a fresh
   *  element is inserted (requires opts.src) and host position/overflow/isolation are
   *  auto-applied. */
  | { type: 'setVideoFill'; nodeId: string; opts: import('../generation/generator-video').BgVideoOpts }
  /** Remove the bg-video first child from the host element. Host styles are left
   *  in place — the user may have wanted them. */
  | { type: 'removeVideoFill'; nodeId: string }
  /** Replace ALL inner JSX between <svg> and </svg> with the given markup. Used by the
   *  in-tree SVG shape editor (src/svg-editor/) which round-trips full SVG content per edit. */
  | { type: 'replaceSvgInner'; nodeId: string; innerJSX: string }
  /** Set or replace `data-sketch-anim` JSON config on the wrapper SVG. */
  | { type: 'setSketchAnim'; nodeId: string; config: import('../sketch/sketch-anim-config').SketchAnimConfig }
  /** Remove `data-sketch-anim` from the wrapper SVG. */
  | { type: 'removeSketchAnim'; nodeId: string }
  /** Assign a data-id and data-name to an SVG child element (for selection/editing). */
  | { type: 'injectSvgDataId'; parentId: string; svgIndex: number; newId: string; newName: string }
  // ─── CSS Keyframe mutations ─────────────────────────────────────────────
  /** Create or update a @keyframes animation rule in app/globals.css (global, available across all pages). */
  | { type: 'updateKeyframes'; name: string; css: string }
  /** Remove a @keyframes animation rule from app/globals.css. */
  | { type: 'removeKeyframes'; name: string }
  // ─── CSS :hover mutations ───────────────────────────────────────────────
  /** Create or update a :hover CSS rule for an element in the page style block. */
  | { type: 'updateCssHover'; nodeId: string; styles: Record<string, string> }
  /** Remove the :hover CSS rule for an element. */
  | { type: 'removeCssHover'; nodeId: string }
  /** Add or remove a smooth scroll onClick handler on a link element. */
  | { type: 'setSmoothScroll'; nodeId: string; enabled: boolean }
  // ─── Motion mutations ────────────────────────────────────────────
  /** Set a Motion animation prop (whileHover, whileTap, animate, etc.) on an element. */
  | { type: 'updateMotionProp'; nodeId: string; propName: string; props: Record<string, string>; scope?: import('../animations/animation-scope').ResolvedScope }
  /** Remove a Motion animation prop from an element. */
  | { type: 'removeMotionProp'; nodeId: string; propName: string }
  /** Reset Override: drop one scope's branch from a responsive motion prop (keep the base). */
  | { type: 'removeMotionScopeBranch'; nodeId: string; propName: string; scope: import('../animations/animation-scope').ResolvedScope }
  // ─── Scroll animation mutations ─────────────────────────────────────────
  /** Add or update a scroll-driven animation (useScroll + useTransform hooks). */
  | { type: 'updateScrollAnim'; config: import('../generation/generator-motion').ScrollAnimConfig }
  | { type: 'updateScrollDirection'; config: import('../generation/generator-motion').ScrollDirectionConfig }
  | { type: 'removeScrollDirection'; nodeId: string }
  | { type: 'updateScrollSpeed'; config: import('../generation/generator-motion').ScrollSpeedConfig }
  | { type: 'removeScrollSpeed'; nodeId: string }
  /** Set / remove a continuous Loop effect (its own `data-loop` carrier). */
  | { type: 'updateLoop'; nodeId: string; spec: { props: Record<string, string>; transition: Record<string, string>; offscreen?: string; scope?: import('../generation/generator-motion').SerScope[] } }
  | { type: 'removeLoop'; nodeId: string }
  /** Set / remove a Scroll Variant (component instance — drives initialVariant). */
  | { type: 'updateScrollVariant'; nodeId: string; spec: import('../generation/scroll-variant-gen').ScrollVariantSpec }
  | { type: 'removeScrollVariant'; nodeId: string }
  | { type: 'updateInstanceFx'; nodeId: string; spec: import('../generation/instance-fx-gen').InstanceFxSpec }
  | { type: 'removeInstanceFx'; nodeId: string }
  /** Spec-driven normal-node effects: regenerate the whole data-scroll-fx block from
   *  the spec (robust to reformatting; replaces the fragile decompose/compose path). */
  | { type: 'updateScrollFx'; nodeId: string; spec: import('../generation/generator-motion').ScrollFxSpec }
  | { type: 'removeScrollFx'; nodeId: string }
  /** Glide ("Flow"): coordinate child layout animations on a normal container so
   *  siblings glide smoothly when one resizes. add/update carries the spec; remove
   *  unwraps. See generation/glide-gen.ts. */
  | { type: 'updateGlide'; nodeId: string; spec: import('../generation/glide-gen').GlideSpec }
  | { type: 'removeGlide'; nodeId: string }
  /** Reset Override on a responsive Scroll Speed: drop one viewport/variant branch. */
  | { type: 'removeScrollSpeedScopeBranch'; nodeId: string; scope: import('../generation/generator-motion').SerScope }
  /** Remove a scroll-driven animation from an element. */
  | { type: 'removeScrollAnim'; nodeId: string }
  // ─── CMS / Collection mutations ─────────────────────────────────────────
  /** Create a collection list (data-bound repeating elements) inside a parent element. */
  | { type: 'createCollectionList'; parentId: string; collectionSlug: string; templateJSX: string }
  /** Bind a node's property (text, src, href, style) to a CMS collection field. */
  | { type: 'bindField'; nodeId: string; property: string; fieldId: string; itemVar: string; fieldType?: string }
  /** Unbind a node's property from a CMS field and set a static value. */
  | { type: 'unbindField'; nodeId: string; property: string; staticValue: string }
  /** Per-VARIANT CMS text binding on a raw element inside a .map() in a component master:
   *  rebind that variant to `fieldId` (kind:'field'), unbind→literal default (kind:'literal'),
   *  or clear the variant override (kind:'clear'). Other variants keep the base binding. */
  | { type: 'setVariantCmsText'; nodeId: string; variantName: string; itemVar: string; override: { kind: 'field'; field: string } | { kind: 'literal'; value: string } | { kind: 'clear' } }
  /** Per-VARIANT CMS STYLE binding (the style analogue of setVariantCmsText) — rebind/unbind/clear
   *  a style property's CMS binding on ONE variant. `isImage` url-wraps a field-ref rebind. */
  | { type: 'setVariantCmsStyle'; nodeId: string; styleProp: string; variantName: string; itemVar: string; override: { kind: 'field'; field: string; isImage?: boolean } | { kind: 'literal'; value: string } | { kind: 'clear' } }
  /** Update filter, sort, and limit settings on a collection list. */
  | { type: 'updateCollectionConfig'; parentId: string; filterGroup?: import('@/shared/types').FilterGroup; sort?: import('@/shared/types').SortConfig[]; limit?: number; offset?: number }
  | { type: 'setListResponsiveConfig'; parentId: string; slug: string; config: ResponsiveListConfig; limit?: number | null; offset?: number | null; paginationVar?: string | null; variantArg?: string; vpWidths?: number[] }
  | { type: 'setPagination'; parentId: string; mode: 'loadMore' | 'infinite'; perPage: number }
  | { type: 'removePagination'; parentId: string }
  /** Dynamic "Search Field" filter input: create a text page variable + a bound
   *  search <input> just before the list. The matching filter (valueSource:
   *  'searchField', valueVar) is added separately via updateCollectionConfig. */
  | { type: 'addCollectionSearchField'; parentId: string; varName: string; frameId: string; fieldLabel: string; placeholder: string; isComponentFile?: boolean; queryParam?: string }
  /** Re-bind a Search Field input to a page variable (the "pick variable" dropdown
   *  on a Missing input). `createVar` first declares it as a fresh text page var. */
  | { type: 'setSearchInputVariable'; inputId: string; varName: string; createVar?: boolean }
  | { type: 'setInstanceEventDelay'; nodeId: string; propName: string; delaySeconds: number }
  // Bind/unbind a design-component INSTANCE's event prop to a "close overlay"
  // handler — lets the component's own event (an internal X firing `event1`)
  // close the overlay it lives inside (Increment D of the event-vars feature).
  | { type: 'bindInstanceEventCloseOverlay'; nodeId: string; propName: string; overlayId: string }
  | { type: 'unbindInstanceEvent'; nodeId: string; propName: string }
  // ─── Inline .map() / Repeater mutations ─────────────────────────────────
  /** Convert an element into an inline .map() repeater with data array */
  | { type: 'makeIntoMap'; nodeId: string; varName?: string }
  | { type: 'bindToCmsCollection'; nodeId: string; collectionSlug: string }
  | { type: 'unbindFromCmsCollection'; nodeId: string }
  | { type: 'changeCollectionSource'; parentNodeId: string; newSlug: string; fieldRemap?: Record<string, string> }
  /** Add an item to an existing inline .map() data array */
  | { type: 'addMapItem'; varName: string; item: Record<string, string> }
  /** Remove an item from an inline .map() data array by index */
  | { type: 'removeMapItem'; varName: string; index: number }
  /** Update an item in an inline .map() data array by index */
  | { type: 'updateMapItem'; varName: string; index: number; item: Record<string, string> }
  /** Add a new field to all items in an inline .map() data array */
  | { type: 'addMapField'; varName: string; fieldName: string; defaultValue?: string }
  /** Bind a style property to map data: inline value → item.fieldName */
  | { type: 'bindStyleToMap'; nodeId: string; varName: string; styleProp: string; fieldName: string; currentValue: string }
  /** Unbind a style property from map data: item.fieldName → inline value */
  | { type: 'unbindStyleFromMap'; nodeId: string; varName: string; styleProp: string; fieldName: string; inlineValue: string }
  /** Bind a component prop to map data: static value → item.fieldName */
  | { type: 'bindPropToMap'; nodeId: string; varName: string; propName: string; fieldName: string; currentValue: string; urlWrap?: boolean }
  | { type: 'unbindPropFromMap'; nodeId: string; propName: string }
  /** Clear ONE orphaned CMS prop binding (the "Missing" pill ×) → revert to default. */
  | { type: 'clearCmsOrphan'; nodeId: string; propName: string }
  /** Clear ONE orphaned component-variable binding (purple pill × on a canvas node).
   *  `target` is the slot id: 'content' | 'style.<prop>' | 'attr.<name>'. */
  | { type: 'clearVarOrphan'; nodeId: string; target: string }
  // ─── Preset / Design Token mutations ────────────────────────────────────
  /** Create a new design token (CSS custom property) in app/globals.css. Available as var(--name) in styles. */
  | { type: 'addPresetToken'; token: PresetToken }
  /** Update an existing design token's value. */
  | { type: 'updatePresetToken'; name: string; value: string }
  /** Remove a design token from app/globals.css. */
  | { type: 'removePresetToken'; name: string }
  /** Set the dark theme value for a design token in the [data-theme="dark"] block. */
  | { type: 'setDarkTokenValue'; tokenName: string; darkValue: string }
  // ─── Overlay mutations ─────────────────────────────────────────────────
  /** Create an overlay on a trigger element */
  | { type: 'createOverlay'; triggerId: string; overlayId: string; overlayConfig: import('@/shared/types').OverlayConfig; triggerConfig: import('@/shared/types').OverlayTriggerConfig; canvasNode?: boolean }
  /** Clone an overlay onto a canvas-node trigger CLONE (replica dragged out to canvas). No-op unless the source is an overlay trigger. */
  | { type: 'cloneCanvasOverlay'; sourceTriggerId: string; cloneTriggerId: string; vpWidth: number; variant?: string | null }
  /** Update overlay position (side, align, offset) — whole-config replace (base only) */
  | { type: 'updateOverlayPosition'; overlayId: string; config: import('@/shared/types').OverlayConfig }
  /** Update overlay config for a viewport: vpWidth null = base, number = responsive override. resetKeys clear a replica override. breakpoints = all viewport widths (baked as responsiveBp for owning-viewport resolution). */
  | { type: 'updateOverlayConfig'; overlayId: string; patch: import('@/shared/types').OverlayConfigPatch; vpWidth: number | null; resetKeys?: (keyof import('@/shared/types').OverlayConfigPatch)[]; breakpoints?: number[]; variant?: string | null }
  /** Update overlay trigger config (trigger type, dismiss type) */
  | { type: 'updateOverlayTrigger'; triggerId: string; config: import('@/shared/types').OverlayTriggerConfig }
  /** Remove an overlay and its trigger config */
  | { type: 'removeOverlay'; overlayId: string; triggerId: string }
  // ─── Motion Text animation mutations ──────────────────────────────────
  /** Add a text animation (splits text into motion.span children). */
  | { type: 'addTextAnim'; nodeId: string; config: import('@/editor/tools/AnimationTool/motion/text-anim-presets').TextAnimConfig }
  /** Update a text animation config (re-splits if animationType changed). */
  | { type: 'updateTextAnim'; nodeId: string; config: import('@/editor/tools/AnimationTool/motion/text-anim-presets').TextAnimConfig }
  /** Remove a text animation (collapses motion.span children back to text). */
  | { type: 'removeTextAnim'; nodeId: string }
  // ─── Website metadata mutations ────────────────────────────────────────────
  /** Update metadata fields in app/layout.tsx (title, description, icons, openGraph). */
  | { type: 'updateMetadata'; metadata: import('../generation/metadata-gen').SiteMetadata }
  /** Update siteConfig fields in app/layout.tsx (language, theme, customHead, customBody). */
  | { type: 'updateSiteConfig'; config: Record<string, string> }
  // ─── File-level mutations ───────────────────────────────────────────────
  /** Write a file to the project (components, pages, config files, etc.). Creates or overwrites. */
  | { type: 'writeFile'; filePath: string; content: string }
  /** Delete a file from the project. */
  | { type: 'deleteFile'; filePath: string }
  // ─── FIT text (SVG foreignObject wrap/unwrap) ──────────────────────────
  /** Wrap a text element in SVG foreignObject for FIT text mode */
  | { type: 'wrapFitText'; nodeId: string; viewBox: { width: number; height: number; fontSize: number; marginTop?: number } }
  /** Unwrap a text element from its SVG foreignObject FIT wrapper */
  | { type: 'unwrapFitText'; nodeId: string }
  // ─── Pseudo-element styles (::before / ::after) ───────────────────────
  /** Write or update a ::before or ::after CSS rule in the <style> block */
  | { type: 'updatePseudoStyle'; nodeId: string; pseudo: 'before' | 'after'; styles: Record<string, string> }
  /** Remove a ::before or ::after rule from the <style> block */
  | { type: 'removePseudo'; nodeId: string; pseudo: 'before' | 'after' }
  ;

// ─── Queue State ───────────────────────────────────────────────────────────

export interface MutationErrorDetail {
  /** The validation error message (e.g. babel parse error, dangling identifier, etc.) */
  message: string;
  /** Types of mutations that were being applied when the error occurred */
  mutationTypes: string[];
  /** Lines of generated code around the error location (extracted from babel line:col) */
  codeExcerpt?: string;
}

type FlushCallback = (newCode: string) => void;

const queue: Mutation[] = [];
let currentCode: string = '';
let isProcessing = false;
let flushTimer: number | null = null;
// FPS: while a slider/drag is live (`canvasInteractingAtom`), EXPENSIVE animation
// code-regens (scroll / hover / tap / appear / loop / variant / fx / keyframes …)
// are deferred here — coalesced to the latest per logical target — and flushed
// once the interaction ends. See `processQueue` / `pumpDeferredAnim`.
let deferredAnim: Mutation[] = [];
let animPumpRaf: number | null = null;

// Slider-driven animation mutations whose regen reparses the whole file + cascades
// a full re-render — too heavy to run at 60 ticks/sec. Coalesced per target so the
// release applies ONE regen, not N. EXCLUDES remove* (one-shot clicks, never a hot
// drag) and stateful update* mutations (carry an `oldCall` that must match live code).
const DEFERRABLE_ANIM_TYPES: ReadonlySet<string> = new Set([
  'updateScrollAnim', 'updateScrollDirection', 'updateScrollSpeed',
  'updateMotionProp', 'updateLoop', 'updateScrollVariant', 'updateInstanceFx',
  'updateScrollFx', 'updateGlide', 'updateTextAnim', 'setSketchAnim', 'updateKeyframes',
]);

// Stable identity for coalescing: same logical target → same key → keep latest.
// Safe because each of these carries the FULL state for that target (the editor
// sends a complete props/spec/config, not a delta), so the latest supersedes the
// rest. `propName` keeps hover/tap/initial/animate/exit independent.
function animCoalesceKey(m: Mutation): string {
  switch (m.type) {
    case 'updateMotionProp':      return `${m.type}:${m.nodeId}:${m.propName}:${JSON.stringify(m.scope ?? 0)}`;
    case 'updateScrollAnim':
    case 'updateScrollDirection':
    case 'updateScrollSpeed':     return `${m.type}:${(m.config as { nodeId?: string }).nodeId ?? ''}`;
    case 'updateKeyframes':       return `${m.type}:${m.name}`;
    case 'updateLoop':
    case 'updateScrollVariant':
    case 'updateInstanceFx':
    case 'updateScrollFx':
    case 'updateGlide':
    case 'updateTextAnim':
    case 'setSketchAnim':         return `${m.type}:${m.nodeId}`;
    default:                      return m.type;
  }
}
let onFlush: FlushCallback | null = null;
let onBeforeFlush: ((mutationTypes: string[]) => void) | null = null;
let onAfterFlush: (() => void) | null = null;
let onError: ((detail: MutationErrorDetail) => void) | null = null;

/** When true, the next flush will NOT set the "skip re-render" flag.
 *  Used by non-canvas-initiated code changes (JSON editor, etc.) that need a full Renderer rebuild. */
let _forceRenderOnNextFlush = false;
export function setForceRender(): void { _forceRenderOnNextFlush = true; }
/** Peek WITHOUT consuming — the drag-flush stash uses it to decide whether a
 *  mid-drag flush carries a STRUCTURAL change that must reach the canvas now
 *  (see deferred-drag-flush.onFlush). */
/** True while the flag is pending AND for the remainder of the flush that
 *  consumed it. The flush consumes `_forceRenderOnNextFlush` while deciding
 *  render-skip, which happens BEFORE onFlush subscribers run — so a plain peek
 *  read `false` exactly when the drag-flush stash asked, and the alt-duplicate
 *  kept being stashed ("still not rendering", 2026-08-08). */
export function isForceRenderPending(): boolean { return _forceRenderOnNextFlush || _forceRenderThisFlush; }
let _forceRenderThisFlush = false;
export function consumeForceRender(): boolean {
  const v = _forceRenderOnNextFlush;
  _forceRenderOnNextFlush = false;
  if (v) _forceRenderThisFlush = true;
  return v;
}
/** Reset the per-flush latch — called at the START of each flush cycle. */
export function beginFlushForceRenderWindow(): void { _forceRenderThisFlush = false; }

// Render-resolved mutation types (the render-skip decision) live in their own
// LEAF module — see `render-resolved-mutations.ts` for the full rationale.
// Re-exported here for callers that already import from the queue.
export { RENDER_RESOLVED_MUTATIONS, flushNeedsRender } from './render-resolved-mutations';

/** Active file path — so writeFile mutations can update code when targeting the active page */
let _activeFilePath: string = 'app/page.client.tsx';

/** Resolver handed to `dormantizeTranslationBinding` — looks the key up in the
 *  active page's default-locale messages. Built per call so a locale/page switch
 *  can't be captured stale. Failures degrade to null (the generator then falls
 *  back to showing the key) rather than aborting the move. */
function translationTextResolver(): (key: string) => string | null {
  return (key: string) => {
    try {
      return readTranslationText({ filePath: _activeFilePath, key, locale: getI18nConfig().defaultLocale });
    } catch {
      return null;
    }
  };
}

// ─── Configuration ─────────────────────────────────────────────────────────

/** How long to wait before flushing (batches rapid mutations) */
const FLUSH_DELAY_MS = 16; // ~1 frame

/**
 * Mutation types that can change what the file imports. Both the async
 * `processQueue` path and the synchronous `flushNow` path consult this
 * set so the import line always matches the JSX after a flush.
 *
 * History: previously this set lived inside `processQueue`. `flushNow`
 * skipped the import sync entirely, so every creator (which ends with
 * `flushNow()`) could land a `setVariantVisibility` mutation that wrote
 * an `<AnimatePresence>` wrapper without adding the import → the live
 * preview crashed with `ReferenceError: AnimatePresence is not
 * defined`.
 */
const IMPORT_AFFECTING_TYPES = new Set([
  'updateMotionProp', 'removeMotionProp', 'removeMotionScopeBranch',
  'updateScrollAnim', 'removeScrollAnim', 'updateScrollDirection', 'removeScrollDirection',
  'updateScrollSpeed', 'removeScrollSpeed', 'updateLoop', 'removeLoop',
  // Scroll Variant injects useState/useScroll/useMotionValueEvent/useInView/useRef/
  // useEffect — syncImports must add them or the page crashes "X is not defined".
  'updateScrollVariant', 'removeScrollVariant',
  'updateInstanceFx', 'removeInstanceFx',
  // Spec-driven normal-node effects: regenerate the data-scroll-fx block from the
  // spec — syncImports must add useScroll/useTransform/useSpring/useMotionValueEvent/
  // useEffect/animate that the regenerated hooks reference.
  'updateScrollFx', 'removeScrollFx',
  // Glide wraps children in <LayoutGroup> + motion.div wrappers — syncImports
  // must add `LayoutGroup`/`motion` from framer-motion (and prune them on remove).
  'updateGlide', 'removeGlide',
  'addNode', 'addCanvasNode', 'removeNode', 'changeTag', 'replaceComponentInstance',
  // convertToMotionLink injects `const MotionLink = motion.create(Link)` which
  // references `Link` — syncImports must add `import Link from 'next/link'`
  // (buildAutoImports detects `\bMotionLink\b`). Also re-flows the const onto
  // its own line after the import block.
  'convertToMotionLink',
  // updateTextAnim included: switching a Text Effect to "On Scroll" injects useScroll/useTransform/
  // useRef/useEffect — syncImports must add them or the page crashes "useScroll is not defined".
  'addTextAnim', 'updateTextAnim', 'removeTextAnim',
  'createOverlay', 'removeOverlay',
  // A 'move' back into a viewport REHYDRATES runtime (scroll-variant /
  // instance-fx / scroll-fx / overlay) — the overlay path adds useState +
  // useLayoutEffect. For an overlay CREATED on the canvas those React hooks
  // were never imported (canvas nodes have no runtime), so without a sync the
  // rehydrated code references undefined `useState`/`useLayoutEffect` and the
  // validator blocks the next mutation. syncImports is idempotent and only runs
  // on flush (reparent commit, not 60fps), so this is safe.
  'move',
  'writeFile',
  // setVariantVisibility emits `<AnimatePresence>` wrappers — needs
  // syncImports to add `AnimatePresence` to the framer-motion import
  // line on first wrap (and remove it on last unwrap, eventually).
  'setVariantVisibility',
  // Page variable bind/unbind insert/remove useState — syncImports needs to
  // pick up the React hook addition/removal.
  'bindStylePageVariable', 'unbindStylePageVariable', 'removePageVariable',
  // Per-viewport style-variable binding emits a `useMediaQuery` gate (which uses
  // useState/useEffect) into the page body — syncImports must add those React hooks.
  'bindResponsiveStyleVariable', 'unbindResponsiveStyleVariable',
  // Per-viewport TEXT-variable binding emits the same `useMediaQuery` gate.
  'bindResponsiveTextVariable', 'unbindResponsiveTextVariable',
  // Hoisting adds a new function-signature param + @pageVariables entry.
  // The annotation block addition triggers `syncImports`'s page-variable
  // detector pass; the destructured prop may need a React import.
  'hoistInstanceProp',
  // Pagination (Load More / Infinite Scroll) emits `useState` (+ `useRef`/
  // `useEffect` for infinite) into the page body — syncImports must add the React
  // hook named-imports or the page references undefined identifiers + validation
  // blocks every later mutation. Remove prunes them back.
  'setPagination', 'removePagination',
  // Responsive list config injects the `useResponsiveListConfig` hook (uses
  // useState/useEffect) into the file. On a PAGE useState is usually already
  // imported (pagination), but a DESIGN COMPONENT file is `import React from 'react'`
  // only → without syncImports the injected hook crashes "useState is not defined".
  'setListResponsiveConfig',
  // Search Field injects a `const [searchX,setSearchX] = useState('')` (page var)
  // → syncImports must add the React `useState` named-import or the page
  // references an undefined `useState` and validation blocks EVERY later mutation
  // (incl. deleting the input/filter). updateCollectionConfig is included too: a
  // dynamic filter add/remove changes which page-var hooks are referenced, and a
  // filter-delete on an already-broken page must trigger the import heal.
  'addCollectionSearchField', 'updateCollectionConfig',
  // Re-binding a search input declares/references a page var → emit its useState.
  'setSearchInputVariable',
]);

/** Structural mutations that can ORPHAN overlay runtime (detach/extract/clone/
 *  remove a trigger and leave a `{<var>Open && …}` conditional referencing a
 *  dropped useState). After a batch with any of these, `healDanglingOverlayState`
 *  re-declares any missing overlay useState so validation can't be tripped by a
 *  tangled component-variant sequence (esp. the variant-exit path, which uses
 *  addCanvasNode/removeNode — NOT the move handler's heal). */
/** Preset mutations write app/globals.css as a SIDE EFFECT of applyMutation —
 *  the page-code fan-out can't announce them: onFlush's setCode carries the
 *  UNCHANGED page code, activeCodeAtom skips identical content and never bumps
 *  projectVersion, so presetTokensAtom (a version-gated view of globals.css)
 *  stayed stale. A freshly created preset only showed up on the NEXT create's
 *  click-time panel bump — "create preset does nothing the first time" (user
 *  trace 2026-08-05: parsePresetTokens read the old CSS 17ms BEFORE the queued
 *  addPresetToken wrote the new one; the panels bump synchronously at click,
 *  the queue applies later). The queue announces the write itself, AFTER
 *  applying. Add/remove are discrete clicks → bump immediately. Value edits
 *  are slider-hot (a preset color drag flushes per tick, and presetUsageAtom's
 *  full-project scan hangs off the version) → trailing debounce, matching the
 *  edit panels' own debouncedBump cadence. */
const GLOBALS_CSS_ADD_REMOVE_TYPES = new Set<Mutation['type']>(['addPresetToken', 'removePresetToken']);
const GLOBALS_CSS_VALUE_TYPES = new Set<Mutation['type']>(['updatePresetToken', 'setDarkTokenValue']);
let _globalsCssBumpTimer: ReturnType<typeof setTimeout> | null = null;

function bumpVersionForGlobalsCssMutations(mutations: Mutation[]): void {
  const bump = () => getDefaultStore().set(projectVersionAtom, (v) => v + 1);
  if (mutations.some((m) => GLOBALS_CSS_ADD_REMOVE_TYPES.has(m.type))) {
    if (_globalsCssBumpTimer !== null) { clearTimeout(_globalsCssBumpTimer); _globalsCssBumpTimer = null; }
    trace.action('mutation-queue:globals-css-bump', { immediate: true });
    bump();
    return;
  }
  if (mutations.some((m) => GLOBALS_CSS_VALUE_TYPES.has(m.type))) {
    if (_globalsCssBumpTimer !== null) clearTimeout(_globalsCssBumpTimer);
    _globalsCssBumpTimer = setTimeout(() => {
      _globalsCssBumpTimer = null;
      trace.action('mutation-queue:globals-css-bump', { immediate: false });
      bump();
    }, 300);
  }
}

const OVERLAY_STRUCTURAL_TYPES = new Set<Mutation['type']>([
  'move', 'addCanvasNode', 'removeNode', 'cloneCanvasOverlay',
  'createOverlay', 'removeOverlay',
]);

/** Mutations that splice top-level DECLARATIONS (a `useState` pair + a hook
 *  block) into the component body, and are therefore syntax-gated on the
 *  SYNCHRONOUS `flushNow` path too — see the gate in `flushNow`. Kept to the
 *  rare, single-shot, user-initiated actions: gesture-hot types (`move`,
 *  `addNode`, `removeNode`) would pay a full parse per drop and are already
 *  covered by `processQueue`'s validation. */
const SYNC_SYNTAX_GATED_TYPES = new Set<Mutation['type']>([
  'createOverlay', 'removeOverlay', 'cloneCanvasOverlay',
]);

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize the mutation queue with the current code and flush callback.
 * Call this once on mount.
 */
export function initMutationQueue(
  initialCode: string,
  flush: FlushCallback,
  beforeFlush?: (mutationTypes: string[]) => void,
  afterFlush?: () => void,
  errorCallback?: (detail: MutationErrorDetail) => void,
): void {
  currentCode = initialCode;
  onFlush = flush;
  onBeforeFlush = beforeFlush ?? null;
  onAfterFlush = afterFlush ?? null;
  onError = errorCallback ?? null;
  // Drop any animation regens deferred against the previous document.
  deferredAnim = [];
  if (animPumpRaf !== null) { cancelAnimationFrame(animPumpRaf); animPumpRaf = null; }
}

/**
 * Keep the queue's code reference in sync.
 * Call this when code changes from OUTSIDE the queue (e.g., Monaco typing).
 */
export function syncQueueCode(code: string): void {
  // Only sync if we're not in the middle of processing
  if (!isProcessing) {
    currentCode = code;
  }
}

/**
 * Queue a mutation. The mutation is applied to the code string asynchronously.
 * The caller should have already updated the DOM for instant visual feedback.
 */
export function queueMutation(mutation: Mutation): void {
  // View-only gate. Every write path in the editor (drag, resize, style
  // panel, keyboard shortcuts, AI agent tools, etc.) funnels through
  // here, so one early-return at the bottom of the stack disables ALL
  // writes for viewers without per-callsite checks. The backend
  // re-enforces this via requireEditAccess — defense in depth.
  if (isViewerMode()) {
    trace.fn('queueMutation:blocked-viewer', { type: mutation.type });
    return;
  }
  queue.push(mutation);
  trace.fn('queueMutation', { type: mutation.type, nodeId: 'nodeId' in mutation ? mutation.nodeId : ('node' in mutation ? (mutation as any).node.id : undefined), queueSize: queue.length });
  // OVERLAY RE-HOMING (design-tool parity): a canvas-node overlay is GLUED to its
  // trigger. Whenever the trigger node re-parents into a real container (any
  // drag-enter/drop path — the strategies commit moves from several sites, so
  // this single chokepoint covers them all), move the overlay along into the
  // same parent. Left behind as a canvas node, its canvas-space positioning
  // fights the in-frame trigger and it teleports at the enter boundary, then
  // the canvas-overlay visibility rules hide it (live e2e 2026-06-12: ~292px
  // jump at enter, display:none in steady state). As a sibling of its
  // trigger it becomes a regular viewport overlay — the portal repositions
  // it from the trigger every render.
  if (mutation.type === 'move' && (mutation as any).newParentId && (mutation as any).canvasNode !== true) {
    const movedId = (mutation as any).nodeId as string;
    for (const ovNode of getAllCachedNodes()) {
      if (!ovNode.isCanvasNode || ovNode.id === movedId) continue;
      const ovAttr = ovNode.attrs?.['data-overlay'];
      if (!ovAttr) continue;
      try {
        const cfg = JSON.parse(ovAttr);
        if (cfg?.triggerId !== movedId) continue;
        queue.push({
          type: 'move', nodeId: ovNode.id,
          newParentId: (mutation as any).newParentId, canvasNode: false,
        } as Mutation);
        trace.action('mutation-queue:overlay-rehomed-with-trigger', {
          overlayId: ovNode.id, triggerId: movedId, newParentId: (mutation as any).newParentId,
        });
      } catch { /* unparseable overlay config — leave it */ }
    }
  }
  scheduleFlush();
}

/**
 * Queue multiple mutations at once (e.g., multi-select drag).
 */
export function queueMutations(mutations: Mutation[]): void {
  if (isViewerMode()) {
    trace.fn('queueMutations:blocked-viewer', { count: mutations.length });
    return;
  }
  queue.push(...mutations);
  trace.fn('queueMutations', { count: mutations.length, queueSize: queue.length });
  scheduleFlush();
}

/**
 * Get the current code (may include un-flushed mutations applied locally).
 * Use this instead of reading codeAtom when you need the latest code
 * for another mutation (e.g., drag + property change in quick succession).
 */
export function getCurrentCode(): string {
  return currentCode;
}

/** Set the active file path — so writeFile mutations know when to update the code string. */
export function setActiveFilePath(path: string): void {
  if (path !== _activeFilePath) {
    // Last-resort guard (switchActiveFile's pre-switch flushNow normally
    // applies it first): a deferred drop fan-out scheduled for the PREVIOUS
    // file must never fire after the active file changed — its onFlush would
    // push the old file's code into the new file's codeAtom. Cancel, don't
    // apply: the old file's bytes are already committed to projectFS by the
    // drain; only the (now-moot) subscriber notification is dropped.
    if (_deferRaf !== null || _deferNextFanOut) {
      trace.action('mutation-queue:cancel-stale-fan-out-on-file-switch', { from: _activeFilePath, to: path });
      cancelDeferredFanOut();
      _deferNextFanOut = false;
    }
  }
  _activeFilePath = path;
}

/** ID of the pending idle callback (so we can cancel it) */
let idleCallbackId: number | null = null;

/**
 * Force immediate processing AND cancel any pending async flush.
 * Call before page switch or any operation that replaces the code entirely.
 */
/** Transition-site flush: while an element drag is live, LEAVE the mutations
 *  queued (the drop's flushNow drains them in one chain) — the synchronous
 *  string pipeline was the mid-drag "start of drag is sluggish" stall on big
 *  pages. Outside a drag this is exactly flushNow(). */
/** True when the queue holds unapplied mutations. Lets drag teardown decide
 *  whether its drain is a real commit (arm the deferred fan-out) or a no-op
 *  click (arming would make flushNow's empty-queue fence fire a redundant
 *  synchronous setCode). */
export function hasQueuedMutations(): boolean {
  return queue.length > 0;
}

export function flushNowDeferredDuringDrag(): void {
  if (dragStateOps.get()) {
    trace.action('mutation-queue:flush-deferred-mid-drag', { queued: queue.length });
    return;
  }
  flushNow();
}

/** An EXTERNAL active-file write landed mid-gesture (a `modifyProjectFile`
 *  transaction — group refit, svg geometry bake). The deferred-drag-flush
 *  stash still holds the PRE-transaction flush output; letting it apply at
 *  gesture end would setCode → FS-mirror that stale code right over the
 *  transaction (the group-child "resize reverts on mouse-up" / "drag flashes
 *  the old position" report, 2026-07-28). Adopt the fresh code as the queue
 *  base AND route it through the flush channel so the stash is REPLACED —
 *  the gesture-end apply then carries exactly this state. No-op outside a
 *  gesture (the normal flush pipeline is already coherent there). */
export function refreshDeferredFlushWithExternalWrite(code: string): void {
  // Adopt during a gesture AND during the post-gesture deferred fan-out
  // window (~32ms): the fan-out fires with `currentCode`, so an external
  // write landing between gesture end and the fan-out timer would be
  // clobbered by the same mechanism (the viewport-resize @canvas config
  // revert, 2026-08-06).
  if (!dragStateOps.get() && _deferRaf === null) return;
  currentCode = code;
  trace.action('mutation-queue:external-write-refresh-stash', { codeLength: code.length });
  onFlush?.(code);
}
// SYNC registration for writers that can't import this module (circular dep):
// viewport-store's @canvas config writes reach the stash through the registry
// in the SAME task as their ProjectFS write — a microtask later is too late
// (see external-write-registry.ts).
registerExternalWriteRefresh(refreshDeferredFlushWithExternalWrite);

export function flushNow(): void {
  // Cancel any pending timers
  if (flushTimer !== null) {
    cancelAnimationFrame(flushTimer);
    flushTimer = null;
  }

  // Cancel any pending idle callback (prevents stale code from overwriting new page)
  if (idleCallbackId !== null) {
    if (typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(idleCallbackId);
    }
    idleCallbackId = null;
  }

  // EMPTY-QUEUE flush with a deferred drop fan-out still pending: APPLY it now,
  // synchronously, while `currentCode` still belongs to the file it was
  // scheduled for. switchActiveFile calls flushNow() right before changing the
  // active file — without this, the armed 32ms timer survived the switch and
  // fired AFTER setActiveFile, writing the OLD page's code into the NEW page's
  // codeAtom ("the home page injected into page 2's viewport" bug, with real
  // file-corruption potential via autosave). A non-empty flush supersedes the
  // pending fan-out in the drain below, exactly as before.
  if (queue.length === 0) {
    flushPendingFanOut();
  }

  // Process any remaining queued mutations synchronously
  if (queue.length > 0) {
    // SAME render-skip decision the async path makes (processQueue below) —
    // this drain skipped it entirely, and that is how a render-resolved
    // mutation got marked away. Every element drag drops through HERE (the
    // queue is held for the whole gesture, then reset() drains it), so the one
    // gate that exists to stop `updateContainerStyle` having its render
    // skipped was never asked on the only path that matters for drags.
    //
    // What that cost: dragging a canvas node back into the PRIMARY viewport
    // queues `updateContainerStyle {display:''}` to drop the "hidden on every
    // non-source viewport" rule the extraction wrote. The drop drained it —
    // the code came out correct — but DragCoordinator's position-only
    // optimisation had already armed `markCanvasUpdate()` (it inspects the
    // strategy's position updates, which know nothing about queued mutations),
    // so the render that rebuilds the @media→@container CSS was dropped with
    // `CanvasRenderer:skip-canvasUpdating`. The stale rule stayed in the
    // iframe and the node was invisible on desktop while still showing on
    // tablet — the user's "it HIDES the primary when I re-enter" (2026-08-04).
    // `decideFlushRenderGate` disarms exactly this; it just never ran.
    //
    // Pure position drops are unaffected: their queue holds only
    // `updateStyles`, which IS fully imperative, so the gate re-arms the skip.
    onBeforeFlush?.(queue.map((m) => m.type));

    const mutations = coalesceMoves(queue.splice(0));
    const codeBefore = currentCode; // pre-mutation baseline for the syntax gate
    let code = healDuplicateLayoutAttrs(currentCode);
    for (const m of mutations) {
      code = applyMutation(code, m);
    }
    // globals.css side-effect writes are committed at this point regardless of
    // what the syntax gate below decides about the PAGE code — announce them.
    bumpVersionForGlobalsCssMutations(mutations);
    code = reglideInsertedParents(code, mutations);
    // Heal any overlay runtime orphaned by a structural mutation BEFORE import
    // sync (so the re-declared useState keeps the React import). PRUNE first —
    // drop duplicate/orphan overlay elements left by a fragile canvas↔viewport
    // round-trip (the "ghost overlay") — THEN re-declare state only for the
    // survivors.
    if (mutations.some(m => OVERLAY_STRUCTURAL_TYPES.has(m.type))) {
      code = stripOverlaysNestedInOverlaysInCode(code);
      code = liftNestedCanvasOverlaysToRoot(code);
      code = pruneOverlayDuplicatesInCode(code);
      code = healDanglingOverlayState(code);
      code = healMissingOverlayEffectsInCode(code);
      code = healUnwrappedOverlayInCode(code);
      // LAST — the wrapper must be whole before the block can be relocated.
      code = healMisplacedOverlayInCode(code);
    }
    // Sync imports for mutations that change what the file uses.
    // Without this the async `processQueue` path picks it up, but
    // every creator (Frame/Text/Layout/Shape/Sketch) ends with a
    // synchronous `flushNow()` — which previously skipped the import
    // sync. Visible symptom: drawing a frame on a non-primary variant
    // queued `setVariantVisibility` (wrapping the JSX in
    // `<AnimatePresence>`) but the framer-motion import line never
    // got `AnimatePresence` added → live preview crashes with
    // `ReferenceError: AnimatePresence is not defined`.
    if (mutations.some(m => IMPORT_AFFECTING_TYPES.has(m.type))) {
      code = syncImports(code);
    }
    // SELF-HEAL dangling `{item.field}` text + `${item.field}` style stranded in
    // `canvasNodes` by a drag-out (a whole CMS row's children dangle at module
    // scope). This is the SYNCHRONOUS drag-commit path — without the heal here it
    // committed the live binding (canvas showed item-0's resolved data on mouse-up,
    // only fixed by a later async processQueue). Mirrors the processQueue heal.
    if (code.indexOf('const canvasNodes') !== -1) {
      code = healDanglingCanvasNodeBindings(code);
      // A search field / dynamic CMS filter pasted onto the canvas references a
      // page useState var at module scope → "X is not defined". Neutralize it.
      code = dormantizePageVarBindingsInCanvas(code);
    }
    // A Search Field pasted into a VIEWPORT of a page that doesn't declare its var
    // → undeclared `searchX` ref → crash. Neutralize the MISSING ones (page tree
    // too, not just canvasNodes); the marker stays so the tool shows "Missing".
    code = neutralizeMissingSearchFieldsInCode(code);
    // ROOT-CAUSE HEAL for the sticky-residue class: components written before
    // the CSS_NEUTRAL_FALLBACK seed carry `default: {}` next to sparse variant
    // entries — framer-motion never resets a prop the target variant doesn't
    // mention, so those values STICK on live after any breakpoint pass. The
    // user can't know WHICH node is corrupted, so ANY edit to the file re-seeds
    // every variant object. Cheap scan-only no-op when nothing is missing;
    // validate-or-revert inside (can never make the file worse).
    code = healSparseVariantDefaults(code);
    // Drop a variant-entry SHORTHAND stranded behind its own longhands — applied
    // in key order it nullifies every side, so the entry paints as zero.
    code = healStrandedVariantShorthands(code);
    // Converge drift-era stray @media bands onto the page's own @canvas
    // viewport keys (config-revert-era pages carry bands keyed at widths no
    // viewport has — panel override lookups miss, resizes strand them).
    // Cheap keys-vs-config gate inside; no-op on healthy pages.
    code = normalizeResponsiveBandKeys(code);
    code = healDanglingModuleJsxInCode(code);
    // Repair `[data-id="…" someAttr={…}]::after` — a JSX attribute spliced into
    // a <style> selector by a generator that located the node with a raw
    // indexOf. Kills the CSS rule AND means the intended write never landed.
    code = healStyleBlockSelectorAttrsInCode(code);
    // Repair event handlers that transition between variants `connections` has
    // no edge for. Such a handler is INVISIBLE — the Interactions panel reads
    // `connections`, so it shows nothing to remove while the runtime still
    // fires. Scan-only no-op when every transition is backed.
    code = healDriftedConnectionHandlersInCode(code);

    // SYNTAX GATE for the synchronous path. `processQueue` has always validated
    // + rolled back, but `flushNow` — which EVERY creator and the overlay tool
    // call to get their node into the parse this same tick — committed whatever
    // the generator produced straight into `currentCode` and projectFS. So a
    // generator bug there didn't surface as "the action failed"; it wrote a
    // broken file, the parse yielded zero nodes, and the user's page went blank
    // with no way back (live find 2026-07-25: an overlay's `useState` spliced
    // inside the root element's `style={{ }}`).
    //
    // DELIBERATELY NARROW — only the mutations that splice top-level
    // DECLARATIONS (`const [xOpen, setXOpen] = useState()` + a hook block) into
    // the component body. Those are rare, single-shot, user-initiated actions
    // where one extra parse is imperceptible and a corrupted file is
    // catastrophic. `move` / `addNode` / `removeNode` are gesture-hot (every
    // drag-drop and every creator ends in flushNow) and the drop path
    // deliberately DEFERS its parse for frame budget — validating them here
    // would undo that. They keep the async `processQueue` validation.
    const needsSyntaxGate = mutations.some(m => SYNC_SYNTAX_GATED_TYPES.has(m.type));
    if (needsSyntaxGate) {
      const syncValidationError = validateGeneratedCode(code);
      // Only block damage THIS flush caused. If the file was ALREADY invalid
      // going in, rolling back doesn't repair anything — it just refuses every
      // action forever, so the user is stuck with a broken page and no way to
      // edit their way out (live find 2026-07-25: a page carrying an overlay
      // block stranded at module scope by an earlier generator bug refused every
      // subsequent "create overlay" with "References undefined identifier").
      // Let it through and trace loudly; the heal passes above are what actually
      // repair such a file.
      const wasAlreadyInvalid = syncValidationError ? validateGeneratedCode(codeBefore) : null;
      if (syncValidationError && !wasAlreadyInvalid) {
        // ROLL BACK: leave `currentCode` on the last good string and report.
        // Same contract as the async path — the mutations are dropped, the file
        // on disk is untouched, and the user keeps a working page.
        trace.error('mutation-queue:flushNow-validation-failed', {
          error: syncValidationError,
          mutationTypes: mutations.map(m => m.type),
        });
        onError?.({
          message: syncValidationError,
          mutationTypes: mutations.map(m => m.type),
          codeExcerpt: extractCodeExcerpt(code, syncValidationError),
        });
        isProcessing = false;
        onAfterFlush?.();
        return;
      }
      if (syncValidationError) {
        trace.error('mutation-queue:flushNow-preexisting-invalid', {
          error: syncValidationError,
          before: wasAlreadyInvalid,
          mutationTypes: mutations.map(m => m.type),
        });
      }
    }

    currentCode = code;
    if (_deferNextFanOut) {
      // DROP PATH: the string is committed (currentCode + projectFS) but the
      // setCode FAN-OUT — codeAtom → nodesAtom re-parse + the cascade of
      // code-derived atoms (overlays, slots, page-interactions, translations,
      // …) ≈ 170ms on a 470KB page — is deferred to the NEXT frame so the
      // mouseup frame returns immediately (the release feels instant instead
      // of freezing ~200ms). The canvas DOM is already correct (render-skip +
      // bridge patch) and the node CACHE is synchronous, so nothing visual
      // waits on this. Set ONLY for pure canvas-node repositions; reparents
      // keep the synchronous fan-out (their render needs the fresh parse).
      _deferNextFanOut = false;
      scheduleDeferredFanOut();
    } else {
      cancelDeferredFanOut(); // a synchronous flush supersedes any pending drop fan-out
      onFlush?.(code);
    }
  }

  // Ensure clean state
  isProcessing = false;
  onAfterFlush?.();
}

// ─── Deferred drop fan-out ──────────────────────────────────────────────────
let _deferNextFanOut = false;
let _deferRaf: number | null = null;
/** What the armed fan-out is FOR. 'drop' fan-outs carry a pushHistory the
 *  next undo/redo must flush; 'restore' fan-outs are pure mirrors a newer
 *  restore can safely supersede (settlePendingFanOutForHistory). */
let _deferKind: 'drop' | 'restore' | null = null;

function scheduleDeferredFanOut(delayMs = 32, kind: 'drop' | 'restore' = 'drop'): void {
  // 'drop' is sticky: if a drop fan-out is armed and a restore re-requests,
  // the pending apply still carries the drop's pushHistory — downgrading it
  // to cancellable 'restore' would let the next undo silently drop that
  // history capture.
  _deferKind = _deferKind === 'drop' ? 'drop' : kind;
  if (_deferRaf !== null) return; // already scheduled — the callback reads the LATEST currentCode
  // setTimeout — NOT requestAnimationFrame. The whole point of the defer is
  // to let the sandbox iframe (same-origin ⇒ same event loop) process its
  // already-queued bridge messages (reparentLive, order/style patches — the
  // DOM moves that make the drop visually LAND) before the heavy parse +
  // React fan-out runs. rAF fires at the next frame boundary, which the
  // browser services AHEAD of pending message tasks — so the fan-out still
  // cut in line and the drop stayed visually blocked behind its ~120ms task
  // (long-task profiling, 2026-07). A timeout task queues BEHIND the
  // earlier-posted iframe messages; 32ms ≈ two frames also lets the iframe
  // apply + paint the move first.
  setPreferCacheSnapshot(true);
  _deferRaf = setTimeout(() => {
    _deferRaf = null;
    _deferKind = null;
    setPreferCacheSnapshot(false);
    onFlush?.(currentCode);
    onAfterFlush?.();
  }, delayMs) as unknown as number;
}

function cancelDeferredFanOut(): void {
  _deferKind = null;
  if (_deferRaf === null) return;
  clearTimeout(_deferRaf as unknown as ReturnType<typeof setTimeout>);
  _deferRaf = null;
  setPreferCacheSnapshot(false);
}

/** Mark the NEXT flushNow() drain to DEFER its setCode fan-out to the next
 *  frame (see the drop-path comment). The drag-drop commit calls this for pure
 *  canvas-node reposition drops. */
export function setDeferNextFanOut(): void {
  _deferNextFanOut = true;
}

/** Schedule the FENCED deferred fan-out for the CURRENT queue code (undo/redo
 *  restore path). currentCode must already be synced (syncQueueCode). Same
 *  32ms-timeout mechanism the drop path uses — the iframe's already-posted
 *  render/patch messages get serviced first, panels catch up right after —
 *  and the same fences apply: an empty-queue flushNow applies it early, a
 *  file switch cancels it. */
export function scheduleQueueFanOut(): void {
  trace.action('mutation-queue:schedule-restore-fan-out', { codeLength: currentCode.length });
  // 250ms (vs the drop path's 32): measured — same-process iframe messages
  // lose to parent timers regardless of posting order, so a 32ms fan-out cut
  // in FRONT of the restore's patch render and pushed the whole
  // render→measure→overlay-catch-up chain ~300ms late. 250ms clears the
  // iframe's render+measure window; the visual + overlay + live panel are
  // already correct from the seed, so panels reconciling to the parsed truth
  // a quarter-second later is imperceptible. Same fences (empty-flush
  // applies, file-switch cancels, next undo/redo CANCELS — see
  // settlePendingFanOutForHistory).
  scheduleDeferredFanOut(250, 'restore');
}

/** Drag-END fan-out: a drag whose commits flushed MID-gesture (enter/exit
 *  reparents — the deferred-drag-flush stash) previously applied its setCode
 *  SYNCHRONOUSLY at mouseup: full Babel re-parse + the whole code-derived
 *  atom cascade in one task pile-up — no frame for ~330ms on a 470KB page
 *  (measured 2026-07-19: first rAF after a drag-out-of-frame mouseup landed
 *  at 331ms; stale pin-constraint lines / name labels stayed painted the
 *  whole time). The canvas DOM is already live-correct (strategies reparent
 *  imperatively + keep the node cache consistent), so the fan-out can ride
 *  the SAME fenced 32ms defer the reposition drop path uses. Returns false
 *  if `code` is not the queue's currentCode (caller falls back to the
 *  synchronous apply — the stash must never be silently dropped). */
export function scheduleDragEndFanOut(code: string): boolean {
  if (code !== currentCode) {
    trace.action('mutation-queue:drag-end-fan-out-mismatch', { codeLength: code.length, currentLength: currentCode.length });
    return false;
  }
  trace.action('mutation-queue:schedule-drag-end-fan-out', { codeLength: code.length });
  scheduleDeferredFanOut();
  return true;
}

/** True while a deferred fan-out (drop OR undo/redo restore) is armed. While
 *  pending, the QUEUE's currentCode is ahead of codeAtom BY DESIGN — mirrors
 *  of codeAtom (the lifecycle's code-sync effect) must NOT sync it back into
 *  the queue, or a stale React effect replays an OLD code state over the
 *  restored one (measured: rapid undo→redo regressed the file to a previous
 *  state, pushed a phantom history entry, and WIPED the redo stack — the
 *  "redo only works once" bug). */
export function hasPendingDeferredFanOut(): boolean {
  return _deferRaf !== null || _deferNextFanOut;
}

/** Force a pending deferred drop fan-out to run NOW (synchronously). Called
 *  before reads that MUST see a fresh codeAtom (undo/redo). No-op otherwise. */
export function flushPendingFanOut(): void {
  if (_deferRaf === null && !_deferNextFanOut) return;
  cancelDeferredFanOut();
  _deferNextFanOut = false;
  setPreferCacheSnapshot(false);
  onFlush?.(currentCode);
  onAfterFlush?.();
}

/** History fence (undo/redo entry): land or drop the pending deferred fan-out.
 *  A DROP-kind fan-out must FLUSH — its apply carries the pushHistory that
 *  lets this undo capture the drop. A RESTORE-kind fan-out is SUPERSEDED by
 *  the restore about to run: its setCode is a skip-identical no-op and its
 *  pushHistory diffs nothing, but flushing it still queued a React pass over
 *  the PREVIOUS restore's code that repainted the canvas one state BACK
 *  ~15ms after the new restore's canvas-first patch — the rapid-Cmd+Z
 *  "flips between undo and redo states" glitch (user trace 2026-08-05). */
export function settlePendingFanOutForHistory(): void {
  if (_deferRaf !== null && _deferKind === 'restore' && !_deferNextFanOut) {
    trace.action('mutation-queue:restore-fan-out-superseded', { codeLength: currentCode.length });
    cancelDeferredFanOut();
    return;
  }
  flushPendingFanOut();
}

// ─── Internal ──────────────────────────────────────────────────────────────

/**
 * Extract lines of code around the error location from a babel error message like "(384:210)".
 * Returns a small excerpt with a → pointer on the error line.
 */
function extractCodeExcerpt(code: string, errorMessage: string): string | undefined {
  const match = errorMessage.match(/\((\d+):(\d+)\)/);
  if (!match) return undefined;
  const errorLine = parseInt(match[1], 10);
  const lines = code.split('\n');
  const start = Math.max(0, errorLine - 3);
  const end = Math.min(lines.length, errorLine + 2);
  return lines.slice(start, end).map((l, i) => {
    const lineNum = start + i + 1;
    const prefix = lineNum === errorLine ? `→ ${String(lineNum).padStart(4)}:` : `  ${String(lineNum).padStart(4)}:`;
    return `${prefix} ${l}`;
  }).join('\n');
}

/**
 * Validate generated code before flushing to the canvas.
 * Returns an error message if invalid, null if clean.
 * Catches both syntax errors (babel) and known semantic mistakes
 */
/** @internal Exported for testing. */
export function validateGeneratedCode(code: string): string | null {
  // Fast semantic checks first (cheap, catch AI-specific mistakes)
  // Detect character-indexed properties pattern: AI spread a JSON string as object keys
  // Pattern: 3+ consecutive numeric keys like `0: '...', 1: '...', 2: '...'`
  if (/\b\d+:\s*['"][^'"]*['"],\s*\d+:\s*['"]/.test(code)) {
    return 'Generated code contains character-indexed properties — AI sent properties as a string instead of an object';
  }

  // Babel syntax check
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch (err) {
    return (err as Error).message;
  }

  // Unresolved-reference check. A mutation can produce SYNTACTICALLY VALID code that
  // references an identifier with no declaration/import — e.g. an orphaned motion var
  // `…OpacityDC` whose `const` was dropped by a bad compose/decompose. That parses
  // fine but throws `X is not defined` (ReferenceError) and CRASHES the preview. Use
  // Babel scope analysis: `program.scope.globals` is every reference that resolves to
  // no binding in the whole file. Anything left after filtering true JS/DOM globals
  // is a dangling reference → block + revert, just like a syntax error.
  try {
    let dangling: string[] = [];
    // DUPLICATE JSX ATTRIBUTES — React silently keeps the LAST while the
    // parser reads the FIRST, so the editor and runtime permanently DISAGREE
    // about the node (live find 2026-07-03: variant creation appended a second
    // `initial` next to an Appear effect's initial — the appear died at
    // runtime and the canvas missed the variant wiring).
    let dupAttr: { name: string; line?: number } | null = null;
    traverse(ast, {
      JSXOpeningElement(path: any) {
        if (dupAttr) return;
        const seen = new Set<string>();
        for (const attr of path.node.attributes) {
          if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier') continue;
          const n = attr.name.name as string;
          if (seen.has(n)) { dupAttr = { name: n, line: attr.loc?.start.line }; return; }
          seen.add(n);
        }
      },
    });
    if (dupAttr !== null) {
      const d = dupAttr as { name: string; line?: number };
      return `Duplicate JSX attribute \`${d.name}\` on the element at line ${d.line ?? '?'} — React keeps only the LAST one while the editor reads the FIRST, so they permanently disagree. Merge the two values into one attribute.`;
    }
    traverse(ast, {
      Program(p) {
        dangling = Object.keys((p.scope as any).globals || {}).filter((n) => !KNOWN_GLOBALS.has(n));
      },
    });
    if (dangling.length) {
      return `References undefined identifier${dangling.length > 1 ? 's' : ''}: ${dangling.slice(0, 4).join(', ')}${dangling.length > 4 ? ` (+${dangling.length - 4} more)` : ''} — would crash at runtime`;
    }
  } catch (e) {
    // Scope crawl failed — fall back to the syntax-only check above, but DON'T swallow
    // silently: this is the undefined-identifier safety net, and a silent failure here
    // is how a dangling reference can slip past the guard into the live preview.
    trace.error('validateGeneratedCode:scope-crawl-failed', { error: e instanceof Error ? e.message : String(e) });
  }

  // CORRUPTED motion EASE — a cubic-bezier array truncated into a string
  // (`ease: '[0.16'`) by a bracket-unaware comma split. framer-motion THROWS
  // "Invalid easing type" when the animation starts, killing the driver —
  // every whileInView below the element stays invisible on the live site
  // while the canvas (no animations) looks fine (live find 2026-07-03).
  {
    const badEase = code.match(/ease:\s*['"]\[[^'"]*['"]/);
    if (badEase && badEase.index !== undefined) {
      const line = code.slice(0, badEase.index).split('\n').length;
      return `Corrupted easing value ${badEase[0]} at line ${line} — a cubic-bezier array truncated into a string. framer-motion crashes on it at runtime. Restore the full array form, e.g. ease: [0.16, 1, 0.3, 1].`;
    }
  }

  // useScroll target/container refs must stay ATTACHED. framer-motion 12
  // hard-crashes the whole page ("Target ref is defined but not hydrated")
  // when a `useScroll({ target: X })` ref never lands on an element. A canvas
  // edit that rewrites the target element's opening tag can silently drop the
  // `ref={X}` attribute (live find 2026-07-07: the works-grid parallax column C
  // lost its ref during editing → the published/preview page white-screened).
  // The MCP oracle has the same rule (SCROLL_TARGET_UNATTACHED) but only gates
  // AI submits — this guard covers the editor's own mutations: the batch is
  // blocked + reverted, like a syntax error. Cheap regex pass, gated on the
  // hook's presence.
  if (code.includes('useScroll(')) {
    const targetRe = /useScroll\(\s*\{[^)]*?\b(?:target|container)\s*:\s*([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    const missing: string[] = [];
    while ((m = targetRe.exec(code)) !== null) {
      const name = m[1];
      // Attached either DECLARATIVELY (`ref={X}` in JSX) or IMPERATIVELY
      // (`X.current = document.querySelector(...)` in an effect — the pattern
      // text-anim-gen / instance-fx-gen emit, with a `|| document.body`
      // fallback so the ref always hydrates). Both satisfy the invariant.
      if (!new RegExp(`ref=\\{${name}\\}`).test(code)
          && !new RegExp(`\\b${name}\\.current\\s*=`).test(code)) missing.push(name);
    }
    if (missing.length) {
      return `useScroll target ref${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not attached to any element (ref={${missing[0]}} missing) — framer-motion crashes the page when a scroll target ref never hydrates. Re-attach the ref or remove the useScroll/useTransform chain.`;
    }
  }

  return null;
}

// Identifiers that legitimately resolve at runtime without a local binding/import:
// JS built-ins + browser/DOM globals + Node/bundler globals. Anything referenced but
// NOT here and NOT declared/imported in the file is treated as a dangling reference.
// (Imported names — React, framer-motion hooks, components — ARE bound, so they
// never appear in scope.globals.)
const KNOWN_GLOBALS = new Set<string>([
  // JS language
  'undefined', 'null', 'NaN', 'Infinity', 'globalThis', 'arguments', 'eval', 'this',
  'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol',
  'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Function', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'btoa', 'atob',
  // typed arrays / binary (WebGL + canvas code components — AuroraBackground uses Float32Array;
  // missing entries here false-positived the oracle's WOULD_CRASH prime-rule test 2026-06-10)
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Float32Array', 'Float64Array',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array',
  // canvas / media / audio (code component territory)
  'OffscreenCanvas', 'ImageData', 'Path2D', 'createImageBitmap', 'ImageBitmap',
  'AudioContext', 'webkitAudioContext', 'devicePixelRatio', 'innerWidth', 'innerHeight',
  // timers / scheduling
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  // browser / DOM
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'WebSocket',
  'Image', 'Audio', 'Video', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver',
  'getComputedStyle', 'matchMedia', 'DOMParser', 'Node', 'Element', 'HTMLElement',
  'NodeList', 'Range', 'Selection', 'crypto', 'performance', 'CSS', 'AbortController',
  // more browser APIs
  'alert', 'confirm', 'prompt', 'scrollTo', 'scrollBy', 'getSelection', 'Worker',
  'Notification', 'caches', 'indexedDB', 'TextEncoder', 'TextDecoder', 'AbortSignal',
  'PointerEvent', 'TouchEvent', 'WheelEvent', 'DragEvent', 'FocusEvent', 'InputEvent',
  'AnimationEvent', 'TransitionEvent', 'DataTransfer', 'ClipboardEvent', 'CSSStyleSheet',
  // React / runtime
  'React', 'Fragment', 'process', 'module', 'exports', 'require',
]);

/**
 * Sync imports at the top of the code to match what's actually used.
 * Scans the code body for usage of React hooks, framer-motion, etc.
 * Adds missing imports, removes unused ones. Runs after every mutation batch.
 */
/** @internal Exported for testing only */
// Re-export the shared framework-import detector so callers in this module
// (and downstream importers) have a single name to reach for. The actual
// implementation lives in `src/shared/import-detection.mjs` so the one-shot
// template pre-bake script (`scripts/add-template-imports.mjs`) can run
// the same logic from plain Node without a TS toolchain — keeping syncImports
// and the script byte-equivalent in their import-detection output.
export { buildAutoImports } from '@/shared/import-detection.mjs';
import { buildAutoImports as _buildAutoImports } from '@/shared/import-detection.mjs';

export function syncImports(code: string): string {
  // Only process page/component files (have export default function)
  if (!code.includes('export default function') && !code.includes('export default ')) return code;

  // Skip layout.tsx (server component) — has metadata export, incompatible with 'use client'.
  // LayoutClient.tsx is a client component and should NOT be skipped (has LayoutClient, not RootLayout).
  if (code.includes('export const metadata') || code.includes('RootLayout')) return code;

  // Split code into import block and body. Block comments at the top of the
  // file (`/** @canvas {...} */`, `/** @pageVariables {...} */`) are
  // captured as complete units so they can be re-emitted verbatim — the
  // original code only kept lines starting with `import` and dropped these
  // annotation blocks on every flush, which silently stripped page-variable
  // declarations whenever a useState insert triggered an import sync.
  const lines = code.split('\n');
  const importLines: string[] = [];
  const bodyLines: string[] = [];
  const blockComments: string[] = []; // each entry = full multi-line `/** ... */` block
  let pastImports = false;

  let inBlockComment = false;
  let currentBlock: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    if (!pastImports && inBlockComment) {
      currentBlock.push(line);
      if (trimmed.includes('*/')) {
        inBlockComment = false;
        blockComments.push(currentBlock.join('\n'));
        currentBlock = [];
      }
      continue;
    }

    // Open a new block comment
    if (!pastImports && (trimmed.startsWith('/**') || trimmed.startsWith('/*'))) {
      currentBlock = [line];
      if (trimmed.includes('*/')) {
        // Single-line block comment — close immediately.
        blockComments.push(currentBlock.join('\n'));
        currentBlock = [];
      } else {
        inBlockComment = true;
      }
      continue;
    }

    // An `import …;<statement>` line — a top-level statement squished after the
    // import's terminating `;` (e.g. retainLines placed
    // `const MotionLink = motion.create(Link);` there). Split it: the import
    // part stays in importLines (so the framework-import dedup sees it), the
    // trailing statement goes to the body — otherwise the whole line is
    // dropped as a framework import and the statement is lost.
    if (!pastImports && trimmed.startsWith('import ')) {
      const semi = line.indexOf(';');
      const after = semi !== -1 ? line.slice(semi + 1).trim() : '';
      if (after) {
        importLines.push(line.slice(0, semi + 1));
        pastImports = true;
        bodyLines.push(line.slice(semi + 1));
        continue;
      }
    }

    if (!pastImports && (
      trimmed.startsWith("'use client'") ||
      trimmed.startsWith('"use client"') ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('//') ||
      trimmed === ''
    )) {
      importLines.push(line);
    } else {
      pastImports = true;
      bodyLines.push(line);
    }
  }
  // If we hit EOF mid-block (malformed), recover by treating the unfinished
  // accumulator as a leading block — better than dropping it.
  if (currentBlock.length > 0) {
    blockComments.push(currentBlock.join('\n'));
  }

  // Strip any stale import lines that leaked into body (prevents duplicate imports)
  const cleanedBodyLines = bodyLines.filter(line => {
    const t = line.trim();
    return !t.startsWith('import ') && !t.startsWith("'use client'") && !t.startsWith('"use client"');
  });
  let body = cleanedBodyLines.join('\n');

  // Self-heal `motion.<UpperCase>` → `<UpperCase>`. Earlier versions of
  // the generator unconditionally wrapped every node added to a component
  // file with `motion.*` for FLIP animations — but framer-motion's
  // `motion` proxy only knows HTML tag names. `motion.MyCard` evaluates
  // to undefined and silently breaks the JSX. The generator now skips
  // the prefix for component-instance tags, but existing source files
  // can still have the broken pattern. This pass strips it on the next
  // flush so the file self-heals without manual editing.
  body = body
    .replace(/<motion\.([A-Z][A-Za-z0-9]*)/g, '<$1')
    .replace(/<\/motion\.([A-Z][A-Za-z0-9]*)>/g, '</$1>');

  // Lowercased-component self-heal. An older bug in `updateMotionPropInCode`
  // converted PascalCase instance tags via `tagName.toLowerCase()`, so a
  // file could contain `<motion.mojiba>` where the original component is
  // imported as `MoJiBa`. The simple `[A-Z]…` pass above won't match the
  // lowercased form. Recover by scanning the import block for the original
  // component names and remapping any `motion.<lowercased-name>` back.
  const importedComponentNames: string[] = [];
  for (const line of importLines) {
    const def = line.match(/import\s+([A-Z][A-Za-z0-9]*)\s+from\s+['"]@\/components\//);
    if (def) importedComponentNames.push(def[1]);
  }
  for (const name of importedComponentNames) {
    const lower = name.toLowerCase();
    if (lower === name) continue; // not actually mixed-case
    const openRe = new RegExp(`<motion\\.${lower}\\b`, 'g');
    const closeRe = new RegExp(`</motion\\.${lower}>`, 'g');
    body = body.replace(openRe, `<${name}`).replace(closeRe, `</${name}>`);
  }

  // `<MotionLink>` needs its `const MotionLink = motion.create(Link);` at module
  // scope or it's undefined at runtime (visible after PASTING MotionLink markup,
  // or hand-editing it in — convertToMotionLink injects the const itself, but a
  // raw paste/edit doesn't). Self-heal it here so EVERY import-affecting action
  // that surfaces a MotionLink also declares it. Injected into `body` BEFORE
  // buildAutoImports(body) runs so `motion.create` → `import { motion }` and
  // `MotionLink` → `import Link from 'next/link'` are both detected below.
  let injectedMotionLinkConst = false;
  if (/<MotionLink\b/.test(body) && !/\bconst\s+MotionLink\s*=\s*motion\.create\(\s*Link\s*\)/.test(body)) {
    body = `const MotionLink = motion.create(Link);\n${body}`;
    injectedMotionLinkConst = true;
    trace.action('syncImports:inject-motionlink-const', {});
  }

  // Build new import block: framework imports (React/framer-motion/
  // next) come from the shared {@link buildAutoImports} helper, then we
  // append `'use client'` + leading block comments + preserved component
  // imports. The framework import detection is shared with the one-shot
  // template script (`scripts/add-template-imports.mjs`) so the templates
  // pre-bake the same import shape `syncImports` would emit on first flush.
  const newImports: string[] = ["'use client';", ''];

  // Preserve top-of-file annotation blocks (`/** @canvas */`, `/** @pageVariables */`,
  // and any other JSDoc-style block comments the page generator may add later).
  // They sit between `'use client'` and the imports so a later parse pass can
  // pick them up via the existing canvas-config / page-variables regexes.
  for (const block of blockComments) {
    newImports.push(block);
  }
  if (blockComments.length > 0) newImports.push('');

  for (const line of _buildAutoImports(body)) {
    newImports.push(line);
  }

  // Preserve any existing imports we don't manage (custom component imports, etc.)
  // Track which component default-import names are already imported so we
  // don't duplicate when auto-injecting below.
  const existingComponentImports = new Set<string>();
  for (const line of importLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('import ') &&
        !trimmed.includes("from 'react'") &&
        !trimmed.includes('from "react"') &&

        !trimmed.includes("from 'framer-motion'") &&
        !trimmed.includes('from "framer-motion"') &&
        !trimmed.includes("from 'next/link'") &&
        !trimmed.includes('from "next/link"') &&
        !trimmed.includes("from 'next/image'") &&
        !trimmed.includes('from "next/image"') &&
        // `@revyme/runtime` is owned by `buildAutoImports` (it scans the
        // body for `withResponsiveProps` / `useStaticCanvas` /
        // `playSketchDraw` and emits the import line). Preserving the
        // existing line here ALSO would emit it twice — duplicate
        // imports break TypeScript / SWC. Drop it from the custom-import
        // pass and let buildAutoImports own it.
        !trimmed.includes("from '@revyme/runtime'") &&
        !trimmed.includes('from "@revyme/runtime"')) {
      // Wrong-directory detection: drop imports that point at the
      // wrong folder when we can prove (by reading projectFS) that the
      // file lives in a sibling folder — components/ vs icons/, so each
      // direction needs its own check. Without these, a stale
      // `@/components/Foo` import for what's actually an icon set
      // sticks around forever and crashes the live runtime when the
      // resolver fails to find `components/Foo`.
      const compMisroute = trimmed.match(/^import\s+\w+\s+from\s+['"]@\/components\/(\w+)['"]/);
      if (compMisroute) {
        const baseName = compMisroute[1];
        const inComponents = projectFS.readFile(`components/${baseName}.tsx`) != null;
        const inIcons = projectFS.readFile(`icons/${baseName}.tsx`) != null;
        if (!inComponents && inIcons) continue; // skip — auto-inject below will rewrite
      }
      const iconMisroute = trimmed.match(/^import\s+\w+\s+from\s+['"]@\/icons\/(\w+)['"]/);
      if (iconMisroute) {
        const baseName = iconMisroute[1];
        const inIcons = projectFS.readFile(`icons/${baseName}.tsx`) != null;
        const inComponents = projectFS.readFile(`components/${baseName}.tsx`) != null;
        if (!inIcons && inComponents) continue;
      }
      // Capture the default-import name from `@/components/X` AND
      // `@/icons/X` so we don't duplicate on the auto-inject pass.
      const compM = trimmed.match(/^import\s+(\w+)\s+from\s+['"]@\/(?:components|icons)\/[^'"]+['"]/);
      if (compM) {
        const name = compM[1];
        // PRUNE a component / icon / sketch import whose instance is no longer
        // in the body — e.g. the user deleted every `<Foo/>` (incl. ones in the
        // `canvasNodes` fragment, which is part of `body`). Without this the
        // import lingers as dead code after a delete-all. Whole-word match so
        // `Foo` isn't matched inside `FooBar`; matching ANY reference (not just
        // a JSX tag) is intentional — keeping a still-referenced import is the
        // safe direction, and component names never appear in data-ids/selectors.
        if (!new RegExp(`\\b${name}\\b`).test(body)) {
          trace.action('syncImports:prune-unused-component-import', { name });
          continue;
        }
        existingComponentImports.add(name);
      }
      // Register the default-import NAME of every other kept import too —
      // CDN URL imports above all (`import Marquee from "https://assets…"`,
      // the cross-project linked-component path). Without this the
      // auto-inject pass below doesn't know the tag is satisfied, lazy-
      // installs the same-named built-in into components/ and emits a
      // SECOND `import Marquee from '@/components/Marquee'` — a duplicate-
      // identifier SyntaxError that kills the whole page module (blank
      // canvas, no surfaced error).
      if (!compM) {
        const anyDefault = trimmed.match(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]/);
        if (anyDefault) existingComponentImports.add(anyDefault[1]);
      }
      newImports.push(trimmed);
    }
  }

  // Auto-inject `import X from '@/components/X'` (or `@/icons/X` for icon
  // sets) for any uppercase JSX tag in the body that matches a known file.
  // Lets toolbar-drag of an embed Code component or icon-set drop a `<YouTubeEmbed/>`
  // / `<XiSuWo/>` instance and have the import added on the next flush —
  // without this, syncImports only PRESERVES existing imports, never adds
  // new ones.
  const FRAMEWORK_TAGS = new Set([
    'Link', 'Image', 'Fragment', 'AnimatePresence', 'MotionConfig', 'LayoutGroup',
    'React', 'Suspense',
    // `MotionLink` is a local `const MotionLink = motion.create(Link)` — NOT a
    // `@/components/MotionLink` file. Excluding it stops the auto-import pass
    // from emitting a bogus component import for it.
    'MotionLink',
  ]);
  // Match `<UpperCase` opening tags. Skip motion.* tags (framer-motion).
  const tagRegex = /<([A-Z][a-zA-Z0-9]*)\b/g;
  const usedTags = new Set<string>();
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(body)) !== null) {
    const name = tagMatch[1];
    if (!FRAMEWORK_TAGS.has(name)) usedTags.add(name);
  }
  for (const name of usedTags) {
    if (existingComponentImports.has(name)) continue;
    // Try to lazy-install a built-in code component first (AI generation, paste,
    // manual code edits — anything that surfaces a known PascalCase tag
    // without going through ToolbarDragStrategy.onEnd's install hook). No-op
    // for tags not in the registry.
    installBuiltInCodeComponent(projectFS, name);
    // Probe candidate locations. Order matters — `icons/`
    // is checked BEFORE `components/` even though the latter is the
    // most common case, because we've seen `installBuiltInCodeComponent` /
    // older flows leave phantom `components/X.tsx` entries that
    // outlive the user's actual file. With components-first, those
    // phantoms hijacked the import for what's really an icon
    // and the live runtime then failed to resolve. Icon-set files
    // are write-once (created via LibraryPanel `+`); when one exists
    // it's the source of truth.
    const inComp = projectFS.readFile(`components/${name}.tsx`) != null;
    const inIcons = projectFS.readFile(`icons/${name}.tsx`) != null;
    trace.action('syncImports:probe', { name, inComp, inIcons });
    if (inIcons) {
      newImports.push(`import ${name} from '@/icons/${name}';`);
      existingComponentImports.add(name);
    } else if (inComp) {
      newImports.push(`import ${name} from '@/components/${name}';`);
      existingComponentImports.add(name);
    }
  }

  newImports.push('');
  const newImportBlock = newImports.join('\n') + '\n';
  const oldImportBlock = importLines.join('\n') + '\n';

  // Only rewrite if imports actually changed (avoid unnecessary code churn) —
  // unless we injected the MotionLink const into the body, which must be written
  // out even when the import block itself is unchanged (Link/motion already
  // imported for other uses, but the const was still missing).
  if (newImportBlock.trim() === oldImportBlock.trim() && !injectedMotionLinkConst) return code;

  return newImportBlock + body;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return; // already scheduled
  flushTimer = requestAnimationFrame(() => {
    flushTimer = null;
    processQueue();
  });
}

// RAF-poll the deferred scroll-anim regens: hold them while the user is still
// dragging (`canvasInteractingAtom` true), then re-queue + flush ONCE the drag
// ends. No atom subscription needed — the slider flips the atom off on release.
function pumpDeferredAnim(): void {
  animPumpRaf = null;
  if (deferredAnim.length === 0) return;
  if (getDefaultStore().get(canvasInteractingAtom)) {
    animPumpRaf = requestAnimationFrame(pumpDeferredAnim);  // still dragging — re-check next frame
    return;
  }
  queue.push(...deferredAnim.splice(0));  // released — apply the latest spec(s) now
  scheduleFlush();
}

// Re-apply glide to any parent a node was just inserted INTO (move / addNode), so
// the newcomer becomes a glide-item (motion.div data-glide-item layout) and slides
// with its siblings. Without it, a drag-in lands a plain child OUTSIDE the
// LayoutGroup and the glide skips it (the user's manual workaround was remove+re-add
// glide; setGlideInCode is idempotent — remove + re-wrap ALL children — so this IS
// exactly that). Run as a post-step on the FINAL code so it never disturbs the
// per-mutation CMS / scroll / overlay rehydration inside applyMutation.
// Collapse redundant `move` mutations. A drag that crosses frame boundaries
// several times (entry → exit → entry …) queues one `move` PER transition,
// but they're gated during the drag and all drain on mouseup — so a single
// drop can run moveNodeInCode 3+ times, each re-homing the node and (for
// exit-to-canvas) taking the slow AST path. Only the LAST move per node
// decides its final home; the earlier ones are superseded. Their non-move
// side mutations (clearContainerStyles / updateHtmlAttrs — all parent-
// INDEPENDENT) stay untouched. Big drop-settle win on a big page.
/** @internal Exported for testing. */
export function coalesceMoves(mutations: Mutation[]): Mutation[] {
  const lastMove = new Map<string, number>();
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.type === 'move') lastMove.set(m.nodeId, i);
  }
  if (lastMove.size === 0) return mutations;

  // CARRY THE SUPERSEDED MOVES' STYLES ONTO THE SURVIVOR.
  //
  // Only the LAST move per node runs — the destination is whatever the gesture
  // ended on. But a move's `styles` are not positional noise: they are the
  // commit's CLEANUP, and dropping the mutation dropped them silently.
  //
  // Drag a replica-only node OUT to the canvas and INTO the primary in one
  // gesture and the queue holds two moves: exit→canvas (carrying the styles
  // that undo the replica-solo hide) and enter→root. The queue is HELD for the
  // whole drag, so both are still pending at drop, the exit move is dropped as
  // superseded, and its `display: ''` goes with it — the node landed under the
  // right parent, at the right position, still `display: none` (user report
  // 2026-08-09). Starting the same drag from the canvas works because there is
  // no earlier move to discard.
  //
  // Earlier styles are a BASE; the surviving move's own styles win on conflict,
  // so the final position is unchanged.
  const carried = new Map<string, Record<string, string>>();
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.type !== 'move' || lastMove.get(m.nodeId) === i || !m.styles) continue;
    carried.set(m.nodeId, { ...(carried.get(m.nodeId) ?? {}), ...m.styles });
  }

  const out = mutations
    .filter((m, i) => m.type !== 'move' || lastMove.get(m.nodeId) === i)
    .map((m) => {
      if (m.type !== 'move') return m;
      const base = carried.get(m.nodeId);
      return base ? { ...m, styles: { ...base, ...(m.styles ?? {}) } } : m;
    });
  if (out.length !== mutations.length) {
    trace.action('mutation-queue:coalesced-moves', {
      before: mutations.length, after: out.length, carriedStyles: [...carried.keys()],
    });
  }
  return out;
}

function reglideInsertedParents(code: string, mutations: Mutation[]): string {
  for (const m of mutations) {
    const pid = m.type === 'move' ? m.newParentId : m.type === 'addNode' ? m.parentId : null;
    if (pid && hasGlide(code, pid)) {
      const spec = getGlide(code, pid);
      if (spec) code = setGlideInCode(code, pid, spec);
    }
  }
  return code;
}

function processQueue(): void {
  // New flush cycle — drop the previous cycle's force-render latch.
  _forceRenderThisFlush = false;
  if (queue.length === 0) return;
  if (isProcessing) return;
  // ELEMENT-DRAG GATE: while a canvas element drag is live, HOLD the queue.
  // Transition commits (enter/exit reparent) queue their mutations but the
  // string pipeline (moveNodeInCode + heal passes ≈ 140ms on a 470KB page)
  // must not run mid-gesture — the strategies keep the node cache + sandbox
  // DOM correct imperatively, and DragCoordinator.reset() drains everything
  // with ONE flushNow() at drop (single applyMutation chain → single parse →
  // single React fan-out). flushNow() bypasses this gate by design (drop
  // drain + the replica-clone path that needs a mid-drag pipeline).
  if (dragStateOps.get()) {
    trace.action('mutation-queue:held-during-drag', { queued: queue.length });
    return;
  }

  isProcessing = true;
  // Hand the queued mutation TYPES to the pre-flush hook — the lifecycle
  // uses them to decide whether the post-flush render may be skipped
  // (container-style mutations rebuild render-time @container CSS, so their
  // render must NOT be marked away — the "reset override only applies after
  // a page switch" bug, 2026-07-19).
  onBeforeFlush?.(queue.map((m) => m.type));

  let mutations = coalesceMoves(queue.splice(0)); // take all queued mutations, collapse redundant moves

  // FPS: while a slider/drag is live, peel off `updateScrollAnim` regens (each
  // reparses the whole file + cascades a full re-render — death at 60 ticks/sec).
  // Hold the latest per node in `deferredScroll`, RAF-flush on release. Every
  // other mutation still applies live. Entirely no-op when not interacting.
  if (getDefaultStore().get(canvasInteractingAtom) && mutations.some(m => DEFERRABLE_ANIM_TYPES.has(m.type))) {
    const live: Mutation[] = [];
    for (const m of mutations) {
      if (DEFERRABLE_ANIM_TYPES.has(m.type)) {
        const key = animCoalesceKey(m);
        deferredAnim = deferredAnim.filter(d => animCoalesceKey(d) !== key);
        deferredAnim.push(m);
      } else live.push(m);
    }
    if (animPumpRaf === null) animPumpRaf = requestAnimationFrame(pumpDeferredAnim);
    mutations = live;
    if (mutations.length === 0) { isProcessing = false; onAfterFlush?.(); return; }
  }
  const t0 = performance.now();

  trace.action('mutation-queue:process', { count: mutations.length });

  // Apply mutations to the code string
  let code = healDuplicateLayoutAttrs(currentCode);
  for (const m of mutations) {
    code = applyMutation(code, m);
  }
  // globals.css side-effect writes are committed at this point regardless of
  // what validation below decides about the PAGE code — announce them.
  bumpVersionForGlobalsCssMutations(mutations);
  code = reglideInsertedParents(code, mutations);

  // Prune duplicate/orphan overlay elements (ghost from a canvas↔viewport
  // round-trip), THEN heal overlay runtime orphaned by a structural mutation
  // (before import sync).
  if (mutations.some(m => OVERLAY_STRUCTURAL_TYPES.has(m.type))) {
    code = stripOverlaysNestedInOverlaysInCode(code);
    code = liftNestedCanvasOverlaysToRoot(code);
    code = pruneOverlayDuplicatesInCode(code);
    code = healDanglingOverlayState(code);
    code = healMissingOverlayEffectsInCode(code);
    code = healUnwrappedOverlayInCode(code);
    // LAST — the wrapper must be whole before the block can be relocated.
    code = healMisplacedOverlayInCode(code);
  }

  // Sync imports — only when mutations might change what's imported
  // (not for pure style/position/text changes which are the hot path)
  const needsImportSync = mutations.some(m => IMPORT_AFFECTING_TYPES.has(m.type));
  if (needsImportSync) {
    code = syncImports(code);
  }

  const duration = performance.now() - t0;
  trace.action('mutation-queue:applied', { duration: `${duration.toFixed(1)}ms`, mutations: mutations.length });

  // Skip code validation when mutations didn't actually modify the code
  // string. Preset / design-token / map-data / file-write mutations write
  // to ProjectFS without touching the page code; running babel parse on
  // every preset color-picker tick is enough to drop framerate during the
  // drag. The page code can't have become invalid if no character changed.
  const codeChanged = code !== currentCode;
  // SELF-HEAL a dangling `{item.field}` TEXT child stranded in `canvasNodes` (e.g. a
  // CMS element dragged out of a paginated list before the iterator-detection fix) →
  // dormantize it (placeholder + Missing) so it stops blocking EVERY later mutation.
  if (codeChanged && code.indexOf('const canvasNodes') !== -1) {
    code = healDanglingCanvasNodeBindings(code);
    // A whole <form> dragged onto the canvas carries onSubmit + FormSubmit
    // initialVariant + responsive-attr __mq gates that reference page-fn vars
    // out of scope in module-scope canvasNodes → dormantize them (no crash).
    code = dormantizeFormBindingsInCanvas(code);
    // A search field / dynamic CMS filter pasted onto the canvas references a
    // page useState var (searchX) at module scope → "searchX is not defined".
    code = dormantizePageVarBindingsInCanvas(code);
  }
  // A Search Field pasted into a VIEWPORT of a page that doesn't declare its var
  // → undeclared `searchX` ref → crash. Neutralize the MISSING ones everywhere
  // (page tree, not just canvasNodes); the marker stays so the tool shows "Missing".
  if (codeChanged) code = neutralizeMissingSearchFieldsInCode(code);
  // SELF-HEAL an orphaned Form Submit `initialVariant={formState<X> === …}` whose
  // lifecycle useState is gone (instance dragged out of its form) → strip the
  // dangling binding so it stops blocking every later mutation. Keeps the spec.
  if (codeChanged) {
    code = healOrphanedFormStateBindings(code);
    // Re-declare a formState<X> that's referenced (onSubmit setter / FormSubmit
    // binding) but undeclared in its function — e.g. a form made into a component
    // whose lifecycle useState stayed in the page. Heals the active file (page or
    // master). No-op when every referenced var is already declared.
    code = healMissingFormStateDeclarations(code);
    // ROOT-CAUSE HEAL for the sticky-residue class (mirrors the flushNow hook):
    // re-seed every sparse variant default so pre-CSS_NEUTRAL_FALLBACK
    // components repair on ANY edit — the user can't know WHICH node carries
    // `default: {}`. Scan-only no-op when healthy; validate-or-revert inside.
    code = healSparseVariantDefaults(code);
    // Drop a variant-entry SHORTHAND stranded behind its own longhands — applied
    // in key order it nullifies every side, so the entry paints as zero.
    code = healStrandedVariantShorthands(code);
    // Converge drift-era stray @media bands onto the page's @canvas viewport
    // keys (mirrors the flushNow hook; cheap gate inside).
    code = normalizeResponsiveBandKeys(code);
    code = healDanglingModuleJsxInCode(code);
    // Repair `[data-id="…" someAttr={…}]::after` — a JSX attribute spliced into
    // a <style> selector by a generator that located the node with a raw
    // indexOf. Kills the CSS rule AND means the intended write never landed.
    code = healStyleBlockSelectorAttrsInCode(code);
    // Repair event handlers that transition between variants `connections` has
    // no edge for. Such a handler is INVISIBLE — the Interactions panel reads
    // `connections`, so it shows nothing to remove while the runtime still
    // fires. Scan-only no-op when every transition is backed.
    code = healDriftedConnectionHandlersInCode(code);
  }
  const validationError = codeChanged ? validateGeneratedCode(code) : null;
  if (validationError) {
    const detail: MutationErrorDetail = {
      message: validationError,
      mutationTypes: mutations.map(m => m.type),
      codeExcerpt: extractCodeExcerpt(code, validationError),
    };
    trace.error('mutation-queue:validation-failed', { error: validationError, mutationTypes: detail.mutationTypes });
    onError?.(detail);
    isProcessing = false;
    onAfterFlush?.();
    return;
  }

  // Update our local reference
  currentCode = code;

  // Flush to the store (this triggers React re-render, Monaco update, etc.)
  // Use requestIdleCallback WITH A TIMEOUT so it doesn't block the next
  // interaction in the common case but still fires promptly when the browser
  // is busy. Without the timeout, dropping a node from the Insert panel
  // could stall up to ~1s: the selection overlay's RAF poll (waiting for the
  // new node's corners to appear in the cache) keeps the event loop busy
  // every 4ms, requestIdleCallback never finds an idle slot, the file write
  // is delayed, the canvas re-render is delayed, and the new node only
  // appears once the deadlock resolves. A 16ms (~1 frame) timeout caps the
  // deferral so the file write always lands within a frame, breaking the
  // deadlock while still letting the browser breathe between flushes.
  const doFlush = () => {
    idleCallbackId = null;
    onFlush?.(code);
    onAfterFlush?.();
    isProcessing = false;

    // If more mutations queued while we were processing, process them too
    if (queue.length > 0) scheduleFlush();
  };

  if (typeof requestIdleCallback !== 'undefined') {
    idleCallbackId = requestIdleCallback(doFlush, { timeout: 16 });
  } else {
    setTimeout(doFlush, 0);
  }
}

/** Read every configured viewport's width from the page's `@canvas` block.
 *  Used by the text-override mutations so the runtime hook gets a current
 *  viewport-widths list as its third argument — the bucket lookup needs it
 *  to distinguish "tablet override at 768" from "every width <= 768 uses the
 *  tablet text". */
function readAllViewportWidths(code: string): number[] {
  const config = parseCanvasConfig(code);
  const viewports = config?.viewports?.length ? config.viewports : DEFAULT_VIEWPORTS;
  return viewports
    .map((v) => v.width)
    .filter((w) => Number.isFinite(w) && w > 0);
}

// Scroll effects (the reference model): when multiple effects share a property they're
// composed into ONE native element, with the separate-form params kept in
// `data-scroll-fx`. Generators only understand the SEPARATE form, so any mutation
// that touches a scroll/appear effect DECOMPOSES the file first (restores the
// separate whileInView/animate/bindings), applies the edit on that form, then
// RECOMPOSES every node that's (still) conflicting — re-emitting a fresh
// data-scroll-fx. Both passes are fast-path guarded (decompose needs the combined
// `= useMotionValue(` reveal; compose needs `(whileInView|animate=) && useScroll`),
// so non-scroll mutations and single-effect nodes pay almost nothing.
const SCROLL_MUTATION_TYPES = new Set<Mutation['type']>([
  'updateScrollAnim', 'removeScrollAnim', 'updateScrollDirection', 'removeScrollDirection',
  'updateScrollSpeed', 'removeScrollSpeed', 'removeScrollSpeedScopeBranch', 'updateLoop', 'removeLoop',
]);
// Appear is written as updateMotionProp/removeMotionProp on these props — they
// form the discrete driver that conflicts with a scrubbed transform. `transition`
// is included so editing the Appear's spring on a COMBINED node round-trips: the
// combined form keeps it inside `animate(Appear, 1, {…})` (no tag `transition=`),
// so the edit must decompose (restoring `transition={{…}}`), apply, recompose. On
// a non-combined node both passes are no-ops, so hover/tap transitions are
// unaffected.
// whileHover/whileTap are included so adding/editing a gesture that shares a prop
// with a scroll motion value (e.g. hover scale vs a scrubbed-transform scale) gets
// folded into that motion value — a style MotionValue overrides a declarative
// whileHover on the same prop, so they must be composed to blend.
// (The Loop has its OWN carrier `data-loop` via updateLoop/removeLoop above — it does
// NOT use the `animate` prop, which would collide with a direction Scroll Animation.)
const APPEAR_PROP_NAMES = new Set(['whileInView', 'initial', 'viewport', 'transition', 'whileHover', 'whileTap']);

function mutationAffectsScroll(mutation: Mutation): boolean {
  if (SCROLL_MUTATION_TYPES.has(mutation.type)) return true;
  if ((mutation.type === 'updateMotionProp' || mutation.type === 'removeMotionProp')
      && APPEAR_PROP_NAMES.has((mutation as any).propName)) return true;
  return false;
}

/** SELF-HEAL duplicate `layout={true}` attributes. An older nested
 *  make-component pass blanket-added `layout={true}` after every `<motion.*`
 *  without checking whether the extracted subtree ALREADY carried one
 *  (nesting a master's content into a new master), so files ended up with
 *  `<motion.div layout={true} layout={true} …>` — and once corrupted, the
 *  duplicate-attribute validator blocked EVERY subsequent mutation on the
 *  file (live find 2026-07-13: resizing a nested cross component errored
 *  forever). Identical duplicates merge losslessly; runs on the batch's BASE
 *  code so the output validates clean. */
function healDuplicateLayoutAttrs(code: string): string {
  if (!code.includes('layout={true}')) return code;
  const healed = code.replace(/layout=\{true\}(\s+layout=\{true\})+/g, 'layout={true}');
  if (healed !== code) trace.action('mutation-queue:healed-duplicate-layout', {});
  return healed;
}

function applyMutation(code: string, mutation: Mutation): string {
  if (!mutationAffectsScroll(mutation)) return applyMutationCore(code, mutation);
  // Decompose → apply on the separate form → recompose conflicts. This is what
  // makes stacking effects "just work" like the reference: adding a 2nd effect that
  // shares a property auto-combines into one element; editing/removing on a
  // combined node round-trips through the separate form transparently.
  const decomposed = decomposeAllScrollConflicts(code);
  const applied = applyMutationCore(decomposed, mutation);
  return composeAllScrollAppearConflicts(applied);
}

function applyMutationCore(code: string, mutation: Mutation): string {
  // Guard: layout-prefixed and placeholder nodes should never be mutated —
  // they live in the TEMPLATE file, not this page, so editing them here would
  // no-op or corrupt. EXCEPTION: `updateContainerStyle`/`clearContainerStyles`
  // write a page-LOCAL `@media { [data-id="…"] { … } }` rule keyed by a SELECTOR
  // (not a source-node edit), which is valid even for a `layout::` id. That's the
  // templated-page REPLICA reorder BRACKET — a page-local order override that
  // keeps the template's Header/CTA/Footer slotted on the flattened canvas merge
  // (dead no-op in the deployed page). See LayoutLiftedStrategy / order-commit.
  const nodeId = (mutation as any).nodeId;
  const isPageLocalContainerStyle = mutation.type === 'updateContainerStyle' || mutation.type === 'clearContainerStyles';
  if (nodeId && (nodeId.startsWith('layout::') || nodeId === 'children-slot') && !isPageLocalContainerStyle) {
    trace.error('mutation:skip-layout-node', { type: mutation.type, nodeId });
    return code;
  }

  try {
    switch (mutation.type) {
      case 'updateStyles': {
        let out = updateNodeInCode(code, mutation.nodeId, mutation.styles);
        // On an OVERLAY, a transform edit (rotate/scale/skew) must be mirrored into
        // its framer-motion initial/animate/exit so it survives the enter/exit
        // animation — `updateNodeInCode` only puts it in `style` (which motion
        // composes away). No-op for non-overlay nodes (early-returns inside).
        const s = mutation.styles as Record<string, unknown>;
        if ('transform' in s || 'rotate' in s || 'scale' in s || 'scaleX' in s || 'scaleY' in s || 'skewX' in s || 'skewY' in s) {
          out = syncOverlayAppearTransformInCode(out, mutation.nodeId);
        }
        // Setting a component INSTANCE to position:fixed/sticky self-heals THAT
        // component's root with the conditional `layoutScroll` (Motion's fixed-element
        // scroll-boundary fix) if it's missing — so an EXISTING fixed component (e.g.
        // the Header) stops "sliding in" on navigation just by being set fixed, without
        // editing the instance. It also UN-WRAPS any leftover `data-fixed-shell` child
        // div from earlier abandoned attempts, reverting the root to the simple form.
        // Components are created relative (plain layout={true}); this is the only path
        // that adds the fix — covering the absolute→fixed transition + legacy headers.
        if (s.position === 'fixed' || s.position === 'sticky') {
          const idIdx = out.indexOf(`data-id="${mutation.nodeId}"`);
          if (idIdx !== -1) {
            const tagStart = out.lastIndexOf('<', idIdx);
            const tagName = tagStart !== -1 ? (/^<([A-Za-z][\w.]*)/.exec(out.slice(tagStart))?.[1]) : undefined;
            // Only DESIGN-component instances — a PascalCase tag with a file in components/.
            if (tagName && /^[A-Z]/.test(tagName)) {
              const compFile = `components/${tagName}.tsx`;
              const compCode = projectFS.readFile(compFile);
              if (compCode) {
                const healed = ensureLayoutRootOnComponentRoot(compCode);
                if (healed !== compCode) {
                  projectFS.writeFile(compFile, healed);
                  trace.action('mutation:layout-root-injected', { nodeId: mutation.nodeId, tagName, compFile });
                }
              }
            }
          }
        }
        return out;
      }

      case 'updateContainerStyle':
        return updateContainerQueryStyle(code, mutation.nodeId, mutation.maxWidth, mutation.styles);

      case 'clearContainerStyles':
        return clearContainerStylesForNode(code, mutation.nodeId);

      case 'stripPositionalTileOverrides':
        // Both run: a file is one or the other, and each is a no-op when its
        // channel isn't present. Cheaper than asking which kind of file it is.
        return stripPositionalVariantStyles(
          stripPositionalContainerStyles(code, mutation.nodeId),
          mutation.nodeId,
        );

      case 'addNode': {
        let next = addNodeInCode(code, mutation.parentId, mutation.node, mutation.index);
        // CMS field auto-bind: a drop from the Insert > CMS > Fields panel
        // carries a `data-cms-field="<slug>:<fieldId>"` hint. If it lands
        // inside a `.map(…)` ancestor we rewrite its text to the iterator
        // expression in the SAME flush — no follow-up commit, the JSX
        // lands already-bound. If there's no enclosing map the hint stays
        // (placeholder text) until the user wraps a parent later.
        if (mutation.node.attrs && mutation.node.attrs['data-cms-field']) {
          next = bindCmsFieldOnDropInCode(next, mutation.node.id);
        }
        // CMS prev/next nav-link drop: rewrite its href to resolve the
        // adjacent detail-page item from the collection order.
        if (mutation.node.attrs && mutation.node.attrs['data-cms-nav']) {
          next = bindCmsNavLinkOnDropInCode(next, mutation.node.id);
        }
        // Form drop: attach the onSubmit handler so the published form posts
        // to /api/form (the relay → Forms Worker), and swap the submit <button>
        // for a <FormSubmit> multi-variant component instance (design-tool parity:
        // default/hover/pressed/loading/disabled/success/error + the Form State
        // tool). The instance's `initialVariant` binds the form's `formState<Id>`
        // lifecycle var the onSubmit drives. Materialize the relay route +
        // FormSubmit/Spinner masters so they ship with publish AND export.
        // Wrapped so a file-write hiccup can NEVER discard the code conversion.
        // Recursive: wire EVERY <form> in the added subtree, not only a
        // top-level one — a dropped SECTION (e.g. a plugin "Contact" layout)
        // contains its form NESTED inside, so a top-level-only check missed it
        // and the form stayed inert.
        {
          const formIds: string[] = [];
          const collectForms = (n: { type?: string; id?: string; children?: unknown[] } | null | undefined): void => {
            if (!n) return;
            if (n.type === 'form' && typeof n.id === 'string') formIds.push(n.id);
            (n.children as typeof n[] | undefined)?.forEach(collectForms);
          };
          collectForms(mutation.node);
          for (const fid of formIds) {
            trace.action('mutation:form-drop-wire', { formId: fid });
            const stateVar = formStateVar(fid);
            next = wireFormSubmitInCode(next, fid, formStateSetter(stateVar));
            next = convertSubmitButtonInCode(next, fid, stateVar);
          }
          if (formIds.length) {
            try {
              ensureFormRouteFile();
              ensureFormSubmitSpinnerFile();
              ensureFormSubmitComponentFile();
            } catch (e) {
              trace.error('mutation:form-ensure-files', { error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
        return next;
      }

      case 'addCanvasNode': {
        let next = addCanvasNodeInCode(code, mutation.node);
        // Form dropped on the CANVAS (floating, outside any viewport): still
        // swap the submit <button> for a <FormSubmit> instance so it reads as a
        // component on the canvas. No lifecycle wiring — canvas nodes live in a
        // module-scope `const canvasNodes = (<>…</>)` fragment that can't hold a
        // useState — so the instance renders its static `default` variant.
        {
          const formIds: string[] = [];
          const collectForms = (n: { type?: string; id?: string; children?: unknown[] } | null | undefined): void => {
            if (!n) return;
            if (n.type === 'form' && typeof n.id === 'string') formIds.push(n.id);
            (n.children as typeof n[] | undefined)?.forEach(collectForms);
          };
          collectForms(mutation.node);
          for (const fid of formIds) {
            trace.action('mutation:form-canvas-drop-wire', { formId: fid });
            next = convertSubmitButtonInCode(next, fid, formStateVar(fid), { wireFormState: false });
          }
          if (formIds.length) {
            try {
              ensureFormSubmitSpinnerFile();
              ensureFormSubmitComponentFile();
            } catch (e) {
              trace.error('mutation:form-canvas-ensure-files', { error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
        return next;
      }

      case 'reorder':
        return reorderNodeInCode(code, mutation.nodeId, mutation.parentId, mutation.index);

      case 'duplicateCollectionToCanvas':
        // Replica drag-out clone of a CMS collection list — COPY the literal
        // `.map()` subtree into `canvasNodes` (map + `item.*` bindings preserved),
        // leaving the original in the page (hidden on the source replica by the
        // paired setConditionalStyle/updateContainerStyle from hideInThis).
        return duplicateCollectionListToCanvasInCode(code, mutation.nodeId, mutation.source, mutation.suffix, mutation.styles);

      case 'move': {
        // Auto-disconnect slot wiring before the move. A slot-hoisted
        // canvas node lives as `const cn_<id> = <jsx/>` and is referenced
        // by every component slot it's wired into. Reparent/unparent
        // doesn't compose with that — `moveNodeInCode` walks JSX for the
        // node's current position, finds it INSIDE a hoisted const (not
        // inside any visible parent), and the resulting move either
        // no-ops or produces broken output (visible symptom: the user
        // drags a slot-connected canvas node into a normal frame and it
        // visually offsets / doesn't re-parent; the slot wiring also
        // sticks around).
        //
        // The right semantics, as the user described: any reparent or
        // unparent of a slot-connected canvas node auto-disconnects it
        // from every slot it's wired into and inlines it back to
        // `canvasNodes` first. Then the regular move applies to a
        // now-inline canvas node — same path as any other free-floating
        // node. `disconnectSlotInCode` re-inlines on the LAST disconnect,
        // so a loop over every connection completes the un-hoist.
        let nextCode = code;
        // CMS bindings are SCOPED to the iterator of the `.map()` the node lives
        // in. Capture it BEFORE the move so we can tell, after, whether the node
        // left that scope (→ dormantize its `item.*` prop bindings to avoid an
        // "undefined identifier: item" crash) or entered a new one (→ rehydrate).
        const srcMapIter = getEnclosingMapIteratorForNode(code, mutation.nodeId);
        // Resolve the CMS row this node DISPLAYS before the move rips it out of
        // its `.map()` — post-move neither the code nor the node cache can say
        // which collection row it came from. Used below to bake real values
        // over the dormantized placeholders when the node leaves map scope.
        const srcCmsRow = srcMapIter ? resolveCmsRowForNodeInCode(code, mutation.nodeId) : null;
        const conns = getAllSlotConnections(nextCode);
        for (const [compId, childIds] of conns) {
          if (childIds.includes(mutation.nodeId)) {
            nextCode = disconnectSlotInCode(nextCode, compId, mutation.nodeId);
          }
        }
        // Scroll Variant is PAGE-LEVEL: `const [<id>Sv] = useState(...)` hooks in the component
        // body + an `initialVariant={<id>Sv}` binding. Moving the instance INTO `canvasNodes`
        // (module scope, no hooks) would leave that binding referencing an out-of-scope var →
        // "undefined identifier" crash. DORMANTIZE on exit (strip hooks + bind a static resting
        // variant, KEEP the spec attr) and REHYDRATE on entry back into a viewport — the effect is
        // fully preserved through the round-trip (design-tool parity). No-op without a scroll variant.
        // Instance-fx (hover/tap/transform/loop/appear/speed) is PAGE-LEVEL the same way — its
        // motion values + `useEffect`/`useScroll` hooks live in the body and its
        // `style={{ scale: <id>FxCScale, … }}` bindings reference them — so it dormantizes/rehydrates
        // on the SAME boundary (else dragging an instance with effects out crashes identically).
        let moveStyles = mutation.styles;
        if (mutation.canvasNode) {
          nextCode = dormantizeScrollVariant(nextCode, mutation.nodeId);
          nextCode = dormantizeInstanceFx(nextCode, mutation.nodeId);
          // A Form Submit instance's `initialVariant={formState<Id> === …}` binds
          // a var declared in the form's component fn — module-scope canvasNodes
          // has no such var → crash. Strip the binding (keep `data-form-state`).
          nextCode = dormantizeFormStateBinding(nextCode, mutation.nodeId);
          // NORMAL nodes carry their scroll/motion compose as `data-scroll-fx` with page-level hooks
          // (useScroll/useTransform/useMotionValue/useEffect) bound into style + handlers + ref —
          // same module-scope crash as instance-fx. Dormantize it too (strip machinery, keep spec).
          nextCode = dormantizeScrollFx(nextCode, mutation.nodeId);
          // Component-variable bindings (text `{prop}` content / `key: prop` style /
          // `x={prop}` attr) → orphan form (default literal + data-var-orphan) so every
          // variable + its data type survives the move and re-binds on re-entry. MUST run
          // BEFORE moveNodeInCode — that fn bakes STYLE prop-refs to flat literals on
          // canvas exit (the inline-on-exit pass), which would otherwise erase a style
          // variable (e.g. `backgroundImage: image`) before it could be stashed. Text
          // content isn't baked there, which is why it survived without this ordering.
          // PER-VIEWPORT `__mq` gates (link/bool-nav per-tile vars) reference the component fn's local
          // `useMediaQuery` consts → undefined at module scope. Collapse them to base FIRST (canvas has no
          // viewport), so the orphan pass then sees a plain `{var}` ref it can stash in `data-var-orphan`.
          nextCode = resolveMediaGateTernariesInCode(nextCode, mutation.nodeId);
          nextCode = dormantizeComponentVarBindings(nextCode, mutation.nodeId);
          // A translated text node renders `{t('key')}`, and `t` is the component
          // fn's `useTranslations()` const — undefined at module scope, so the move
          // was rejected outright ("References undefined identifier: t"). Bake the
          // default-locale string and stash the key; re-entry restores the call.
          nextCode = dormantizeTranslationBinding(nextCode, mutation.nodeId, translationTextResolver());
          // Dormantize removed this node's motion-value hooks (`<cn>Fx…`), but the drag captured the
          // PARSED style map — whose transform serializes those bindings as
          // `transform: 'scale(var:<cn>FxCScale) rotate(var:<cn>FxLoopRotate)'`. Writing that now-dead
          // ref onto the dormant canvas node is invalid CSS the Renderer keeps reasserting every cycle,
          // which FREEZES the live drag (the element stops following the cursor until mouseup — the
          // user-reported "lags the moment of unparent"). Drop any captured style value that still
          // references this node's own fx motion values (`''` = remove property per the generator rule).
          if (moveStyles) moveStyles = stripDeadFxStyleRefs(moveStyles, mutation.nodeId);
          // PARENT-FLOW props die with the parent. A canvas node sits at module
          // scope with no flow parent, so `flex`/`order`/`align-self`/grid
          // placement have nothing to act on — yet a node dragged out of a flex
          // row kept `flex: '1 0 0px'`, a grow factor with nothing to grow in
          // (user report 2026-07-26). The strategies clear these on the mid-drag
          // LIFT styles but never on the committed exit styles, and there are
          // four `canvasNode: true` sites, so normalise HERE: every exit-to-canvas
          // — layout drag, absolute drag, grid drag, the menu command — funnels
          // through this one mutation. Source styles come from the node cache,
          // which still holds the pre-move node at flush time (commitExitToCanvas
          // syncs the cache before flushing); with no cache entry we can't know
          // which props exist, so we write nothing rather than guess.
          const flowReset = canvasRootFlowReset(getNodeFromCache(mutation.nodeId)?.styles);
          if (Object.keys(flowReset).length > 0) {
            trace.action('mutation:canvas-root-flow-reset', { nodeId: mutation.nodeId, flowReset });
            moveStyles = { ...(moveStyles ?? {}), ...flowReset };
          }
          // `data-responsive` dies with the viewport too. It keys per-breakpoint
          // instance-prop overrides to the SOURCE page's viewport widths
          // (`{"375":{…},"768":{…},"_bp":[375,768,1440]}`) — on the canvas there
          // are no viewports to key against, and re-entering a page whose
          // breakpoint set differs applies stale widths' overrides (user report
          // 2026-07-27). Strip it at this same choke point so every
          // exit-to-canvas — layout drag, absolute drag, grid drag, the menu
          // command — sheds it, on the dragged node AND any instance nested in
          // a dragged section.
          nextCode = stripDataResponsiveInSubtree(nextCode, mutation.nodeId);
          // The per-viewport @media OVERRIDES die with the viewport for exactly
          // the same reason, and they were being left behind. A node hidden on
          // tablet (`@media … [data-id=x] { display: none }`) kept that rule
          // while sitting on the canvas — where it was plainly visible, with no
          // viewport to hide it in — and dragging it back in re-hid it on tablet
          // (user report 2026-08-04). Entry only clears the override for the
          // viewport it lands in (`canvas-drag:entered-vp-display-unhide`), so
          // whatever isn't shed here survives the whole round trip. Subtree-wide,
          // like the `data-responsive` shed above: a dragged section takes its
          // children out too, and their rules are just as orphaned.
          nextCode = clearContainerStylesInSubtree(nextCode, mutation.nodeId);
          // An overlay TRIGGER carries `onClick={() => set<id>Open(...)}` plus a
          // page-level `{<id>Open && <overlay/>}` block backed by useState +
          // useLayoutEffect — the SAME module-scope crash class as the effects
          // dormantized above. `canvasNodes` is editor-only (never published) and
          // has no hooks, so we EXTRACT the overlay there as metadata-only JSX:
          // keep `data-overlay`/`data-overlay-trigger` (editor positions it +
          // pairing survives for rehydrate-on-re-entry), drop the runtime
          // useState/useLayoutEffect/onClick/conditional. Both trigger and
          // overlay end up on the canvas, no dangling identifiers.
          const exitTrigger = parseOverlayTriggerCalls(nextCode).find(t => t.triggerId === mutation.nodeId);
          if (exitTrigger?.config.targetId) {
            const pl = parseFloat(String(moveStyles?.left ?? mutation.styles?.left ?? '0')) || 0;
            const pt = parseFloat(String(moveStyles?.top ?? mutation.styles?.top ?? '0')) || 0;
            nextCode = extractOverlayToCanvasInCode(nextCode, mutation.nodeId, pl, pt + 120);
          }
        }
        // Reparent INTO a canvas frame (the new parent is itself a canvas node) lands
        // the node in module-scope `canvasNodes` too — but `mutation.canvasNode` is
        // false there (it gets a parent), so the block above skipped it, leaving a live
        // `{prop}` that crashes at module scope. Dormantize component-var bindings here
        // as well (pre-move so the move's style-baking can't erase a style var first).
        if (!mutation.canvasNode && mutation.newParentId && isCanvasNode(nextCode, mutation.newParentId)) {
          nextCode = resolveMediaGateTernariesInCode(nextCode, mutation.nodeId);
          nextCode = dormantizeComponentVarBindings(nextCode, mutation.nodeId);
          nextCode = dormantizeTranslationBinding(nextCode, mutation.nodeId, translationTextResolver());
          nextCode = dormantizeFormStateBinding(nextCode, mutation.nodeId);
          // Landing INSIDE a canvas frame leaves the viewport system just the
          // same — shed the source page's breakpoint-keyed overrides (see the
          // canvasNode block above).
          nextCode = stripDataResponsiveInSubtree(nextCode, mutation.nodeId);
        }
        let moved = moveNodeInCode(nextCode, mutation.nodeId, mutation.newParentId, moveStyles, mutation.index, mutation.canvasNode, mutation.sourceVpWidth, mutation.sourceVariant, mutation.insertBeforeId);
        // CMS prop-binding round-trip (the reference "Missing" parity). Compare the
        // node's map scope before vs after the move:
        //  • LEFT its source map (canvas, or a frame outside the `.map()`) →
        //    dormantize: strip the live `srcIter.*` bindings (which would now
        //    crash) and stash them in `data-cms-orphan` so the panel shows
        //    "Missing" and a later re-entry can restore them.
        //  • Landed INSIDE a `.map()` → rehydrate any stashed bindings onto the
        //    NEW iterator. Re-binding by field name; the panel shows "Missing"
        //    for any field the destination collection doesn't have.
        const dstMapIter = getEnclosingMapIteratorForNode(moved, mutation.nodeId);
        if (srcMapIter && srcMapIter !== dstMapIter) {
          // Left its map for NO map (canvas / plain frame) with a resolvable row →
          // dormantize the WHOLE dragged subtree and bake the row's values, so the
          // detached node still shows its text/image/link instead of humanized
          // placeholders ("Untitled" for field `untitled`, user report 2026-07-28).
          // Map → DIFFERENT map keeps the plain dormantize (rehydrate below re-binds).
          moved = (!dstMapIter && srcCmsRow)
            ? detachCmsSubtreeWithValues(moved, mutation.nodeId, srcMapIter, srcCmsRow)
            : dormantizeCmsBindings(moved, mutation.nodeId, srcMapIter);
        }
        if (dstMapIter) {
          moved = rehydrateCmsBindings(moved, mutation.nodeId);
        }
        if (!mutation.canvasNode && mutation.newParentId) {
          let rehydrated = rehydrateScrollVariant(moved, mutation.nodeId);
          // Restore `data-var-orphan` bindings (`{bio}` content / `key: prop` style /
          // `x={prop}` attr) ONLY when the node truly landed back in the component
          // render — a canvas-frame parent (newParentId inside canvasNodes) keeps it
          // module-scope, so it must STAY orphaned (dormantized pre-move above), not
          // re-bind to an out-of-scope identifier. Inverse of dormantize; restores
          // only props that still exist.
          if (!isCanvasNode(rehydrated, mutation.nodeId)) {
            rehydrated = rehydrateComponentVarBindings(rehydrated, mutation.nodeId);
            // Back inside the component render → `t` is in scope again, so put the
            // `{t('key')}` call back and re-ensure the import + hook (the node may
            // have landed in a different file than the one it left).
            rehydrated = rehydrateTranslationBinding(rehydrated, mutation.nodeId, filePathToSlug(_activeFilePath));
            // Form Submit dragged back into a form → rebind its `initialVariant`
            // to THAT form's `formState<Id>` (+ ensure its useState) from the
            // retained `data-form-state` spec. No-op if it didn't land in a form.
            rehydrated = rehydrateFormStateBinding(rehydrated, mutation.nodeId);
          }
          rehydrated = rehydrateInstanceFx(rehydrated, mutation.nodeId);
          rehydrated = rehydrateScrollFx(rehydrated, mutation.nodeId);
          // Back inside a component render → regenerate the hook-backed On Scroll text-effect spans.
          // An overlay TRIGGER dragged back into a viewport: restore the overlay's
          // runtime (useState + useLayoutEffect + onClick + conditional) that was
          // stripped on extract — else the live site can't open it. Inverse of the
          // extractOverlayToCanvasInCode above. No-op unless this node is a trigger
          // whose overlay is still a canvas node.
          rehydrated = rehydrateOverlayFromCanvasInCode(rehydrated, mutation.nodeId);
          // Self-heal any overlay conditional left referencing a dropped useState
          // (a prior detach/extract/rehydrate/remove sequence on component
          // variants could orphan it → "undefined identifier" crash on the next
          // mutation). Re-declares the missing useState. No-op when all are sound.
          rehydrated = healDanglingOverlayState(rehydrated);
          return rehydrated;
        }
        // Moving a component-internal node onto the canvas carries its raw JSX, which may hold a
        // `variant`/`initialVariant` CONDITIONAL style (e.g. `display: initialVariant === 'variant-2'
        // ? 'none' : ''`). `canvasNodes` is module scope — that prop is out of scope there → "undefined
        // identifier" crash. Flatten the conditional to its default branch (the canvas has no variant).
        if (mutation.canvasNode) {
          moved = flattenVariantConditionalStylesInCode(moved, mutation.nodeId);
          // (Component-variable bindings are dormantized BEFORE moveNodeInCode above —
          // they must be stashed while the live `prop` refs still exist, since the move
          // bakes style refs to flat literals on exit.)
          // Sweep EVERY canvas node (not just the one moved): a node dragged out in an earlier gesture
          // can carry a stale `boxShadow: <prop>` / `'--border': <prop>` ref that's undefined at module
          // scope, and it blocks ALL later mutations once it's in the file. Inline those to literals.
          moved = inlineCanvasNodePropRefsInCode(moved);
          // The style sweeps above only touch the STYLE object. A node dragged out of a design component also
          // carries framer-motion VARIANT/animation JSX attrs (`animate={['default', variant]}`, `initial`,
          // `transition={variant === 'v' ? transitionN : …}`) + per-variant child conditionals `{variant === 'v'
          // && <el>}` — all referencing FUNCTION-scope idents that don't exist at module scope → the validator
          // blocks the drag. Strip them (a canvas node is a static free element; it never variant-animates).
          moved = stripCanvasNodeMotionRefsInCode(moved);
          // A variant CONNECTION on the dragged-out node is an `on*={() => setVariant('v')}` handler — undefined
          // at module scope. Pull the target into `data-conn-target` on the canvas node (renders the arrow on the
          // canvas to that variant + restores the live handler on drag-back) and strip the crashing handler.
          moved = stashCanvasNodeConnectionsInCode(moved);
          // The On Scroll text effect baked per-unit `useTransform` refs into its spans backed by
          // component-body hooks. The node is now in module-scope canvasNodes where those hooks can't
          // exist → orphaned refs crash. Regenerate as the self-contained view-form (spec preserved for
          // rehydrate on re-entry). Sweeps EVERY canvas node so a node broken in an earlier gesture also
          // heals. Runs AFTER the move so it sees nodes inside canvasNodes.
          // Self-heal: if extracting the overlay left a `{<var>Open && …}`
          // conditional / posEffect referencing a dropped useState (tangled
          // detach↔rehydrate↔extract sequences on component variants), re-declare
          // the missing useState so the next mutation doesn't fail validation.
          moved = healDanglingOverlayState(moved);
        }
        return moved;
      }

      case 'updateText': {
        // Text-anim nodes: remove anim (collapse spans), FULL-replace the text, re-add anim.
        // Must NOT route through updateNodeTextInCode — it PRESERVES element children, so the
        // `<br />`/`<p>` elements left by the collapse survived every edit and the re-split baked
        // the old text back in front of whatever the user typed (the stuck-DESIGN.BUILD.DEPLOY bug).
        if (nodeHasTextAnim(code, mutation.nodeId)) {
          const config = readTextAnimConfig(code, mutation.nodeId);
          let c = removeTextAnimFromCode(code, mutation.nodeId);
          c = replaceNodeTextContent(c, mutation.nodeId, mutation.text);
          // Unparseable spec → leave the node as clean plain text (attr already stripped).
          return config ? addTextAnimInCode(c, mutation.nodeId, config) : c;
        }
        return updateNodeTextInCode(code, mutation.nodeId, mutation.text);
      }

      case 'updateVariantText':
        return updateVariantTextInCode(code, mutation.nodeId, mutation.variantName, mutation.text);
      case 'detachTextVariableForVariant':
        return detachTextVariableForVariantInCode(code, mutation.nodeId, mutation.variantName, mutation.propName, mutation.literal);
      case 'bindTextVariableForVariant': {
        const boundCode = bindTextVariableForVariantInCode(code, mutation.nodeId, mutation.variantName, mutation.propName, mutation.propDefault);
        // A text-content variable is the Plain Text type (same as createTextVariable).
        return setPropTypeInCode(boundCode, mutation.propName, 'plainText');
      }

      case 'updateChildrenHTML': {
        // Text-anim nodes: fold the TipTap HTML to plain multi-line text and FULL-replace, then
        // re-split. Routing through updateNodeChildrenFromHTML wrote the multi-paragraph commit as
        // real `<p>` JSX children, which the re-split then baked in as literal characters — the
        // live site rendered `<P>DESIGN.</P>` as visible text. And its tag-free fallback
        // (updateNodeTextInCode) preserved those stale children forever (see updateText above).
        if (nodeHasTextAnim(code, mutation.nodeId)) {
          const config = readTextAnimConfig(code, mutation.nodeId);
          let c = removeTextAnimFromCode(code, mutation.nodeId);
          c = replaceNodeTextContent(c, mutation.nodeId, htmlToPlainTextLines(mutation.html));
          return config ? addTextAnimInCode(c, mutation.nodeId, config) : c;
        }
        return updateNodeChildrenFromHTML(code, mutation.nodeId, mutation.html);
      }

      case 'stripInlineSpanStyle':
        return stripInlineSpanStyleInCode(code, mutation.nodeId, mutation.property);

      case 'updateTextOverride': {
        const widths = readAllViewportWidths(code);
        return setTextOverrideInCode(
          code,
          mutation.nodeId,
          mutation.vpWidth,
          mutation.primaryWidth,
          mutation.text,
          widths,
        );
      }

      case 'removeTextOverride': {
        const widths = readAllViewportWidths(code);
        return removeTextOverrideInCode(
          code,
          mutation.nodeId,
          mutation.vpWidth,
          mutation.primaryWidth,
          widths,
        );
      }

      case 'removeNode': {
        // Strip the element, then drop any connection whose trigger element is
        // now gone (its onTap went with the element; the `connections` entry +
        // arrow would otherwise linger as dead data). Presence-based so it also
        // covers deleting a parent of the trigger. No-op for non-component
        // files / when every sourceNode still exists.
        const afterRemove = removeNodeInCode(code, mutation.nodeId);
        // Deleting a paginated collection list removes its JSX (incl. the
        // `.slice()`), but leaves its body hooks (useState/useRef/useEffect)
        // orphaned — and those keep referencing the deleted list's slug, which
        // may no longer be imported → "<slug> is not defined". Prune them.
        return pruneOrphanedPaginationHooks(removeDanglingConnectionsInCode(afterRemove));
      }

      case 'renameNode': {
        // The canonical JSX-attribute finder — NOT a hand-rolled `<`-vs-`[`
        // heuristic. The old one classified any tag whose attrs contain a `[`
        // BEFORE data-id as "a CSS selector" and skipped it — and every
        // responsive component instance does (`data-responsive='…"_bp":
        // [375,768,1440]}'` precedes data-id), so instances silently could
        // not be renamed at all: the mutation applied, the code came back
        // byte-identical, and the layers row reverted (user report
        // 2026-07-27, `activeCodeAtom:set-skip-identical` in the trace).
        // findJSXDataIdIndex requires a real tag-open with no `>` between,
        // which also correctly skips `[data-id="…"]` selectors in <style>
        // blocks and querySelector strings in script logic.
        const idIdx = findJSXDataIdIndex(code, mutation.nodeId);
        if (idIdx === -1) return code;

        // Find data-name in the same tag. findTagClose is brace-safe — a
        // plain indexOf('>') stops inside `onTap={() => …}` arrow props.
        const tagEnd = findTagClose(code, idIdx);
        if (tagEnd === -1) return code;
        const tagSlice = code.slice(idIdx, tagEnd);
        const nameMatch = tagSlice.match(/data-name="[^"]*"/);
        if (nameMatch) {
          const nameStart = idIdx + tagSlice.indexOf(nameMatch[0]);
          return code.slice(0, nameStart) + `data-name="${sanitizeDataName(mutation.name)}"` + code.slice(nameStart + nameMatch[0].length);
        }
        // No data-name exists — insert after data-id
        const insertAt = idIdx + `data-id="${mutation.nodeId}"`.length;
        return code.slice(0, insertAt) + ` data-name="${sanitizeDataName(mutation.name)}"` + code.slice(insertAt);
      }

      case 'createVariable': {
        let boundCode = createVariableInCode(
          code,
          mutation.nodeId,
          mutation.styleProperty,
          mutation.propName,
          mutation.defaultValue,
          mutation.clearLonghands,
          mutation.literalKind ?? 'string',
        );
        // Persist the variable's TYPE (number/toggle/color/…) in @propMeta so the modal shows the right
        // default editor and the pill shows the right glyph — decoupled from the CSS property it drives.
        boundCode = mutation.varType ? setPropTypeInCode(boundCode, mutation.propName, mutation.varType) : boundCode;
        // On a CANVAS node the live `prop` style ref is module-scope (would crash) —
        // convert the just-written binding to the restorable orphan form (default
        // literal + data-var-orphan) so it works on canvas exactly like in a variant.
        return isCanvasNode(boundCode, mutation.nodeId)
          ? dormantizeComponentVarBindings(boundCode, mutation.nodeId)
          : boundCode;
      }
      case 'createConditionalVariable': {
        const boundCode = createConditionalVariableInCode(
          code,
          mutation.nodeId,
          mutation.styleProperty,
          mutation.propName,
          mutation.consequent,
          mutation.alternate,
          mutation.boolDefault,
        );
        return mutation.varType ? setPropTypeInCode(boundCode, mutation.propName, mutation.varType) : boundCode;
      }
      case 'setVariantBorderVariable':
        return setBorderOverlayVariableForVariant(
          code,
          mutation.nodeId,
          mutation.propName,
          mutation.variantName,
          mutation.defaultValue,
        );
      case 'setVariantInlineVariable':
        return setInlineVariableForVariant(
          code,
          mutation.nodeId,
          mutation.cssProp,
          mutation.variantName,
          mutation.propName,
          mutation.elseValue,
          mutation.defaultValue,
          mutation.elseIsIdentifier ?? false,
        );
      case 'removeVariantStyleVariable':
        return removeVariantStyleVariableInCode(code, mutation.nodeId, mutation.cssProp, mutation.variantName);
      case 'setComponentPropDefault':
        return setComponentPropDefaultInCode(code, mutation.propName, mutation.newDefault, mutation.literalKind);
      case 'setComponentPropDescription':
        return setPropDescriptionInCode(code, mutation.propName, mutation.description);
      case 'setChildEventFire':
        return setChildEventFireInCode(code, mutation.childId, mutation.trigger, mutation.eventVar, mutation.delay ?? 0, mutation.variantName ?? 'default');
      case 'removeChildEventFire':
        return removeChildEventFireInCode(code, mutation.childId, mutation.trigger, mutation.variantName ?? 'default');
      case 'createTypedVariable': {
        // An EVENT variable is a component CALLBACK prop (standard component event),
        // NOT a data prop — add it BARE (`{ eventName }`, no string default) so a child
        // can fire it (`onClick={eventName}`) and the page instance can pass a handler
        // (`eventName={() => setOverlayOpen(true)}`). Other types get a typed literal default.
        const withProp = mutation.varType === 'event'
          ? addBarePropToFunctionInCode(code, mutation.name, 'none')
          : createTypedVariableInCode(code, mutation.name, mutation.literalKind, mutation.defaultValue);
        return setPropTypeInCode(withProp, mutation.name, mutation.varType);
      }
      case 'setComponentPropOptions':
        return setPropOptionsInCode(code, mutation.propName, mutation.options, mutation.locked);
      case 'setComponentPropType':
        return setPropTypeInCode(code, mutation.propName, mutation.varType);
      case 'setComponentPropLabel':
        return setPropLabelInCode(code, mutation.propName, mutation.label);
      case 'setComponentPropVariantOf':
        return setPropVariantOfInCode(code, mutation.propName, mutation.componentTag);
      case 'setComponentPropNumberMeta':
        return setPropNumberMetaInCode(code, mutation.propName, mutation.meta);
      case 'deleteComponentVariable': {
        // The full single-file erase (scroll-variant refs → param+references → @propMeta →
        // __templateProps route values → @pageVariables entry) lives in the shared pipeline —
        // the cross-file cascade (cascade-delete-variable.ts) applies the SAME cleanup to every
        // instancing file it walks, so the two paths can never drift.
        return applyDeleteVariablePipeline(code, mutation.propName, mutation.defaultValue);
      }
      case 'renameComponentVariable': {
        // Rename the prop + all refs, then MOVE its @propMeta entry (type/description/options/label/
        // variantOf) to the new key — renameComponentVariableInCode doesn't touch @propMeta, so without
        // this the label + the variant-of-component identity would be lost on a var-NAME rename.
        const oldType = getPropType(code, mutation.oldName);
        const oldDesc = getPropDescription(code, mutation.oldName);
        const oldOpts = getPropOptions(code, mutation.oldName);
        const oldLabel = getPropLabel(code, mutation.oldName);
        const oldVariantOf = getPropVariantOf(code, mutation.oldName);
        let c = renameComponentVariableInCode(code, mutation.oldName, mutation.newName);
        c = setPropTypeInCode(c, mutation.oldName, '');
        c = setPropDescriptionInCode(c, mutation.oldName, '');
        c = setPropOptionsInCode(c, mutation.oldName, []);
        c = setPropLabelInCode(c, mutation.oldName, '');
        c = setPropVariantOfInCode(c, mutation.oldName, '');
        if (oldType) c = setPropTypeInCode(c, mutation.newName, oldType);
        if (oldDesc) c = setPropDescriptionInCode(c, mutation.newName, oldDesc);
        if (oldOpts.length) c = setPropOptionsInCode(c, mutation.newName, oldOpts);
        if (oldLabel) c = setPropLabelInCode(c, mutation.newName, oldLabel);
        if (oldVariantOf) c = setPropVariantOfInCode(c, mutation.newName, oldVariantOf);
        return c;
      }
      case 'createTextVariable': {
        // A text-content variable IS the Plain Text type — tag it in @propMeta so it reads as
        // 'plainText' everywhere (icon/modal resolve from the type, not CSS-prop inference), exactly like
        // a Plain Text variable created from the "+" picker. The only difference is what it's bound to:
        // the element's text children vs a free-standing prop.
        const withText = setPropTypeInCode(
          createTextVariableInCode(code, mutation.nodeId, mutation.propName, mutation.defaultValue),
          mutation.propName,
          'plainText',
        );
        // Canvas node → the live `{prop}` text child is module-scope (would crash);
        // convert to the orphan form so the pill shows + a re-entry restores it.
        return isCanvasNode(withText, mutation.nodeId)
          ? dormantizeComponentVarBindings(withText, mutation.nodeId)
          : withText;
      }
      case 'createTextPageVariable':
        // Page text variable = bind the text node to `{propName}`, declare a
        // @pageVariables text entry, then sync the `const [propName, setPropName]
        // = useState(default)` hook. Unlike a @propMeta text prop, this is
        // SETTABLE, so it appears in the Interactions tool's Set-Variable list.
        return syncPageVariableHooks(addPageVariableInCode(
          bindTextNodeAsPageVarInCode(code, mutation.nodeId, mutation.propName, mutation.defaultValue),
          { name: mutation.propName, type: 'text', default: mutation.defaultValue ?? '' },
        ));
      case 'removeTextPageVariable':
        // Inverse: unbind `{propName}` back to its literal text (deleteProp=false —
        // there's no prop), drop the @pageVariables entry, then sync clears the
        // now-orphan useState hook.
        return syncPageVariableHooks(removePageVariableInCode(
          removeTextVariableInCode(code, mutation.nodeId, mutation.propName, mutation.defaultValue ?? '', false),
          mutation.propName,
        ));
      case 'removeTextVariable':
        // The pill × on a CANVAS node clears the orphan stash (revert to the default
        // literal already in place) — there's no live `{prop}` to strip.
        if (isCanvasNode(code, mutation.nodeId)) {
          return clearVarOrphanInCode(code, mutation.nodeId, 'content');
        }
        return removeTextVariableInCode(
          code,
          mutation.nodeId,
          mutation.propName,
          mutation.defaultValue,
          mutation.deleteProp,
        );

      case 'removeVariable':
        if (isCanvasNode(code, mutation.nodeId)) {
          return clearVarOrphanInCode(code, mutation.nodeId, `style.${mutation.styleProperty}`);
        }
        return removeVariableInCode(code, mutation.nodeId, mutation.styleProperty, mutation.propName, mutation.defaultValue, mutation.deleteProp);

      case 'createTransitionVariable': {
        // Bind the framer-motion transition to a VARIABLE identifier (NOT style.transition): default →
        // <MotionConfig transition={var}>, a variant → variantObj[v].transition = var (per-variant native),
        // child → transition={var}. Then add the prop param (empty-object default the modal edits) + @propMeta
        // type 'transition'. This is the per-variant transition-variable create — see [[project_transition_responsive]].
        let c = code;
        if (mutation.mode === 'variantEntry' && mutation.variantName) {
          // Per-variant transition VARIABLES are FUNCTION-SCOPE (the module-scope variant object can't
          // reference a function-scoped prop → "undefined identifier" crash). Re-binding the BASE variable on a
          // variant = drop the per-variant override → re-inherit the base. A DIFFERENT variable = the element
          // transition-prop ternary `transition={initialVariant === 'v' ? var : base}`.
          const baseVar = readTransitionVarRef(c, mutation.nodeId, 'motionConfig', null) ?? readTransitionVarRef(c, mutation.nodeId, 'elementProp', null);
          // ROOT → MotionConfig (cascade to all children); CHILD → the child's OWN element-prop ternary (override).
          if (mutation.onRoot && baseVar === mutation.propName) {
            c = updateVariantEntryTransition(c, mutation.nodeId, mutation.variantName, null);
          } else {
            c = setVariantTransitionPropVar(c, mutation.nodeId, mutation.variantName, mutation.propName, baseVar ?? 'undefined', mutation.onRoot ?? true);
          }
        } else if (mutation.mode === 'elementProp') {
          c = setElementTransitionVar(c, mutation.nodeId, mutation.propName);
        } else {
          // PRIMARY (default): set the BASE of the MotionConfig chain — keep the per-variant branches intact
          // (replacing the whole MotionConfig would override every variant's individual transition).
          c = setMotionConfigBaseVar(c, mutation.propName);
        }
        c = addBarePropToFunctionInCode(c, mutation.propName, (mutation.defaultValue && mutation.defaultValue.trim()) ? mutation.defaultValue : '{}');
        c = setPropTypeInCode(c, mutation.propName, 'transition');
        return c;
      }

      case 'addPageVariable':
        return addPageVariableInCode(code, mutation.variable);
      case 'hoistInstanceProp':
        // Sync hooks afterward: the new function-signature param
        // shouldn't get a useState (component variables ARE props), so
        // we DON'T call syncPageVariableHooks here. The annotation
        // metadata exists so the variable shows up in the editor's
        // variable list and gets type/description info; the destructure
        // param is what gives it runtime semantics as a controllable
        // prop — the two storage layers intentionally coexist.
        return hoistInstancePropInCode(code, {
          instanceNodeId: mutation.instanceNodeId,
          componentName: mutation.componentName,
          propName: mutation.propName,
          variable: mutation.variable,
          scope: mutation.scope,
        });
      case 'createLinkAttrVariable':
        // Add a `@pageVariables` entry (metadata for the editor's variable
        // list / instance-row control type) + rewrite the attr to a prop ref.
        // Like hoistInstanceProp, the destructure param — not the annotation —
        // is what gives it runtime prop semantics. Then syncSmoothScrollHandler
        // (re)injects the runtime onClick so a VARIABLE smooth flag actually
        // scrolls — the static setSmoothScrollInCode can't bake in a section id
        // it doesn't know. Runs for every kind so a later href var also updates
        // the handler's href reference.
        return syncLinkHandlerInCode(
          addPageVariableInCode(
            createLinkAttrVariableInCode(code, mutation.nodeId, {
              attrName: mutation.attrName,
              propName: mutation.propName,
              kind: mutation.kind,
              defaultValue: mutation.defaultValue,
            }),
            { name: mutation.propName, type: mutation.variableType, default: mutation.defaultValue },
          ),
          mutation.nodeId,
        );
      case 'removeLinkAttrVariable':
        // Rewrite the attr back to a literal + drop the prop, then remove the
        // @pageVariables annotation. syncPageVariableHooks clears any orphan
        // useState (page-level link vars never have one, but masters share the path).
        // syncSmoothScrollHandler removes/updates the onClick — e.g. detaching
        // the smooth var drops the dynamic flag, so the handler is removed.
      {
        // The pill × on a node (keepVariable) UNBINDS only — rewrite the attr to its literal but KEEP the
        // param AND the @pageVariables entry so the variable survives (same as every other variable's ×; the
        // modal's explicit delete is what fully removes it). Without keepVariable it's the full detach.
        const unbound = removeLinkAttrVariableInCode(code, mutation.nodeId, {
          attrName: mutation.attrName,
          propName: mutation.propName,
          kind: mutation.kind,
          deleteProp: !mutation.keepVariable,
        });
        const afterPageVar = mutation.keepVariable ? unbound : removePageVariableInCode(unbound, mutation.propName);
        return syncLinkHandlerInCode(syncPageVariableHooks(afterPageVar), mutation.nodeId);
      }
      case 'updatePageVariable': {
        // The annotation rewrite is information-only. If the NAME changed, ALSO
        // rename the runtime hook (value + setter + every reference) so the
        // invariant annotation === hook === setter holds — otherwise the old
        // `const [oldName, setOldName]` is orphaned and the Interactions tool
        // can't find `set<NewName>`, hiding the "Set Variable" "+".
        const annotated = updatePageVariableInCode(code, mutation.oldName, mutation.updates);
        return mutation.updates.name && mutation.updates.name !== mutation.oldName
          ? renamePageVariableHookInCode(annotated, mutation.oldName, mutation.updates.name)
          : annotated;
      }
      case 'removePageVariable':
        // Hooks are synced at end-of-batch; removing the variable here also
        // drops any orphan useState in the same flush.
        return syncPageVariableHooks(removePageVariableInCode(code, mutation.name));
      case 'bindStylePageVariable':
        // Run hook sync inline so the useState lands in the SAME flush as the
        // JSX identifier — otherwise the file is briefly invalid (identifier
        // referencing an undeclared variable) and ESLint/babel can complain.
        return syncPageVariableHooks(
          bindStyleToPageVariableInCode(code, mutation.nodeId, mutation.styleProperty, mutation.varName),
        );
      case 'unbindStylePageVariable':
        return syncPageVariableHooks(
          unbindStyleFromPageVariableInCode(code, mutation.nodeId, mutation.styleProperty, mutation.literalValue),
        );
      case 'bindResponsiveStyleVariable': {
        // The bound variable is already a declared page variable (its useState exists); sync anyway
        // so a freshly-added variable's hook lands in the same flush as the ternary identifier.
        let rsv = setResponsiveStyleVariableInCode(code, mutation.nodeId, mutation.vpWidth, mutation.styleProperty, mutation.varName, mutation.baseFallback);
        // CRITICAL: clear any stale `@media` literal override for this prop+tile (left by a PRIOR
        // per-viewport REMOVE, which freezes the value as `… !important`). Its `!important` masks the
        // inline `__mq` variable ternary — the variable resolves but the @media wins. Empty value =
        // remove the rule.
        rsv = updateContainerQueryStyle(rsv, mutation.nodeId, mutation.vpWidth, { [mutation.styleProperty]: '' });
        return syncPageVariableHooks(rsv);
      }
      case 'unbindResponsiveStyleVariable':
        return syncPageVariableHooks(
          resetResponsiveStyleVariableInCode(code, mutation.nodeId, mutation.vpWidth, mutation.styleProperty),
        );
      case 'setResponsiveStyleBase':
        return syncPageVariableHooks(
          setResponsiveStyleBaseInCode(code, mutation.nodeId, mutation.styleProperty, mutation.newBase),
        );
      case 'bindResponsiveTextVariable':
        return syncPageVariableHooks(
          setResponsiveTextVariableInCode(code, mutation.nodeId, mutation.vpWidth, mutation.branch, mutation.baseFallback),
        );
      case 'unbindResponsiveTextVariable':
        return syncPageVariableHooks(
          resetResponsiveTextVariableInCode(code, mutation.nodeId, mutation.vpWidth),
        );
      case 'setResponsiveTextBase':
        return syncPageVariableHooks(
          setResponsiveTextBaseInCode(code, mutation.nodeId, mutation.newBase),
        );
      case 'ensureTemplateVarParam': {
        // Add the prop (idempotent) + its @propMeta type, then strip a now-redundant `const
        // [name,…] = useState(…)` (a per-viewport var that landed as useState the old way) so the
        // param isn't duplicated — templates read vars as props.
        let c = createTypedVariableInCode(code, mutation.name, mutation.literalKind, mutation.defaultValue);
        c = c.replace(new RegExp(`\\n?[ \\t]*const \\[\\s*${mutation.name}\\s*,[^\\]]*\\]\\s*=\\s*useState\\([^;]*\\);`, 'g'), '');
        c = setPropTypeInCode(c, mutation.name, mutation.varType);
        return c;
      }

      case 'addPageInteraction':
        return addPageInteractionInCode(code, mutation.nodeId, mutation.trigger, mutation.varName, mutation.value);
      case 'removePageInteraction':
        return removePageInteractionInCode(code, mutation.nodeId, mutation.trigger, mutation.varName);
      case 'addCloseOverlay':
        return addCloseOverlayInCode(code, mutation.nodeId, mutation.trigger, mutation.overlayId);
      case 'removeCloseOverlay':
        return removeCloseOverlayInCode(code, mutation.nodeId, mutation.trigger, mutation.overlayId);
      case 'setCloseOverlayDelay':
        return setCloseOverlayDelayInCode(code, mutation.nodeId, mutation.trigger, mutation.overlayId, mutation.delay);

      case 'setFormStateMapping':
        return setFormStateMappingInCode(code, mutation.nodeId, mutation.stateVar, mutation.mapping);

      case 'setResponsiveAttr':
        return setResponsiveAttrInCode(code, mutation.nodeId, mutation.vpWidth, mutation.attr, mutation.value, mutation.baseValue);
      case 'setResponsiveAttrBase':
        return setResponsiveAttrBaseInCode(code, mutation.nodeId, mutation.attr, mutation.value);
      case 'setVariantAttr':
        return setVariantAttrInCode(code, mutation.nodeId, mutation.variant, mutation.attr, mutation.value, mutation.baseValue);

      case 'updateVariantStyle':
        return updateVariantStyleInCode(code, mutation.nodeId, mutation.variantName, mutation.styles);

      case 'setVariantVisibility':
        return setVariantVisibilityInCode(code, mutation.nodeId, mutation.hiddenVariants, mutation.allVariants);

      case 'setConditionalOrder':
        return setConditionalOrderInCode(code, mutation.nodeId, mutation.orderMap);

      case 'setConditionalStyle':
        return setConditionalStyleInCode(code, mutation.nodeId, mutation.prop, mutation.variantName, mutation.value);

      case 'updateBorderOverlay':
        return updateBorderOverlayStyle(code, mutation.nodeId, mutation.afterCSS);

      case 'removeBorderOverlay':
        return removeBorderOverlayStyle(code, mutation.nodeId);

      case 'updateHtmlAttrs': {
        let next = updateHtmlAttrsInCode(code, mutation.nodeId, mutation.attrs);
        // Configuring a form's Send To writes `data-form`. Make sure the form
        // is actually wired: add the onSubmit handler (covers forms created
        // before auto-wiring existed — without it the submit button does a
        // native page-navigating submit instead of POSTing to /api/form) and
        // ensure the relay route exists in the FS.
        if (mutation.attrs && 'data-form' in mutation.attrs) {
          next = wireFormSubmitInCode(next, mutation.nodeId);
          ensureFormRouteFile();
        }
        return next;
      }

      case 'setCmsNavHref':
        return setCmsNavHrefInCode(code, mutation.nodeId, mutation.mode, mutation.collection, mutation.itemVar);

      case 'connectSlot':
        return connectSlotInCode(code, mutation.componentId, mutation.canvasNodeId);

      case 'disconnectSlot':
        return disconnectSlotInCode(code, mutation.componentId, mutation.canvasNodeId);

      case 'reorderSlot':
        return reorderSlotInCode(code, mutation.componentId, mutation.fromIndex, mutation.toIndex);

      case 'changeTag':
        return changeTagInCode(code, mutation.nodeId, mutation.newTag);
      case 'replaceComponentInstance': {
        // Swap the instance for a different component (keeps data-id + style),
        // then re-assert width/height so the new instance keeps the old one's
        // rendered size even when the old size came from the master default
        // (not an explicit instance override). syncImports (import-affecting)
        // adds the new import + prunes the old one if it's now unused.
        let next = replaceComponentInstanceInCode(code, {
          nodeId: mutation.nodeId,
          newTag: mutation.newTag,
          newDisplayName: mutation.newDisplayName,
        });
        const dims: Record<string, string> = {};
        if (mutation.width) dims.width = mutation.width;
        if (mutation.height) dims.height = mutation.height;
        if (Object.keys(dims).length) next = updateNodeInCode(next, mutation.nodeId, dims);
        return next;
      }
      case 'convertToMotionLink':
        return convertToMotionLinkInCode(code, mutation.nodeId);
      case 'syncLinkHandler':
        return syncLinkHandlerInCode(code, mutation.nodeId);

      case 'updateSvgAttrs':
        return updateSvgAttrsInCode(code, mutation.nodeId, mutation.attrs, mutation.childIndex);

      case 'addSvgChild':
        return addSvgChildInCode(code, mutation.nodeId, mutation.childJSX);

      case 'removeSvgChild':
        return removeSvgChildInCode(code, mutation.nodeId, mutation.childIndex);

      case 'setVideoFill':
        return setVideoFillInCode(code, mutation.nodeId, mutation.opts);

      case 'removeVideoFill':
        return removeVideoFillInCode(code, mutation.nodeId);

      case 'replaceSvgInner':
        return replaceSvgInnerInCode(code, mutation.nodeId, mutation.innerJSX);

      case 'setSketchAnim':
        return setSketchAnimInCode(code, mutation.nodeId, mutation.config);
      case 'removeSketchAnim':
        return removeSketchAnimInCode(code, mutation.nodeId);

      case 'updateKeyframes':
        // Writes to app/globals.css (global) — does not modify per-page code
        updateKeyframeInTokensCSS(mutation.name, mutation.css);
        return code;

      case 'removeKeyframes':
        // Writes to app/globals.css (global) — does not modify per-page code
        removeKeyframeFromTokensCSS(mutation.name);
        return code;

      case 'updateCssHover':
        return updateHoverStyleInCode(code, mutation.nodeId, mutation.styles);
      case 'removeCssHover':
        return removeHoverStyleInCode(code, mutation.nodeId);

      case 'updatePseudoStyle':
        return updatePseudoStyleInCode(code, mutation.nodeId, mutation.pseudo, mutation.styles);
      case 'removePseudo':
        return removePseudoStyleInCode(code, mutation.nodeId, mutation.pseudo);

      case 'setSmoothScroll':
        // setSmoothScrollInCode bakes a STATIC handler when the section is
        // resolvable (literal page links). syncSmoothScrollHandler then adds the
        // RUNTIME handler iff the link is dynamic (variable href/smooth) — and
        // is a strict no-op for fully-literal links, so it never clobbers the
        // static one. Together they cover "any link" toggling smooth on/off.
        return syncLinkHandlerInCode(
          setSmoothScrollInCode(code, mutation.nodeId, mutation.enabled),
          mutation.nodeId,
        );

      case 'updateMotionProp': {
        // RESPONSIVE-VALUE model: when a scope context is given (add OR edit while
        // a viewport/variant is active), route through setMotionPropScopedValue —
        // it KEEPS the base and writes the edit into that scope's branch
        // (`whileHover={__mq0 ? {override} : {base}}`). scope=null → write the base.
        // No scope key at all (legacy / non-scoped editor) → plain in-place update.
        if (mutation.scope !== undefined) {
          return setMotionPropScopedValue(code, mutation.nodeId, mutation.propName, mutation.props, mutation.scope);
        }
        return updateMotionPropInCode(code, mutation.nodeId, mutation.propName, mutation.props);
      }

      case 'removeMotionProp':
        return removeMotionPropFromCode(code, mutation.nodeId, mutation.propName);

      case 'removeMotionScopeBranch':
        // Reset Override on a responsive animation → drop just this scope's branch;
        // collapse to the base (or remove the prop entirely if there was no base).
        return removeMotionPropScopeBranch(code, mutation.nodeId, mutation.propName, mutation.scope);

      // CANVAS-NODE routing (all six scroll cases): module-scope `canvasNodes`
      // can't hold hooks — the hook-emitting writers bound function-scope
      // motion values into module-scope style ("References undefined
      // identifiers …Opacity/…Scale" adding a Scroll Transform on a canvas
      // paste, 2026-08-07). Store the spec DORMANT in data-scroll-fx instead;
      // the move pipeline's rehydrateScrollFx materializes it on page entry.
      case 'updateScrollAnim': {
        const cfg = mutation.config;
        if (isCanvasNode(code, cfg.nodeId)) {
          return writeCanvasNodeScrollFx(code, cfg.nodeId, { transform: {
            trigger: cfg.trigger,
            from: cfg.stops[0]?.props ?? {},
            to: cfg.stops[cfg.stops.length - 1]?.props ?? {},
            ...(cfg.transition ? { transition: cfg.transition } : {}),
          } });
        }
        return updateScrollAnimInCode(code, cfg);
      }

      case 'removeScrollAnim':
        if (isCanvasNode(code, mutation.nodeId)) return writeCanvasNodeScrollFx(code, mutation.nodeId, { transform: undefined });
        return removeScrollAnimFromCode(code, mutation.nodeId);

      case 'updateScrollDirection': {
        const cfg = mutation.config;
        if (isCanvasNode(code, cfg.nodeId)) {
          return writeCanvasNodeScrollFx(code, cfg.nodeId, { animation: {
            direction: cfg.direction, replay: cfg.replay, toProps: cfg.toProps,
            ...(cfg.transition ? { transition: cfg.transition } : {}),
          } });
        }
        return updateScrollDirectionAnimInCode(code, cfg);
      }

      case 'removeScrollDirection':
        if (isCanvasNode(code, mutation.nodeId)) return writeCanvasNodeScrollFx(code, mutation.nodeId, { animation: undefined });
        return removeScrollDirectionFromCode(code, mutation.nodeId);

      case 'updateScrollSpeed': {
        const cfg = mutation.config;
        if (isCanvasNode(code, cfg.nodeId)) return writeCanvasNodeScrollFx(code, cfg.nodeId, { speed: cfg.speed });
        return updateScrollSpeedInCode(code, cfg);
      }

      case 'removeScrollSpeed':
        if (isCanvasNode(code, mutation.nodeId)) return writeCanvasNodeScrollFx(code, mutation.nodeId, { speed: undefined, speedResponsive: undefined });
        return removeScrollSpeedFromCode(code, mutation.nodeId);

      case 'updateLoop':
        return setLoopInCode(code, mutation.nodeId, mutation.spec);

      case 'removeLoop':
        return setLoopInCode(code, mutation.nodeId, null);

      // Scroll Variant is page-level (drives the instance's initialVariant prop) — it
      // is NOT a data-scroll-fx motion-value compose, so it does NOT route through the
      // decompose/recompose wrapper; a plain set/remove.
      case 'updateScrollVariant':
        return setScrollVariantInCode(code, mutation.nodeId, mutation.spec);

      case 'removeScrollVariant':
        return setScrollVariantInCode(code, mutation.nodeId, null);

      case 'updateInstanceFx':
        return setInstanceFxInCode(code, mutation.nodeId, mutation.spec);

      case 'removeInstanceFx':
        return setInstanceFxInCode(code, mutation.nodeId, null);

      case 'updateGlide':
        return setGlideInCode(code, mutation.nodeId, mutation.spec);

      case 'removeGlide':
        return setGlideInCode(code, mutation.nodeId, null);

      case 'updateScrollFx':
        return setScrollFxInCode(code, mutation.nodeId, mutation.spec);

      case 'removeScrollFx':
        return setScrollFxInCode(code, mutation.nodeId, null);

      case 'removeScrollSpeedScopeBranch':
        return removeScrollSpeedScopeBranch(code, mutation.nodeId, mutation.scope);

      case 'injectSvgDataId': {
        // Find parent element by data-id, then find the Nth <svg WITHOUT data-id inside it
        const parentMarker = `data-id="${mutation.parentId}"`;
        const parentIdx = code.indexOf(parentMarker);
        if (parentIdx < 0) return code;
        // Search for <svg tags after the parent marker, skip ones that already have data-id
        let svgCount = 0;
        let searchFrom = parentIdx;
        while (searchFrom < code.length) {
          const svgIdx = code.indexOf('<svg', searchFrom);
          if (svgIdx < 0) break;
          // Check if this <svg already has a data-id (look at the next ~200 chars for the closing >)
          const tagEnd = code.indexOf('>', svgIdx);
          const tagContent = tagEnd >= 0 ? code.slice(svgIdx, tagEnd) : '';
          if (tagContent.includes('data-id=')) {
            // Already has data-id, skip
            searchFrom = svgIdx + 4;
            continue;
          }
          if (svgCount === mutation.svgIndex) {
            const insertPos = svgIdx + 4; // after '<svg'
            const attrs = ` data-id="${mutation.newId}" data-name="${sanitizeDataName(mutation.newName)}"`;
            return code.slice(0, insertPos) + attrs + code.slice(insertPos);
          }
          svgCount++;
          searchFrom = svgIdx + 4;
        }
        return code;
      }

      case 'createCollectionList':
        {
          const created = createCollectionListInCode(code, mutation.parentId, mutation.collectionSlug, mutation.templateJSX);
          // Localize the new list when the project has more than one language,
          // so its rows resolve per-locale field values on the canvas AND on
          // the published site. No-op on a single-locale project (nothing to
          // resolve) and idempotent, so a re-drop can't double-wrap.
          return getI18nConfig().locales.length > 1
            ? localizeCollectionListsInCode(created)
            : created;
        }
      case 'bindField':
        return bindFieldInCode(code, mutation.nodeId, mutation.property, mutation.fieldId, mutation.itemVar, mutation.fieldType);
      case 'unbindField':
        return unbindFieldInCode(code, mutation.nodeId, mutation.property, mutation.staticValue);
      case 'setVariantCmsText':
        return setVariantTextBindingInCode(code, mutation.nodeId, mutation.variantName, mutation.override, mutation.itemVar);
      case 'setVariantCmsStyle':
        return setVariantStyleBindingInCode(code, mutation.nodeId, mutation.styleProp, mutation.variantName, mutation.override, mutation.itemVar);
      case 'updateCollectionConfig':
        return updateCollectionListConfigInCode(code, mutation.parentId, mutation.filterGroup, mutation.sort, mutation.limit, mutation.offset);

      // Responsive (per-viewport / per-variant) list config — re-emits the whole
      // list from the model: upgrades to `__applyListConfig(slug, cfg)` when there
      // are overrides, downgrades to the inline chain when none.
      case 'setListResponsiveConfig':
        return writeResponsiveListConfigInCode(code, mutation.parentId, mutation.slug, mutation.config, {
          limit: mutation.limit ?? undefined,
          offset: mutation.offset ?? undefined,
          paginationVar: mutation.paginationVar ?? undefined,
          variantArg: mutation.variantArg,
          vpWidths: mutation.vpWidths,
        });

      case 'setPagination':
        // Each mode injects a component instance — make sure its master file
        // exists on disk first so the import + expandComponent resolve.
        if (mutation.mode === 'loadMore') ensureLoadMoreComponentFile();
        if (mutation.mode === 'infinite') ensureSpinnerComponentFile();
        // Also sweep orphaned hooks from previously-deleted lists (they keep
        // referencing a no-longer-imported slug → "<slug> is not defined").
        return pruneOrphanedPaginationHooks(setPaginationInCode(code, mutation.parentId, { mode: mutation.mode, perPage: mutation.perPage }));

      case 'removePagination':
        return pruneOrphanedPaginationHooks(removePaginationInCode(code, mutation.parentId));

      case 'addCollectionSearchField':
        return addSearchFieldInCode(code, mutation.parentId, mutation.varName, mutation.frameId, mutation.fieldLabel, mutation.placeholder, !!mutation.isComponentFile, mutation.queryParam);

      case 'setSearchInputVariable': {
        let out = code;
        if (mutation.createVar) out = addPageVariableInCode(out, { name: mutation.varName, type: 'text', default: '' });
        out = setSearchInputVariableInCode(out, mutation.inputId, mutation.varName);
        return syncPageVariableHooks(out);
      }

      case 'setInstanceEventDelay':
        return setInstanceEventDelayInCode(code, mutation.nodeId, mutation.propName, mutation.delaySeconds);
      case 'bindInstanceEventCloseOverlay':
        return setInstanceEventCloseHandlerInCode(code, mutation.nodeId, mutation.propName, overlayCloseSetter(mutation.overlayId));
      case 'unbindInstanceEvent':
        return removeInstanceEventHandlerInCode(code, mutation.nodeId, mutation.propName);

      case 'updateLocaleStyle':
        return updateLocaleStyleInCode(code, mutation.nodeId, mutation.locale, mutation.styles, mutation.maxWidth, mutation.variantName);
      case 'updateLocaleInstanceProp':
        // Per-locale instance-prop value (variable localization) —
        // null value removes that locale scope (Reset Override).
        return setLocaleInstancePropInCode(code, mutation.nodeId, mutation.componentName, mutation.prop, mutation.locale, mutation.value, mutation.bandQuery);
      case 'updateInstancePropBase':
        // Default-locale (Fallback) value of a scoped instance prop — rewrites
        // the expression's base branch, preserving every locale/width scope.
        return setInstancePropBaseInCode(code, mutation.nodeId, mutation.componentName, mutation.prop, JSON.stringify(mutation.value));

      // ─── Inline .map() / Repeater mutations ──────────────────────────────
      case 'makeIntoMap':
        return makeIntoMapInCode(code, mutation.nodeId, mutation.varName);
      case 'bindToCmsCollection':
        return bindToCmsCollectionInCode(code, mutation.nodeId, mutation.collectionSlug);
      case 'unbindFromCmsCollection':
        return unbindFromCmsCollectionInCode(code, mutation.nodeId);
      case 'changeCollectionSource': {
        let out = changeCollectionSourceInCode(code, mutation.parentNodeId, mutation.newSlug, mutation.fieldRemap);
        // The source change rewrites the .map() chain head + import, but
        // pagination's sentinel guard + IntersectionObserver useEffect still
        // reference the OLD slug (`<oldSlug>.length`) → deploy throws
        // "<oldSlug> is not defined". Re-apply pagination so they regenerate
        // against the NEW slug (setPaginationInCode reads the new chain head).
        const pag = readPaginationMarker(out, mutation.parentNodeId);
        if (pag) {
          if (pag.mode === 'infinite') ensureSpinnerComponentFile();
          else ensureLoadMoreComponentFile();
          out = setPaginationInCode(out, mutation.parentNodeId, pag);
        }
        // Also sweep up any orphaned pagination hooks from previously-deleted
        // lists (they keep referencing a no-longer-imported slug → crash).
        return pruneOrphanedPaginationHooks(out);
      }
      case 'addMapItem':
        return addMapItemInCode(code, mutation.varName, mutation.item);
      case 'removeMapItem':
        return removeMapItemInCode(code, mutation.varName, mutation.index);
      case 'updateMapItem':
        return updateMapItemInCode(code, mutation.varName, mutation.index, mutation.item);
      case 'addMapField':
        return addMapFieldInCode(code, mutation.varName, mutation.fieldName, mutation.defaultValue);
      case 'bindStyleToMap':
        return bindStyleToMapInCode(code, mutation.nodeId, mutation.varName, mutation.styleProp, mutation.fieldName, mutation.currentValue);
      case 'unbindStyleFromMap':
        return unbindStyleFromMapInCode(code, mutation.nodeId, mutation.varName, mutation.styleProp, mutation.fieldName, mutation.inlineValue);
      case 'bindPropToMap':
        return bindPropToMapInCode(code, mutation.nodeId, mutation.varName, mutation.propName, mutation.fieldName, mutation.currentValue, mutation.urlWrap);
      case 'unbindPropFromMap':
        return unbindPropFromMapInCode(code, mutation.nodeId, mutation.propName);
      case 'clearCmsOrphan':
        return clearCmsOrphanInCode(code, mutation.nodeId, mutation.propName);

      case 'clearVarOrphan':
        return clearVarOrphanInCode(code, mutation.nodeId, mutation.target);

      // ─── Preset / Design Token mutations (write to app/globals.css, not page code) ──
      case 'addPresetToken':
        addPresetToken(mutation.token);
        return code;
      case 'updatePresetToken':
        updatePresetToken(mutation.name, mutation.value);
        return code;
      case 'removePresetToken':
        removePresetToken(mutation.name);
        return code;
      case 'setDarkTokenValue':
        setDarkTokenValue(mutation.tokenName, mutation.darkValue);
        return code;

      // ─── Overlay mutations ──────────────────────────────────────────────────
      case 'createOverlay':
        return mutation.canvasNode
          ? createCanvasOverlayInCode(code, mutation.triggerId, mutation.overlayId, mutation.overlayConfig, mutation.triggerConfig)
          : createOverlayInCode(code, mutation.triggerId, mutation.overlayId, mutation.overlayConfig, mutation.triggerConfig);
      case 'cloneCanvasOverlay':
        return cloneOverlayToCanvasTriggerInCode(code, mutation.sourceTriggerId, mutation.cloneTriggerId, mutation.vpWidth, mutation.variant);
      case 'updateOverlayPosition':
        return updateOverlayPositionInCode(code, mutation.overlayId, mutation.config);
      case 'updateOverlayConfig':
        return updateOverlayConfigInCode(code, mutation.overlayId, mutation.patch, mutation.vpWidth, mutation.resetKeys, mutation.breakpoints, mutation.variant);
      case 'updateOverlayTrigger':
        return updateOverlayTriggerInCode(code, mutation.triggerId, mutation.config);
      case 'removeOverlay':
        return removeOverlayInCode(code, mutation.overlayId, mutation.triggerId);

      // ─── Motion Text animation mutations ────────────────────────────────────
      case 'addTextAnim':
        return addTextAnimInCode(code, mutation.nodeId, mutation.config);
      case 'updateTextAnim':
        return updateTextAnimInCode(code, mutation.nodeId, mutation.config);
      case 'removeTextAnim':
        return removeTextAnimFromCode(code, mutation.nodeId);

      // ─── Website metadata mutations (write to app/layout.tsx) ───────────────
      // No longer auto-creates `app/LayoutClient.tsx` — the bare root client
      // wrapper was removed (pages render against `<body>{children}</body>`
      // directly). Templates carry their own LayoutClient inside their route
      // group; metadata always lives in the server `app/layout.tsx`.
      case 'updateMetadata': {
        if (!projectFS.exists('app/layout.tsx')) {
          projectFS.writeFile('app/layout.tsx', ensureLayoutFile());
        }
        const metaLayoutCode = projectFS.readFile('app/layout.tsx')!;
        const metaUpdated = updateMetadataInCode(metaLayoutCode, mutation.metadata);
        projectFS.writeFile('app/layout.tsx', metaUpdated);
        if (_activeFilePath === 'app/layout.tsx') return metaUpdated;
        return code;
      }
      case 'updateSiteConfig': {
        if (!projectFS.exists('app/layout.tsx')) {
          projectFS.writeFile('app/layout.tsx', ensureLayoutFile());
        }
        const configLayoutCode = projectFS.readFile('app/layout.tsx')!;
        const configUpdated = updateSiteConfigInCode(configLayoutCode, mutation.config);
        projectFS.writeFile('app/layout.tsx', configUpdated);
        if (_activeFilePath === 'app/layout.tsx') return configUpdated;
        return code;
      }

      // ─── File-level mutations (write/delete project files) ──────────────────
      case 'writeFile':
        projectFS.writeFile(mutation.filePath, mutation.content);
        // If writing the active file, clear stale canvas CSS and return new content
        if (mutation.filePath === _activeFilePath) {
          clearCanvasStyles();
          return mutation.content;
        }
        return code;
      case 'deleteFile':
        projectFS.deleteFile(mutation.filePath);
        return code;

      // ─── FIT text (SVG foreignObject wrap/unwrap) ───────────────────────────
      case 'wrapFitText':
        return wrapInFitSVGInCode(code, mutation.nodeId, mutation.viewBox);
      case 'unwrapFitText':
        return unwrapFitSVGInCode(code, mutation.nodeId);

      default:
        trace.error('mutation-queue', `Unknown mutation type: ${(mutation as any).type}`);
        return code;
    }
  } catch (err) {
    trace.error('mutation-queue:applyMutation-failed', { type: mutation.type, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}
