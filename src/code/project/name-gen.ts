// name-gen.ts — Random PascalCase file-name generator shared by
// component-ops (`generateInternalName`) and icon-set-template
// (`generateIconSetName`). Both previously carried a byte-identical
// SYLLABLES list + pick loop; this is that single implementation.

import { projectFS } from './project-fs';

const SYLLABLES = ['Ba','Ce','Da','Fe','Ga','He','Ji','Ka','Le','Ma','Ne','Po','Qi','Re','Se','Ta','Vu','We','Xi','Za',
  'Bi','Co','Du','Fi','Go','Hu','Jo','Ku','Li','Mo','Nu','Pa','Ro','Su','Ti','Ux','Vi','Wo','Yu','Zo'];

/**
 * Generate a unique 3-syllable PascalCase name (~64k entropy, 50 retries)
 * whose `${dir}/{Name}.tsx` path does not yet exist in the project.
 * Falls back to `fallbackPrefix + timestamp` when all retries collide.
 */
export function generateSyllableName(dir: string, fallbackPrefix: string): string {
  const pick = () => SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = pick() + pick() + pick();
    if (!projectFS.exists(`${dir}/${name}.tsx`)) return name;
  }
  return fallbackPrefix + Date.now().toString(36).slice(-6);
}
