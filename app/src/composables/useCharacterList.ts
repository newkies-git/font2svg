import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import type { CharacterSummary, IssueStatus, StatusFilter } from '../types.ts'

export function useCharacterList(error: Ref<string>) {
  const chars = ref<CharacterSummary[]>([])
  const query = ref('')
  const statusFilter = ref<StatusFilter>('ALL')

  // Search AbortController to prevent race conditions
  let listAbortController: AbortController | null = null

  const filteredChars = computed(() => {
    if (statusFilter.value === 'ALL') return chars.value
    return chars.value.filter((c) => c.issue_status === statusFilter.value)
  })

  const statusCounts = computed(() => {
    const counts: Record<StatusFilter, number> = { ALL: chars.value.length, APPROVED: 0, DRAFT: 0, OPEN: 0 }
    for (const c of chars.value) {
      if (c.issue_status && c.issue_status in counts) {
        counts[c.issue_status as IssueStatus]++
      }
    }
    return counts
  })

  async function loadList() {
    if (listAbortController) {
      listAbortController.abort()
    }
    listAbortController = new AbortController()

    try {
      const response = await fetch(`/api/characters?q=${encodeURIComponent(query.value)}`, {
        signal: listAbortController.signal,
      })
      if (!response.ok) throw new Error('한자 목록 조회 실패: 서버 연결 상태를 확인하세요.')
      chars.value = await response.json()
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      error.value = cause instanceof Error ? cause.message : '한자 목록 조회 실패: 잠시 후 다시 시도하세요.'
    }
  }

  function clearSearch() {
    query.value = ''
    loadList()
  }

  onBeforeUnmount(() => {
    if (listAbortController) listAbortController.abort()
  })

  return { chars, query, statusFilter, filteredChars, statusCounts, loadList, clearSearch }
}
