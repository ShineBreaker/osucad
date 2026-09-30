import { SampleChannel } from "./SampleChannel";
import { Track } from "./Track";

// 轨代际全局单调分配：换轨后新实例的代际不会与旧实例巧合相等——
// 命中采样预调度按「数值相等」判断「同轨同代际」，相等误判会导致
// 池化复用的物件跳过重调度而漏播
let globalTrackGeneration = 0;

export class AudioBufferTrack extends Track
{
  constructor(
    name: string,
    readonly context: AudioContext,
    readonly buffer: AudioBuffer,
  )
  {
    super(name, context);
  }

  get length()
  {
    return this.buffer.duration * 1000;
  }

  #source: AudioBufferSourceNode | null = null;

  override get currentTime(): number
  {
    if (!this.isRunning)
      return this.#offset;

    return this.#timeAtStart + (this.contextTimeMillis - this.#contextTimeAtStart) * this.rate;
  }

  override seek(position: number): boolean
  {
    if (position > this.length)
      return false;

    if (!this.isRunning)
    {
      this.#offset = position;
      return true;
    }

    this.stop();
    this.#offset = position;
    this.start();
    return true;
  }

  #offset = 0;
  #timeAtStart = 0;
  #contextTimeAtStart = 0;

  protected get contextTimeMillis()
  {
    return this.context.currentTime * 1000;
  }

  override start(): void
  {
    if (this.isRunning)
      return;

    this.#source = this.createSource();

    // 基线与 source.start 的调度时刻必须同读一次 ctx 时钟：起播基线读在
    // start 之后会系统性偏晚（ctx.currentTime 按 render quantum 台阶推进，
    // 后读可能已跨步），后续 currentTime/采样 when 的换算全体偏晚
    const ctxNow = this.context.currentTime;

    let offset = this.#offset / 1000;
    let when: number | undefined;

    if (offset < 0)
    {
      when = (ctxNow - offset) / this.rate;
      offset = 0;
    }

    this.#source.start(when, offset);

    this.#contextTimeAtStart = ctxNow * 1000;
    this.#timeAtStart = this.#offset;

    this.#source.onended = () =>
    {
      // stop() 触发的 onended 已被置 null；seek 时旧 source 的 onended 同样先被摘除。
      // 这里只需防「没到轨尾就 ended」的异常路径——比较轨道时间而非 context 时钟
      // （旧实现 contextTimeMillis - offset 混合两个时钟域，seek 后永不成立 → 卡在 running）
      if (this.currentTime < this.length - 10)
        return;
      this.#source = null;
      this.#offset = this.length;
      this.raiseCompleted();
    };
  }

  override stop(): void
  {
    // 轨停止打破「以当前速率连续推进」的时序假设：先把调度在未来、尚未
    // 发声的采样统一掐断（暂停/seek 跳转后放出即幽灵音），再停源
    SampleChannel.cancelScheduled(this.context);
    this.#generation = ++globalTrackGeneration;

    const source = this.#source;
    if (!source)
      return;

    source.onended = null;
    source.stop();
    source.disconnect();
    this.#source = null;

    this.#offset = (this.contextTimeMillis - this.#contextTimeAtStart) * this.rate + this.#timeAtStart;
  }

  #generation = ++globalTrackGeneration;

  /** 轨中断（stop/seek 会使之以 stop+start 重启）单调递增的代际计数。
   *  命中采样提前调度用它识别「预调度作废」：代际落后 = 撤销已发生，
   *  物件重新调度即可，不会因旧调度悬挂而双播或漏播 */
  get generation(): number
  {
    return this.#generation;
  }

  override get isRunning(): boolean
  {
    return this.#source !== null;
  }

  #rate = 1;

  override get rate(): number
  {
    return this.#rate;
  }

  override set rate(value: number)
  {
    this.#rate = value;

    if (!this.isRunning)
      return;

    this.stop();
    this.start();
  }

  protected createSource()
  {
    const source = this.context.createBufferSource();

    source.buffer = this.buffer;

    source.playbackRate.value = this.rate;

    source.connect(this.output);

    return source;
  }

  override dispose(): void
  {
    this.stop();
  }
}
