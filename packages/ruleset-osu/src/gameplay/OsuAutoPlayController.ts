import type { AutoPlayFrameContext } from "@osucad/core";
import { AutoPlayController, type Playfield, ReplayState } from "@osucad/core";
import type { DrawableOsuHitObject } from "../hitObjects/drawables/DrawableOsuHitObject";
import { clamp, Interpolation, MousePositionAbsoluteInput, type PassThroughInputManager, Vec2 } from "@osucad/framework";
import { DrawableSlider } from "../hitObjects/drawables/DrawableSlider";
import { OsuAction } from "../ui/OsuAction";
import { SliderTick } from "../hitObjects/SliderTick";
import { SliderRepeat } from "../hitObjects/SliderRepeat";
import type { OsuHitObject } from "../hitObjects/OsuHitObject";
import { Slider } from "../hitObjects/Slider";
import { DrawableSliderBall } from "../hitObjects/drawables/DrawableSliderBall";
import { CursorPosition } from "./CursorPosition";
import type { DynamicsParameters } from "./SecondOrderDynamics";
import { DrawableSpinner } from "../hitObjects/drawables/DrawableSpinner";

export class OsuAutoPlayController extends AutoPlayController<DrawableOsuHitObject>
{
  constructor(playfield: Playfield, inputManager: PassThroughInputManager)
  {
    super(playfield, inputManager);
  }

  #currentHitObject?: DrawableOsuHitObject;

  readonly cursorPos = new CursorPosition();

  protected override* process({ current, next }: AutoPlayFrameContext<DrawableOsuHitObject>)
  {

    if (this.#currentHitObject)
    {
      if (!this.#currentHitObject.hitObject || this.time.current > this.#currentHitObject.hitObject.endTime)
      {
        yield new ReplayState([]);
        this.#currentHitObject = undefined;
      }
    }

    if (current instanceof DrawableSpinner && this.isActive(current))
    {
      const angle = (this.time.current - current.hitObject.startTime) * 0.05;

      const spinCount = Math.floor(current.rotationTracker.rotation / Math.PI + 0.5);

      const scaleX = 0.5 + random(spinCount, 0) * 0.4;
      const scaleY = 0.8 + random(spinCount, 1) * 0.6;

      const rotation = Math.PI * (0.2 + random(spinCount, 12) * 0.1);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);

      // (0,120).rotate(angle).mul(scaleX,scaleY).rotate(rotation), inlined to avoid Vec2 churn
      const vx = -120 * sin * scaleX;
      const vy = 120 * cos * scaleY;

      const position = scratchA;
      position.x = 256 + vx * cosR - vy * sinR;
      position.y = 192 + vx * sinR + vy * cosR;

      yield this.moveCursor(position, {
        frequency: 4 + Math.random(),
        damping: 0.8 + Math.random(),
        response: 0.5,
      });
    }
    else if (current instanceof DrawableSlider && this.isActive(current))
    {
      const position = this.getSliderPosition(current, this.time.current + 36);
      yield this.moveCursor(position, {
        frequency: Math.max(current.hitObject.velocity * 2.5, 5),
        damping: 1,
        response: 0.5,
      });
    }
    else if (current && next)
    {
      const prevPosition = this.getEndPositionWithLeniency(current);
      const nextPosition = next.hitObject.getStackedPosition(scratchB);
      const deltaX = nextPosition.x - prevPosition.x;
      const deltaY = nextPosition.y - prevPosition.y;

      const startTime = this.getLooseEndTime(current.hitObject);
      const endTime = next.hitObject.startTime;
      const duration = endTime - startTime;

      const midX = (prevPosition.x + nextPosition.x) * 0.5;
      const midY = (prevPosition.y + nextPosition.y) * 0.5;

      // Interpolation.valueAt with default (linear) easing, inlined into scratchA.
      const blendEnd = startTime + Math.min(200, duration * 0.75);
      const position = scratchA;
      if (this.time.current < startTime)
      {
        position.x = midX;
        position.y = midY;
      }
      else if (this.time.current >= blendEnd)
      {
        position.x = nextPosition.x;
        position.y = nextPosition.y;
      }
      else
      {
        const t = (this.time.current - startTime) / (blendEnd - startTime);
        position.x = midX + (nextPosition.x - midX) * t;
        position.y = midY + (nextPosition.y - midY) * t;
      }

      const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

      const completionProgress = clamp((this.time.current - current.hitObject.endTime) / (next.hitObject.startTime - current.hitObject.endTime), 0, 1);

      let frequencyMultiplier = 1;

      const deltaLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (deltaLength > 125)
      {
        const curveFactor = Math.pow(1 - completionProgress, 2);

        if (mostlyHorizontal)
          position.y -= curveFactor * deltaLength * 0.2;
        else
          position.x -= curveFactor * deltaLength * 0.15;


        frequencyMultiplier *= 1.5;
      }

      const ho = current.hitObject;
      position.x += (random(ho.position.x, ho.position.y) - 0.5) * ho.radius * 0.25;
      position.y += (random(ho.position.x + 1, ho.position.y) - 0.5) * ho.radius * 0.25;

      const distanceFactor = 1 + Math.log(deltaLength + 1) * 0.05;

      const frequency = duration > 0
          ? (1000 / duration) * 0.75 * distanceFactor * frequencyMultiplier
          : 10;

      const fadeIn = Interpolation.valueAt(
          this.time.current,
          0.15,
          1,
          startTime,
          startTime + Math.min(250, duration * 0.75),
      );


      yield this.moveCursor(position, {
        frequency: Math.max(Math.max(frequency, 0.5) * fadeIn, 2) ,
        damping: 1,
        response: 0.9 * fadeIn,
      });
    }
    else
    {
      const position = next ? next.hitObject.getStackedPosition(scratchA) : this.cursorPos.current;

      yield this.moveCursor(position, {
        frequency: 2,
        damping: 0.5,
        response: 0.5,
      });
    }

    if (current && this.didPassStartTime(current))
    {
      this.#currentHitObject = current;
      yield new ReplayState([this.#buttonIndex++ % 2 === 0 ? OsuAction.LeftButton : OsuAction.RightButton]);
    }
  }

  #buttonIndex = 0;

  protected moveCursor(position: Vec2, dynamics: DynamicsParameters)
  {
    position = this.cursorPos.update(position, Math.min(this.time.elapsed, 100), dynamics);
    return new MousePositionAbsoluteInput(this.positionToAbsolute(position));
  }

  protected getLooseEndTime(hitObject: OsuHitObject)
  {
    let endTime = hitObject.endTime;

    if (hitObject instanceof Slider)
    {
      endTime -= 36;
      for (const nested of hitObject.nestedHitObjects)
      {
        if (nested instanceof SliderTick || nested instanceof SliderRepeat)
          endTime = Math.max(endTime, nested.endTime);
      }
    }

    return endTime;
  }

  protected isActive(hitObject: DrawableOsuHitObject)
  {
    return this.time.current >= hitObject.hitObject.startTime && this.time.current < this.getLooseEndTime(hitObject.hitObject);
  }

  protected getEndPositionWithLeniency(hitObject: DrawableOsuHitObject)
  {
    const time = this.getLooseEndTime(hitObject.hitObject);
    if (hitObject instanceof DrawableSlider)
      return this.getSliderPositionExact(hitObject, time);

    return hitObject.hitObject.getStackedEndPosition(scratchC);
  }

  protected getSliderPosition(slider: DrawableSlider, time = this.time.current): Vec2
  {
    const exact = this.getSliderPositionExact(slider, time);
    const loose = this.getSliderPositionLoose(slider, time);

    exact.x += (loose.x - exact.x) * 0.5;
    exact.y += (loose.y - exact.y) * 0.5;
    return exact;
  }

  protected getSliderPositionExact(slider: DrawableSlider, time = this.time.current): Vec2
  {
    const completionProgress = clamp((time - slider.hitObject.startTime) / slider.hitObject.duration, 0, 1);

    const out = slider.hitObject.getStackedPosition(scratchD);
    out.addInPlace(slider.hitObject.curvePositionAt(completionProgress, scratchF));
    return out;
  }

  protected getSliderPositionLoose(slider: DrawableSlider, time = this.time.current)
  {
    // nestedHitObjects are already startTime-sorted (HitObject.applyDefaults sorts them).
    const nested = slider.hitObject.nestedHitObjects as readonly OsuHitObject[];
    if (time < nested[0].startTime)
      return nested[0].getStackedPosition(scratchE);

    if (time > nested[nested.length - 1].endTime)
      return nested[nested.length - 1].getStackedEndPosition(scratchE);

    for (let i = 1; i < nested.length; i++)
    {
      const prev = nested[i - 1];
      const curr = nested[i];

      if (i === nested.length - 1)
      {
        const radius = curr.radius * DrawableSliderBall.FOLLOW_AREA;
        if (prev.getStackedEndPosition(scratchF).distance(curr.getStackedPosition(scratchG)) < radius)
        {
          return prev.getStackedEndPosition(scratchE);
        }
      }

      if (time >= prev.startTime && time < curr.startTime)
      {
        // Interpolation.valueAt with default (linear) easing, inlined into scratchE.
        const out = prev.getStackedPosition(scratchE);
        const prevX = out.x;
        const prevY = out.y;
        curr.getStackedPosition(scratchF);

        const t = (time - prev.startTime) / (curr.startTime - prev.startTime);
        out.x = prevX + (scratchF.x - prevX) * t;
        out.y = prevY + (scratchF.y - prevY) * t;
        return out;
      }
    }

    return this.getSliderPositionExact(slider, time);
  }

  protected positionToAbsolute(position: Vec2)
  {
    return this.playfield.toScreenSpace(position);
  }
}

const scratchA = new Vec2();
const scratchB = new Vec2();
const scratchC = new Vec2();
const scratchD = new Vec2();
const scratchE = new Vec2();
const scratchF = new Vec2();
const scratchG = new Vec2();

function random(x: number, y: number): number
{
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;

  return v - Math.floor(v);
}
