import { Track } from "./Track";

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

    let offset = this.#offset / 1000;
    let when: number | undefined;

    if (offset < 0)
    {
      when = (this.context.currentTime - offset) / this.rate;
      offset = 0;
    }

    this.#source.start(when, offset);

    this.#contextTimeAtStart = this.contextTimeMillis;
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
    if (!this.#source)
      return;

    this.#source.onended = null;
    this.#source.stop();
    this.#source = null;

    this.#offset = (this.contextTimeMillis - this.#contextTimeAtStart) * this.rate + this.#timeAtStart;
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
    if (!this.isRunning)
    {
      this.#rate = value;
      return;
    }

    this.stop();
    this.#rate = value;
    if (this.#source)
    {
      this.#source.playbackRate.value = value;
    }
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
