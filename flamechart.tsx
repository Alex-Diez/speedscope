import {h, render, Component} from 'preact'
import {StyleSheet, css} from 'aphrodite'

import {Profile, Frame} from './profile'
import regl, {vec2, vec3, mat3, ReglCommand, ReglCommandConstructor} from 'regl'
import { Rect, Vec2, AffineTransform, clamp } from './math'

interface FlamechartFrame {
  frame: Frame
  start: number
  end: number
}

type StackLayer = FlamechartFrame[]

export class Flamechart {
  // Bottom to top
  private layers: StackLayer[] = []
  private duration: number = 0

  private frameColors = new Map<Frame, [number, number, number]>()

  getDuration() { return this.duration }
  getLayers() { return this.layers }
  getFrameColors() { return this.frameColors }

  private appendFrame(layerIndex: number, frame: Frame, timeDelta: number) {
    while (layerIndex >= this.layers.length) this.layers.push([])
    this.layers[layerIndex].push({
      frame: frame,
      start: this.duration,
      end: this.duration + timeDelta
    })
  }

  private appendSample(stack: Frame[], timeDelta: number) {
    for (let i = 0; i < stack.length; i++) {
      this.appendFrame(i, stack[i], timeDelta)
    }
    this.duration += timeDelta
  }

  private static mergeAdjacentFrames(layer: StackLayer): StackLayer {
    const ret: StackLayer = []
    for (let flamechartFrame of layer) {
      const prev = ret.length > 0 ? ret[ret.length - 1] : null
      if (prev && prev.frame === flamechartFrame.frame && prev.end === flamechartFrame.start) {
        prev.end = flamechartFrame.end
      } else {
        ret.push(flamechartFrame)
      }
    }
    return ret
  }

  private selectFrameColors(profile: Profile) {
    const frames: Frame[] = []

    function parts(f: Frame) {
      return (f.file || '').split('/').concat(f.name.split(/\W/))
    }

    function compare(a: Frame, b: Frame) {
      const aParts = parts(a)
      const bParts = parts(b)

      const matching = 0
      const minLength = Math.min(aParts.length, bParts.length)
      const maxLength = Math.max(aParts.length, bParts.length)

      let prefixMatchLength = 0
      for (let i = 0; i < minLength; i++) {
        if (aParts[i] === bParts[i]) prefixMatchLength++
        else break
      }

      // Weight matches at the beginning of the string more heavily
      const score = Math.pow(0.95, prefixMatchLength)

      return aParts.join() > bParts.join() ? score : -score
    }

    this.profile.forEachFrame(f => frames.push(f))
    frames.sort(compare)

    const cumulativeScores: number[] = []
    let lastScore = 0
    for (let i = 0; i < frames.length; i++) {
      const score = lastScore + Math.abs(compare(frames[i], frames[(i + 1)%frames.length]))
      cumulativeScores.push(score)
      lastScore = score
    }

    // We now have a sorted list of frames s.t. frames with similar
    // file paths and method names are clustered together.
    //
    // Now, to assign them colors, we map normalized cumulative
    // score values onto the full range of hue values.
    const hues: number[] = []
    const totalScore = cumulativeScores[cumulativeScores.length - 1] || 1
    for (let i = 0; i < cumulativeScores.length; i++) {
      hues.push(360 * cumulativeScores[i] / totalScore)
    }

    for (let i = 0; i < hues.length; i++) {
      // For each frame, select a random saturation in [0.1, 0.2]
      // and a random value in [0.8, 0.9]. This helps visually
      // differentiate otherwise very similar colors.
      const S = 0.10 + 0.10 * Math.random()
      const V = 0.80 + 0.10 * Math.random()

      // TODO(jlfwong): Move this into color routines in a different file
      // https://en.wikipedia.org/wiki/HSL_and_HSV#From_HSV

      const C = V * S
      const hPrime = Math.floor(hues[i] / 60)
      const X = C * (1 - Math.abs(hPrime % 2 - 1))
      const [R1, G1, B1] = (
        hPrime < 1 ? [C, X, 0] :
        hPrime < 2 ? [X, C, 0] :
        hPrime < 3 ? [0, C, X] :
        hPrime < 4 ? [0, X, C] :
        hPrime < 5 ? [X, 0, C] :
        [C, 0, X]
      )

      const m = V - C
      this.frameColors.set(frames[i], [R1 + m, G1 + m, B1 + m])
    }
  }

  constructor(private profile: Profile) {
    profile.forEachSample(this.appendSample.bind(this))
    this.layers = this.layers.map(Flamechart.mergeAdjacentFrames)
    this.selectFrameColors(profile)
  }
}

interface FlamechartViewProps {
  flamechart: Flamechart
}

interface FlamechartFrameLabel {
  configSpaceBounds: Rect
  frame: Frame
}

function binarySearch(lo: number, hi: number, f: (val: number) => number, target: number, targetRangeSize = 1): [number, number] {
  while (true) {
    if (hi - lo <= targetRangeSize) return [lo, hi]
    const mid = (hi + lo) / 2
    const val = f(mid)
    if (val < target) lo = mid
    if (val > target) hi = mid
  }
}

const ELLIPSIS = '\u2026'

function buildTrimmedText(text: string, length: number) {
  const prefixLength = Math.floor(length / 2)
  const suffixLength = Math.ceil(length / 2)
  const prefix = text.substr(0, prefixLength)
  const suffix = text.substr(text.length - prefixLength, prefixLength)
  return prefix + ELLIPSIS + suffix
}

const measureTextCache = new Map<string, number>()
function cachedMeasureTextWidth(ctx: CanvasRenderingContext2D, text: string): number {
  if (!measureTextCache.has(text)) {
    measureTextCache.set(text, ctx.measureText(text).width)
  }
  return measureTextCache.get(text)!
}

function trimTextMid(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (cachedMeasureTextWidth(ctx, text) <= maxWidth) return text
  const [lo, hi] = binarySearch(0, text.length, (n) => {
    return cachedMeasureTextWidth(ctx, buildTrimmedText(text, n))
  }, maxWidth)
  return buildTrimmedText(text, lo)
}

const DEVICE_PIXEL_RATIO = window.devicePixelRatio

export class FlamechartView extends Component<FlamechartViewProps, void> {
  renderer: ReglCommand<RectangleBatchRendererProps> | null = null
  canvas: HTMLCanvasElement | null = null
  overlayCanvas: HTMLCanvasElement | null = null
  overlayCtx: CanvasRenderingContext2D | null = null

  worldSpaceViewportRect = new Rect()
  labels: FlamechartFrameLabel[] = []

  private preprocess() {
    if (!this.canvas) return

    const {flamechart} = this.props
    const configSpaceRects: Rect[] = []
    const colors: vec3[] = []

    const layers = flamechart.getLayers()
    const duration = flamechart.getDuration()
    const maxStackHeight = layers.length

    const configSpaceToWorldSpace = this.configSpaceToWorldSpace()
    const frameColors = flamechart.getFrameColors()

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      for (let flamechartFrame of layer) {
        const configSpaceBounds = new Rect(
          new Vec2(flamechartFrame.start, i),
          new Vec2(flamechartFrame.end - flamechartFrame.start, 1)
        )
        configSpaceRects.push(configSpaceBounds)
        colors.push(frameColors.get(flamechartFrame.frame) || [0, 0, 0])

        this.labels.push({
          configSpaceBounds,
          frame: flamechartFrame.frame
        })
      }
    }

    this.worldSpaceViewportRect = new Rect(
      new Vec2(0, 0),
      new Vec2(this.viewSpaceViewportWidth(), this.viewSpaceViewportHeight())
    )

    const ctx = this.canvas.getContext('webgl')!
    this.renderer = rectangleBatchRenderer(ctx, configSpaceRects, colors)
  }

  private canvasRef = (element?: Element) => {
    if (element) {
      this.canvas = element as HTMLCanvasElement
      this.preprocess()
      this.renderGL()
    } else {
      this.canvas = null
    }
  }

  private overlayCanvasRef = (element?: Element) => {
    if (element) {
      this.overlayCanvas = element as HTMLCanvasElement
      this.overlayCtx = this.overlayCanvas.getContext('2d')
      this.renderLabels()
    } else {
      this.overlayCanvas = null
      this.overlayCtx = null
    }
  }

  private configSpaceWidth() { return this.props.flamechart.getDuration() }
  private configSpaceHeight() { return this.props.flamechart.getLayers().length }
  private configSpaceSize() { return new Vec2(this.configSpaceWidth(), this.configSpaceHeight()) }

  private WORLD_SPACE_FRAME_HEIGHT = 16
  private WORLD_SPACE_LABEL_FONT_SIZE = 12

  private viewSpaceViewportWidth() { return this.canvas ? this.canvas.width : 0 }
  private viewSpaceViewportHeight() { return this.canvas ? this.canvas.height : 0 }
  private viewSpaceViewportSize() { return new Vec2(this.viewSpaceViewportWidth(), this.viewSpaceViewportHeight()) }

  private configSpaceToWorldSpace() {
    return AffineTransform.withScale(new Vec2(
      this.viewSpaceViewportWidth() / this.configSpaceWidth(),
      this.WORLD_SPACE_FRAME_HEIGHT
    ))
  }
  private worldSpaceSize() {
    return this.configSpaceToWorldSpace().transformVector(this.configSpaceSize())
  }

  private worldSpaceToViewSpace() {
    return AffineTransform.betweenRects(
      this.worldSpaceViewportRect,
      new Rect(new Vec2(0, 0), this.viewSpaceViewportSize())
    )
  }

  private viewSpaceToNDC() {
    return AffineTransform.withScale(new Vec2(1, -1)).times(
      AffineTransform.betweenRects(
        new Rect(new Vec2(0, 0), this.viewSpaceViewportSize()),
        new Rect(new Vec2(-1, -1), new Vec2(2, 2))
      )
    )
  }

  private viewSpaceToOverlaySpace() {
    return AffineTransform.withScale(new Vec2(DEVICE_PIXEL_RATIO, DEVICE_PIXEL_RATIO))
  }

  private configSpaceToNDC() {
    return this.viewSpaceToNDC()
      .times(this.worldSpaceToViewSpace())
      .times(this.configSpaceToWorldSpace())
  }

  private renderLabels() {
    const ctx = this.overlayCtx
    if (!ctx) return

    const configSpaceToOverlaySpace = this.viewSpaceToOverlaySpace()
      .times(this.worldSpaceToViewSpace())
      .times(this.configSpaceToWorldSpace())

    const overlaySpaceFontSize = this.WORLD_SPACE_LABEL_FONT_SIZE * DEVICE_PIXEL_RATIO
    const overlaySpaceFrameHeight = this.WORLD_SPACE_FRAME_HEIGHT * DEVICE_PIXEL_RATIO

    ctx.font = `${overlaySpaceFontSize}px/${overlaySpaceFrameHeight}px Courier, monospace`
    ctx.fillStyle = 'rgba(15, 10, 5, 1)'
    ctx.textBaseline = 'top'

    const minWidthToRender = cachedMeasureTextWidth(ctx, 'M' + ELLIPSIS + 'M')
    const overlaySpaceViewportRect = this.viewSpaceToOverlaySpace().transformRect(new Rect(new Vec2(0, 0), this.viewSpaceViewportSize()))

    ctx.clearRect(overlaySpaceViewportRect.left(), overlaySpaceViewportRect.top(), overlaySpaceViewportRect.width(), overlaySpaceViewportRect.height())

    for (let label of this.labels) {
      const LABEL_PADDING_PX = 2 * DEVICE_PIXEL_RATIO
      let overlaySpaceBounds = configSpaceToOverlaySpace.transformRect(label.configSpaceBounds)

      overlaySpaceBounds = overlaySpaceBounds
        .withOrigin(overlaySpaceBounds.origin.plus(new Vec2(LABEL_PADDING_PX, LABEL_PADDING_PX)))
        .withSize(overlaySpaceBounds.size.minus(new Vec2(2 * LABEL_PADDING_PX, 2 * LABEL_PADDING_PX)))

      if (overlaySpaceBounds.width() < minWidthToRender) continue

      // Cull text outside the viewport
      if (overlaySpaceViewportRect.intersectWith(overlaySpaceBounds).isEmpty()) continue

      const trimmedText = trimTextMid(ctx, label.frame.name, overlaySpaceBounds.width())
      ctx.fillText(trimmedText, overlaySpaceBounds.left(), overlaySpaceBounds.top())
    }
  }

  private renderGL() {
    if (!this.renderer || !this.canvas) return
    this.renderer({
      configSpaceToNDC: this.configSpaceToNDC()
    })
    this.renderLabels()
  }

  private pan(viewSpaceDelta: Vec2) {
    const worldSpaceDelta = this.worldSpaceToViewSpace().inverseTransformVector(viewSpaceDelta)
    if (!worldSpaceDelta) return
    this.transformViewport(AffineTransform.withTranslation(worldSpaceDelta))
  }

  private zoom(viewSpaceZoomCenter: Vec2, multiplier: number) {
    const worldSpaceZoomCenter = this.worldSpaceToViewSpace().inverseTransformPosition(viewSpaceZoomCenter)
    if (!worldSpaceZoomCenter) return

    const zoomTransform = AffineTransform
      .withTranslation(worldSpaceZoomCenter.times(-1))
      .scaledBy(new Vec2(multiplier, 1))
      .translatedBy(worldSpaceZoomCenter)

    this.transformViewport(zoomTransform)
  }

  private transformViewport(transform: AffineTransform) {
    const viewportRect = transform.transformRect(this.worldSpaceViewportRect)

    const worldSpaceOriginBounds = new Rect(
      new Vec2(0, 0),
      this.worldSpaceSize().minus(viewportRect.size)
    )

    const worldSpaceSizeBounds = new Rect(
      new Vec2(1, viewportRect.height()),
      new Vec2(this.worldSpaceSize().x, viewportRect.height())
    )

    this.worldSpaceViewportRect = new Rect(
      worldSpaceOriginBounds.closestPointTo(viewportRect.origin),
      worldSpaceSizeBounds.closestPointTo(viewportRect.size)
    )
  }

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault()

    // TODO(jlfwong): When scrolling and adding or releasing
    // a modifier key, any momentum scrolling from previous
    // initiated momentum scrolling may still take effect.
    // Figure out how to prevent this.
    //
    // Also, support drag-based panning, and pinch-to-zoom
    if (ev.metaKey) {
      const multiplier = 1 + (ev.deltaY / 100)
      this.zoom(new Vec2(ev.offsetX, ev.offsetY), multiplier)
    } else {
      this.pan(new Vec2(ev.deltaX, ev.deltaY))
    }

    this.renderGL()
  }

  render() {
    // TODO(jlfwong): Handle node and/or window resizing

    const width = window.innerWidth
    const height = window.innerHeight

    return (
      <div
        className={css(style.fullscreen)}
        onWheel={this.onWheel}>
        <canvas
          width={width} height={height}
          ref={this.canvasRef}
          className={css(style.fill)} />
        {/*
          We render text at a higher resolution then scale down to
          ensure we're rendering at 1:1 device pixel ratio.
          This ensures our text is rendered crisply.
        */}
        <canvas
          width={width * DEVICE_PIXEL_RATIO} height={height * DEVICE_PIXEL_RATIO}
          ref={this.overlayCanvasRef}
          className={css(style.fill)} />
      </div>
    )
  }
}

const style = StyleSheet.create({
  fullscreen: {
    width: '100vw',
    height: '100vh',
  },
  fill: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    left: 0,
    top: 0
  }
})


interface RectangleBatchRendererProps {
  configSpaceToNDC: AffineTransform
}

export const rectangleBatchRenderer = (ctx: WebGLRenderingContext, rects: Rect[], colors: vec3[]) => {
  const positions: vec2[] = []
  const vertexColors: vec3[] = []

  const addRectangle = (r: Rect, color: vec3) => {
    function addVertex(v: Vec2) {
      positions.push(v.flatten())
      vertexColors.push(color)
    }

    addVertex(r.topLeft())
    addVertex(r.bottomLeft())
    addVertex(r.topRight())

    addVertex(r.bottomLeft())
    addVertex(r.topRight())
    addVertex(r.bottomRight())
  }

  for (let i = 0; i < rects.length; i++) {
    addRectangle(rects[i], colors[i])
  }

  return regl(ctx)<RectangleBatchRendererProps>({
    vert: `
      uniform mat3 configSpaceToNDC;
      attribute vec2 position;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = vec4((configSpaceToNDC * vec3(position, 1)).xy, 0, 1);
      }
    `,

    frag: `
      precision mediump float;
      varying vec3 vColor;
      void main() {
        gl_FragColor = vec4(vColor, 1);
      }
    `,

    attributes: {
      position: positions,
      color: vertexColors
    },

    uniforms: {
      configSpaceToNDC: (context, props) => {
        return props.configSpaceToNDC.flatten()
      }
    },

    primitive: 'triangles',

    count: vertexColors.length
  })
}