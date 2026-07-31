import { describe, test, expect } from 'vitest';
import { nodeHasTranslationCall } from './i18n-gen';

// The old "any CallExpression child counts as a translation call" heuristic
// broke when useResponsiveText (per-viewport text overrides) landed as a text
// child: a DEFAULT-LOCALE edit on such a node was misrouted to
// messages/<defaultLocale>.json (JSX untouched) and the orphaned message then
// SHADOWED every later source edit — the "committed text reverts to the old
// text" live bug (2026-07-03, FIT texts).
describe('nodeHasTranslationCall — builder-injected calls are NOT translations', () => {
  const page = (child: string) => `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <p data-id="t1">${child}</p>
    </div>
  );
}
`;

  test('a real t() call counts', () => {
    expect(nodeHasTranslationCall(page(`{t('t1')}`), 't1')).toBe(true);
  });

  test('useResponsiveText does NOT count (per-viewport text override wrapper)', () => {
    expect(nodeHasTranslationCall(page(`{useResponsiveText('Hello', { 768: 'Hi' }, [768, 1440])}`), 't1')).toBe(false);
  });

  test('plain text does not count', () => {
    expect(nodeHasTranslationCall(page('Hello'), 't1')).toBe(false);
  });
});
