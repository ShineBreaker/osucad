# hitsound-preview 播放性能基准

测量环境：headless Chromium 151（SwiftShader 不可用 → renderer 置空桩，**测的是 CPU 侧 update/音频/GC 压力，不含 GPU 渲染耗时**）；fixture = `apps/hitsound-preview/src/assets/bench/test.osu`（309 物件 / 96s）+ 110s 合成 WAV。

## 复跑方式

```bash
cd apps/hitsound-preview && pnpm dev          # :4201
# 需要有 WebGL 的浏览器跑完整路径；headless 下 bench/bench.ts 会自动换空 renderer
node bench/run.mjs                            # 输出 JSON 到 stdout
# 或浏览器打开 http://localhost:4201/bench.html，完成后读 window.__benchResult
```

指标：`update` = `GameHost.update()` 墙钟（含 updateSubTree + transforms + audio），`frames` = rAF 间隔，`heap*` = `performance.memory.usedJSHeapSize`。

## 基线（优化前，commit 4437327）

| 阶段 | update p50 | update p95 | update p99 | update max | 帧间隔 >20ms | heap 区间 |
|---|---|---|---|---|---|---|
| load（309 物件 + 音轨解码） | — | — | — | 579ms 一次性 | — | +4.4MB |
| playback 15s | 0.30ms | 0.80ms | 1.40ms | 4.0ms | 1 | 96.8→54.4MB（GC 锯齿 ~10MB/s）|
| afterSeek 8s | 0.30ms | 0.80ms | 1.40ms | 2.0ms | 0 | 61.0→51.6MB |
| hs:update 热更新 | — | — | — | 22.6ms 一次性 | — | — |
| afterHotUpdate 8s | 0.40ms | 0.90ms | 1.40ms | 11.0ms | 0 | 65.1→52.4MB |

采样命中 325/325。

## 判读

- **帧循环本身不重**（update p99 ~1.4ms）：卡顿不来自每帧 CPU 耗时均值。
- **GC 锯齿是主卡顿源**：稳态分配 → V8 GC 数十 ms 级停顿周期性出现。优化前 ~10MB/s（锯齿跨度 ~40MB），优化后锯齿跨度 ~15MB，分配速率明显下降。
- **hs:update 热更新**：优化前单帧 ~23ms（全量解压 + 全量重解析 + 重建皮肤链）；优化后 **4.5ms（↓80%）**。
- **音频路径曾有致命缺陷**：换音轨后 `trackMixer` 对已断连 Track 二次 `disconnect()` 抛 `InvalidAccessError` 会杀死整个 run 循环（已修复为容错断开 + 正确 splice）。
- **hitsound 时序**：`source.start()` 无 `when` 参数 → ±1 帧量化抖动（已透传 AudioContext 调度时间）。

## 已修复清单（按批次归并）

1. `Drawable.updateDrawNodeTransform` 每次调用 5–6 个 Vec2 分配 → 标量展开零分配；`position` setter 同帧二次计算删除。

2. Scheduler/LifetimeEntryManager/InputManager/LifetimeManagementContainer/GameHost 每帧小分配与 O(n) 移位 → 游标/复用数组/单遍压缩。
3. `AudioDestination.disconnect` 缺 splice 泄漏 + 修剪二次断连崩溃 → 容错断开 + splice；`AudioBufferTrack.stop` 悬挂节点摘除 + rate setter 死分支删除；hitsound `source.start(when)` 全链路透传 AudioContext 调度时间。
4. `CalculatedPath` 线性扫描 → 二分；`PathGeometryBuilder` 每顶点对象分配 → 标量数学 + 双缓冲复用；CursorTrail 无池化 → freelist（cap 128）；DrawablePool（Slider 20→64，Tick/Repeat 100→512）；`SpinnerRotationTracker.dispose` addListener→removeListener 泄漏修复。
5. `hs:update` 全量重做 → lazy zip 解压 + 皮肤/谱面解析指纹缓存（音频指纹替代常驻字节 + 全量比）。
6. 每物件每采样重建 `PoolableSkinnableSample` → 按 `ISampleInfo.equals` 增量复用；非 looping `SampleChannel` 免 Bindable 绑定。
