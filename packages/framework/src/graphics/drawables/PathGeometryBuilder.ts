import { Vec2 } from "../../math/Vec2";

const max_res = 24;

/**
 * Builds path geometry for consecutive vertex pairs without allocating.
 *
 * Buffers are grow-only: `positions`/`texCoords`/`indices` always expose the full
 * backing store; `positionsLength`/`texCoordsLength`/`indicesLength` hold the
 * number of valid elements written by the last {@link build} call.
 */
export class PathGeometryBuilder
{
  constructor(
    public radius: number,
    public vertices: readonly Vec2[],
  )
  {
  }

  index = 0;

  indices: Uint32Array = new Uint32Array(0);
  positions: Float32Array = new Float32Array(0);
  texCoords: Float32Array = new Float32Array(0);

  positionsLength = 0;
  texCoordsLength = 0;
  indicesLength = 0;

  // Double-buffered: prevSegment* must stay valid while the current iteration
  // rewrites its own slots, so alternating parity is required.
  readonly #linesL: [MutableLine, MutableLine] = [new MutableLine(), new MutableLine()];
  readonly #linesR: [MutableLine, MutableLine] = [new MutableLine(), new MutableLine()];
  readonly #tmpLineA = new MutableLine();
  readonly #tmpLineB = new MutableLine();

  build()
  {
    const { vertices, radius } = this;

    this.positionsLength = 0;
    this.texCoordsLength = 0;
    this.indicesLength = 0;
    this.index = 0;

    const linesL = this.#linesL;
    const linesR = this.#linesR;
    let prevSegmentLeft: MutableLine | undefined;
    let prevSegmentRight: MutableLine | undefined;
    let prevTheta = 0;

    for (let i = 0; i < vertices.length - 1; i++)
    {
      const a = vertices[i];
      const b = vertices[i + 1];
      const segmentLeft = linesL[i & 1];
      const segmentRight = linesR[i & 1];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const theta = Math.atan2(dy, dx);
      const len = Math.sqrt(dx * dx + dy * dy);

      // orthogonalDirection = normalize(dir) rotated -90°; NaN for degenerate segments.
      let ox = -dy / len;
      let oy = dx / len;
      if (Number.isNaN(ox) || Number.isNaN(oy))
      {
        ox = 0;
        oy = 1;
      }

      const oxr = ox * radius;
      const oyr = oy * radius;

      segmentLeft.set(a.x + oxr, a.y + oyr, b.x + oxr, b.y + oyr);
      segmentRight.set(a.x - oxr, a.y - oyr, b.x - oxr, b.y - oyr);

      this.#addSegmentQuads(a.x, a.y, b.x, b.y, segmentLeft, segmentRight);

      if (i > 0)
      {
        const thetaDiff = theta - prevTheta;
        this.#addSegmentCaps(thetaDiff, segmentLeft, segmentRight, prevSegmentLeft!, prevSegmentRight!);
      }

      if (i === 0)
      {
        const flippedLeft = this.#tmpLineA.set(segmentRight.ex, segmentRight.ey, segmentRight.sx, segmentRight.sy);
        const flippedRight = this.#tmpLineB.set(segmentLeft.ex, segmentLeft.ey, segmentLeft.sx, segmentLeft.sy);

        this.#addSegmentCaps(Math.PI, segmentLeft, segmentRight, flippedLeft, flippedRight);
      }

      if (i === vertices.length - 2)
      {
        const flippedLeft = this.#tmpLineA.set(segmentRight.ex, segmentRight.ey, segmentRight.sx, segmentRight.sy);
        const flippedRight = this.#tmpLineB.set(segmentLeft.ex, segmentLeft.ey, segmentLeft.sx, segmentLeft.sy);

        this.#addSegmentCaps(Math.PI, flippedLeft, flippedRight, segmentLeft, segmentRight);
      }

      prevSegmentLeft = segmentLeft;
      prevSegmentRight = segmentRight;
      prevTheta = theta;
    }

    return this;
  }

  #addSegmentQuads(
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    segmentLeft: MutableLine,
    segmentRight: MutableLine,
  )
  {
    this.addTriangle(
        segmentRight.ex,
        segmentRight.ey,
        0,
        segmentRight.sx,
        segmentRight.sy,
        0,
        sx,
        sy,
        1,
    );

    this.addTriangle(
        sx,
        sy,
        1,
        ex,
        ey,
        1,
        segmentRight.ex,
        segmentRight.ey,
        0,
    );

    this.addTriangle(
        sx,
        sy,
        1,
        ex,
        ey,
        1,
        segmentLeft.ex,
        segmentLeft.ey,
        0,
    );

    this.addTriangle(
        segmentLeft.ex,
        segmentLeft.ey,
        0,
        segmentLeft.sx,
        segmentLeft.sy,
        0,
        sx,
        sy,
        1,
    );
  }

  #addSegmentCaps(
    thetaDiff: number,
    segmentLeft: MutableLine,
    segmentRight: MutableLine,
    prevSegmentLeft: MutableLine,
    prevSegmentRight: MutableLine,
  )
  {
    if (Math.abs(thetaDiff) > Math.PI)
      thetaDiff = -Math.sign(thetaDiff) * 2 * Math.PI + thetaDiff;

    if (thetaDiff === 0)
      return;

    const originX = (segmentLeft.sx + segmentRight.sx) * 0.5;
    const originY = (segmentLeft.sy + segmentRight.sy) * 0.5;

    let currentX = thetaDiff > 0 ? prevSegmentRight.ex : prevSegmentLeft.ex;
    let currentY = thetaDiff > 0 ? prevSegmentRight.ey : prevSegmentLeft.ey;
    const endX = thetaDiff > 0 ? segmentRight.sx : segmentLeft.sx;
    const endY = thetaDiff > 0 ? segmentRight.sy : segmentLeft.sy;

    const theta0 = thetaDiff > 0
        ? Math.atan2(prevSegmentRight.ey - prevSegmentLeft.ey, prevSegmentRight.ex - prevSegmentLeft.ex)
        : Math.atan2(prevSegmentLeft.ey - prevSegmentRight.ey, prevSegmentLeft.ex - prevSegmentRight.ex);
    const thetaStep = Math.sign(thetaDiff) * Math.PI / max_res;
    const stepCount = Math.ceil(thetaDiff / thetaStep);

    for (let i = 1; i <= stepCount; i++)
    {
      let nextX: number;
      let nextY: number;
      if (i < stepCount)
      {
        const angle = theta0 + i * thetaStep;
        nextX = originX + Math.cos(angle) * this.radius;
        nextY = originY + Math.sin(angle) * this.radius;
      }
      else
      {
        nextX = endX;
        nextY = endY;
      }

      this.addTriangle(
          originX,
          originY,
          1,

          currentX,
          currentY,
          0,

          nextX,
          nextY,
          0,
      );

      currentX = nextX;
      currentY = nextY;
    }
  }

  addTriangle(
    x1: number,
    y1: number,
    z1: number,

    x2: number,
    y2: number,
    z2: number,

    x3: number,
    y3: number,
    z3: number,
  )
  {
    if (this.positionsLength + 9 > this.positions.length)
      this.positions = grow(this.positions, this.positionsLength + 9);
    this.positions.set([x1, y1, z1, x2, y2, z2, x3, y3, z3], this.positionsLength);
    this.positionsLength += 9;

    if (this.texCoordsLength + 6 > this.texCoords.length)
      this.texCoords = grow(this.texCoords, this.texCoordsLength + 6);
    this.texCoords.set([z1, 0.5, z2, 0.5, z3, 0.5], this.texCoordsLength);
    this.texCoordsLength += 6;

    if (this.indicesLength + 3 > this.indices.length)
      this.indices = grow(this.indices, this.indicesLength + 3);
    this.indices[this.indicesLength++] = this.index;
    this.indices[this.indicesLength++] = this.index + 1;
    this.indices[this.indicesLength++] = this.index + 2;

    this.index += 3;
  }

  addVertex(
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
  )
  {
    if (this.positionsLength + 3 > this.positions.length)
      this.positions = grow(this.positions, this.positionsLength + 3);
    this.positions.set([x, y, z], this.positionsLength);
    this.positionsLength += 3;

    if (this.texCoordsLength + 2 > this.texCoords.length)
      this.texCoords = grow(this.texCoords, this.texCoordsLength + 2);
    this.texCoords.set([u, v], this.texCoordsLength);
    this.texCoordsLength += 2;
  }
}

type GrowableArray = Float32Array | Uint32Array;

function grow<T extends GrowableArray>(array: T, required: number): T
{
  const next = new (array.constructor as new (length: number) => T)(Math.max(array.length * 2, required));
  next.set(array as never);
  return next;
}

class MutableLine
{
  sx = 0;
  sy = 0;
  ex = 0;
  ey = 0;

  set(sx: number, sy: number, ex: number, ey: number): this
  {
    this.sx = sx;
    this.sy = sy;
    this.ex = ex;
    this.ey = ey;
    return this;
  }
}
