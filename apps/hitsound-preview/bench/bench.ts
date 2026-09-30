// 性能基准：在浏览器内构造 .osz（内存 zip），驱动 PreviewGame 播放并记录
// 帧间隔 / update / render 耗时 / JS 堆。结果写入 window.__benchResult，
// 由 bench/run.mjs 通过 CDP 取走。dev-only，不进生产产物。

import "@osucad/ruleset-osu/init";

import { LoadState, Renderer, WebGameHost } from "@osucad/framework";
import { PreviewGame } from "../src/PreviewGame";
import osuText from "../src/assets/bench/test.osu?raw";

// headless 无 WebGL：换成空 renderer（保留 canvas 供 MouseHandler 挂监听、
// resize() 供 renderer.size setter），update/音频/内存全部照常实测。
import type { WebGLRenderer } from "pixi.js";
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
  const audio = sineWav(110);
  const osu = new TextEncoder().encode(osuText);
  const osz = zip([
    { name: "test.osu", data: osu },
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

  // seek 压力：中段随机跳 5 次后继续录
  for (const t of [30000, 60000, 10000, 80000, 45000])
  {
    game.onMessage({ type: "hs:control", action: "seek", value: t });
    await sleep(80);
  }
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

  await runPhase("afterHotUpdate", 8);

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

  (window as unknown as { __benchResult: unknown }).__benchResult = {
    ua: navigator.userAgent,
    loadMs,
    updateMs,
    heapBeforeLoad,
    heapAfterLoad,
    heapEnd: mem(),
    audioState: (game as unknown as { audioManager: { context: { state: string } } }).audioManager.context.state,
    phases,
    sampleStats: statsMsg,
    heapSamples,
  };
}

main().catch((e) =>
{
  (window as unknown as { __benchError: string }).__benchError = String(e?.stack ?? e);
});
