import { ISkinSource, SkinnableDrawable } from "@osucad/core";
import type { ReadonlyDependencyContainer } from "@osucad/framework";
import { Anchor, Axes, CompositeDrawable, computed, resolved, Vec2 } from "@osucad/framework";
import { OsuSkinComponents } from "../../skinning/OsuSkinComponents";
import { OsuHitObject } from "../OsuHitObject";
import { DrawableSlider } from "./DrawableSlider";

export class DrawableSliderBall extends CompositeDrawable
{
  static readonly FOLLOW_AREA = 2.4;

  @resolved(() => DrawableSlider)
  accessor #drawableSlider!: DrawableSlider;

  @resolved(ISkinSource)
  accessor #skin!: ISkinSource;

  private ball!: SkinnableDrawable;

  readonly sliderBallFlip = computed(() => this.#skin.getConfig("sliderBallFlip"));

  protected override load(dependencies: ReadonlyDependencyContainer)
  {
    super.load(dependencies);

    this.size = OsuHitObject.OBJECT_DIMENSIONS;
    this.origin = Anchor.Center;

    this.addAllInternal(
        new SkinnableDrawable(OsuSkinComponents.SliderFollowCircle).with({
          relativeSizeAxes: Axes.Both,
          anchor: Anchor.Center,
          origin: Anchor.Center,
        }),
        this.ball = new SkinnableDrawable(OsuSkinComponents.SliderBall).with({
          relativeSizeAxes: Axes.Both,
          anchor: Anchor.Center,
          origin: Anchor.Center,
        }),
    );
  }

  override clearTransformsAfter(time: number, propagateChildren?: boolean, targetMember?: string)
  {
    super.clearTransformsAfter(time, false, targetMember);
  }

  override applyTransformsAt(time: number)
  {
    super.applyTransformsAt(time, false);
  }

  readonly #positionScratch = new Vec2();
  readonly #aheadScratch = new Vec2();

  updateProgress(completionProgress: number)
  {
    const slider = this.#drawableSlider.hitObject!;
    if (slider.spanCount() > 1 && this.sliderBallFlip.value == false)
      this.ball.scaleX = slider.spanAt(completionProgress) % 2 == 1 ? -1 : 1;

    const position = this.#positionScratch;
    slider.curvePositionAt(completionProgress, position);
    this.position = position;

    const ahead = slider.curvePositionAt(Math.min(1, completionProgress + 0.1 / slider.path.expectedDistance), this.#aheadScratch);
    const dx = position.x - ahead.x;
    const dy = position.y - ahead.y;

    if (dx * dx + dy * dy < 0.05 * 0.05)
      return;

    this.ball.rotation = -Math.atan2(dx, dy) - Math.PI * 0.5;
  }
}
