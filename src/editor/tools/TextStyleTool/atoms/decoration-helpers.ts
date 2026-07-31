// decoration-helpers.ts — Parse/format CSS text-decoration shorthand.
// Extracted from DecorationControl.tsx for testability and reuse.

export interface DecorationValues {
  line: string;
  color: string;
  style: string;
  thickness: number;
  offset: number;
}

const LINE_TYPES = ['underline', 'overline', 'line-through'];
const STYLE_TYPES = ['solid', 'double', 'dotted', 'dashed', 'wavy'];

/** Parse CSS text-decoration shorthand → individual values.
 *  Handles: "underline solid #a72222", "underline", "none",
 *  and legacy pipe format "underline|#a72222|solid|14.5px|0px" */
export function parseDecoShorthand(v: string): DecorationValues {
  if (!v || v === 'none') return { line: 'none', color: '#000000', style: 'solid', thickness: 1, offset: 0 };

  // Legacy pipe format migration
  if (v.includes('|')) {
    const parts = v.split('|');
    return {
      line: parts[0] || 'none',
      color: parts[1] || '#000000',
      style: parts[2] || 'solid',
      thickness: parseFloat(parts[3]) || 1,
      offset: parseFloat(parts[4]) || 0,
    };
  }

  let line = 'none', style = 'solid', color = '#000000';

  // Extract color first (hex or rgb/rgba) so it doesn't interfere with word matching
  const colorMatch = v.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/);
  if (colorMatch) color = colorMatch[0];

  // Extract line type
  for (const lt of LINE_TYPES) {
    if (v.includes(lt)) { line = lt; break; }
  }

  // Extract style type
  for (const st of STYLE_TYPES) {
    if (st !== 'solid' && v.includes(st)) { style = st; break; }
  }
  // Check solid explicitly (avoid false match with other words)
  if (v.includes('solid')) style = 'solid';

  return { line, style, color, thickness: 1, offset: 0 };
}

/** Format as CSS text-decoration shorthand: "underline solid #a72222" */
export function formatDecoShorthand(vals: DecorationValues): string {
  if (vals.line === 'none') return 'none';
  return `${vals.line} ${vals.style} ${vals.color}`;
}
