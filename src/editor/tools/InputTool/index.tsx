// InputTool — Properties-panel tool for form controls (<input>/<textarea>/
// <select>). Mirrors the reference's Input panel: Type, Name, Placeholder, Required,
// and a "+" menu of extra attributes (Auto Fill / Auto Focus / Hidden / Max
// Length / Max / Min / Step / Value). Writes via changeTag + updateHtmlAttrs.
//
// Select "Options" (the <option> children editor) is a follow-up.

import React, { useState, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useAtomValue } from 'jotai';
import { useControl } from '../../controls/ControlProvider';
import { ToolSection, ToolRow, ToolSelect, ToolInput, ToolSegmentedControl, RemoveButton, EntryList } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import PageVariableChip from '../../controls/PageVariableChip';
import { parsePageVariables } from '@/code/features/page-variables';
import { codeAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { isReplicaViewportAtom, interactingViewportWidthAtom, isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { forceCanvasRender } from '@/canvas/node-ops';
import { parseResponsiveAttr, getResponsiveAttrAtViewport, getResponsiveAttrForVariant } from '@/code/generation/responsive-attrs-gen';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';
import { getI18nConfig } from '@/code/project/locale-ops';
import { commitTranslationAttr, readTranslationText } from '@/code/project/translation-ops';
import { getActiveFilePath } from '@/canvas/node-ops';

/** Blue "overridden on this viewport/variant" label style (matches ComponentPropsTool). */
const OVERRIDE_LABEL: React.CSSProperties = { color: 'var(--accent-text)', fontWeight: 600 };

/** flush the queue AND force the derived node map / canvas to refresh, so the
 *  tool re-reads fresh attrs on the next render (otherwise an edit appears to
 *  "revert" because the read came from a stale nodesAtom). */
function commitNow() { flushNow(); forceCanvasRender(); }

// Type dropdown → the (tag, type) the element should become.
const TYPE_OPTIONS: Array<{ value: string; label: string; tag: 'input' | 'textarea' | 'select'; type?: string }> = [
  { value: 'text', label: 'Text', tag: 'input', type: 'text' },
  { value: 'textarea', label: 'Text Area', tag: 'textarea' },
  { value: 'email', label: 'Email', tag: 'input', type: 'email' },
  { value: 'number', label: 'Number', tag: 'input', type: 'number' },
  { value: 'tel', label: 'Phone Number', tag: 'input', type: 'tel' },
  { value: 'url', label: 'URL', tag: 'input', type: 'url' },
  { value: 'date', label: 'Date', tag: 'input', type: 'date' },
  { value: 'time', label: 'Time', tag: 'input', type: 'time' },
  { value: 'select', label: 'Select', tag: 'select' },
];

// Extra props available behind the "+". `attr` = the JSX attribute name.
type ExtraKind = 'autoComplete' | 'autoFocus' | 'hidden' | 'maxLength' | 'max' | 'min' | 'step' | 'value';
const EXTRA_DEFS: Array<{ kind: ExtraKind; label: string; toggle?: boolean; numeric?: boolean }> = [
  { kind: 'autoComplete', label: 'Auto Fill', toggle: true },
  { kind: 'autoFocus', label: 'Auto Focus', toggle: true },
  { kind: 'hidden', label: 'Hidden', toggle: true },
  { kind: 'maxLength', label: 'Max Length', numeric: true },
  { kind: 'max', label: 'Max', numeric: true },
  { kind: 'min', label: 'Min', numeric: true },
  { kind: 'step', label: 'Step', numeric: true },
  { kind: 'value', label: 'Value' },
];

const ADD_ITEM = 'group flex items-center mx-1 px-2.5 py-1.5 rounded w-[calc(100%-8px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap disabled:opacity-40';
const ADD_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]';

function AddPropMenu({ available, onAdd }: { available: typeof EXTRA_DEFS; onAdd: (k: ExtraKind) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  if (available.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} title="Add property"
        className="flex items-center justify-center cursor-pointer group text-[var(--text-primary)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
            {available.map((d) => (
              <button key={d.kind} type="button" className={ADD_ITEM} onClick={() => { onAdd(d.kind); setOpen(false); }}>
                <span className={ADD_LABEL}>{d.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 20×20 select glyph chip for option rows.
function OptionChip() {
  return (
    <span className="flex items-center justify-center w-5 h-5 rounded shrink-0" style={{ backgroundColor: 'var(--grid-line)', color: 'var(--text-secondary)' }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
    </span>
  );
}

// Per-option editor. Holds LOCAL state seeded from the option node (re-seeded
// only when switching options) so a field never visually reverts while the code
// + derived nodes catch up. Each edit updates local state AND commits to code.
function OptionEditor({ opt, onChangeType, onSetValue, onSetTitle, onSetEnabled, onSetDefault }: {
  opt: CanvasNode;
  onChangeType: (isGroup: boolean) => void;
  onSetValue: (v: string) => void;
  onSetTitle: (v: string) => void;
  onSetEnabled: (yes: boolean) => void;
  onSetDefault: (yes: boolean) => void;
}) {
  const seed = () => ({
    isGroup: opt.type === 'optgroup',
    value: opt.attrs?.value ?? '',
    title: opt.textContent ?? '',
    enabled: !opt.attrs?.disabled,
    isDefault: !!opt.attrs?.selected,
  });
  const [v, setV] = useState(seed);
  // Re-seed on option switch AND on external code changes (undo while the
  // Option popup is open) — id-only left pre-undo value/title showing.
  // Own commits round-trip to identical seed values, so this never
  // disturbs mid-typing state (the sig only changes when code changed).
  const optSig = `${opt.id}|${opt.type}|${opt.attrs?.value ?? ''}|${opt.textContent ?? ''}|${opt.attrs?.disabled ?? ''}|${opt.attrs?.selected ?? ''}`;
  const prevOptSigRef = useRef(optSig);
  useEffect(() => {
    if (optSig === prevOptSigRef.current) return;
    prevOptSigRef.current = optSig;
    setV(seed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optSig]);
  return (
    <div className="flex flex-col gap-2 p-1">
      <ToolRow label="Type"><ToolSegmentedControl value={v.isGroup ? 'line' : 'text'} onChange={(x) => { const g = x === 'line'; setV((s) => ({ ...s, isGroup: g })); onChangeType(g); }} options={[{ value: 'text', label: 'Text' }, { value: 'line', label: 'Line' }]} /></ToolRow>
      <ToolRow label="Value"><ToolInput value={v.value} onChange={(x) => { setV((s) => ({ ...s, value: x })); onSetValue(x); }} text /></ToolRow>
      <ToolRow label="Title"><ToolInput value={v.title} onChange={(x) => { setV((s) => ({ ...s, title: x })); onSetTitle(x); }} text /></ToolRow>
      <ToolRow label="Enabled"><ToolSegmentedControl value={v.enabled ? 'yes' : 'no'} onChange={(x) => { const y = x === 'yes'; setV((s) => ({ ...s, enabled: y })); onSetEnabled(y); }} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></ToolRow>
      <ToolRow label="Default"><ToolSegmentedControl value={v.isDefault ? 'yes' : 'no'} onChange={(x) => { const y = x === 'yes'; setV((s) => ({ ...s, isDefault: y })); onSetDefault(y); }} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></ToolRow>
    </div>
  );
}

function newOptionId(): string {
  return `opt-${Math.floor(performance.now()).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export default function InputTool() {
  const { node } = useControl();
  const nodeId = node?.id ?? '';
  const code = useAtomValue(codeAtom);
  // Responsive axis context (mirrors ComponentPropsTool): on a page replica we
  // override per-viewport; on a non-default component variant we override
  // per-variant; otherwise we write the base. `type`/`name`/`placeholder` are
  // responsive (string attrs); the tag, required + extras stay global.
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);
  const isComponentVariant = useAtomValue(isComponentVariantViewportAtom);
  const activeVariant = useAtomValue(activeComponentVariantAtom);
  // Extras the user has revealed via "+" but not yet given a value (e.g. an
  // empty "Value" — updateHtmlAttrs can't write an empty attr, so track shown
  // rows here). Seeded from present attrs; re-seeded when a different node is selected.
  const [shown, setShown] = useState<Set<ExtraKind>>(new Set());
  const [editOption, setEditOption] = useState<number | null>(null);
  const optRowRef = useRef<HTMLElement | null>(null);
  useEffect(() => { setShown(new Set()); setEditOption(null); }, [nodeId]);

  // ─── Select options (<option>/<optgroup> children) — hook, so it lives
  // ABOVE the early return. Fine-grained: re-renders only when the resolved
  // option-node list actually changes.
  const optionNodes: CanvasNode[] = useNodesComputed(
    (nodes) => node?.type === 'select'
      ? (node.children ?? []).map((id) => nodes.get(id)).filter((o): o is CanvasNode => !!o && (o.type === 'option' || o.type === 'optgroup'))
      : [],
    [node],
  );

  if (!node || (node.type !== 'input' && node.type !== 'textarea' && node.type !== 'select')) return null;
  const attrs = node.attrs ?? {};

  const setAttrsOf = (id: string, a: Record<string, string>) => {
    if (!id) return;
    queueMutation({ type: 'updateHtmlAttrs', nodeId: id, attrs: a });
    commitNow();
    trace.action('input-tool:set-attrs', { id, keys: Object.keys(a) });
  };
  const setAttrs = (a: Record<string, string>) => setAttrsOf(nodeId, a);

  // ─── Responsive (per-viewport / per-variant) attr routing ───────────────────
  const respAxis: 'viewport' | 'variant' | 'base' =
    isReplica ? 'viewport'
    : (isComponentVariant && activeVariant && activeVariant !== 'default') ? 'variant'
    : 'base';
  /** Write a responsive-capable string attr through the active axis. */
  const writeAttr = (attr: string, value: string) => {
    if (!nodeId) return;
    // LOCALIZED attr (placeholder={t('…')} after a translation): route the
    // base write into the DEFAULT-locale message — an updateHtmlAttrs write
    // would replace the translation call with a plain string and orphan
    // every locale's value (localization overhaul Phase 3).
    if (respAxis === 'base' && node.attrTranslationKeys?.[attr] !== undefined) {
      const cfg = getI18nConfig();
      commitTranslationAttr({
        filePath: getActiveFilePath(), nodeId, attr, locale: cfg.defaultLocale,
        defaultLocale: cfg.defaultLocale, text: value, transformed: true,
      });
      commitNow();
      trace.action('input-tool:write-attr-localized', { nodeId, attr });
      return;
    }
    const base = attrs[attr] ?? '';
    if (respAxis === 'viewport') queueMutation({ type: 'setResponsiveAttr', nodeId, vpWidth, attr, value, baseValue: base });
    else if (respAxis === 'variant') queueMutation({ type: 'setVariantAttr', nodeId, variant: activeVariant!, attr, value, baseValue: base });
    else queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { [attr]: value } });
    commitNow();
    trace.action('input-tool:write-attr', { nodeId, attr, axis: respAxis });
  };
  /** The displayed value for an attr on the active axis (override or base).
   *  Localized attrs resolve from the default-locale message. */
  const displayAttr = (attr: string): string => {
    const tKey = node.attrTranslationKeys?.[attr];
    const base = tKey !== undefined
      ? (readTranslationText({ filePath: getActiveFilePath(), key: tKey, locale: getI18nConfig().defaultLocale }) ?? '')
      : (attrs[attr] ?? '');
    if (!code || !nodeId || respAxis === 'base') return base;
    return respAxis === 'viewport'
      ? getResponsiveAttrAtViewport(code, nodeId, attr, vpWidth)
      : getResponsiveAttrForVariant(code, nodeId, attr, activeVariant!);
  };
  /** Is this attr overridden on the active axis? (drives blue label + reset). */
  const isOverridden = (attr: string): boolean => {
    if (respAxis === 'base' || !code || !nodeId) return false;
    const r = parseResponsiveAttr(code, nodeId, attr);
    return respAxis === 'viewport' ? r.byViewport.has(vpWidth) : r.byVariant.has(activeVariant!);
  };
  const resetAttr = (attr: string) => writeAttr(attr, ''); // value '' clears the override
  /** ToolRow override props (blue label + reset menu) for a responsive attr. */
  const ov = (attr: string) => ({
    labelStyle: isOverridden(attr) ? OVERRIDE_LABEL : undefined,
    onResetOverride: isOverridden(attr) ? () => resetAttr(attr) : undefined,
  });

  const curType: string = node.type === 'textarea' ? 'textarea'
    : node.type === 'select' ? 'select'
    : (respAxis !== 'base' ? (displayAttr('type') || 'text') : (attrs.type || 'text'));

  const setType = (val: string) => {
    const def = TYPE_OPTIONS.find((o) => o.value === val);
    if (!def || !nodeId) return;
    // Leaving Select → drop any <option>/<optgroup> children. Orphaned on an
    // input (a void element) or textarea they're invalid HTML and crash/warn the
    // strict preview when the form is made into a component.
    if (node.type === 'select' && def.tag !== 'select') {
      const nodes = getNodesSnapshot();
      for (const childId of node.children ?? []) {
        const c = nodes.get(childId);
        if (c && (c.type === 'option' || c.type === 'optgroup')) queueMutation({ type: 'removeNode', nodeId: childId });
      }
    }
    // On a replica/variant, only the `type` ATTR is responsive (same <input>
    // tag). Cross-tag changes (Text Area / Select) aren't per-viewport — they
    // apply globally (the tag can't be media-query/variant-switched).
    const sameTagInput = def.tag === 'input' && node.type === 'input';
    if (respAxis !== 'base' && sameTagInput) {
      writeAttr('type', def.type ?? 'text');
      trace.action('input-tool:set-type-responsive', { nodeId, val, axis: respAxis });
      return;
    }
    if (node.type !== def.tag) queueMutation({ type: 'changeTag', nodeId, newTag: def.tag });
    // input → set type; textarea/select → remove type (empty string removes attr)
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { type: def.type ?? '' } });
    commitNow();
    trace.action('input-tool:set-type', { nodeId, val, tag: def.tag });
  };

  const isSelect = node.type === 'select';
  const isToggleOn = (k: string) => attrs[k] != null && attrs[k] !== 'false';
  const isExtraVisible = (k: ExtraKind) => attrs[k] != null || shown.has(k);
  const availableExtras = EXTRA_DEFS.filter((d) => !isExtraVisible(d.kind));

  const addExtra = (k: ExtraKind) => {
    const def = EXTRA_DEFS.find((d) => d.kind === k)!;
    setShown((s) => new Set(s).add(k));
    if (def.toggle) setAttrs({ [k]: 'true' });
    else if (def.numeric) setAttrs({ [k]: '0' });
    // text 'value' → no write yet; the row's input commits on blur.
  };
  const removeExtra = (k: ExtraKind) => {
    setShown((s) => { const n = new Set(s); n.delete(k); return n; });
    setAttrs({ [k]: '' });
  };

  // ─── Select options — `optionNodes` resolved above (hook, pre-early-return) ──
  const addOption = () => {
    if (!nodeId) return;
    queueMutation({ type: 'addNode', parentId: nodeId, node: { id: newOptionId(), type: 'option', styles: {}, attrs: { value: 'option' }, textContent: 'Option' } });
    commitNow();
    setEditOption(optionNodes.length);
    trace.action('input-tool:add-option', { nodeId });
  };
  const removeOption = (i: number) => {
    const o = optionNodes[i]; if (!o) return;
    queueMutation({ type: 'removeNode', nodeId: o.id });
    commitNow();
  };
  const optSetType = (i: number, isGroup: boolean) => { const o = optionNodes[i]; if (o) { queueMutation({ type: 'changeTag', nodeId: o.id, newTag: isGroup ? 'optgroup' : 'option' }); commitNow(); } };
  const optSetValue = (i: number, v: string) => { const o = optionNodes[i]; if (o) setAttrsOf(o.id, { value: v }); };
  const optSetTitle = (i: number, v: string) => { const o = optionNodes[i]; if (o) { queueMutation({ type: 'updateText', nodeId: o.id, text: v }); commitNow(); } };
  const optSetEnabled = (i: number, yes: boolean) => { const o = optionNodes[i]; if (o) setAttrsOf(o.id, { disabled: yes ? '' : 'true' }); };
  const optSetDefault = (i: number, yes: boolean) => { const o = optionNodes[i]; if (o) setAttrsOf(o.id, { selected: yes ? 'true' : '' }); };

  // ─── Search Field (CMS dynamic filter input) ───────────────────────────────
  // A different KIND of input than a form control: it's bound to a PAGE variable
  // that a Collection List filter reads. the reference shows it as just Variable +
  // Placeholder (no Type/Name/Required/Value), so we do the same. Detected via
  // the `data-search-field="<varName>"` marker OR (for inputs created before the
  // marker existed) a `value={var}` binding the parser stored as `var:<name>`.
  const searchVar = attrs['data-search-field']
    || (attrs.value?.startsWith('var:') ? attrs.value.slice(4) : undefined);
  if (searchVar) {
    // Dropdown: pick an EXISTING text page var that matches the input — so a Missing
    // input stays Missing until the user chooses one (design-tool parity). Rebinds via
    // mutation. No "create" — the user makes variables elsewhere, then binds here.
    const textVars = (parsePageVariables(code)?.variables ?? []).filter(v => v.type === 'text');
    const rebind = (varName: string) => {
      if (!nodeId) return;
      queueMutation({ type: 'setSearchInputVariable', inputId: nodeId, varName });
      commitNow();
      trace.action('input-tool:rebind-search-var', { nodeId, varName });
    };
    return (
      <ToolSection title="Input">
        <ToolRow label="Variable">
          <PageVariableChip
            name={searchVar}
            selectable={{ options: textVars.map(v => ({ name: v.name })), onSelect: rebind }}
          />
        </ToolRow>
        <ToolRow label="Placeholder" {...ov('placeholder')}>
          <ToolInput value={displayAttr('placeholder')} onChange={(v) => writeAttr('placeholder', v)} placeholder="Search..." />
        </ToolRow>
      </ToolSection>
    );
  }

  return (
    <ToolSection title="Input" action={<AddPropMenu available={availableExtras} onAdd={addExtra} />}>
      <ToolRow label="Type" {...ov('type')}>
        <ToolSelect value={curType} onChange={setType} options={TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      </ToolRow>

      <ToolRow label="Name" {...ov('name')}>
        <ToolInput value={displayAttr('name')} onChange={(v) => writeAttr('name', v)} placeholder="Name" />
      </ToolRow>

      {!isSelect && (
        <ToolRow label="Placeholder" {...ov('placeholder')}>
          <ToolInput value={displayAttr('placeholder')} onChange={(v) => writeAttr('placeholder', v)} placeholder="Enter text…" />
        </ToolRow>
      )}

      <ToolRow label="Required">
        <ToolSegmentedControl value={isToggleOn('required') ? 'yes' : 'no'} onChange={(v) => setAttrs({ required: v === 'yes' ? 'true' : '' })}
          options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
      </ToolRow>

      {/* Extra props (added via the "+") — each removable. */}
      {EXTRA_DEFS.filter((d) => isExtraVisible(d.kind)).map((d) => (
        <ToolRow key={d.kind} label={d.label}>
          <div className="flex items-center gap-1.5 w-full">
            {d.toggle ? (
              <ToolSegmentedControl value={isToggleOn(d.kind) ? 'yes' : 'no'} onChange={(v) => setAttrs({ [d.kind]: v === 'yes' ? 'true' : 'false' })}
                options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
            ) : (
              <ToolInput value={attrs[d.kind] ?? ''} onChange={(v) => setAttrs({ [d.kind]: v })} placeholder={d.label} text={!d.numeric} />
            )}
            <RemoveButton onClick={() => removeExtra(d.kind)} />
          </div>
        </ToolRow>
      ))}

      {/* Select → Options (the <option> children) */}
      {isSelect && (
        <EntryList<CanvasNode>
          label="Options"
          property="options"
          entries={optionNodes}
          onEdit={(i) => setEditOption(i)}
          onRemove={(i) => removeOption(i)}
          onAdd={addOption}
          renderIcon={() => <OptionChip />}
          renderSwatch={() => ({})}
          renderLabel={(o) => o.textContent || o.attrs?.value || 'Option'}
          addButtonRef={optRowRef}
          rowClassName="!pr-2"
          addLabel="Add…"
        />
      )}

      {editOption !== null && optionNodes[editOption] && (
        <ToolPopup isOpen onClose={() => setEditOption(null)} title="Option" anchorRef={optRowRef} width={240}>
          <OptionEditor
            opt={optionNodes[editOption]}
            onChangeType={(g) => optSetType(editOption, g)}
            onSetValue={(v) => optSetValue(editOption, v)}
            onSetTitle={(v) => optSetTitle(editOption, v)}
            onSetEnabled={(y) => optSetEnabled(editOption, y)}
            onSetDefault={(y) => optSetDefault(editOption, y)}
          />
        </ToolPopup>
      )}
    </ToolSection>
  );
}
