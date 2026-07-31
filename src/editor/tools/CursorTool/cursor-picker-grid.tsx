// cursor-picker-grid.tsx — The 4-column grid of every CSS cursor (icon + label, live `cursor:` preview on
// hover). Extracted from CursorTool so it can ALSO back the web-cursor VARIABLE editor (the grid popup a
// hoisted `cursor` variable shows) WITHOUT pulling CursorTool's heavy deps into the variable-editor-registry
// (which would cycle: registry → editor → CursorTool → VariableModal → registry).

import React from 'react';
import { CURSOR_ICONS, CURSOR_NAMES, cursorLabel } from './cursor-icons';

export function CursorPickerGrid({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1.5 max-h-[420px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      {CURSOR_NAMES.map((name) => {
        const Icon = CURSOR_ICONS[name];
        const isSelected = value === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            title={cursorLabel(name)}
            style={{ cursor: name }}
            className={`
              flex flex-col items-center justify-center gap-1 p-2 rounded-md border transition-colors
              ${isSelected
                ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                : 'bg-[var(--grid-line)] border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)]'
              }
            `}
          >
            <span className="flex items-center justify-center w-9 h-9">
              <Icon size={32} />
            </span>
            <span className={`text-[10px] truncate w-full text-center ${isSelected ? 'text-white' : 'text-[var(--text-secondary)]'}`}>
              {cursorLabel(name)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

