import type { IBeatmapTiming, Judgement } from "@osucad/core";
import { HitResult, HitSampleInfo } from "@osucad/core";
import { OsuSpinnerTickJudgement, SpinnerTick } from "./SpinnerTick";
import type { Spinner } from "./Spinner";

export class SpinnerBonusTick extends SpinnerTick
{
  /** 父转盘——spinnerbonus 继承其第一个 addition 采样的 bank/音量（lazer CreateHitSampleInfo） */
  spinner?: Spinner;

  override createJudgement(): Judgement
  {
    return super.createJudgement();
  }

  protected override createSamples(timing: IBeatmapTiming): HitSampleInfo[]
  {
    const samples = this.spinner?.samples ?? [];

    const reference = samples.find(s => s.name !== HitSampleInfo.HIT_NORMAL) ?? samples.find(s => s.name === HitSampleInfo.HIT_NORMAL);
    return [reference?.with("spinnerbonus") ?? new HitSampleInfo("spinnerbonus")];
  }
}

export class OsuSpinnerBonusTickJudgement extends OsuSpinnerTickJudgement
{
  override get maxResult(): HitResult
  {
    return HitResult.LargeBonus;
  }
}
