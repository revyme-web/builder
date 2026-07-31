import { describe, it, expect } from 'vitest';
import {
  setResponsiveStyleVariableInCode,
  resetResponsiveStyleVariableInCode,
  parseResponsiveStyleVarInCode,
  setResponsiveStyleBaseInCode,
} from './responsive-style-vars-gen';
import { parseJSXToNodes } from '../parsing/parser';
import { syncPageVariableHooks } from './page-variables-gen';
import { parse as babelParse } from '@babel/parser';
import { createTypedVariableInCode } from '../features/variable-ops';
import { setPropTypeInCode } from '../components/prop-meta';
import { parseComponentInfoFromSource } from '../components/component-registry';
import { updateContainerQueryStyle } from './generator-styles';

const wrap = (styleBody: string, extraHooks = '') => `'use client';
import React, { useState, useEffect } from 'react';
export default function LayoutClient({ children, color1 = "#97cffc", colorTablet = "#ff0000", colorMobile = "#00ff00" }) {
${extraHooks}  return <div data-id="frame-1" data-name="Frame" style={{ position: 'relative', ${styleBody} }}></div>;
}
`;

describe('setResponsiveStyleVariableInCode', () => {
  it('binds a different variable on Tablet, keeping the base variable as fallback', () => {
    const code = wrap(`backgroundColor: color1`);
    const out = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    expect(out).toContain("const __mq0 = useMediaQuery('(max-width: 768px)')");
    expect(out).toMatch(/backgroundColor:\s*\(__mq0\s*\?\s*colorTablet\s*:\s*color1\)/);
    expect(out).toContain('function useMediaQuery');
  });

  it('binds over a LITERAL base (no base variable)', () => {
    const code = wrap(`backgroundColor: '#fff'`);
    const out = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', '#fff');
    expect(out).toMatch(/backgroundColor:\s*\(__mq0\s*\?\s*colorTablet\s*:\s*'#fff'\)/);
  });

  it('chains a second viewport smallest-width-first', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 375, 'backgroundColor', 'colorMobile', 'color1');
    // smallest (375) outermost, then 768, then base
    expect(code).toMatch(/backgroundColor:\s*\(__mq\d+\s*\?\s*colorMobile\s*:\s*__mq\d+\s*\?\s*colorTablet\s*:\s*color1\)/);
    const parsed = parseResponsiveStyleVarInCode(code, 'frame-1', 'backgroundColor');
    expect(parsed.base).toBe('color1');
    expect(parsed.byViewport.get(768)).toBe('colorTablet');
    expect(parsed.byViewport.get(375)).toBe('colorMobile');
  });

  it('round-trips through parseResponsiveStyleVarInCode', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    const r = parseResponsiveStyleVarInCode(code, 'frame-1', 'backgroundColor');
    expect(r.base).toBe('color1');
    expect(r.byViewport.get(768)).toBe('colorTablet');
  });

  it('reset reverts a viewport to the cascaded base and drops the now-orphan gate', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    code = resetResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor');
    // back to a bare base binding, no ternary, no orphan gate
    expect(code).toMatch(/backgroundColor:\s*color1/);
    expect(code).not.toContain('__mq0 ? colorTablet');
    expect(code).not.toContain("useMediaQuery('(max-width: 768px)')");
  });

  it('setting the base var name as the override is a no-op override (removes it)', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'color1', 'color1');
    expect(code).toMatch(/backgroundColor:\s*color1/);
    expect(code).not.toContain('__mq');
  });

  it('inserts the prop when the style object lacks it (base = pre-quoted literal expr)', () => {
    const code = wrap(`opacity: 1`);
    const out = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', "'#000'");
    expect(out).toMatch(/backgroundColor:\s*\(__mq0\s*\?\s*colorTablet\s*:\s*'#000'\)/);
    expect(out).toContain('opacity: 1');
  });

  it('parser resolves the bound ternary into responsiveStyleVariables + Values + base pill', () => {
    const pv = `'use client';
import React, { useState } from 'react';
/** @pageVariables { "variables": [ { "name": "color1", "type": "color", "default": "#97cffc" }, { "name": "colorTablet", "type": "color", "default": "#ff0000" } ] } */
export default function LayoutClient({ children, color1 = "#97cffc", colorTablet = "#ff0000" }) {
  return <div data-id="frame-1" data-name="Frame" style={{ position: 'relative', backgroundColor: color1 }}></div>;
}`;
    const code = setResponsiveStyleVariableInCode(pv, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    const n = parseJSXToNodes(code).get('frame-1')!;
    expect(n.styles.backgroundColor).toBe('#97cffc');                          // base/Desktop resolved
    expect(n.styleVariables?.backgroundColor).toBe('color1');                  // base pill
    expect(n.responsiveStyleVariables?.backgroundColor?.[768]).toBe('colorTablet'); // tablet pill
    expect(n.responsiveStyleValues?.backgroundColor?.[768]).toBe('#ff0000');        // tablet canvas value
  });

  it('per-viewport bind + hook-sync on a TEMPLATE does not duplicate a param variable', () => {
    // Regression: syncPageVariableHooks used to emit `const [headerVariant…] = useState()` for a
    // variable that is already a function PARAM (templates/components read vars as props), crashing
    // "Identifier 'headerVariant' has already been declared".
    const tpl = `'use client';
import React, { useState } from 'react';
/** @pageVariables { "variables": [ { "name": "headerVariant", "type": "text", "default": "" }, { "name": "color1", "type": "color", "default": "#97cffc" }, { "name": "color2", "type": "color", "default": "#112233" } ] } */
function useMediaQuery(q){return false;}
export default function LayoutClient({ children, headerVariant = "", color1 = "#97cffc", color2 = "#112233" }) {
  const __mq3 = useMediaQuery('(max-width: 768px)');
  const [HeaderSv] = useState(headerVariant || 'default');
  return <div data-id="root"><div data-id="frame-1" style={{ position: 'relative', backgroundColor: color1 }}></div></div>;
}`;
    let code = setResponsiveStyleVariableInCode(tpl, 'frame-1', 768, 'backgroundColor', 'color2', 'color1');
    code = syncPageVariableHooks(code);
    expect(code).not.toMatch(/const \[headerVariant/);
    expect(() => babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
    expect(code).toMatch(/backgroundColor:\s*\(__mq3\s*\?\s*color2\s*:\s*color1\)/);
  });

  it('removing the BASE var on the primary injects its default literal, keeping the override', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    // base color1 removed on primary → inject its default light-blue literal, keep colorTablet on 768
    code = setResponsiveStyleBaseInCode(code, 'frame-1', 'backgroundColor', "'#97cffc'");
    expect(code).toMatch(/backgroundColor:\s*\(__mq\d+\s*\?\s*colorTablet\s*:\s*'#97cffc'\)/);
    const r = parseResponsiveStyleVarInCode(code, 'frame-1', 'backgroundColor');
    expect(r.base).toBe("'#97cffc'");
    expect(r.byViewport.get(768)).toBe('colorTablet');
  });

  it('Set Variable on the primary (ternary present) sets the base branch to the variable', () => {
    const code = `'use client';
import React, { useState } from 'react';
/** @pageVariables { "variables": [ { "name": "color1", "type": "color", "default": "#97cffc" }, { "name": "color2", "type": "color", "default": "#112233" } ] } */
function useMediaQuery(q){return false;}
export default function LayoutClient({ children, color1 = "#97cffc", color2 = "#112233" }) {
  const __mq3 = useMediaQuery('(max-width: 768px)');
  return <div data-id="root"><div data-id="frame-1" style={{ position: 'relative', backgroundColor: __mq3 ? color2 : '' }}></div></div>;
}`;
    const out = setResponsiveStyleBaseInCode(code, 'frame-1', 'backgroundColor', 'color1');
    expect(out).toMatch(/backgroundColor:\s*\(__mq3\s*\?\s*color2\s*:\s*color1\)/);
    const n = parseJSXToNodes(out).get('frame-1')!;
    expect(n.styleVariables?.backgroundColor).toBe('color1');
    expect(n.responsiveStyleVariables?.backgroundColor?.[768]).toBe('color2');
  });

  it('ensureTemplateVarParam converts a per-viewport useState var into a Template-tool param', () => {
    const tpl = `'use client';
/** @propMeta {"color1":{"type":"color"}} */
import React, { useState } from 'react';
function useMediaQuery(q){return false;}
export default function LayoutClient({ children, color1 = "#000000" }: {children: React.ReactNode}) {const [color2, setColor2] = useState("#97cffc");
  const __mq3 = useMediaQuery('(max-width: 768px)');
  return <div data-id="root"><div data-id="frame-1" style={{ backgroundColor: __mq3 ? color2 : color1 }}></div></div>;
}`;
    let c = createTypedVariableInCode(tpl, 'color2', 'string', '#97cffc');
    c = c.replace(/\n?[ \t]*const \[\s*color2\s*,[^\]]*\]\s*=\s*useState\([^;]*\);/g, '');
    c = setPropTypeInCode(c, 'color2', 'color');
    expect(() => babelParse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
    expect(c).not.toMatch(/const \[\s*color2/);
    expect(c).toMatch(/color2\s*=\s*["']#97cffc["']/);
    const info = parseComponentInfoFromSource('app/(Body)/LayoutClient.tsx', c, String(c.length));
    expect(info?.props.some(p => p.name === 'color2')).toBe(true);
  });

  it('a Tablet override is BANDED (does not cascade onto Mobile) — uses the banded gate + band floor', () => {
    const layout = `'use client';
import React, { useState } from 'react';
/** @pageVariables { "variables": [ { "name": "color1", "type": "color", "default": "#000000" }, { "name": "color2", "type": "color", "default": "#97cffc" } ] } */
function useMediaQuery(q){return false;}
export default function LayoutClient({ children, color1 = "#000000", color2 = "#97cffc" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 375.02px)');
  const __mq1 = useMediaQuery('(max-width: 375px)');
  return <div data-id="root"><div data-id="hdr" data-responsive='{"_bp":[375,768,1440]}'></div>
    <div data-id="frame-1" style={{ position: 'relative', backgroundColor: color1 }}></div></div>;
}`;
    const out = setResponsiveStyleVariableInCode(layout, 'frame-1', 768, 'backgroundColor', 'color2', 'color1');
    expect(out).toMatch(/backgroundColor:\s*\(__mq2\s*\?\s*color2\s*:\s*color1\)/); // banded gate reused, not (max-width:768)
    const n = parseJSXToNodes(out).get('frame-1')!;
    expect(n.responsiveStyleVariables?.backgroundColor?.[768]).toBe('color2');
    expect(n.responsiveStyleBands?.backgroundColor?.[768]).toBe(375); // floor excludes Mobile (375)
  });

  it('canvas resolves a per-viewport ternary to template ROUTE values via propOverrides', () => {
    const layout = `'use client';
import React, { useState } from 'react';
function useMediaQuery(q){return false;}
export default function LayoutClient({ children, color3 = "#97cffc", color4 = "#97cffc" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 375.02px)');
  return <div data-id="root"><div data-id="hdr" data-responsive='{"_bp":[375,768,1440]}'></div>
    <div data-id="frame-1" style={{ position: 'relative', backgroundColor: (__mq2 ? color4 : color3) }}></div></div>;
}`;
    // no overrides → param defaults
    expect(parseJSXToNodes(layout).get('frame-1')!.styles.backgroundColor).toBe('#97cffc');
    // route overrides → base (Desktop) + per-viewport (Tablet band) resolve to the page's colors
    const n = parseJSXToNodes(layout, { color3: '#25313b', color4: '#ff376d' }).get('frame-1')!;
    expect(n.styles.backgroundColor).toBe('#25313b');
    expect(n.responsiveStyleValues?.backgroundColor?.[768]).toBe('#ff376d');
  });

  it('binding a per-viewport var + clearing the stale @media literal (the masking-override bug)', () => {
    const layout = `'use client';
import React, { useState } from 'react';
export default function LayoutClient({ children, color3 = "#000", color4 = "#f0f" }) {
  return <div data-id="root">
    <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="frame-1"] { background-color: #97cffc !important; }
    }
  \`}</style>
    <div data-id="frame-1" data-responsive='{"_bp":[375,768,1440]}' style={{ position: 'relative', backgroundColor: color3 }}></div>
  </div>;
}`;
    let c = setResponsiveStyleVariableInCode(layout, 'frame-1', 768, 'backgroundColor', 'color4', 'color3');
    expect(c).toContain('#97cffc !important'); // stale @media still there before clear
    c = updateContainerQueryStyle(c, 'frame-1', 768, { backgroundColor: '' });
    expect(c).not.toContain('#97cffc !important'); // cleared → the inline `__mq2 ? color4 : color3` wins
  });

  it('parser sees a clean base binding after reset (no per-viewport fields)', () => {
    const pv = `'use client';
import React, { useState } from 'react';
/** @pageVariables { "variables": [ { "name": "color1", "type": "color", "default": "#97cffc" }, { "name": "colorTablet", "type": "color", "default": "#ff0000" } ] } */
export default function LayoutClient({ children, color1 = "#97cffc", colorTablet = "#ff0000" }) {
  return <div data-id="frame-1" data-name="Frame" style={{ position: 'relative', backgroundColor: color1 }}></div>;
}`;
    let code = setResponsiveStyleVariableInCode(pv, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    code = resetResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor');
    const n = parseJSXToNodes(code).get('frame-1')!;
    expect(n.styleVariables?.backgroundColor).toBe('color1');
    expect(n.responsiveStyleVariables?.backgroundColor).toBeUndefined();
  });

  it('updates an existing viewport binding in place (no duplicate branch)', () => {
    let code = wrap(`backgroundColor: color1`);
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorTablet', 'color1');
    code = setResponsiveStyleVariableInCode(code, 'frame-1', 768, 'backgroundColor', 'colorMobile', 'color1');
    const r = parseResponsiveStyleVarInCode(code, 'frame-1', 'backgroundColor');
    expect(r.byViewport.get(768)).toBe('colorMobile');
    // the bound VALUE in the style is colorMobile, not the replaced colorTablet
    expect(code).toMatch(/backgroundColor:\s*\(__mq\d+\s*\?\s*colorMobile\s*:\s*color1\)/);
    expect(code).not.toMatch(/backgroundColor:[^}]*colorTablet/);
  });
});
