// ComponentPropsTool/VariablePresetPillRow.tsx — lifted verbatim from
// ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { projectVersionAtom } from '@/code/project/project-fs';
import type { PresetToken } from '@/shared/types';
import { ControlLabel } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import EditBorderPresetPanel from '../../ui/EditBorderPresetPanel';
import { groupBorderTokens } from '../../ui/border-preset-utils';
import { liveUpdatePresetToken } from '../../ui/preset-live-update';
import { formatPresetRefLabel } from './helpers';

/**
 * Blue preset pill for a variable row whose value is a preset reference.
 * Click BODY → opens a ToolPopup that EDITS the preset token itself (live,
 * propagates everywhere the preset is used) — same as the Styles tool's
 * preset pills. Click × → detaches the preset from this variable only.
 *
 * Edit surface:
 *   - border preset → `EditBorderPresetPanel` (compound group).
 *   - everything else → the prop's rich atom in `mode="preset"`, wired to
 *     `liveUpdatePresetToken` so dragging the editor updates the token value.
 */
export function VariablePresetPillRow({
  rowLabel, subLabel, plain, cssProp, presetRef, presetTokens, Atom, onDetach,
}: {
  rowLabel: string;
  subLabel?: string;
  plain: boolean;
  cssProp: string;
  presetRef: string;
  presetTokens: PresetToken[];
  Atom: React.ComponentType<any> | null;
  onDetach: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const bumpVersion = useSetAtom(projectVersionAtom);
  const tokenLabel = formatPresetRefLabel(presetRef, presetTokens);
  const isBorder = presetRef.startsWith('border-');
  const token = presetTokens.find(t => t.name === presetRef);
  const borderGroup = isBorder
    ? groupBorderTokens(presetTokens).find(g => g.name === presetRef.slice('border-'.length))
    : null;
  const canEdit = isBorder ? !!borderGroup : (!!Atom && !!token);

  // Live preset edit — paint the canvas immediately + debounce the version
  // bump (which fans out to every preset consumer). Mirrors ShadowPresetPillRow.
  const debouncedBump = useDebouncedCallback(() => bumpVersion(v => v + 1), 300);
  const handleEditChange = useCallback((newValue: string) => {
    liveUpdatePresetToken(presetRef, newValue);
    debouncedBump.call();
  }, [presetRef, debouncedBump]);
  useEffect(() => () => {
    debouncedBump.cancel();
    bumpVersion(v => v + 1);
  }, [bumpVersion, debouncedBump]);

  return (
    <>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={rowLabel} property={cssProp} plain={plain} subLabel={subLabel} />
        <button
          ref={anchorRef}
          onClick={() => { if (canEdit) setEditOpen(true); }}
          className="w-full h-8 flex items-center justify-between px-2 bg-[var(--accent)] rounded-[var(--radius-lg)] text-xs font-medium text-[var(--accent-fg)] cursor-pointer transition-colors hover:opacity-90 truncate"
          title={`Preset: ${tokenLabel} — click to edit, × to remove`}
        >
          <span className="truncate flex-1 text-left">{tokenLabel}</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onDetach(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDetach(); } }}
            className="ml-1 text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none shrink-0 cursor-pointer"
          >
            ×
          </span>
        </button>
      </div>
      {editOpen && canEdit && (
        <ToolPopup isOpen={editOpen} onClose={() => setEditOpen(false)} title={`Edit "${tokenLabel}"`} anchorRef={anchorRef} width={260}>
          {isBorder && borderGroup ? (
            <EditBorderPresetPanel group={borderGroup} />
          ) : Atom && token ? (
            <Atom mode="preset" externalValue={token.value} externalOnChange={handleEditChange} />
          ) : null}
        </ToolPopup>
      )}
    </>
  );
}
