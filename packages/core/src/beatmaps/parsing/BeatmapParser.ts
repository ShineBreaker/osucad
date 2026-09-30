import { Color } from "pixi.js";
import type { HitObject } from "../../rulesets/hitObjects/HitObject";
import type { RulesetStore } from "../../rulesets/RulesetStore";
import { rulesets } from "../../rulesets/RulesetStore";
import { nn } from "../../utils/nn";
import { Beatmap } from "../Beatmap";
import { LegacyTimingPoint } from "../timing/LegacyTimingPoint";
import { SampleSet } from "../../audio/SampleSet";

export interface BeatmapParserOptions
{
  rulesetStore?: RulesetStore
}

export interface RulesetBeatmapParser
{
  createBeatmap?(): Beatmap;

  parseHitObject(line: string, beatmap: Beatmap): HitObject | null;
}

enum BeatmapSection
{
  General = "General",
  Editor = "Editor",
  Metadata = "Metadata",
  Difficulty = "Difficulty",
  Events = "Events",
  TimingPoints = "TimingPoints",
  Colours = "Colours",
  HitObjects = "HitObjects",
}

export class BeatmapParser
{
  rulesetStore: RulesetStore;

  constructor(
    options: BeatmapParserOptions = {},
  )
  {
    this.rulesetStore = options.rulesetStore ?? rulesets;
  }

  async parse(content: string | string[])
  {
    const lines = typeof content === "string"
        ? content.split(/\r?\n/)
        : content;

    const fileVersion = parseVersionHeader(lines.shift() ?? "");
    console.debug(`Parsing beatmap from .osu content (Format version ${fileVersion})`);

    let currentSection: BeatmapSection | null = null;
    let rulesetParser: RulesetBeatmapParser | null = null;

    const beatmap = new Beatmap();

    const getRuleset = () =>
    {
      if (!beatmap.beatmapInfo.ruleset)
        throw new Error("No ruleset" /* TODO: better error message */);
      return beatmap.beatmapInfo.ruleset;
    };

    const getRulesetParser = async (): Promise<RulesetBeatmapParser> =>
    {
      return nn(
          await getRuleset().createBeatmapParser?.(),
          `Parsing not supported for "${getRuleset().title}" ruleset`,
      );
    };

    for (const line of lines)
    {
      const newSection = tryParseSectionHeader(line);
      if (newSection)
      {
        currentSection = newSection;
        continue;
      }

      switch (currentSection)
      {
      case BeatmapSection.General:
        parseGeneral(line, beatmap);
        break;
      case BeatmapSection.Metadata:
        parseMetadata(line, beatmap);
        break;
      case BeatmapSection.Difficulty:
        parseDifficulty(line, beatmap);
        break;
      case BeatmapSection.TimingPoints:
        parseTimingPoint(line, beatmap);
        break;
      case BeatmapSection.Colours:
        parseColors(line, beatmap);
        break;
      case BeatmapSection.HitObjects: {
        const hitObject = (rulesetParser ??= await getRulesetParser()).parseHitObject(line, beatmap);
        if (hitObject)
        {
          hitObject.applyDefaults(beatmap.difficulty, beatmap.timing);
          beatmap.hitObjects.push(hitObject);
        }
        break;
      }
      }
    }

    beatmap.hitObjects.sort((a, b) => a.startTime - b.startTime);

    const postProcessor = await getRuleset().createBeatmapPostProcessor?.();
    if (postProcessor)
      postProcessor.applyToBeatmap(beatmap);

    return beatmap;
  }
}

function parseGeneral(line: string, { beatmapInfo }: Beatmap)
{
  const [key, value] = parseKeyValue(line);

  if (!key || !value)
    return;

  switch (key)
  {
  case "AudioFilename":
    beatmapInfo.audioFile = value;
    break;
  case "AudioLeadIn":
    beatmapInfo.audioLeadIn = Number.parseInt(value);
    break;
  case "AudioHash":
    // TODO
    // beatmapInfo.audioHash = value;
    break;
  case "PreviewTime":
    beatmapInfo.previewTime = Number.parseInt(value);
    break;
  case "Countdown":
    beatmapInfo.countdownType = Number.parseInt(value);
    break;
  case "SampleSet":
    beatmapInfo.sampleSet = value;
    break;
  case "SampleVolume": {
    const volume = Number.parseInt(value);
    if (Number.isFinite(volume))
      beatmapInfo.sampleVolume = volume;
    break;
  }
  case "StackLeniency":
    beatmapInfo.stackLeniency = Number.parseFloat(value);
    break;
  case "Mode":
    beatmapInfo.ruleset = nn(
        rulesets.get({ legacyId: Number.parseInt(value) }),
        `No ruleset found for Mode: ${value} `,
    );
    break;
  case "LetterboxInBreaks":
    beatmapInfo.letterboxInBreaks = value === "1";
    break;
  case "UseSkinSprites":
    beatmapInfo.useSkinSprites = value === "1";
    break;
  case "AlwaysShowPlayfield":
    beatmapInfo.alwaysShowPlayfield = value === "1";
    break;
  case "OverlayPosition":
    beatmapInfo.overlayPosition = value;
    break;
  case "SkinPreference":
    beatmapInfo.skinPreference = value;
    break;
  case "EpilepsyWarning":
    beatmapInfo.epilepsyWarning = value === "1";
    break;
  case "CountdownOffset":
    beatmapInfo.countdownOffset = Number.parseInt(value);
    break;
  case "SpecialStyle":
    beatmapInfo.specialStyle = value === "1";
    break;
  case "WidescreenStoryboard":
    beatmapInfo.widescreenStoryboard = value === "1";
    break;
  case "SamplesMatchPlaybackRate":
    beatmapInfo.samplesMatchingPlaybackRate = value === "1";
    break;
  default:
    console.warn(`Unknown key ${key} in beatmap General section`);
    break;
  }
}

function parseMetadata(line: string, beatmap: Beatmap)
{
  const [key, value] = parseKeyValue(line);

  if (!key || !value)
    return;

  switch (key)
  {
  case "Title":
    beatmap.metadata.title = value;
    break;
  case "TitleUnicode":
    beatmap.metadata.titleUnicode = value;
    break;
  case "Artist":
    beatmap.metadata.artist = value;
    break;
  case "ArtistUnicode":
    beatmap.metadata.artistUnicode = value;
    break;
  case "Creator":
    beatmap.metadata.creator = value;
    break;
  case "Version":
    beatmap.metadata.difficultyName = value;
    break;
  case "Source":
    beatmap.metadata.source = value;
    break;
  case "Tags":
    beatmap.metadata.tags = value;
    break;
  case "BeatmapID":
    beatmap.beatmapInfo.onlineInfo.id = Number.parseInt(value);
    break;
  case "BeatmapSetID":
    beatmap.beatmapInfo.onlineInfo.beatmapSetId = Number.parseInt(value);
    break;
  }
}

function parseDifficulty(line: string, beatmap: Beatmap)
{
  const [key, value] = parseKeyValue(line);

  if (!key || !value)
    return;

  switch (key)
  {
  case "HPDrainRate":
    beatmap.difficulty.drainRate = Number.parseFloat(value);
    break;
  case "CircleSize":
    beatmap.difficulty.circleSize = Number.parseFloat(value);
    break;
  case "OverallDifficulty":
    beatmap.difficulty.overallDifficulty = Number.parseFloat(value);
    break;
  case "ApproachRate":
    beatmap.difficulty.approachRate = Number.parseFloat(value);
    break;
  case "SliderMultiplier":
    beatmap.difficulty.sliderMultiplier = Number.parseFloat(value);
    break;
  case "SliderTickRate":
    beatmap.difficulty.sliderTickRate = Number.parseFloat(value);
    break;
  }
}

function parseTimingPoint(line: string, beatmap: Beatmap)
{
  const values = line.split(",");
  if (values.length <= 1)
    return;

  const startTime = Number.parseFloat(values[0]);
  const beatLength = Number.parseFloat(values[1]);

  // lazer：第 7 列缺失（或空串）按红线处理
  const uninherited = values.length < 7 || values[6].trim() === "" || values[6].trimStart()[0] === "1";

  if (uninherited && Number.isNaN(beatLength))
    return; // lazer 丢弃 NaN beatLength 的红线

  const timingPoint = new LegacyTimingPoint();
  timingPoint.startTime = startTime;
  timingPoint.uninherited = uninherited;
  timingPoint.generateTicks = !Number.isNaN(beatLength);

  // 缺列回落：[General] SampleSet / SampleVolume，index 默认 0
  timingPoint.sampleSet = values.length >= 4 ? parseTimingSampleSet(values[3], beatmap) : defaultSampleSetOf(beatmap);

  if (values.length >= 5)
  {
    const index = Number.parseInt(values[4]);
    timingPoint.sampleIndex = Number.isNaN(index) ? 0 : index;
  }

  if (values.length >= 6)
  {
    const volume = Number.parseInt(values[5]);
    timingPoint.volume = Number.isNaN(volume) ? beatmap.beatmapInfo.sampleVolume : Math.min(100, Math.max(0, volume));
  }
  else
    timingPoint.volume = beatmap.beatmapInfo.sampleVolume;

  // SV 由该行自身的 beatLength 决定（红绿线都算）；正值与 NaN → 1
  const speedMultiplier = beatLength < 0 ? 100 / -beatLength : 1;
  timingPoint.sliderVelocity = speedMultiplier;

  if (uninherited)
  {
    const signature = Number.parseInt(values[2]);

    timingPoint.timingInfo = {
      beatLength,
      signature: Number.isNaN(signature) ? 4 : signature,
    };
  }

  beatmap.timing.add(timingPoint);
}

/** `[General] SampleSet` → 数值 bank（None→None，使用时归一化为 Normal） */
function defaultSampleSetOf(beatmap: Beatmap): SampleSet
{
  return sampleSetFromName(beatmap.beatmapInfo.sampleSet) ?? SampleSet.None;
}

function sampleSetFromName(value: string): SampleSet | undefined
{
  switch (value.trim().toLowerCase())
  {
  case "none": return SampleSet.None;
  case "normal": return SampleSet.Normal;
  case "soft": return SampleSet.Soft;
  case "drum": return SampleSet.Drum;
  default: {
    const parsed = Number.parseInt(value);
    return Number.isNaN(parsed) ? undefined : parsed as SampleSet;
  }
  }
}

/** timing 点第 4 列：非法值回 [General] 默认 bank */
function parseTimingSampleSet(raw: string, beatmap: Beatmap): SampleSet
{
  const parsed = Number.parseInt(raw);
  return Number.isNaN(parsed) ? defaultSampleSetOf(beatmap) : parsed as SampleSet;
}

function parseVersionHeader(line: string)
{
  const match = line.match(/osu file format v(\d+)/);

  if (!match)
    return undefined;

  const version = Number.parseInt(match[1]);

  if (Number.isFinite(version))
    return version;

  throw Error(`Invalid version header: ${line}`);
}

function parseColors(line: string, beatmap: Beatmap)
{
  const [key, value] = parseKeyValue(line);

  if (!key || !value)
    return;

  const parseColorValue = () =>
  {
    const [r, g, b] = value.split(",").map(it => Number.parseInt(it));

    return new Color({ r, g, b });
  };

  if (key.startsWith("Combo"))
  {
    beatmap.colors.addComboColor(parseColorValue());
  }
  else
    switch (key)
    {
    case "SliderTrackOverride":
      beatmap.colors.sliderTrackOverride = parseColorValue();
      break;
    case "SliderBorder":
      beatmap.colors.sliderBorder = parseColorValue();
      break;
    }
}

function tryParseSectionHeader(line: string)
{
  if (line.startsWith("[") && line.endsWith("]"))
  {
    const section = line.substring(1, line.length - 1);
    if (section in BeatmapSection)
      return section as BeatmapSection;
  }

  return null;
}

function parseKeyValue(line: string): [string, string] | []
{
  const index = line.indexOf(":");
  if (index === -1)
    return [];

  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}
