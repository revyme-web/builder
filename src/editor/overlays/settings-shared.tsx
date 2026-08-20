// settings-shared.tsx — Primitives for the borderless-row settings layout.
//
// Ported from revyme-cloud's dashboard settings so the editor's
// SettingsOverlay and the cloud dashboard share one visual language:
// groups of labelled rows separated by hairline dividers, no card chrome,
// inputs that sit flush in the row. All colors flow through CSS variables
// (--text-*, --bg-hover, --border-light, --accent) so the same components
// render correctly in light and dark mode.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { trace } from '@/shared/debug-trace';
import { FlagIcon } from '@/shared/flag-icon';

// ─── LoadingSpinner ────────────────────────────────────────────────────────

/** Inline spinner used by the SaveButton and section-level async buttons. */
export function SettingsSpinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────────────

/** Pulsing placeholder bar shown in a SettingsRow while its data is still
 *  being fetched. Size it with `className` (h-/w-) so the row doesn't jump
 *  when the real value swaps in. */
export function Skeleton({ className = 'h-5 w-40' }: { className?: string }) {
  return <span className={`block animate-pulse rounded bg-[var(--bg-hover)] ${className}`} />;
}

// ─── SettingsGroup ─────────────────────────────────────────────────────────

/** Groups a header (title + optional action) above a stack of rows.
 *  Rows are visually separated by `divide-y` hairlines using the
 *  --border-light token — same on both themes. */
export function SettingsGroup({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      {(title || action) && (
        <div className="flex items-center justify-between px-3 py-3">
          {title ? (
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      <div className="divide-y divide-[var(--border-light)]">{children}</div>
    </section>
  );
}

// ─── SettingsRow ───────────────────────────────────────────────────────────

/** A labelled row. Label sits in a fixed-width column on desktop and
 *  stacks above the value on mobile. Hover effect is applied by default;
 *  pass `interactive={false}` for read-only rows (helper text, "no items"
 *  empty states) so they don't react to the cursor. */
export function SettingsRow({
  label,
  htmlFor,
  align = 'center',
  interactive = true,
  children,
}: {
  label: string;
  htmlFor?: string;
  align?: 'center' | 'top';
  interactive?: boolean;
  children: ReactNode;
}) {
  const itemsCls = align === 'top' ? 'sm:items-start' : 'sm:items-center';
  const hoverCls = interactive ? 'transition-colors hover:bg-[var(--bg-hover)]/40' : '';
  return (
    <div className={`flex flex-col sm:flex-row gap-1 sm:gap-4 px-3 py-3 ${hoverCls} ${itemsCls}`}>
      <label
        htmlFor={htmlFor}
        className={`w-full sm:w-44 shrink-0 text-sm text-[var(--text-secondary)] ${
          align === 'top' ? 'sm:pt-1.5' : ''
        }`}
      >
        {label}
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ─── ROW_INPUT_CLS ─────────────────────────────────────────────────────────

/** Classes for a borderless input meant to sit inside a SettingsRow.
 *  Sits flush against the row's hover background. */
export const ROW_INPUT_CLS =
  'w-full bg-transparent border-0 outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:placeholder:text-[var(--text-disabled)] px-0 py-1';

// ─── SaveButton ────────────────────────────────────────────────────────────

/** Pill Save button for SettingsGroup headers. Three states: disabled
 *  (no changes), enabled (dirty), saving (in flight). */
export function SaveButton({
  onClick,
  saving,
  dirty,
  label = 'Save',
}: {
  onClick: () => void;
  saving: boolean;
  dirty: boolean;
  label?: string;
}) {
  const enabled = dirty && !saving;
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      className={`px-4 rounded-full text-xs font-medium min-w-[72px] h-[30px] flex items-center justify-center transition-all ${
        saving
          ? 'bg-[var(--accent)]/50 text-[var(--accent-fg)] cursor-not-allowed'
          : enabled
            ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)]'
            : 'bg-[var(--bg-hover)] text-[var(--text-disabled)] cursor-not-allowed'
      }`}
    >
      {saving ? <SettingsSpinner /> : label}
    </button>
  );
}

// ─── Toggle ────────────────────────────────────────────────────────────────

/** Pill toggle for boolean rows. */
export function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors ${
        value ? 'bg-[var(--accent)]' : 'bg-[var(--bg-active)]'
      }`}
      aria-pressed={value}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
          value ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ─── RowButton ─────────────────────────────────────────────────────────────

/** Compact secondary button for in-row actions (Upload, Remove, Connect…).
 *  `variant="danger"` tints it red for destructive actions. */
export function RowButton({
  onClick,
  disabled,
  loading,
  variant = 'default',
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'default' | 'danger' | 'accent';
  title?: string;
  children: ReactNode;
}) {
  const tint =
    variant === 'danger'
      ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400'
      : variant === 'accent'
        ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)]'
        : 'bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] text-[var(--text-primary)]';
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 px-3 h-[30px] rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tint}`}
    >
      {loading ? <SettingsSpinner /> : children}
    </button>
  );
}

// ─── RowSelect ─────────────────────────────────────────────────────────────

export interface RowSelectOption {
  value: string;
  label: string;
  /** Optional leading visual — e.g. a country flag for the language row. */
  icon?: ReactNode;
}

/** Themed replacement for a native `<select>` inside a SettingsRow.
 *
 *  A native `<select>` can't have its option list styled — the OS draws it
 *  (a glaring white box in dark mode). This renders the trigger flush in
 *  the row like ROW_INPUT_CLS, and a compact themed popup (portal +
 *  fixed-positioned so the overlay's `overflow:auto` can't clip it) that
 *  closes on outside-click, Escape, scroll, or resize. */
export function RowSelect({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select…',
}: {
  id?: string;
  value: string;
  options: RowSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());

    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // An *outside* scroll invalidates the cached trigger rect, so close.
    // But scrolling *inside* the popup itself must NOT close it — the
    // `scroll` event fires here (capture phase) with the popup as target,
    // so ignore those or the list becomes impossible to scroll.
    const onScroll = (e: Event) => {
      if (popupRef.current && popupRef.current.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        onClick={() => {
          trace.action('row-select:toggle', { id, open: !open });
          setOpen((o) => !o);
        }}
        className="w-full flex items-center justify-between gap-2 bg-transparent border-0 outline-none text-sm px-0 py-1 cursor-pointer"
      >
        <span
          className={`flex items-center gap-2 min-w-0 ${
            selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'
          }`}
        >
          {selected?.icon}
          <span className="truncate">{selected ? selected.label : placeholder}</span>
        </span>
        <svg
          className={`w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && rect &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[10010]" onClick={() => setOpen(false)} />
            <div
              ref={popupRef}
              className="fixed z-[10011] max-h-[280px] overflow-y-auto cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--dropdown-bg)] shadow-lg py-1"
              style={{
                left: rect.left,
                top: rect.bottom + 4,
                width: Math.min(Math.max(rect.width, 180), 260),
              }}
            >
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    trace.action('row-select:change', { id, from: value, to: opt.value });
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm transition-colors ${
                    opt.value === value
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {opt.icon}
                  <span className="truncate">{opt.label}</span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

// ─── ConfirmModal ──────────────────────────────────────────────────────────

/** Shared confirm dialog used across the settings overlay (domain removals,
 *  workspace deletes, favicon clears, etc).
 *
 *  Design system match: same compact layout as the Backups + Staging
 *  confirm modals — portal, framer-motion enter/exit, header with title
 *  + close X + border-b, body text in p-3, two equal-width footer
 *  buttons. Escape + outside-click close (when not isLoading); X button
 *  disabled while running.
 *
 *  Variants:
 *    'danger' — red primary button (destructive — delete, remove,
 *               disconnect, etc.)
 *    'default' — accent primary button (constructive — proceed,
 *                confirm, etc.)
 */
export function ConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading,
}: {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'default';
  isLoading?: boolean;
}) {
  // Escape closes — but only when NOT in-flight, so an accidental
  // Escape can't bail mid-action and leave UI state inconsistent.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, isLoading, onCancel]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 99999 }}
          onClick={isLoading ? undefined : onCancel}
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/40"
          />
          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="relative w-80 bg-[var(--bg-surface)] cut-corners cut-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-light)]">
              <h3 className="text-xs font-bold text-[var(--text-primary)]">{title}</h3>
              <button
                onClick={onCancel}
                disabled={isLoading}
                className="p-1 hover:bg-[var(--bg-hover)] cut-corners transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-3 flex flex-col gap-3">
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{message}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onCancel}
                  disabled={isLoading}
                  className="flex-1 h-[var(--control-height)] text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] cut-corners transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  {cancelText}
                </button>
                <button
                  onClick={onConfirm}
                  disabled={isLoading}
                  className={`flex-1 h-8 px-3 text-xs cut-corners font-medium flex items-center justify-center text-[var(--accent-fg)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer ${
                    variant === 'danger'
                      ? 'bg-red-500/90 hover:bg-red-500'
                      : 'bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))]'
                  }`}
                >
                  {isLoading ? `${confirmText.replace(/e$/, '')}ing…` : confirmText}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Language options ───────────────────────────────────────

/** Languages offered by the Website settings "Default language" row, each
 *  paired with a representative country flag. Tuples: [code, label, countryCode]. */
export const LANGUAGE_OPTIONS: RowSelectOption[] = (
  [
    ['en', 'English', 'gb'],
    ['es', 'Spanish', 'es'],
    ['fr', 'French', 'fr'],
    ['de', 'German', 'de'],
    ['pt', 'Portuguese', 'pt'],
    ['it', 'Italian', 'it'],
    ['ja', 'Japanese', 'jp'],
    ['zh', 'Chinese', 'cn'],
    ['ar', 'Arabic', 'sa'],
    ['hi', 'Hindi', 'in'],
    ['ru', 'Russian', 'ru'],
    ['ko', 'Korean', 'kr'],
    ['nl', 'Dutch', 'nl'],
    ['sv', 'Swedish', 'se'],
    ['no', 'Norwegian', 'no'],
    ['da', 'Danish', 'dk'],
    ['fi', 'Finnish', 'fi'],
    ['pl', 'Polish', 'pl'],
    ['tr', 'Turkish', 'tr'],
    ['th', 'Thai', 'th'],
    ['vi', 'Vietnamese', 'vn'],
    ['id', 'Indonesian', 'id'],
    ['ms', 'Malay', 'my'],
    ['uk', 'Ukrainian', 'ua'],
    ['cs', 'Czech', 'cz'],
    ['ro', 'Romanian', 'ro'],
    ['el', 'Greek', 'gr'],
    ['hu', 'Hungarian', 'hu'],
    ['he', 'Hebrew', 'il'],
    ['fa', 'Persian', 'ir'],
    ['bn', 'Bengali', 'bd'],
    ['ur', 'Urdu', 'pk'],
    ['af', 'Afrikaans', 'za'],
    ['sq', 'Albanian', 'al'],
    ['am', 'Amharic', 'et'],
    ['hy', 'Armenian', 'am'],
    ['az', 'Azerbaijani', 'az'],
    ['eu', 'Basque', 'es'],
    ['be', 'Belarusian', 'by'],
    ['bs', 'Bosnian', 'ba'],
    ['bg', 'Bulgarian', 'bg'],
    ['ca', 'Catalan', 'es'],
    ['hr', 'Croatian', 'hr'],
    ['et', 'Estonian', 'ee'],
    ['tl', 'Tagalog', 'ph'],
    ['gl', 'Galician', 'es'],
    ['ka', 'Georgian', 'ge'],
    ['gu', 'Gujarati', 'in'],
    ['ht', 'Haitian Creole', 'ht'],
    ['ha', 'Hausa', 'ng'],
    ['is', 'Icelandic', 'is'],
    ['ig', 'Igbo', 'ng'],
    ['ga', 'Irish', 'ie'],
    ['jv', 'Javanese', 'id'],
    ['kn', 'Kannada', 'in'],
    ['kk', 'Kazakh', 'kz'],
    ['km', 'Khmer', 'kh'],
    ['rw', 'Kinyarwanda', 'rw'],
    ['ky', 'Kyrgyz', 'kg'],
    ['lo', 'Lao', 'la'],
    ['la', 'Latin', 'va'],
    ['lv', 'Latvian', 'lv'],
    ['lt', 'Lithuanian', 'lt'],
    ['lb', 'Luxembourgish', 'lu'],
    ['mk', 'Macedonian', 'mk'],
    ['mg', 'Malagasy', 'mg'],
    ['ml', 'Malayalam', 'in'],
    ['mt', 'Maltese', 'mt'],
    ['mi', 'Maori', 'nz'],
    ['mr', 'Marathi', 'in'],
    ['mn', 'Mongolian', 'mn'],
    ['my', 'Burmese', 'mm'],
    ['ne', 'Nepali', 'np'],
    ['pa', 'Punjabi', 'in'],
    ['ps', 'Pashto', 'af'],
    ['sa', 'Sanskrit', 'in'],
    ['sr', 'Serbian', 'rs'],
    ['sd', 'Sindhi', 'pk'],
    ['si', 'Sinhala', 'lk'],
    ['sk', 'Slovak', 'sk'],
    ['sl', 'Slovenian', 'si'],
    ['so', 'Somali', 'so'],
    ['sw', 'Swahili', 'ke'],
    ['ta', 'Tamil', 'in'],
    ['te', 'Telugu', 'in'],
    ['bo', 'Tibetan', 'cn'],
    ['tk', 'Turkmen', 'tm'],
    ['ug', 'Uighur', 'cn'],
    ['uz', 'Uzbek', 'uz'],
    ['cy', 'Welsh', 'gb'],
    ['xh', 'Xhosa', 'za'],
    ['yi', 'Yiddish', 'il'],
    ['yo', 'Yoruba', 'ng'],
    ['zu', 'Zulu', 'za'],
  ] as Array<[string, string, string]>
).map(([value, label, cc]) => ({
  value,
  label,
  icon: <FlagIcon code={cc} />,
}));
