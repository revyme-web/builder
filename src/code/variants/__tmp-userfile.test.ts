import { describe, test, expect, vi } from 'vitest';
import { parse as babelParse } from '@babel/parser';
import fs from 'fs';
let capturedTransform: ((code: string) => string) | null = null;
vi.mock('../project/modify-file', () => ({
  modifyProjectFile: (_f: string, t: (c: string) => string) => { capturedTransform = t; return null; },
}));
import { removeVariant } from './variant-ops';

describe('user file', () => {
  test('RoJiKu delete variant-1 parses', () => {
    const code = fs.readFileSync('debug_output/debug-code-before.jsx', 'utf8');
    removeVariant('components/RoJiKu.tsx', 'variant-1');
    const out = capturedTransform!(code);
    fs.writeFileSync('/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/012f3ab6-0602-4174-9b7f-bac47b2bb6c3/scratchpad/rojiku-after.jsx', out);
    expect(out).not.toBe(code);
    babelParse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    expect(out).not.toContain('variant-1');
  });
});
