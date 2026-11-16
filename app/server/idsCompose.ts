import { IDS_MAX_DEPTH } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
import { fitMedians, type Box } from './geometry.ts'
import { IDS_LAYOUTS, LEAF_FORMS, parseIds, WHOLE_BOX, type IdsNode } from './ids.ts'

// 합성에 필요한 글자 정보. DB와 IDS 파일을 직접 알지 않아도 되게 바깥에서 넘겨 받는다.
export type IdsLookup = {
  // 이미 획이 있는 글자의 중심선(없으면 빈 배열)
  knownMedians: (char: string) => Pt[][]
  // 글자를 한 단계 쪼갠 IDS 후보
  decompositions: (char: string) => string[]
}

// 글자의 획이 있으면 box에 맞춰 쓰고, 없으면 IDS로 한 단계 더 쪼갠다.
function mediansOfChar(char: string, box: Box, depth: number, lookup: IdsLookup): Pt[][] | null {
  const known = lookup.knownMedians(char)
  if (known.length > 0) return fitMedians(known, box)
  if (depth >= IDS_MAX_DEPTH) return null
  for (const ids of lookup.decompositions(char)) {
    const node = parseIds(ids)
    const medians = node && composeNode(node, box, depth + 1, lookup)
    if (medians?.length) return medians
  }
  return null
}

function composeNode(node: IdsNode, box: Box, depth: number, lookup: IdsLookup): Pt[][] | null {
  if ('leaf' in node) return mediansOfChar(LEAF_FORMS[node.leaf] ?? node.leaf, box, depth, lookup)
  const layout = IDS_LAYOUTS[node.op]
  const [left, bottom, right, top] = box
  const medians: Pt[][] = []
  for (let index = 0; index < layout.length; index++) {
    const [x0, y0, x1, y1] = layout[index]
    const sub: Box = [left + x0 * (right - left), bottom + y0 * (top - bottom), left + x1 * (right - left), bottom + y1 * (top - bottom)]
    const part = composeNode(node.children[index], sub, depth, lookup)
    if (!part) return null
    medians.push(...part)
  }
  return medians
}

// IDS 문자열 하나를 글자 전체 칸에 합성한 중심선. 글자 하나짜리(leaf)이거나 합성이 안 되면 null.
export function composeFrom(ids: string, lookup: IdsLookup): Pt[][] | null {
  const node = parseIds(ids)
  if (!node || 'leaf' in node) return null
  const medians = composeNode(node, WHOLE_BOX, 0, lookup)
  return medians?.length ? medians : null
}
