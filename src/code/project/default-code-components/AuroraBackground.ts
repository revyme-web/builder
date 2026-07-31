// AuroraBackground — Code component template (WebGL fragment-shader aurora).
//
// Fullscreen quad, all the work in the fragment shader. Two independent fBm
// fields drive the effect: one warps the horizontal position of the curtain
// so it ripples, the other pushes its vertical centre up and down so the
// band drifts. A gaussian falloff around that moving centre gives the soft
// glow edge, and the three colours are mixed by a third noise sample so the
// hue varies along the curtain instead of being a flat gradient.
//
// Noise is a hand-rolled hash + smoothstep value noise stacked into fBm.
// That is deliberate: the widely-copied simplex `snoise` implementations are
// somebody's licensed code, whereas hash-and-interpolate value noise is
// trivial maths with no provenance to carry. It is marginally cheaper too,
// and at this blur radius the quality difference is invisible.
//
// Performance: `useStaticCanvas()` renders exactly one frame at a fixed time
// offset and never starts a rAF loop, so a page holding several of these on
// the editor canvas doesn't run several GPU loops at once.

export const AURORA_BACKGROUND_COMPONENT = `'use client';

/** @label "Aurora Background" */
/** @comment "Animated northern-lights curtain rendered on the GPU." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "colorA": { "type": "color", "label": "Color 1", "default": "#0ea5e9" },
  "colorB": { "type": "color", "label": "Color 2", "default": "#a855f7" },
  "colorC": { "type": "color", "label": "Color 3", "default": "#22d3ee" },
  "bgColor": { "type": "color", "label": "Background", "default": "#020617" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 3, "step": 0.05, "default": 1 },
  "scale": { "type": "number", "label": "Scale", "min": 0.5, "max": 6, "step": 0.1, "default": 2.2 },
  "spread": { "type": "number", "label": "Spread", "min": 0.05, "max": 0.6, "step": 0.01, "default": 0.22 },
  "intensity": { "type": "number", "label": "Intensity", "min": 0.2, "max": 2.5, "step": 0.05, "default": 1.1 }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

const VERT = [
  'attribute vec2 aPos;',
  'void main() {',
  '  gl_Position = vec4(aPos, 0.0, 1.0);',
  '}',
].join('\\n');

const FRAG = [
  'precision highp float;',
  'uniform vec2  uRes;',
  'uniform float uTime;',
  'uniform vec3  uA;',
  'uniform vec3  uB;',
  'uniform vec3  uC;',
  'uniform vec3  uBg;',
  'uniform float uScale;',
  'uniform float uSpread;',
  'uniform float uIntensity;',
  '',
  'float hash(vec2 p) {',
  '  return fract(sin(dot(p, vec2(41.31, 289.07))) * 43758.5453);',
  '}',
  '',
  'float vnoise(vec2 p) {',
  '  vec2 i = floor(p);',
  '  vec2 f = fract(p);',
  '  vec2 u = f * f * (3.0 - 2.0 * f);',
  '  float a = hash(i);',
  '  float b = hash(i + vec2(1.0, 0.0));',
  '  float c = hash(i + vec2(0.0, 1.0));',
  '  float d = hash(i + vec2(1.0, 1.0));',
  '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
  '}',
  '',
  'float fbm(vec2 p) {',
  '  float sum = 0.0;',
  '  float amp = 0.5;',
  '  for (int i = 0; i < 5; i++) {',
  '    sum += amp * vnoise(p);',
  '    p *= 2.03;',
  '    amp *= 0.5;',
  '  }',
  '  return sum;',
  '}',
  '',
  'void main() {',
  '  vec2 uv = gl_FragCoord.xy / uRes;',
  '  float t = uTime * 0.08;',
  '',
  '  // Ripple across the curtain, and a slower drift of its centre line.',
  '  float ripple = fbm(vec2(uv.x * uScale + t, uv.y * 1.6 - t * 0.4));',
  '  float drift  = fbm(vec2(uv.x * uScale * 0.5 - t * 0.6, 3.7));',
  '',
  '  float centre = 0.52 + (drift - 0.5) * 0.5 + (ripple - 0.5) * 0.22;',
  '  float dy = (uv.y - centre) / max(0.01, uSpread);',
  '  float curtain = exp(-dy * dy);',
  '',
  '  // Vertical streaking: high-frequency noise along x only.',
  '  float streak = 0.65 + 0.35 * fbm(vec2(uv.x * uScale * 6.0 + t * 1.7, 11.3));',
  '  curtain *= streak;',
  '',
  '  // Hue varies along the curtain rather than being a flat ramp.',
  '  float m1 = clamp(fbm(vec2(uv.x * uScale * 1.3 + t * 0.9, 21.1)), 0.0, 1.0);',
  '  float m2 = clamp(ripple, 0.0, 1.0);',
  '  vec3 tint = mix(mix(uA, uB, m1), uC, m2 * 0.6);',
  '',
  '  vec3 col = uBg + tint * curtain * uIntensity;',
  '  gl_FragColor = vec4(col, 1.0);',
  '}',
].join('\\n');

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const full = s.length === 3
    ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    : s;
  const n = parseInt(full || '000000', 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
  ];
}

function AuroraBackground({
  colorA = '#0ea5e9',
  colorB = '#a855f7',
  colorC = '#22d3ee',
  bgColor = '#020617',
  speed = 1,
  scale = 2.2,
  spread = 0.22,
  intensity = 1.1,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { antialias: false, alpha: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) return;

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    // Two triangles covering clip space.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uA = gl.getUniformLocation(prog, 'uA');
    const uB = gl.getUniformLocation(prog, 'uB');
    const uC = gl.getUniformLocation(prog, 'uC');
    const uBg = gl.getUniformLocation(prog, 'uBg');
    const uScale = gl.getUniformLocation(prog, 'uScale');
    const uSpread = gl.getUniformLocation(prog, 'uSpread');
    const uIntensity = gl.getUniformLocation(prog, 'uIntensity');

    const ca = hexToRgb(colorA);
    const cb = hexToRgb(colorB);
    const cc = hexToRgb(colorC);
    const cbg = hexToRgb(bgColor);
    gl.uniform3f(uA, ca[0], ca[1], ca[2]);
    gl.uniform3f(uB, cb[0], cb[1], cb[2]);
    gl.uniform3f(uC, cc[0], cc[1], cc[2]);
    gl.uniform3f(uBg, cbg[0], cbg[1], cbg[2]);
    gl.uniform1f(uScale, scale);
    gl.uniform1f(uSpread, spread);
    gl.uniform1f(uIntensity, intensity);

    // Cap DPR — a full-viewport aurora at 3x on a retina phone is a lot of
    // fragments for a background layer nobody inspects closely.
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    function resize() {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    }

    function render(timeSec) {
      resize();
      gl.uniform1f(uTime, timeSec);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    const ro = new ResizeObserver(function () {
      if (isStatic) render(12.0);
    });
    ro.observe(canvas);

    // Static canvas: one frame at an offset that has the curtain formed.
    if (isStatic) {
      render(12.0);
      return function () {
        ro.disconnect();
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
      };
    }

    let raf = 0;
    const start = performance.now();

    function tick(now) {
      render(((now - start) / 1000) * Math.max(0, speed));
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return function () {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [colorA, colorB, colorC, bgColor, speed, scale, spread, intensity, isStatic]);

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', overflow: 'hidden', backgroundColor: bgColor, ...props.style }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: '0px', left: '0px', width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}

export default withResponsiveProps(AuroraBackground);
`;
