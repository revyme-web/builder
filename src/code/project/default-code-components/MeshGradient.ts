// MeshGradient — Code component template (CSS radial-gradient blob mesh).
//
// Five absolutely-positioned `<motion.div>` blobs with `mix-blend-mode:
// lighter` drift over the frame inside a container with `filter: blur(N)`.
// The browser caches the blurred layer between frames; only the blob
// transforms (driven by MotionValues, no React re-renders) update per
// frame. Slider drags only re-rasterize the static layer once per change
// instead of per-frame Canvas 2D paint.
//
// `useStaticCanvas()` from `@revyme/runtime` flips the code component into a
// paint-once branch on the editor canvas — sets the blob positions for t=0.5
// and stops, no rAF.

export const MESH_GRADIENT_COMPONENT = `'use client';

/** @label "Mesh Gradient" */
/** @comment "Soft drifting color blobs blended into a single continuous gradient." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "color1": { "type": "color", "label": "Color 1", "default": "#FF6B6B" },
  "color2": { "type": "color", "label": "Color 2", "default": "#FFD93D" },
  "color3": { "type": "color", "label": "Color 3", "default": "#6BCB77" },
  "color4": { "type": "color", "label": "Color 4", "default": "#4D96FF" },
  "color5": { "type": "color", "label": "Color 5", "default": "#FF9CEE" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 3, "step": 0.05, "default": 0.5 },
  "blur": { "type": "number", "label": "Blur", "min": 0, "max": 80, "step": 1, "default": 32 },
  "scale": { "type": "number", "label": "Scale", "min": 0.4, "max": 2.5, "step": 0.05, "default": 1.2 },
  "saturation": { "type": "number", "label": "Saturation", "min": 0.2, "max": 2, "step": 0.05, "default": 1 }
} */

import React, { useEffect } from 'react';
import { motion, useMotionValue, useTransform, useAnimationFrame } from 'framer-motion';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function MeshGradient({
  color1 = '#FF6B6B',
  color2 = '#FFD93D',
  color3 = '#6BCB77',
  color4 = '#4D96FF',
  color5 = '#FF9CEE',
  speed = 0.5,
  blur = 32,
  scale = 1.2,
  saturation = 1,
  ...props
}) {
  const isStatic = useStaticCanvas();

  const x0 = useMotionValue(50);
  const y0 = useMotionValue(50);
  const x1 = useMotionValue(50);
  const y1 = useMotionValue(50);
  const x2 = useMotionValue(50);
  const y2 = useMotionValue(50);
  const x3 = useMotionValue(50);
  const y3 = useMotionValue(50);
  const x4 = useMotionValue(50);
  const y4 = useMotionValue(50);

  const lx0 = useTransform(x0, v => v + '%');
  const ly0 = useTransform(y0, v => v + '%');
  const lx1 = useTransform(x1, v => v + '%');
  const ly1 = useTransform(y1, v => v + '%');
  const lx2 = useTransform(x2, v => v + '%');
  const ly2 = useTransform(y2, v => v + '%');
  const lx3 = useTransform(x3, v => v + '%');
  const ly3 = useTransform(y3, v => v + '%');
  const lx4 = useTransform(x4, v => v + '%');
  const ly4 = useTransform(y4, v => v + '%');

  const setAll = (timeSec) => {
    const xs = [x0, x1, x2, x3, x4];
    const ys = [y0, y1, y2, y3, y4];
    for (let i = 0; i < 5; i++) {
      const phase = i * 1.7 + timeSec;
      xs[i].set(50 + Math.cos(phase * 0.7 + i) * 35);
      ys[i].set(50 + Math.sin(phase * 0.9 + i * 1.3) * 35);
    }
  };

  useAnimationFrame((t) => {
    if (isStatic) return;
    setAll((t / 1000) * speed);
  });

  useEffect(() => {
    if (!isStatic) return;
    setAll(0.5 * speed);
  }, [isStatic, speed]);

  const colors = [color1, color2, color3, color4, color5];
  const lefts = [lx0, lx1, lx2, lx3, lx4];
  const tops = [ly0, ly1, ly2, ly3, ly4];

  const blobSize = (80 * scale) + '%';

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        ...props.style,
        position: 'relative',
        overflow: 'hidden',
        filter: 'blur(' + blur + 'px) saturate(' + saturation + ')',
        backgroundColor: color1,
      }}
    >
      {colors.map((c, i) => (
        <motion.div
          key={i}
          style={{
            position: 'absolute',
            width: blobSize,
            height: blobSize,
            left: lefts[i],
            top: tops[i],
            translateX: '-50%',
            translateY: '-50%',
            backgroundImage: 'radial-gradient(circle, ' + c + ' 0%, rgba(0,0,0,0) 70%)',
            mixBlendMode: 'lighter',
            pointerEvents: 'none',
            willChange: 'left, top',
          }}
        />
      ))}
    </div>
  );
}

export default withResponsiveProps(MeshGradient);
`;
