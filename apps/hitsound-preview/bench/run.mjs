// 基准运行器：拉起 headless Chromium，加载 /bench.html，轮询 window.__benchResult，
// 输出 JSON 到 stdout。用法: node bench/run.mjs [url] [--timeout=90] [--gl=angle|swiftshader|stub] [--bg]
// --gl 决定渲染路径：angle=headless 直连本机 GPU 走真渲染管线（默认）；
//   swiftshader=SwANGLE 软渲染（本机 Vulkan 缺 VK_KHR_wayland_surface 时不可用，
//   页面侧探测失败会自动落空桩）；stub=空渲染桩（页面加 ?nogl=1，仅测 update/音频/内存）。
// fixture 由页面 URL 选择：?fixture=big 用大谱面（1900 物件），默认 test.osu。
// --bg 启用后台定向场景（页面需带 ?bg；headless 下不可靠，默认禁用）。

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const url = process.argv[2] ?? "http://localhost:4201/bench.html";
const timeoutArg = process.argv.find(a => a.startsWith("--timeout="));
const timeoutMs = Number(timeoutArg?.slice(10) ?? 90) * 1000;
const glArg = process.argv.find(a => a.startsWith("--gl="));
const glMode = glArg?.slice(5) ?? "angle";

const GL_FLAGS = {
  angle: ["--use-gl=angle"],
  swiftshader: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  stub: [],
};
const benchUrl = glMode === "stub"
  ? url + (url.includes("?") ? "&" : "?") + "nogl=1"
  : url;

const CHROME = process.env.CHROME_BIN ?? "chromium";
const PORT = 9333;

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-precise-memory-info",
  "--window-size=1280,800",
  ...GL_FLAGS[glMode] ?? [],
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--mute-audio",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeErr = "";
chrome.stderr.on("data", d => chromeErr += d);

async function fetchJson(path, init)
{
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return res.json();
}

async function main()
{
  // 等 DevTools 端口起来
  let targets;
  for (let i = 0; i < 100; i++)
  {
    try { targets = await fetchJson("/json/list"); break; }
    catch { await delay(200); }
  }
  if (!targets)
    throw new Error(`chrome devtools 未就绪: ${chromeErr.slice(-500)}`);

  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) =>
  {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id))
    {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) =>
  {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send("Page.enable");
  await send("Page.navigate", { url: benchUrl });

  const deadline = Date.now() + timeoutMs;
  const bgEnabled = process.argv.includes("--bg");
  let result;
  let bgActed = false;
  while (Date.now() < deadline)
  {
    await delay(1000);
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify({ r: window.__benchResult ?? null, e: window.__benchError ?? null, p: window.__benchPhase ?? null })",
      returnByValue: true,
    });
    const parsed = JSON.parse(r.result.value ?? "{}");
    if (parsed.e)
      throw new Error(`bench 页内错误: ${parsed.e}`);
    // 后台定向场景（默认禁用，--bg 开启）：bench 置 __benchPhase=bgWait 时冻结
    // 页面 3s 再恢复。headless 实测 frozen→active 后页面永久 hidden 不可恢复，
    // 且污染整 run 数据，故仅作 opt-in 实验用
    if (bgEnabled && parsed.p === "bgWait" && !bgActed)
    {
      bgActed = true;
      try
      {
        await send("Page.setWebLifecycleState", { state: "frozen" });
        await delay(3000);
        await send("Page.setWebLifecycleState", { state: "active" });
      }
      catch (e)
      {
        chromeErr += `\nbg-scene failed: ${e}`;
      }
    }
    if (parsed.r)
    {
      result = parsed.r;
      break;
    }
  }

  if (!result)
    throw new Error("超时未拿到 __benchResult");

  console.log(JSON.stringify(result, null, 2));
  ws.close();
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => chrome.kill("SIGKILL"));
