import { AudioComponent } from "./AudioComponent";
import type { IAudioSource } from "./IAudioSource";

export abstract class AudioDestination<T extends IAudioSource = IAudioSource> extends AudioComponent
{
  protected items: T[] = [];

  protected abstract get input(): AudioNode;

  connect(source: T): void
  {
    if (source.destination)
      source.destination.disconnect(source);

    source.destination = this;

    source.output.connect(this.input);

    this.items.push(source);
  }

  disconnect(source: T): boolean
  {
    const index = this.items.indexOf(source);
    if (index < 0)
      return false;

    console.assert(source.destination === this);

    source.destination = undefined;

    this.items.splice(index, 1);

    try
    {
      source.output.disconnect(this.input);
    }
    catch
    {
      // 边可能已被外部（如 track.output.disconnect()）断开——
      // WebAudio 对已不存在的连接抛 InvalidAccessError，状态修正照常完成
    }

    return true;
  }

  protected override updateChildren()
  {
    super.updateChildren();

    for (let i = 0; i < this.items.length; i++)
    {
      const item = this.items[i];

      if (!item.isAlive)
      {
        this.disconnect(item);
        i--;
        continue;
      }

      item.update();
    }
  }

  public override dispose()
  {
    for (const item of this.items)
      item.dispose();

    super.dispose();
  }
}
