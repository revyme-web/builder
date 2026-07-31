// svg-path-model.ts — Mutable SVG path data model for visual editing.
// Ported from Yqnn/svg-path-editor (Apache 2.0).
// Provides SvgPoint, SvgControlPoint, SvgItem (+ subclasses), and SvgPath.

import { trace } from '@/shared/debug-trace';
import { parseSvgPath } from '@/shared/svg-path/svg-path-parser';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

// ─── SvgPoint ────────────────────────────────────────────────────────────────

/** An anchor point on the path. */
export class SvgPoint {
  x: number;
  y: number;
  itemIndex: number;
  movable: boolean;

  constructor(x: number, y: number, itemIndex: number, movable = true) {
    this.x = x;
    this.y = y;
    this.itemIndex = itemIndex;
    this.movable = movable;
  }
}

// ─── SvgControlPoint ─────────────────────────────────────────────────────────

/** A Bezier control handle. */
export class SvgControlPoint extends SvgPoint {
  subIndex: number;
  relations: SvgControlPoint[];

  constructor(x: number, y: number, itemIndex: number, subIndex: number) {
    super(x, y, itemIndex, true);
    this.subIndex = subIndex;
    this.relations = [];
  }
}

// ─── SvgItem (abstract base) ─────────────────────────────────────────────────

/** Abstract base for one path command. */
export abstract class SvgItem {
  values: number[];
  relative: boolean;
  previousPoint: Point = { x: 0, y: 0 };
  absolutePoints: SvgPoint[] = [];
  absoluteControlPoints: SvgControlPoint[] = [];

  constructor(relative: boolean, values: number[]) {
    this.relative = relative;
    this.values = values;
  }

  /** Factory: create the right subclass from parser output tokens. */
  static Make(tokens: string[]): SvgItem {
    const letter = tokens[0];
    const upperLetter = letter.toUpperCase();
    const relative = letter !== upperLetter;
    const nums = tokens.slice(1).map(Number);

    switch (upperLetter) {
      case 'M': return new MoveTo(relative, nums);
      case 'L': return new LineTo(relative, nums);
      case 'H': return new HorizontalLineTo(relative, nums);
      case 'V': return new VerticalLineTo(relative, nums);
      case 'Z': return new ClosePath(relative);
      case 'C': return new CurveTo(relative, nums);
      case 'S': return new SmoothCurveTo(relative, nums);
      case 'Q': return new QuadraticBezierCurveTo(relative, nums);
      case 'T': return new SmoothQuadraticBezierCurveTo(relative, nums);
      case 'A': return new EllipticalArcTo(relative, nums);
      default:
        trace.error('SvgItem.Make', { message: 'unknown command', letter });
        return new LineTo(false, [0, 0]);
    }
  }

  /** Convert an existing item to a new type, preserving position. */
  static MakeFrom(origin: SvgItem, previous: Point, newType: string): SvgItem {
    trace.fn('SvgItem.MakeFrom', { from: origin.getType(), to: newType });

    const upper = newType.toUpperCase();
    const relative = newType !== upper;

    // Get the absolute endpoint of the origin item
    const endAbs = origin.getEndPoint();

    // Helper: make values relative if needed
    const toVal = (absX: number, absY: number): [number, number] => {
      if (relative) return [absX - previous.x, absY - previous.y];
      return [absX, absY];
    };

    switch (upper) {
      case 'L': {
        const [x, y] = toVal(endAbs.x, endAbs.y);
        return new LineTo(relative, [x, y]);
      }
      case 'H': {
        const x = relative ? endAbs.x - previous.x : endAbs.x;
        return new HorizontalLineTo(relative, [x]);
      }
      case 'V': {
        const y = relative ? endAbs.y - previous.y : endAbs.y;
        return new VerticalLineTo(relative, [y]);
      }
      case 'C': {
        // Convert to cubic: place control points at 1/3 and 2/3 along the line
        const cp1x = previous.x + (endAbs.x - previous.x) / 3;
        const cp1y = previous.y + (endAbs.y - previous.y) / 3;
        const cp2x = previous.x + (endAbs.x - previous.x) * 2 / 3;
        const cp2y = previous.y + (endAbs.y - previous.y) * 2 / 3;

        // If origin has control points, try to preserve them
        if (origin instanceof CurveTo) {
          // Already C, just adjust relative/absolute
          const oEnd = toVal(endAbs.x, endAbs.y);
          const absCP = origin.getAbsoluteControlPoints();
          const cp1 = toVal(absCP[0].x, absCP[0].y);
          const cp2 = toVal(absCP[1].x, absCP[1].y);
          return new CurveTo(relative, [cp1[0], cp1[1], cp2[0], cp2[1], oEnd[0], oEnd[1]]);
        }
        if (origin instanceof QuadraticBezierCurveTo) {
          // Q→C: elevate the quadratic to cubic
          const qcp = origin.getAbsoluteControlPoints();
          const cx1 = previous.x + (qcp[0].x - previous.x) * 2 / 3;
          const cy1 = previous.y + (qcp[0].y - previous.y) * 2 / 3;
          const cx2 = endAbs.x + (qcp[0].x - endAbs.x) * 2 / 3;
          const cy2 = endAbs.y + (qcp[0].y - endAbs.y) * 2 / 3;
          const [vcp1x, vcp1y] = toVal(cx1, cy1);
          const [vcp2x, vcp2y] = toVal(cx2, cy2);
          const [vex, vey] = toVal(endAbs.x, endAbs.y);
          return new CurveTo(relative, [vcp1x, vcp1y, vcp2x, vcp2y, vex, vey]);
        }
        if (origin instanceof SmoothCurveTo) {
          const scp = origin.getAbsoluteControlPoints();
          // S has one explicit handle (the second); the first is reflected from previous
          const reflectedCP1 = origin.getReflectedControlPoint(previous);
          const [vcp1x, vcp1y] = toVal(reflectedCP1.x, reflectedCP1.y);
          const [vcp2x, vcp2y] = toVal(scp[0].x, scp[0].y);
          const [vex, vey] = toVal(endAbs.x, endAbs.y);
          return new CurveTo(relative, [vcp1x, vcp1y, vcp2x, vcp2y, vex, vey]);
        }

        // Default: line-like control points
        const [vcp1x, vcp1y] = toVal(cp1x, cp1y);
        const [vcp2x, vcp2y] = toVal(cp2x, cp2y);
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new CurveTo(relative, [vcp1x, vcp1y, vcp2x, vcp2y, vex, vey]);
      }
      case 'S': {
        // Smooth cubic: only second control point + endpoint
        const cp2x = previous.x + (endAbs.x - previous.x) * 2 / 3;
        const cp2y = previous.y + (endAbs.y - previous.y) * 2 / 3;
        const [vcp2x, vcp2y] = toVal(cp2x, cp2y);
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new SmoothCurveTo(relative, [vcp2x, vcp2y, vex, vey]);
      }
      case 'Q': {
        if (origin instanceof CurveTo) {
          // C→Q: average the two cubic handles
          const absCP = origin.getAbsoluteControlPoints();
          const qx = (absCP[0].x + absCP[1].x) / 2;
          const qy = (absCP[0].y + absCP[1].y) / 2;
          const [vcpx, vcpy] = toVal(qx, qy);
          const [vex, vey] = toVal(endAbs.x, endAbs.y);
          return new QuadraticBezierCurveTo(relative, [vcpx, vcpy, vex, vey]);
        }
        // Default: control point at midpoint
        const mx = (previous.x + endAbs.x) / 2;
        const my = (previous.y + endAbs.y) / 2;
        const [vcpx, vcpy] = toVal(mx, my);
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new QuadraticBezierCurveTo(relative, [vcpx, vcpy, vex, vey]);
      }
      case 'T': {
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new SmoothQuadraticBezierCurveTo(relative, [vex, vey]);
      }
      case 'A': {
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        const dx = endAbs.x - previous.x;
        const dy = endAbs.y - previous.y;
        const r = Math.sqrt(dx * dx + dy * dy) / 2;
        return new EllipticalArcTo(relative, [r, r, 0, 0, 1, vex, vey]);
      }
      case 'M': {
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new MoveTo(relative, [vex, vey]);
      }
      default: {
        const [vex, vey] = toVal(endAbs.x, endAbs.y);
        return new LineTo(relative, [vex, vey]);
      }
    }
  }

  /** Get the command type letter (uppercase unless uppercase===false). */
  getType(uppercase = true): string {
    const upper = this._typeChar();
    if (uppercase) return upper;
    return this.relative ? upper.toLowerCase() : upper;
  }

  /** Serialize to path fragment, e.g. "L 100 200" */
  asString(decimals?: number): string {
    const letter = this.relative ? this._typeChar().toLowerCase() : this._typeChar();
    const vals = this.values.map(v => roundValue(v, decimals));
    if (vals.length === 0) return letter;
    return `${letter} ${vals.join(' ')}`;
  }

  /** Recompute absolute positions from origin and previous point. */
  refresh(origin: Point, previous: Point): void {
    this.previousPoint = { ...previous };
    this._computeAbsolutePositions(origin);
  }

  /** Set the target (endpoint) location in absolute coords. */
  setTargetLocation(pt: Point): void {
    trace.fn('SvgItem.setTargetLocation', { type: this.getType(), pt });
    this._setTargetLocation(pt);
  }

  /** Set a control handle location in absolute coords. */
  setControlLocation(subIndex: number, pt: Point): void {
    trace.fn('SvgItem.setControlLocation', { type: this.getType(), subIndex, pt });
    this._setControlLocation(subIndex, pt);
  }

  /** Get the absolute endpoint of this command. */
  abstract getEndPoint(): Point;

  /** Get the uppercase type character for this command. */
  protected abstract _typeChar(): string;

  /** Compute absolute points and control points. */
  protected abstract _computeAbsolutePositions(origin: Point): void;

  /** Implementation of setTargetLocation. */
  protected abstract _setTargetLocation(pt: Point): void;

  /** Implementation of setControlLocation. */
  protected _setControlLocation(_subIndex: number, _pt: Point): void {
    // Override in subclasses that have control points
  }

  /** Get absolute control points for type conversion. */
  getAbsoluteControlPoints(): Point[] {
    return this.absoluteControlPoints.map(cp => ({ x: cp.x, y: cp.y }));
  }

  /** Get reflected control point (for S commands). Override in subclasses. */
  getReflectedControlPoint(_previous: Point): Point {
    return this.getEndPoint();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundValue(v: number, decimals?: number): string {
  if (decimals === undefined) return String(v);
  return v.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

// ─── Shared command bases ───────────────────────────────────────────────────
// Internal dedup helpers — the concrete command classes below keep their own
// type letter; these bases hold the method bodies that were previously
// duplicated verbatim across subclasses.

/** Base for commands whose values are a bare [x, y] endpoint with no control
 *  points (M, L, T). */
abstract class XYCommand extends SvgItem {
  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x + this.values[0], y: this.previousPoint.y + this.values[1] };
    }
    return { x: this.values[0], y: this.values[1] };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];
    this.absoluteControlPoints = [];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[0] = pt.x - this.previousPoint.x;
      this.values[1] = pt.y - this.previousPoint.y;
    } else {
      this.values[0] = pt.x;
      this.values[1] = pt.y;
    }
  }
}

/** Base for curves with ONE explicit control point at values[0..1] and the
 *  endpoint at values[2..3] (S, Q). */
abstract class SingleControlCurve extends SvgItem {
  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x + this.values[2], y: this.previousPoint.y + this.values[3] };
    }
    return { x: this.values[2], y: this.values[3] };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    const dx = this.relative ? this.previousPoint.x : 0;
    const dy = this.relative ? this.previousPoint.y : 0;

    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];

    const cp2 = new SvgControlPoint(this.values[0] + dx, this.values[1] + dy, 0, 0);
    this.absoluteControlPoints = [cp2];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[2] = pt.x - this.previousPoint.x;
      this.values[3] = pt.y - this.previousPoint.y;
    } else {
      this.values[2] = pt.x;
      this.values[3] = pt.y;
    }
  }

  protected _setControlLocation(subIndex: number, pt: Point): void {
    if (subIndex === 0) {
      const dx = this.relative ? this.previousPoint.x : 0;
      const dy = this.relative ? this.previousPoint.y : 0;
      this.values[0] = pt.x - dx;
      this.values[1] = pt.y - dy;
    }
  }

  override getReflectedControlPoint(_previous: Point): Point {
    const end = this.getEndPoint();
    const dx = this.relative ? this.previousPoint.x : 0;
    const dy = this.relative ? this.previousPoint.y : 0;
    const cp2x = this.values[0] + dx;
    const cp2y = this.values[1] + dy;
    return { x: 2 * end.x - cp2x, y: 2 * end.y - cp2y };
  }
}

// ─── MoveTo ──────────────────────────────────────────────────────────────────

export class MoveTo extends XYCommand {
  protected _typeChar() { return 'M'; }
}

// ─── LineTo ──────────────────────────────────────────────────────────────────

export class LineTo extends XYCommand {
  protected _typeChar() { return 'L'; }
}

// ─── HorizontalLineTo ────────────────────────────────────────────────────────

export class HorizontalLineTo extends SvgItem {
  protected _typeChar() { return 'H'; }

  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x + this.values[0], y: this.previousPoint.y };
    }
    return { x: this.values[0], y: this.previousPoint.y };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];
    this.absoluteControlPoints = [];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[0] = pt.x - this.previousPoint.x;
    } else {
      this.values[0] = pt.x;
    }
    // H ignores y — only horizontal movement
  }
}

// ─── VerticalLineTo ──────────────────────────────────────────────────────────

export class VerticalLineTo extends SvgItem {
  protected _typeChar() { return 'V'; }

  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x, y: this.previousPoint.y + this.values[0] };
    }
    return { x: this.previousPoint.x, y: this.values[0] };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];
    this.absoluteControlPoints = [];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[0] = pt.y - this.previousPoint.y;
    } else {
      this.values[0] = pt.y;
    }
    // V ignores x — only vertical movement
  }
}

// ─── ClosePath ───────────────────────────────────────────────────────────────

export class ClosePath extends SvgItem {
  constructor(relative: boolean) {
    super(relative, []);
  }

  protected _typeChar() { return 'Z'; }

  /** ClosePath returns to the origin (last M point). We store origin in refresh(). */
  private _origin: Point = { x: 0, y: 0 };

  getEndPoint(): Point {
    return { ...this._origin };
  }

  protected _computeAbsolutePositions(origin: Point): void {
    this._origin = { ...origin };
    this.absolutePoints = [];
    this.absoluteControlPoints = [];
  }

  protected _setTargetLocation(_pt: Point): void {
    // ClosePath has no movable target
  }
}

// ─── CurveTo ─────────────────────────────────────────────────────────────────

export class CurveTo extends SvgItem {
  protected _typeChar() { return 'C'; }

  // values: [x1, y1, x2, y2, x, y]

  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x + this.values[4], y: this.previousPoint.y + this.values[5] };
    }
    return { x: this.values[4], y: this.values[5] };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    const prev = this.previousPoint;
    const dx = this.relative ? prev.x : 0;
    const dy = this.relative ? prev.y : 0;

    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];

    const cp1 = new SvgControlPoint(this.values[0] + dx, this.values[1] + dy, 0, 0);
    const cp2 = new SvgControlPoint(this.values[2] + dx, this.values[3] + dy, 0, 1);
    this.absoluteControlPoints = [cp1, cp2];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[4] = pt.x - this.previousPoint.x;
      this.values[5] = pt.y - this.previousPoint.y;
    } else {
      this.values[4] = pt.x;
      this.values[5] = pt.y;
    }
  }

  protected _setControlLocation(subIndex: number, pt: Point): void {
    const dx = this.relative ? this.previousPoint.x : 0;
    const dy = this.relative ? this.previousPoint.y : 0;
    if (subIndex === 0) {
      this.values[0] = pt.x - dx;
      this.values[1] = pt.y - dy;
    } else {
      this.values[2] = pt.x - dx;
      this.values[3] = pt.y - dy;
    }
  }

  override getReflectedControlPoint(_previous: Point): Point {
    // Reflect cp2 across the endpoint
    const end = this.getEndPoint();
    const dx = this.relative ? this.previousPoint.x : 0;
    const dy = this.relative ? this.previousPoint.y : 0;
    const cp2x = this.values[2] + dx;
    const cp2y = this.values[3] + dy;
    return { x: 2 * end.x - cp2x, y: 2 * end.y - cp2y };
  }
}

// ─── SmoothCurveTo ───────────────────────────────────────────────────────────

export class SmoothCurveTo extends SingleControlCurve {
  protected _typeChar() { return 'S'; }

  // values: [x2, y2, x, y]
}

// ─── QuadraticBezierCurveTo ──────────────────────────────────────────────────

export class QuadraticBezierCurveTo extends SingleControlCurve {
  protected _typeChar() { return 'Q'; }

  // values: [x1, y1, x, y]
}

// ─── SmoothQuadraticBezierCurveTo ────────────────────────────────────────────

export class SmoothQuadraticBezierCurveTo extends XYCommand {
  protected _typeChar() { return 'T'; }

  // values: [x, y]
}

// ─── EllipticalArcTo ─────────────────────────────────────────────────────────

export class EllipticalArcTo extends SvgItem {
  protected _typeChar() { return 'A'; }

  // values: [rx, ry, rotation, largeArcFlag, sweepFlag, x, y]

  getEndPoint(): Point {
    if (this.relative) {
      return { x: this.previousPoint.x + this.values[5], y: this.previousPoint.y + this.values[6] };
    }
    return { x: this.values[5], y: this.values[6] };
  }

  protected _computeAbsolutePositions(_origin: Point): void {
    const end = this.getEndPoint();
    this.absolutePoints = [new SvgPoint(end.x, end.y, 0, true)];
    this.absoluteControlPoints = [];
  }

  protected _setTargetLocation(pt: Point): void {
    if (this.relative) {
      this.values[5] = pt.x - this.previousPoint.x;
      this.values[6] = pt.y - this.previousPoint.y;
    } else {
      this.values[5] = pt.x;
      this.values[6] = pt.y;
    }
  }
}

// ─── SvgPath — Top-level mutable path model ─────────────────────────────────

export class SvgPath {
  path: SvgItem[];

  constructor(d: string) {
    trace.fn('SvgPath.constructor', { d });
    const tokens = parseSvgPath(d);
    this.path = tokens.map(t => SvgItem.Make(t));
    this.refreshAbsolutePositions();
    trace.fn('SvgPath.constructor:result', { itemCount: this.path.length });
  }

  // ─── Serialize ───────────────────────────────────────────────────────

  /** Serialize the entire path to a `d` attribute string. */
  asString(decimals?: number): string {
    return this.path.map(item => item.asString(decimals)).join(' ');
  }

  /** Translate all points by (dx, dy). */
  translate(dx: number, dy: number): void {
    for (const item of this.path) {
      // For absolute commands, shift the coordinate values directly
      if (!item.relative) {
        const type = item.getType(true);
        if (type === 'M' || type === 'L' || type === 'T') {
          item.values[0] += dx; item.values[1] += dy;
        } else if (type === 'H') {
          item.values[0] += dx;
        } else if (type === 'V') {
          item.values[0] += dy;
        } else if (type === 'C') {
          item.values[0] += dx; item.values[1] += dy;
          item.values[2] += dx; item.values[3] += dy;
          item.values[4] += dx; item.values[5] += dy;
        } else if (type === 'S' || type === 'Q') {
          item.values[0] += dx; item.values[1] += dy;
          item.values[2] += dx; item.values[3] += dy;
        } else if (type === 'A') {
          item.values[5] += dx; item.values[6] += dy;
        }
      }
      // Relative commands don't need translation (they're relative offsets)
    }
    this.refreshAbsolutePositions();
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  /** All anchor points across all items. */
  targetLocations(): SvgPoint[] {
    const result: SvgPoint[] = [];
    for (let i = 0; i < this.path.length; i++) {
      for (const pt of this.path[i].absolutePoints) {
        result.push(new SvgPoint(pt.x, pt.y, i, pt.movable));
      }
    }
    return result;
  }

  /** All Bezier control handles across all items. */
  controlLocations(): SvgControlPoint[] {
    const result: SvgControlPoint[] = [];
    for (let i = 0; i < this.path.length; i++) {
      for (const cp of this.path[i].absoluteControlPoints) {
        result.push(new SvgControlPoint(cp.x, cp.y, i, cp.subIndex));
      }
    }
    return result;
  }

  // ─── Mutations ───────────────────────────────────────────────────────

  /** Insert a new point at the midpoint of the segment after `afterIndex`. */
  insert(afterIndex: number): void {
    trace.action('SvgPath.insert', { afterIndex, beforeCount: this.path.length });

    if (afterIndex < 0 || afterIndex >= this.path.length - 1) {
      trace.error('SvgPath.insert', { message: 'invalid afterIndex', afterIndex, pathLength: this.path.length });
      return;
    }

    const current = this.path[afterIndex];
    const next = this.path[afterIndex + 1];

    const startPt = current.getEndPoint();
    const endPt = next.getEndPoint();

    let newItem: SvgItem;

    if (next instanceof CurveTo) {
      // De Casteljau split at t=0.5 for cubic Bezier
      const prev = next.previousPoint;
      const dx = next.relative ? prev.x : 0;
      const dy = next.relative ? prev.y : 0;
      const p0 = startPt;
      const p1 = { x: next.values[0] + dx, y: next.values[1] + dy };
      const p2 = { x: next.values[2] + dx, y: next.values[3] + dy };
      const p3 = endPt;

      // de Casteljau at t=0.5
      const m01 = mid(p0, p1);
      const m12 = mid(p1, p2);
      const m23 = mid(p2, p3);
      const m012 = mid(m01, m12);
      const m123 = mid(m12, m23);
      const m0123 = mid(m012, m123);

      // First half: C from startPt, cp1=m01, cp2=m012, end=m0123
      newItem = new CurveTo(false, [m01.x, m01.y, m012.x, m012.y, m0123.x, m0123.y]);

      // Update the existing next item to be the second half: C cp1=m123, cp2=m23, end=p3
      next.values[0] = next.relative ? m123.x - m0123.x : m123.x;
      next.values[1] = next.relative ? m123.y - m0123.y : m123.y;
      next.values[2] = next.relative ? m23.x - m0123.x : m23.x;
      next.values[3] = next.relative ? m23.y - m0123.y : m23.y;
      if (next.relative) {
        next.values[4] = p3.x - m0123.x;
        next.values[5] = p3.y - m0123.y;
      }
    } else if (next instanceof QuadraticBezierCurveTo) {
      // De Casteljau split for quadratic at t=0.5
      const prev = next.previousPoint;
      const dx = next.relative ? prev.x : 0;
      const dy = next.relative ? prev.y : 0;
      const p0 = startPt;
      const p1 = { x: next.values[0] + dx, y: next.values[1] + dy };
      const p2 = endPt;

      const m01 = mid(p0, p1);
      const m12 = mid(p1, p2);
      const m012 = mid(m01, m12);

      newItem = new QuadraticBezierCurveTo(false, [m01.x, m01.y, m012.x, m012.y]);

      // Update next to second half
      next.values[0] = next.relative ? m12.x - m012.x : m12.x;
      next.values[1] = next.relative ? m12.y - m012.y : m12.y;
      if (next.relative) {
        next.values[2] = p2.x - m012.x;
        next.values[3] = p2.y - m012.y;
      }
    } else {
      // Line-like: insert at midpoint
      const midPt = mid(startPt, endPt);
      newItem = new LineTo(false, [midPt.x, midPt.y]);
    }

    this.path.splice(afterIndex + 1, 0, newItem);
    this.refreshAbsolutePositions();

    trace.action('SvgPath.insert:done', { afterCount: this.path.length });
  }

  /** Delete the item at `index`. Minimum 2 items preserved. */
  delete(index: number): void {
    trace.action('SvgPath.delete', { index, beforeCount: this.path.length });

    if (this.path.length <= 2) {
      trace.error('SvgPath.delete', { message: 'minimum 2 items required' });
      return;
    }
    if (index < 0 || index >= this.path.length) {
      trace.error('SvgPath.delete', { message: 'invalid index', index });
      return;
    }

    // If deleting the first M, promote the next item to an M at the same absolute position
    if (index === 0 && this.path.length > 1) {
      const nextEnd = this.path[1].getEndPoint();
      this.path.splice(0, 2, new MoveTo(false, [nextEnd.x, nextEnd.y]));
    } else {
      this.path.splice(index, 1);
    }

    this.refreshAbsolutePositions();
    trace.action('SvgPath.delete:done', { afterCount: this.path.length });
  }

  /** Change the command type of item at `index`. */
  changeType(index: number, newType: string): void {
    trace.action('SvgPath.changeType', { index, from: this.path[index]?.getType(), to: newType });

    if (index < 0 || index >= this.path.length) {
      trace.error('SvgPath.changeType', { message: 'invalid index', index });
      return;
    }

    const item = this.path[index];
    const previous = index > 0 ? this.path[index - 1].getEndPoint() : { x: 0, y: 0 };
    const newItem = SvgItem.MakeFrom(item, previous, newType);
    this.path[index] = newItem;
    this.refreshAbsolutePositions();

    trace.action('SvgPath.changeType:done', { index, newType: this.path[index].getType() });
  }

  // ─── Point manipulation (for drag) ──────────────────────────────────

  /** Move a point (anchor or control handle) to a new absolute position. */
  setLocation(point: SvgPoint | SvgControlPoint, to: Point): void {
    trace.fn('SvgPath.setLocation', {
      itemIndex: point.itemIndex,
      isControl: point instanceof SvgControlPoint,
      from: { x: point.x, y: point.y },
      to,
    });

    const item = this.path[point.itemIndex];
    if (!item) {
      trace.error('SvgPath.setLocation', { message: 'invalid itemIndex', itemIndex: point.itemIndex });
      return;
    }

    if (point instanceof SvgControlPoint) {
      item.setControlLocation(point.subIndex, to);
    } else {
      // Moving an anchor: compute delta so we can also shift control points
      const dx = to.x - point.x;
      const dy = to.y - point.y;

      item.setTargetLocation(to);

      // For commands with control points, move handles with the anchor
      if (item.absoluteControlPoints.length > 0) {
        for (const cp of item.absoluteControlPoints) {
          item.setControlLocation(cp.subIndex, { x: cp.x + dx, y: cp.y + dy });
        }
      }
    }

    this.refreshAbsolutePositions();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /** Recompute all absolute coords by walking the path in order. */
  refreshAbsolutePositions(): void {
    let origin: Point = { x: 0, y: 0 };
    let previous: Point = { x: 0, y: 0 };

    for (let i = 0; i < this.path.length; i++) {
      const item = this.path[i];
      item.refresh(origin, previous);

      // Update itemIndex on all computed points
      for (const pt of item.absolutePoints) pt.itemIndex = i;
      for (const cp of item.absoluteControlPoints) cp.itemIndex = i;

      const end = item.getEndPoint();
      previous = end;

      // Track origin: the last M command's endpoint
      if (item instanceof MoveTo) {
        origin = end;
      }
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ─── d → native element attribute conversion ─────────────────────────────────

/** Convert a path d string back to native element attributes. */
export function dToElementAttrs(tag: string, d: string): Record<string, string> {
  if (tag === 'path') return { d };
  if (tag === 'line') {
    const pts = new SvgPath(d).targetLocations();
    if (pts.length >= 2) return { x1: String(pts[0].x), y1: String(pts[0].y), x2: String(pts[1].x), y2: String(pts[1].y) };
    return { d };
  }
  if (tag === 'polygon' || tag === 'polyline') {
    const pts = new SvgPath(d).targetLocations();
    return { points: pts.map(p => `${p.x},${p.y}`).join(' ') };
  }
  // rect, circle, ellipse: keep as path d (shape may have been deformed)
  return { d };
}
