// FilterFieldPicker.tsx — standard field picker for adding a Collection List
// filter. A searchable dropdown of EVERY collection field; each field opens a
// flyout submenu offering a type-specific DYNAMIC input (Search Field for text,
// Checkbox for image/boolean, …) and a STATIC condition. This increment wires
// the STATIC path; the Dynamic options are shown (greyed) for the follow-up that
// creates the bound canvas input.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FieldDefinition } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

/** The type-specific dynamic input label (design-tool parity), or null when the field
 *  type has no meaningful dynamic control. */
function dynamicInputLabel(type: string | undefined): string | null {
  switch (type) {
    case 'text': case 'string': case 'richtext': case 'slug': return 'Search Field';
    case 'image': return 'Checkbox';       // "has image"
    case 'boolean': return 'Checkbox';
    case 'number': return 'Number Input';
    case 'date': return 'Date Picker';
    case 'enum': return 'Select';
    default: return null;
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  fields: FieldDefinition[];
  anchorRef: React.RefObject<HTMLElement | null>;
  /** STATIC condition for `fieldId` (wired). */
  onPickStatic: (fieldId: string) => void;
  /** DYNAMIC input for `fieldId` — creates a bound Search Field. Only offered for
   *  text fields (the implemented dynamic kind) and only when allowed (page base
   *  context). Absent → the Dynamic option renders greyed. */
  onPickDynamic?: (fieldId: string) => void;
}

/** Whether a field type supports a WIRED dynamic input today (Search Field for
 *  text-like fields). Other types still SHOW their dynamic label, but greyed. */
function dynamicWired(type: string | undefined): boolean {
  return dynamicInputLabel(type) === 'Search Field';
}

const ROW = 'group flex items-center justify-between mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap';
const ROW_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]';

/** One field row + its left-opening flyout (Dynamic option / Static). The
 *  Dynamic option is clickable only when `onDynamic` is supplied (currently the
 *  Search Field path for text fields); otherwise it shows greyed "coming soon". */
function FieldRow({ field, onStatic, onDynamic }: { field: FieldDefinition; onStatic: () => void; onDynamic?: () => void }) {
  const [showSub, setShowSub] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dyn = dynamicInputLabel(field.type);

  useEffect(() => {
    if (!showSub || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ x: r.left - 8, y: r.top });
  }, [showSub]);

  // The flyout is portaled to <body> — OUTSIDE the picker's ref — so without this
  // its mousedown bubbles to the picker's outside-click handler and closes the
  // picker before the click lands ("Static does nothing"). Stop it (capture).
  useEffect(() => {
    const el = portalRef.current;
    if (!el) return;
    const stop = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener('mousedown', stop, true);
    return () => el.removeEventListener('mousedown', stop, true);
  });

  return (
    <div onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
      <button ref={btnRef} type="button" className={ROW} onClick={() => setShowSub(v => !v)}>
        <span className={ROW_LABEL}>{field.name}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)] shrink-0 ml-2">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {showSub && createPortal(
        <div ref={portalRef} style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateX(-100%)', zIndex: 100031 }}
          onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
          <div style={{ position: 'absolute', top: 0, right: -12, width: 16, height: '100%' }} />
          {/* Same shell as the main dropdown: same py-1.5, inset rounded rows
              (ROW), bg-white/10 separator — NOT full-bleed edge-touching rows. */}
          <div className="min-w-[150px] bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1.5">
            {dyn && (
              <>
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] opacity-60">Dynamic</div>
                {onDynamic ? (
                  // Wired: creates the bound search <input> + page variable on the canvas.
                  <button type="button" className={ROW} onClick={() => { onDynamic(); }}>
                    <span className={ROW_LABEL}>{dyn}</span>
                  </button>
                ) : (
                  // Greyed (no hover): this field type's dynamic input isn't built yet.
                  <div className="mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] whitespace-nowrap opacity-40" title="Coming soon — creates a bound input on the canvas">
                    <span className={ROW_LABEL}>{dyn}</span>
                  </div>
                )}
                <div className="h-px bg-white/10 mx-2 my-1" />
              </>
            )}
            <button type="button" className={ROW} onClick={() => { onStatic(); }}>
              <span className={ROW_LABEL}>Static</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function FilterFieldPicker({ open, onClose, fields, anchorRef, onPickStatic, onPickDynamic }: Props) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const [visible, setVisible] = useState(false); // fade-in

  useEffect(() => {
    if (!open) { setQuery(''); setVisible(false); return; }
    const a = anchorRef.current?.getBoundingClientRect();
    if (a) {
      // Window-edge aware (like every other dropdown): clamp the box inside the
      // viewport so it never cuts off at the bottom/right; shift up + cap height
      // when there isn't room below.
      const M = 8, W = 240;
      const maxH = Math.min(420, window.innerHeight - M * 2);
      let top = a.bottom + 4;
      if (top + maxH > window.innerHeight - M) top = Math.max(M, window.innerHeight - M - maxH);
      let left = Math.min(a.left, window.innerWidth - W - M);
      left = Math.max(M, left);
      setPos({ left, top, maxH });
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    // Outside-click is handled by the context-menu backdrop below (not a
    // document listener) so the click that closes the picker is also SWALLOWED
    // — clicking the "Filters" row again closes the picker instead of the row's
    // onClick re-opening it on the same event.
    return () => { cancelAnimationFrame(raf); };
  }, [open, anchorRef]);

  if (!open || !pos) return null;

  const filtered = query.trim()
    ? fields.filter(f => f.name.toLowerCase().includes(query.trim().toLowerCase()))
    : fields;

  return createPortal(
    <>
      {/* Context-menu backdrop — above the ToolPopup (z 100001) but below the
          dropdown (100030). A mousedown here closes the picker AND is swallowed
          (prevent/stop) so the click never reaches the element behind it (e.g.
          the "Filters" row, which would otherwise re-open the picker). */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 100029 }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); trace.action('filter-field-picker:backdrop-close', {}); onClose(); }}
      />
      <div ref={ref} style={{ position: 'fixed', left: pos.left, top: pos.top, maxHeight: pos.maxH, zIndex: 100030, width: 240, opacity: visible ? 1 : 0 }}
      className="bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1.5 overflow-y-auto transition-opacity duration-150">
      {/* Inline search — icon + borderless input + separator (LeftHeader style). */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)] shrink-0">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Type to search…"
          className="flex-1 min-w-0 bg-transparent border-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none" />
      </div>
      {/* Separator — match the LeftHeader dropdown's hairline (bg-white/10), not
          the darker --border-light. */}
      <div className="h-px bg-white/10 mx-2 my-1" />
      {filtered.length === 0
        ? <div className="px-3 py-2 text-xs text-[var(--text-secondary)]">No fields</div>
        : filtered.map(f => (
            <FieldRow
              key={f.id}
              field={f}
              onStatic={() => { trace.action('filter-field-picker:static', { field: f.id }); onPickStatic(f.id); onClose(); }}
              onDynamic={onPickDynamic && dynamicWired(f.type)
                ? () => { trace.action('filter-field-picker:dynamic', { field: f.id }); onPickDynamic(f.id); onClose(); }
                : undefined}
            />
          ))}
      </div>
    </>,
    document.body,
  );
}
