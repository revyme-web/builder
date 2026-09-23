// The fixture is the baseline every case is judged against, so it must itself
// be oracle-clean — otherwise "the case introduced this violation" is a guess.
import { describe, test, expect } from 'vitest';
import { checkFile } from '@/code/oracle/check-file';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { isPageServerFile } from '@/code/project/active-file-store';
import { FIXTURE_FILES } from './fixture';

describe('the capability fixture project', () => {
  for (const [path, code] of Object.entries(FIXTURE_FILES)) {
    // The server half of a page pair is plumbing the builder writes and never
    // edits; the oracle's page rules are about the CLIENT half.
    if (!path.endsWith('.tsx') || isPageServerFile(path)) continue;
    test(`${path} passes the oracle`, () => {
      const kind = path.startsWith('components/') ? (isCodeComponentSource(code) ? 'code-component' : 'component') : 'page';
      const violations = checkFile(code, { kind, path });
      expect(violations.map((v) => `${v.code}: ${v.message.slice(0, 160)}`)).toEqual([]);
    });
  }
});
