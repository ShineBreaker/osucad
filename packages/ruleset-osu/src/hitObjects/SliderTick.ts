import { HitWindows, safeAssign } from "@osucad/core";
import type { HitSampleInfo, IBeatmapTiming } from "@osucad/core";
import type { OsuHitObjectOptions } from "./OsuHitObject";
import { OsuHitObject } from "./OsuHitObject";
import type { Slider } from "./Slider";

export interface SliderTickOptions extends OsuHitObjectOptions
{
  spanIndex?: number
  spanStartTime?: number
  pathProgress?: number
  slider?: Slider
}

export class SliderTick extends OsuHitObject
{
  spanIndex = 0;

  spanStartTime = 0;

  pathProgress = 0;

  /** 父滑条——tick 采样是其对象级 hitnormal 的 `slidertick` 改名派生 */
  slider?: Slider;

  constructor(options: SliderTickOptions = {})
  {
    const { spanIndex, spanStartTime, pathProgress, slider, ...rest } = options;

    super(rest);

    safeAssign(this, { spanIndex, spanStartTime, pathProgress, slider });
  }

  protected override createSamples(timing: IBeatmapTiming): HitSampleInfo[]
  {
    const tickSample = this.slider?.tickSample;
    return tickSample ? [tickSample] : [];
  }

  protected override createHitWindows()
  {
    return HitWindows.Empty;
  }
}
