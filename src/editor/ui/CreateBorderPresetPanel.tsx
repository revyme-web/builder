// CreateBorderPresetPanel.tsx — Create-flow for COMPOUND border presets.
// One preset = a group of 3+ tokens (width/style/color for solid, or
// width/image-source/image-slice for gradient) sharing a common slug.
// Mirrors the typography preset model, just with a smaller fixed schema.
//
// On Save & Apply:
//   1. queueMutation('addPresetToken') for each facet of the chosen flavor
//   2. bumpVersion so derived atoms see the new tokens
//   3. onApply(buildBorderApplyStyles(group)) — caller writes all the var()
//      refs to the active node's longhands in one shot.

import { useState, useCallback, useRef } from 'react';
import { useSetAtom } from 'jotai';
import ToolInput from '../controls/ToolInput';
import ToolSelect from '../controls/ToolSelect';
import ToolSegmentedControl from '../controls/ToolSegmentedControl';
import ColorInput from '../controls/ColorInput';
import ControlLabel from '../controls/ControlLabel';
import GradientEditor from './GradientEditor';
import { parseGradient, formatGradient, createDefaultGradient } from '@/shared/gradient-utils';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import {
  createDefaultSolidBorderTokens, createDefaultGradientBorderTokens,
  buildBorderApplyStyles, type BorderGroup,
} from './border-preset-utils';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

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

/** Sanitize a user name into a CSS variable segment (mirrors CreatePresetPopup). NOT cms-ops' slugify: this one hyphenates punctuation ('a.b' -> 'a-b', cms-ops deletes it) and has no 'untitled' fallback — ids/tokens generated here must stay stable. Do not merge (phase-9 9.1c). */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface Props {
  /** Called with the styles object that applies the new compound preset to
   *  the calling control's node (multi-property `var()` refs). */
  onApply: (styles: Record<string, string>) => void;
  onClose: () => void;
}

export default function CreateBorderPresetPanel({ onApply, onClose }: Props) {
  const [name, setName] = useState('');
  const [flavor, setFlavor] = useState<'solid' | 'gradient'>('solid');

  // Solid facets.
  const [width, setWidth] = useState('1px');
  const [style, setStyle] = useState('solid');
  const [color, setColor] = useState('#000000');

  // Gradient facets.
  const [gradient, setGradient] = useState(() => createDefaultGradient());
  const [gradWidth, setGradWidth] = useState('2px');

  const bumpVersion = useSetAtom(projectVersionAtom);
  const submittedRef = useRef(false);

  const canSave = !!name.trim();

  const handleSave = useCallback(() => {
    if (submittedRef.current || !canSave) return;
    const slug = slugify(name);
    if (!slug) return;
    submittedRef.current = true;

    let tokens: PresetToken[];
    if (flavor === 'gradient') {
      tokens = createDefaultGradientBorderTokens(slug);
      // Override the defaults with whatever the user configured.
      const map = new Map(tokens.map(t => [t.name, t] as const));
      const w = map.get(`border-${slug}-width`)!;        w.value = gradWidth;
      const src = map.get(`border-${slug}-image-source`)!; src.value = formatGradient(gradient);
      // image-slice keeps its '1' default.
    } else {
      tokens = createDefaultSolidBorderTokens(slug);
      const map = new Map(tokens.map(t => [t.name, t] as const));
      map.get(`border-${slug}-width`)!.value = width;
      map.get(`border-${slug}-style`)!.value = style;
      map.get(`border-${slug}-color`)!.value = color;
    }

    // First token in the group gets the human label so the row shows it
    // nicely in the panel.
    tokens[0] = { ...tokens[0], label: name.trim() };

    for (const t of tokens) {
      queueMutation({ type: 'addPresetToken', token: t });
    }
    bumpVersion(v => v + 1);
    trace.action('create-border-preset:created', { slug, flavor, tokenCount: tokens.length });

    // Apply to the active node by writing all the var() refs at once. We
    // synthesize the BorderGroup shape buildBorderApplyStyles expects.
    const fakeGroup: BorderGroup = { name: slug, label: name.trim(), tokens, flavor };
    onApply(buildBorderApplyStyles(fakeGroup));
    onClose();
  }, [name, flavor, width, style, color, gradWidth, gradient, canSave, bumpVersion, onApply, onClose]);

  trace.fn('CreateBorderPresetPanel:render', { name, flavor });

  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] focus:border-[var(--border-focus)] cut-corners cut-border focus:[--cut-border-color:var(--border-focus)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />

      <ToolSegmentedControl
        value={flavor}
        onChange={(v) => setFlavor(v as 'solid' | 'gradient')}
        options={[{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }]}
        size="sm"
      />

      {flavor === 'solid' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Width" property="borderWidth" plain />
            <ToolInput value={width} onChange={setWidth} step={1} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Style" property="borderStyle" plain />
            <ToolSelect value={style} onChange={setStyle} options={BORDER_STYLE_OPTIONS} />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Color" property="borderColor" plain />
            <ColorInput value={color} onChange={setColor} showAlpha />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Width" property="borderWidth" plain />
            <ToolInput value={gradWidth} onChange={setGradWidth} step={1} />
          </div>
          <GradientEditor value={formatGradient(gradient)} onChange={(css) => {
            const next = parseGradient(css);
            if (next) setGradient(next);
          }} />
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={!canSave}
        className={`w-full h-[var(--control-height)] cut-corners text-xs font-medium transition-colors ${
          canSave
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Save & Apply
      </button>
    </div>
  );
}
