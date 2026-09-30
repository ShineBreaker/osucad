import type { Beatmap, ISkin } from "@osucad/core";
import { BeatmapParser, GameplayClock, OsucadGameBase, Skin, SkinProvidingContainer } from "@osucad/core";
import type { ITrack } from "@osucad/framework";
import { AudioBufferTrack, Axes, LoadState, SimpleFileSystem, ZipArchiveFileSystem } from "@osucad/framework";
import type { ToParent, ToPreview } from "./protocol";
import { postToParent } from "./protocol";
import { Color } from "pixi.js";
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
  #fs?: SimpleFileSystem;
  #activePath = ""; // 当前难度 .osu 路径（hs:update 后按路径保持所选难度）
  #beatmap?: Beatmap;
  #osuText = "";
  #skinContainer?: SkinProvidingContainer;
  #track?: AudioBufferTrack;
  #audioData?: ArrayBuffer;

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
      await this.resumeAudio();
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
    const fs = await ZipArchiveFileSystem.createMutable(bytes);
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
  async #applyBeatmap(parsed: ParsedBeatmap, fs: SimpleFileSystem, preserveState: boolean)
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
    const audioData = (await fs.get(audioPath)?.read()) ?? null;
    const audioSame = this.#audioData !== undefined && audioData !== null
      && bytesEqual(this.#audioData, audioData);

    let track: AudioBufferTrack | null | undefined;
    if (audioSame)
      track = this.#track ?? null;
    else if (audioData)
    {
      try
      {
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

    // Skin 每次重建：换 skin → sourceChanged → 所有 SkinnableSound 重取样本。
    // skinFs 剔除歌曲文件，避免 SkinSampleStore.loadAll 把整首 MP3 也解码；
    // 先铺默认皮肤再覆盖包内文件，保证无皮肤包也能看到物件。
    const skinFs = new IndexedSampleFileSystem();
    for (const [name, data] of await defaultSkinFiles())
      await skinFs.create(name, data);
    for (const entry of fs.entries())
    {
      if (entry.path === audioPath)
        continue;
      await skinFs.create(entry.path, await entry.read());
    }

    const skin = new Skin(skinFs, this);
    // 谱面 [Colours] 的 combo 颜色优先于皮肤默认（未解析到时 Skin 回落纯白）
    if (beatmap.colors.comboColors.length)
      skin.config.comboColors = [...beatmap.colors.comboColors];
    // 滑条体默认纯黑；谱面 [Colours] 的 SliderTrackOverride/SliderBorder 优先覆盖
    skin.config.set("sliderTrackOverride", beatmap.colors.sliderTrackOverride ?? new Color(0x000000));
    if (beatmap.colors.sliderBorder)
      skin.config.set("sliderBorder", beatmap.colors.sliderBorder);

    const skinT: ISkin
      = (await beatmap.beatmapInfo.ruleset?.createSkinTransformer?.(skin)) ?? skin;

    // 采样命中统计（验证用）：命中数 = 在 fs 里找到文件的查询次数
    const skinAny = skinT as ISkin & { getSample: ISkin["getSample"] };
    const origGetSample = skinAny.getSample.bind(skinT);
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

      const old = this.#skinContainer;
      this.add(container);
      if (old)
        this.remove(old);
      this.#skinContainer = container;
    }
    else
    {
      this.#skinContainer.skin = skinT;
    }

    this.#beatmap = beatmap;
    this.#activePath = path;
    this.#osuText = text;
    this.#audioData = audioData ?? undefined;

    if (!audioSame)
    {
      if (this.#track)
      {
        this.#track.stop();
        this.#track.output.disconnect();
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

  /** 解析谱面集内全部 .osu——多难度共用同一 fs/skin，只换游玩屏 */
  async #parseAll(fs: SimpleFileSystem): Promise<ParsedBeatmap[]>
  {
    const candidates = fs.entries()
      .filter(f => f.path.endsWith(".osu"))
      .sort((a, b) => a.path.localeCompare(b.path));

    const parser = new BeatmapParser();
    const parsed: ParsedBeatmap[] = [];

    for (const entry of candidates)
    {
      try
      {
        const text = new TextDecoder().decode(await entry.read());
        const beatmap = await parser.parse(text);

        if (beatmap.beatmapInfo.ruleset)
          parsed.push({ beatmap, path: entry.path, text });
      }
      catch
      {
        // 解析失败的 .osu 跳过（其它 mode / 损坏文件），不阻塞可用难度
      }
    }

    return parsed;
  }
}

// osu! 的 hitsound 查询带自定义样本组下标（timing 点 index）：
// `drum-hitnormal1`/`soft-hitwhistle2`… —— 文件系统里通常只有裸名
// `drum-hitnormal.wav`。下标文件不存在时按 osu! 语义回落到裸名。
class IndexedSampleFileSystem extends SimpleFileSystem
{
  override get(path: string)
  {
    const hit = super.get(path);
    if (hit)
      return hit;

    // 只在「词干尾部是纯数字 + 音频扩展名」时回落（如 hitnormal1.wav → hitnormal.wav）
    const stripped = path.replace(/([^/]*?)\d+(\.(?:wav|mp3|ogg))$/, "$1$2");
    return stripped === path ? undefined : super.get(stripped);
  }
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer)
{
  if (a.byteLength !== b.byteLength)
    return false;

  const u1 = new Uint32Array(a, 0, a.byteLength >> 2);
  const u2 = new Uint32Array(b, 0, b.byteLength >> 2);

  for (let i = 0; i < u1.length; i++)
  {
    if (u1[i] !== u2[i])
      return false;
  }

  const t1 = new Uint8Array(a, u1.length * 4);
  const t2 = new Uint8Array(b, u2.length * 4);

  for (let i = 0; i < t1.length; i++)
  {
    if (t1[i] !== t2[i])
      return false;
  }

  return true;
}
