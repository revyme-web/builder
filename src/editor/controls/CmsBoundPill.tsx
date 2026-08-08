// CmsBoundPill.tsx — Value-column pill shown when a property is bound to
// a CMS collection field. Same shape as VariableBoundPill (blue/accent
// instead of purple/accent-secondary) so the user sees at a glance which
// kind of binding they're looking at:
//
//   • purple pill ⟶ component variable (prop on the component file)
//   • blue   pill ⟶ CMS collection field
//
// Click the body → opens the same field-picker dropdown the menu uses
// (so re-binding a different field doesn't require navigating menus).
// Click × → unbinds, falling back to the static placeholder value.

import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useControl } from './ControlProvider';
import { fieldTypesForProperty } from './control-menu-items';
import { trace } from '@/shared/debug-trace';

interface CmsBoundPillProps {
  /** CSS / JSX property name (e.g. `'textContent'`, `'backgroundColor'`). */
  property: string;
  /** Static fallback to restore on unbind (current rendered value). */
  fallbackValue?: string;
  /**
   * Fired the instant × is pressed, with the value the row will fall back to.
   *
   * Unbinding swaps this pill out for the row's normal editor, but that swap
   * waits on the write → parse → mirror round-trip. Even at a few frames the
   * row visibly empties and the input animates in — the "glitch" a user sees
   * on ×. A host that holds the fallback optimistically re-renders the editor
   * in the SAME frame as the click, so there is no in-between state to see.
   */
  onUnbound?: (fallbackValue: string) => void;
}

/**
 * The human label for a CMS field ID. The JSX carries the field's ID
 * (`content={item.title}`), but every pill must show the schema's display NAME
 * ("Question") — so both pill variants resolve through this ONE function.
 *
 * They didn't before: the primary pill looked the name up while the replica
 * pill rendered `field` verbatim, so the same binding read "Question" on
 * desktop and "title" on tablet (user report 2026-08-08). Falls back to the id
 * when the schema has no matching field — a detached/renamed binding still
 * shows something recognisable rather than going blank.
 */
export function cmsFieldLabel(
  fields: ReadonlyArray<{ id: string; name?: string }> | undefined,
  fieldId: string,
): string {
  return fields?.find((f) => f.id === fieldId)?.name || fieldId;
}

export function CmsBoundPill({ property, fallbackValue, onUnbound }: CmsBoundPillProps) {
  const { cmsBinding } = useControl();
  const fieldId = cmsBinding?.getBindingForProperty(property);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  // Open / close keyboard handling — Escape closes the picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setPickerOpen(false); }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [pickerOpen]);

  // Filter the rebind picker to fields whose type fits this property —
  // mirrors the type-gated submenu in `getCmsBindingMenuItems`. Without
  // this the picker would offer (e.g.) a `text` field for `backgroundColor`,
  // which the generator would happily wire and produce broken JSX.
  const candidateFields = useMemo(() => {
    if (!cmsBinding) return [];
    const allowed = fieldTypesForProperty(property, cmsBinding.nodeTag);
    return cmsBinding.fields.filter(f => allowed.has(f.type));
  }, [cmsBinding, property]);

  // MUST be declared BEFORE the early return below. A hook after a conditional
  // return triggers React's "Rendered fewer hooks than expected" crash when the
  // pill re-renders with no `fieldId` — exactly what happens the instant × clears
  // the binding (the field disappears, so this would-be-skipped hook crashes).
  const handleUnbind = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cmsBinding) return;
    // Tell the host FIRST — it swaps in the static editor this frame, so the
    // pill→input transition has no empty intermediate to flash.
    onUnbound?.(fallbackValue ?? '');
    cmsBinding.unbindField(property, fallbackValue ?? '');
    trace.action('cms-bound-pill:unbind', { property });
  }, [cmsBinding, property, fallbackValue, onUnbound]);

  if (!cmsBinding || !fieldId) return null;

  const fieldName = cmsFieldLabel(cmsBinding.fields, fieldId);

  const openPicker = () => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuWidth = 200;
    const padding = 12;
    let x = rect.right + 4;
    if (x + menuWidth > window.innerWidth - padding) x = rect.left - menuWidth - 4;
    let y = rect.top;
    const estHeight = Math.min(candidateFields.length * 32 + 40, 320);
    if (y + estHeight > window.innerHeight - padding) {
      y = Math.max(padding, window.innerHeight - estHeight - padding);
    }
    setPickerPos({ x, y });
    setPickerOpen(true);
    trace.action('cms-bound-pill:open-picker', { property, fieldId });
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={openPicker}
        className="w-full min-w-0 h-8 flex items-center gap-1.5 pl-1 pr-2 bg-[var(--accent)] rounded-[var(--radius-lg)] border border-transparent bg-clip-padding text-xs font-medium text-[var(--accent-fg)] cursor-pointer transition-colors hover:opacity-90 truncate"
        title={`Bound to CMS field: ${fieldName} — click to change`}
      >
        <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--accent-fg)]">
          <CmsLinkIcon />
        </span>
        <span className="truncate flex-1 text-left">{fieldName}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={handleUnbind}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleUnbind(e as any); }}
          className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none shrink-0 cursor-pointer"
          title="Unbind from CMS field"
        >
          ×
        </span>
      </button>

      {pickerOpen && createPortal(
        <>
          <div className="fixed inset-0 z-[10000]" onClick={() => setPickerOpen(false)} />
          <div
            className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-[10001] min-w-[200px] max-h-[320px] overflow-y-auto border border-[var(--border-light)] space-y-0.5"
            style={{ left: pickerPos.x, top: pickerPos.y }}
          >
            <div className="px-3 py-1.5 text-[10px] font-bold text-[var(--text-disabled)] uppercase">
              Bind {property}
            </div>
            {candidateFields.map(f => (
              <button
                key={f.id}
                onClick={() => {
                  cmsBinding.bindToField(property, f.id);
                  setPickerOpen(false);
                  trace.action('cms-bound-pill:rebind', { property, from: fieldId, to: f.id });
                }}
                className={`w-[calc(100%-12px)] mx-1.5 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-left transition-colors ${
                  f.id === fieldId
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'hover:bg-[var(--accent)] text-[var(--text-primary)] hover:text-[var(--accent-fg)]'
                }`}
              >
                <span className="text-xs font-medium">{f.name}</span>
                {/* No explicit color — inherits the row's `currentColor`
                    (primary text when unselected, white on the accent
                    selected/hover state) and just dims it, so the type
                    label stays legible in every state and both themes. */}
                <span className="text-[10px] opacity-60">{f.type}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/**
 * "Missing" variant of the CMS pill — shown on a prop whose CMS binding was
 * REMEMBERED but is currently detached (the instance was dragged out of its
 * collection list, so the live `item.field` was stripped; see cms-detach-gen).
 * Same chrome as CmsBoundPill (pixel-identical) so it reads as "the same blue
 * pill, but its data source is gone" — exactly the reference's behaviour. Click × to
 * forget the binding (the prop reverts to the component default). Dropping the
 * instance back into a collection list re-binds it automatically.
 *
 * Standalone (no `useControl`) so it renders even when the node is fully
 * detached and there's no collection context to provide a binding.
 */
export function CmsMissingPill({ field, onClear }: { field: string; onClear: () => void }) {
  const handleClear = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onClear();
    trace.action('cms-missing-pill:clear', { field });
  };
  return (
    <div
      className="w-full min-w-0 h-8 flex items-center gap-1.5 pl-1 pr-2 bg-[var(--accent)] rounded-[var(--radius-lg)] border border-transparent bg-clip-padding text-xs font-medium text-[var(--accent-fg)] truncate"
      title={`Was bound to CMS field "${field}" — drop this into a collection list that has this field to reconnect`}
    >
      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--accent-fg)]">
        <CmsLinkIcon />
      </span>
      <span className="truncate flex-1 text-left">Missing</span>
      <span
        role="button"
        tabIndex={0}
        onClick={handleClear}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClear(e); }}
        className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none shrink-0 cursor-pointer"
        title="Clear — revert to the component default"
      >
        ×
      </span>
    </div>
  );
}

/**
 * Standalone presentational CMS-field pill (no `useControl` coupling) — shows a
 * field name + ×, identical chrome to CmsBoundPill. Used for PER-VIEWPORT
 * component-instance prop rebinds (the binding lives in `data-responsive`, not in
 * the node's `propBindings`, so the context-driven CmsBoundPill can't read it).
 * Click × → caller's `onUnbind` (per-viewport unbind→default); click body →
 * optional `onClick` (e.g. open the rebind picker).
 */
export function CmsFieldPill({ field, title, onUnbind, onClick }: { field: string; title?: string; onUnbind: () => void; onClick?: () => void }) {
  const handleUnbind = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onUnbind();
    trace.action('cms-field-pill:unbind', { field });
  };
  return (
    <div
      onClick={onClick}
      className={`w-full min-w-0 h-8 flex items-center gap-1.5 pl-1 pr-2 bg-[var(--accent)] rounded-[var(--radius-lg)] border border-transparent bg-clip-padding text-xs font-medium text-[var(--accent-fg)] truncate ${onClick ? 'cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
      title={title ?? `Bound to CMS field "${field}" for this viewport`}
    >
      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--accent-fg)]"><CmsLinkIcon /></span>
      <span className="truncate flex-1 text-left">{field}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={handleUnbind}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleUnbind(e); }}
        className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none shrink-0 cursor-pointer"
        title="Remove this viewport's binding (show the default)"
      >
        ×
      </span>
    </div>
  );
}

/**
 * Two-loop "link" glyph used as the CMS-binding indicator. Inherits color
 * from `currentColor` so it picks up the white text-color of the pill
 * (and any other surface that drops it in).
 */
function CmsLinkIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 6.1a.31.31 0 0 0-.45.32a2.47 2.47 0 0 0 .51 1.22l.15.13A3 3 0 0 1 9.08 10a3.63 3.63 0 0 1-3.55 3.44a3 3 0 0 1-2.11-.85a3 3 0 0 1-.85-2.22A3.55 3.55 0 0 1 3.63 8a3.66 3.66 0 0 1 1.5-.91A5.2 5.2 0 0 1 5 6v-.16a4.84 4.84 0 0 0-2.31 1.3a4.5 4.5 0 0 0-.2 6.37a4.16 4.16 0 0 0 3 1.22a4.8 4.8 0 0 0 3.38-1.42a4.52 4.52 0 0 0 .21-6.38A4.2 4.2 0 0 0 8 6.1"
      />
      <path
        fill="currentColor"
        d="M13.46 2.54a4.16 4.16 0 0 0-3-1.22a4.8 4.8 0 0 0-3.37 1.42a4.52 4.52 0 0 0-.21 6.38A4.2 4.2 0 0 0 8 9.9a.31.31 0 0 0 .45-.31a2.4 2.4 0 0 0-.52-1.23l-.15-.13A3 3 0 0 1 6.92 6a3.63 3.63 0 0 1 3.55-3.44a3 3 0 0 1 2.11.85a3 3 0 0 1 .85 2.22A3.55 3.55 0 0 1 12.37 8a3.66 3.66 0 0 1-1.5.91a5.2 5.2 0 0 1 .13 1.14v.16a4.84 4.84 0 0 0 2.31-1.3a4.5 4.5 0 0 0 .15-6.37"
      />
    </svg>
  );
}

