import { describe, it, expect } from 'vitest';
import { compileCodeComponent } from './code-component-runtime';

/**
 * A module in the shape the reference builder PUBLISHES one: minified (no space after
 * `import`, none before the quote), compiled with the automatic JSX runtime,
 * aliased named imports, and the publisher's own metadata export tacked on the end.
 *
 * Every one of those broke the compile independently, so each assertion below
 * is a regression that made ALL the reference builder modules fail.
 */
const PUBLISHED = `'use client';

import { withResponsiveProps } from '@revyme/runtime';
import{jsx as _jsx}from"react/jsx-runtime";import{useMemo}from"react";import{motion}from"framer-motion";
function Banner({blur=10,tint="#fff"}){const s=useMemo(()=>({filter:\`blur(\${blur}px)\`,background:tint}),[blur,tint]);return _jsx(motion.div,{style:s});}
export const __ModuleMetadata__ = {"exports":{"default":{"type":"reactComponent"}}};
export default withResponsiveProps(Banner);
`;

describe('a published module compiles', () => {
  it('compiles end to end', () => {
    expect(compileCodeComponent(PUBLISHED, 'Banner')).not.toBeNull();
  });

  it('resolves the automatic JSX runtime', () => {
    // `import{jsx as _jsx}from"react/jsx-runtime"` — the module never uses JSX
    // syntax, so without this entry in MODULE_MAP nothing renders.
    expect(compileCodeComponent(PUBLISHED.replace('{jsx as _jsx}', '{jsx as _jsx, jsxs as _jsxs}'), 'B2')).not.toBeNull();
  });

  it('tolerates minified spacing around from', () => {
    const spaced = PUBLISHED.replace(/from"/g, 'from "');
    expect(compileCodeComponent(spaced, 'B3')).not.toBeNull();
  });

  it('does not double-declare motion when the module imports it itself', () => {
    // The auto-inject safety net missed `from"framer-motion"` (no space) and
    // added a second binding: "Identifier 'motion' has already been declared".
    expect(compileCodeComponent(PUBLISHED, 'B4')).not.toBeNull();
  });

  it('tolerates a named export beside the default', () => {
    expect(compileCodeComponent(PUBLISHED, 'B5')).not.toBeNull();
    const noMeta = PUBLISHED.replace(/export const __ModuleMetadata__[^\n]*\n/, '');
    expect(compileCodeComponent(noMeta, 'B6')).not.toBeNull();
  });
});

// A published component may import React as a NAMESPACE. React is already in
// scope as the wrapper's own parameter, so binding it again is "Identifier
// 'React' has already been declared" — the module compiles to null and the
// component renders as nothing. Its transpiled twin imports the jsx runtime
// instead, which is why this only showed up once the ORIGINAL source was
// recovered.
describe('a module that imports React as a namespace', () => {
  it('compiles instead of colliding with the wrapper', () => {
    const src = `'use client';
import * as React from "react"
import { useState } from "react"

function Gallery() {
  const [n] = useState(1);
  return React.createElement('div', null, String(n));
}

export default Gallery;
`;
    expect(compileCodeComponent(src, 'Gallery')).toBeTruthy();
  });
});
