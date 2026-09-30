import { SampleSet } from "./SampleSet";
import { SampleAdditions } from "./SampleAdditions";
import { FileHitSampleInfo, HitSampleInfo } from "./HitSampleInfo";
import type { IBeatmapTiming } from "../beatmaps/timing/IBeatmapTiming";

export class HitSoundInfo
{
  constructor(
    /** 0/None = 未指定，回落到控制点 bank */
    readonly sampleSet: SampleSet = SampleSet.None,
    /** 0/None = 跟随 normal bank */
    readonly additionSampleSet: SampleSet = SampleSet.None,
    readonly additions: SampleAdditions = SampleAdditions.None,
    /** hitSample 第 3 列：自定义音效组下标，0 = 继承控制点（下标 ≥2 才进文件名后缀） */
    readonly customIndex: number = 0,
    /** hitSample 第 4 列：0 = 继承控制点音量 */
    readonly volume: number = 0,
    /** hitSample 第 5 列：显式文件名，非空时接管 hitnormal 槽位 */
    readonly filename: string = "",
  )
  {
  }

  getSamples(time: number, timing: IBeatmapTiming): HitSampleInfo[]
  {
    const samples: HitSampleInfo[] = [];

    const sampleInfo = timing.getSampleInfoAt(time);

    const sampleSet = this.sampleSet !== SampleSet.None ? this.sampleSet : sampleInfo.sampleSet;
    const additionSampleSet = this.additionSampleSet !== SampleSet.None ? this.additionSampleSet : sampleSet;

    const index = this.customIndex > 0 ? this.customIndex : sampleInfo.sampleIndex;
    const suffix = index >= 2 ? index.toString() : undefined;
    const volume = this.volume > 0 ? this.volume : sampleInfo.volume;
    // lazer `useBeatmapSamples: customSampleBank >= 1`：下标 0 的采样不查谱面包内文件
    const useBeatmapSamples = index >= 1;

    if (this.filename.length > 0)
      samples.push(new FileHitSampleInfo(this.filename, volume));
    else
      samples.push(new HitSampleInfo(HitSampleInfo.HIT_NORMAL, sampleSetToBank(sampleSet), suffix, volume, true, useBeatmapSamples));

    if (this.additions & SampleAdditions.Whistle)
      samples.push(new HitSampleInfo(HitSampleInfo.HIT_WHISTLE, sampleSetToBank(additionSampleSet), suffix, volume, true, useBeatmapSamples));

    if (this.additions & SampleAdditions.Finish)
      samples.push(new HitSampleInfo(HitSampleInfo.HIT_FINISH, sampleSetToBank(additionSampleSet), suffix, volume, true, useBeatmapSamples));

    if (this.additions & SampleAdditions.Clap)
      samples.push(new HitSampleInfo(HitSampleInfo.HIT_CLAP, sampleSetToBank(additionSampleSet), suffix, volume, true, useBeatmapSamples));

    return samples;
  }
}

export function sampleSetToBank(sampleSet: SampleSet)
{
  switch (sampleSet)
  {
  case SampleSet.Normal:
    return HitSampleInfo.BANK_NORMAL;
  case SampleSet.Soft:
    return HitSampleInfo.BANK_SOFT;
  case SampleSet.Drum:
    return HitSampleInfo.BANK_DRUM;
  default:
    return HitSampleInfo.BANK_NORMAL;
  }
}
