import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { createCompileOutput, validate } from '../server/compileOutput.ts'
import { insertCharacter, openMigratedDb, rectPath, tempDir } from './helpers.ts'

const dir = tempDir()
const { db } = openMigratedDb(dir)
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const okStroke = { stroke_order: 1, outline_path: rectPath(0, 0, 10, 10), median_points: [[1, 1], [9, 9]] as [number, number][], stroke_width: 70, is_radical: 0 }

test('validate: 획 없음·짧은 중심선·잘못된 경로를 각각 보고한다', () => {
  assert.deepEqual(validate('一', []), ['획이 없습니다.'])
  assert.deepEqual(validate('一', [okStroke]), [])
  assert.deepEqual(validate('一', [{ ...okStroke, median_points: [[1, 1]] }]), ['1획 중심선이 짧습니다.'])
  assert.deepEqual(validate('一', [okStroke, { ...okStroke, outline_path: 'M 0 0 L 1 1' }]), ['2획 경로가 올바르지 않습니다.'])
  assert.deepEqual(validate('一', [{ ...okStroke, outline_path: 'M 0 0 <x> Z' }]), ['1획 경로가 올바르지 않습니다.'])
})

function makeCompile(over: Record<string, unknown> = {}) {
  const issues: string[] = []
  const cleared: string[] = []
  const out = path.join(dir, 'compiled')
  fs.mkdirSync(out, { recursive: true })
  const base = { char: '一', working: false, reading: '일', radical: 1, font_outline: ['M 0 0 Z', 'M 1 1 Z'], origin: 'MMH', origin_url: null, strokes: [okStroke], ...over }
  const deps = {
    getCharacter: (unicode: string) => (unicode === 'U+4E00' ? (base as never) : null),
    setIssue: (_unicode: string, reason: string) => { issues.push(reason) },
    clearIssue: (unicode: string) => { cleared.push(unicode) },
  }
  return { compile: createCompileOutput(db, out, deps).compile, issues, cleared, out }
}

test('compile 골든: JSON 구조와 파일 출력', () => {
  insertCharacter(db, 'U+4E00', '一')
  const { compile, cleared, out } = makeCompile()
  const compiled = compile('U+4E00')
  assert.deepEqual(compiled, {
    schemaVersion: 1,
    character: '一',
    unicode: 'U+4E00',
    reading: '일',
    strokeCount: 1,
    coordinateSystem: { size: 1024, yAxis: 'up' },
    radical: { id: 1, char: compiled.radical!.char, origin: null, name: compiled.radical!.name, strokeIndices: [] },
    fullOutline: 'M 0 0 Z M 1 1 Z',
    strokes: [okStroke.outline_path],
    medians: [okStroke.median_points],
    strokeWidths: [70],
    source: { outline: 'MMH', medians: 'MMH' },
  })
  assert.deepEqual(cleared, ['U+4E00'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, '一.json'), 'utf8')), compiled)
  assert.match(fs.readFileSync(path.join(out, '一.svg'), 'utf8'), /^<svg id="z19968" class="acjk"/)
  const row = db.prepare('SELECT last_modified_by AS by FROM characters WHERE unicode = ?').get('U+4E00') as { by: string }
  assert.equal(row.by, 'user')
})

test('compile: 등록 안 된 글자·작업 데이터·검증 실패를 거부한다', () => {
  assert.throws(() => makeCompile().compile('U+9999'), /등록되지 않은/)
  assert.throws(() => makeCompile({ working: true }).compile('U+4E00'), /승인 전/)
  const bad = makeCompile({ strokes: [] })
  assert.throws(() => bad.compile('U+4E00'), /획이 없습니다/)
  assert.deepEqual(bad.issues, ['획이 없습니다.'])
  assert.equal(bad.cleared.length, 0, '실패하면 이슈를 지우지 않는다')
})

test('compile: 글자가 1자가 아니거나 경로를 벗어나면 거부한다', () => {
  assert.throws(() => makeCompile({ char: '一二' }).compile('U+4E00'), /1자만/)
  assert.throws(() => makeCompile({ char: '/' }).compile('U+4E00'), /경로가 올바르지 않습니다|ENOENT/)
})
