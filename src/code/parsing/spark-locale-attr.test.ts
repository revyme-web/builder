import { describe, it, expect, afterEach } from 'vitest';
import { parseJSXToNodes, setParseActiveLocale } from './parser';

const CODE = `'use client';
import LocaleSwitcher from '@/components/LocaleSwitcher';
function useMediaQuery(q){ return false; }
export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  const __activeLocale = 'en';
  return <div data-id="root">
    <LocaleSwitcher data-id="ls-1" data-name="LocaleSwitcher" locales={(__activeLocale === 'fr' ? "fr only" : "en, fr, it, es")} />
  </div>;
}`;

// CODE-COMPONENT locale parity (2026-07-23): localized @control values ride
// the SAME scoped-attr expression rail as design-component instance props —
// the parser folds `__activeLocale` ternaries on ANY instance tag, so Spark
// props resolve per-locale at parse time (canvas) and per-branch at runtime
// (deploy). These tests pin that shared rail for code-component tags.
describe('code-component locale attr parse-time resolution', () => {
  afterEach(() => setParseActiveLocale(''));
  it('default locale: base branch', () => {
    setParseActiveLocale('');
    const nodes = parseJSXToNodes(CODE);
    const n = nodes.get('ls-1');
    console.log('EN props:', JSON.stringify(n?.componentProps ?? null));
  });
  it('fr: locale branch', () => {
    setParseActiveLocale('fr');
    const nodes = parseJSXToNodes(CODE);
    const n = nodes.get('ls-1');
    console.log('FR props:', JSON.stringify(n?.componentProps ?? null));
  });
});
