import { describe, test, expect } from 'vitest';
import {
  dormantizeTranslationBinding,
  rehydrateTranslationBinding,
  getTranslationOrphanKey,
  I18N_ORPHAN_ATTR,
} from './i18n-gen';

// Dragging a TRANSLATED text node out onto the canvas moved it into the
// module-scope `canvasNodes` fragment while it still rendered `{t('key')}` —
// but `t` is the component fn's `useTranslations()` const, so the file no
// longer compiled and the mutation was rejected with
// "References undefined identifier: t — would crash at runtime"
// (user report 2026-08-03, <h1 data-id="h1-msdn09or-d">).
//
// Same dormantize/rehydrate contract every other component-scope binding uses
// across a canvas round trip: bake a literal on exit, restore the call on
// re-entry, never lose the key in between.

const KEY = 'h1-msdn09or-d';

const pageWithTranslatedHeading = `'use client';
import React from 'react';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root" data-name="Page">
    <h1 data-id="${KEY}" data-name="Heading" style={{ fontSize: '36px' }}>{t("${KEY}")}</h1>
  </div>;
}
`;

const resolver = (map: Record<string, string>) => (key: string) => map[key] ?? null;

describe('translation dormancy across a canvas round trip', () => {
  test('exit bakes the default-locale text and stashes the key', () => {
    const out = dormantizeTranslationBinding(pageWithTranslatedHeading, KEY, resolver({ [KEY]: 'Bonjour' }));

    // The crashing reference is gone…
    expect(out).not.toContain(`t("${KEY}")`);
    // …replaced by the resolved copy, so the node stays visible on the canvas…
    expect(out).toContain('Bonjour');
    // …and the key survives for the return trip.
    expect(out).toContain(`${I18N_ORPHAN_ATTR}="${KEY}"`);
    expect(getTranslationOrphanKey(out, KEY)).toBe(KEY);
  });

  test('re-entry restores the call and the hook', () => {
    const dormant = dormantizeTranslationBinding(pageWithTranslatedHeading, KEY, resolver({ [KEY]: 'Bonjour' }));
    const revived = rehydrateTranslationBinding(dormant, KEY, 'home');

    expect(revived).toContain(`t("${KEY}")`);
    expect(revived).not.toContain(I18N_ORPHAN_ATTR);
    // The baked literal must not linger beside the restored call.
    expect(revived).not.toContain('Bonjour');
    expect(revived).toContain('useTranslations');
  });

  test('round trip is lossless — the key is identical after out-and-back', () => {
    const dormant = dormantizeTranslationBinding(pageWithTranslatedHeading, KEY, resolver({ [KEY]: 'Bonjour' }));
    const revived = rehydrateTranslationBinding(dormant, KEY, 'home');
    const again = dormantizeTranslationBinding(revived, KEY, resolver({ [KEY]: 'Bonjour' }));
    expect(getTranslationOrphanKey(again, KEY)).toBe(KEY);
  });

  test('falls back to the key when the message is missing, never blanks the node', () => {
    const out = dormantizeTranslationBinding(pageWithTranslatedHeading, KEY, () => null);
    expect(out).toContain(KEY);
    expect(out).toContain(`${I18N_ORPHAN_ATTR}="${KEY}"`);
    // Still no dangling identifier — that's the whole point.
    expect(out).not.toContain(`t("${KEY}")`);
  });

  test('a second exit pass does not overwrite the stash', () => {
    const once = dormantizeTranslationBinding(pageWithTranslatedHeading, KEY, resolver({ [KEY]: 'Bonjour' }));
    const twice = dormantizeTranslationBinding(once, KEY, resolver({ [KEY]: 'DIFFERENT' }));
    expect(twice).toBe(once);
  });

  test('leaves untranslated nodes alone', () => {
    const plain = `'use client';
export default function Page() {
  return <div data-id="root"><h1 data-id="plain">Hello</h1></div>;
}
`;
    expect(dormantizeTranslationBinding(plain, 'plain', () => 'x')).toBe(plain);
    expect(rehydrateTranslationBinding(plain, 'plain', 'home')).toBe(plain);
  });

  test('does not treat useResponsiveText as a translation', () => {
    const responsive = `'use client';
export default function Page() {
  const v = useResponsiveText({});
  return <div data-id="root"><h1 data-id="rt">{useResponsiveText({ base: 'a' })}</h1></div>;
}
`;
    expect(dormantizeTranslationBinding(responsive, 'rt', () => 'x')).toBe(responsive);
  });
});
