/**
 * @vitest-environment jsdom
 *
 * Each shader template must parse/compile cleanly through the runtime
 * AND expose its @controls metadata. A shader with broken JSDoc / a
 * missing default-export wouldn't show up in the panel at all.
 */
import { describe, it, expect } from 'vitest';
import {
  WAVE_LINES_COMPONENT,
  WAVE_GRADIENT_COMPONENT,
  MESH_GRADIENT_COMPONENT,
  PLASMA_SHADER_COMPONENT,
  LIQUID_METAL_COMPONENT,
  CAUSTICS_LIGHT_COMPONENT,
  NEON_PARTICLE_FIELD_COMPONENT,
} from './index';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { hasComponentControls, parseComponentControlsMeta } from '@/code/components/controls-parser';

const SHADERS: { name: string; src: string; expectedLabel: string; minControls: number }[] = [
  { name: 'WaveLines',     src: WAVE_LINES_COMPONENT,     expectedLabel: 'Wave Lines',     minControls: 10 },
  { name: 'WaveGradient',  src: WAVE_GRADIENT_COMPONENT,  expectedLabel: 'Wave Gradient',  minControls: 11 },
  { name: 'MeshGradient',  src: MESH_GRADIENT_COMPONENT,  expectedLabel: 'Mesh Gradient',  minControls: 8 },
  { name: 'PlasmaShader',  src: PLASMA_SHADER_COMPONENT,  expectedLabel: 'Plasma',         minControls: 6 },
  { name: 'LiquidMetal',   src: LIQUID_METAL_COMPONENT,   expectedLabel: 'Liquid Metal',   minControls: 6 },
  { name: 'CausticsLight', src: CAUSTICS_LIGHT_COMPONENT, expectedLabel: 'Caustics',       minControls: 6 },
  { name: 'NeonParticleField', src: NEON_PARTICLE_FIELD_COMPONENT, expectedLabel: 'Neon Particles', minControls: 8 },
];

describe('Shader Code components', () => {
  for (const s of SHADERS) {
    it(`${s.name} has @controls metadata`, () => {
      expect(hasComponentControls(s.src)).toBe(true);
      const meta = parseComponentControlsMeta(s.src);
      expect(meta).not.toBeNull();
      expect(meta!.label).toBe(s.expectedLabel);
      expect(Object.keys(meta!.controls).length).toBeGreaterThanOrEqual(s.minControls);
    });

    it(`${s.name} compiles through code-component-runtime to a forwardRef component`, () => {
      const C = compileCodeComponent(s.src, s.name);
      expect(C).not.toBeNull();
      // withResponsiveProps now wraps in React.forwardRef → exotic OBJECT
      // ($$typeof: react.forward_ref), accepted by the runtime's
      // forwardRef-aware isRenderableComponent check — not a plain function.
      expect(typeof C).toBe('object');
      expect((C as any).$$typeof).toBe(Symbol.for('react.forward_ref'));
      expect(typeof (C as any).render).toBe('function');
    });
  }
});
