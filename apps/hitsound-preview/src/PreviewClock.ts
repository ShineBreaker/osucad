import { GameplayClock } from "@osucad/core";
import type { IAdjustableClock, IClock, ITrack } from "@osucad/framework";
import { Bindable, FramedClock } from "@osucad/framework";

/**
 * 预览时钟：源为音频轨时画面节奏与声音严格同源；
 * 无音频时退回 GameplayClock（performance.now() 驱动）。
 *
 * FramedClock 在 processSource 下会自动 processFrame 帧式源
 * （GameplayClock 是 IFrameBasedClock，Track 不是），两种源共用一条路径。
 */
export class PreviewClock extends FramedClock
{
  constructor()
  {
    super(new GameplayClock());
  }

  get adjustable(): IAdjustableClock
  {
    return this.source as IAdjustableClock;
  }

  /** 换源（换轨 / 有无音轨切换），保留播放位置与播放状态 */
  setSource(source: IClock & IAdjustableClock)
  {
    const time = this.currentTime;
    const wasRunning = this.isRunning;
    const rate = this.rate;

    this.changeSource(source);
    this.adjustable.rate = rate;
    this.seek(time);

    if (wasRunning)
      this.adjustable.start();
    else
      this.isPaused.value = true;
  }

  play()
  {
    this.adjustable.start();
    this.isPaused.value = false;
  }

  pause()
  {
    this.adjustable.stop();
    this.isPaused.value = true;
  }

  seek(position: number)
  {
    const duration = (this.source as Partial<ITrack>).length;

    if (duration !== undefined && Number.isFinite(duration))
      position = Math.min(position, duration);

    this.adjustable.seek(position);
  }

  /** 可寻址时长：音轨长度，无轨时为 undefined */
  get duration(): number | undefined
  {
    const length = (this.source as Partial<ITrack>).length;
    return Number.isFinite(length) ? length : undefined;
  }

  // PlayfieldClock 表面（osu!cad 组件按需读取）
  startTime = 0;
  gameplayStartTime = 0;
  readonly isPaused = new Bindable(true);
  readonly isRewinding = false;
}
