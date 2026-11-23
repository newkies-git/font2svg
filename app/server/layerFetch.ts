import type { DatabaseSync } from 'node:sqlite'
import { LAYER_ID } from '../shared/constants.ts'
import type { createCharacterCatalog } from './characterCatalog.ts'
import { patchLayersMeta } from './layerWrites.ts'
import { ACJK_BLOB, fetchHanja, fetchNaver, hanjaUrl, naverUrl } from './references.ts'
import type { createReferencePipeline } from './referencePipeline.ts'
import type { StrokeStore } from './strokeStore.ts'

type CharacterLookup = ReturnType<typeof createCharacterCatalog>['getCharacter']

// 외부 참고 레이어(네이버·AnimCJK·Hanzi)를 내려받아 표시 상태로 만든다.
export function createLayerFetch(
  db: DatabaseSync,
  deps: { strokes: StrokeStore; references: ReturnType<typeof createReferencePipeline>; getCharacter: CharacterLookup },
) {
  const { strokes, references, getCharacter } = deps

  // 외부 수신을 지원하는 레이어별 수신 방법. retryMiss는 "없음"으로 저장된 이전 결과를 지우고 다시 받는다(네이버는 사전이 갱신될 수 있다).
  const remoteLayers: Record<string, { retryMiss?: boolean; notFound: string; load: (unicode: string, char: string) => Promise<unknown> }> = {
    [LAYER_ID.naver]: {
      retryMiss: true,
      notFound: '네이버 한자사전에서 이 글자의 획순을 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'NAVER', naverUrl(char), () => fetchNaver(char)),
    },
    [LAYER_ID.acjk]: {
      notFound: 'AnimCJK에서 이 글자 데이터를 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'ACJK', ACJK_BLOB, () => references.fetchAcjk(char)),
    },
    [LAYER_ID.mmh]: {
      notFound: 'Hanzi(MMH)에서 이 글자 데이터를 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'MMH', hanjaUrl(char), () => fetchHanja(char)),
    },
  }

  async function fetchLayer(unicode: string, layerId: string) {
    const character = strokes.requireCharacter(unicode)
    const remote = Object.hasOwn(remoteLayers, layerId) ? remoteLayers[layerId] : undefined
    if (!remote) throw new Error('외부 수신을 지원하지 않는 레이어입니다.')
    if (remote.retryMiss) db.prepare(`DELETE FROM reference_data WHERE unicode = ? AND source = 'NAVER' AND found = 0`).run(unicode)
    if (!(await remote.load(unicode, character.char))) throw new Error(remote.notFound)
    patchLayersMeta(db, character.char, [{ id: layerId, visible: true }])
    return getCharacter(unicode)
  }

  return { fetchLayer }
}
