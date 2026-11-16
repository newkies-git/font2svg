import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMedianLines, parseStringArray, parseStrokeOutlines } from '../server/storedJson.ts'

test('parseStringArray: 문자열 배열만 받고 오류에 데이터 이름을 밝힌다', () => {
  assert.deepEqual(parseStringArray('["a","b"]', '다른 음'), ['a', 'b'])
  assert.deepEqual(parseStringArray('[]', '다른 음'), [])
  assert.throws(() => parseStringArray('[1]', '다른 음'), /저장된 다른 음 데이터의 형식/)
  assert.throws(() => parseStringArray('{}', '다른 음'), /형식이 올바르지 않습니다/)
  assert.throws(() => parseStringArray('깨짐', '다른 음'), /저장된 다른 음 데이터를 읽을 수 없습니다/)
})

test('parseStrokeOutlines: order와 path가 있는 항목만 받는다', () => {
  const ok = [{ order: 1, path: 'M 0 0 Z', radical: 0 }]
  assert.deepEqual(parseStrokeOutlines(JSON.stringify(ok)), ok)
  assert.throws(() => parseStrokeOutlines('[{"order":"1","path":"M"}]'), /획 윤곽/)
  assert.throws(() => parseStrokeOutlines('[null]'), /획 윤곽/)
  assert.throws(() => parseStrokeOutlines('"x"'), /획 윤곽/)
})

test('parseMedianLines: 점은 숫자 쌍이어야 하고 캡 종류는 요구하지 않는다', () => {
  const ok = [{ order: 1, points: [[0, 0], [1, 1]], width: 70 }]
  assert.deepEqual(parseMedianLines(JSON.stringify(ok)), ok)
  assert.throws(() => parseMedianLines('[{"order":1,"points":[[0]],"width":70}]'), /중심선/)
  assert.throws(() => parseMedianLines('[{"order":1,"points":[[0,"a"]],"width":70}]'), /중심선/)
  assert.throws(() => parseMedianLines('[{"order":1,"points":[],"width":"70"}]'), /중심선/)
})
