// CreatePresetPopup.tsx — Generic "create new preset" popup invoked from
// ControlLabel's "Apply Preset" submenu. Mounts a name input + the editor
// matching the chosen category + a Save button. On save:
//   1. queueMutation addPresetToken (writes the new --token-name to tokens.css)
//   2. calls onApply(`var(--name)`) so the caller writes the reference into
//      its target property (e.g. boxShadow, border, padding) — applying the
//      brand-new preset to the node in the same gesture.
//
// The popup itself is a ToolPopup, so the inner editors that rely on the
// useToolPopup() context (ColorPicker / ShadowControl / etc.) all work.

import { useState, useCallback, useMemo, useRef } from 'react';
import { useSetAtom } from 'jotai';
import ToolPopup from './ToolPopup';
import ColorPicker from './ColorPicker';
import ToolInput from '../controls/ToolInput';
import ToolSelect from '../controls/ToolSelect';
import ColorInput from '../controls/ColorInput';
import ControlLabel from '../controls/ControlLabel';
import SpacingControl from '../controls/SpacingControl';
import { ShadowControl } from '../tools/StylesTool/atoms/ShadowControl';
import CreateImagePresetPanel from './CreateImagePresetPanel';
import CreateVideoPresetPanel from './CreateVideoPresetPanel';
import CreateBorderPresetPanel from './CreateBorderPresetPanel';
import { parseBorderShorthand, formatBorderShorthand, type BorderSide } from './border-utils';
import { parseShorthand } from '@/shared/css-utils';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

// ─── Defaults & helpers ─────────────────────────────────────────────────────

/** Per-category default starting value when the source property is empty. */
const CATEGORY_DEFAULTS: Record<PresetToken['category'], string> = {
  color: '#000000',
  typography: '16px',
  spacing: '16px',
  margin: '16px',
  radius: '8px',
  shadow: '0 2px 4px rgba(0,0,0,0.1)',
  border: '1px solid #000000',
  image: '',
  video: '',
  other: '',
};

const CATEGORY_PREFIXES: Record<PresetToken['category'], string> = {
  color: 'color', typography: 'typo', spacing: 'space', margin: 'margin',
  radius: 'radius', shadow: 'shadow', border: 'border', image: 'image',
  video: 'video', other: 'preset',
};

const CATEGORY_TITLES: Record<PresetToken['category'], string> = {
  color: 'Create color preset',
  typography: 'Create typography preset',
  spacing: 'Create padding preset',
  margin: 'Create margin preset',
  radius: 'Create radius preset',
  shadow: 'Create shadow preset',
  border: 'Create border preset',
  image: 'Create image preset',
  video: 'Create video preset',
  other: 'Create preset',
};

const BORDER_STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'double', label: 'Double' },
  { value: 'groove', label: 'Groove' },
  { value: 'ridge', label: 'Ridge' },
  { value: 'inset', label: 'Inset' },
  { value: 'outset', label: 'Outset' },
];

/** Sanitize a user name into a valid CSS variable segment (after the prefix). NOT cms-ops' slugify: this one hyphenates punctuation ('a.b' -> 'a-b', cms-ops deletes it) and has no 'untitled' fallback — ids/tokens generated here must stay stable. Do not merge (phase-9 9.1c). */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Build canonical 4-side shorthand from [T, R, B, L]. */
function formatShorthand([t, r, b, l]: [string, string, string, string]): string {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

// ─── Inner editor switch ────────────────────────────────────────────────────

function PresetValueEditor({ category, value, onChange }: {
  category: PresetToken['category'];
  value: string;
  onChange: (v: string) => void;
}) {
  if (category === 'color') {
    return <ColorPicker value={value || '#000000'} onChange={onChange} showAlpha />;
  }
  if (category === 'shadow') {
    return (
      <ShadowControl
        mode="preset"
        externalValue={value}
        externalOnChange={onChange}
      />
    );
  }
  if (category === 'border') {
    const side: BorderSide = parseBorderShorthand(value || '1px solid #000000');
    const update = (patch: Partial<BorderSide>) => {
      const next: BorderSide = { ...side, ...patch };
      if (next.width > 0 && (next.style === 'none' || !next.style)) next.style = 'solid';
      onChange(formatBorderShorthand(next));
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Width" property="borderWidth" plain />
          <ToolInput
            value={`${side.width}px`}
            onChange={(v) => update({ width: parseInt(v) || 0 })}
            step={1}
          />
        </div>
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Style" property="borderStyle" plain />
          <ToolSelect
            value={side.style || 'solid'}
            onChange={(v) => update({ style: v })}
            options={BORDER_STYLE_OPTIONS}
          />
        </div>
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Color" property="borderColor" plain />
          <ColorInput value={side.color} onChange={(v) => update({ color: v })} showAlpha />
        </div>
      </div>
    );
  }
  if (category === 'radius') {
    return (
      <SpacingControl
        values={[value, value, value, value] as [string, string, string, string]}
        labels={['TL', 'TR', 'BR', 'BL']}
        onChange={(_, val) => onChange(val)}
        onChangeAll={onChange}
      />
    );
  }
  if (category === 'spacing' || category === 'margin') {
    const sides = parseShorthand(value);
    return (
      <SpacingControl
        values={sides}
        labels={['T', 'R', 'B', 'L']}
        onChange={(idx, val) => {
          const next: [string, string, string, string] = [...sides];
          next[idx] = val;
          onChange(formatShorthand(next));
        }}
        onChangeAll={onChange}
      />
    );
  }
  // typography + other fallback — single text input.
  return <ToolInput value={value} onChange={onChange} />;
}

// ─── Main popup ─────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  category: PresetToken['category'];
  /** Anchor element for popup positioning. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Starting value for the editor (typically the current property value). */
  initialValue: string;
  /** Called with `var(--name)` after the token is created. The caller writes
   *  this to its target property to apply the new preset to the current node. */
  onApply: (varRef: string) => void;
  /** For compound presets (border) that span multiple CSS properties — caller
   *  receives a styles object to write all longhand var() refs at once.
   *  When omitted, compound flows fall back to applying nothing. */
  onApplyMultiple?: (styles: Record<string, string>) => void;
}

export default function CreatePresetPopup({ isOpen, onClose, category, anchorRef, initialValue, onApply, onApplyMultiple }: Props) {
  // Image and video presets have their own dedicated panels (with picker + thumbnail).
  // Reuse those instead of building parallel editors here.
  if (category === 'image' || category === 'video') {
    return (
      <ToolPopup isOpen={isOpen} onClose={onClose} title={CATEGORY_TITLES[category]} anchorRef={anchorRef} width={260}>
        {category === 'image' ? (
          <CreateImagePresetPanel
            initialValue={initialValue}
            onCreated={() => onClose()}
          />
        ) : (
          <CreateVideoPresetPanel
            initialValue={initialValue}
            onCreated={() => onClose()}
          />
        )}
      </ToolPopup>
    );
  }

  // Border is *compound* — one preset = a group of width/style/color (or
  // width/image-source/image-slice for gradient) tokens applied together.
  // The dedicated panel handles token creation AND the multi-property apply,
  // so it doesn't go through the generic single-value Save flow below.
  if (category === 'border') {
    return (
      <ToolPopup isOpen={isOpen} onClose={onClose} title={CATEGORY_TITLES.border} anchorRef={anchorRef} width={260}>
        <CreateBorderPresetPanel
          onApply={(styles) => onApplyMultiple?.(styles)}
          onClose={onClose}
        />
      </ToolPopup>
    );
  }

  return (
    <ToolPopup isOpen={isOpen} onClose={onClose} title={CATEGORY_TITLES[category]} anchorRef={anchorRef} width={260}>
      <CreatePresetPopupBody
        category={category}
        initialValue={initialValue}
        onClose={onClose}
        onApply={onApply}
      />
    </ToolPopup>
  );
}

function CreatePresetPopupBody({ category, initialValue, onClose, onApply }: {
  category: PresetToken['category'];
  initialValue: string;
  onClose: () => void;
  onApply: (varRef: string) => void;
}) {
  const initial = useMemo(
    () => initialValue || CATEGORY_DEFAULTS[category],
    [initialValue, category],
  );
  const [name, setName] = useState('');
  const [value, setValue] = useState(initial);
  const bumpVersion = useSetAtom(projectVersionAtom);
  const submittedRef = useRef(false);

  const handleSave = useCallback(() => {
    if (submittedRef.current) return;
    const slug = slugify(name);
    if (!slug || !value) return;
    submittedRef.current = true;
    const tokenName = `${CATEGORY_PREFIXES[category]}-${slug}`;
    queueMutation({ type: 'addPresetToken', token: {
      name: tokenName, value, category,
      label: name.trim(),
    } });
    bumpVersion(v => v + 1);
    trace.action('create-preset-popup:created', { category, tokenName, valueLength: value.length });
    // Apply the new preset to the calling control's property in the same gesture.
    onApply(`var(--${tokenName})`);
    onClose();
  }, [name, value, category, bumpVersion, onApply, onClose]);

  const canSave = !!name.trim() && !!value;

  trace.fn('CreatePresetPopup:render', { category, name, hasValue: !!value });

  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--border-focus)] rounded-[var(--radius-lg)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />

      <PresetValueEditor category={category} value={value} onChange={setValue} />

      <button
        onClick={handleSave}
        disabled={!canSave}
        className={`w-full h-8 rounded-[var(--radius-lg)] text-xs font-medium transition-colors ${
          canSave
            ? 'bg-[var(--accent)] text-white cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Save & Apply
      </button>
    </div>
  );
}
