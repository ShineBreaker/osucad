import type { Beatmap, ISkin } from "@osucad/core";
import { BeatmapParser, GameplayClock, OsucadGameBase, Skin, SkinProvidingContainer } from "@osucad/core";
import type { ITrack } from "@osucad/framework";
import { AudioBufferTrack, Axes, LoadState, SimpleFileSystem, ZipArchiveFileSystem } from "@osucad/framework";
import type { ToParent, ToPreview } from "./protocol";
import { postToParent } from "./protocol";
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

  #beatmap?: Beatmap;
  #osuPath = "";
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
        await this.#control(message.action, message.value);
        break;
      }
    }
    catch (e)
    {
      this.post({ type: "cad:error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async #control(action: string, value?: number)
  {
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
        this.audioManager.volume.value = Math.min(1, Math.max(0, value));
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
    const seq = ++this.#seq;

    const fs = await ZipArchiveFileSystem.createMutable(bytes);
    if (seq !== this.#seq)
      return;

    const parsed = await this.#parseBeatmap(fs);
    if (seq !== this.#seq)
      return;

    const { beatmap, path, text } = parsed;

    // .osu 内容不变 → 复用游玩屏，只换皮肤/音轨（热更新路径，画面不重置）
    const sameBeatmap
      = preserveState
      && this.#skinContainer !== undefined
      && this.#osuPath === path
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
    const skinFs = new SimpleFileSystem();
    for (const [name, data] of await defaultSkinFiles())
      await skinFs.create(name, data);
    for (const entry of fs.entries())
    {
      if (entry.path === audioPath)
        continue;
      await skinFs.create(entry.path, await entry.read());
    }

    const skin = new Skin(skinFs, this);
    const skinT: ISkin
      = (await beatmap.beatmapInfo.ruleset?.createSkinTransformer?.(skin)) ?? skin;

    // 采样命中统计（验证用）：命中数 = 在 fs 里找到文件的查询次数
    const skinAny = skinT as ISkin & { getSample: ISkin["getSample"] };
    const origGetSample = skinAny.getSample.bind(skinT);
    skinAny.getSample = (info) =>
    {
      this.#sampleLookups++;
      const sample = origGetSample(info);
      if (sample)
        this.#sampleHits++;
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
    this.#osuPath = path;
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
      },
    });
  }

  async #parseBeatmap(fs: SimpleFileSystem): Promise<ParsedBeatmap>
  {
    const candidates = fs.entries()
      .filter(f => f.path.endsWith(".osu"))
      .sort((a, b) => a.path.localeCompare(b.path));

    const parser = new BeatmapParser();
    let lastError: unknown;

    for (const entry of candidates)
    {
      const text = new TextDecoder().decode(await entry.read());

      try
      {
        const beatmap = await parser.parse(text);

        if (!beatmap.beatmapInfo.ruleset)
          throw new Error("谱面未声明可用 Mode");

        return { beatmap, path: entry.path, text };
      }
      catch (e)
      {
        lastError = e;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("谱面集中没有可解析的 .osu 文件");
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
