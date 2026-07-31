// control-variable-type.ts — Single source of truth for "what TYPE of variable does this control work
// with". A control's data type drives three things, and they must agree: how a new variable is created
// (numeric literal vs boolean ternary vs string), which existing variables it offers in "Set Variable"
// (the icon family), and which glyph the bound pill shows. This is the reference's model — there is no
// "opacity variable", just a Number you can attach to any single-number control; Hide/Wrap are Toggles;
// Fill paints with color/gradient/image; Radius/Padding/Border/Shadow keep their own multi-value types.
//
// CSS-style controls derive their type from `pageVariableTypeForProperty` (the existing SSOT for which
// CSS property maps to which primitive). Code-component `@controls` derive it from the declared control
// type (slider/number → Number, color → Color, …) — see `codeControlVariableType`.

import { pageVariableTypeForProperty, conditionalBranchesFor, type PageVariableType } from '@/code/features/page-variables';
import type { VariableTypeId } from './variable-types';

export type { PropLiteralKind } from '@/code/features/variable-ops';

export interface ControlVarSpec {
  /** Variable type id persisted in @propMeta (drives the modal's default editor + the pill glyph). */
  typeId: VariableTypeId;
  /** Literal kind for the prop's signature default — 'number'/'boolean' write raw literals. */
  literalKind: 'string' | 'number' | 'boolean';
  /** Present for boolean CSS props that bind via a ternary (`display: hideVar ? 'none' : ''`). */
  conditional?: { consequent: string; alternate: string };
}

/** Map a primitive page-variable type → the richer VariableTypeId + literal kind used for creation. */
function specForPrimitive(type: PageVariableType, property: string): ControlVarSpec {
  switch (type) {
    case 'number':  return { typeId: 'number', literalKind: 'number' };
    case 'boolean': return { typeId: 'toggle', literalKind: 'boolean', conditional: conditionalBranchesFor(property) ?? undefined };
    case 'color':   return { typeId: 'color', literalKind: 'string' };
    case 'image':   return { typeId: 'image', literalKind: 'string' };
    case 'text':    return { typeId: 'plainText', literalKind: 'string' };
    default:        return { typeId: 'plainText', literalKind: 'string' };
  }
}

/** The variable-creation spec for a CSS-style control, or null when the property has no clean primitive
 *  type (border/shadow/transition/etc. fall back to the legacy string-style variable create path). */
export function styleControlVariableSpec(property: string): ControlVarSpec | null {
  const t = pageVariableTypeForProperty(property);
  return t ? specForPrimitive(t, property) : null;
}

/** Map a code-component `@control` type → its variable type. Mirrors `codeComponentControlVariableType` but
 *  returns the richer VariableTypeId. `slider` and `number` are the SAME type (a slider is just
 *  Number's default slider display — the reference has no separate slider type). */
export function codeControlVariableType(controlType: string): VariableTypeId | null {
  switch (controlType) {
    case 'slider':
    case 'number':     return 'number';
    case 'color':      return 'color';
    case 'toggle':     return 'toggle';
    case 'select':     return 'option';
    case 'text':       return 'plainText';
    case 'transition': return 'transition';
    case 'upload':     return 'image';
    default:           return null; // slot / group — not a single-value variable
  }
}
