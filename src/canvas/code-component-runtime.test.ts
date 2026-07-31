import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileCodeComponent, clearCodeComponentCache } from './code-component-runtime';

describe('code-component-runtime', () => {
  beforeEach(() => clearCodeComponentCache());

  describe('compileCodeComponent', () => {
    it('compiles a simple code component without import React', () => {
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test code component" */
/** @controls {} */
import { useState } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TestCodeComponent({ color = '#ff0000', ...props }) {
  return <div {...props} style={{ backgroundColor: color, ...props.style }}>Hello</div>;
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
      // withResponsiveProps now forwards refs, so the wrapped export is a
      // React.forwardRef object (renderable), not a bare function.
      expect(
        typeof Component === 'function' ||
        (typeof Component === 'object' && Component !== null && (Component as any).$$typeof != null),
      ).toBe(true);
    });

    it('compiles a code component with import React (no double declaration)', () => {
      // This previously failed with "Identifier React has already been declared"
      // because the IIFE wrapper passes React as a parameter AND the import
      // transform created `const React = __require("react")`
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test code component" */
/** @controls {} */
import React, { useState, useEffect, useId } from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

function TestCodeComponent({ title = 'Hello', ...props }) {
  const id = useId();
  return <div {...props} style={{ ...props.style }}>{title}</div>;
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
      // withResponsiveProps now forwards refs, so the wrapped export is a
      // React.forwardRef object (renderable), not a bare function.
      expect(
        typeof Component === 'function' ||
        (typeof Component === 'object' && Component !== null && (Component as any).$$typeof != null),
      ).toBe(true);
    });

    it('compiles a code component with import React default only', () => {
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test" */
/** @controls {} */
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TestCodeComponent(props) {
  return <div {...props}>test</div>;
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
    });

    it('compiles a code component with TypeScript interface declarations', () => {
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test" */
/** @controls {} */
import React, { useState } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

interface TestProps {
  color?: string;
  size?: number;
  [key: string]: any;
}

function TestCodeComponent({ color = '#ff0000', size = 100, ...props }: TestProps) {
  return <div {...props} style={{ width: size, height: size, backgroundColor: color, ...props.style }} />;
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
    });

    it('compiles a code component with multiple helper functions before export', () => {
      // Tests that only export default gets the __CODE_COMPONENT__ assignment,
      // not the helper functions
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test" */
/** @controls {} */
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function HelperCard({ title }) {
  return <div>{title}</div>;
}

function TestCodeComponent({ items = ['a', 'b'], ...props }) {
  return (
    <div {...props} style={{ ...props.style }}>
      {items.map((item, i) => <HelperCard key={i} title={item} />)}
    </div>
  );
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
    });

    it('preserves JSX style object transition/animation properties', () => {
      // Previously CSS stripping regex ate JS `transition:` properties
      // destroying JSX structure. Now stripping is removed, so this should compile fine.
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test" */
/** @controls {} */
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TestCodeComponent(props) {
  return (
    <div {...props} style={{
      transition: 'opacity 0.3s ease',
      animation: 'none',
      backgroundColor: '#000',
      ...props.style
    }}>
      test
    </div>
  );
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
    });

    it('strips mouse event handlers from JSX', () => {
      const code = `
'use client';
/** @label "Test" */
/** @comment "Test" */
/** @controls {} */
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TestCodeComponent(props) {
  return (
    <div {...props} onMouseMove={handleMove} onMouseLeave={handleLeave} style={{ ...props.style }}>
      test
    </div>
  );
}
export default withResponsiveProps(TestCodeComponent);
`;
      const Component = compileCodeComponent(code, 'TestCodeComponent');
      expect(Component).not.toBeNull();
    });

    it('returns null for invalid code', () => {
      const Component = compileCodeComponent('this is not valid jsx }{}{', 'BadCodeComponent');
      expect(Component).toBeNull();
    });

    it('compiles a code component whose mouse handlers have BLOCK bodies (balanced-brace strip)', () => {
      // Regression: the old `[^}]*` strip stopped at the first `}` inside the
      // handler, leaving a stray `}` → broken JSX → "Compilation returned null".
      const code = `
'use client';
/** @label "Hover" */
/** @comment "hover code component" */
/** @controls {} */
import { useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Hover({ ...props }) {
  const paused = useRef(false);
  return (
    <div {...props}
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      style={{ ...props.style }}>Hover me</div>
  );
}
export default withResponsiveProps(Hover);
`;
      const Component = compileCodeComponent(code, 'Hover');
      expect(Component).not.toBeNull();
    });

    it('module-eval misses a RENDER-time throw but a smoke-render catches it (gate compile-step)', () => {
      // Dialect-clean, every identifier defined (JSON is a global → WOULD_CRASH
      // can't flag it), but the body throws when rendered. The gate compiles
      // (module-eval → non-null) AND smoke-renders (renderToStaticMarkup) to
      // catch exactly this class — "renders on the canvas? no, blank/crash".
      const code = `
'use client';
/** @label "Boom" */
/** @comment "throws at render" */
/** @controls {} */
import { withResponsiveProps } from '@revyme/runtime';

function Boom({ ...props }) {
  const x = JSON.parse('{ broken');
  return <div {...props} style={{ ...props.style }}>{x}</div>;
}
export default withResponsiveProps(Boom);
`;
      const Component = compileCodeComponent(code, 'Boom');
      expect(Component).not.toBeNull();                                  // module-eval succeeds
      expect(() => renderToStaticMarkup(createElement(Component as any))).toThrow(); // render throws → gate bounces
    });
  });
});
