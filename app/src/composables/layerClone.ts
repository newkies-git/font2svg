import type { LayerRecord, Pt, StrokeRecord } from '../types.ts'

export function cloneStroke(s: StrokeRecord): StrokeRecord {
  return {
    ...s,
    median_points: s.median_points.map((p): Pt => [p[0], p[1]]),
  }
}

export function cloneLayer(layer: LayerRecord): LayerRecord {
  return {
    ...layer,
    strokes: layer.strokes.map(cloneStroke),
    paths: layer.paths.slice(),
  }
}
