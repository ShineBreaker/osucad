import { SkinReloadableDrawable } from "./SkinReloadableDrawable";
import { PoolableSkinnableSample } from "./PoolableSkinnableSample";
import { Bindable, Container, LoadState } from "@osucad/framework";
import type { ISampleInfo } from "../audio/ISampleInfo";

export class SkinnableSound extends SkinReloadableDrawable
{
  public minimumSampleVolume = 0;

  override get removeWhenNotAlive(): boolean
  {
    return false;
  }

  override get removeCompletedTransforms(): boolean
  {
    return false;
  }

  override set removeCompletedTransforms(value: boolean)
  {
    // noop
  }

  protected get playWhenZeroVolume()
  {
    return this.looping;
  }

  get drawableSamples()
  {
    return this.#samplesContainer.children.map(it => it.sample).filter(it => it !== null);
  }

  readonly #samplesContainer: Container<PoolableSkinnableSample>;

  readonly rate = new Bindable(1);

  public constructor(samples?: ISampleInfo | ISampleInfo[])
  {
    super();

    this.internalChild = this.#samplesContainer = new Container();

    if (samples)
      this.#samples = Array.isArray(samples) ? samples : [samples];
  }

  #samples: readonly ISampleInfo[] = [];

  public get samples(): readonly ISampleInfo[]
  {
    return this.#samples;
  }

  public set samples(value: readonly ISampleInfo[])
  {
    if (this.#samples === value)
      return;

    this.#samples = value;

    if (this.loadState >= LoadState.Ready)
      this.#updateSamples();
  }

  clearSamples()
  {
    this.samples = [];
  }

  #looping: boolean = false;

  get looping(): boolean
  {
    return this.#looping;
  }

  set looping(value: boolean)
  {
    if (this.#looping === value)
      return;

    this.#looping = value;

    for (const s of this.#samplesContainer.children)
      s.looping = value;
  }

  play(when?: number)
  {
    this.flushPendingSkinChanges();

    // 不在 play 前 stop：每次 play 走新 channel，上一个尾音播完为止（对齐 lazer，
    // 快速重复触发同一采样不互相截断）；loop 的停/重启由调用方显式处理
    for (const c  of this.#samplesContainer.children)
    {
      if (this.playWhenZeroVolume || c.volume.value > 0)
        c.play(when);
    }
  }

  protected override loadAsyncComplete()
  {
    if (this.#samplesContainer.children.length > 0)
      this.#updateSamples();

    super.loadAsyncComplete();
  }

  stop()
  {
    for (const c of this.#samplesContainer.children)
      c.stop();
  }

  #updateSamples()
  {
    const wasPlaying = this.isPlaying;

    if (wasPlaying && this.looping)
      this.stop();

    // 按 ISampleInfo.equals 复用已在容器中的实例，采样集不变时零分配、
    // 也不触发换肤重查（原实现每次全量 clear+新建 PoolableSkinnableSample）
    const remaining = [...this.#samplesContainer.children];

    for (const info of this.#samples)
    {
      let sample = remaining.find(s => s.sampleInfo?.equals(info));

      if (sample)
        remaining.splice(remaining.indexOf(sample), 1);
      else
      {
        this.#samplesContainer.add(sample = new PoolableSkinnableSample(info));
        sample.rate.bindTo(this.rate);
      }

      sample.looping = this.looping;
      sample.volume.value = Math.max(info.volume, this.minimumSampleVolume) / 100.0;
    }

    for (const s of remaining)
      this.#samplesContainer.remove(s, !s.isInPool);

    if (wasPlaying && this.looping)
      this.play();
  }

  get isPlaying()
  {
    for (const c of this.#samplesContainer.children)
    {
      if (c.playing)
        return true;
    }

    return false;
  }
}
