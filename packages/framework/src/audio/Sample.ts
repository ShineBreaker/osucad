import { Action } from "../bindables/Action";
import { BindableNumber } from "../bindables/BindableNumber";
import { AudioDestination } from "./AudioDestination";
import type { IAudioDestination } from "./IAudioDestination";
import type { IAudioSource } from "./IAudioSource";
import { SampleChannel } from "./SampleChannel";

export class Sample extends AudioDestination<SampleChannel> implements IAudioSource
{
  readonly onPlay = new Action<Sample>();

  readonly volume = new BindableNumber(1)
    .withMinValue(0)
    .withMaxValue(1);

  readonly balance = new BindableNumber(0)
    .withMinValue(-1)
    .withMaxValue(1);

  readonly rate = new BindableNumber(1);

  public looping = false;

  get output(): AudioNode
  {
    return this.#gain;
  }

  protected get input(): AudioNode
  {
    return this.#pan;
  }

  destination?: IAudioDestination | undefined;

  readonly #gain: GainNode;
  readonly #pan: StereoPannerNode;

  constructor(
    name: string,
    readonly buffer: AudioBuffer,
    readonly context: AudioContext,
  )
  {
    super(name);

    this.#gain = context.createGain();
    this.#pan = context.createStereoPanner();

    this.#pan.connect(this.#gain);

    this.volume.bindValueChanged(volume => this.#gain.gain.value = volume.value);
    this.balance.bindValueChanged(balance => this.#pan.pan.value = balance.value);
  }

  get length()
  {
    return this.buffer.duration * 1000;
  }

  // dispose 后若仍有 channel 在播尾音，继续保持挂接直到全部播完，
  // 再由 destination 的 updateChildren 正常摘除（否则 disconnect 会立刻把尾音静音）
  override get isAlive()
  {
    return super.isAlive || this.items.some(it => it.isAlive);
  }

  override update()
  {
    // 已 dispose 的 Sample 不能走 AudioComponent.update（会抛 disposed 错误），
    // 只需继续修剪已播完的 channel
    if (this.isDisposed)
    {
      this.updateChildren();
      return;
    }

    super.update();
  }

  play(when?: number)
  {
    const channel = this.getChannel();
    channel.play(when);
    return channel;
  }

  public getChannel()
  {
    return this.createChannel();
  }

  protected createChannel()
  {
    const channel = new SampleChannel(this);
    channel.onPlay.addListener(this.#onChannelPlay, this);

    return channel;
  }

  #onChannelPlay(channel: SampleChannel)
  {
    this.connect(channel);
    this.onPlay.emit(this);
  }
}
