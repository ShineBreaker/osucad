// 最小默认皮肤（Argon 风格）：多数 .osz 不内嵌皮肤资源（皮肤在玩家本地），
// 没有 hitcircle/approachcircle 等纹理时所有物件都是隐形 Sprite。
//
// lazer 的 Argon 皮肤不是贴图包——圈体由 ArgonMainCirclePiece.cs 用 C# 图层
// 程序化拼出（暗底 + 两层渐变环 + 白色描边环 + 加粗数字），没有可提取的 PNG。
// 这里按其源码实测的几何比例/配色（直径分数见各常量）在 Canvas 上等价重绘，
// 仍以文件形式注入皮肤文件系统——谱面包自带同名文件时自动覆盖（文件名优先）。
//
// 染色模型（与 LegacyCirclePiece 对应）：hitcircle.png 被 combo 颜色乘染——
// 亮区染成 accent、暗区保持近黑；hitcircleoverlay.png 不染（白色描边环）。

import comfortaaUrl from "./assets/comfortaa-700.woff2?url";

const FONT = "PreviewDigits";

async function png(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Promise<ArrayBuffer>
{
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  draw(ctx, size);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  return blob!.arrayBuffer();
}

// ── Argon 圈体几何（ArgonMainCirclePiece.cs，均为圈体直径的分数）──
// BORDER = D·2/58 ≈ 0.0345；GRADIENT = BORDER·2.5 ≈ 0.086
// OUTER_GRADIENT = D−4·BORDER ≈ 0.862；INNER_GRADIENT = OUTER−2·GT ≈ 0.69；INNER_FILL ≈ 0.517
const F_INNER_FILL = 0.517, F_INNER_GRAD = 0.69, F_OUTER_GRAD = 0.862;

const DARK = "#17171c";   // accent.Darken(4) 的灰度近似（乘染后 ≈ 极暗 accent）
const MID = "#8f8f99";    // accent.Darken(0.5..0.6)
const BRIGHT = "#ffffff"; // accent 全亮

// Argon 圈体：暗心 → 中层渐亮 → 外层亮环 → 描边环之下回落暗色。
// 只填圆形区域（arc），圆外必须保持透明——fillRect 会让四角钳制成
// 渐变末端的深色，渲染出来就是物件后面的黑色方块，还会污染滑条。
function argonCircle(ctx: CanvasRenderingContext2D, s: number)
{
  const r = s / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, DARK);
  g.addColorStop(F_INNER_FILL - 0.02, DARK);
  g.addColorStop(F_INNER_GRAD, MID);
  g.addColorStop(F_OUTER_GRAD, BRIGHT);
  g.addColorStop(F_OUTER_GRAD + 0.03, DARK);
  g.addColorStop(1, DARK);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
}

// 白色描边环（hitcircleoverlay，不被染色）——宽度 = BORDER
function borderRing(ctx: CanvasRenderingContext2D, s: number)
{
  const lw = Math.max(s * 0.0345, 1.2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - lw / 2 - s * 0.004, 0, Math.PI * 2);
  ctx.stroke();
}

function approachRing(ctx: CanvasRenderingContext2D, s: number)
{
  const lw = Math.max(s * 0.045, 1.5);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - lw / 2 - s * 0.01, 0, Math.PI * 2);
  ctx.stroke();
}

// Argon 光标：实心点 + 外圈环
function argonCursor(ctx: CanvasRenderingContext2D, s: number)
{
  const r = s / 2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(r, r, s * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = s * 0.07;
  ctx.beginPath();
  ctx.arc(r, r, s * 0.36, 0, Math.PI * 2);
  ctx.stroke();
}

function softDot(ctx: CanvasRenderingContext2D, s: number)
{
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

// Argon 滑条球：同圈体的暗心+亮环结构（sliderb 也会被染色）
function sliderBall(ctx: CanvasRenderingContext2D, s: number)
{
  argonCircle(ctx, s);
  const lw = Math.max(s * 0.06, 1.5);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - lw / 2 - s * 0.01, 0, Math.PI * 2);
  ctx.stroke();
}

// Argon follow circle：细环 + 极淡底
function followCircle(ctx: CanvasRenderingContext2D, s: number)
{
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - s * 0.03, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(s * 0.035, 1);
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - s * 0.03 - s * 0.0175, 0, Math.PI * 2);
  ctx.stroke();
}

// Argon 折返/引导点：圆角 chevron
function chevron(ctx: CanvasRenderingContext2D, s: number)
{
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = s * 0.22;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(s * 0.28, s * 0.2);
  ctx.lineTo(s * 0.72, s * 0.5);
  ctx.lineTo(s * 0.28, s * 0.8);
  ctx.stroke();
}

function digit(n: number)
{
  return (ctx: CanvasRenderingContext2D, s: number) =>
  {
    ctx.font = `700 ${Math.floor(s * 0.62)}px ${FONT}, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = s * 0.06;
    ctx.shadowOffsetY = s * 0.02;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(n), s / 2, s / 2 + s * 0.02);
  };
}

function judgement(label: string, color: string)
{
  return (ctx: CanvasRenderingContext2D, s: number) =>
  {
    ctx.font = `700 ${Math.floor(s * 0.3)}px ${FONT}, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = s * 0.05;
    ctx.fillStyle = color;
    ctx.fillText(label, s / 2, s / 2);
  };
}

async function loadFont()
{
  try
  {
    const face = new FontFace(FONT, `url(${comfortaaUrl})`, { weight: "700" });
    await face.load();
    document.fonts.add(face);
  }
  catch
  {
    // 字体加载失败时回退 system-ui，数字照常渲染
  }
}

let cache: Promise<Map<string, ArrayBuffer>> | null = null;

/** 生成一次并缓存；返回 path → png bytes */
export function defaultSkinFiles(): Promise<Map<string, ArrayBuffer>>
{
  return (cache ??= (async () =>
  {
    await loadFont();

    const files = new Map<string, ArrayBuffer>();
    const set = async (name: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) =>
    {
      files.set(`${name}.png`, await png(size, draw));
      files.set(`${name}@2x.png`, await png(size * 2, draw));
    };

    await set("hitcircle", 128, argonCircle);
    await set("hitcircleoverlay", 128, borderRing);
    await set("approachcircle", 128, approachRing);
    await set("sliderb0", 64, sliderBall);
    await set("sliderfollowcircle", 128, followCircle);
    await set("reversearrow", 96, chevron);
    await set("followpoint-0", 64, chevron);
    await set("cursor", 48, argonCursor);
    await set("hit300", 160, judgement("300", "#bfe9ff"));
    await set("hit100", 160, judgement("100", "#8ee6a0"));
    await set("hit50", 160, judgement("50", "#d6a8ff"));
    await set("hit0", 160, judgement("✕", "#ff7d7d"));

    files.set("cursortrail.png", await png(24, softDot));

    for (let i = 0; i < 10; i++)
      await set(`default-${i}`, 80, digit(i));

    return files;
  })());
}
