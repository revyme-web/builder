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

// Dragging a CONTAINER out is the same problem one level down: the container
// itself carries no `{t()}`, its CHILDREN do. A root-only pass left every one
// of those calls pointing at a `t` that doesn't exist at module scope, and the
// section landed on the canvas with all its text gone (user report 2026-08-09,
// "when i drop it on canvas its completely loses all the content").
//
// The sibling `dormantizeComponentVarBindings` had walked "the root AND every
// descendant" since it was written; this one had not.

const SECTION = `'use client';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root">
    <div data-id="card" data-name="Card">
      <p data-id="eyebrow">{t("eyebrow")}</p>
      <h2 data-id="title">{t("title")}</h2>
      <div data-id="tags">
        <span data-id="pill">{t("pill")}</span>
      </div>
    </div>
  </div>;
}
`;

const MESSAGES = { eyebrow: 'The part nobody sells you', title: 'Lunch arrives by boat', pill: 'Swimming' };

describe('dragging a CONTAINER out takes its translated descendants with it', () => {
  test('every descendant is baked and stashed, not just the root', () => {
    const out = dormantizeTranslationBinding(SECTION, 'card', resolver(MESSAGES));

    // No dangling `t` anywhere in the subtree — the whole point.
    expect(out).not.toContain('t("eyebrow")');
    expect(out).not.toContain('t("title")');
    expect(out).not.toContain('t("pill")');
    // …and the copy is on the canvas instead of an empty box.
    for (const text of Object.values(MESSAGES)) expect(out).toContain(text);
    // …with each key kept for the return trip, including the nested one.
    for (const id of ['eyebrow', 'title', 'pill']) {
      expect(getTranslationOrphanKey(out, id)).toBe(id);
    }
  });

  test('re-entry restores every one of them', () => {
    const dormant = dormantizeTranslationBinding(SECTION, 'card', resolver(MESSAGES));
    const revived = rehydrateTranslationBinding(dormant, 'card', 'home');

    expect(revived).toContain('t("eyebrow")');
    expect(revived).toContain('t("title")');
    expect(revived).toContain('t("pill")');
    expect(revived).not.toContain(I18N_ORPHAN_ATTR);
    // No baked literal left beside a restored call.
    for (const text of Object.values(MESSAGES)) expect(revived).not.toContain(text);
  });

  test('the round trip is lossless for the whole subtree', () => {
    const dormant = dormantizeTranslationBinding(SECTION, 'card', resolver(MESSAGES));
    const revived = rehydrateTranslationBinding(dormant, 'card', 'home');
    const again = dormantizeTranslationBinding(revived, 'card', resolver(MESSAGES));
    for (const id of ['eyebrow', 'title', 'pill']) {
      expect(getTranslationOrphanKey(again, id)).toBe(id);
    }
  });

  test('a translated container AND its translated child both survive', () => {
    const both = `'use client';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root">
    <div data-id="card">{t("card")}<p data-id="kid">{t("kid")}</p></div>
  </div>;
}
`;
    const out = dormantizeTranslationBinding(both, 'card', resolver({ card: 'Outer', kid: 'Inner' }));
    expect(getTranslationOrphanKey(out, 'card')).toBe('card');
    expect(getTranslationOrphanKey(out, 'kid')).toBe('kid');
    expect(out).not.toContain('t("card")');
    expect(out).not.toContain('t("kid")');
  });

  test('untranslated siblings are left exactly alone', () => {
    const mixed = `'use client';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root">
    <div data-id="card"><p data-id="tx">{t("tx")}</p><p data-id="plain">Static copy</p></div>
  </div>;
}
`;
    const out = dormantizeTranslationBinding(mixed, 'card', resolver({ tx: 'Translated' }));
    expect(out).toContain('Static copy');
    expect(getTranslationOrphanKey(out, 'plain')).toBeNull();
  });

  test('a subtree with nothing translated is untouched, and gains no hook', () => {
    const plain = `'use client';
export default function Page() {
  return <div data-id="root"><div data-id="card"><p data-id="p">Hello</p></div></div>;
}
`;
    expect(dormantizeTranslationBinding(plain, 'card', () => 'x')).toBe(plain);
    // Re-entry must not scaffold `useTranslations` into a file that has none.
    const revived = rehydrateTranslationBinding(plain, 'card', 'home');
    expect(revived).toBe(plain);
    expect(revived).not.toContain('useTranslations');
  });

  test('a second exit pass still does not overwrite any stash', () => {
    const once = dormantizeTranslationBinding(SECTION, 'card', resolver(MESSAGES));
    const twice = dormantizeTranslationBinding(once, 'card', resolver({ eyebrow: 'DIFFERENT' }));
    expect(twice).toBe(once);
  });
});
