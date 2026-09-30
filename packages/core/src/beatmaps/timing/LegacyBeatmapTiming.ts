import type { IBeatmapTiming } from "./IBeatmapTiming";
import type { ITimingInfo } from "./ITimingInfo";
import type { LegacyTimingPoint } from "./LegacyTimingPoint";
import { SampleSet } from "../../audio/SampleSet";

const defaultTimingInfo: ITimingInfo = { beatLength: 60_000 / 180, signature: 4, startTime: 0 };

/** lazer `LegacyBeatmapDecoder.CONTROL_POINT_LENIENCY`：物件取控制点时向后探的量 */
export const CONTROL_POINT_LENIENCY = 5;

export interface ISampleInfo
{
  volume: number,
  sampleSet: SampleSet,
  sampleIndex: number,
}

export class LegacyBeatmapTiming implements IBeatmapTiming
{
  private readonly _timingPoints: LegacyTimingPoint[] = [];

  get timingPoints(): readonly LegacyTimingPoint[]
  {
    return this._timingPoints as readonly LegacyTimingPoint[];
  }

  public add(timingPoint: LegacyTimingPoint)
  {
    this._timingPoints.push(timingPoint);
    // sort 稳定：同一时刻保持文件顺序，分组取点时绿线（后写者）覆盖红线
    this._timingPoints.sort((a, b) => a.startTime - b.startTime);
  }

  public remove(timingPoint: LegacyTimingPoint)
  {
    const index = this._timingPoints.indexOf(timingPoint);
    if (index < 0)
      return false;

    this._timingPoints.splice(index, 1);
    return true;
  }

  /**
   * lazer 的控制点分组语义（`addControlPoint`/`flushPendingPoints`）：
   * 同一 timestamp 上非 timing 类型（sample/difficulty/effect）由**文件里最后写入的行**胜出——
   * 绿线写在红线之后即绿线生效，反之红线生效；timing 属性另由 `getTimingInfoAt` 取首条红线。
   * time 早于所有点时返回 undefined。
   */
  #groupPointAt(time: number): LegacyTimingPoint | undefined
  {
    const points = this._timingPoints;

    let index = -1;
    for (let i = points.length - 1; i >= 0; i--)
    {
      if (points[i].startTime <= time)
      {
        index = i;
        break;
      }
    }

    if (index < 0)
      return undefined;

    // 稳定排序下，同刻最后一行就是组尾
    return points[index];
  }

  /** SamplePointAt：早于所有点时回落到最早一条点的样本配置 */
  public getSampleInfoAt(time: number): ISampleInfo
  {
    const timingPoint = this.#groupPointAt(time) ?? this.#groupPointAt(this._timingPoints[0]?.startTime ?? 0);

    if (!timingPoint)
    {
      return {
        volume: 100,
        sampleSet: SampleSet.Normal,
        sampleIndex: 0,
      };
    }

    return {
      volume: timingPoint.volume,
      // timing 点的 sampleSet 恒为具体 bank（lazer 把 None 归一化成 normal）
      sampleSet: timingPoint.sampleSet === SampleSet.None ? SampleSet.Normal : timingPoint.sampleSet,
      sampleIndex: timingPoint.sampleIndex,
    };
  }

  /** TimingPointAt：只看红线（timingInfo 仅红线有）；早于所有红线回落到最早一条红线 */
  public getTimingInfoAt(time: number): ITimingInfo
  {
    const points = this._timingPoints;

    let index = -1;
    for (let i = points.length - 1; i >= 0; i--)
    {
      if (points[i].timingInfo && points[i].startTime <= time)
      {
        index = i;
        break;
      }
    }

    let timingPoint: LegacyTimingPoint | undefined;
    if (index < 0)
      timingPoint = points.find(p => p.timingInfo !== null);
    else
      timingPoint = points.find(p => p.startTime === points[index].startTime && p.timingInfo !== null);

    if (!timingPoint?.timingInfo)
      return defaultTimingInfo;

    return { ...timingPoint.timingInfo, startTime: timingPoint.startTime };
  }

  /** DifficultyPointAt：早于所有点回落默认值（SV=1） */
  public getSliderVelocityAt(time: number): number
  {
    const velocity = this.#groupPointAt(time)?.sliderVelocity ?? 1;
    return Number.isFinite(velocity) ? velocity : 1;
  }

  public getGenerateTicksAt(time: number): boolean
  {
    return this.#groupPointAt(time)?.generateTicks ?? true;
  }
}
