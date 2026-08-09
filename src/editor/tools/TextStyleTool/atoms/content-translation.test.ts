// content-translation.test.ts — the Content row on a localized page.
//
// The bug these lock: a `{t('key')}` text node showed a BLANK Content row
// (user report 2026-08-09). `textContent` is empty by design for those nodes,
// and the resolved message — which `buildTranslationTextOverrides` had already
// computed for the default locale — was gated behind a `!isDefaultLocale`
// check, so this row never read it.

import { describe, it, expect } from 'vitest';
import { resolveTranslatedContent } from './content-translation';

describe('resolveTranslatedContent', () => {
  it('resolves the message for a translated node', () => {
    expect(resolveTranslatedContent({ translationKey: 'hero-title', overrideText: 'Three hours.' }))
      .toEqual({ isTranslated: true, text: 'Three hours.' });
  });

  it('leaves an untranslated node alone', () => {
    // The caller keeps its existing textContent / variant / CMS ladder.
    expect(resolveTranslatedContent({ translationKey: undefined, overrideText: 'ignored' }))
      .toEqual({ isTranslated: false, text: '' });
  });

  it('an unseeded key is EMPTY but still translated', () => {
    // The two answers must not collapse. Reading "" as "not translated" would
    // send the first edit down the JSX path, and `updateNodeTextInCode` appends
    // a JSXText when it finds none to replace — leaving the element rendering
    // its translation AND the typed text.
    expect(resolveTranslatedContent({ translationKey: 'hero-title', overrideText: '' }))
      .toEqual({ isTranslated: true, text: '' });
    expect(resolveTranslatedContent({ translationKey: 'hero-title', overrideText: undefined }))
      .toEqual({ isTranslated: true, text: '' });
  });

  it('strips markup, as every other Content branch does', () => {
    expect(resolveTranslatedContent({
      translationKey: 'k', overrideText: 'Three <span style="color:red">hours</span>.',
    }).text).toBe('Three hours.');
  });

  it('is keyed by the translation call, not by having text', () => {
    // A node can carry a key while its message is still being typed; it can
    // equally carry text with no key (a plain JSX string). Only the key
    // decides where the words live.
    expect(resolveTranslatedContent({ translationKey: '', overrideText: 'plain' }).isTranslated)
      .toBe(false);
    expect(resolveTranslatedContent({ translationKey: 'k', overrideText: null }).isTranslated)
      .toBe(true);
  });
});
