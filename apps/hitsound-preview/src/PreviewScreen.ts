import type { Beatmap, DrawableRuleset } from "@osucad/core";
import { PlayfieldClock } from "@osucad/core";
import type { ReadonlyDependencyContainer } from "@osucad/framework";
import { Axes, Container, provide } from "@osucad/framework";
import type { PreviewClock } from "./PreviewClock";

/**
 * 预览屏：DrawableRuleset（内含 autoplay 控制器）+ PlayfieldClock。
 * 谱面替换时整个屏被换掉，clock 跨屏保留以维持播放位置。
 */
export class PreviewScreen extends Container
{
  constructor(
    private readonly beatmap: Beatmap,
    clock: PreviewClock,
  )
  {
    super({ relativeSizeAxes: Axes.Both });
    this.clock = clock;
  }

  @provide(PlayfieldClock)
  accessor clock: PreviewClock;

  #ruleset?: DrawableRuleset;

  protected override load(dependencies: ReadonlyDependencyContainer)
  {
    super.load(dependencies);

    void this.#loadRuleset();
  }

  async #loadRuleset()
  {
    const ruleset = await this.beatmap.beatmapInfo.ruleset?.createDrawableRuleset?.();

    if (!ruleset || this.isDisposed)
      return;

    this.addInternal((this.#ruleset = ruleset));

    for (const hitObject of this.beatmap.hitObjects)
      ruleset.addHitObject(hitObject);
  }

  override update()
  {
    super.update();

    this.clock.processFrame();
  }
}
