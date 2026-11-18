import type { Ref } from 'vue'
import { LAYER_ID, MISSING_FETCH_LIMIT, type ImageSplit } from '../../shared/constants.ts'
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
}

// 글자 단위 동작: 열기, 서버에서 레퍼런스 받기, 승인, SVG·이미지 가져오기, 네이버 적용, 되돌리기, 컴파일, 일괄 조회.
// 레이어 편집·저장은 useLayerWorkspace가 맡는다.
export function useCharacterActions(studio: StudioState, deps: CharacterActionsDeps) {
  const { selected, message, error, busy } = studio
  const { chars, loadList, syncFromDetail, saveAllDirtyLayers, dirtyIds, stopPlayback, workStrokeCount, confirmReplace } = deps
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
      message.value = `${body.imported}자 등록 완료. 한자 선택 시 레퍼런스 획 데이터를 수신합니다.`
      await loadList()
    }, '초기 파일 업로드 실패: 파일 형식과 인코딩을 확인하세요.')
  }

  async function openChar(row: CharacterSummary) {
    stopPlayback()
    await run(async () => {
      const detail = await apiRequest<CharacterDetail>(characterUrl(row.unicode), '한자 정보 조회 실패: 잠시 후 다시 시도하세요.')
      if (detail.strokes.length === 0 && !detail.issue_status) {
        await apiRequest(characterUrl(row.unicode, 'reference'), '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.', { method: 'POST' })
        return openChar(row)
      }
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

  async function pullReference() {
    const current = selected.value
    if (!current) return
    await run(async () => {
      const body = await apiRequest<{ source: string }>(
        characterUrl(current.unicode, 'reference'),
        '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.',
        { method: 'POST' },
      )
      message.value = body.source === 'NONE' ? '참조 출처(Hanja, IDS) 검색 결과 없음' : `${body.source} 레퍼런스 데이터 반영 완료`
      await reload()
    }, '레퍼런스 데이터 수신 실패: 네트워크 상태를 확인하세요.')
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
    if (workStrokeCount() > 0) {
      const confirmed = await confirmReplace()
      if (!confirmed) return
    }
    await run(async () => {
      await apiRequest(characterUrl(current.unicode, 'apply-naver'), '네이버 획순 적용 실패: 잠시 후 다시 시도하세요.', { method: 'POST' })
      message.value = '네이버 한자사전 획순을 적용했습니다.'
      await reload()
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

  async function syncMissing() {
    await run(async () => {
      const body = await apiRequest<{ tried: number }>(
        apiUrl('sync-missing'),
        '일괄 레퍼런스 조회 실패: 서버 상태를 확인하세요.',
        { method: 'POST', body: { limit: MISSING_FETCH_LIMIT } },
      )
      message.value = `미완료 한자 ${body.tried}자 레퍼런스 조회 완료`
      await loadList()
    }, '일괄 레퍼런스 조회 실패: 네트워크 상태를 확인하세요.')
  }

  return { uploadInitial, openChar, openFirst, reload, pullReference, approve, importSvg, importImage, applyNaver, undo, compileChar, syncMissing }
}
