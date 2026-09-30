import type { BeatmapDifficultyInfo, HitSoundInfo, IBeatmapTiming } from "@osucad/core";
import { CONTROL_POINT_LENIENCY, HitSampleInfo, HitWindows, safeAssign } from "@osucad/core";
import { Bindable, BindableNumber, Vec2 } from "@osucad/framework";
import type { OsuHitObjectOptions } from "./OsuHitObject";
import { OsuHitObject } from "./OsuHitObject";
import type { PathPoint } from "./PathPoint";
import { SliderPath } from "./SliderPath";
import { SliderHeadCircle } from "./SliderHeadCircle";
import { SliderTailCircle } from "./SliderTailCircle";
import { SliderRepeat } from "./SliderRepeat";
import { SliderEventGenerator, SliderEventType } from "./SliderEventGenerator";
import { SliderTick } from "./SliderTick";

export interface SliderOptions extends OsuHitObjectOptions
{
  repeatCount?: number
  expectedDistance?: number
  controlPoints?: readonly PathPoint[]
  nodeSamples?: readonly HitSoundInfo[]
}

export class Slider extends OsuHitObject
{
  constructor(options: SliderOptions = {})
  {
    const { repeatCount, expectedDistance, controlPoints, nodeSamples, ...rest } = options;
    super(rest);

    safeAssign(this, { repeatCount });
    safeAssign(this, { nodeHitSounds: nodeSamples });

    safeAssign(this.path, { expectedDistance, controlPoints });

    this.positionBindable.bindValueChanged(this.#updateNestedPositions, this);
  }

  readonly #positionScratch = new Vec2();

  #updateNestedPositions()
  {
    for (const nested of this.nestedHitObjects)
    {
      if (nested instanceof SliderHeadCircle)
        nested.position = this.position;
      else if (nested instanceof SliderTailCircle)
        nested.position = this.position;
      else if (nested instanceof SliderRepeat)
      {
        this.path.positionAt(nested.pathProgress, this.#positionScratch);
        this.#positionScratch.addInPlace(this.position);
        nested.position = this.#positionScratch;
      }
      else if (nested instanceof SliderTick)
      {
        this.path.positionAt(nested.pathProgress, this.#positionScratch);
        this.#positionScratch.addInPlace(this.position);
        nested.position = this.#positionScratch;
      }
    }

    if (this.headCircle)
      this.headCircle.position = this.position;
    if (this.tailCircle)
      this.tailCircle.position = this.endPosition;
  }

  headCircle: SliderHeadCircle | null = null;

  tailCircle: SliderTailCircle | null = null;

  readonly repeatCountBindable = new BindableNumber(0)
    .withMinValue(0)
    .withPrecision(1);


  get repeatCount()
  {
    return this.repeatCountBindable.value;
  }

  set repeatCount(value)
  {
    this.repeatCountBindable.value = value;
  }

  spanCount()
  {
    return this.repeatCount + 1;
  }

  readonly sliderVelocityBindable = new BindableNumber(1)
    .withMinValue(0);

  get velocity()
  {
    return this.sliderVelocityBindable.value;
  }

  private set velocity(value: number)
  {
    this.sliderVelocityBindable.value = value;
  }

  spanDuration()
  {
    return this.path.distance / this.velocity;
  }

  public override get duration(): number
  {
    return this.spanDuration() * this.spanCount();
  }

  #tickDistance = 1;

  get tickDistance()
  {
    return this.#tickDistance;
  }

  readonly nodeHitSoundsBindable = new Bindable<readonly HitSoundInfo[]>([]);

  get nodeHitSounds()
  {
    return this.nodeHitSoundsBindable.value;
  }

  set nodeHitSounds(value)
  {
    this.nodeHitSoundsBindable.value = value;
  }

  protected override applyDefaultsToSelf(difficulty: BeatmapDifficultyInfo, timing: IBeatmapTiming)
  {
    super.applyDefaultsToSelf(difficulty, timing);

    // lazer：TimingPointAt(StartTime) 与 DifficultyPointAt(StartTime)——均不带偏移
    const timingPoint = timing.getTimingInfoAt(this.startTime);

    const baseVelocity = Slider.BASE_SCORING_DISTANCE * difficulty.sliderMultiplier / timingPoint.beatLength;

    const sliderVelocity = timing.getSliderVelocityAt(this.startTime);
    const generateTicks = timing.getGenerateTicksAt(this.startTime);

    this.velocity = baseVelocity * sliderVelocity;
    this.#generateTicks = generateTicks;

    const scoringDistance = this.velocity * timingPoint.beatLength;

    this.#tickDistance = scoringDistance / difficulty.sliderTickRate;
  }

  /** 控制点 GenerateTicks——绿线 NaN beatLength 时为 false（lazer DifficultyPoint.GenerateTicks） */
  #generateTicks = true;

  readonly path = new SliderPath();

  spanAt(progress: number)
  {
    return Math.floor(progress * this.spanCount());
  }

  progressAt(progress: number): number
  {
    let p = (progress * this.spanCount()) % 1;
    if (this.spanAt(progress) % 2 === 1)
      p = 1 - p;
    return p;
  }

  curvePositionAt(progress: number, out: Vec2 = new Vec2()): Vec2
  {
    return this.path.positionAt(this.progressAt(progress), out);
  }

  public override get endPosition(): Vec2
  {
    return this.position.add(this.curvePositionAt(1));
  }

  override getStackedEndPosition(out: Vec2): Vec2
  {
    this.curvePositionAt(1, out).addInPlace(this.position);

    out.x += this.stackOffsetScalar;
    out.y += this.stackOffsetScalar;

    return out;
  }

  protected override createNestedHitObjects()
  {
    super.createNestedHitObjects();

    for (const e of SliderEventGenerator.generate(this.startTime, this.spanDuration(), this.velocity, this.tickDistance, this.path.distance, this.spanCount(), this.#generateTicks))
    {
      switch (e.type)
      {
      case SliderEventType.Tick:
        this.addNested(new SliderTick({
          spanIndex: e.spanIndex,
          spanStartTime: e.spanStartTime,
          startTime: e.time,
          position: this.position.add(this.path.positionAt(e.pathProgress)),
          pathProgress: e.pathProgress,
          stackHeight: this.stackHeight,
          slider: this,
        }));
        break;
      case SliderEventType.Head:
        this.addNested(this.headCircle = new SliderHeadCircle({
          startTime: e.time,
          position: this.position,
          stackHeight: this.stackHeight,
          hitSound: this.nodeHitSounds[0] ?? this.hitSound,
        }));
        break;
      case SliderEventType.Tail:
        this.addNested(this.tailCircle = new SliderTailCircle(this, {
          repeatIndex: e.spanIndex,
          startTime: e.time,
          position: this.endPosition,
          stackHeight: this.stackHeight,
          hitSound: this.nodeHitSounds[this.spanCount()] ?? this.hitSound,
        }));
        break;
      case SliderEventType.Repeat:
        this.addNested(new SliderRepeat(this, {
          repeatIndex: e.spanIndex,
          startTime: this.startTime + (e.spanIndex + 1) * this.spanDuration(),
          position: this.position.add(this.path.positionAt(e.pathProgress)),
          stackHeight: this.stackHeight,
          pathProgress: e.pathProgress,
          hitSound: this.nodeHitSounds[e.spanIndex + 1] ?? this.hitSound,
        }));
        break;
      }
    }
  }

  protected override createHitWindows()
  {
    return HitWindows.Empty;
  }

  /** 对象级 hitnormal 改名 `slidertick`——所有 tick 复用（lazer UpdateNestedSamples） */
  tickSample: HitSampleInfo | null = null;

  protected override createSamples(timing: IBeatmapTiming)
  {
    // lazer：滑条对象级采样取 startTime + CONTROL_POINT_LENIENCY + 1 处的控制点，
    // sliderslide/sliderwhistle/slidertick 都由解析后的对象采样改名派生（保留 bank/下标/音量）
    const resolved = this.hitSound.getSamples(this.startTime + CONTROL_POINT_LENIENCY + 1, timing);

    const normalSample = resolved.find(s => s.name === HitSampleInfo.HIT_NORMAL) ?? resolved[0];
    const whistleSample = resolved.find(s => s.name === HitSampleInfo.HIT_WHISTLE);

    this.tickSample = normalSample?.with("slidertick") ?? null;

    const samples: HitSampleInfo[] = [];
    if (normalSample)
      samples.push(normalSample.with("sliderslide"));
    if (whistleSample)
      samples.push(whistleSample.with("sliderwhistle"));

    return samples;
  }
}
