/**
 * PathModel — Wraps svg-pathdata to provide a high-level anchor/handle model.
 *
 * Parses a `d` attribute string into Anchor objects (point + bezier handles + mode),
 * allows mutation (move anchor, move handle, convert type, add/delete point),
 * and serializes back to a `d` string.
 *
 * Handle modes:
 *   straight     — no handles (L command). Sharp corner.
 *   mirrored     — handles are symmetric. Dragging one mirrors the other.
 *   disconnected — handles move independently. Each can be different length/angle.
 */

// @ts-ignore — svg-pathdata types don't resolve via "exports" but work at runtime
import { SVGPathData, encodeSVGPath } from 'svg-pathdata';
import { splitCubic, splitLine } from './SegmentMath';
type SVGCommand = any;
import type { Anchor, Point, HandleMode } from './types';

export class PathModel {
  private commands: SVGCommand[] = [];
  private _anchors: Anchor[] = [];
  private _closed = false;

  /** Per-anchor handle mode. Indexed by anchor index. Survives re-parse. */
  private handleModes: HandleMode[] = [];

  /** DANGLING outgoing handle on the LAST anchor (the reference "end handle"). The
   *  endpoint has no outgoing segment, so this handle can't live in the path
   *  commands — we hold it here and re-apply it to the last anchor after every
   *  _buildAnchors. It makes the endpoint show BOTH handles, curves the pen
   *  preview, and pre-curves the next segment (addPointAtEnd reads it). Cleared
   *  when the endpoint changes (new point added / straightened). Relative offset. */
  private _endHandleOut: Point | null = null;

  constructor(d: string = '') {
    if (d) this.parse(d);
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  parse(d: string): void {
    this._endHandleOut = null; // a freshly parsed path has no dangling end handle
    try {
      // svg-pathdata's `normalizeHVZ` takes three flags: (closeToLine,
      // horizToLine, vertToLine). We DO want H→L and V→L (otherwise
      // axis-aligned segments produce anchors with no usable d.x/d.y in
      // their command, which `_buildAnchors` can't read), but we DO NOT
      // want Z→L: converting `Z` into an explicit `L start_x,start_y`
      // duplicates the path's first anchor at the same coordinates,
      // producing a stacked anchor at the start vertex (Bug: "click on
      // top vertex of a polygon-converted triangle creates a new point
      // behind it"). `_buildAnchors` handles the original CLOSE_PATH
      // command correctly (sets `_closed = true`, no extra anchor) so
      // leaving Z untouched gives the right anchor count out of the box.
      const pathData = new SVGPathData(d).toAbs().normalizeHVZ(false, true, true);
      this.commands = pathData.commands;
    } catch {
      this.commands = [];
    }
    this._buildAnchors();
  }

  private _buildAnchors(): void {
    this._anchors = [];
    this._closed = false;

    for (let i = 0; i < this.commands.length; i++) {
      const cmd = this.commands[i];

      switch (cmd.type) {
        case SVGPathData.MOVE_TO: {
          this._pushAnchor(i, { x: cmd.x, y: cmd.y }, null, null);
          break;
        }

        case SVGPathData.LINE_TO: {
          this._pushAnchor(i, { x: cmd.x, y: cmd.y }, null, null);
          break;
        }

        case SVGPathData.CURVE_TO: {
          // Set outgoing handle on PREVIOUS anchor
          const prevAnchor = this._anchors[this._anchors.length - 1];
          if (prevAnchor) {
            prevAnchor.handleOut = {
              x: cmd.x1 - prevAnchor.point.x,
              y: cmd.y1 - prevAnchor.point.y,
            };
            // If handle was set, upgrade to at least disconnected
            if (prevAnchor.handleMode === 'straight') {
              prevAnchor.handleMode = this._getStoredMode(this._anchors.length - 1, 'disconnected');
            }
          }

          this._pushAnchor(i, { x: cmd.x, y: cmd.y },
            { x: cmd.x2 - cmd.x, y: cmd.y2 - cmd.y }, null);
          break;
        }

        case SVGPathData.QUAD_TO: {
          const prevQ = this._anchors[this._anchors.length - 1];
          if (prevQ) {
            prevQ.handleOut = {
              x: cmd.x1 - prevQ.point.x,
              y: cmd.y1 - prevQ.point.y,
            };
            if (prevQ.handleMode === 'straight') {
              prevQ.handleMode = this._getStoredMode(this._anchors.length - 1, 'disconnected');
            }
          }

          this._pushAnchor(i, { x: cmd.x, y: cmd.y },
            { x: cmd.x1 - cmd.x, y: cmd.y1 - cmd.y }, null);
          break;
        }

        case SVGPathData.CLOSE_PATH: {
          this._closed = true;
          // A closed contour whose LAST explicit anchor sits exactly on the
          // FIRST (M) one — e.g. the 4-bezier ellipse the shape tool emits, whose
          // final curve returns to its start point — carries a REDUNDANT anchor
          // stacked on the start. Left in, a circle shows 5 vertices (two at the
          // top); dragging "the top" grabs one of the stacked pair and tears it
          // off the other (the separated-start bug). Fold the closing curve's
          // incoming handle onto the first anchor and drop the duplicate so the
          // contour has the true vertex count (4 for a circle). The Z still
          // closes it. Skipped when last != first (e.g. a triangle's Z closes a
          // real gap), so non-redundant closed paths keep every anchor.
          const n = this._anchors.length;
          if (n > 1) {
            const first = this._anchors[0];
            const last = this._anchors[n - 1];
            if (Math.abs(last.point.x - first.point.x) < 0.01 && Math.abs(last.point.y - first.point.y) < 0.01) {
              if (last.handleIn) {
                first.handleIn = { x: last.handleIn.x, y: last.handleIn.y };
                if (first.handleMode === 'straight') first.handleMode = 'disconnected';
              }
              this._anchors.pop();
            }
          }
          break;
        }
      }
    }

    // Detect mirrored handles: if handleIn and handleOut are roughly symmetric, mark as mirrored.
    for (const anchor of this._anchors) {
      if (anchor.handleIn && anchor.handleOut && anchor.handleMode !== 'straight') {
        const idx = this._anchors.indexOf(anchor);
        // A REAL stored mode (survives re-parse) only exists when this index is
        // within handleModes. `_getStoredMode(idx, null)` can't be used here: it
        // coerces a null fallback to 'straight', so an UNstored curve anchor came
        // back 'straight' and this whole detection no-opped — a freshly-drawn
        // ellipse showed corner anchors instead of smooth/mirrored ones (the
        // "O circle isn't in mirror mode" bug). Read the stored value directly.
        const storedMode = idx < this.handleModes.length ? this.handleModes[idx] : null;
        if (storedMode) {
          anchor.handleMode = storedMode;
        } else if (this._areHandlesMirrored(anchor.handleIn, anchor.handleOut)) {
          anchor.handleMode = 'mirrored';
        } else {
          anchor.handleMode = 'disconnected';
        }
      }
    }

    // Re-apply the dangling end handle (no command carries it). It only makes
    // sense on the LAST anchor of an OPEN path.
    if (this._endHandleOut && !this._closed && this._anchors.length > 0) {
      const lastA = this._anchors[this._anchors.length - 1];
      lastA.handleOut = { x: this._endHandleOut.x, y: this._endHandleOut.y };
      if (lastA.handleMode === 'straight') lastA.handleMode = 'mirrored';
    }
  }

  private _pushAnchor(cmdIndex: number, point: Point, handleIn: Point | null, handleOut: Point | null): void {
    const anchorIdx = this._anchors.length;
    const hasHandles = handleIn !== null || handleOut !== null;
    const defaultMode: HandleMode = hasHandles ? 'disconnected' : 'straight';

    this._anchors.push({
      index: cmdIndex,
      point,
      handleIn,
      handleOut,
      handleMode: this._getStoredMode(anchorIdx, defaultMode),
    });
  }

  private _getStoredMode(anchorIdx: number, fallback: HandleMode | null): HandleMode {
    if (anchorIdx < this.handleModes.length) return this.handleModes[anchorIdx];
    return fallback ?? 'straight';
  }

  private _areHandlesMirrored(hIn: Point, hOut: Point, tolerance: number = 2): boolean {
    // Mirrored means hOut ≈ -hIn (same distance, opposite direction)
    return Math.abs(hOut.x + hIn.x) < tolerance && Math.abs(hOut.y + hIn.y) < tolerance;
  }

  private _syncHandleModes(): void {
    this.handleModes = this._anchors.map(a => a.handleMode);
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  get anchors(): readonly Anchor[] { return this._anchors; }
  get closed(): boolean { return this._closed; }
  get commandCount(): number { return this.commands.length; }

  // ── Anchor mutation ──────────────────────────────────────────────────────

  /** Move an anchor point by delta. Handles move with it. */
  moveAnchor(anchorIndex: number, dx: number, dy: number): void {
    const anchor = this._anchors[anchorIndex];
    if (!anchor) return;

    const cmd = this.commands[anchor.index] as any;
    if ('x' in cmd && 'y' in cmd) {
      cmd.x += dx;
      cmd.y += dy;
    }

    // Move incoming handle control point (x2,y2 on THIS command if curve)
    if ('x2' in cmd && 'y2' in cmd) {
      cmd.x2 += dx;
      cmd.y2 += dy;
    }

    // Move outgoing handle control point (x1,y1 on the NEXT curve command)
    const nextCurveIdx = this._findNextCurveIndex(anchor.index);
    if (nextCurveIdx !== -1) {
      const nextCmd = this.commands[nextCurveIdx] as any;
      if ('x1' in nextCmd && 'y1' in nextCmd) {
        nextCmd.x1 += dx;
        nextCmd.y1 += dy;
      }
    }

    // Closed-path START anchor: when the closing segment EXPLICITLY returns to
    // the start point (the 4-bezier ellipse the shape tool emits ends `C …M Z`),
    // the `M` AND that closing endpoint are the SAME vertex. The code above only
    // moved the `M`; without also moving the closing endpoint the contour TEARS
    // OPEN — a circle's top splits into two anchors with a stray segment (the
    // reported bug). Move the closing draw command's endpoint + its incoming
    // handle by the same delta so the start vertex moves as one. Gated on
    // coincidence with the PRE-move start, so a triangle/quad whose `Z` closes a
    // real gap (last endpoint != M) is untouched.
    if (this._closed && anchor.index === 0) {
      const closeIdx = this._lastDrawCommandIndex();
      if (closeIdx !== -1 && closeIdx !== anchor.index) {
        const closeCmd = this.commands[closeIdx] as any;
        const startX = cmd.x - dx, startY = cmd.y - dy; // M before this move
        if (Math.abs(closeCmd.x - startX) < 0.01 && Math.abs(closeCmd.y - startY) < 0.01) {
          closeCmd.x += dx;
          closeCmd.y += dy;
          if ('x2' in closeCmd && 'y2' in closeCmd) {
            closeCmd.x2 += dx;
            closeCmd.y2 += dy;
          }
        }
      }
    }

    this._buildAnchors();
  }

  /** Index of the LAST drawing command (curve/quad/line) — the segment that
   *  closes the contour back toward the start. -1 if none. */
  private _lastDrawCommandIndex(): number {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const ty = this.commands[i].type;
      if (ty === SVGPathData.CURVE_TO || ty === SVGPathData.QUAD_TO || ty === SVGPathData.LINE_TO) return i;
    }
    return -1;
  }

  // ── Handle mutation ──────────────────────────────────────────────────────

  /** Move a handle to an absolute position (SVG space). Respects handleMode. */
  setHandleAbsolute(anchorIndex: number, type: 'in' | 'out', pos: Point): void {
    const anchor = this._anchors[anchorIndex];
    if (!anchor) return;
    // The OPEN endpoint's outgoing handle is dangling (no segment), so route it to
    // `_endHandleOut` instead of a command.
    const isEndpoint = !this._closed && anchorIndex === this._anchors.length - 1;

    if (type === 'in') {
      this._setInHandle(anchor, pos);
      // Mirror: set outgoing handle to opposite
      if (anchor.handleMode === 'mirrored') {
        const relIn = { x: pos.x - anchor.point.x, y: pos.y - anchor.point.y };
        if (isEndpoint) {
          this._endHandleOut = { x: -relIn.x, y: -relIn.y };
        } else {
          this._setOutHandle(anchor, { x: anchor.point.x - relIn.x, y: anchor.point.y - relIn.y });
        }
      }
    } else {
      const relOut = { x: pos.x - anchor.point.x, y: pos.y - anchor.point.y };
      if (isEndpoint) {
        this._endHandleOut = relOut;
      } else {
        this._setOutHandle(anchor, pos);
      }
      // Mirror: set incoming handle to opposite
      if (anchor.handleMode === 'mirrored') {
        const mirrorIn = { x: anchor.point.x - relOut.x, y: anchor.point.y - relOut.y };
        this._setInHandle(anchor, mirrorIn);
      }
    }

    this._buildAnchors();
  }

  /** Move a handle by delta (SVG space). Respects handleMode. */
  moveHandle(anchorIndex: number, type: 'in' | 'out', dx: number, dy: number): void {
    const anchor = this._anchors[anchorIndex];
    if (!anchor) return;

    if (type === 'in' && anchor.handleIn) {
      const newPos = {
        x: anchor.point.x + anchor.handleIn.x + dx,
        y: anchor.point.y + anchor.handleIn.y + dy,
      };
      this.setHandleAbsolute(anchorIndex, 'in', newPos);
    } else if (type === 'out' && anchor.handleOut) {
      const newPos = {
        x: anchor.point.x + anchor.handleOut.x + dx,
        y: anchor.point.y + anchor.handleOut.y + dy,
      };
      this.setHandleAbsolute(anchorIndex, 'out', newPos);
    }
  }

  private _setInHandle(anchor: Anchor, absPos: Point): void {
    // Incoming handle is x2,y2 on the anchor's own curve command. EXCEPTION: the
    // START anchor of a CLOSED contour that returns to its start — its `M`
    // command has no handle slot, so its incoming handle lives on the CLOSING
    // curve's x2,y2 (the segment that draws back to the start). Without routing
    // here, mirroring the start vertex could only move the OUTGOING handle —
    // dragging one handle didn't mirror the other (a circle's top wouldn't go
    // smooth). Same place `_buildAnchors` reads that handle from (the parse-merge).
    let cmd = this.commands[anchor.index] as any;
    if (this._closed && anchor.index === 0 && !('x2' in cmd)) {
      const closeIdx = this._lastDrawCommandIndex();
      if (closeIdx !== -1) {
        const closeCmd = this.commands[closeIdx] as any;
        if (Math.abs(closeCmd.x - anchor.point.x) < 0.01 && Math.abs(closeCmd.y - anchor.point.y) < 0.01) {
          cmd = closeCmd;
        }
      }
    }
    if ('x2' in cmd && 'y2' in cmd) {
      cmd.x2 = absPos.x;
      cmd.y2 = absPos.y;
    }
  }

  private _setOutHandle(anchor: Anchor, absPos: Point): void {
    // Outgoing handle is x1,y1 on the NEXT curve command
    const nextIdx = this._findNextCurveIndex(anchor.index);
    if (nextIdx !== -1) {
      const nextCmd = this.commands[nextIdx] as any;
      if ('x1' in nextCmd && 'y1' in nextCmd) {
        nextCmd.x1 = absPos.x;
        nextCmd.y1 = absPos.y;
      }
    }
  }

  // ── Handle mode conversion ───────────────────────────────────────────────

  /** Change the handle mode of an anchor. Adjusts handles accordingly. */
  setHandleMode(anchorIndex: number, mode: HandleMode): void {
    const anchor = this._anchors[anchorIndex];
    if (!anchor) return;

    const oldMode = anchor.handleMode;
    anchor.handleMode = mode;

    // A handle counts as "real" only if it exists AND has non-zero length. After
    // a `straight` toggle the surrounding curves become lines, which can leave a
    // ZERO-length handle ({0,0}) rather than null — truthy, so the old
    // `anchor.handleIn && anchor.handleOut` test wrongly took the "make
    // symmetric" branch (which then no-ops on dist===0), so a second
    // straight→mirrored toggle added NO visible handles. Gate on real length.
    const realIn = !!anchor.handleIn && (anchor.handleIn.x !== 0 || anchor.handleIn.y !== 0);
    const realOut = !!anchor.handleOut && (anchor.handleOut.x !== 0 || anchor.handleOut.y !== 0);

    if (mode === 'straight') {
      // Remove handles: convert surrounding curves to lines
      this._convertToLine(anchor);
      // Straightening the endpoint also drops its dangling end handle.
      if (anchorIndex === this._anchors.length - 1) this._endHandleOut = null;
    } else if (mode === 'mirrored' && realIn && realOut) {
      // Make handles symmetric: mirror outgoing from incoming
      const dist = Math.sqrt(anchor.handleIn!.x ** 2 + anchor.handleIn!.y ** 2);
      const outDist = Math.sqrt(anchor.handleOut!.x ** 2 + anchor.handleOut!.y ** 2);
      const avgDist = (dist + outDist) / 2;

      if (dist > 0) {
        const nx = anchor.handleIn!.x / dist;
        const ny = anchor.handleIn!.y / dist;
        anchor.handleOut = { x: -nx * avgDist, y: -ny * avgDist };
        const absOut = { x: anchor.point.x + anchor.handleOut.x, y: anchor.point.y + anchor.handleOut.y };
        this._setOutHandle(anchor, absOut);
      }
    } else if ((mode === 'mirrored' || mode === 'disconnected') && !(realIn && realOut)) {
      // Entering a curve mode without existing handles — add default tangent
      // handles so the user has something visible to drag. Previously this
      // only ran on the explicit `straight → curve-mode` transition, which
      // missed the case where an anchor was already tagged as curve-mode
      // but had no handles (e.g. host calls `convertAllAnchorsToMode` after
      // parsing a shape whose path commands are all line ops).
      this._addDefaultHandles(anchor, anchorIndex);
    }

    this._syncHandleModes();
    this._buildAnchors();
  }

  private _convertToLine(anchor: Anchor): void {
    const cmd = this.commands[anchor.index] as any;
    if (cmd.type === SVGPathData.CURVE_TO || cmd.type === SVGPathData.QUAD_TO) {
      // Replace curve with line
      this.commands[anchor.index] = {
        type: SVGPathData.LINE_TO,
        relative: false,
        x: cmd.x,
        y: cmd.y,
      } as SVGCommand;
    }

    // Also convert the next command if it's a curve (remove outgoing handle)
    const nextIdx = this._findNextCurveIndex(anchor.index);
    if (nextIdx !== -1) {
      const nextCmd = this.commands[nextIdx] as any;
      if (nextCmd.type === SVGPathData.CURVE_TO) {
        // Keep x2,y2 (incoming handle of next anchor) but set x1,y1 to this anchor's point
        nextCmd.x1 = anchor.point.x;
        nextCmd.y1 = anchor.point.y;
      }
    }
  }

  private _addDefaultHandles(anchor: Anchor, anchorIndex: number): void {
    // Find prev and next anchors to calculate a smooth handle direction.
    // Direction = tangent from prev → next (or toward neighbor if at an end).
    const prev = this._anchors[anchorIndex - 1];
    const next = this._anchors[anchorIndex + 1] ?? (this._closed ? this._anchors[0] : null);

    let dirX = 1, dirY = 0;
    if (prev && next) {
      dirX = next.point.x - prev.point.x;
      dirY = next.point.y - prev.point.y;
    } else if (next) {
      dirX = next.point.x - anchor.point.x;
      dirY = next.point.y - anchor.point.y;
    } else if (prev) {
      dirX = anchor.point.x - prev.point.x;
      dirY = anchor.point.y - prev.point.y;
    }

    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    let nx = dirX / len;
    let ny = dirY / len;

    // Handle length = 30% of distance to nearest neighbor
    const distPrev = prev ? Math.sqrt((anchor.point.x - prev.point.x) ** 2 + (anchor.point.y - prev.point.y) ** 2) : len;
    const distNext = next ? Math.sqrt((next.point.x - anchor.point.x) ** 2 + (next.point.y - anchor.point.y) ** 2) : len;
    let handleLen = Math.min(distPrev, distNext) * 0.3;

    // Open endpoint (last anchor, no next segment): the tangent direction is the
    // last segment, which may be vertical — that puts both handles stacked
    // on top of each other (un-grabbable). Force a SMALL HORIZONTAL curve so the
    // two handles sit on the sides, matching the reference's double-click-the-end gesture.
    const isOpenEndpoint = !this._closed && anchorIndex === this._anchors.length - 1 && !next;
    if (isOpenEndpoint) {
      nx = 1;
      ny = 0;
      handleLen = Math.max(distPrev * 0.3, 28);
    }

    // Incoming handle position (absolute)
    const hInX = anchor.point.x - nx * handleLen;
    const hInY = anchor.point.y - ny * handleLen;
    // Outgoing handle position (absolute)
    const hOutX = anchor.point.x + nx * handleLen;
    const hOutY = anchor.point.y + ny * handleLen;

    // 1. Convert THIS command to a curve (adds incoming handle = x2,y2)
    const cmd = this.commands[anchor.index] as any;
    if (cmd.type === SVGPathData.LINE_TO) {
      const prevAnchor = this._anchors[anchorIndex - 1];
      const fromX = prevAnchor ? prevAnchor.point.x : cmd.x;
      const fromY = prevAnchor ? prevAnchor.point.y : cmd.y;
      // x1,y1 = outgoing handle of PREVIOUS anchor (keep at prev point if prev has no handle)
      this.commands[anchor.index] = {
        type: SVGPathData.CURVE_TO,
        relative: false,
        x1: fromX,
        y1: fromY,
        x2: hInX,
        y2: hInY,
        x: cmd.x,
        y: cmd.y,
      } as SVGCommand;
    }

    // 2. Convert the NEXT command to a curve too (adds outgoing handle = x1,y1)
    // This is what the reference does — both sides become curves so you see both handle lines.
    const nextCmdIdx = anchor.index + 1;
    if (nextCmdIdx < this.commands.length) {
      const nextCmd = this.commands[nextCmdIdx] as any;
      if (nextCmd.type === SVGPathData.LINE_TO) {
        const nextAnchor = this._anchors[anchorIndex + 1];
        const toX = nextCmd.x;
        const toY = nextCmd.y;
        // x1,y1 = outgoing handle of THIS anchor
        // x2,y2 = incoming handle of NEXT anchor (keep at next point if it has no handle)
        this.commands[nextCmdIdx] = {
          type: SVGPathData.CURVE_TO,
          relative: false,
          x1: hOutX,
          y1: hOutY,
          x2: toX,
          y2: toY,
          x: toX,
          y: toY,
        } as SVGCommand;
      } else if (nextCmd.type === SVGPathData.CURVE_TO) {
        // Next is already a curve — just update x1,y1 (outgoing handle of this anchor)
        nextCmd.x1 = hOutX;
        nextCmd.y1 = hOutY;
      }
    }

    // 3. Handle closed path: if this is the LAST anchor before Z, also convert the
    // first command (or the close connection) so the outgoing handle appears.
    if (this._closed && anchorIndex === this._anchors.length - 1) {
      // The close path loops back to the first anchor.
      // Find the first non-MOVE command after M to set its x1,y1
      for (let i = 1; i < this.commands.length; i++) {
        const c = this.commands[i] as any;
        if (c.type === SVGPathData.LINE_TO) {
          this.commands[i] = {
            type: SVGPathData.CURVE_TO,
            relative: false,
            x1: hOutX,
            y1: hOutY,
            x2: c.x,
            y2: c.y,
            x: c.x,
            y: c.y,
          } as SVGCommand;
          break;
        } else if (c.type === SVGPathData.CURVE_TO) {
          c.x1 = hOutX;
          c.y1 = hOutY;
          break;
        }
      }
    }

    // 4. OPEN path's LAST anchor (the endpoint): no next segment to carry the
    // outgoing handle, so store it as the DANGLING end handle so both handles show
    // and the next segment / pen preview pre-curve.
    if (!this._closed && anchorIndex === this._anchors.length - 1 && nextCmdIdx >= this.commands.length) {
      this._endHandleOut = { x: hOutX - anchor.point.x, y: hOutY - anchor.point.y };
    }
  }

  // ── Point operations ─────────────────────────────────────────────────────

  /** Delete an anchor. Reconnects with a line. Returns false if can't delete (< 2 points). */
  deleteAnchor(anchorIndex: number): boolean {
    if (this._anchors.length <= 2) return false;
    const anchor = this._anchors[anchorIndex];
    if (!anchor) return false;

    this.commands.splice(anchor.index, 1);
    this.handleModes.splice(anchorIndex, 1);
    this._buildAnchors();
    return true;
  }

  /** Add a point at the end of the path. */
  addPointAtEnd(point: Point, mode: HandleMode = 'straight'): void {
    // Insert before close command if path is closed
    let insertIdx = this.commands.length;
    if (this._closed) {
      for (let i = this.commands.length - 1; i >= 0; i--) {
        if (this.commands[i].type === SVGPathData.CLOSE_PATH) {
          insertIdx = i;
          break;
        }
      }
    }

    if (this.commands.length === 0) {
      this.commands.push({
        type: SVGPathData.MOVE_TO,
        relative: false,
        x: point.x,
        y: point.y,
      } as SVGCommand);
    } else {
      // CURVE CARRYOVER (the reference): if the previous anchor has an outgoing handle
      // (it was curved), the new segment bends OUT of it — emit a CURVE_TO whose
      // first control point is prev.point + prev.handleOut (cp2 = the new point,
      // a clean corner on the new side). Otherwise a straight LINE_TO. This makes
      // the committed segment match the pen's already-curved preview.
      const prevA = this._anchors[this._anchors.length - 1];
      const po = prevA?.handleOut;
      if (po && (po.x !== 0 || po.y !== 0)) {
        this.commands.splice(insertIdx, 0, {
          type: SVGPathData.CURVE_TO, relative: false,
          x1: prevA.point.x + po.x, y1: prevA.point.y + po.y,
          x2: point.x, y2: point.y,
          x: point.x, y: point.y,
        } as SVGCommand);
      } else {
        this.commands.splice(insertIdx, 0, {
          type: SVGPathData.LINE_TO,
          relative: false,
          x: point.x,
          y: point.y,
        } as SVGCommand);
      }
    }

    // The old endpoint's dangling handle (if any) is now baked into the new
    // segment's cp1; the NEW endpoint has no dangling handle yet.
    this._endHandleOut = null;
    this.handleModes.push(mode);
    this._buildAnchors();
  }

  /** Add a curved point at the end with handle direction from drag. */
  addCurvedPointAtEnd(point: Point, handleOut: Point): void {
    const prevAnchor = this._anchors[this._anchors.length - 1];
    const insertIdx = this._closed
      ? this.commands.findIndex(c => c.type === SVGPathData.CLOSE_PATH)
      : this.commands.length;

    if (insertIdx === -1 || this.commands.length === 0) {
      this.commands.push({
        type: SVGPathData.MOVE_TO,
        relative: false,
        x: point.x,
        y: point.y,
      } as SVGCommand);
      this.handleModes.push('mirrored');
    } else {
      // The outgoing handle of the previous anchor becomes x1,y1
      // The incoming handle of this anchor becomes x2,y2
      const mirrorIn = { x: point.x - handleOut.x, y: point.y - handleOut.y };
      this.commands.splice(insertIdx < 0 ? this.commands.length : insertIdx, 0, {
        type: SVGPathData.CURVE_TO,
        relative: false,
        x1: prevAnchor ? prevAnchor.point.x : point.x,
        y1: prevAnchor ? prevAnchor.point.y : point.y,
        x2: mirrorIn.x,
        y2: mirrorIn.y,
        x: point.x,
        y: point.y,
      } as SVGCommand);
      this.handleModes.push('mirrored');
    }

    this._buildAnchors();
  }

  /** Close the path. */
  closePath(): void {
    if (this._closed) return;
    this.commands.push({
      type: SVGPathData.CLOSE_PATH,
    } as SVGCommand);
    this._closed = true;
  }

  /**
   * Split a segment at parameter t, inserting a new anchor.
   * anchorIndex = the END anchor of the segment (segment goes from anchorIndex-1 → anchorIndex).
   * Returns the new anchor index.
   */
  splitSegment(anchorIndex: number, t: number): number {
    const anchor = this._anchors[anchorIndex];
    const prevAnchor = this._anchors[anchorIndex - 1];
    if (!anchor || !prevAnchor) return -1;

    const cmd = this.commands[anchor.index] as any;

    if (cmd.type === SVGPathData.CURVE_TO) {
      // Split cubic bezier using De Casteljau
      const p0 = prevAnchor.point;
      const p1 = { x: cmd.x1, y: cmd.y1 };
      const p2 = { x: cmd.x2, y: cmd.y2 };
      const p3 = { x: cmd.x, y: cmd.y };

      const { left, right } = splitCubic(p0, p1, p2, p3, t);

      // Replace the original curve with two curves:
      // First curve: p0 → left[1] → left[2] → left[3] (the new midpoint)
      // Second curve: left[3] → right[1] → right[2] → right[3] (=p3)
      this.commands[anchor.index] = {
        type: SVGPathData.CURVE_TO,
        relative: false,
        x1: left[1].x, y1: left[1].y,
        x2: left[2].x, y2: left[2].y,
        x: left[3].x, y: left[3].y,
      } as SVGCommand;

      // Insert second curve after
      this.commands.splice(anchor.index + 1, 0, {
        type: SVGPathData.CURVE_TO,
        relative: false,
        x1: right[1].x, y1: right[1].y,
        x2: right[2].x, y2: right[2].y,
        x: right[3].x, y: right[3].y,
      } as SVGCommand);

      // Insert handle mode for new anchor
      this.handleModes.splice(anchorIndex, 0, 'disconnected');
    } else if (cmd.type === SVGPathData.LINE_TO) {
      // Split line: insert a new LINE_TO at the midpoint
      const mid = splitLine(prevAnchor.point, { x: cmd.x, y: cmd.y }, t);

      this.commands.splice(anchor.index, 0, {
        type: SVGPathData.LINE_TO,
        relative: false,
        x: mid.x, y: mid.y,
      } as SVGCommand);

      this.handleModes.splice(anchorIndex, 0, 'straight');
    } else {
      return -1;
    }

    this._buildAnchors();
    // A break-point added on a segment comes in as a MIRRORED curve (symmetric,
    // centred handles) so it's smooth like the reference, not a sharp single dot. On a
    // curve split this symmetrises the de-Casteljau handles; on a line split it
    // adds default tangent handles. splitSegment's only callers are the editor's
    // user-facing "add point" gestures, which all want this.
    this.setHandleMode(anchorIndex, 'mirrored');
    return anchorIndex; // The new anchor is at this index (original shifted right)
  }

  /**
   * Split the closing (wrap-around) segment of a closed path at parameter t.
   * The closing segment runs from the LAST anchor back to the FIRST anchor
   * via the `Z` command (always a straight line in SVG).
   *
   * Inserts a new LINE_TO anchor at the midpoint, just before the CLOSE_PATH
   * command. Returns the new anchor index (which equals the old anchors.length).
   * Returns -1 if the path isn't closed or can't be split.
   */
  splitClosingSegment(t: number): number {
    if (!this._closed) return -1;
    const lastAnchor = this._anchors[this._anchors.length - 1];
    const firstAnchor = this._anchors[0];
    if (!lastAnchor || !firstAnchor) return -1;

    const closeIdx = this.commands.findIndex(c => c.type === SVGPathData.CLOSE_PATH);
    if (closeIdx < 0) return -1;

    const mid = splitLine(lastAnchor.point, firstAnchor.point, t);
    this.commands.splice(closeIdx, 0, {
      type: SVGPathData.LINE_TO,
      relative: false,
      x: mid.x, y: mid.y,
    } as SVGCommand);

    // The new anchor is appended to the end (before the close).
    this.handleModes.push('straight');

    this._buildAnchors();
    return this._anchors.length - 1;
  }

  // ── Serialization ────────────────────────────────────────────────────────

  serialize(): string {
    if (this.commands.length === 0) return '';
    return encodeSVGPath(this.commands);
  }

  /**
   * Reverse the path direction IN PLACE (open paths only). The start anchor
   * becomes the end, so the pen tool's append-from-end extends from what was the
   * START — the reference's "click the start vertex to keep drawing from the start".
   * Cubic segments swap their two control points; quad/line just flip endpoints.
   * Re-parses from the reversed `d` so commands + anchors stay consistent. No-op
   * for a closed path or fewer than 2 points.
   */
  reverse(): void {
    if (this._closed) return;
    const cmds = this.commands.filter((c: SVGCommand) => c.type !== SVGPathData.CLOSE_PATH);
    if (cmds.length < 2 || cmds[0].type !== SVGPathData.MOVE_TO) return;
    const n = cmds.length;
    const rev: SVGCommand[] = [{
      type: SVGPathData.MOVE_TO, relative: false, x: cmds[n - 1].x, y: cmds[n - 1].y,
    } as SVGCommand];
    for (let i = n - 1; i >= 1; i--) {
      const seg = cmds[i];
      const prev = cmds[i - 1];
      if (seg.type === SVGPathData.CURVE_TO) {
        rev.push({
          type: SVGPathData.CURVE_TO, relative: false,
          x1: seg.x2, y1: seg.y2, x2: seg.x1, y2: seg.y1, // swap controls
          x: prev.x, y: prev.y,
        } as SVGCommand);
      } else if (seg.type === SVGPathData.QUAD_TO) {
        rev.push({
          type: SVGPathData.QUAD_TO, relative: false,
          x1: seg.x1, y1: seg.y1, x: prev.x, y: prev.y,
        } as SVGCommand);
      } else {
        rev.push({ type: SVGPathData.LINE_TO, relative: false, x: prev.x, y: prev.y } as SVGCommand);
      }
    }
    this.parse(encodeSVGPath(rev));
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _findNextCurveIndex(fromCmdIndex: number): number {
    for (let i = fromCmdIndex + 1; i < this.commands.length; i++) {
      const cmd = this.commands[i];
      if (cmd.type === SVGPathData.CURVE_TO || cmd.type === SVGPathData.QUAD_TO) return i;
      if (cmd.type === SVGPathData.MOVE_TO || cmd.type === SVGPathData.CLOSE_PATH) return -1;
    }
    return -1;
  }
}
