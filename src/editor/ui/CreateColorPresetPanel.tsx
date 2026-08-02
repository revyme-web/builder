// CreateColorPresetPanel.tsx — Sliding panel for creating a new color preset.
// Pushed via ToolPopup.pushPanel from ColorPicker's "Create new color preset" button.
// Features: name input, Light/Dark theme toggle, ColorPicker, Create button.

import { useState, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import ToolSegmentedControl from '../controls/ToolSegmentedControl';
import ColorPicker from './ColorPicker';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import { PresetSunIcon, PresetMoonIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Initial color from the color picker that triggered this panel */
  initialColor: string;
  /** Called after preset is created (to close the panel, etc.) */
  onCreated?: () => void;
}

export default function CreateColorPresetPanel({ initialColor, onCreated }: Props) {
  const [name, setName] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [lightColor, setLightColor] = useState(initialColor || '#000000');
  const [darkColor, setDarkColor] = useState(initialColor || '#000000');
  // Light and dark are synced by default. Editing dark detaches them.
  const [synced, setSynced] = useState(true);

  const bumpVersion = useSetAtom(projectVersionAtom);

  const activeColor = theme === 'light' ? lightColor : darkColor;

  const handleColorChange = useCallback((newColor: string) => {
    if (theme === 'light') {
      setLightColor(newColor);
      if (synced) setDarkColor(newColor); // sync dark when still linked
    } else {
      setDarkColor(newColor);
      setSynced(false); // detach — user explicitly set dark color
    }
  }, [theme, synced]);

  const handleCreate = useCallback(() => {
    if (!name.trim()) return;

    const tokenName = 'color-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Add the light color token
    queueMutation({ type: 'addPresetToken', token: {
      name: tokenName,
      value: lightColor,
      category: 'color',
      label: name.trim(),
    } });

    // If dark color differs, add a dark variant
    // This writes to :root.dark { --color-name: darkValue; } in tokens.css
    if (darkColor !== lightColor) {
      queueMutation({ type: 'setDarkTokenValue', tokenName, darkValue: darkColor });
    }

    // Trigger derived atom refresh
    bumpVersion(v => v + 1);

    trace.action('create-color-preset:created', {
      name: tokenName,
      light: lightColor,
      dark: darkColor,
      hasDarkVariant: darkColor !== lightColor,
    });

    onCreated?.();
  }, [name, lightColor, darkColor, bumpVersion, onCreated]);

  trace.fn('CreateColorPresetPanel:render', { name, theme, lightColor, darkColor });

  return (
    <div className="flex flex-col gap-3">
      {/* Name input — uses raw <input> so onChange fires on every keystroke (ToolInput commits on blur) */}
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--border-focus)] rounded-[var(--radius-lg)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />

      {/* Light / Dark toggle */}
      <ToolSegmentedControl
        value={theme}
        onChange={(v) => setTheme(v as 'light' | 'dark')}
        options={[
          { value: 'light', icon: <PresetSunIcon /> },
          { value: 'dark', icon: <PresetMoonIcon /> },
        ]}
        size="sm"
      />

      {/* Color Picker for active theme */}
      <ColorPicker
        value={activeColor}
        onChange={handleColorChange}
        showAlpha
      />

      {/* Create button */}
      <button
        onClick={handleCreate}
        disabled={!name.trim()}
        className={`w-full h-[var(--control-height)] rounded-[var(--radius-lg)] text-xs font-medium transition-colors ${
          name.trim()
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Create
      </button>
    </div>
  );
}

// Icons imported from @/shared/icons (PresetSunIcon, PresetMoonIcon)
