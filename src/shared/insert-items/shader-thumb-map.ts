// shader-thumb-map.ts — Shaders-category item id → bundled cover image URL.
//
// Same rules as section-thumb-map: covers are IMPORTED so Vite serves them
// through the module graph (root-absolute paths 404 behind the dispatcher).
// The images are real renders of each shader (the Gem Smoke cover shows the
// upload-an-image glass treatment). Regenerate via the vendor bake harness
// when a shader's defaults change.

import gemSmoke from './shader-thumbs/gem-smoke.jpg';
import liquidMetal from './shader-thumbs/liquid-metal.jpg';
import meshGradient from './shader-thumbs/mesh-gradient.jpg';
import grainGradient from './shader-thumbs/grain-gradient.jpg';
import metaballs from './shader-thumbs/metaballs.jpg';
import smokeRing from './shader-thumbs/smoke-ring.jpg';

export const SHADER_THUMBS: Record<string, string> = {
  'cs-shaderGemSmoke': gemSmoke,
  'cs-shaderLiquidMetal': liquidMetal,
  'cs-shaderMeshGradient': meshGradient,
  'cs-shaderGrainGradient': grainGradient,
  'cs-shaderMetaballs': metaballs,
  'cs-shaderSmokeRing': smokeRing,
};
