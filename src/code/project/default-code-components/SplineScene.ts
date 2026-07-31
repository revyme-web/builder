// SplineScene — Code component template (Spline runtime 3D scene viewer).

export const SPLINE_SCENE_COMPONENT = `'use client';

/** @label "Spline Scene" */
/** @comment "Embed an interactive Spline 3D scene" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "sceneUrl": { "type": "text", "label": "Scene URL", "default": "" },
  "cameraX": { "type": "number", "label": "Camera X", "min": -180, "max": 180, "default": 0, "step": 1 },
  "cameraY": { "type": "number", "label": "Camera Y", "min": -90, "max": 90, "default": 0, "step": 1 }
} */

import { useState, useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function SplineScene({ sceneUrl = '', cameraX = 0, cameraY = 0, ...props }) {
  const canvasRef = useRef(null);
  const appRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sceneUrl || !canvasRef.current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadScene() {
      try {
        const { Application } = await import('@splinetool/runtime');
        if (cancelled) return;
        const app = new Application(canvasRef.current);
        await app.load(sceneUrl);
        if (cancelled) { app.dispose(); return; }
        appRef.current = app;
        setLoading(false);
      } catch (err) {
        if (!cancelled) { setError('Failed to load Spline scene'); setLoading(false); }
      }
    }

    loadScene();
    return () => { cancelled = true; if (appRef.current) { try { appRef.current.dispose(); } catch {} } appRef.current = null; };
  }, [sceneUrl]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{...props.style, position: 'relative', overflow: 'hidden'}}>
      <canvas ref={canvasRef} style={{width: '100%', height: '100%', display: 'block'}} />
      {loading && (
        <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12}}>
          Loading scene...
        </div>
      )}
      {error && (
        <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f87171', fontSize: 12}}>
          {error}
        </div>
      )}
    </div>
  );
}

export default withResponsiveProps(SplineScene);
`;
