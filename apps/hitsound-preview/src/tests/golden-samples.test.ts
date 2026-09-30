// lazer 语义差分测试：独立复刻 LegacyBeatmapDecoder + ConvertHitObjectParser 的采样管线
// （timing 点分组 / hitSample 五列 / banksOnly / 逐节点 edgeSets·edgeSounds / 组下标 ≥2 后缀），
// 与真实 BeatmapParser + OsuBeatmapParser 解析出的 object.samples 逐物件比对。
// 谱面：~/Projects/osu 下两张富音效组 .osz（OSZ_DIR 环境变量可覆盖）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BeatmapParser, beatmapSampleLookups, FileHitSampleInfo, HitSampleInfo, rulesets, skinSampleLookups, type Ruleset } from "@osucad/core";
import { OsuBeatmapParser } from "../../../../packages/ruleset-osu/src/beatmaps/OsuBeatmapParser";
import { Slider } from "../../../../packages/ruleset-osu/src/hitObjects/Slider";
import { SliderTick } from "../../../../packages/ruleset-osu/src/hitObjects/SliderTick";
import { SliderRepeat } from "../../../../packages/ruleset-osu/src/hitObjects/SliderRepeat";
import { SliderHeadCircle } from "../../../../packages/ruleset-osu/src/hitObjects/SliderHeadCircle";
import { SliderTailCircle } from "../../../../packages/ruleset-osu/src/hitObjects/SliderTailCircle";
import { Spinner } from "../../../../packages/ruleset-osu/src/hitObjects/Spinner";

// ---------- 参考实现（与 lazer 源码逐行对齐的独立复刻） ----------

const BANKS = ["normal", "normal", "soft", "drum"] as const;
const LENIENCY = 5;

interface RefBankInfo
{
  sampleSet: number // 0 = None 未指定 → 继承控制点
  addSet: number
  index: number
  volume: number
  filename: string
}

/** lazer `readCustomSampleBanks` 的 bank 列：越界 → Normal(1)；0/缺 → None(0) */
function parseBank(raw: string | undefined): number
{
  const n = Number.parseInt(raw ?? "");
  if (Number.isNaN(n))
    return 0;
  return n >= 0 && n <= 3 ? n : 1;
}

function readBanks(str: string, info: RefBankInfo, banksOnly = false)
{
  if (!str.length)
    return;
  const split = str.split(":");
  info.sampleSet = parseBank(split[0]);
  info.addSet = parseBank(split[1]);
  if (banksOnly)
    return;
  if (split.length > 2)
  {
    const v = Number.parseInt(split[2]);
    info.index = Number.isNaN(v) ? 0 : v;
  }
  if (split.length > 3)
  {
    const v = Number.parseInt(split[3]);
    info.volume = Number.isNaN(v) ? 0 : Math.max(0, v);
  }
  if (split.length > 4)
    info.filename = split[4];
}

interface RefTiming { bank: number, index: number, volume: number }

interface RefObj
{
  kind: "circle" | "slider" | "spinner"
  startTime: number
  additions: number
  bank: RefBankInfo
  nodes?: RefBankInfo[] // slider：nodeCount = repeatCount+2，含头尾
  nodeAdditions?: number[]
}

interface RefMap
{
  generalBank: number
  generalVolume: number
  timing: { time: number, data: RefTiming }[] // 文件顺序
  objects: RefObj[]
}

function refParse(text: string): RefMap
{
  const map: RefMap = { generalBank: 0, generalVolume: 100, timing: [], objects: [] };
  let section = "";

  for (const raw of text.split(/\r?\n/))
  {
    const line = raw.trim();
    if (!line)
      continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m)
    {
      section = m[1];
      continue;
    }

    if (section === "General")
    {
      const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!kv)
        continue;
      if (kv[1] === "SampleSet")
        map.generalBank = { none: 0, normal: 1, soft: 2, drum: 3 }[kv[2].trim().toLowerCase()] ?? (Number.parseInt(kv[2]) || 0);
      else if (kv[1] === "SampleVolume")
      {
        const v = Number.parseInt(kv[2]);
        if (!Number.isNaN(v))
          map.generalVolume = v;
      }
      continue;
    }

    if (section === "TimingPoints")
    {
      const v = line.split(",");
      if (v.length < 2)
        continue;
      const time = Number.parseFloat(v[0]);
      const beatLength = Number.parseFloat(v[1]);
      const uninherited = v.length < 7 || v[6].trim() === "" || v[6].trimStart()[0] === "1";
      if (uninherited && Number.isNaN(beatLength))
        continue;

      // lazer：col3 缺失才回落 [General] SampleSet；写 "0"(none) 归一化为 normal（查询侧 `cp.bank || 1`）
      const rawBank = Number.parseInt(v[3]);
      const bank = v.length >= 4 ? (Number.isNaN(rawBank) ? map.generalBank : rawBank) : map.generalBank;
      const index = v.length >= 5 ? (Number.parseInt(v[4]) || 0) : 0;
      let volume = map.generalVolume;
      if (v.length >= 6)
      {
        const vv = Number.parseInt(v[5]);
        volume = Number.isNaN(vv) ? map.generalVolume : Math.min(100, Math.max(0, vv));
      }
      map.timing.push({ time, data: { bank, index, volume } });
      continue;
    }

    if (section === "HitObjects")
    {
      const v = line.split(",");
      if (v.length < 4)
        continue;
      const startTime = Number.parseFloat(v[2]);
      const type = Number.parseInt(v[3]);
      const additions = Number.parseInt(v[4]) || 0;
      const bank: RefBankInfo = { sampleSet: 0, addSet: 0, index: 0, volume: 0, filename: "" };

      if (type & 1)
      {
        if (v.length > 5)
          readBanks(v[5] ?? "", bank);
        map.objects.push({ kind: "circle", startTime, additions, bank });
      }
      else if (type & 2)
      {
        const repeatCount = Math.max(0, (Number.parseInt(v[6]) || 0) - 1);
        const nodeCount = repeatCount + 2;
        if (v.length > 10)
          readBanks(v[10] ?? "", bank, true);

        const nodes: RefBankInfo[] = Array.from({ length: nodeCount }, () => ({ ...bank }));
        const sets = v[9] ? v[9].split("|") : [];
        for (let i = 0; i < Math.min(nodeCount, sets.length); i++)
          readBanks(sets[i], nodes[i]);

        const nodeAdditions = Array.from({ length: nodeCount }, () => additions);
        const sounds = v[8] ? v[8].split("|") : [];
        for (let i = 0; i < Math.min(nodeCount, sounds.length); i++)
          nodeAdditions[i] = Number.parseInt(sounds[i]) || 0;

        map.objects.push({ kind: "slider", startTime, additions, bank, nodes, nodeAdditions });
      }
      else if (type & 8)
      {
        if (v.length > 6)
          readBanks(v[6] ?? "", bank);
        map.objects.push({ kind: "spinner", startTime, additions, bank });
      }
    }
  }

  return map;
}

/** lazer `SamplePointAt`：同刻组内最后写入行胜出；早于所有点回落首组的胜出者 */
function refSampleAt(map: RefMap, time: number): RefTiming
{
  const lines = map.timing;
  const pick = (t: number): RefTiming | undefined =>
  {
    let last: RefTiming | undefined;
    for (const l of lines)
    {
      if (l.time === t)
        last = l.data;
    }
    return last;
  };

  if (!lines.length)
    return { bank: 1, index: 0, volume: 100 };

  let groupTime = -Infinity;
  for (const l of lines)
  {
    if (l.time <= time && l.time > groupTime)
      groupTime = l.time;
  }
  if (groupTime === -Infinity)
    groupTime = lines[0].time;

  return pick(groupTime) ?? { bank: 1, index: 0, volume: 100 };
}

/** lazer `convertSoundType` + `ApplyTo` 后的期望 lookupNames 首名 + 音量 + 包内查询资格 */
function refNames(map: RefMap, bank: RefBankInfo, additions: number, pointTime: number): { name: string, volume: number, ubs: boolean }[]
{
  const cp = refSampleAt(map, pointTime);
  const sampleSet = bank.sampleSet !== 0 ? bank.sampleSet : (cp.bank || 1);
  const addSet = bank.addSet !== 0 ? bank.addSet : sampleSet;
  const index = bank.index > 0 ? bank.index : cp.index;
  const suffix = index >= 2 ? String(index) : "";
  const volume = bank.volume > 0 ? bank.volume : cp.volume;
  // lazer `useBeatmapSamples: customSampleBank >= 1`（FileHitSampleInfo 强制 csb=1）
  const ubs = index >= 1;

  const out: { name: string, volume: number, ubs: boolean }[] = [];
  if (bank.filename)
    out.push({ name: bank.filename, volume, ubs: true }); // FileHitSampleInfo lookupNames[0] = 文件名原样
  else
    out.push({ name: `${BANKS[sampleSet]}-hitnormal${suffix}`, volume, ubs });

  for (const [name, bit] of [["hitwhistle", 2], ["hitfinish", 4], ["hitclap", 8]] as const)
  {
    if (additions & bit)
      out.push({ name: `${BANKS[addSet]}-${name}${suffix}`, volume, ubs });
  }
  return out;
}

function actualNames(samples: HitSampleInfo[]): { name: string, volume: number, ubs: boolean }[]
{
  return samples.map(s => ({ name: s.lookupNames[0], volume: s.volume, ubs: s.useBeatmapSamples }));
}

function fmt(list: { name: string, volume: number, ubs?: boolean }[]): string
{
  return list.map(s => `${s.name}@${s.volume}${s.ubs ? "+b" : ""}`).join(", ");
}

// ---------- 测试 ----------

const OSZ_DIR = process.env.OSZ_DIR ?? `${process.env.HOME}/Projects/osu`;
const OSZ_FILES = [
  "2612783 Street - reimei.osz",
  "2623975 Cansol - Curtain Call.osz",
];

rulesets.register({
  id: "osu",
  title: "osu!",
  legacyId: 0,
  createBeatmapParser: () => new OsuBeatmapParser(),
  createDrawableRuleset: () => { throw new Error("not available in tests"); },
} as unknown as Ruleset);

function extractOsu(oszPath: string): string[]
{
  const dir = mkdtempSync(join(tmpdir(), "golden-osu-"));
  execFileSync("unzip", ["-o", "-j", oszPath, "*.osu", "-d", dir], { stdio: "pipe" });
  return readdirSync(dir).filter(f => f.endsWith(".osu")).map(f => join(dir, f));
}

describe("绿线/红线采样解析 vs lazer 参考实现", () =>
{
  for (const osz of OSZ_FILES)
  {
    const oszPath = join(OSZ_DIR, osz);
    if (!existsSync(oszPath))
      continue;

    for (const osuPath of extractOsu(oszPath))
    {
      it(`${osz} / ${osuPath.split("/").pop()}`, async () =>
      {
        const text = readFileSync(osuPath, "utf8");
        const ref = refParse(text);
        const beatmap = await new BeatmapParser().parse(text);

        const diffs: string[] = [];
        const refPool = new Map<string, RefObj[]>();
        for (const o of ref.objects)
        {
          const k = `${o.kind}@${o.startTime}`;
          const arr = refPool.get(k) ?? [];
          arr.push(o);
          refPool.set(k, arr);
        }

        let checked = 0;

        for (const obj of beatmap.hitObjects)
        {
          const kind = obj instanceof Slider ? "slider" : obj instanceof Spinner ? "spinner" : "circle";
          const refObj = (refPool.get(`${kind}@${obj.startTime}`) ?? []).shift();
          if (!refObj)
          {
            diffs.push(`${kind}@${obj.startTime}: 参考实现中找不到对应物件`);
            continue;
          }

          if (obj instanceof Slider)
          {
            // 对象级：hitnormal→sliderslide、hitwhistle→sliderwhistle（startTime + 6）
            const refObject = refNames(ref, refObj.bank, refObj.additions, obj.startTime + LENIENCY + 1);
            const expectedSlider = refObject
              .filter(s => /hitnormal|hitwhistle/.test(s.name))
              .map(s => ({
                name: s.name.replace("hitnormal", "sliderslide").replace("hitwhistle", "sliderwhistle"),
                volume: s.volume,
                ubs: s.ubs,
              }));
            if (fmt(actualNames(obj.samples)) !== fmt(expectedSlider))
              diffs.push(`slider-obj@${obj.startTime}\n  期望: ${fmt(expectedSlider)}\n  实际: ${fmt(actualNames(obj.samples))}`);
            checked++;

            // 节点级：nested 对象（头/折返/尾）各自的 samples
            const spanCount = obj.spanCount();
            const nodeDur = obj.duration / spanCount;
            for (let i = 0; i <= spanCount; i++)
            {
              const nodeTime = obj.startTime + i * nodeDur + LENIENCY;
              const expected = refNames(ref, refObj.nodes![i], refObj.nodeAdditions![i], nodeTime);

              const nested = obj.nestedHitObjects.find(n =>
                (i === 0 && n instanceof SliderHeadCircle)
                || (i === spanCount && n instanceof SliderTailCircle && !(n instanceof SliderRepeat))
                || (i > 0 && i < spanCount && n instanceof SliderRepeat && n.repeatIndex === i - 1));

              if (!nested)
              {
                diffs.push(`slider-node${i}@${obj.startTime}: nested 对象缺失`);
                continue;
              }
              if (fmt(actualNames(nested.samples)) !== fmt(expected))
                diffs.push(`slider-node${i}@${obj.startTime}\n  期望: ${fmt(expected)}\n  实际: ${fmt(actualNames(nested.samples))}`);
              checked++;
            }

            // tick：对象级 hitnormal 改名 slidertick
            const tickExpected = expectedSlider.length
              ? [{ ...expectedSlider[0], name: expectedSlider[0].name.replace("sliderslide", "slidertick") }]
              : [];
            for (const n of obj.nestedHitObjects)
            {
              if (!(n instanceof SliderTick))
                continue;
              if (fmt(actualNames(n.samples)) !== fmt(tickExpected))
                diffs.push(`tick@${n.startTime.toFixed(1)}\n  期望: ${fmt(tickExpected)}\n  实际: ${fmt(actualNames(n.samples))}`);
              checked++;
            }
          }
          else
          {
            // circle/spinner：endTime + 5（circle endTime=startTime）
            const expected = refNames(ref, refObj.bank, refObj.additions, obj.endTime + LENIENCY);
            if (fmt(actualNames(obj.samples)) !== fmt(expected))
              diffs.push(`${kind}@${obj.startTime}\n  期望: ${fmt(expected)}\n  实际: ${fmt(actualNames(obj.samples))}`);
            checked++;
          }
        }

        expect(diffs, `${diffs.length} 处不一致\n${diffs.slice(0, 15).join("\n")}`).toEqual([]);
        expect(checked).toBeGreaterThan(30);
      });
    }
  }
});

// ---------- 分层皮肤查询（lazer UseBeatmapSamples + UseCustomSampleBanks） ----------

describe("谱面/皮肤分层采样查询", () =>
{
  const mk = (index: number) =>
    new HitSampleInfo(
      HitSampleInfo.HIT_NORMAL,
      HitSampleInfo.BANK_NORMAL,
      index >= 2 ? String(index) : undefined,
      100,
      true,
      index >= 1,
    );

  it("下标 0：谱面层整体跳过，只走皮肤裸名", () =>
  {
    expect(beatmapSampleLookups(mk(0))).toEqual([]);
    expect(skinSampleLookups(mk(0))).toEqual(["normal-hitnormal", "hitnormal"]);
  });

  it("下标 1（无后缀）：谱面查裸名，不读 `…1` 文件名", () =>
  {
    const s = mk(1);
    expect(beatmapSampleLookups(s)).toEqual(["normal-hitnormal", "hitnormal"]);
    expect(s.lookupNames.every(n => !n.endsWith("1"))).toBe(true);
  });

  it("下标 ≥2：谱面层只查带后缀名 + 通用名；皮肤层剥后缀", () =>
  {
    const s = mk(3);
    expect(beatmapSampleLookups(s)).toEqual(["normal-hitnormal3", "hitnormal"]);
    expect(skinSampleLookups(s)).toEqual(["normal-hitnormal", "hitnormal"]);
  });

  it("显式文件名：恒可查谱面层，先文件名再去扩展名再回落", () =>
  {
    const s = new FileHitSampleInfo("custom.wav", 80);
    expect(beatmapSampleLookups(s)).toEqual(["custom.wav", "custom", "normal-hitnormal", "hitnormal"]);
    expect(skinSampleLookups(s)).toEqual(["custom.wav", "custom", "normal-hitnormal", "hitnormal"]);
  });
});
