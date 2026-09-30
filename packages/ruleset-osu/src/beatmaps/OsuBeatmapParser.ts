import type { Beatmap, HitObject, RulesetBeatmapParser, SampleAdditions } from "@osucad/core";
import { HitSoundInfo, HitType, SampleSet } from "@osucad/core";
import { Vec2 } from "@osucad/framework";
import { HitCircle } from "../hitObjects/HitCircle";
import { PathPoint, PathType } from "../hitObjects/PathPoint";
import { Slider } from "../hitObjects/Slider";
import { Spinner } from "../hitObjects/Spinner";

export class OsuBeatmapParser implements RulesetBeatmapParser
{
  parseHitObject(line: string, beatmap: Beatmap): HitObject | null
  {
    const values = line.split(",");
    if (values.length < 4)
      return null;

    const x = Number.parseInt(values[0]);
    const y = Number.parseInt(values[1]);
    const startTime = Number.parseFloat(values[2]);
    const type = Number.parseInt(values[3]);
    const newCombo = !!(type & HitType.NewCombo);
    const comboOffset = (type & HitType.ComboOffset) >> 4;

    const additions: SampleAdditions = Number.parseInt(values[4]);

    if (type & HitType.Normal)
    {
      return new HitCircle({
        startTime,
        position: { x, y },
        newCombo,
        comboOffset,
        hitSound: parseHitSound(values[5] ?? "", additions),
      });
    }

    if (type & HitType.Slider)
    {
      // lazer：repeatCount = max(0, n-1) → span ≥ 1（非法值容忍为单程）
      const spanCount = Math.max(1, Number.parseInt(values[6]) || 0);

      // hitSample 列在 sliders 上是 values[10]（values[5] 是曲线规格串）；
      // banksOnly：滑条对象级 hitSample 只取 bank 两列，index/volume/文件名按 lazer 忽略
      const hitSound = parseHitSound(values[10] ?? "", additions, true);

      return new Slider({
        startTime,
        position: { x, y },
        newCombo,
        comboOffset,
        controlPoints: parseControlPoints(Vec2.from({ x, y }), values[5]),
        repeatCount: spanCount - 1,
        expectedDistance: Number.parseFloat(values[7]),
        hitSound,
        nodeSamples: parseSliderNodeSamples(hitSound, values[8], values[9], spanCount),
      });
    }

    if (type & HitType.Spinner)
    {
      const duration = Number.parseFloat(values[5]) - startTime;

      return new Spinner({
        startTime,
        position: { x, y }, // TODO: is this actually needed?
        newCombo,
        comboOffset,
        duration,
        hitSound: parseHitSound(values[6] ?? "", additions),
      });
    }

    return null;
  }
}

function parseControlPoints(basePosition: Vec2, pathString: string): PathPoint[]
{
  const [pathTypeLetter, ...pathPoints] = pathString.split("|");

  const pathType = parsePathType(pathTypeLetter);

  const path: PathPoint[] = [
    new PathPoint(Vec2.zero(), pathType),
  ];

  for (const p of pathPoints)
  {
    const [x, y] = p.split(":").map(it => Number.parseFloat(it));
    const position = new Vec2(x, y).sub(basePosition);

    const lastPoint = path[path.length - 1];

    if (position.equals(lastPoint.position))
    {
      path.pop();
      path.push(new PathPoint(position, PathType.Bezier));
      continue;
    }

    path.push(new PathPoint(position));
  }

  return path;
}

function parsePathType(pathTypeLetter: string)
{
  switch (pathTypeLetter)
  {
  case "B":
    return PathType.Bezier;
  case "C":
    return PathType.Catmull;
  case "L":
    return PathType.Linear;
  case "P":
    return PathType.PerfectCurve;
  default:
    throw new Error(`Unknown path type: ${pathTypeLetter}`);
  }
}

/** hitSample 五列：bank:addBank:index:volume:filename（对应 lazer SampleBankInfo） */
interface SampleBankInfo
{
  sampleSet: SampleSet
  additionSampleSet: SampleSet
  customIndex: number
  volume: number
  filename: string
}

/** bank 列：越界值回落 Normal（lazer `!Enum.IsDefined → Normal`）；None(0) 表示未指定继承控制点 */
function parseSampleBank(raw: string | undefined): SampleSet
{
  const parsed = Number.parseInt(raw ?? "");
  if (Number.isNaN(parsed))
    return SampleSet.None;
  return (parsed in SampleSet ? parsed : SampleSet.Normal) as SampleSet;
}

function readCustomSampleBanks(str: string, bankInfo: SampleBankInfo, banksOnly = false)
{
  if (str.length === 0)
    return;

  const split = str.split(":");

  // None 会整体覆盖克隆值——edgeSet 写 `0` 表示回落控制点而不是继承物件 bank
  bankInfo.sampleSet = parseSampleBank(split[0]);
  bankInfo.additionSampleSet = parseSampleBank(split[1]);

  if (banksOnly)
    return;

  if (split.length > 2)
  {
    const index = Number.parseInt(split[2]);
    bankInfo.customIndex = Number.isNaN(index) ? 0 : index;
  }

  if (split.length > 3)
  {
    const volume = Number.parseInt(split[3]);
    bankInfo.volume = Number.isNaN(volume) ? 0 : Math.max(0, volume);
  }

  if (split.length > 4)
    bankInfo.filename = split[4];
}

function bankInfoOf(hitSound: HitSoundInfo): SampleBankInfo
{
  return {
    sampleSet: hitSound.sampleSet,
    additionSampleSet: hitSound.additionSampleSet,
    customIndex: hitSound.customIndex,
    volume: hitSound.volume,
    filename: hitSound.filename,
  };
}

function toHitSoundInfo(bankInfo: SampleBankInfo, additions: SampleAdditions): HitSoundInfo
{
  return new HitSoundInfo(bankInfo.sampleSet, bankInfo.additionSampleSet, additions, bankInfo.customIndex, bankInfo.volume, bankInfo.filename);
}

function parseHitSound(str: string, additions: SampleAdditions, banksOnly = false): HitSoundInfo
{
  const bankInfo: SampleBankInfo = {
    sampleSet: SampleSet.None,
    additionSampleSet: SampleSet.None,
    customIndex: 0,
    volume: 0,
    filename: "",
  };

  readCustomSampleBanks(str, bankInfo, banksOnly);

  return toHitSoundInfo(bankInfo, additions);
}

function parseSliderNodeSamples(hitSound: HitSoundInfo, edgeSoundsString: string | undefined, edgeSetsString: string | undefined, spanCount: number): HitSoundInfo[]
{
  const samples: HitSoundInfo[] = [];

  const edgeSounds = edgeSoundsString?.split("|") ?? [];
  const edgeSets = edgeSetsString?.split("|") ?? [];

  for (let i = 0; i <= spanCount; i++)
  {
    // lazer：节点 bankInfo 克隆自对象，edgeSets[i] 存在则整体重读（含 index/volume/文件名）
    const bankInfo = bankInfoOf(hitSound);
    if (i < edgeSets.length)
      readCustomSampleBanks(edgeSets[i], bankInfo);

    const additions = i < edgeSounds.length
        ? (Number.parseInt(edgeSounds[i]) || 0) as SampleAdditions
        : hitSound.additions;

    samples.push(toHitSoundInfo(bankInfo, additions));
  }

  return samples;
}
