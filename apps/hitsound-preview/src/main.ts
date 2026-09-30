import "./styles.css";
import "@osucad/ruleset-osu/init";

import { WebGameHost } from "@osucad/framework";
import { isToPreview } from "./protocol";
import { PreviewGame } from "./PreviewGame";

const game = new PreviewGame();
const host = new WebGameHost();

// 冒烟/调试句柄（音量断言等）
(window as unknown as { __game?: PreviewGame }).__game = game;

void host.run(game);

window.addEventListener("message", (event) =>
{
  // 只接受父窗口消息；同源 iframe 部署下 source 校验足够
  if (event.source !== window.parent)
    return;

  if (!isToPreview(event.data))
    return;

  game.onMessage(event.data);
});

// 浏览器自动播放策略兜底：iframe 内任意点击都可以解锁 AudioContext
window.addEventListener("pointerdown", () => void game.resumeAudio(), { capture: true });
