import type { ReadonlyDependencyContainer } from "@osucad/framework";
import { Action, AudioBufferTrack, Bindable, FramedClock, provideSelf, resolved } from "@osucad/framework";
import { Color } from "pixi.js";
import { PoolableDrawableWithLifetime } from "../../../pooling/PoolableDrawableWithLifetime";
import type { IAnimationTimeReference } from "../../../skinning/IAnimationTimeReference";
import type { HitObject } from "../HitObject";
import { ArmedState } from "./ArmedState";
import type { HitObjectLifetimeEntry } from "./HitObjectLifetimeEntry";
import { SyntheticHitObjectEntry } from "./SyntheticHitObjectEntry";
import { ISkinSource } from "../../../skinning/ISkinSource";
import { IPooledHitObjectProvider } from "../../ui/IPooledHitObjectProvider";
import type { HitSampleInfo } from "../../../audio/HitSampleInfo";
import { JudgementResult } from "../../judgements/JudgementResult";
import type { Judgement } from "../../judgements/Judgement";
import type { HitResult } from "../../scoring/HitResult";
import { SkinnableSound } from "../../../skinning/SkinnableSound";

/** 命中采样预调度窗口（ms）：判定由输入帧驱动、恒晚于命中时刻 1~2 帧
 *  （press 跨帧 + 帧内子树遍历），等判定再播 hitsound 必迟到。窗口必须
 *  覆盖最大判定延迟（掉帧帧长 × 2 以上），100ms 对 60fps 足够富余；
 *  暂停/seek 的撤销由 SampleChannel 登记表兜底，窗口大小不影响正确性 */
const hitSampleScheduleAhead = 100;

/** 判定路径补放的迟到容忍（ms）：仅剩 ≤10ms 的迟到值得补放（听感门限），
 *  更大的负 delta 说明命中时刻落在冻结/跳过区间内——补放只能是错拍爆音，
 *  宁缺勿错拍（判定与视觉照旧） */
const hitSampleLateTolerance = 10;

@provideSelf()
export class DrawableHitObject<out T extends HitObject = HitObject>
  extends PoolableDrawableWithLifetime<HitObjectLifetimeEntry>
  implements IAnimationTimeReference
{
  readonly defaultsApplied = new Action<DrawableHitObject>();

  readonly hitObjectApplied = new Action<DrawableHitObject>();

  get hitObject(): T
  {
    return this.entry?.hitObject as T;
  }

  parentHitObject: DrawableHitObject | null = null;

  readonly accentColor = new Bindable(new Color(0xffffff));

  protected samples!: SkinnableSound;

  #samplesLoaded = false;

  protected getSamples()
  {
    return this.samplesBindable.value;
  }

  readonly animationStartTime = new Bindable(0);

  readonly onNewResult = new Action<[DrawableHitObject, JudgementResult]>();

  readonly onRevertResult = new Action<[DrawableHitObject, JudgementResult]>();

  readonly #state = new Bindable(ArmedState.Idle);

  isInitialized = false;

  get state()
  {
    return this.#state.value;
  }

  set state(value)
  {
    this.updateState(value);
  }

  constructor(initialHitObject?: T)
  {
    super();

    if (initialHitObject)
    {
      this.entry = new SyntheticHitObjectEntry(initialHitObject);
      this.#ensureEntryHasResult();
    }
  }

  @resolved(ISkinSource)
  protected accessor skin!: ISkinSource;

  protected override load(dependencies: ReadonlyDependencyContainer)
  {
    super.load(dependencies);

    super.addInternal(this.samples = new SkinnableSound().adjust(t => t.minimumSampleVolume = 5));
  }

  protected override loadAsyncComplete(): void
  {
    super.loadAsyncComplete();
    this.skinChanged();
  }

  public handleUserInput = true;

  override get propagatePositionalInputSubTree(): boolean
  {
    return this.handleUserInput;
  }

  override get propagateNonPositionalInputSubTree(): boolean
  {
    return this.handleUserInput;
  }

  protected override loadComplete()
  {
    super.loadComplete();

    this.skin.sourceChanged.addListener(this.skinChanged, this);

    this.samplesBindable.bindValueChanged(() =>
    {
      if (this.#samplesLoaded)
        this.loadSamples();
    });

    this.#updateStateFromResult();
  }

  readonly applyCustomUpdateState = new Action<[DrawableHitObject, ArmedState]>();

  readonly startTimeBindable = new Bindable(0);

  readonly samplesBindable = new Bindable<HitSampleInfo[]>([]);

  get hitStateUpdateTime()
  {
    return this.result?.timeAbsolute ?? this.hitObject.endTime;
  }

  get result()
  {
    return this.entry?.result ?? null;
  }

  get isHit()
  {
    return this.result?.isHit ?? false;
  }

  get judged()
  {
    return this.entry?.judged ?? false;
  }

  get allJudged()
  {
    return this.entry?.allJudged ?? false;
  }

  override get requiresChildrenUpdate(): boolean
  {
    return true;
  }

  override get isPresent(): boolean
  {
    return super.isPresent || this.isIdle;
  }

  get isIdle()
  {
    return this.clock !== null && this.clock.currentTime >= this.lifetimeStart;
  }

  @resolved(IPooledHitObjectProvider, true)
  accessor #pooledObjectProvider!: IPooledHitObjectProvider | undefined;

  readonly onNestedDrawableCreated = new Action<DrawableHitObject>();

  #nestedHitObjects: DrawableHitObject[] = [];

  get nestedHitObjects()
  {
    return this.#nestedHitObjects as readonly DrawableHitObject[];
  }

  protected override onApply(entry: HitObjectLifetimeEntry)
  {
    super.onApply(entry);

    if (entry instanceof SyntheticHitObjectEntry)
      this.lifetimeStart = entry.lifetimeStart - this.initialLifetimeOffset;

    this.#ensureEntryHasResult();

    entry.revertResult.addListener(this.#onRevertResult, this);

    for (const h of this.hitObject.nestedHitObjects)
    {
      const pooledDrawableNested = this.#pooledObjectProvider?.getPooledDrawableRepresentation(h, this);

      const drawableNested = pooledDrawableNested ?? this.createNestedHitObject(h);

      if (!drawableNested)
        throw new Error(`createNestedHitObject returned null for ${h.constructor.name}.`);

      if (pooledDrawableNested === null)
        this.onNestedDrawableCreated.emit(drawableNested);

      drawableNested.onNewResult.addListener(this.#onNewResult, this);
      drawableNested.onRevertResult.addListener(this.#onNestedRevertResult, this);
      drawableNested.applyCustomUpdateState.addListener(this.#onApplyCustomUpdateState, this);

      drawableNested.parentHitObject = this;

      this.#nestedHitObjects.push(drawableNested);

      if (drawableNested.entry instanceof SyntheticHitObjectEntry)
        entry.nestedEntries.add(drawableNested.entry);

      this.addNestedHitObject(drawableNested);
    }

    this.startTimeBindable.bindTo(this.hitObject.startTimeBindable);

    this.samplesBindable.bindTo(this.hitObject.samplesBindable);
    this.hitObject.defaultsApplied.addListener(this.#onDefaultsApplied);

    this.onApplied();
    this.hitObjectApplied.emit(this);

    if (this.isLoaded)
    {
      this.#updateStateFromResult();
      this.updateComboColor();
    }
  }

  protected override onFree(entry: HitObjectLifetimeEntry)
  {
    super.onFree(entry);

    this.startTimeBindable.unbindFrom(this.hitObject.startTimeBindable);

    this.samplesBindable.unbindFrom(this.hitObject.samplesBindable);

    this.#samplesLoaded = false;
    // 池化复用：上一命中的预调度代际记录必须清掉，
    // 否则新物件会被误判「已调度」而漏播命中采样
    this.#hitSampleScheduleGeneration = null;
    this.samples?.clearSamples();

    for (const obj of this.#nestedHitObjects)
    {
      obj.applyCustomUpdateState.removeListener(this.#onApplyCustomUpdateState, this);
      obj.onNewResult.removeListener(this.#onNewResult, this);
      obj.onRevertResult.removeListener(this.#onNestedRevertResult, this);
    }
    this.#nestedHitObjects = [];

    for (const nestedEntry of [...entry.nestedEntries])
    {
      if (nestedEntry instanceof SyntheticHitObjectEntry)
        entry.nestedEntries.delete(nestedEntry);
    }
    this.clearNestedHitObjects();
    this.hitObject.defaultsApplied.removeListener(this.#onDefaultsApplied, this);

    entry.revertResult.removeListener(this.#onRevertResult, this);

    this.onFreed();

    this.parentHitObject = null;

    this.#clearExistingStateTransforms();
  }

  protected onApplied()
  {
  }

  protected onFreed()
  {
  }

  protected loadSamples()
  {
    const samples = this.getSamples();

    if (samples.length <= 0)
      return;

    this.samples.samples = [...samples];
  }

  #onNewResult(drawableHitObject: DrawableHitObject, result: JudgementResult)
  {
    this.onNewResult.emit(drawableHitObject, result);
  }

  #onRevertResult()
  {
    this.updateState(ArmedState.Idle);
    this.onRevertResult.emit(this, this.result!);
  }

  #onNestedRevertResult(drawableHitObject: DrawableHitObject, result: JudgementResult)
  {
    this.onRevertResult.emit(drawableHitObject, result);
  }

  #onDefaultsApplied(hitObject: HitObject)
  {
    console.assert(this.entry !== null);
    this.apply(this.entry!);

    this.defaultsApplied.emit(this);
  }

  protected createNestedHitObject(hitObject: HitObject): DrawableHitObject | null
  {
    return null;
  }

  protected addNestedHitObject(hitObject: DrawableHitObject)
  {
  }

  protected clearNestedHitObjects()
  {
  }

  #onApplyCustomUpdateState(drawableHitObject: DrawableHitObject, state: ArmedState)
  {
    this.applyCustomUpdateState.emit(drawableHitObject, state);
  }

  updateState(state: ArmedState, force = false)
  {
    if (state === this.state && !force)
      return;

    this.#state.value = state;

    this.lifetimeEnd = Number.MAX_VALUE;

    this.#clearExistingStateTransforms();

    const initialTransformsTime = this.hitObject!.startTime - this.initialLifetimeOffset;

    this.animationStartTime.value = initialTransformsTime;

    this.absoluteSequence(initialTransformsTime, () => this.updateInitialTransforms());
    this.absoluteSequence(this.hitObject.startTime, () => this.updateStartTimeTransforms());
    this.absoluteSequence(this.hitStateUpdateTime, () => this.updateHitStateTransforms(state));

    if (this.lifetimeEnd === Number.MAX_VALUE)
      this.lifetimeEnd = Math.max(this.latestTransformEndTime, this.hitObject!.endTime);

    this.applyCustomUpdateState.emit(this, state);
    if (!force && state === ArmedState.Hit)
      this.playSamples();
  }

  #clearExistingStateTransforms()
  {
    super.applyTransformsAt(-Number.MAX_VALUE, true);

    super.clearTransformsAfter(-Number.MAX_VALUE, true);
  }

  override clearTransformsAfter()
  {
  }

  override applyTransformsAt()
  {
  }

  override update()
  {
    if (!this.#samplesLoaded)
    {
      this.#samplesLoaded = true;
      this.loadSamples();
    }

    this.#scheduleHitSamplesAhead();

    super.update();
  }

  override updateAfterChildren()
  {
    super.updateAfterChildren();

    this.updateResult(false);
  }

  protected get initialLifetimeOffset()
  {
    return 1000;
  }

  protected updateInitialTransforms()
  {
    this.fadeInFromZero();
  }

  protected updateStartTimeTransforms()
  {
  }

  protected updateHitStateTransforms(state: ArmedState)
  {
  }

  onKilled()
  {
    for (const nested of this.nestedHitObjects)
      nested.onKilled();

    this.updateResult(false);
  }

  protected updateComboColor()
  {
  }

  protected skinChanged()
  {
    this.updateComboColor();
  }

  override dispose(isDisposing?: boolean)
  {
    super.dispose(isDisposing);

    this.skin.sourceChanged.removeListener(this.skinChanged, this);
  }

  /** 已把命中采样调度到未来的轨代际；轨 stop/seek（generation 递增）后
   *  预调度已被撤销、此记录作废，等待重新调度 */
  #hitSampleScheduleGeneration: number | null = null;

  #audioTrack(): AudioBufferTrack | null
  {
    let source: unknown = this.clock;
    while (source instanceof FramedClock)
      source = source.source;

    return source instanceof AudioBufferTrack ? source : null;
  }

  /** 命中采样提前调度（同步性核心）：在到达命中时刻前 hitSampleScheduleAhead
   *  窗口内提前调 playSamples——此时 delta > 0，采样被调度到 AudioContext
   *  的精确命中时刻（Web Audio 未来调度 sub-ms 精度），完全绕开「判定恒晚
   *  1~2 帧」的输入帧延迟。判定/视觉/分数照旧走原路径（playSamples 见
   *  已调度标记跳过，防双播）。本预览为 autoplay（全部命中），提前发声
   *  不依赖判定结果 */
  #scheduleHitSamplesAhead(): void
  {
    const startTime = this.hitObject?.startTime;
    if (startTime === undefined)
      return;

    const track = this.#audioTrack();
    if (!track || !track.isRunning || track.rate <= 0)
      return;

    if (this.#hitSampleScheduleGeneration === track.generation)
      return;

    const delta = startTime - track.currentTime;
    if (delta <= 0 || delta > hitSampleScheduleAhead)
      return;

    this.playSamples();
    this.#hitSampleScheduleGeneration = track.generation;
  }

  protected playSamples()
  {
    const track = this.#audioTrack();

    // 预调度已把采样安排在精确命中时刻：判定路径不再补播（否则双击）。
    // generation 落后 = 轨曾中断（撤销已发生），照常走下方兜底
    if (track && this.#hitSampleScheduleGeneration === track.generation)
      return;

    let when: number | undefined;

    // 时钟源为音频轨时把采样调度到命中时刻对应的 AudioContext 时间；
    // 暂停/无轨/非正常速率回落即时播放
    if (track && track.isRunning && track.rate > 0 && this.hitObject)
    {
      const delta = this.hitObject.startTime - track.currentTime;

      // 命中时刻已落入无帧区间（主线程冻结恢复/seek 大跳的首帧快照）：
      // 补放只能是迟到错拍，宁缺勿错拍
      if (delta < -hitSampleLateTolerance)
        return;

      when = track.context.currentTime + Math.max(0, delta) / track.rate / 1000;
    }

    this.samples?.play(when);
  }

  stopAllSamples()
  {
    if (this.samples?.looping === true)
      this.samples.stop();
  }

  protected applyMaxResult()
  {
    this.applyResult(r => r.type = r.judgement.maxResult);
  }

  protected applyMinResult()
  {
    this.applyResult(r => r.type = r.judgement.minResult);
  }

  protected applyResult(type: HitResult): void;
  protected applyResult(application: (result: JudgementResult) => void): void;
  protected applyResult(application: ((result: JudgementResult) => void) | HitResult)
  {
    if (typeof application !== "function")
    {
      this.applyResult(result => result.type = application);
      return;
    }

    const result = this.result!;

    if (result.hasResult)
      throw new Error("Cannot apply result on a hitobject that already has a result.");

    application(result);

    if (!result.hasResult)
      throw new Error(`${this.constructor.name} applied a JudgementResult but did not update JudgementResult.Type.`);

    result.rawTime = this.time.current;

    if (result.hasResult)
      this.updateState(result.isHit ? ArmedState.Hit : ArmedState.Miss);

    this.onNewResult.emit(this, result);
  }

  protected updateResult(userTriggered: boolean)
  {
    // TODO:
    // if ((Clock as IGameplayClock)?.IsRewinding == true)
    //                 return false;

    if (this.judged)
      return false;

    this.checkForResult(userTriggered, this.time.current - this.hitObject.endTime);

    return this.judged;
  }

  protected checkForResult(userTriggered: boolean, timeOffset: number)
  {
  }

  protected createResult(judgement: Judgement): JudgementResult
  {
    return new JudgementResult(this.hitObject, judgement);
  }

  #ensureEntryHasResult()
  {
    this.entry!.result ??= this.createResult(this.hitObject.judgement);
  }

  #updateStateFromResult()
  {
    if (this.result!.isHit)
      this.updateState(ArmedState.Hit, true);
    else if (this.result!.hasResult)
      this.updateState(ArmedState.Miss, true);
    else
      this.updateState(ArmedState.Idle, true);
  }
}
