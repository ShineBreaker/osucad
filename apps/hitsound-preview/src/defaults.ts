// 最小默认皮肤：多数 .osz 不内嵌皮肤资源（皮肤在玩家本地），
// 没有 hitcircle/approachcircle 等纹理时所有物件都是隐形 Sprite。
// 这里程序化生成一套纯白系纹理（hitcircle 会被 combo 颜色染色），
// 以文件形式注入皮肤文件系统——谱面包自带同名文件时自动覆盖（文件名优先）。

async function png(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Promise<ArrayBuffer>
{
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  draw(ctx, size);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  return blob!.arrayBuffer();
}

function circle(ctx: CanvasRenderingContext2D, s: number, fill = "#ffffff", stroke = "#d8d8d8")
{
  const r = s / 2 - 6;
  const g = ctx.createRadialGradient(s / 2, s / 2, r * 0.55, s / 2, s / 2, r);
  g.addColorStop(0, fill);
  g.addColorStop(0.85, fill);
  g.addColorStop(1, "rgba(255,255,255,0.85)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 5;
  ctx.stroke();
}

function ring(ctx: CanvasRenderingContext2D, s: number, width = 10, color = "#ffffff")
{
  const r = s / 2 - width / 2 - 3;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, s: number, color = "#ffffff")
{
  ctx.fillStyle = color;
  ctx.strokeStyle = "#33333388";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(s * 0.15, s * 0.25);
  ctx.lineTo(s * 0.7, s * 0.5);
  ctx.lineTo(s * 0.15, s * 0.75);
  ctx.closePath();
  ctx.fill();
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

function digit(n: number)
{
  return (ctx: CanvasRenderingContext2D, s: number) =>
  {
    ctx.font = `bold ${Math.floor(s * 0.62)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = s * 0.08;
    ctx.strokeStyle = "#00000088";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(String(n), s / 2, s / 2 + 2);
    ctx.fillText(String(n), s / 2, s / 2 + 2);
  };
}

function judgement(label: string, color: string)
{
  return (ctx: CanvasRenderingContext2D, s: number) =>
  {
    ctx.font = `bold ${Math.floor(s * 0.3)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = "#000000aa";
    ctx.fillStyle = color;
    ctx.strokeText(label, s / 2, s / 2);
    ctx.fillText(label, s / 2, s / 2);
  };
}

let cache: Promise<Map<string, ArrayBuffer>> | null = null;

/** 生成一次并缓存；返回 path → png bytes */
export function defaultSkinFiles(): Promise<Map<string, ArrayBuffer>>
{
  return (cache ??= (async () =>
  {
    const files = new Map<string, ArrayBuffer>();

    files.set("hitcircle.png", await png(128, (c, s) => circle(c, s)));
    files.set("hitcircleoverlay.png", await png(128, (c, s) => ring(c, s, 14)));
    files.set("approachcircle.png", await png(128, (c, s) => ring(c, s, 8)));
    files.set("cursor.png", await png(32, (c, s) => circle(c, s)));
    files.set("cursortrail.png", await png(24, softDot));
    files.set("sliderfollowcircle.png", await png(128, (c, s) => ring(c, s, 10)));
    files.set("sliderb0.png", await png(64, (c, s) => circle(c, s)));
    files.set("reversearrow.png", await png(96, (c, s) => arrow(c, s)));
    files.set("followpoint-0.png", await png(64, (c, s) => arrow(c, s)));
    files.set("hit300.png", await png(160, judgement("300", "#9fd27f")));
    files.set("hit100.png", await png(160, judgement("100", "#7fc9d2")));
    files.set("hit50.png", await png(160, judgement("50", "#b58fc9")));
    files.set("hit0.png", await png(160, judgement("✕", "#ff6f6f")));

    for (let i = 0; i < 10; i++)
      files.set(`default-${i}.png`, await png(80, digit(i)));

    return files;
  })());
}
