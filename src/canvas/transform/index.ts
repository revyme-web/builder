// transform/ — Canvas pan/zoom system.
// Re-exports everything so consumers import from '@/canvas/transform'.

export { transformManager } from './TransformManager';
export {
  zoomIn, zoomOut, zoomTo100, zoomToScale,
  zoomToFit, zoomToFitNodes, zoomToFitSelection, zoomToFitCanvasBounds,
  fitAllOnNextRender,
  panToNode, panToCanvasPoint,
} from './CameraCommands';
export {
  handleWheel,
  attachMiddleMousePan,
  handleHandToolDown, handleHandToolMove, handleHandToolUp, isPanning,
  setSpaceBarDown, isSpaceBarDown,
  handleSpacePanDown, handleSpacePanMove, handleSpacePanUp, isSpacePanning,
} from './InputHandler';
export {
  attachAutoPan, setActiveAutoPan, getActiveAutoPan,
} from './AutoPan';
export { cameraStash } from './camera-stash';
export { applyPageCameraForSwitch } from './page-camera';
export { hydrateCameras, initCameraPersist } from './camera-persist';
