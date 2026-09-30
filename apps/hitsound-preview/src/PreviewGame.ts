import type { Beatmap, ISkin } from "@osucad/core";
import { BeatmapParser, BeatmapSkin, DefaultSkin, GameplayClock, OsucadGameBase, SkinProvidingContainer } from "@osucad/core";
import type { FileSystemEvents, IFile, IFileSystem, ITrack } from "@osucad/framework";
import { AudioBufferTrack, Axes, LoadState, SimpleFileSystem, ZipArchiveFile, ZipArchiveFileSystem } from "@osucad/framework";
import type { ToParent, ToPreview } from "./protocol";
import { postToParent } from "./protocol";
import { Color, EventEmitter } from "pixi.js";
import { defaultSkinFiles } from "./defaults";
import { PreviewClock } from "./PreviewClock";
import { PreviewScreen } from "./PreviewScreen";

interface ParsedBeatmap
{
  beatmap: Beatmap;
  path: string;
  text: string;
}

export class PreviewGame extends OsucadGameBase
{
  readonly clock = new PreviewClock();

  #parsed: ParsedBeatmap[] = [];
  #fs?: IFileSystem;
  #activePath = ""; // 当前难度 .osu 路径（hs:update 后按路径保持所选难度）
  #beatmap?: Beatmap;
  #osuText = "";
  #skinContainer?: SkinProvidingContainer;
  #outerContainer?: SkinProvidingContainer;
  #defaultSkin?: ISkin;
  #track?: AudioBufferTrack;
  #audioFp?: number; // 当前音频文件指纹（byteLength + 采样校验和），替代常驻 #audioData
  #skin?: BeatmapSkin; // 重建才换：指纹不变时复用，避免全量 SkinnableSound 重查样本
  #skinT?: ISkin;
  #skinFp?: number;

  #seq = 0;
  #pending: ToPreview[] = [];

  #lastTimePost = 0;
  #sampleLookups = 0;
  #sampleHits = 0;

  protected override loadComplete()
  {
    super.loadComplete();

    this.post({ type: "cad:ready" });

    for (const message of this.#pending.splice(0))
      void this.#dispatch(message);
  }

  post(message: ToParent)
  {
    postToParent(message);
  }

  onMessage(message: unknown)
  {
    if (this.loadState < LoadState.Ready)
    {
      this.#pending.push(message as ToPreview);
      return;
    }

    void this.#dispatch(message as ToPreview);
  }

  async resumeAudio()
  {
    if (this.audioManager.context.state !== "running")
      await this.audioManager.context.resume().catch(() => {});
  }

  async #dispatch(message: ToPreview)
  {
    try
    {
      switch (message.type)
      {
      case "hs:load":
        await this.#mountPackage(message.bytes, false);
        break;
      case "hs:update":
        await this.#mountPackage(message.bytes, true);
        break;
      case "hs:control":
        await this.#control(message);
        break;
      }
    }
    catch (e)
    {
      this.post({ type: "cad:error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async #control(message: Extract<ToPreview, { type: "hs:control" }>)
  {
    const { action } = message;
    const value = "value" in message ? message.value : undefined;

    switch (action)
    {
    case "play":
      // resumeAudio 不 await：ctx 挂起时 resume() 可能挂住（页面隐藏），但时钟状态
      // 必须先动起来；source.start 在挂起的 ctx 上不推进，恢复后自动续播
      void this.resumeAudio();
      // 播到结尾自然停下后再按播放 = 从头重播（与初次装载相同的提前量）。
      // 位置读 source.currentTime：FramedClock.currentTime 逐帧更新可能滞后于真实轨尾。
      if (!this.clock.isRunning && this.#duration() > 0
        && this.clock.source.currentTime >= this.#duration() - 1)
        this.clock.seek(Math.max(0, this.clock.gameplayStartTime - 1000));
      this.clock.play();
      break;
    case "pause":
      this.clock.pause();
      break;
    case "seek":
      if (value !== undefined)
        this.clock.seek(value);
      break;
    case "volume":
      if (value !== undefined)
      {
        const v = Math.min(1, Math.max(0, value));
        // music = 音轨 mixer，effects = 音效采样 mixer（channel 缺省 = 总音量）
        if (message.channel === "music")
          this.audioManager.trackMixer.volume.value = v;
        else if (message.channel === "effects")
          this.audioManager.sampleMixer.volume.value = v;
        else
          this.audioManager.volume.value = v;
      }
      break;
    case "difficulty":
      if (value !== undefined)
        await this.#selectDifficulty(value);
      break;
    case "stats":
      this.post({ type: "cad:stats", lookups: this.#sampleLookups, hits: this.#sampleHits });
      break;
    }
  }

  override update()
  {
    super.update();

    const now = performance.now();
    if (now - this.#lastTimePost >= 120)
    {
      this.#lastTimePost = now;
      this.post({
        type: "cad:time",
        time: this.clock.currentTime,
        duration: this.#duration(),
        playing: this.clock.isRunning,
      });
    }
  }

  #duration()
  {
    return this.#track?.length ?? this.#beatmap?.hitObjects.at(-1)?.endTime ?? 0;
  }

  async #mountPackage(bytes: ArrayBuffer, preserveState: boolean)
  {
    const fs = await ZipArchiveFileSystem.createMutableLazy(bytes);
    const parsed = await this.#parseAll(fs);
    if (!parsed.length)
      throw new Error("谱面集中没有可解析的 .osu 文件");

    this.#fs = fs;
    this.#parsed = parsed;

    // 尽量沿用正在预览的难度（路径保持），否则取第一个可解析难度
    const chosen = parsed.find(p => p.path === this.#activePath) ?? parsed[0];
    await this.#applyBeatmap(chosen, fs, preserveState);
  }

  async #selectDifficulty(index: number)
  {
    const parsed = this.#parsed[index];
    if (!parsed || parsed.path === this.#activePath || !this.#fs)
      return;

    await this.#applyBeatmap(parsed, this.#fs, false);
  }

  /** 装载一个难度：重建 skin（含 combo 颜色）→ 按 sameBeatmap 决定换屏或复用 → 音轨/时钟 */
  async #applyBeatmap(parsed: ParsedBeatmap, fs: IFileSystem, preserveState: boolean)
  {
    const seq = ++this.#seq;

    const { beatmap, path, text } = parsed;

    // .osu 内容不变 → 复用游玩屏，只换皮肤/音轨（热更新路径，画面不重置）
    const sameBeatmap
      = preserveState
      && this.#skinContainer !== undefined
      && this.#activePath === path
      && this.#osuText === text;

    const audioPath = beatmap.beatmapInfo.audioFile.toLowerCase();
    const audioEntry = fs.get(audioPath);
    const audioFp = audioEntry ? audioFingerprint(await audioEntry.read()) : undefined;
    const audioSame = audioFp !== undefined && audioFp === this.#audioFp;

    let track: AudioBufferTrack | null | undefined;
    if (audioSame)
      track = this.#track ?? null;
    else if (audioEntry)
    {
      try
      {
        const audioData = await audioEntry.read();
        const copy = new ArrayBuffer(audioData.byteLength);
        new Uint8Array(copy).set(new Uint8Array(audioData));
        const buffer = await this.audioManager.context.decodeAudioData(copy);
        track = new AudioBufferTrack(audioPath, this.audioManager.context, buffer);
      }
      catch
      {
        track = null;
      }
    }
    else
      track = null;

    if (seq !== this.#seq)
      return;

    // 皮肤层（BeatmapSkin）：指纹覆盖包内非 .osu/非歌曲文件（path+size），
    // 指纹与同谱面同时不变 → 复用 #skinT，跳过 BeatmapSkin+transformer 重建，
    // 也省去 sourceChanged 引起的全量 SkinnableSound 样本重查。
    // 采样分两层（lazer LegacyBeatmapSkin / LegacySkin 语义）：
    //   谱面文件层（BeatmapSkin，UseCustomSampleBanks=true）：解析下标 ≥1 才查，
    //     下标 ≥2 时只查带后缀名，不回落包内裸名；
    //   默认皮肤层（DefaultSkin，UseCustomSampleBanks=false）：下标 ≥2 剥后缀查裸名。
    // FilteredFileSystem 惰性视图剔除歌曲文件，避免 loadAll 把整首 MP3 解码成采样。
    const skinFp = skinFingerprint(fs, audioPath);

    let skin: BeatmapSkin | undefined;
    let skinT: ISkin;
    if (sameBeatmap && skinFp === this.#skinFp && this.#skin && this.#skinT)
    {
      skinT = this.#skinT;
      // 颜色随谱面文本走，指纹相等时内容一致，重设开销可忽略
      applySkinColors(this.#skin, beatmap);
    }
    else
    {
      skin = new BeatmapSkin(new FilteredFileSystem(fs, audioPath), this);
      applySkinColors(skin, beatmap);
      skinT = (await beatmap.beatmapInfo.ruleset?.createSkinTransformer?.(skin)) ?? skin;
    }

    // 默认皮肤层常驻（文件不变），同样经 ruleset transformer 拿纹理/采样 store
    if (!this.#defaultSkin)
    {
      const skin = new DefaultSkin(await defaultSkinFs(), this);
      await skin.samples.loadAll();
      this.#defaultSkin
        = (await beatmap.beatmapInfo.ruleset?.createSkinTransformer?.(skin)) ?? skin;
    }

    if (!this.#outerContainer)
    {
      this.#outerContainer = new SkinProvidingContainer({
        relativeSizeAxes: Axes.Both,
        skin: this.#defaultSkin,
      });
      this.add(this.#outerContainer);
    }

    if (seq !== this.#seq)
      return;

    if (!sameBeatmap)
    {
      const screen = new PreviewScreen(beatmap, this.clock);
      const container = new SkinProvidingContainer({
        relativeSizeAxes: Axes.Both,
        skin: skinT,
        child: screen,
      });

      // 采样命中统计（验证用）：挂在串链末端，穿透两层后仍 miss 才算未命中
      const skinAny = container as unknown as ISkin & { getSample: ISkin["getSample"] };
      const origGetSample = skinAny.getSample.bind(container);
      let logged = 0;
      skinAny.getSample = (info) =>
      {
        this.#sampleLookups++;
        const sample = origGetSample(info);
        if (sample)
          this.#sampleHits++;
        else if (logged++ < 12)
          console.log("sample miss:", JSON.stringify(info.lookupNames));
        return sample;
      };

      const old = this.#skinContainer;
      this.#outerContainer.add(container);
      if (old)
        this.#outerContainer.remove(old);
      this.#skinContainer = container;
    }
    else
    {
      this.#skinContainer!.skin = skinT;
    }

    this.#beatmap = beatmap;
    this.#activePath = path;
    this.#osuText = text;
    this.#audioFp = audioFp;
    if (skin)
    {
      this.#skin = skin;
      this.#skinT = skinT;
      this.#skinFp = skinFp;
    }

    if (!audioSame)
    {
      if (this.#track)
      {
        this.#track.stop();
        this.audioManager.trackMixer.disconnect(this.#track);
        this.#track.dispose();
      }
      this.#track = track ?? undefined;
      if (this.#track)
        this.audioManager.trackMixer.connect(this.#track);
      this.clock.setSource((this.#track as ITrack | undefined) ?? new GameplayClock());
    }

    if (!sameBeatmap)
    {
      const first = beatmap.hitObjects[0]?.startTime ?? 0;
      this.clock.gameplayStartTime = first;
      this.clock.seek(Math.max(0, first - 1000));
      this.clock.pause();
    }

    this.post({
      type: "cad:loaded",
      meta: {
        title: beatmap.metadata.title,
        artist: beatmap.metadata.artist,
        version: beatmap.metadata.difficultyName,
        creator: beatmap.metadata.creator,
        duration: this.#duration(),
        objects: beatmap.hitObjects.length,
        hasAudio: this.#track !== undefined,
        beatmapFile: path,
        difficulties: this.#parsed.map(p => p.beatmap.metadata.difficultyName || p.path),
        difficultyIndex: this.#parsed.indexOf(parsed),
      },
    });
  }

  /** 已解析难度缓存：path+size 一致直接复用，省掉 TextDecoder+parse 往返 */
  readonly #parsedCache = new Map<string, { beatmap: Beatmap, path: string, text: string, size: number }>();

  /** 解析谱面集内全部 .osu——多难度共用同一 fs/skin，只换游玩屏 */
  async #parseAll(fs: IFileSystem): Promise<ParsedBeatmap[]>
  {
    const candidates = fs.entries()
      .filter(f => f.path.toLowerCase().endsWith(".osu"))
      .sort((a, b) => a.path.localeCompare(b.path));

    const parser = new BeatmapParser();
    const parsed: ParsedBeatmap[] = [];
    const seen = new Set<string>();

    for (const entry of candidates)
    {
      try
      {
        const size = fileSize(entry);
        const cached = size >= 0 ? this.#parsedCache.get(entry.path) : undefined;

        if (cached && cached.size === size)
        {
          parsed.push(cached);
          seen.add(entry.path);
          continue;
        }

        const text = new TextDecoder().decode(await entry.read());
        const beatmap = await parser.parse(text);

        if (beatmap.beatmapInfo.ruleset)
        {
          const item = { beatmap, path: entry.path, text, size };
          parsed.push(item);
          if (size >= 0)
          {
            this.#parsedCache.set(entry.path, item);
            seen.add(entry.path);
          }
        }
      }
      catch
      {
        // 解析失败的 .osu 跳过（其它 mode / 损坏文件），不阻塞可用难度
      }
    }

    for (const key of this.#parsedCache.keys())
      if (!seen.has(key))
        this.#parsedCache.delete(key);

    return parsed;
  }
}

let defaultFsPromise: Promise<SimpleFileSystem> | undefined;

function defaultSkinFs()
{
  return defaultFsPromise ??= (async () =>
  {
    const fs = new SimpleFileSystem();
    for (const [name, data] of await defaultSkinFiles())
      await fs.create(name, data);
    return fs;
  })();
}

/** 音频指纹：byteLength + 首/中/尾各 2KB 的 FNV-1a 采样校验和（替代常驻全量字节+全量比） */
function audioFingerprint(buf: ArrayBuffer): number
{
  let h = (0x811c9dc5 ^ buf.byteLength) >>> 0;
  const bytes = new Uint8Array(buf);

  for (const start of [0, Math.max(0, (buf.byteLength - 2048) >> 1), Math.max(0, buf.byteLength - 2048)])
  {
    const end = Math.min(start + 2048, buf.byteLength);
    for (let i = start; i < end; i++)
      h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  }

  return h;
}

/** 惰性条目的解压前大小（非 zip 来源返回 -1，禁用 size 缓存） */
function fileSize(file: IFile): number
{
  return file instanceof ZipArchiveFile ? file.size : -1;
}

/** 包内非 .osu/非歌曲文件的 path+size 指纹，决定 BeatmapSkin 是否需要重建 */
function skinFingerprint(fs: IFileSystem, audioPath: string): number
{
  let h = 0x811c9dc5 >>> 0;

  for (const entry of fs.entries())
  {
    const path = entry.path.toLowerCase();
    if (path === audioPath || path.endsWith(".osu"))
      continue;

    for (let i = 0; i < path.length; i++)
      h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ fileSize(entry), 0x01000193) >>> 0;
  }

  return h;
}

function applySkinColors(skin: BeatmapSkin, beatmap: Beatmap)
{
  // 谱面 [Colours] 的 combo 颜色优先于皮肤默认（未解析到时 Skin 回落纯白）
  if (beatmap.colors.comboColors.length)
    skin.config.comboColors = [...beatmap.colors.comboColors];
  // 滑条体默认纯黑；谱面 [Colours] 的 SliderTrackOverride/SliderBorder 优先覆盖
  skin.config.set("sliderTrackOverride", beatmap.colors.sliderTrackOverride ?? new Color(0x000000));
  if (beatmap.colors.sliderBorder)
    skin.config.set("sliderBorder", beatmap.colors.sliderBorder);
}

/** 惰性只读视图：向 BeatmapSkin 暴露除歌曲文件外的所有条目（等效原 beatmapFs 剔除） */
class FilteredFileSystem extends EventEmitter<FileSystemEvents> implements IFileSystem
{
  readonly #inner: IFileSystem;
  readonly #excluded: string;

  constructor(inner: IFileSystem, excludedPath: string)
  {
    super();

    this.#inner = inner;
    this.#excluded = excludedPath;
  }

  entries(): IFile[]
  {
    return this.#inner.entries().filter(e => e.path.toLowerCase() !== this.#excluded);
  }

  get(path: string): IFile | undefined
  {
    if (path.trim().toLowerCase() === this.#excluded)
      return undefined;
    return this.#inner.get(path);
  }
}
