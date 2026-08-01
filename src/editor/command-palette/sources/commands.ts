// sources/commands.ts — App-level verbs: undo, copy, zoom, wrap, …
//
// Every id here MUST have a matching branch in `useSearchActions.ts`'s
// `executeCommand()` switch. Adding a command means editing both — the
// switch has a `default` that toasts "Unknown command", so a mismatch
// shows up the first time the row is activated rather than at build time.

import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

const COMMANDS: Array<{
  id: string;
  name: string;
  shortcut?: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  // File / project
  { id: 'new-project',       name: 'New Project',         shortcut: '⌃⌥N', keywords: ['new', 'project', 'create', 'start'] },
  // Editing
  { id: 'undo',              name: 'Undo',                shortcut: '⌃Z',  keywords: ['undo', 'reverse', 'history', 'back'] },
  { id: 'redo',              name: 'Redo',                shortcut: '⌃⇧Z', keywords: ['redo', 'forward', 'history'] },
  { id: 'copy',              name: 'Copy',                shortcut: '⌃C',  keywords: ['copy', 'clipboard'] },
  { id: 'paste',             name: 'Paste',               shortcut: '⌃V',  keywords: ['paste', 'clipboard'] },
  { id: 'cut',               name: 'Cut',                 shortcut: '⌃X',  keywords: ['cut', 'clipboard'] },
  { id: 'duplicate',         name: 'Duplicate',           shortcut: '⌃D',  keywords: ['duplicate', 'copy'] },
  { id: 'delete',            name: 'Delete',              shortcut: '⌫',   keywords: ['delete', 'remove', 'trash'] },
  // Visibility / state toggles
  { id: 'toggle-lock',       name: 'Lock / Unlock',       shortcut: '⌃L',  keywords: ['lock', 'unlock', 'freeze'] },
  { id: 'toggle-visibility', name: 'Hide / Show',         shortcut: '⌃H',  keywords: ['hide', 'show', 'visibility'] },
  // Structure
  { id: 'wrap-in-frame',     name: 'Wrap in Frame',       shortcut: '⌥⇧A', keywords: ['wrap', 'frame', 'group', 'container'] },
  { id: 'wrap-in-layout',    name: 'Wrap in Layout',      shortcut: '⇧A',  keywords: ['wrap', 'layout', 'group', 'flex'] },
  { id: 'group-svgs',        name: 'Group SVGs',          shortcut: '⌃G',  keywords: ['group', 'svg', 'merge'] },
  { id: 'unfold-children',   name: 'Unfold Children',     shortcut: '⌃⌫',  keywords: ['unfold', 'unwrap', 'flatten', 'ungroup'] },
  // Zoom
  { id: 'zoom-in',           name: 'Zoom In',             shortcut: '⌃+',  keywords: ['zoom', 'in', 'magnify'] },
  { id: 'zoom-out',          name: 'Zoom Out',            shortcut: '⌃-',  keywords: ['zoom', 'out'] },
  { id: 'zoom-to-fit',       name: 'Zoom to Fit',         shortcut: '⇧1',  keywords: ['zoom', 'fit', 'fit all'] },
  { id: 'zoom-to-selection', name: 'Zoom to Selection',   shortcut: '⇧2',  keywords: ['zoom', 'selection', 'focus'] },
  { id: 'zoom-100',          name: 'Zoom to 100%',        shortcut: '⇧3',  keywords: ['zoom', '100', 'reset', 'actual size'] },
  // Selection
  { id: 'select-parent',     name: 'Select Parent',       shortcut: 'ESC', keywords: ['select', 'parent', 'up'] },
  { id: 'select-children',   name: 'Select Children',     shortcut: '↵',   keywords: ['select', 'children', 'down', 'into'] },
  { id: 'select-replica',    name: 'Select Replica',      shortcut: '⇧B',  keywords: ['select', 'replica', 'duplicate', 'instance'] },
];

export const commandsSource: SearchSource = () =>
  COMMANDS.map((cmd) => ({
    id: `cmd:${cmd.id}`,
    name: cmd.name,
    category: 'commands' as const,
    keywords: cmd.keywords,
    shortcut: cmd.shortcut,
    icon: cmd.icon ?? null,
    action: { type: 'execute-command' as const, commandId: cmd.id },
  }));
