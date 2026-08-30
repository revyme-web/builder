// section-thumb-map.ts — blueprint id → bundled cover image URL.
//
// The covers are IMPORTED (not public/ root paths) so Vite hashes and
// serves them through the module graph — root-absolute `/section_thumbs/…`
// URLs 404 when the editor is reached through the dispatcher
// (localhost:3001/builder/…), which owns the root path space.
//
// Regenerate the images with `node scripts/gen-section-thumbs.mjs` after
// changing a blueprint; a NEW blueprint needs its import added here.

import headerEditorial from './section-thumbs/header-editorial.jpg';
import headerGlass from './section-thumbs/header-glass.jpg';
import heroEditorial from './section-thumbs/hero-editorial.jpg';
import heroTypewall from './section-thumbs/hero-typewall.jpg';

export const SECTION_THUMBS: Record<string, string> = {
  'header-editorial': headerEditorial,
  'header-glass': headerGlass,
  'hero-editorial': heroEditorial,
  'hero-typewall': heroTypewall,
};
