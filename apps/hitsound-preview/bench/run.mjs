// 基准运行器：拉起 headless Chromium，加载 /bench.html，轮询 window.__benchResult，
// 输出 JSON 到 stdout。用法: node bench/run.mjs [url] [--timeout=90]

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const url = process.argv[2] ?? "http://localhost:4201/bench.html";
const timeoutArg = process.argv.find(a => a.startsWith("--timeout="));
const timeoutMs = Number(timeoutArg?.slice(10) ?? 90) * 1000;

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
  "--use-gl=swiftshader",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--mute-audio",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeErr = "";
chrome.stderr.on("data", d => chromeErr += d);

async function fetchJson(path)
{
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
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
  await send("Page.navigate", { url });

  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline)
  {
    await delay(1000);
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify({ r: window.__benchResult ?? null, e: window.__benchError ?? null })",
      returnByValue: true,
    });
    const parsed = JSON.parse(r.result.value ?? "{}");
    if (parsed.e)
      throw new Error(`bench 页内错误: ${parsed.e}`);
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
