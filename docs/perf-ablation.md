# 播放性能优化消融实验

对象：`193c1da` 的 6 类优化。方法：逐个关闭单类（其余保持开启）+ 全开基线，共 7 配置（另加 `no12` 联合关闭供参考，不计入 6 类矩阵），每配置 bench 3 次取中位 + framework 16 项 / golden-samples 6 项回归。

环境：headless Chromium（renderer 置空桩，测 CPU 侧 update/音频/GC，不含 GPU 渲染）；fixture 309 物件 + 110s 合成 WAV；同一 dev server（:4201），run.mjs 逐次拉起干净 headless 进程（`--enable-precise-memory-info --mute-audio`）。原始 JSON：`/tmp/ablation/runs/<cfg>_<1..3>.json`（本机路径，未入库）。

开关方式：`git checkout 193c1da^ -- <文件>` 回退整文件；共享文件（SampleChannel、PoolableSkinnableSample）按 hunk 归属手工保留对方类别改动。每次测量后恢复，实验结束工作区与 HEAD 一致。

## 配置定义

| 配置 | 关闭内容 | 开关手段 |
|---|---|---|
| base（全开） | 无 | HEAD 原样 |
| no1 | 类1 Drawable transform 标量展开 + position setter | 回退 `Drawable.ts` |
| no2 | 类2 Scheduler/事件队列/hover/GameHost 游标化复用 | 回退 Scheduler、LifetimeEntryManager、InputManager、TargetGroupingTransformTracker、TransformBindable、LifetimeManagementContainer、GameHost、platform/index + 恢复 transformQueue.ts |
| no3 | 类3 音频：AudioDestination 容错+splice、Track 摘源、start(when) | 回退 AudioBufferTrack、AudioDestination、Sample、DrawableSample、DrawableHitObject；SampleChannel 仅恢复 `start()` 无参（保留免绑定） |
| no4 | 类4 滑条/游玩：CalculatedPath 二分、PathGeometryBuilder 复用、CursorTrail freelist、池扩容、Spinner 泄漏修、aliveObjects 零拷贝 | 回退 OsuAutoPlayController、CalculatedPath、OsuHitObject、Slider、DrawableSlider、DrawableSliderBall、SliderInputManager、SpinnerRotationTracker、CursorTrail、OsuPlayfield、Path、PathGeometryBuilder、HitObjectContainer、AutoPlayController |
| no5 | 类5 hs:update lazy zip + 皮肤/谱面指纹缓存 | 回退 PreviewGame、ZipArchiveFileSystem |
| no6 | 类6 PoolableSkinnableSample 增量复用（+sampleInfo getter） | 回退 SkinnableSound、PoolableSkinnableSample |
| no12（参考） | 类1+类2 联合关闭 | 回退 no1∪no2 文件集 |

## 消融矩阵（3 次中位）

指标列：`updateMs` = hs:update 热更新一次性耗时；`pb.*` = playback 15s 相 update 分布；`gap>20` = 帧间隔超 20ms 计数/总帧；`锯齿` = 全程 heapSamples 极差（GC 压力代理）；`heapEnd` = 结束时堆；`命中` = 采样 hits/lookups（各 run）；回归 = framework/app 测试。

| 配置 | updateMs | pb p50 | pb p99 | pb max | gap>20 | 锯齿 | heapEnd | 命中 | 回归 |
|---|---|---|---|---|---|---|---|---|---|
| base 全开 | 3.8 | 0.60 | 3.30 | 8.10 | 1/876 | 24.7MB | 66.6MB | 309~310/309~310 | 16/16, 6/6 ✓ |
| no1 关 transform | 3.9 | 0.90 | 3.60 | 10.90 | 1/868 | 25.8MB | 67.8MB | 308~314/同 | 16/16, 6/6 ✓ |
| no2 关游标复用 | 3.8 | 0.50 | 2.60 | 7.50 | 1/879 | 25.1MB | 67.2MB | 307~316/同 | 16/16, 6/6 ✓ |
| no3 关音频修复 | 3.8 | 0.50 | 2.80 | 6.30 | 1/880 | 25.1MB | 67.1MB | 307~309/同 | 16/16, 6/6 ✓ |
| no4 关滑条游玩 | 3.9 | 0.60 | 2.40 | 10.20 | 1/880 | 24.8MB | 60.1MB | 309~313/同 | 16/16, 6/6 ✓ |
| no5 关指纹缓存 | **20.8** | 0.60 | 2.50 | 6.70 | 1/881 | **17.9MB** | **49.9MB** | 320~324/同 | 16/16, 6/6 ✓ |
| no6 关样本复用 | 3.8 | 0.50 | 2.20 | 6.20 | 1/880 | 25.2MB | 67.2MB | 309~313/同 | 16/16, 6/6 ✓ |
| no12 关类1+2（参考） | 4.5 | 0.80 | 2.80 | 8.00 | 1/880 | 25.6MB | 55.9MB | 308~309/同 | 16/16, 6/6 ✓ |

（注：afterSeek / afterHotUpdate 稳态相各配置 p99/max 均在 2~4ms / 2~8ms 区间内波动，无配置呈现系统性偏离，略去分列，原始数据见 runs 目录 JSON。）

## 判读

- **类5 是唯一主效应**：关闭后 `updateMs` 3.8→20.8ms（≈5.5×），即指纹缓存贡献了热更新路径约 17ms 消除量。其余五类在任一指标上均无超出 run 间噪声的系统性差异。
- **类5 的代价可见**：关闭类5 后 heapEnd 反而更低（49.9 vs 66.6MB）、锯齿更小（17.9 vs 24.7MB）——缓存（皮肤链、解析结果、池扩容）以常驻内存换热更新速度，与"压低所有情况内存"字面目标冲突，属明确权衡。
- **稳态帧分布对 6 类均不敏感**：pb p50 0.5~0.9ms、p99 2.2~3.6ms、max 6~11ms 的差异与 run 间抖动同量级（base 自身 3 次 max 为 5.6/8.1/12.3ms）。即：本次 bench 测不到稳态卡顿改善，GC 锯齿跨度同样无显著变化（24.7 vs 25~26MB，no5 的 17.9MB 来自跳过皮肤重建链、路径不同）。
- **正确性类修复无性能信号但必须保留**：类3 的二次 disconnect 崩溃修复、SpinnerRotationTracker 泄漏修复属于正确性问题，bench 无卡顿场景覆盖不到是预期的，不构成回退理由。
- **结论**：性能收益几乎全部来自类5；类1/2/4/6 的逐帧零分配工作在本 fixture/空渲染桩下不可测——可能原因：(a) 真实瓶颈在 GPU 渲染侧（桩掉了）；(b) fixture 规模（309 物件）太小；(c) 优化本身量级被 GC/调度噪声淹没。建议后续在有 WebGL 环境 + 更大谱面下重测稳态侧，或直接以代码审查结论保留（零分配是单调不劣化）。
