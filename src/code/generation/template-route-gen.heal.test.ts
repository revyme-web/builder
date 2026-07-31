// Regression: a LayoutClient whose `__matchTemplateRoute` got DUPLICATED (the
// old parens-required idempotency check missed the babel-reformatted `__p =>`
// form and re-injected on every template-var write → "Identifier
// '__matchTemplateRoute' has already been declared" babel crash) must SELF-HEAL
// to exactly one matcher on the next template-var write.

import { describe, test, expect, vi } from 'vitest';
import { setTemplateRouteValueInCode } from './template-route-gen';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), error: vi.fn(), fn: vi.fn(), dom: vi.fn() } }));

const MATCHER_COUNT = (code: string) => (code.match(/const __matchTemplateRoute =/g) || []).length;

// The exact corrupted shape: TWO matchers — the emitted `(__p) =>` and the
// babel-reformatted `__p =>` — back to back (as seen in the user's file).
const CORRUPT = `'use client';
import { usePathname } from 'next/navigation';
const __templateProps = {"/":{"v":"a"},"/tools":{"v":"a"}};
const __matchTemplateRoute = (__p) => {
  if (__templateProps[__p]) return __templateProps[__p];
  for (const __k in __templateProps) {
    if (__k.indexOf('[') === -1) continue;
    if (new RegExp('^' + __k.replace(/\\[[^\\]]+\\]/g, '[^/]+') + '$').test(__p)) return __templateProps[__k];
  }
  return {};
};
const __matchTemplateRoute = __p => {
  if (__templateProps[__p]) return __templateProps[__p];
  for (const __k in __templateProps) {
    if (__k.indexOf('[') === -1) continue;
    if (new RegExp('^' + __k.replace(/\\[[^\\]]+\\]/g, '[^/]+') + '$').test(__p)) return __templateProps[__k];
  }
  return {};
};
export default function LayoutClient({ children, v = "" }) {
  const __tp = __matchTemplateRoute(usePathname());
  v = __tp.v ?? v;
  return <div>{children}{v}</div>;
}`;

describe('template-route-gen — __matchTemplateRoute dedup / self-heal', () => {
  test('starts corrupted (two matchers)', () => {
    expect(MATCHER_COUNT(CORRUPT)).toBe(2);
  });

  test('a template-var write collapses the duplicate to exactly one', () => {
    const out = setTemplateRouteValueInCode(CORRUPT, '/tools', 'v', 'hero', ['v']);
    expect(MATCHER_COUNT(out)).toBe(1);
  });

  test('idempotent on the babel-reformatted `__p =>` form (no parens) — does NOT re-add', () => {
    // Drop the parens version, leaving ONLY the no-parens matcher (the shape a
    // babel round-trip leaves). A second write must keep it at one.
    const single = CORRUPT.replace(/const __matchTemplateRoute = \(__p\) => \{[\s\S]*?\n\};\n/, '');
    expect(MATCHER_COUNT(single)).toBe(1);
    const out = setTemplateRouteValueInCode(single, '/x', 'v', 'b', ['v']);
    expect(MATCHER_COUNT(out)).toBe(1);
  });

  test('still wires resolution (one matcher + a __tp lookup that calls it)', () => {
    const out = setTemplateRouteValueInCode(CORRUPT, '/tools', 'v', 'hero', ['v']);
    expect(out).toContain('const __tp = __matchTemplateRoute(usePathname());');
    expect(MATCHER_COUNT(out)).toBe(1);
  });
});
