// variable-types.ts — The standard variable TYPE taxonomy for the "+" type picker.
//
// A variable is a typed component prop. Some types drive CSS (Color/Border/Shadow/Cursor/Transition);
// the rest are arbitrary data the component reads (Text/Number/Option/Toggle/Date/Link/Image/File/Event).
// Each entry declares: the picker label, its filled icon, the default literal + its JS literal kind
// (so codegen writes `5` not `"5"` for numbers, `true` for toggles), and which Default-row editor to use
// — `'style'` reuses the existing control-registry editor at `controlProperty`, the rest are primitives.

import type { VariableIconKey } from './VariableTypeIcon';

export type VariableTypeId =
  | 'plainText' | 'formattedText' | 'number' | 'toggle' | 'option' | 'color'
  | 'date' | 'link' | 'image' | 'file' | 'event' | 'transition' | 'border' | 'shadow'
  | 'componentCursor';

type LiteralKind = 'string' | 'number' | 'boolean';
type DefaultEditor = 'text' | 'textarea' | 'number' | 'toggle' | 'option' | 'style' | 'componentCursor' | 'none';

export interface VariableTypeDef {
  id: VariableTypeId;
  label: string;
  iconKey: VariableIconKey;
  literalKind: LiteralKind;
  defaultValue: string;
  editor: DefaultEditor;
  /** For `editor: 'style'` — the CSS property whose control-registry editor renders the default. */
  controlProperty?: string;
  /** False = NOT offered in the "+" type picker (created by a dedicated flow). Defaults to pickable. */
  pickable?: boolean;
}

// Ordered to match the reference's picker.
export const VARIABLE_TYPES: VariableTypeDef[] = [
  { id: 'plainText',     label: 'Plain Text',     iconKey: 'text',       literalKind: 'string',  defaultValue: '',                              editor: 'text' },
  { id: 'formattedText', label: 'Formatted Text', iconKey: 'text',       literalKind: 'string',  defaultValue: '',                              editor: 'textarea' },
  { id: 'date',          label: 'Date',           iconKey: 'date',       literalKind: 'string',  defaultValue: '',                              editor: 'text' },
  { id: 'link',          label: 'Link',           iconKey: 'link',       literalKind: 'string',  defaultValue: '',                              editor: 'text' },
  { id: 'image',         label: 'Image',          iconKey: 'image',      literalKind: 'string',  defaultValue: '',                              editor: 'style', controlProperty: 'backgroundImage' },
  { id: 'color',         label: 'Color',          iconKey: 'color',      literalKind: 'string',  defaultValue: '#000000',                       editor: 'style', controlProperty: 'backgroundColor' },
  { id: 'toggle',        label: 'Toggle',         iconKey: 'boolean',    literalKind: 'boolean', defaultValue: 'false',                         editor: 'toggle' },
  { id: 'number',        label: 'Number',         iconKey: 'number',     literalKind: 'number',  defaultValue: '0',                             editor: 'number' },
  { id: 'option',        label: 'Option',         iconKey: 'option',     literalKind: 'string',  defaultValue: '',                              editor: 'option' },
  { id: 'event',         label: 'Event',          iconKey: 'event',      literalKind: 'string',  defaultValue: '',                              editor: 'none' },
  { id: 'file',          label: 'File',           iconKey: 'file',       literalKind: 'string',  defaultValue: '',                              editor: 'text' },
  { id: 'transition',    label: 'Transition',     iconKey: 'transition', literalKind: 'string',  defaultValue: '',                              editor: 'style', controlProperty: 'transition' },
  { id: 'border',        label: 'Border',         iconKey: 'border',     literalKind: 'string',  defaultValue: '1px solid #000000',             editor: 'style', controlProperty: 'border' },
  { id: 'shadow',        label: 'Shadow',         iconKey: 'shadow',     literalKind: 'string',  defaultValue: '0px 4px 8px rgba(0, 0, 0, 0.25)', editor: 'style', controlProperty: 'boxShadow' },
  // Component-cursor: a component the page instance supplies as the follow/replace cursor. NOT a CSS
  // type — created from the Cursor tool (not the "+" picker), so pickable:false. Its editor is the
  // full Component Cursor control, mounted by the cursor pill via the modal's renderDefaultValue hook.
  { id: 'componentCursor', label: 'Cursor',       iconKey: 'cursor',     literalKind: 'string',  defaultValue: '',                              editor: 'componentCursor', pickable: false },
];

// `@pageVariables` stores PRIMITIVE types ('boolean'/'text'/…) while the editor's richer VariableTypeId
// is 'toggle'/'plainText'/…. ('number'/'color'/'image'/'componentCursor' already coincide.) Normalize so
// getVariableType(primitive) resolves for ALL types — without this an ORPHAN variable (×-unbound, no live
// binding to infer a CSS prop from) lost its proper editor/glyph and fell back to a plain text input.
const PRIMITIVE_TYPE_ALIAS: Record<string, VariableTypeId> = { boolean: 'toggle', text: 'plainText' };

export function getVariableType(id: string | undefined): VariableTypeDef | undefined {
  if (!id) return undefined;
  const norm = PRIMITIVE_TYPE_ALIAS[id] ?? id;
  return VARIABLE_TYPES.find(t => t.id === norm);
}
