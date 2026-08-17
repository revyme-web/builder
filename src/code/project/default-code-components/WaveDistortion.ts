// WaveDistortion — Code component template (WebGL fragment-shader sine-wave warp).
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, single draw on resize) on the editor canvas. Live
// preview and the published site keep the full animated version.

export const WAVE_DISTORTION_COMPONENT = `'use client';

/** @label "Wave Distortion" */
/** @comment "WebGL fragment shader that warps an animated gradient with sine waves" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "speed": { "type": "number", "label": "Speed", "min": 0.1, "max": 4, "default": 0.8, "step": 0.05 },
  "amplitude": { "type": "number", "label": "Amplitude", "min": 0, "max": 0.5, "default": 0.18, "step": 0.005 },
  "frequency": { "type": "number", "label": "Frequency", "min": 1, "max": 30, "default": 8, "step": 0.5 },
  "colorA": { "type": "color", "label": "Color A", "default": "#06b6d4" },
  "colorB": { "type": "color", "label": "Color B", "default": "#3b82f6" },
  "colorC": { "type": "color", "label": "Color C", "default": "#0f172a" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function hexToVec3Wave(hex) {
  const h = (hex || '').replace('#', '').padEnd(6, '0').slice(0, 6);
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function WaveDistortion({
  speed = 0.8, amplitude = 0.18, frequency = 8,
  colorA = '#06b6d4', colorB = '#3b82f6', colorC = '#0f172a',
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl');
    if (!gl) return;

    const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
    const FS = [
      'precision highp float;',
      'uniform vec2 uRes;',
      'uniform float uTime;',
      'uniform float uAmp;',
      'uniform float uFreq;',
      'uniform vec3 uA;',
      'uniform vec3 uB;',
      'uniform vec3 uC;',
      'void main(){',
      '  vec2 uv = gl_FragCoord.xy / uRes.xy;',
      '  vec2 p = uv;',
      '  p.x += sin(uv.y * uFreq + uTime * 1.3) * uAmp;',
      '  p.y += cos(uv.x * uFreq * 0.7 + uTime * 0.9) * uAmp * 0.7;',
      '  float t1 = sin(p.x * 6.2831 + uTime) * 0.5 + 0.5;',
      '  float t2 = sin(p.y * 6.2831 - uTime * 0.7) * 0.5 + 0.5;',
      '  vec3 col = mix(uC, uA, t1);',
      '  col = mix(col, uB, t2 * 0.7);',
      '  float scan = 0.95 + 0.05 * sin(gl_FragCoord.y * 1.6);',
      '  gl_FragColor = vec4(col * scan, 1.0);',
      '}',
    ].join('\\n');

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uAmp = gl.getUniformLocation(program, 'uAmp');
    const uFreq = gl.getUniformLocation(program, 'uFreq');
    const uA = gl.getUniformLocation(program, 'uA');
    const uB = gl.getUniformLocation(program, 'uB');
    const uC = gl.getUniformLocation(program, 'uC');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      canvas.width = Math.max(1, canvas.clientWidth * dpr);
      canvas.height = Math.max(1, canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const cA = hexToVec3Wave(colorA);
    const cB = hexToVec3Wave(colorB);
    const cC = hexToVec3Wave(colorC);
    const start = isStatic
      ? performance.now() - 1000 / Math.max(speed, 0.1)
      : performance.now();
    let raf = 0;
    function tick() {
      const tSec = ((performance.now() - start) / 1000) * speed;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, tSec);
      gl.uniform1f(uAmp, amplitude);
      gl.uniform1f(uFreq, frequency);
      gl.uniform3f(uA, cA[0], cA[1], cA[2]);
      gl.uniform3f(uB, cB[0], cB[1], cB[2]);
      gl.uniform3f(uC, cC[0], cC[1], cC[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!isStatic) raf = requestAnimationFrame(tick);
    }

    if (isStatic) {
      tick();
      const _staticRo = new ResizeObserver(() => { resize(); tick(); });
      _staticRo.observe(canvas);
      return () => {
        _staticRo.disconnect();
        ro.disconnect();
        gl.deleteBuffer(buf);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(program);
      };
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
    };
  }, [speed, amplitude, frequency, colorA, colorB, colorC, isStatic]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{  position: 'relative', overflow: 'hidden', ...props.style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(WaveDistortion);
`;
