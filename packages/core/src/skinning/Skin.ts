import { Action, type Drawable, type IFileSystem, type Sample } from "@osucad/framework";
import type { Texture } from "pixi.js";
import { Color } from "pixi.js";
import type { ISampleInfo } from "../audio/ISampleInfo";
import type { IResourcesProvider } from "../io/IResourcesProvider";
import type { ISkin } from "./ISkin";
import type { SkinConfigurationLookup, SkinConfigurationValue } from "./SkinConfiguration";
import { SkinConfiguration } from "./SkinConfiguration";
import { SkinSampleStore } from "./SkinSampleStore";
import type { SkinComponentLookup } from "./SkinComponentLookup";

export class Skin implements ISkin
{
  readonly config = new SkinConfiguration();

  readonly samples: SkinSampleStore;

  readonly texturesChanged = new Action();

  constructor(readonly files: IFileSystem, resourcesProvider: IResourcesProvider)
  {
    this.samples = new SkinSampleStore(
        files,
        resourcesProvider.audioManager,
    );
  }

  getTexture(lookup: string): Texture | null
  {
    return null;
  }

  getSample(sampleInfo: ISampleInfo): Sample | null
  {
    for (const lookup of this.getSampleLookups(sampleInfo))
    {
      const sample = this.samples.get(lookup);
      if (sample)
        return sample;
    }

    return null;
  }

  /**
   * 本层皮肤允许查询的文件名列表（lazer `LegacySkin.getLegacyLookupNames`）。
   * 默认不过滤；`BeatmapSkin`/`DefaultSkin` 按自定义音效组下标语义裁剪。
   */
  protected getSampleLookups(sampleInfo: ISampleInfo): string[]
  {
    return sampleInfo.lookupNames;
  }

  public getDrawableComponent(lookup: SkinComponentLookup): Drawable | null
  {
    return null;
  }

  getConfig<T extends SkinConfigurationLookup>(lookup: T): SkinConfigurationValue<T> | null
  {
    return this.config.get(lookup);
  }

  get comboColors()
  {
    if (this.config.comboColors.length)
      return this.config.comboColors;

    return [new Color("white")];
  }

  getComboColor(comboIndex: number)
  {
    const colors = this.comboColors;
    return colors[Math.max(comboIndex + 1, 0) % colors.length];
  }

  dispose()
  {
    this.config.dispose();
  }
}
