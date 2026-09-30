// 性能基准：在浏览器内构造 .osz（内存 zip），驱动 PreviewGame 播放并记录
// 帧间隔 / update / render 耗时 / JS 堆。结果写入 window.__benchResult，
// 由 bench/run.mjs 通过 CDP 取走。dev-only，不进生产产物。

import "@osucad/ruleset-osu/init";

import { DrawableHitObject } from "@osucad/core";
import { AudioBufferTrack, FramedClock, LoadState, Renderer, SampleChannel, WebGameHost } from "@osucad/framework";
import { PreviewGame } from "../src/PreviewGame";
import testOsuText from "../src/assets/bench/test.osu?raw";
import bigOsuText from "../src/assets/bench/big.osu?raw";

// 渲染路径：模块加载时探测 WebGL——可用（headless 需 --use-gl=angle，本机
// 直连 Intel Arc 真 GPU）则走真渲染管线；不可用（旧 headless 无 SwiftShader）
// 或 URL 带 ?nogl 时换成空 renderer（保留 canvas 供 MouseHandler 挂监听、
// resize() 供 renderer.size setter），update/音频/内存全部照常实测。
import type { WebGLRenderer } from "pixi.js";

const glProbe = document.createElement("canvas");
const gl = glProbe.getContext("webgl2") ?? glProbe.getContext("webgl");
const glRenderer = (() =>
{
  if (!gl) return null;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
})();
gl?.getExtension("WEBGL_lose_context")?.loseContext();

const useStubRenderer = !gl || new URLSearchParams(location.search).has("nogl");
if (useStubRenderer)
{
  const fakeCanvas = document.createElement("canvas");
  const fakeInternalRenderer = {
    canvas: fakeCanvas,
    render() {},
    resize() {},
  } as unknown as WebGLRenderer;
  Renderer.prototype.init = async function ()
  {
    Object.defineProperty(this, "canvas", { get: () => fakeCanvas });
    Object.defineProperty(this, "internalRenderer", { get: () => fakeInternalRenderer });
  };
  Renderer.prototype.render = () => {};
}

// ── 音频同步插桩（诊断员方案）：轨域→ctx 域换算 + 采样调度偏差 ──────────
// #timeAtStart/#contextTimeAtStart 是真私有字段，无法从外部读取；改为在
// start/stop/seek/rate 的原型包装里维护镜像基线：start 前读 currentTime
// （未跑时 === #offset，即原生将写入的 #timeAtStart），start 后立即读
// context.currentTime 作 #contextTimeAtStart（误差仅一次调用开销，µs 级）。

interface TrackBaseline { tAtStart: number; ctxAtStart: number; rate: number }

let activeBaseline: TrackBaseline | null = null;
let baselineGeneration = 0;
let baselineChanges = 0;
let activeCtx: AudioContext | null = null;

/** 轨域时刻 → ctx 域 ms（与 AudioBufferTrack.currentTime 公式互逆）；无基线返回 null */
function trackTimeToCtxMs(trackTimeMs: number): number | null
{
  if (!activeBaseline)
    return null;
  const b = activeBaseline;
  return b.ctxAtStart + (trackTimeMs - b.tAtStart) / b.rate;
}

interface SyncRecord
{
  phase: string;
  objId: number; // startTime 即本 run 内唯一 id
  startTime: number;
  judgeSnapshot: number; // this.time.current
  trackRealtime: number; // source.currentTime
  ctxNow: number; // ms
  when: number | null; // 秒（ctx 域）
  actualStartCtxMs: number | null;
  delta: number | null;
}

interface ChannelEvent
{
  phase: string;
  sampleName: string;
  whenMs: number | null;
  ctxNowMs: number;
  actualStartCtxMs: number;
  ended: boolean;
  endedCtxMs: number | null;
  stopped: boolean;
}

interface SeekEvent { phase: string; ctxMs: number; to: number }

const syncRecords: SyncRecord[] = [];
const channelEvents: ChannelEvent[] = [];
const seekEvents: SeekEvent[] = [];
const playSamplesStack: SyncRecord[] = [];
const channelEventOf = new WeakMap<object, ChannelEvent>();
let currentPhase = "idle";

// hook 1：AudioBufferTrack 基线镜像（start/stop/seek/rate）
{
  const proto = AudioBufferTrack.prototype as unknown as Record<string, unknown>;
  const origStart = proto.start as (this: AudioBufferTrack) => void;
  const origStop = proto.stop as (this: AudioBufferTrack) => void;
  const origSeek = proto.seek as (this: AudioBufferTrack, p: number) => boolean;
  const rateDesc = Object.getOwnPropertyDescriptor(AudioBufferTrack.prototype, "rate")!;

  const refresh = (track: AudioBufferTrack) =>
  {
    activeCtx ??= track.context;
    activeBaseline = { tAtStart: track.currentTime, ctxAtStart: track.context.currentTime * 1000, rate: track.rate };
    baselineGeneration++;
    baselineChanges++;
  };

  proto.start = function (this: AudioBufferTrack)
  {
    origStart.call(this);
    refresh(this);
  };
  proto.stop = function (this: AudioBufferTrack)
  {
    origStop.call(this);
    baselineChanges++; // 停下后轨位置冻结（currentTime === #offset），旧换算作废
  };
  proto.seek = function (this: AudioBufferTrack, p: number)
  {
    const ok = origSeek.call(this, p);
    seekEvents.push({ phase: currentPhase, ctxMs: this.context.currentTime * 1000, to: p });
    if (!this.isRunning)
      baselineChanges++; // 未跑 seek 只改 #offset，等价基线漂移
    return ok;
  };
  Object.defineProperty(AudioBufferTrack.prototype, "rate", {
    get: rateDesc.get,
    set(this: AudioBufferTrack, v: number)
    {
      rateDesc.set!.call(this, v);
      if (this.isRunning)
        refresh(this); // 原实现 stop+start 重启；start 包装已刷新，此处兜底幂等重算
    },
  });
}

// hook 2：DrawableHitObject.playSamples —— 记录期望发声（轨域）与判定帧相位
const origPlaySamples = DrawableHitObject.prototype.playSamples;
DrawableHitObject.prototype.playSamples = function (this: never)
{
  const self = this as unknown as {
    hitObject?: { startTime: number };
    time: { current: number };
    clock: unknown;
  };
  let source: unknown = self.clock;
  while (source instanceof FramedClock)
    source = (source as unknown as { source: unknown }).source;

  const startTime = self.hitObject?.startTime ?? -1;
  const rec: SyncRecord = {
    phase: currentPhase,
    objId: startTime,
    startTime,
    judgeSnapshot: self.time.current,
    trackRealtime: source instanceof AudioBufferTrack ? source.currentTime : -1,
    ctxNow: (activeCtx ??= (source as AudioBufferTrack | null)?.context ?? null)?.currentTime * 1000 ?? -1,
    when: null,
    actualStartCtxMs: null,
    delta: null,
  };
  playSamplesStack.push(rec);
  try
  {
    return (origPlaySamples as (this: never) => void).call(this);
  }
  finally
  {
    playSamplesStack.pop();
    syncRecords.push(rec);
  }
};

// hook 3：SampleChannel.play/stop —— 记录实际起播（ctx 域）与 channel 生死。
// ended 用 addEventListener 旁听（与原生 onended 赋值并存，不改其行为）。
{
  const proto = SampleChannel.prototype as unknown as Record<string, unknown>;
  const origPlay = proto.play as (this: never, when?: number) => boolean;
  const origStop = proto.stop as (this: never) => void;

  proto.play = function (this: never, when?: number)
  {
    const self = this as unknown as { sample: { name: string; context: AudioContext }; output: AudioBufferSourceNode };
    const ctxNowMs = (activeCtx ??= self.sample.context).currentTime * 1000;
    const actualStartCtxMs = (when ?? ctxNowMs / 1000) * 1000; // Web Audio 语义：when 缺省=立即
    const ev: ChannelEvent = {
      phase: currentPhase,
      sampleName: self.sample.name,
      whenMs: when != null ? when * 1000 : null,
      ctxNowMs,
      actualStartCtxMs,
      ended: false,
      endedCtxMs: null,
      stopped: false,
    };

    // 与最近的 playSamples 配对，算 Δ（换算用当前基线；start/seek 后基线已刷新）
    const rec = playSamplesStack.at(-1);
    if (rec)
    {
      rec.when = when ?? null;
      rec.actualStartCtxMs = actualStartCtxMs;
      const expected = trackTimeToCtxMs(rec.startTime);
      rec.delta = expected != null && rec.startTime >= 0 ? actualStartCtxMs - expected : null;
    }

    const ok = origPlay.call(this, when);
    if (ok)
    {
      channelEventOf.set(this as object, ev);
      try
      {
        self.output.addEventListener("ended", () =>
        {
          ev.ended = true;
          ev.endedCtxMs = (activeCtx ?? self.sample.context).currentTime * 1000;
        }, { once: true });
      }
      catch { /* output 不支持时跳过旁听 */ }
      channelEvents.push(ev);
    }
    return ok;
  };

  proto.stop = function (this: never)
  {
    const ev = channelEventOf.get(this as object);
    if (ev)
      ev.stopped = true;
    return origStop.call(this);
  };
}

const game = new PreviewGame();
const host = new WebGameHost();

(window as unknown as { __game?: PreviewGame }).__game = game;

// 顶层窗口里 window.parent === window，PreviewGame.post → postToParent
// 的回报我们自己就能收到（同时也是它自己按协议回传给 iframe 宿主的通道）。
const loaded = new Promise<void>((resolve, reject) =>
{
  const timer = setTimeout(() => reject(new Error("cad:loaded timeout")), 30_000);
  window.addEventListener("message", (event) =>
  {
    const data = event.data as { type?: string; meta?: unknown };
    if (data?.type === "cad:loaded")
    {
      clearTimeout(timer);
      resolve();
    }
  });
});

void host.run(game);

// ── .osz 构造：stored（非压缩）ZIP，两条目 ──────────────────────────────

function crc32(data: Uint8Array): number
{
  let crc = ~0;
  for (let i = 0; i < data.length; i++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return ~crc >>> 0;
}

const CRC_TABLE = (() =>
{
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++)
  {
    let c = n;
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function zip(entries: { name: string; data: Uint8Array }[]): ArrayBuffer
{
  const enc = new TextEncoder();
  const names = entries.map(e => enc.encode(e.name));
  const localSize = entries.reduce((s, e, i) => s + 30 + names[i].length + e.data.length, 0);
  const centralSize = entries.reduce((s, e, i) => s + 46 + names[i].length, 0);
  const buf = new DataView(new ArrayBuffer(localSize + centralSize + 22));
  let o = 0;
  const offsets: number[] = [];

  for (let i = 0; i < entries.length; i++)
  {
    const name = names[i];
    const data = entries[i].data;
    const crc = crc32(data);
    offsets.push(o);
    buf.setUint32(o, 0x04034b50, true);
    buf.setUint16(o + 4, 20, true); // version needed
    buf.setUint16(o + 6, 0x0800, true); // UTF-8 flag
    buf.setUint16(o + 8, 0, true); // stored
    buf.setUint16(o + 14, crc, true);
    buf.setUint32(o + 18, data.length, true);
    buf.setUint32(o + 22, data.length, true);
    buf.setUint16(o + 26, name.length, true);
    o += 30;
    new Uint8Array(buf.buffer).set(name, o); o += name.length;
    new Uint8Array(buf.buffer).set(data, o); o += data.length;
  }

  const centralStart = o;
  for (let i = 0; i < entries.length; i++)
  {
    const name = names[i];
    const data = entries[i].data;
    buf.setUint32(o, 0x02014b50, true);
    buf.setUint16(o + 4, 20, true);
    buf.setUint16(o + 6, 20, true);
    buf.setUint16(o + 8, 0x0800, true);
    buf.setUint16(o + 10, 0, true);
    buf.setUint32(o + 16, crc32(data), true);
    buf.setUint32(o + 20, data.length, true);
    buf.setUint32(o + 24, data.length, true);
    buf.setUint16(o + 28, name.length, true);
    buf.setUint32(o + 42, offsets[i], true);
    o += 46;
    new Uint8Array(buf.buffer).set(name, o); o += name.length;
  }

  buf.setUint32(o, 0x06054b50, true);
  buf.setUint16(o + 8, entries.length, true);
  buf.setUint16(o + 10, entries.length, true);
  buf.setUint32(o + 12, o - centralStart, true);
  buf.setUint32(o + 16, centralStart, true);
  return buf.buffer;
}

function sineWav(seconds: number, rate = 22050): Uint8Array
{
  const n = Math.floor(seconds * rate);
  const data = new Uint8Array(44 + n * 2);
  const v = new DataView(data.buffer);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) data[off + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
  {
    const t = i / rate;
    const sample = Math.sin(2 * Math.PI * 220 * t) * 0.3 * (i % 44100 < 22050 ? 1 : 0.6);
    v.setInt16(44 + i * 2, sample * 32767, true);
  }
  return data;
}

// ── 采样与指标 ────────────────────────────────────────────────────────

interface PerfMemory { usedJSHeapSize: number; totalJSHeapSize: number }
const mem = () => (performance as unknown as { memory?: PerfMemory }).memory?.usedJSHeapSize ?? 0;

const frames: number[] = [];
const updates: number[] = [];
const renders: number[] = [];
const heapSamples: { t: number; heap: number }[] = [];

let recording = false;
let lastTs = 0;
function onRaf(ts: number)
{
  if (recording && lastTs > 0)
    frames.push(ts - lastTs);
  lastTs = ts;
  requestAnimationFrame(onRaf);
}
requestAnimationFrame(onRaf);

const origUpdate = host.update.bind(host);
host.update = () =>
{
  const t0 = performance.now();
  origUpdate();
  if (recording)
    updates.push(performance.now() - t0);
};

function stats(values: number[])
{
  if (!values.length)
    return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: s[s.length - 1],
    over20ms: s.filter(v => v > 20).length,
    over50ms: s.filter(v => v > 50).length,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main()
{
  // fixture 选择：?fixture=big 用大谱面（1900 物件 / 滑条 60% / 140s 音频）
  const fixture = new URLSearchParams(location.search).get("fixture") === "big" ? "big" : "test";
  const audio = sineWav(fixture === "big" ? 140 : 110);
  const osu = new TextEncoder().encode(fixture === "big" ? bigOsuText : testOsuText);
  const osz = zip([
    { name: `${fixture}.osu`, data: osu },
    { name: "audio.mp3", data: audio },
  ]);

  // 等游戏就绪：loadComplete 后 PreviewGame 才 dispatch
  while (game.loadState < LoadState.Ready)
    await sleep(50);

  const heapBeforeLoad = mem();
  const tLoad = performance.now();
  game.onMessage({ type: "hs:load", name: "bench.osz", bytes: osz });
  await loaded;
  const loadMs = performance.now() - tLoad;
  const heapAfterLoad = mem();

  await game.resumeAudio();

  const phases: Record<string, unknown> = {};

  async function runPhase(name: string, seconds: number, before?: () => void)
  {
    currentPhase = name; // 先打标签再跑 before（before 内的 seek 要归入本相）
    before?.();
    frames.length = updates.length = renders.length = 0;
    lastTs = 0;
    const h0 = mem();
    const t0 = performance.now();
    recording = true;

    const end = t0 + seconds * 1000;
    while (performance.now() < end)
    {
      await sleep(200);
      heapSamples.push({ t: performance.now() - t0, heap: mem() });
    }

    recording = false;
    currentPhase = "idle";
    phases[name] = {
      frames: stats(frames),
      update: stats(updates),
      render: stats(renders),
      heapStart: h0,
      heapEnd: mem(),
    };
  }

  // render 计时：renderer.render 由 host.render() 调用，包一层统计
  const hostAny = host as unknown as { render: () => void };
  const origRender = hostAny.render.bind(host);
  hostAny.render = () =>
  {
    const t0 = performance.now();
    origRender();
    if (recording)
      renders.push(performance.now() - t0);
  };

  game.onMessage({ type: "hs:control", action: "play" });
  await runPhase("playback", 15);

  // seek 压力：中段随机跳 5 次后继续录（时序保持原样；seek 事件归入 afterSeek 相）
  currentPhase = "afterSeek";
  for (const t of [30000, 60000, 10000, 80000, 45000])
  {
    game.onMessage({ type: "hs:control", action: "seek", value: t });
    await sleep(80);
  }
  currentPhase = "idle";
  await runPhase("afterSeek", 8);

  // 热更新路径：同包 hs:update（换 skin + 重建/复用屏）
  const tUpd = performance.now();
  game.onMessage({ type: "hs:update", name: "bench.osz", bytes: osz.slice(0) });
  await new Promise<void>((resolve) =>
  {
    const onMsg = (e: MessageEvent) =>
    {
      if ((e.data as { type?: string }).type === "cad:loaded")
      {
        window.removeEventListener("message", onMsg);
        resolve();
      }
    };
    window.addEventListener("message", onMsg);
  });
  const updateMs = performance.now() - tUpd;

  // 定向场景 6a：热更新相内模拟宿主侧 buildBytes 冷路径的 100ms 主线程占用，
  // 观察采样调度 Δ 尖刺与恢复收敛（updateMs 计时已结束，不改既有指标语义）
  const busy: { startCtxMs: number; endCtxMs: number } = { startCtxMs: -1, endCtxMs: -1 };
  await runPhase("afterHotUpdate", 8, () =>
  {
    setTimeout(() =>
    {
      busy.startCtxMs = (activeCtx?.currentTime ?? 0) * 1000;
      const t0 = performance.now();
      while (performance.now() - t0 < 100);
      busy.endCtxMs = (activeCtx?.currentTime ?? 0) * 1000;
    }, 500);
  });

  // 定向场景 6c：后台 3s → 回前台，统计后台/恢复期错帧物件数。
  // ⚠ headless 下不可靠（默认跳过，URL 带 ?bg 才启用）：实测两种后台化手段
  // （开新 tab 挤后台 / Page.setWebLifecycleState frozen→active）都会把页面打
  // 入不可恢复的 hidden（active 后 visible 不回来），且污染整 run 数据。
  // run.mjs 检测 __benchPhase=bgWait 后用 CDP Page.setWebLifecycleState 把本页
  // frozen 3s 再 active；页面回不来时本相 8s 窗口自然超时。
  const bg: Record<string, unknown> = { rafFrozen: false, visibilityHidden: false, frozenAtCtxMs: -1, visibleAtCtxMs: -1, enabled: false };
  {
    let lastCount = -1;
    let stallRuns = 0;
    const bgProbe = setInterval(() =>
    {
      if (!bg.rafFrozen)
      {
        if (frames.length === lastCount && lastCount >= 0)
        {
          if (++stallRuns >= 2)
          {
            bg.rafFrozen = true;
            bg.frozenAtCtxMs = (activeCtx?.currentTime ?? 0) * 1000;
          }
        }
        else
          stallRuns = 0;
        lastCount = frames.length;
      }
      else if (bg.visibleAtCtxMs === -1 && frames.length > lastCount)
      {
        bg.visibleAtCtxMs = (activeCtx?.currentTime ?? 0) * 1000;
        lastCount = frames.length;
      }
    }, 500);
    const onVis = () =>
    {
      if (document.visibilityState === "hidden")
        bg.visibilityHidden = true;
    };
    const bgEnabled = new URLSearchParams(location.search).has("bg");
    bg.enabled = bgEnabled;
    await runPhase("background", bgEnabled ? 8 : 0.2, () =>
    {
      if (!bgEnabled)
        return;
      document.addEventListener("visibilitychange", onVis);
      (window as unknown as { __benchPhase: string | null }).__benchPhase = "bgWait";
    });
    clearInterval(bgProbe);
    document.removeEventListener("visibilitychange", onVis);
  }
  (window as unknown as { __benchPhase: string | null }).__benchPhase = null;

  game.onMessage({ type: "hs:control", action: "stats" });
  const statsMsg = await new Promise<{ lookups: number; hits: number }>((resolve) =>
  {
    const onMsg = (e: MessageEvent) =>
    {
      const d = e.data as { type?: string; lookups?: number; hits?: number };
      if (d.type === "cad:stats")
      {
        window.removeEventListener("message", onMsg);
        resolve({ lookups: d.lookups!, hits: d.hits! });
      }
    };
    window.addEventListener("message", onMsg);
  });

  // ── 同步统计：Δ 分布 / 判定帧相位 / 幽灵音 / busy-loop / 后台 ──────────
  const byPhase = (phase: string) => syncRecords.filter(r => r.delta != null && r.phase === phase);
  const allDelta = syncRecords.filter(r => r.delta != null);
  const dist = (rs: typeof syncRecords) =>
  {
    const d = rs.map(r => r.delta as number).sort((a, b) => a - b);
    if (!d.length)
      return { n: 0 };
    const pick = (q: number) => d[Math.min(d.length - 1, Math.floor(q * d.length))];
    return {
      n: d.length,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      min: d[0],
      max: d[d.length - 1],
      late10: d.filter(v => v > 10).length,
      early10: d.filter(v => v < -10).length,
      spike50: d.filter(v => Math.abs(v) > 50).length,
    };
  };

  // 判定帧相位（judgeSnapshot - startTime，模型预期 [-帧长,0] 均匀）与 Δ 的相关
  const judgePhase = allDelta.map(r => r.judgeSnapshot - r.startTime).sort((a, b) => a - b);
  const jp = judgePhase.length
    ? {
        n: judgePhase.length,
        p5: judgePhase[Math.floor(judgePhase.length * 0.05)],
        p50: judgePhase[Math.floor(judgePhase.length * 0.5)],
        p95: judgePhase[Math.floor(judgePhase.length * 0.95)],
        min: judgePhase[0],
        max: judgePhase[judgePhase.length - 1],
        hist: [-70, -60, -50, -40, -30, -20, -10, 0].map(
          (edge, i, arr) =>
          {
            const lo = i === 0 ? -Infinity : arr[i - 1];
            return judgePhase.filter(v => v > lo && v <= edge).length;
          }),
      }
    : { n: 0 };
  const pearson = (xs: number[], ys: number[]) =>
  {
    if (xs.length < 2)
      return null;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++)
    {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  };
  const corrDeltaJudge = pearson(
    allDelta.map(r => r.delta as number),
    allDelta.map(r => r.judgeSnapshot - r.startTime),
  );

  // 幽灵音（6b）：afterSeek 相各次 seek 的两种口径
  let ghostLiteral = 0;
  let ghostSemantic = 0;
  for (const sk of seekEvents.filter(s => s.phase === "afterSeek"))
  {
    for (const ev of channelEvents)
    {
      if (ev.whenMs == null)
        continue;
      if (ev.whenMs > sk.ctxMs && ev.whenMs - sk.ctxMs <= 50 && ev.ctxNowMs <= sk.ctxMs + 50 && ev.ended && !ev.stopped)
        ghostLiteral++;
      if (ev.whenMs <= sk.ctxMs && ev.ended && !ev.stopped && (ev.endedCtxMs ?? 0) > sk.ctxMs)
        ghostSemantic++;
    }
  }

  // busy-loop（6a）：busy 窗内及恢复期 Δ 序列与收敛点
  const busyRecords = busy.startCtxMs >= 0
    ? allDelta.filter(r => r.ctxNow >= busy.startCtxMs - 50 && r.ctxNow <= busy.endCtxMs + 1500)
    : [];
  const busyDeltas = busyRecords.map(r => r.delta as number);
  const afterBusy = busy.endCtxMs >= 0
    ? allDelta.filter(r => r.ctxNow > busy.endCtxMs)
    : [];
  let recoverIdx = afterBusy.findIndex(r => Math.abs(r.delta as number) <= 10);

  // 后台相（6c）
  const bgDeltas = byPhase("background").map(r => r.delta as number);

  const heapValues = heapSamples.map(h => h.heap);
  const heapSpanMB = heapValues.length ? (Math.max(...heapValues) - Math.min(...heapValues)) / 1048576 : 0;

  (window as unknown as { __benchResult: unknown }).__benchResult = {
    ua: navigator.userAgent,
    renderer: useStubRenderer ? "stub" : glRenderer,
    fixture,
    loadMs,
    updateMs,
    heapBeforeLoad,
    heapAfterLoad,
    heapEnd: mem(),
    audioState: (game as unknown as { audioManager: { context: { state: string } } }).audioManager.context.state,
    phases,
    sampleStats: statsMsg,
    heapSamples,
    heapSpanMB,
    sync: {
      baselineChanges,
      baselineGeneration,
      recordsTotal: syncRecords.length,
      channels: {
        total: channelEvents.length,
        ended: channelEvents.filter(e => e.ended).length,
        stopped: channelEvents.filter(e => e.stopped).length,
      },
      combined: dist(allDelta),
      perPhase: {
        playback: dist(byPhase("playback")),
        afterSeek: dist(byPhase("afterSeek")),
        afterHotUpdate: dist(byPhase("afterHotUpdate")),
        background: dist(byPhase("background")),
      },
      judgePhase: jp,
      corrDeltaJudge,
      ghost: { seekCount: seekEvents.filter(s => s.phase === "afterSeek").length, literal: ghostLiteral, semantic: ghostSemantic },
      busyLoop: {
        startCtxMs: busy.startCtxMs,
        endCtxMs: busy.endCtxMs,
        windowN: busyDeltas.length,
        spike10: busyDeltas.filter(v => v > 10).length,
        spike50: busyDeltas.filter(v => v > 50).length,
        deltaSeq: busyDeltas.slice(0, 30),
        recoveredAtRecord: recoverIdx,
      },
      background: {
        ...bg,
        spike50: bgDeltas.filter(v => Math.abs(v) > 50).length,
        deltaFirst12: bgDeltas.slice(0, 12),
      },
    },
  };
}

main().catch((e) =>
{
  (window as unknown as { __benchError: string }).__benchError = String(e?.stack ?? e);
});
