import { HitSampleInfo } from "../audio/HitSampleInfo";
import type { ISampleInfo } from "../audio/ISampleInfo";
import { Skin } from "./Skin";

/**
 * 谱面包内文件层（lazer `LegacyBeatmapSkin`，`UseCustomSampleBanks = true`）：
 * - `useBeatmapSamples=false`（解析后的音效组下标为 0）时本层整体跳过——包内文件不参与查询；
 * - 带后缀下标（≥2）只查带后缀名，不允许回落到包内裸名（裸名交给皮肤层）；
 * - 层末仍可查无 bank 的通用名（`hitnormal` 等，对齐 lazer 无条件 `yield return hitSample.Name`）。
 * 非 `HitSampleInfo` 的采样（如故事板）不受下标门控。
 */
export class BeatmapSkin extends Skin
{
  protected override getSampleLookups(sampleInfo: ISampleInfo): string[]
  {
    return beatmapSampleLookups(sampleInfo);
  }
}

export function beatmapSampleLookups(sampleInfo: ISampleInfo): string[]
{
  if (!(sampleInfo instanceof HitSampleInfo))
    return sampleInfo.lookupNames;

  if (!sampleInfo.useBeatmapSamples)
    return [];

  const suffix = sampleInfo.suffix;
  if (suffix && suffix.length > 0)
    return [...sampleInfo.lookupNames.filter(name => name.endsWith(suffix)), sampleInfo.name];

  return sampleInfo.lookupNames;
}
