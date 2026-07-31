// ModelViewer — Code component template (Three.js .glb model viewer with orbit camera).

export const MODEL_VIEWER_COMPONENT = `'use client';

/** @label "3D Model Viewer" */
/** @comment "Interactive Three.js 3D model viewer for .glb files" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "modelPath": { "type": "text", "label": "Model (.glb)", "default": "" },
  "cameraX": { "type": "number", "label": "Camera Orbit X", "min": -180, "max": 180, "default": 0, "step": 1 },
  "cameraY": { "type": "number", "label": "Camera Orbit Y", "min": -90, "max": 90, "default": 20, "step": 1 },
  "cameraDistance": { "type": "number", "label": "Camera Distance", "min": 1, "max": 20, "default": 5, "step": 0.1 },
  "rotateY": { "type": "number", "label": "Model Rotation", "min": -180, "max": 180, "default": 0, "step": 1 },
  "envIntensity": { "type": "number", "label": "Lighting", "min": 0, "max": 3, "default": 1, "step": 0.1 },
  "bgColor": { "type": "color", "label": "Background", "default": "transparent" },
  "autoRotate": { "type": "toggle", "label": "Auto Rotate", "default": false }
} */

import { useState, useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function ModelViewer({
  modelPath = '', cameraX = 0, cameraY = 20, cameraDistance = 5,
  rotateY = 0, envIntensity = 1, bgColor = 'transparent', autoRotate = false,
  ...props
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const modelRef = useRef(null);
  const rafRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    async function init() {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

        if (cancelled) return;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(50, container.offsetWidth / container.offsetHeight, 0.1, 1000);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: bgColor === 'transparent' });
        renderer.setSize(container.offsetWidth, container.offsetHeight);
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        if (bgColor !== 'transparent') {
          renderer.setClearColor(new THREE.Color(bgColor), 1);
        }
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4 * envIntensity);
        scene.add(ambientLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8 * envIntensity);
        dirLight.position.set(5, 10, 7);
        scene.add(dirLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3 * envIntensity);
        fillLight.position.set(-5, 3, -5);
        scene.add(fillLight);

        if (modelPath) {
          setLoading(true);
          const loader = new GLTFLoader();
          loader.load(
            modelPath,
            (gltf) => {
              if (cancelled) return;
              const model = gltf.scene;
              const box = new THREE.Box3().setFromObject(model);
              const center = box.getCenter(new THREE.Vector3());
              model.position.sub(center);
              const size = box.getSize(new THREE.Vector3()).length();
              const scale = 2 / size;
              model.scale.setScalar(scale);
              scene.add(model);
              modelRef.current = model;
              setLoading(false);
            },
            undefined,
            (err) => { if (!cancelled) { setError('Failed to load model'); setLoading(false); } }
          );
        }

        function animate() {
          if (cancelled) return;
          rafRef.current = requestAnimationFrame(animate);
          renderer.render(scene, camera);
        }
        animate();
      } catch (err) {
        if (!cancelled) setError('Three.js not available');
      }
    }

    init();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (rendererRef.current.domElement?.parentElement) {
          rendererRef.current.domElement.remove();
        }
      }
    };
  }, [modelPath]);

  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const phi = (90 - cameraY) * Math.PI / 180;
    const theta = cameraX * Math.PI / 180;
    camera.position.x = cameraDistance * Math.sin(phi) * Math.sin(theta);
    camera.position.y = cameraDistance * Math.cos(phi);
    camera.position.z = cameraDistance * Math.sin(phi) * Math.cos(theta);
    camera.lookAt(0, 0, 0);
  }, [cameraX, cameraY, cameraDistance]);

  useEffect(() => {
    const model = modelRef.current;
    if (model) model.rotation.y = rotateY * Math.PI / 180;
  }, [rotateY]);

  useEffect(() => {
    if (!autoRotate || !modelRef.current) return;
    let angle = modelRef.current.rotation.y;
    const spin = () => {
      if (!modelRef.current) return;
      angle += 0.005;
      modelRef.current.rotation.y = angle;
      requestAnimationFrame(spin);
    };
    const id = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(id);
  }, [autoRotate]);

  return (
    <div ref={containerRef} data-id={props['data-id']} data-name={props['data-name']}
         style={{...props.style, position: 'relative', overflow: 'hidden'}}>
      {loading && (
        <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12}}>
          Loading model...
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

export default withResponsiveProps(ModelViewer);
`;
