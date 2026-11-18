import {
  GRAY_LEVELS,
  GRAY_MAX,
  CANVAS,
  IMAGE_FIT_MARGIN,
  IMAGE_INVERT_RATIO,
  IMAGE_MASK_PAD,
  IMAGE_MAX_COMPONENTS,
  IMAGE_MIN_COMPONENT_RATIO,
  LUMA_BLUE,
  LUMA_GREEN,
  LUMA_RED,
} from './constants.ts'
import { connectedComponents } from './strokeCut/mask.ts'
import { outlineOfMask } from './strokeCut/contour.ts'
import type { Raster } from './strokeCut/raster.ts'

// 래스터 이미지(RGBA)를 글자 윤곽 경로로 바꾸는 순수 계산. 이미지를 읽는 일(디코딩)은 화면이 하고, 여기서는 픽셀만 다룬다.
// 좌표는 저장 좌표계(0~CANVAS, y축 위쪽)이고, 윤곽 추적·단순화는 궁서체 윤곽 분할과 같은 모듈(strokeCut)을 쓴다.

const BYTES_PER_PIXEL = 4

// 투명한 픽셀은 흰 배경 위에 얹은 것처럼 합성해 0~255 밝기로 바꾼다.
export function grayscaleOf(rgba: ArrayLike<number>, pixelCount: number): Uint8Array {
  const gray = new Uint8Array(pixelCount)
  for (let index = 0; index < pixelCount; index++) {
    const offset = index * BYTES_PER_PIXEL
    const alpha = rgba[offset + 3] / GRAY_MAX
    const luma = rgba[offset] * LUMA_RED + rgba[offset + 1] * LUMA_GREEN + rgba[offset + 2] * LUMA_BLUE
    gray[index] = Math.round(luma * alpha + GRAY_MAX * (1 - alpha))
  }
  return gray
}

// Otsu 방법: 어두운 쪽과 밝은 쪽의 분산 차이가 가장 큰 밝기를 경계로 삼는다. 이 값 이하가 '어두운 쪽'이다.
export function otsuThreshold(gray: Uint8Array): number {
  const histogram = new Array<number>(GRAY_LEVELS).fill(0)
  for (const value of gray) histogram[value] += 1
  let weightedTotal = 0
  for (let level = 0; level < GRAY_LEVELS; level++) weightedTotal += level * histogram[level]
  let darkCount = 0
  let darkSum = 0
  let best = 0
  let bestVariance = -1
  for (let level = 0; level < GRAY_LEVELS; level++) {
    darkCount += histogram[level]
    if (darkCount === 0) continue
    const lightCount = gray.length - darkCount
    if (lightCount === 0) break
    darkSum += level * histogram[level]
    const darkMean = darkSum / darkCount
    const lightMean = (weightedTotal - darkSum) / lightCount
    const variance = darkCount * lightCount * (darkMean - lightMean) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      best = level
    }
  }
  return best
}

// 밝기가 threshold 이하인 쪽을 잉크로 본다. 어두운 쪽이 절반을 넘으면(밝은 글씨·어두운 배경) 반전해야 한다.
export function shouldInvert(gray: Uint8Array, threshold: number): boolean {
  let dark = 0
  for (const value of gray) if (value <= threshold) dark += 1
  return dark > gray.length * IMAGE_INVERT_RATIO
}

export function binarize(gray: Uint8Array, threshold: number, invert: boolean): Uint8Array {
  const mask = new Uint8Array(gray.length)
  for (let index = 0; index < gray.length; index++) mask[index] = (gray[index] <= threshold) !== invert ? 1 : 0
  return mask
}

export type TracedGlyph = { contours: string[]; components: number }

// 이진 마스크에서 글자 윤곽을 뽑는다. 이어진 덩어리 하나가 윤곽 경로 하나(안쪽 구멍 포함)이다.
// 잡음 덩어리를 버리고, 남은 글자를 여백을 두고 저장 좌표계 한가운데에 맞춘다. 덩어리는 읽는 순서(위→아래, 왼→오른)로 돌려준다.
export function traceImageMask(mask: Uint8Array, width: number, height: number): TracedGlyph {
  const all = connectedComponents(mask, width, height)
  const total = all.reduce((sum, pixels) => sum + pixels.length, 0)
  if (total === 0) throw new Error('이미지에서 글자를 찾지 못했습니다. 글자와 배경의 밝기 차이를 확인하세요.')
  const kept = all.filter((pixels) => pixels.length >= total * IMAGE_MIN_COMPONENT_RATIO)
  if (kept.length > IMAGE_MAX_COMPONENTS) {
    throw new Error(`글자 덩어리가 ${kept.length}개로 너무 많습니다. 배경이 복잡하거나 흑백 구분이 잘못된 이미지입니다.`)
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (const pixels of kept) {
    for (const index of pixels) {
      const x = index % width
      const y = Math.floor(index / width)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const glyphWidth = maxX - minX + 1
  const glyphHeight = maxY - minY + 1
  const maskWidth = glyphWidth + IMAGE_MASK_PAD * 2
  const maskHeight = glyphHeight + IMAGE_MASK_PAD * 2

  // 글자의 긴 변이 (CANVAS - 2 × 여백)가 되게 늘리고 가운데에 놓는다. Raster.scale은 저장 좌표 1단위당 픽셀 수다.
  const pixelsPerUnit = Math.max(glyphWidth, glyphHeight) / (CANVAS - 2 * IMAGE_FIT_MARGIN)
  const raster: Raster = {
    w: maskWidth,
    h: maskHeight,
    ink: new Uint8Array(0),
    pad: IMAGE_MASK_PAD,
    scale: pixelsPerUnit,
    minX: (CANVAS - glyphWidth / pixelsPerUnit) / 2,
    maxY: CANVAS - (CANVAS - glyphHeight / pixelsPerUnit) / 2,
  }

  const pieces = kept.map((pixels) => {
    const componentMask = new Uint8Array(maskWidth * maskHeight)
    let sumX = 0
    let sumY = 0
    for (const index of pixels) {
      const x = index % width
      const y = Math.floor(index / width)
      componentMask[(y - minY + IMAGE_MASK_PAD) * maskWidth + (x - minX + IMAGE_MASK_PAD)] = 1
      sumX += x
      sumY += y
    }
    return { path: outlineOfMask(componentMask, raster), centerX: sumX / pixels.length, centerY: sumY / pixels.length }
  })
  const contours = pieces
    .filter((piece): piece is { path: string; centerX: number; centerY: number } => piece.path !== null)
    .sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX)
    .map((piece) => piece.path)
  if (contours.length === 0) throw new Error('글자 윤곽을 만들지 못했습니다.')
  return { contours, components: contours.length }
}
