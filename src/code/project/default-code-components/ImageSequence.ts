// ImageSequence — Code component template (scroll-driven frame-by-frame animation).

export const IMAGE_SEQUENCE_COMPONENT = `'use client';

/** @label "Image Sequence" */
/** @comment "Scroll-driven frame-by-frame animation from uploaded image sequence" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "folder": { "type": "upload", "label": "Frames", "default": "", "accept": "image/*", "multiple": true, "uploadSource": "sequence" },
  "totalFrames": { "type": "number", "label": "Total Frames", "min": 1, "max": 9999, "default": 60, "step": 1 },
  "frame": { "type": "number", "label": "Current Frame", "min": 0, "max": 299, "default": 0, "step": 1 },
  "fit": { "type": "select", "label": "Fit", "default": "contain", "options": [{"label":"Contain","value":"contain"},{"label":"Cover","value":"cover"},{"label":"Fill","value":"fill"}] },
  "scrollDriven": { "type": "toggle", "label": "Scroll Drive", "default": false }
} */

import { useState, useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function ImageSequence({ folder = '/frames', totalFrames = 60, frame = 0, fit = 'contain', scrollDriven = false, ...props }) {
  const canvasRef = useRef(null);
  const imagesRef = useRef([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!folder) return;
    const images = [];
    let loadedCount = 0;
    const urls = folder.includes('|') ? folder.split('|') : [];
    const isUrlList = urls.length > 0;
    const count = isUrlList ? urls.length : totalFrames;
    for (let i = 0; i < count; i++) {
      const img = new Image();
      img.src = isUrlList ? urls[i] : folder + '/frame-' + String(i + 1).padStart(3, '0') + '.webp';
      img.onload = () => { loadedCount++; if (loadedCount === count) setLoaded(true); };
      img.onerror = () => { loadedCount++; if (loadedCount === count) setLoaded(true); };
      images.push(img);
    }
    imagesRef.current = images;
  }, [folder, totalFrames]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const idx = Math.max(0, Math.min(Math.round(frame), imagesRef.current.length - 1));
    const img = imagesRef.current[idx];
    if (!img || !img.complete || !img.naturalWidth) return;
    canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
    canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fitMode = fit;
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    let dx = 0, dy = 0, dw = canvas.width, dh = canvas.height;
    if (fitMode === 'contain' || fitMode === 'cover') {
      const imgRatio = img.naturalWidth / img.naturalHeight;
      const canvasRatio = canvas.width / canvas.height;
      if ((fitMode === 'contain' && imgRatio > canvasRatio) || (fitMode === 'cover' && imgRatio < canvasRatio)) {
        dw = canvas.width;
        dh = dw / imgRatio;
        dy = (canvas.height - dh) / 2;
      } else {
        dh = canvas.height;
        dw = dh * imgRatio;
        dx = (canvas.width - dw) / 2;
      }
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }, [frame, loaded, fit]);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const observer = new MutationObserver(() => {
      const dataFrame = el.getAttribute('data-frame');
      if (dataFrame != null) {
        const idx = parseInt(dataFrame, 10);
        if (!isNaN(idx)) {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d');
          const img = imagesRef.current[Math.max(0, Math.min(idx, imagesRef.current.length - 1))];
          if (ctx && img && img.complete && img.naturalWidth) {
            canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
            canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
        }
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-frame'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!scrollDriven || !loaded || imagesRef.current.length === 0) return;
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const total = rect.height + vh;
      const progress = Math.min(1, Math.max(0, (vh - rect.top) / total));
      const idx = Math.round(progress * (imagesRef.current.length - 1));
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const img = imagesRef.current[idx];
      if (ctx && img && img.complete && img.naturalWidth) {
        canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
        canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(draw); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollDriven, loaded]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{...props.style, position: 'relative', overflow: 'hidden'}}>
      <canvas ref={canvasRef} style={{width: '100%', height: '100%', display: 'block'}} />
      {!loaded && (
        <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12}}>
          Loading frames...
        </div>
      )}
    </div>
  );
}

export default withResponsiveProps(ImageSequence);
`;
