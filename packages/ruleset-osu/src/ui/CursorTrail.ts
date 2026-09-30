import type { MouseMoveEvent } from "@osucad/framework";
import { Anchor, Axes, clamp, CompositeDrawable, DrawableSprite, FramedClock, InputResampler, Vec2 } from "@osucad/framework";
import type { Texture } from "pixi.js";

export abstract class CursorTrail extends CompositeDrawable
{
  protected constructor()
  {
    super();

    this.clock = new FramedClock();
    this.processCustomClock = true;

    this.relativeSizeAxes = Axes.Both;
  }

  readonly #resampler = new InputResampler();

  #lastPosition: Vec2 | null = null;

  public texture: Texture | null = null;

  public trailOrigin: Anchor = Anchor.Center;

  public globalPartScale = 1;

  public newPartScale = new Vec2(1);


  protected get fadeDuration()
  {
    return 300;
  }

  protected get interpolateMovements()
  {
    return true;
  }

  protected get intervalMultiplier()
  {
    return 1;
  }

  protected get avoidDrawingNearCursor()
  {
    return false;
  }

  protected get fadeExponent()
  {
    return 1.7;
  }

  override onMouseMove(e: MouseMoveEvent): boolean
  {
    this.addTrail(e.screenSpaceMousePosition);
    return false;
  }

  override receivePositionalInputAt(screenSpacePosition: Vec2): boolean
  {
    return true;
  }

  protected addTrail(position: Vec2)
  {
    if (this.texture === null)
      return;

    position = this.toLocalSpace(position);

    if (this.interpolateMovements)
    {
      if (!this.#lastPosition)
      {
        this.#lastPosition = position;
        this.#resampler.addPosition(this.#lastPosition);
        return;
      }

      const interval = this.texture.width / 2.5 * this.intervalMultiplier;

      for (const pos2 of this.#resampler.addPosition(position))
      {
        const pos1 = this.#lastPosition!;

        const dx = pos2.x - pos1.x;
        const dy = pos2.y - pos1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const dirX = dx / distance;
        const dirY = dy / distance;

        const stopAt = distance - (this.avoidDrawingNearCursor ? interval : 0);

        for (let d = interval; d < stopAt; d += interval)
        {
          this.#addPart(pos1.x + dirX * d, pos1.y + dirY * d);

          // #lastPosition tracks the last emitted point; persistent Vec2 mutated in place.
          this.#lastPosition!.x = pos1.x + dirX * d;
          this.#lastPosition!.y = pos1.y + dirY * d;
        }
      }
    }
    else
    {
      this.#lastPosition = position;
      this.#addPart(position.x, position.y);
    }
  }

  readonly #partFreelist: TrailPart[] = [];
  static readonly #maxPooledParts = 128;

  #addPart(x: number, y: number)
  {
    const sprite = this.#partFreelist.pop() ?? new TrailPart({
      texture: this.texture,
      blendMode: "inherit",
    });

    sprite.origin = this.trailOrigin;

    sprite.startTime = this.#time + 1;
    sprite.texture = this.texture;
    sprite.x = x;
    sprite.y = y;
    sprite.alpha = 1;
    sprite.lifetimeStart = -Number.MAX_VALUE;
    sprite.lifetimeEnd = Number.MAX_VALUE;
    sprite.scaleX = this.newPartScale.x * this.globalPartScale;
    sprite.scaleY = this.newPartScale.y * this.globalPartScale;

    if (sprite.parent === null)
      this.addInternal(sprite);
  }

  #time = 0;

  override update()
  {
    super.update();

    const time = this.#time = this.time.current / this.fadeDuration;

    const fadeExponent = this.fadeExponent;

    // Iterate backwards: expired parts are removed from internalChildren in place
    // and recycled into the freelist instead of being destroyed.
    const children = this.internalChildren as TrailPart[];
    for (let i = children.length - 1; i >= 0; i--)
    {
      const c = children[i];

      const alpha = Math.pow(
          clamp(c.startTime - time, 0, 1),
          fadeExponent,
      );

      if (alpha <= 0)
      {
        this.removeInternal(c, false);
        if (this.#partFreelist.length < CursorTrail.#maxPooledParts)
          this.#partFreelist.push(c);
        else
          c.dispose();
        continue;
      }

      c.alpha = alpha;
    }
  }
}

class TrailPart extends DrawableSprite
{
  startTime = 0;
}
