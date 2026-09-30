// 生成大 fixture：node bench/gen-big-osu.mjs → src/assets/bench/big.osu
// 规模：1900 物件（滑条 ~55%，含周期性长滑条），BPM 220、1/4 分音，
// 时长约 130s（配套音频 bench.ts 里 sineWav(140)）。
// 圆/滑条交替 + 每 100 个一个 1 拍长滑条；每 8 个物件加一次 finish addition，
// 抬高采样调度量；坐标绕 (256,192) 双正弦游走，保持屏幕内。

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 1900;
const BPM = 220;
const BEAT = 60000 / BPM; // 272.73ms
const STEP = BEAT / 4; // 1/4 分音 ≈ 68.18ms
const T0 = 1000;

const lines = [
  "osu file format v14",
  "",
  "[General]",
  "AudioFilename: audio.mp3",
  "AudioLeadIn: 0",
  "PreviewTime: 1000",
  "Countdown: 0",
  "SampleSet: Soft",
  "StackLeniency: 0.7",
  "Mode: 0",
  "LetterboxInBreaks: 0",
  "WidescreenStoryboard: 0",
  "",
  "[Metadata]",
  "Title:BenchBig",
  "TitleUnicode:BenchBig",
  "Artist:bench",
  "ArtistUnicode:bench",
  "Creator:gen-big-osu",
  "Version:big",
  "Source:",
  "Tags:",
  "BeatmapID:0",
  "BeatmapSetID:-1",
  "",
  "[Difficulty]",
  "HPDrainRate:5",
  "CircleSize:4",
  "OverallDifficulty:8",
  "ApproachRate:9",
  "SliderMultiplier:1.4",
  "SliderTickRate:1",
  "",
  "[TimingPoints]",
  `0,${BEAT},4,1,0,80,1,0`,
  "",
  "[Colours]",
  "Combo1 : 255,80,140",
  "Combo2 : 120,200,255",
  "Combo3 : 255,220,120",
  "",
  "[HitObjects]",
];

let sliders = 0;
for (let i = 0; i < N; i++)
{
  const t = T0 + i * STEP;
  const ang = i * 0.21;
  const x = Math.round(256 + 180 * Math.sin(ang));
  const y = Math.round(192 + 120 * Math.cos(ang * 1.37));
  const hitSound = i % 8 === 0 ? 2 : i % 8 === 4 ? 8 : 0; // finish/whistle 交替
  const hs = `${hitSound}`;
  const isLongSlider = i % 100 === 99; // 周期性 1 拍长滑条
  const isSlider = isLongSlider || i % 2 === 1 || i % 10 === 0;

  if (isSlider)
  {
    sliders++;
    // 短滑条 pixelLength 取 1/8 拍（50/SliderMultiplier/100 像素≈时长 34ms），
    // 长滑条 1 拍（100×1.4×100 像素）
    const px = isLongSlider ? 140 : 7;
    const x2 = Math.max(0, Math.min(511, x + 40));
    const y2 = Math.max(0, Math.min(383, y + 24));
    lines.push(`${x},${y},${Math.round(t)},2,${hs},B|${x2}:${y2},1,${px},0:0:0:0:`);
  }
  else
  {
    lines.push(`${x},${y},${Math.round(t)},1,${hs},0:0:0:0:`);
  }
}

const out = lines.join("\n") + "\n";
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "bench", "big.osu");
writeFileSync(dest, out);
console.log(`big.osu: ${N} 物件（滑条 ${sliders}，${(sliders / N * 100).toFixed(1)}%），时长跨度 ${((T0 + N * STEP) / 1000).toFixed(1)}s，${out.length} bytes`);
