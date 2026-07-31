// Generated app/providers.tsx — locale imports follow the config; route-first
// locale resolution ships in the template.
import { describe, it, expect } from 'vitest';
import { buildProvidersSource, looksGeneratedProviders, PROVIDERS_MARKER } from './providers-gen';

const CFG = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
    { code: 'it', label: 'Italian' },
    { code: 'pt-BR', label: 'Português (BR)' },
  ],
};

describe('buildProvidersSource', () => {
  it('imports one dictionary per configured locale (the old template hardcoded en/fr/es)', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import enMessages from '@/messages/en.json';");
    expect(src).toContain("import itMessages from '@/messages/it.json';");
    expect(src).toContain("import pt_BRMessages from '@/messages/pt-BR.json';");
    expect(src).toContain("'pt-BR': pt_BRMessages,");
    expect(src).not.toContain('esMessages');
  });

  it('resolves the locale route-first via usePathname', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import { usePathname } from 'next/navigation';");
    expect(src).toContain('localeFromPath');
    expect(src).toContain(PROVIDERS_MARKER);
    expect(src).toContain("const DEFAULT_LOCALE = 'en';");
    // SSR :lang() carrier
    expect(src).toContain('<div lang={locale}');
  });

  it('rejects malformed locale codes instead of interpolating them', () => {
    const src = buildProvidersSource({
      defaultLocale: 'en',
      locales: [{ code: 'en', label: 'E' }, { code: "x'; alert(1); '", label: 'evil' }],
    });
    expect(src).not.toContain('alert(1)');
  });
});

describe('looksGeneratedProviders', () => {
  it('detects v2 (marker), v1 (heuristic), and leaves hand-written alone', () => {
    expect(looksGeneratedProviders(buildProvidersSource(CFG))).toBe(true);
    expect(looksGeneratedProviders("const messagesByLocale = {}; window.addEventListener('locale-change', h);")).toBe(true);
    expect(looksGeneratedProviders('export function Providers({children}) { return children; }')).toBe(false);
  });
});
