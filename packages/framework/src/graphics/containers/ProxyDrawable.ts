import type { Container as PIXIContainer } from "pixi.js";
import { RenderLayer } from "pixi.js";
import type { ReadonlyDependencyContainer } from "../../di/DependencyContainer";
import { Drawable } from "../drawables/Drawable";

export class ProxyDrawable extends Drawable
{
  constructor(readonly source: Drawable)
  {
    super();
  }

  override get isPresent(): boolean
  {
    return false;
  }

  override get shouldBeAlive(): boolean
  {
    return this.source.shouldBeAlive;
  }

  override get removeWhenNotAlive(): boolean
  {
    return this.source.removeWhenNotAlive;
  }

  override get lifetimeStart(): number
  {
    return this.source.lifetimeStart;
  }

  override get lifetimeEnd(): number
  {
    return this.source.lifetimeEnd;
  }

  readonly #renderLayer = new RenderLayer();

  #attached = true;

  protected override load(dependencies: ReadonlyDependencyContainer)
  {
    super.load(dependencies);

    this.#renderLayer.attach(this.source.drawNode);

    this.source.lifetimeChanged.addListener(() => this.lifetimeChanged.emit(this));
  }

  override updateSubTree(): boolean
  {
    this.#syncAttachment();

    return super.updateSubTree();
  }

  /**
   * 源 drawNode 被从渲染树摘除（所属 drawable 死亡/回池）时，RenderLayer 仍会按
   * 陈旧的世界变换重绘它 → 屏幕上留下幽灵图像（停滞的 approach circle / 折返箭头）。
   * 无生命周期的源（如 slider 箭头、圈体 overlay）其 shouldBeAlive 恒为 true，
   * 代理永远不会被生命周期回收，因此必须按「是否还在同一渲染树」逐帧同步挂接。
   */
  #syncAttachment()
  {
    const inScene = topNode(this.source.drawNode) === topNode(this.drawNode);

    if (inScene === this.#attached)
      return;

    if (!(this.#attached = inScene))
      this.#renderLayer.detachAll();
    else
      this.#renderLayer.attach(this.source.drawNode);
  }

  override createDrawNode(): PIXIContainer
  {
    return this.#renderLayer as any;
  }

  override updateDrawNodeTransform()
  {
  }

  override dispose(isDisposing: boolean = true)
  {
    super.dispose(isDisposing);

    this.#renderLayer.detachAll();
  }
}

function topNode(node: PIXIContainer): PIXIContainer
{
  while (node.parent)
    node = node.parent;

  return node;
}
