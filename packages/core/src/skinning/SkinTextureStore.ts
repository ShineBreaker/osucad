import type { ComputedRef } from "@osucad/framework";
import { Action, computed, DrawableSprite, type IFile, loadTexture, reactive, ref, unref, watch } from "@osucad/framework";
import { deferredPromise } from "../utils/DeferredPromise";
import type { Texture } from "pixi.js";
import type { Skin } from "./Skin";
import { SkinnableTextureAnimation } from "./SkinnableTextureAnimation";

export interface TextureStoreManifestRaw
{
  readonly textures?: (TextureManifestEntry | string)[];
  readonly animations?: (AnimationManifestEntry | string)[];
}

export interface TextureStoreManifest
{
  readonly textures: TextureManifestEntry[];
  readonly animations: AnimationManifestEntry[];
}

export interface TextureManifestEntry
{
  readonly name: string;
}

export interface AnimationManifestEntry
{
  name: string;
  animatable?: boolean
  animationSeparator?: string
  looping?: boolean
  applyConfigFrameRate?: boolean
  startAtCurrentTime?: boolean,
  frameLength?: number,
  maxSize?: number
}

interface ReactiveFileEntry
{
  file: IFile;
  version: number;
}

export class SkinTextureStore
{
  readonly textureChanged = new Action();

  allow2xTextureLookup = true;

  constructor(
    readonly skin: Skin,
    manifest: TextureStoreManifestRaw | ComputedRef<TextureStoreManifestRaw>,
  )
  {
    for (const file of skin.files.entries())
      this._addFile(file);

    skin.files.on("added", (_, file) => this._addFile(file));

    this.manifest = computed(() =>
    {
      return {
        textures: unref(manifest).textures?.map(entry => normalizeTextureManifestEntry(entry)) ?? [],
        animations: unref(manifest).animations?.map(entry => normalizeAnimationManifestEntry(entry)) ?? [],
      };
    });

    this._textures = this.manifest.value.textures.map(entry => new ReactiveTextureEntry(this, normalizeTextureManifestEntry(entry)));
    this._animations = this.manifest.value.animations.map(entry => new ReactiveAnimationEntry(this, entry));

    watch(this.manifest, (newManifest: TextureStoreManifest) =>
    {
      const textures = [...this._textures];
      const animations = [...this._animations];

      // find removed entries
      for (const entry of textures)
      {
        if (newManifest.textures.some(it => it.name === entry.manifest.name))
          continue;

        this._textures.splice(this._textures.indexOf(entry), 1);
      }

      for (const entry of animations)
      {
        if (newManifest.animations.some(it => it.name === entry.manifest.name))
          continue;

        this._animations.splice(this._animations.indexOf(entry), 1);
      }

      // find new entries
      for (const entry of newManifest.textures)
      {
        if (this._textures.some(it => it.manifest.name === entry.name))
          continue;

        const textureEntry = new ReactiveTextureEntry(this, entry);
        this._textures.push(textureEntry);

        textureEntry.isLoaded.then(() => this.textureChanged.emit());
      }

      for (const entry of newManifest.animations)
      {
        if (this._animations.some(it => it.manifest.name === entry.name))
          continue;

        const animationEntry = new ReactiveAnimationEntry(this, entry);
        this._animations.push(animationEntry);

        animationEntry.isLoaded.then(() => this.textureChanged.emit());
      }
    });
  }

  readonly manifest: ComputedRef<TextureStoreManifest>;

  private _counter = 0;

  private _addFile(file: IFile)
  {
    this.filesReactive.push({ file, version: this._counter++ });

    const remove = () =>
    {
      const index = this.filesReactive.findIndex(it => it.file === file);
      if (index >= 0)
        this.filesReactive.splice(index, 1);
    };

    file.once("removed", remove);

    file.once("changed", () =>
    {
      remove();
      setTimeout(() => this._addFile(file), 0);
    });
  }

  async load()
  {
    await Promise.all([
      ...this._textures.map(entry => entry.load()),
      ...this._animations.map(entry => entry.load()),
    ]);

    watch(() => this.skin.getConfig("animationFramerate"), () =>
    {
      this.textureChanged.emit();
    });
  }

  readonly filesReactive = reactive<ReactiveFileEntry[]>([]);

  private readonly _textures: ReactiveTextureEntry[];
  private readonly _animations: ReactiveAnimationEntry[];

  readonly extensions: string[] = ["jpg", "jpeg", "png", "webp"];

  getEntry(name: string)
  {
    const lookupNames = this.allow2xTextureLookup ? [`${name}@2x`, name] : name;

    for (const lookup of lookupNames)
    {
      for (const entry of this.filesReactive)
      {
        for (const extension of this.extensions)
        {
          if (entry.file.path === `${lookup}.${extension}`)
            return entry;
        }
      }
    }

    return null;
  }

  getTexture(name: string)
  {
    const entry = this._textures.find(it => it.manifest.name === name);

    return entry?.texture.value ?? null;
  }

  getAnimation(name: string)
  {
    const entry = this._animations.find(it => it.manifest.name === name);
    if (!entry)
      return null;

    return entry.getAnimation();
  }
}

class ReactiveTextureEntry
{
  constructor(
    readonly store: SkinTextureStore,
    readonly manifest: TextureManifestEntry,
  )
  {
  }

  readonly entry = computed(() => this.store.getEntry(this.manifest.name));

  // 不用 vueuse computedAsync：它经 vue@3.5.35 解析到另一份 @vue/reactivity，
  // 追踪不到本框架 3.5.34 的 ref/computed——异步求值只跑一次且不随依赖重算，
  // 纹理/动画会永远停在初始空值（entry 晚到或文件变更后都不会刷新）。
  readonly texture = ref<Texture | null>(null);

  isLoaded = deferredPromise<void>();

  async load()
  {
    let seq = 0;
    watch(this.entry, async (entry) =>
    {
      const token = ++seq;
      let texture: Texture | null = null;
      try
      {
        if (entry)
        {
          const data = await entry.file.read();
          const is2xTexture = entry.file.path.includes("@2x");
          texture = await loadTexture(data, { resolution: is2xTexture ? 2 : 1, label: entry.file.path });
        }
      }
      catch
      {
        texture = null;
      }
      if (token === seq)
        this.texture.value = texture;
      this.isLoaded.resolve();
    }, { immediate: true });

    await this.isLoaded;

    watch(this.texture, () =>
    {
      this.store.textureChanged.emit();
    });
  }
}

export function normalizeTextureManifestEntry(value: TextureManifestEntry | string): TextureManifestEntry
{
  if (typeof value === "string")
    return { name: value };
  return value;
}

export function normalizeAnimationManifestEntry(value: AnimationManifestEntry | string): AnimationManifestEntry
{
  if (typeof value === "string")
    return { name: value };
  return value;
}


class ReactiveAnimationEntry
{
  constructor(
    readonly store: SkinTextureStore,
    readonly manifest: AnimationManifestEntry,
  )
  {
    watch(this.entries, (entries: ReactiveFileEntry[], oldEntries: ReactiveFileEntry[]) =>
    {
      if (!oldEntries
          || this.entriesDebounced.value.length === 0
          || entries.length !== oldEntries.length
          || entries.some((entry, index) => entry !== oldEntries[index])
      )
        this.entriesDebounced.value = entries;
    }, { immediate: true });
  }

  entries = computed(() =>
  {
    const {
      animationSeparator = "-",
      name: componentName,
    } = this.manifest;

    const getFrameName = (frameIndex: number) => `${componentName}${animationSeparator}${frameIndex}`;

    const entries: ReactiveFileEntry[] = [];

    let frameCount = 0;
    while (true)
    {
      const entry = this.store.getEntry(getFrameName(frameCount));

      if (!entry)
        break;

      entries.push(entry);

      frameCount++;
    }

    if (entries.length === 0)
    {
      const entry = this.store.getEntry(this.manifest.name);
      if (entry)
        return [entry];
    }

    return entries;
  });

  entriesDebounced = ref<ReactiveFileEntry[]>([]);

  readonly textures = ref<Texture[]>([]);

  async #loadTexture(entry: ReactiveFileEntry)
  {
    const data = await entry.file.read();

    const is2xTexture = entry.file.path.includes("@2x");

    return loadTexture(data, { resolution: is2xTexture ? 2 : 1, label: entry.file.path });
  }

  isLoaded = deferredPromise<void>();

  async load()
  {
    let seq = 0;
    watch(this.entriesDebounced, async (entries) =>
    {
      const token = ++seq;
      const loaded = await Promise.all(
          entries.map(entry => this.#loadTexture(entry).catch(() => null)),
      );
      if (token === seq)
        this.textures.value = loaded.filter((t): t is Texture => t !== null);
      this.isLoaded.resolve();
    }, { immediate: true });

    await this.isLoaded;

    watch(this.textures, () =>
    {
      this.store.textureChanged.emit();
    });
  }

  getAnimation()
  {
    const {
      looping = false,
      applyConfigFrameRate = false,
      startAtCurrentTime = true,
      frameLength,
    } = this.manifest;

    const textures = this.textures.value;

    if (textures.length === 0)
      return null;

    if (textures.length === 1)
      return new DrawableSprite({ texture: textures[0] });

    const animation = new SkinnableTextureAnimation(startAtCurrentTime);
    animation.loop = looping;
    animation.defaultFrameLength = frameLength ?? this.#getFrameLength(applyConfigFrameRate, textures);

    for (const t of textures)
      animation.addFrame(t);

    return animation;
  }

  #getFrameLength(applyConfigFrameRate: boolean, textures: Texture[])
  {
    if (applyConfigFrameRate)
    {
      const iniRate = this.store.skin.getConfig("animationFramerate");

      if (iniRate && iniRate > 0)
        return 1000 / iniRate;

      return 1000 / textures.length;
    }

    return 1000 / 60;
  }
}
