import { HitSampleInfo } from "../audio/HitSampleInfo";
import type { ISampleInfo } from "../audio/ISampleInfo";
import { Skin } from "./Skin";

/**
 * 皮肤/默认层（lazer `LegacySkin`，`UseCustomSampleBanks = false`）：
 * 自定义音效组下标 ≥2 的采样在本层一律剥掉后缀查裸名——
 * 后缀文件只允许由谱面包内层提供。
 */
export class DefaultSkin extends Skin
{
  protected override getSampleLookups(sampleInfo: ISampleInfo): string[]
  {
    return skinSampleLookups(sampleInfo);
  }
}

export function skinSampleLookups(sampleInfo: ISampleInfo): string[]
{
  if (sampleInfo instanceof HitSampleInfo)
  {
    const suffix = sampleInfo.suffix;
    if (suffix && suffix.length > 0)
      return sampleInfo.lookupNames.filter(name => !name.endsWith(suffix));
  }

  return sampleInfo.lookupNames;
}
