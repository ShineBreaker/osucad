import { EventEmitter } from "pixi.js";
import type { ZipEntry } from "unzipit";
import type { FileEvents, FileSystemEvents, IFile, IFileSystem } from "./IFileSystem";
import { SimpleFileSystem } from "./SimpleFileSystem";

export class ZipArchiveFileSystem extends EventEmitter<FileSystemEvents> implements IFileSystem
{
  static async create(buffer: ArrayBuffer | Blob)
  {
    const { unzip } = await import("unzipit");

    const { entries } = await unzip(buffer);

    return new ZipArchiveFileSystem(entries);
  }

  static async createMutable(buffer: ArrayBuffer | Blob): Promise<SimpleFileSystem>
  {
    const { unzip, setOptions } = await import("unzipit");

    setOptions({
      // workerURL: new URL("unzipit/dist/unzipit-worker.js", import.meta.url).href,
      // numWorkers: 4,
    });

    const { entries } = await unzip(buffer);
    const files = new SimpleFileSystem({ caseSensitive: false });

    const loadP: Promise<unknown>[] = [];

    for (const key in entries)
    {
      loadP.push(
          entries[key].arrayBuffer()
            .then(data => files.create(key, data)),
      );
    }

    await Promise.all(loadP);

    return files;
  }

  /**
   * 惰性解压变体：返回只读 IFileSystem，条目内容到 `read()` 时才解包
   * （同 create 的语义，命名沿用 createMutable 以区分「解压整个包」）
   */
  static async createMutableLazy(buffer: ArrayBuffer | Blob): Promise<ZipArchiveFileSystem>
  {
    return this.create(buffer);
  }

  private readonly _entries = new Map<string, ZipArchiveFile>();

  private constructor(entries: Record<string, ZipEntry>)
  {
    super();

    // 键统一小写，与 SimpleFileSystem(caseSensitive=false) 的查询语义一致
    // （entry.path 保留原始大小写）
    for (const key in entries)
      this._entries.set(key.toLowerCase(), new ZipArchiveFile(entries[key]));
  }

  public entries(): IFile[]
  {
    return [...this._entries.values()];
  }

  get(path: string): IFile | undefined
  {
    return this._entries.get(path.trim().toLowerCase());
  }
}
export class ZipArchiveFile extends EventEmitter<FileEvents> implements IFile
{
  constructor(
    private readonly entry: ZipEntry,
  )
  {
    super();
  }

  private _dataP?: Promise<ArrayBuffer>;

  get path()
  {
    return this.entry.name;
  }

  /** 解压前大小，供调用方做指纹/缓存判定 */
  get size()
  {
    return this.entry.size;
  }

  read(): Promise<ArrayBuffer>
  {
    this._dataP ??= this.entry.arrayBuffer();
    return this._dataP;
  }
}
