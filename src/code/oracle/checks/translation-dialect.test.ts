// Translation dialect rules — t() calls must be hook-scoped, keys must be
// data-id-derived, namespace must match the page slug.
import { describe, it, expect } from 'vitest';
import { checkFile } from '../check-file';

const PATH = 'app/page.client.tsx';
const wrap = (body: string, pre = '') => `'use client';
${pre}
export default function Page() {
  ${pre.includes('useTranslations') ? "const t = useTranslations('home');" : ''}
  return (<div data-id="root" style={{ width: '100%', position: 'relative' }}>${body}</div>);
}
`;

const codes = (code: string) => checkFile(code, { kind: 'page', path: PATH }).map(v => v.code);

describe('translation dialect', () => {
  it('valid t() usage passes', () => {
    const code = wrap(`<p data-id="intro" style={{ position: 'relative' }}>{t('intro')}</p>`,
      `import { useTranslations } from 'next-intl';`);
    expect(codes(code)).not.toContain('TRANSLATION_HOOK_MISSING');
    expect(codes(code)).not.toContain('TRANSLATION_KEY_MISMATCH');
    expect(codes(code)).not.toContain('TRANSLATION_NAMESPACE_MISMATCH');
  });

  it('t() without import/hook is tier 1', () => {
    const code = `'use client';
export default function Page() {
  return (<div data-id="root" style={{ width: '100%', position: 'relative' }}><p data-id="intro" style={{ position: 'relative' }}>{t('intro')}</p></div>);
}`;
    expect(codes(code)).toContain('TRANSLATION_HOOK_MISSING');
  });

  it('key must equal the data-id', () => {
    const code = wrap(`<p data-id="intro" style={{ position: 'relative' }}>{t('welcome-copy')}</p>`,
      `import { useTranslations } from 'next-intl';`);
    expect(codes(code)).toContain('TRANSLATION_KEY_MISMATCH');
  });

  it('attr keys must be id__attr_<name>', () => {
    const bad = wrap(`<input data-id="email" placeholder={t('email-ph')} style={{ position: 'relative' }} />`,
      `import { useTranslations } from 'next-intl';`);
    expect(codes(bad)).toContain('TRANSLATION_KEY_MISMATCH');
    const good = wrap(`<input data-id="email" placeholder={t('email__attr_placeholder')} style={{ position: 'relative' }} />`,
      `import { useTranslations } from 'next-intl';`);
    expect(codes(good)).not.toContain('TRANSLATION_KEY_MISMATCH');
  });

  it('namespace must match the page slug', () => {
    const code = `'use client';
import { useTranslations } from 'next-intl';
export default function Page() {
  const t = useTranslations('landing');
  return (<div data-id="root" style={{ width: '100%', position: 'relative' }}><p data-id="intro" style={{ position: 'relative' }}>{t('intro')}</p></div>);
}`;
    expect(codes(code)).toContain('TRANSLATION_NAMESPACE_MISMATCH');
  });

  it('useResponsiveText is not treated as a translation call', () => {
    const code = wrap(`<p data-id="intro" style={{ position: 'relative' }}>{useResponsiveText('a', { 768: 'b' })}</p>`);
    expect(codes(code)).not.toContain('TRANSLATION_HOOK_MISSING');
  });
});
