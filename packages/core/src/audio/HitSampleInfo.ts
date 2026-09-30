import type { ISampleInfo } from "./ISampleInfo";

export class HitSampleInfo implements ISampleInfo
{
  public static readonly HIT_NORMAL = "hitnormal";
  public static readonly HIT_WHISTLE = "hitwhistle";
  public static readonly HIT_FINISH = "hitfinish";
  public static readonly HIT_CLAP = "hitclap";

  public static readonly BANK_NORMAL = "normal";
  public static readonly BANK_SOFT = "soft";
  public static readonly BANK_DRUM = "drum";

  public static readonly ALL_ADDITIONS = [this.HIT_WHISTLE, this.HIT_FINISH, this.HIT_CLAP];
  public static readonly ALL_BANKS = [this.BANK_NORMAL, this.BANK_SOFT, this.BANK_DRUM];

  constructor(
    readonly name: string,
    readonly bank = HitSampleInfo.BANK_NORMAL,
    readonly suffix?: string,
    readonly volume = 100,
    readonly editorAutoBank = true,
    /**
     * lazer `useBeatmapSamples`：解析后的自定义音效组下标 ≥1（物件自身或控制点继承）
     * 才允许查谱面包内文件；0 时只走皮肤/默认层。`FileHitSampleInfo` 恒为 true。
     */
    readonly useBeatmapSamples = false,
  )
  {
  }

  /**
   * lazer `HitSampleInfo.LookupNames`：自定义音效组下标 ≥2 才进后缀，
   * 命中不了时逐级回落到裸名（`normal-hitnormal3` → `normal-hitnormal` → `hitnormal`）。
   */
  get lookupNames(): string[]
  {
    const { suffix, bank, name } = this;

    const names = suffix && suffix.length > 0 ? [`${bank}-${name}${suffix}`] : [];

    names.push(`${bank}-${name}`, name);

    return names;
  }

  public equals(other: ISampleInfo): boolean
  {
    if (!(other instanceof HitSampleInfo))
      return false;

    return this.suffix === other.suffix
        && this.bank === other.bank
        && this.name === other.name
        && this.volume === other.volume
        && this.editorAutoBank === other.editorAutoBank
        && this.useBeatmapSamples === other.useBeatmapSamples;
  }

  public with(name: string)
  {
    return new HitSampleInfo(name, this.bank, this.suffix, this.volume, this.editorAutoBank, this.useBeatmapSamples);
  }
}

/**
 * hitSample 第 5 列指定的显式文件名样本（`FileHitSampleInfo`）。
 * 固定占 hitnormal 槽位：先查原文件名与去后缀名，再回落到 normal bank 的基础名。
 * lazer 强制 `customSampleBank: 1`——显式文件名必然来自谱面包内，故 `useBeatmapSamples` 恒 true。
 */
export class FileHitSampleInfo extends HitSampleInfo
{
  constructor(
    readonly filename: string,
    volume: number,
  )
  {
    super(HitSampleInfo.HIT_NORMAL, HitSampleInfo.BANK_NORMAL, undefined, volume, true, true);
  }

  override get lookupNames(): string[]
  {
    const stem = this.filename.replace(/\.[^./\\]*$/, "");

    return stem === this.filename
        ? [this.filename, ...super.lookupNames]
        : [this.filename, stem, ...super.lookupNames];
  }

  // lazer `FileHitSampleInfo.With` 保留文件名（改名只改显示名，文件不变）
  override with(name: string): HitSampleInfo
  {
    void name;
    return new FileHitSampleInfo(this.filename, this.volume);
  }
}
