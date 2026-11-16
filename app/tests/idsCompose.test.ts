import assert from 'node:assert/strict'
import test from 'node:test'
import { CANVAS, IDS_MAX_DEPTH } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
import { composeFrom, type IdsLookup } from '../server/idsCompose.ts'

// 한 획짜리 가로선: 글자 칸 전체를 채우는 모양
const BAR: Pt[][] = [[[0, 0], [CANVAS, 0]]]
const lookupOf = (known: Record<string, Pt[][]>, parts: Record<string, string[]> = {}): IdsLookup => ({
  knownMedians: (char) => known[char] ?? [],
  decompositions: (char) => parts[char] ?? [],
})
const boundsOf = (medians: Pt[][]) => {
  const points = medians.flat()
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  }
}

test('⿰는 두 부품을 왼쪽·오른쪽 반씩에 놓는다', () => {
  const medians = composeFrom('⿰一一', lookupOf({ 一: BAR }))
  assert.ok(medians)
  assert.equal(medians.length, 2)
  assert.ok(boundsOf([medians[0]]).maxX <= CANVAS / 2)
  assert.ok(boundsOf([medians[1]]).minX >= CANVAS / 2)
})

test('⿱는 위 부품이 먼저 오고 y 위쪽(큰 값) 칸에 놓인다', () => {
  const medians = composeFrom('⿱一一', lookupOf({ 一: BAR }))
  assert.ok(medians)
  assert.ok(boundsOf([medians[0]]).minY >= CANVAS / 2)
  assert.ok(boundsOf([medians[1]]).maxY <= CANVAS / 2)
})

test('변형 부수는 원래 글자의 획을 쓴다', () => {
  const medians = composeFrom('⿰亻一', lookupOf({ 人: BAR, 一: BAR }))
  assert.equal(medians?.length, 2)
})

test('획이 없는 부품은 그 글자의 IDS로 한 번 더 쪼갠다', () => {
  const medians = composeFrom('⿰甲一', lookupOf({ 一: BAR }, { 甲: ['⿱一一'] }))
  assert.equal(medians?.length, 3, '甲이 두 획, 一이 한 획')
})

test('쪼갠 IDS가 여러 개면 합성되는 첫 후보를 쓴다', () => {
  const medians = composeFrom('⿰甲一', lookupOf({ 一: BAR }, { 甲: ['⿱無一', '⿱一一'] }))
  assert.equal(medians?.length, 3)
})

test('부품 하나라도 획을 구하지 못하면 전체가 null이다', () => {
  assert.equal(composeFrom('⿰一乙', lookupOf({ 一: BAR })), null)
})

test('깊이 한도를 넘는 분해는 null이다', () => {
  const chain: Record<string, string[]> = {}
  const chars = ['甲', '乙', '丙', '丁', '戊', '己']
  for (let index = 0; index < chars.length - 1; index++) chain[chars[index]] = [`⿰${chars[index + 1]}一`]
  assert.ok(IDS_MAX_DEPTH < chars.length - 1)
  assert.equal(composeFrom('⿰甲一', lookupOf({ 一: BAR, 己: BAR }, chain)), null)
})

test('글자 하나짜리나 해석할 수 없는 IDS는 null이다', () => {
  assert.equal(composeFrom('一', lookupOf({ 一: BAR })), null)
  assert.equal(composeFrom('⿰一', lookupOf({ 一: BAR })), null)
  assert.equal(composeFrom('⿰一{1}', lookupOf({ 一: BAR })), null)
})
