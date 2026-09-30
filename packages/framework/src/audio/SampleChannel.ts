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
  }

  readonly #rate: Bindable<number>;

  readonly #source: AudioBufferSourceNode;

  #playing = false;

  #played = false;

  constructor(readonly sample: Sample)
  {
    super(`SampleChannel (${sample.name})`);

    const { buffer, context, looping } = this.sample;

    this.#source = new AudioBufferSourceNode(context, {
      buffer,
      loop: looping,
    });

    this.#source.onended = this.#onEnded.bind(this);

    this.#rate = sample.rate.getBoundCopy();
    this.#rate.bindValueChanged(rate => this.#source.playbackRate.value = rate.value, true);
  }

  public play()
  {
    if (this.isDisposed)
      throw new Error("Cannot not play disposed sample");

    if (this.#played)
      return false;

    this.#source.start();
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

  #onEnded()
  {
    this.#playing = false;

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

    this.#rate.unbindAll();

    super.dispose();
  }
}
