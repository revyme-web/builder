// LocaleSwitcher.tsx — Dropdown to switch the active editor locale.
// Only visible when more than one locale is configured in i18n/config.json.

import { useAtom, useAtomValue } from 'jotai';
import { ToolSelect } from '../controls';
import { i18nConfigAtom, activeLocaleAtom } from '@/code/stores/locale-store';
import { trace } from '@/shared/debug-trace';

export default function LocaleSwitcher() {
  const config = useAtomValue(i18nConfigAtom);
  const [locale, setLocale] = useAtom(activeLocaleAtom);

  trace.fn('LocaleSwitcher:render', { locale, localeCount: config.locales.length });

  // Only show when more than 1 locale configured
  if (config.locales.length <= 1) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-[var(--text-disabled)]">🌐</span>
      <ToolSelect
        value={locale}
        onChange={(v) => {
          trace.action('locale:switch', { from: locale, to: v });
          setLocale(v);
        }}
        options={config.locales.map(l => ({
          value: l.code,
          label: `${l.label}`,
        }))}
      />
    </div>
  );
}
