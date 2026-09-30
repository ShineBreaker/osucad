import type { ReadonlyDependencyContainer } from "../../di/DependencyContainer";

import type { Vec2 } from "../../math/Vec2";
import type { Container as PIXIContainer } from "pixi.js";
import { AlphaFilter, Mesh } from "pixi.js";
import { Cached } from "../../caching/Cached";
import { Drawable } from "./Drawable";
import { PathGeometry } from "./PathGeometry";
import { PathGeometryBuilder } from "./PathGeometryBuilder";
import { PathShader } from "./PathShader";

export class Path extends Drawable
{
  protected override load(dependencies: ReadonlyDependencyContainer)
  {
    super.load(dependencies);

    this.#mesh.state.depthTest = true;
  }

  #vertices: readonly Vec2[] = [];

  get vertices()
  {
    return this.#vertices;
  }

  set vertices(value)
  {
    this.#vertices = value;
    this.#segmentsCache.invalidate();
  }

  readonly #geometryBuilder = new PathGeometryBuilder(10, []);
  readonly #segmentsCache = new Cached();

  #generateSegments()
  {
    const builder = this.#geometryBuilder;
    builder.radius = this.pathRadius;
    builder.vertices = this.#vertices;
    builder.build();

    // Subarray views pin the exact active range without copying; Buffer.setDataWithSize
    // uploads only the view range and Geometry.indexSize reads the view's length.
    this.#geometry.positions = builder.positions.subarray(0, builder.positionsLength);
    this.#geometry.texCoords = builder.texCoords.subarray(0, builder.texCoordsLength);
    this.#geometry.indices = builder.indices.subarray(0, builder.indicesLength);

    this.#segmentsCache.validate();
  }

  get texture()
  {
    return this.#pathShader.texture;
  }

  set texture(value)
  {
    if (this.texture === value)
      return;

    this.#pathShader.texture = value;
  }

  #pathRadius = 10;

  get pathRadius()
  {
    return this.#pathRadius;
  }

  set pathRadius(value)
  {
    if (this.#pathRadius === value)
      return;
    this.#pathRadius = value;

    this.#segmentsCache.invalidate();
  }

  readonly #geometry = new PathGeometry();

  readonly #pathShader = new PathShader();

  readonly #alphaFilter = new AlphaFilter();

  readonly #mesh = new Mesh({
    geometry: this.#geometry,
    shader: this.#pathShader,
    blendMode: "none",
    filters: this.#alphaFilter,
  });

  protected override createDrawNode(): PIXIContainer
  {
    return this.#mesh;
  }

  override updateSubTreeTransforms(): boolean
  {
    if (!super.updateSubTreeTransforms())
      return false;

    if (!this.#segmentsCache.isValid)
      this.#generateSegments();

    return true;
  }
}
