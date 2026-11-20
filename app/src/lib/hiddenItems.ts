/** 획·윤곽 목록에서 특정 인덱스의 숨김 상태를 토글한 새 집합을 돌려준다. */
export function toggleHiddenIndex(hidden: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(hidden)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  return next
}

/** totalCount개 중 index 항목만 단독 표시 중인지 확인한다. */
export function isIndexSoloed(totalCount: number, index: number, hidden: ReadonlySet<number>): boolean {
  if (totalCount <= 1 || index < 0 || index >= totalCount || hidden.has(index)) return false
  let hiddenValidCount = 0
  for (const i of hidden) {
    if (i >= 0 && i < totalCount) hiddenValidCount++
  }
  return hiddenValidCount === totalCount - 1
}

/** index 항목만 단독 표시하거나, 이미 단독 표시 중이면 전체 표시로 복원한 숨김 집합을 돌려준다. */
export function soloVisibleIndex(totalCount: number, index: number, hidden: ReadonlySet<number>): Set<number> {
  if (totalCount <= 1 || index < 0 || index >= totalCount) return new Set()
  if (isIndexSoloed(totalCount, index, hidden)) return new Set()
  const next = new Set<number>()
  for (let i = 0; i < totalCount; i++) {
    if (i !== index) next.add(i)
  }
  return next
}

/** 모든 유효 인덱스를 숨김 처리한 집합을 돌려준다. */
export function hideAllIndices(totalCount: number): Set<number> {
  const next = new Set<number>()
  for (let i = 0; i < totalCount; i++) next.add(i)
  return next
}

/** 항목 개수가 바뀐 뒤 0..count-1 범위 밖의 숨김 인덱스를 제거한다. */
export function pruneHiddenIndices(hidden: ReadonlySet<number>, count: number): Set<number> {
  const next = new Set<number>()
  for (const i of hidden) {
    if (i >= 0 && i < count) next.add(i)
  }
  return next
}

/** index와 index + delta 항목의 순서 이동에 맞춰 숨김 상태를 맞바꾼다. */
export function remapHiddenAfterMove(hidden: ReadonlySet<number>, index: number, delta: number): Set<number> {
  const target = index + delta
  if (delta === 0 || index < 0 || target < 0) return new Set(hidden)
  const next = new Set(hidden)
  const indexHidden = hidden.has(index)
  const targetHidden = hidden.has(target)
  if (targetHidden) next.add(index)
  else next.delete(index)
  if (indexHidden) next.add(target)
  else next.delete(target)
  return next
}

/** index 항목 삭제에 맞춰 이후 숨김 인덱스를 1씩 당긴다. */
export function remapHiddenAfterDelete(hidden: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set<number>()
  for (const i of hidden) {
    if (i < index) next.add(i)
    else if (i > index) next.add(i - 1)
  }
  return next
}

/** index와 index + 1 병합 시 병합 결과는 표시하고 이후 숨김 인덱스를 1씩 당긴다. */
export function remapHiddenAfterMerge(hidden: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set<number>()
  for (const i of hidden) {
    if (i < index) next.add(i)
    else if (i > index + 1) next.add(i - 1)
  }
  return next
}
