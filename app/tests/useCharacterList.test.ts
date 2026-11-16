import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { ref } from 'vue'
import { useCharacterList } from '../src/composables/useCharacterList.ts'
import type { CharacterSummary, IssueStatus } from '../shared/types.ts'

// onBeforeUnmount를 컴포넌트 밖에서 부르면 Vue가 경고를 찍는다. 시험 출력만 어지럽히므로 막는다.
beforeEach(() => { mock.method(console, 'warn', () => {}) })
afterEach(() => mock.restoreAll())

const row = (char: string, status: IssueStatus | null): CharacterSummary => ({
  unicode: `U+${char.codePointAt(0)!.toString(16).toUpperCase()}`, char, grade: null, issue_reason: null, issue_status: status, in_font: 1, origin: 'MMH',
  reading: null, meaning: null, stroke_count: 1, last_modified_at: '', last_modified_by: 'user',
})

function stubFetch(handler: (url: string, signal?: AbortSignal | null) => Promise<Response>) {
  return mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => handler(String(input), init?.signal))
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('목록을 불러오면서 검색어를 URL 인코딩해 보낸다', async () => {
  const urls: string[] = []
  stubFetch(async (url) => { urls.push(url); return json([row('丁', null)]) })
  const list = useCharacterList(ref(''))
  list.query.value = '정 & 일'
  await list.loadList()
  assert.equal(urls[0], `/api/characters?q=${encodeURIComponent('정 & 일')}`)
  assert.equal(list.chars.value.length, 1)
})

test('상태 필터와 개수: ALL은 전체, 그 외는 해당 상태만', async () => {
  stubFetch(async () => json([row('丁', 'OPEN'), row('丙', 'OPEN'), row('乙', 'DRAFT'), row('甲', 'APPROVED'), row('戊', null)]))
  const list = useCharacterList(ref(''))
  await list.loadList()
  assert.deepEqual(list.statusCounts.value, { ALL: 5, APPROVED: 1, DRAFT: 1, OPEN: 2 })
  assert.equal(list.filteredChars.value.length, 5)
  list.statusFilter.value = 'OPEN'
  assert.deepEqual(list.filteredChars.value.map((item) => item.char), ['丁', '丙'])
  list.statusFilter.value = 'APPROVED'
  assert.deepEqual(list.filteredChars.value.map((item) => item.char), ['甲'])
})

test('조회 실패: 서버 메시지를 오류로 올린다', async () => {
  stubFetch(async () => json({ error: '서버 점검 중' }, 503))
  const error = ref('')
  await useCharacterList(error).loadList()
  assert.equal(error.value, '서버 점검 중')
})

test('조회 실패: 서버 메시지가 없으면 기본 안내를 쓴다', async () => {
  stubFetch(async () => json({}, 500))
  const error = ref('')
  await useCharacterList(error).loadList()
  assert.equal(error.value, '한자 목록 조회 실패: 서버 연결 상태를 확인하세요.')
})

test('연속 조회: 앞선 요청을 취소하고 취소된 요청은 오류로 보이지 않는다', async () => {
  let call = 0
  const signals: (AbortSignal | null | undefined)[] = []
  stubFetch((_url, signal) => {
    signals.push(signal)
    call += 1
    if (call === 1) {
      // 느린 첫 요청: 취소되면 AbortError로 끝난다.
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    return Promise.resolve(json([row('丁', null)]))
  })
  const error = ref('')
  const list = useCharacterList(error)
  const first = list.loadList()
  const second = list.loadList()
  await Promise.all([first, second])
  assert.equal(signals[0]!.aborted, true)
  assert.equal(error.value, '', '취소는 오류가 아니다')
  assert.equal(list.chars.value.length, 1, '마지막 요청의 결과만 남는다')
})

test('검색 지우기: 검색어를 비우고 다시 불러온다', async () => {
  const urls: string[] = []
  stubFetch(async (url) => { urls.push(url); return json([]) })
  const list = useCharacterList(ref(''))
  list.query.value = '검색'
  list.clearSearch()
  assert.equal(list.query.value, '')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(urls[0], '/api/characters?q=')
})
