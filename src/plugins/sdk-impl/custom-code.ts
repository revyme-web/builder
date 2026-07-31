// plugins/sdk-impl/custom-code.ts — customCode.* namespace.
//
// Site-wide head / body script injection. Stored as a single JSON
// blob at `app/_custom-code.json` with four keyed locations
// (headStart, headEnd, bodyStart, bodyEnd). The publish pipeline
// reads this file at export time.

import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import type { CustomCode } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

const FILE = 'app/_custom-code.json';
const VALID_LOCATIONS = ['headStart', 'headEnd', 'bodyStart', 'bodyEnd'] as const;

function readCustomCode(): CustomCode {
  const raw = projectFS.readFile(FILE);
  const empty: CustomCode = { headStart: null, headEnd: null, bodyStart: null, bodyEnd: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomCode>;
    return {
      headStart: typeof parsed.headStart === 'string' ? parsed.headStart : null,
      headEnd: typeof parsed.headEnd === 'string' ? parsed.headEnd : null,
      bodyStart: typeof parsed.bodyStart === 'string' ? parsed.bodyStart : null,
      bodyEnd: typeof parsed.bodyEnd === 'string' ? parsed.bodyEnd : null,
    };
  } catch {
    return empty;
  }
}

export const customCodeHandlers: Record<string, RpcHandler> = {
  'customCode.getCustomCode': async () => readCustomCode(),

  'customCode.setCustomCode': async (params): Promise<void> => {
    const p = params as { location?: unknown; html?: unknown };
    if (!VALID_LOCATIONS.includes(p?.location as typeof VALID_LOCATIONS[number])) {
      throw new Error(`customCode.setCustomCode: location must be one of ${VALID_LOCATIONS.join(', ')}`);
    }
    if (p.html !== null && typeof p.html !== 'string') {
      throw new Error('customCode.setCustomCode: html must be string or null');
    }
    const next = { ...readCustomCode(), [p.location as string]: p.html };
    projectFS.writeFile(FILE, JSON.stringify(next, null, 2));
    store.set(projectVersionAtom, (v) => v + 1);
  },
};
