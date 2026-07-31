// CreatePresetInline — inline "+ new preset" name input row.

import React, { useState } from 'react';
import type { CategoryConfig } from '../shared/types';

interface CreatePresetInlineProps {
  category: CategoryConfig;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function CreatePresetInline({ category, onSubmit, onCancel }: CreatePresetInlineProps) {
  const [name, setName] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && name.trim()) {
      onSubmit(name.trim());
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!name.trim()) onCancel(); }}
        placeholder={`New ${category.label.toLowerCase()} name...`}
        className="flex-1 bg-[var(--grid-line)] border border-[var(--control-border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-[var(--border-focus)]"
      />
      <button
        onClick={() => name.trim() && onSubmit(name.trim())}
        className="text-[10px] font-medium text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors px-1"
      >
        Add
      </button>
    </div>
  );
}
