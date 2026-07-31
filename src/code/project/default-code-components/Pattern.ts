// Pattern — Code component template (CSS-driven decorative background patterns).
//
// One component for all seven pattern flavours (grid, dots, crosses,
// diagonal, grid+mask, honeycomb, checkerboard). The Insert panel has
// seven entry points but each one drops `<Pattern kind="..." />` —
// switching `kind` post-drop reshuffles the recipe without changing
// anything else, so the user can A/B between styles freely.
//
// All seven recipes are pure CSS background-image (gradients or inline
// SVG data-URLs for shapes CSS can't express ergonomically), so there's
// no canvas / WebGL runtime to manage. Native to React, native to
// Next.js production build, no special handling on canvas.

export const PATTERN_COMPONENT = `'use client';

/** @label "Pattern" */
/** @comment "CSS-only decorative pattern. Pick a kind, tune color, opacity, tile size and line thickness." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "kind": {
    "type": "select",
    "label": "Pattern",
    "default": "grid",
    "options": [
      { "label": "Grid", "value": "grid" },
      { "label": "Dots", "value": "dots" },
      { "label": "Crosses", "value": "crosses" },
      { "label": "Diagonal", "value": "diagonal" },
      { "label": "Grid + Mask", "value": "gridMask" },
      { "label": "Honeycomb", "value": "honeycomb" },
      { "label": "Checkerboard", "value": "checkerboard" }
    ]
  },
  "color": { "type": "color", "label": "Pattern Color", "default": "#7C3AED" },
  "background": { "type": "color", "label": "Background", "default": "transparent" },
  "opacity": { "type": "number", "label": "Pattern Opacity", "min": 0, "max": 1, "step": 0.05, "default": 0.5 },
  "tileSize": { "type": "number", "label": "Tile Size", "min": 4, "max": 120, "step": 1, "default": 20, "unit": "px" },
  "thickness": { "type": "number", "label": "Line / Dot Size", "min": 1, "max": 12, "step": 0.5, "default": 1, "unit": "px" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function Pattern({
  kind = 'grid',
  color = '#7C3AED',
  background = 'transparent',
  opacity = 0.5,
  tileSize = 20,
  thickness = 1,
  ...props
}) {
  // Build the CSS \`backgroundImage\` recipe for the chosen kind. Each
  // recipe scales with \`tileSize\` (the repeat unit) and \`thickness\`
  // (the visible mark inside that unit), so a single Pattern instance
  // covers everything from "1px line every 4px" to "12px line every 120px".
  // Color is interpolated as \`rgba(...)\` so the \`opacity\` slider
  // works regardless of whether the user picked a hex, rgb, or named color.
  const fill = withAlpha(color, opacity);
  const tile = Math.max(2, tileSize);
  const t = Math.max(0.5, thickness);

  let backgroundImage = '';
  let backgroundSize = '';
  let backgroundPosition = '';
  let mask = '';

  switch (kind) {
    case 'grid': {
      backgroundImage = \`linear-gradient(\${fill} \${t}px, transparent \${t}px), linear-gradient(90deg, \${fill} \${t}px, transparent \${t}px)\`;
      backgroundSize = \`\${tile}px \${tile}px\`;
      break;
    }
    case 'dots': {
      backgroundImage = \`radial-gradient(circle, \${fill} \${t}px, transparent \${t + 0.5}px)\`;
      backgroundSize = \`\${tile}px \${tile}px\`;
      break;
    }
    case 'crosses': {
      const arm = Math.min(tile / 2 - 1, t * 4);
      const half = tile / 2;
      const svg = \`<svg xmlns='http://www.w3.org/2000/svg' width='\${tile}' height='\${tile}' viewBox='0 0 \${tile} \${tile}'><path d='M\${half} \${half - arm}v\${arm * 2}M\${half - arm} \${half}h\${arm * 2}' stroke='\${color}' stroke-opacity='\${opacity}' stroke-width='\${t}' stroke-linecap='round'/></svg>\`;
      backgroundImage = \`url("data:image/svg+xml;utf8,\${encodeURIComponent(svg)}")\`;
      backgroundSize = \`\${tile}px \${tile}px\`;
      break;
    }
    case 'diagonal': {
      backgroundImage = \`repeating-linear-gradient(45deg, \${fill} 0, \${fill} \${t}px, transparent \${t}px, transparent \${tile}px)\`;
      break;
    }
    case 'gridMask': {
      backgroundImage = \`linear-gradient(\${fill} \${t}px, transparent \${t}px), linear-gradient(90deg, \${fill} \${t}px, transparent \${t}px)\`;
      backgroundSize = \`\${tile}px \${tile}px\`;
      mask = 'radial-gradient(ellipse at center, black 30%, transparent 75%)';
      break;
    }
    case 'honeycomb': {
      // Hex tessellation — proper SVG with two-row stagger. Width tile×2,
      // height ~tile×1.73 (hex aspect). Stroke uses \`thickness\`; opacity
      // bakes into the rgba color via \`fill\`.
      const w = tile * 2;
      const h = Math.round(tile * 1.732);
      const svg = \`<svg xmlns='http://www.w3.org/2000/svg' width='\${w}' height='\${h}' viewBox='0 0 \${w} \${h}'><path d='M\${w / 2} \${h * 0.083}L\${w} \${h * 0.333}V\${h * 0.667}L\${w / 2} \${h * 0.917}L0 \${h * 0.667}V\${h * 0.333}Z M0 \${h * 0.333}L\${w / 2} \${h * 0.083}M\${w} \${h * 0.333}L\${w / 2} \${h * 0.083}' fill='none' stroke='\${color}' stroke-opacity='\${opacity}' stroke-width='\${t}'/></svg>\`;
      backgroundImage = \`url("data:image/svg+xml;utf8,\${encodeURIComponent(svg)}")\`;
      backgroundSize = \`\${w}px \${h}px\`;
      break;
    }
    case 'checkerboard': {
      backgroundImage = \`linear-gradient(45deg, \${fill} 25%, transparent 25%, transparent 75%, \${fill} 75%), linear-gradient(45deg, \${fill} 25%, transparent 25%, transparent 75%, \${fill} 75%)\`;
      backgroundSize = \`\${tile}px \${tile}px\`;
      backgroundPosition = \`0 0, \${tile / 2}px \${tile / 2}px\`;
      break;
    }
  }

  const style = {
    ...(props.style || {}),
    backgroundColor: background,
    backgroundImage,
    backgroundSize,
    ...(backgroundPosition ? { backgroundPosition } : {}),
    ...(mask ? { WebkitMaskImage: mask, maskImage: mask } : {}),
  };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style} />
  );
}

// Convert any CSS color to \`rgba(r, g, b, a)\` for opacity control. Reads
// the computed RGB by stuffing the color into a throwaway element — this
// way named colors, hex, hsl, anything-the-browser-knows works.
function withAlpha(color, alpha) {
  if (typeof window === 'undefined') return color;
  const probe = document.createElement('div');
  probe.style.color = color;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const m = rgb.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
  if (!m) return color;
  return \`rgba(\${m[1]}, \${m[2]}, \${m[3]}, \${alpha})\`;
}

export default withResponsiveProps(Pattern);
`;
