import { Action } from "../bindables/Action";
import type { Bindable } from "../bindables/Bindable";
import { AudioComponent } from "./AudioComponent";
import type { IAudioDestination } from "./IAudioDestination";
import type { IAudioSource } from "./IAudioSource";
import type { Sample } from "./Sample";

export class SampleChannel extends AudioComponent implements IAudioSource
{
  readonly onPlay = new Action<SampleChannel>();

  get looping()
  {
    return this.#source.loop;
  }

  set looping(value: boolean)
  {
    this.#source.loop = value;

    if (value)
      this.#bindRate();
  }

  #rate?: Bindable<number>;

  // 一次性采样只占一次播放的速率快照；仅 looping channel 需要跟随
  // sample.rate 的后续变化（对应 lazer 的持续变调），少建一份绑定
  #bindRate()
  {
    if (!this.#rate)
    {
      this.#rate = this.sample.rate.getBoundCopy();
      this.#rate.bindValueChanged(rate => this.#source.playbackRate.value = rate.value, true);
    }
  }

  readonly #source: AudioBufferSourceNode;

  #playing = false;

  #played = false;

  // 调度在未来、尚未发声的 ctx 时刻（秒）；null = 无未来调度。
  // 与 #scheduled 登记表配合，供轨 stop/seek 时统一掐断（见 cancelScheduled）
  #scheduledAt: number | null = null;

  constructor(readonly sample: Sample)
  {
    super(`SampleChannel (${sample.name})`);

    const { buffer, context, looping } = this.sample;

    this.#source = new AudioBufferSourceNode(context, {
      buffer,
      loop: looping,
    });

    this.#source.onended = this.#onEnded.bind(this);

    if (looping)
      this.#bindRate();
  }

  public play(when?: number)
  {
    if (this.isDisposed)
      throw new Error("Cannot not play disposed sample");

    if (this.#played)
      return false;

    if (!this.looping)
      this.#source.playbackRate.value = this.sample.rate.value;

    this.#source.start(when);

    // 一次性采样被调度到未来（命中采样提前调度路径）时登记：
    // 轨 stop/seek 后这些采样相对新位置已错位，放出即幽灵音
    if (!this.looping && when != null && when > this.sample.context.currentTime)
    {
      this.#scheduledAt = when;
      SampleChannel.#scheduledFor(this.sample.context).add(this);
    }

    this.onPlay.emit(this);

    this.#playing = true;
    this.#played = true;

    return true;
  }

  public stop()
  {
    // 未 start 过的 AudioBufferSourceNode 调 stop() 会抛 InvalidStateError
    if (this.#played)
      this.#source.stop();

    this.#playing = false;
    this.#unregister();
  }

  get playing()
  {
    return this.#playing;
  }

  override get isAlive()
  {
    return super.isAlive && this.playing;
  }

  get output(): AudioNode
  {
    return this.#source;
  }

  destination?: IAudioDestination;

  #disposeAfterEnded = false;

  // 未来调度登记表（按 AudioContext 分组）。静态持有 channel 引用，
  // 发声开始（自然 ended）或 stop 时移除，不会长期滞留
  static readonly #scheduled = new Map<BaseAudioContext, Set<SampleChannel>>();

  static #scheduledFor(context: BaseAudioContext): Set<SampleChannel>
  {
    let set = SampleChannel.#scheduled.get(context);
    if (!set)
      SampleChannel.#scheduled.set(context, set = new Set());
    return set;
  }

  #unregister()
  {
    this.#scheduledAt = null;
    SampleChannel.#scheduled.get(this.sample.context)?.delete(this);
  }

  /** 掐断该 ctx 上所有调度在未来、尚未发声的一次性采样。
   *  由 AudioBufferTrack.stop() 调用：轨停止/跳转打破了「轨以当前速率
   *  连续推进」的时序假设，已排定的未来采样不再成立（放出即幽灵音）。
   *  Web Audio 语义下对已 start(when) 未发声的节点 stop() 即在当前
   *  ctx 时刻掐断，不会发声。已开始发声的不受影响。 */
  static cancelScheduled(context: BaseAudioContext): void
  {
    const set = SampleChannel.#scheduled.get(context);
    if (!set)
      return;

    const now = context.currentTime;
    for (const channel of set)
    {
      if (channel.#scheduledAt != null && channel.#scheduledAt > now)
        channel.stop();
    }

    SampleChannel.#scheduled.delete(context);
  }

  #onEnded()
  {
    this.#playing = false;
    this.#unregister();

    if (this.#disposeAfterEnded)
      this.dispose();
  }

  public override dispose()
  {
    // 仍在发声的一次性 channel 延迟到自然播完再回收：
    // 宿主 drawable 死亡/换肤触发的 dispose 不应掐断尾音。
    // loop 永远不会自然结束，必须走正常 dispose 立即停掉。
    if (this.#playing && !this.looping)
    {
      this.#disposeAfterEnded = true;
      return;
    }

    this.stop();

    this.#rate?.unbindAll();

    super.dispose();
  }
}
