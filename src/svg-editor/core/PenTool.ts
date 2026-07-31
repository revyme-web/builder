/**
 * PenTool — Click to place corners, click+drag to place curves.
 *
 * Behavior (matches Figma/the reference):
 * - Click: add a straight anchor point
 * - Click+drag: add anchor with mirrored bezier handles (drag sets direction/length)
 * - Click on first anchor: close the path
 * - Escape / double-click: finish open path
 * - While dragging: show preview of the curve being created
 */

import { PathModel } from './PathModel';
import type { Point } from './types';

export interface PenToolState {
  /** Is the pen tool actively drawing? */
  active: boolean;
  /** Is the user currently dragging to set a handle? */
  dragging: boolean;
  /** Current anchor being placed (during drag) */
  currentPoint: Point | null;
  /** Handle direction during drag */
  handleOut: Point | null;
  /** Preview line from last anchor to mouse */
  previewLine: { from: Point; to: Point } | null;
  /** Preview curve (if last anchor has an outgoing handle) */
  previewCurve: { from: Point; cp1: Point; cp2: Point; to: Point } | null;
}

export class PenTool {
  private model: PathModel;
  private _state: PenToolState = {
    active: false,
    dragging: false,
    currentPoint: null,
    handleOut: null,
    previewLine: null,
    previewCurve: null,
  };

  private dragStartPoint: Point | null = null;
  private onUpdate: (() => void) | null = null;

  constructor(model: PathModel, onUpdate?: () => void) {
    this.model = model;
    this.onUpdate = onUpdate ?? null;
  }

  get state(): PenToolState { return this._state; }

  /** Start pen tool mode. Begins a new path or continues the current one. */
  activate(startFresh: boolean = false): void {
    if (startFresh) {
      this.model.parse('');
    }
    this._state.active = true;
  }

  /** Finish and deactivate pen tool. */
  deactivate(): void {
    this._state = {
      active: false,
      dragging: false,
      currentPoint: null,
      handleOut: null,
      previewLine: null,
      previewCurve: null,
    };
  }

  /** Called on pointerdown in SVG space. */
  onPointerDown(svgPoint: Point): void {
    if (!this._state.active) return;

    // Check if clicking on the first anchor (close path)
    const anchors = this.model.anchors;
    if (anchors.length >= 3) {
      const first = anchors[0];
      const dist = Math.sqrt(
        (svgPoint.x - first.point.x) ** 2 + (svgPoint.y - first.point.y) ** 2,
      );
      if (dist < 5) {
        this.model.closePath();
        this.deactivate();
        this.onUpdate?.();
        return;
      }
    }

    this._state.dragging = true;
    this._state.currentPoint = { ...svgPoint };
    this.dragStartPoint = { ...svgPoint };
  }

  /** Called on pointermove in SVG space. */
  onPointerMove(svgPoint: Point): void {
    if (!this._state.active) return;

    if (this._state.dragging && this.dragStartPoint) {
      // Dragging: update handle preview
      this._state.handleOut = {
        x: svgPoint.x - this.dragStartPoint.x,
        y: svgPoint.y - this.dragStartPoint.y,
      };
      this._state.previewLine = null;
      this._state.previewCurve = null;
    } else {
      // Hovering: show preview line/curve from last anchor to mouse
      const anchors = this.model.anchors;
      if (anchors.length > 0) {
        const last = anchors[anchors.length - 1];
        if (last.handleOut) {
          // Last anchor has outgoing handle → preview curve
          const cp1 = {
            x: last.point.x + last.handleOut.x,
            y: last.point.y + last.handleOut.y,
          };
          this._state.previewCurve = {
            from: last.point,
            cp1,
            cp2: svgPoint, // simplified preview
            to: svgPoint,
          };
          this._state.previewLine = null;
        } else {
          // Preview straight line
          this._state.previewLine = { from: last.point, to: svgPoint };
          this._state.previewCurve = null;
        }
      }
    }

    this.onUpdate?.();
  }

  /** Called on pointerup in SVG space. */
  onPointerUp(svgPoint: Point): void {
    if (!this._state.active || !this._state.dragging) return;

    const start = this.dragStartPoint!;
    const dragDist = Math.sqrt(
      (svgPoint.x - start.x) ** 2 + (svgPoint.y - start.y) ** 2,
    );

    if (dragDist < 2) {
      // Click (no drag): add straight point
      this.model.addPointAtEnd(start, 'straight');
    } else {
      // Drag: add curved point with handle
      const handleOut = {
        x: svgPoint.x - start.x,
        y: svgPoint.y - start.y,
      };
      this.model.addCurvedPointAtEnd(start, handleOut);
    }

    this._state.dragging = false;
    this._state.currentPoint = null;
    this._state.handleOut = null;
    this.dragStartPoint = null;

    this.onUpdate?.();
  }

  /** Double-click or Escape: finish the path without closing. */
  finish(): void {
    this.deactivate();
    this.onUpdate?.();
  }
}
