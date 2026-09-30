// postMessage 协议：宿主页面（hitsound-share）与预览 iframe 之间。
// 字节负载统一走完整 .osz（zip）ArrayBuffer，作为 transferable 零拷贝传入。

export interface PreviewMeta
{
  title: string;
  artist: string;
  version: string;
  creator: string;
  /** 谱面时长（ms）：有音轨时取音轨长度，否则取最后一个物件的 endTime */
  duration: number;
  /** 物件数 */
  objects: number;
  /** 是否成功装载音轨 */
  hasAudio: boolean;
  /** 谱面文件名（.osu 路径） */
  beatmapFile: string;
  /** 谱面集内全部可用难度名（Version） */
  difficulties: string[];
  /** 当前装载难度在 difficulties 中的下标 */
  difficultyIndex: number;
}

export type VolumeChannel = "music" | "effects";

export type ToPreview =
  | { type: "hs:load"; name: string; bytes: ArrayBuffer }
  | { type: "hs:update"; name: string; bytes: ArrayBuffer }
  | { type: "hs:control"; action: "play" | "pause" | "seek" | "stats"; value?: number }
  | { type: "hs:control"; action: "volume"; channel: VolumeChannel; value: number }
  | { type: "hs:control"; action: "difficulty"; value: number };

export type ToParent =
  | { type: "cad:ready" }
  | { type: "cad:loaded"; meta: PreviewMeta }
  | { type: "cad:time"; time: number; duration: number; playing: boolean }
  | { type: "cad:stats"; lookups: number; hits: number }
  | { type: "cad:error"; message: string };

export function postToParent(message: ToParent)
{
  window.parent.postMessage(message, "*");
}

export function isToPreview(message: unknown): message is ToPreview
{
  if (typeof message !== "object" || message === null)
    return false;

  const type = (message as { type?: unknown }).type;

  return type === "hs:load" || type === "hs:update" || type === "hs:control";
}
