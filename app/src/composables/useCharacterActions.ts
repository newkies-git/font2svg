import type { Ref } from 'vue'
import { LAYER_ID, type ImageSplit } from '../../shared/constants.ts'
import type { CharacterDetail, CharacterSummary } from '../../shared/types.ts'
import { apiRequest, apiUrl, characterUrl } from '../lib/api.ts'
import { buildImageImport } from '../lib/imageDecode.ts'
import { issueLabel } from '../lib/labels.ts'
import { createBusyRunner } from './useBusyAction.ts'
import type { StudioState } from './useStudioState.ts'

type CharacterActionsDeps = {
  chars: Ref<CharacterSummary[]>
  loadList: () => Promise<void>
  syncFromDetail: (detail: CharacterDetail) => void
  saveAllDirtyLayers: () => Promise<void>
  dirtyIds: Ref<Set<string>>
  stopPlayback: () => void
  workStrokeCount: () => number
  // 작업 획을 덮어써도 되는지 사용자에게 묻는다. 확인 창이 없으면 undefined.
  confirmReplace: () => Promise<boolean | undefined>
  // 참고 획을 작업 획으로 가져올 때 초기화(replace)와 추가(append) 중 고른다. 확인 창이 없으면 undefined.
  confirmImport: () => Promise<'replace' | 'append' | null | undefined>
  // 가져온 뒤 맞지 않는 획을 작업 획에서 바로 고를 수 있게 한다.
  focusWorkStroke?: (index: number) => void
}

// 글자 단위 동작: 열기, 승인, SVG·이미지 가져오기, 네이버 적용, 되돌리기, 컴파일.
// 글자를 열 때 레퍼런스·IDS로 작업 획을 자동으로 채우지 않는다.
// 레이어 편집·저장은 useLayerWorkspace가 맡는다.
export function useCharacterActions(studio: StudioState, deps: CharacterActionsDeps) {
  const { selected, message, error, busy } = studio
  const { chars, loadList, syncFromDetail, saveAllDirtyLayers, dirtyIds, stopPlayback, workStrokeCount, confirmReplace, confirmImport, focusWorkStroke } = deps
  const run = createBusyRunner(busy, error)

  async function uploadInitial(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    await run(async () => {
      const entries = JSON.parse(await file.text()) as unknown
      const body = await apiRequest<{ imported: number }>(
        apiUrl('import'),
        '파일 업로드 실패: 올바른 한자 JSON 형식인지 확인하세요.',
        { method: 'POST', body: { entries } },
      )
      message.value = `${body.imported}자 등록 완료. 획은 네이버·SVG·이미지로 직접 가져오세요.`
      await loadList()
    }, '초기 파일 업로드 실패: 파일 형식과 인코딩을 확인하세요.')
  }

  async function openChar(row: CharacterSummary) {
    stopPlayback()
    await run(async () => {
      const detail = await apiRequest<CharacterDetail>(characterUrl(row.unicode), '한자 정보 조회 실패: 잠시 후 다시 시도하세요.')
      selected.value = detail
      syncFromDetail(detail)
      message.value = [
        detail.char,
        detail.reading,
        detail.origin ? `출처 ${detail.origin}` : '',
        issueLabel(detail),
        detail.issue_status === 'OPEN' ? detail.issue_reason : '',
      ]
        .filter(Boolean)
        .join(' · ')
    }, '한자 상세 정보 조회 실패: 잠시 후 다시 시도하세요.')
  }

  async function openFirst() {
    if (chars.value.length > 0) await openChar(chars.value[0])
  }

  // 목록을 새로 받고 보던 글자를 다시 연다.
  async function reload() {
    if (!selected.value) return
    const unicode = selected.value.unicode
    await loadList()
    const row = chars.value.find((item) => item.unicode === unicode)
    if (row) await openChar(row)
  }

  async function approve() {
    const current = selected.value
    if (!current) return
    await run(async () => {
      await apiRequest(characterUrl(current.unicode, 'approve'), '승인 실패: 작업 데이터를 확인하세요.', { method: 'POST' })
      message.value = '작업 데이터를 승인해 최종 획(strokes)으로 옮겼습니다.'
      await reload()
    }, '승인 실패: 서버 상태를 확인하세요.')
  }

  async function importSvg(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const current = selected.value
    if (!current || !file) return
    await run(async () => {
      await apiRequest(
        characterUrl(current.unicode, 'import-svg'),
        'SVG 가져오기 실패: AnimCJK 형식 SVG인지 확인하세요.',
        { method: 'POST', body: { svg: await file.text() } },
      )
      message.value = 'SVG를 작업 데이터로 가져왔습니다. 확인 후 승인하세요.'
      await reload()
    }, 'SVG 가져오기 실패: 서버 상태를 확인하세요.')
  }

  // 이미지(PNG·JPEG·WebP)를 읽어 윤곽을 뽑고 서버에서 획으로 나눠 저장한다. 변환 내용은 서버가 DB(conversions)에 기록한다.
  // 이미 획이 있는 글자는 그 획을 교체하므로 먼저 확인을 받는다(바뀌기 전 획은 이력에 남아 실행 취소할 수 있다).
  async function importImage(event: Event, split: ImageSplit) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const current = selected.value
    if (!current || !file) return
    if (!current.working && workStrokeCount() > 0) {
      const confirmed = await confirmReplace()
      if (!confirmed) return
    }
    await run(async () => {
      const body = await buildImageImport(file)
      await apiRequest(
        characterUrl(current.unicode, 'import-image'),
        '이미지 변환 실패: 이미지와 글자 위치를 확인하세요.',
        { method: 'POST', body: { ...body, split } },
      )
      message.value = `${file.name}을(를) 획으로 변환했습니다. 확인 후 편집하세요.`
      await reload()
    }, '이미지 변환 실패: 이미지 형식과 서버 상태를 확인하세요.')
  }

  async function applyNaver() {
    const current = selected.value
    if (!current) return
    let write: 'replace' | 'append' = 'replace'
    if (workStrokeCount() > 0) {
      const choice = await confirmImport()
      if (choice !== 'replace' && choice !== 'append') return
      write = choice
    }
    await run(async () => {
      const applied = await apiRequest<CharacterDetail & { fit_status?: string; unmatched_strokes?: number[] }>(
        characterUrl(current.unicode, 'apply-naver'),
        '네이버 획순 적용 실패: 잠시 후 다시 시도하세요.',
        { method: 'POST', body: { write } },
      )
      await reload()
      const orders = applied.unmatched_strokes ?? []
      message.value = !applied.fit_status
        ? (write === 'append' ? '네이버 한자사전 획을 작업 획 뒤에 추가했습니다.' : '네이버 한자사전 획순을 적용했습니다.')
        : applied.fit_status === 'no-font'
          ? '궁서체 윤곽이 없어 네이버 획을 그대로 가져왔습니다. 작업 획에서 각 획을 편집하세요.'
          : orders.length > 0
            ? `네이버 획을 궁서체에 맞췄습니다. ${orders.join('·')}획은 맞지 않아 그 획을 편집할 수 있습니다.`
            : '네이버 획을 궁서체(기본 레이어)에 맞춰 작업 획으로 가져왔습니다. 획은 작업 획에서 하나씩 고칠 수 있습니다.'
      if (orders.length > 0) focusWorkStroke?.(orders[0] - 1)
    }, '네이버 획순 적용 실패: 네트워크 상태를 확인하세요.')
  }

  async function undo() {
    const current = selected.value
    if (!current) return
    try {
      const detail = await apiRequest<CharacterDetail>(characterUrl(current.unicode, 'undo'), '되돌리기 실패: 이전 편집 이력이 없습니다.', { method: 'POST' })
      selected.value = detail
      syncFromDetail(detail)
      message.value = '이전 편집 상태로 복원 완료'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '되돌리기 실패: 이전 편집 이력이 없습니다.'
    }
  }

  async function compileChar() {
    const current = selected.value
    if (!current) return
    if (dirtyIds.value.has(LAYER_ID.strokes)) {
      await saveAllDirtyLayers()
      if (error.value) return
    }
    try {
      await apiRequest(characterUrl(current.unicode, 'compile'), '컴파일 실패: 획 데이터 유효성을 확인하세요.', { method: 'POST' })
      message.value = '배포용 컴파일 JSON 생성 완료'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '컴파일 실패: 획 데이터 유효성을 확인하세요.'
    }
    await reload()
  }

  return { uploadInitial, openChar, openFirst, reload, approve, importSvg, importImage, applyNaver, undo, compileChar }
}
