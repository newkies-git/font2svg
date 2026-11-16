import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { buildCharacterLayers } from '../server/layers.ts'
import { createOutlineMapping } from '../server/outlineMapping.ts'
import { splitOutlinePieces } from '../server/geometry.ts'
import type { StrokeRecord } from '../shared/types.ts'
import { insertCharacter, openMigratedDb, rectPath, strokeOf, tempDir } from './helpers.ts'

const UNICODE = 'U+4E01'
const CHAR = '丁'
// 글자: 서로 떨어진 두 가로 막대(윤곽 0, 1). 작업 획: 각 막대를 지나는 중심선 두 개.
// (정사각형은 골격이 퇴화해 분할이 매우 느려지므로 길쭉한 막대를 쓴다.)
const FONT_A = [rectPath(200, 200, 440, 260), rectPath(560, 600, 800, 660)]
const FONT_B = [rectPath(180, 200, 440, 260), rectPath(560, 600, 820, 660), rectPath(450, 400, 550, 450)]
const GUIDE: StrokeRecord[] = [
  strokeOf(rectPath(200, 200, 440, 260), [[210, 230], [430, 230]]),
  strokeOf(rectPath(560, 600, 800, 660), [[570, 630], [790, 630]], { stroke_order: 2 }),
]

// 작업 공간 없이 outlineMapping만 시험한다: 글자 상세를 buildCharacterLayers로 만들어 준다.
function setup() {
  const dir = tempDir()
  const { db } = openMigratedDb(dir)
  insertCharacter(db, UNICODE, CHAR)
  let fontContours = FONT_A
  const getCharacter = () => ({
    char: CHAR,
    font_outline: fontContours,
    layers: buildCharacterLayers(db, {
      unicode: UNICODE, char: CHAR, working: false, historyCount: 0, originUrl: null, strokes: GUIDE, fontContours,
    }),
  })
  const mapping = createOutlineMapping(db, { getCharacter })
  const outline = () => getCharacter().layers.find((layer) => layer.id === 'outline')!
  const cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  return { db, mapping, outline, setFont: (paths: string[]) => { fontContours = paths }, cleanup }
}

test('합성 글자: 획마다 놓인 윤곽을 찾는다', () => {
  const pieces = splitOutlinePieces(FONT_A, GUIDE.map((s) => s.median_points))
  assert.ok(pieces)
  assert.deepEqual(pieces.map((piece) => piece.contours), [[0], [1]])
})

test('자동 매핑: outline 레이어가 만들어지고 지문이 기록된다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    const layer = t.outline()
    assert.equal(layer.strokes.length, 2)
    assert.deepEqual(layer.strokes.map((s) => s.font_contours), [[0], [1]])
    assert.ok(layer.strokes.every((s) => s.map_manual === 0 && /^[0-9a-f]{12}$/.test(s.font_hash ?? '')))
    assert.equal(layer.stale, false)
  } finally { t.cleanup() }
})

test('수동 매핑: 윤곽을 합쳐 획 모양으로 쓰고, 다시 만들어도 유지된다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    t.mapping.mapStroke(UNICODE, 0, [0, 1])
    let stroke = t.outline().strokes[0]
    assert.deepEqual(stroke.font_contours, [0, 1])
    assert.equal(stroke.map_manual, 1)
    assert.equal(stroke.outline_path, `${FONT_A[0]} ${FONT_A[1]}`)
    t.mapping.generate(UNICODE)
    stroke = t.outline().strokes[0]
    assert.equal(stroke.map_manual, 1, '자동 매핑을 다시 해도 수동 획은 유지')
    assert.deepEqual(stroke.font_contours, [0, 1])
  } finally { t.cleanup() }
})

test('매핑 해제: 중심선 띠 모양으로 되돌리고 미매핑이 된다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    t.mapping.mapStroke(UNICODE, 1, [])
    const stroke = t.outline().strokes[1]
    assert.deepEqual(stroke.font_contours, [])
    assert.equal(stroke.map_manual, 0)
  } finally { t.cleanup() }
})

test('잘못된 입력은 거부한다', () => {
  const t = setup()
  try {
    assert.throws(() => t.mapping.mapStroke(UNICODE, 0, [0]), /매핑할 획이 없습니다/)
    t.mapping.generate(UNICODE)
    assert.throws(() => t.mapping.mapStroke(UNICODE, 0, [99]), /존재하지 않는 궁서체 윤곽/)
    assert.throws(() => t.mapping.mapStroke(UNICODE, 0, 'x'), /형식/)
    assert.throws(() => t.mapping.mapStroke(UNICODE, 7, [0]), /매핑할 획이 없습니다/)
  } finally { t.cleanup() }
})

test('획 수가 달라진 수동 작업은 자동 재생성이 덮어쓰지 못한다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    const [first, second] = t.outline().strokes
    // 나이프로 한 획을 둘로 가른 상황: 수동 표시된 3획
    t.db.prepare(`UPDATE character_layers SET strokes_json = ? WHERE char = ? AND layer_id = 'outline'`)
      .run(JSON.stringify([first, { ...second, map_manual: 1 }, { ...second, map_manual: 1 }]), CHAR)
    assert.throws(() => t.mapping.generate(UNICODE), /레이어를 원본으로 초기화/)
  } finally { t.cleanup() }
})

test('궁서체 윤곽이 바뀌면 stale이 되고, 수동 매핑은 거부되며, 갱신하면 풀린다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    assert.equal(t.outline().stale, false)

    t.setFont(FONT_B)
    assert.equal(t.outline().stale, true)
    assert.throws(() => t.mapping.mapStroke(UNICODE, 0, [0]), /매핑 갱신/)

    t.mapping.refresh(UNICODE)
    const layer = t.outline()
    assert.equal(layer.stale, false)
    assert.ok(layer.strokes.every((s) => Array.isArray(s.font_contours)))
    // 획 모양은 바뀌지 않는다
    assert.equal(layer.strokes[0].outline_path, t.outline().strokes[0].outline_path)
  } finally { t.cleanup() }
})

test('갱신: 윤곽이 추가되어 번호가 밀려도 획 모양으로 인덱스를 다시 구한다', () => {
  const t = setup()
  try {
    t.mapping.generate(UNICODE)
    // 새 윤곽을 맨 앞에 끼워 넣어 기존 번호가 한 칸씩 밀린 경우
    const shifted = [rectPath(10, 10, 90, 40), ...FONT_A]
    t.setFont(shifted)
    assert.equal(t.outline().stale, true)
    t.mapping.refresh(UNICODE)
    assert.deepEqual(t.outline().strokes.map((s) => s.font_contours), [[1], [2]])
    assert.equal(t.outline().stale, false)
  } finally { t.cleanup() }
})

test('갱신할 매핑이 없으면 오류', () => {
  const t = setup()
  try {
    assert.throws(() => t.mapping.refresh(UNICODE), /갱신할 매핑이 없습니다/)
  } finally { t.cleanup() }
})

test('fontContours가 없는 글자는 자동 매핑 불가', () => {
  const t = setup()
  try {
    t.setFont([])
    assert.throws(() => t.mapping.generate(UNICODE), /궁서체 윤곽이 없어/)
  } finally { t.cleanup() }
})

export type { DatabaseSync }
