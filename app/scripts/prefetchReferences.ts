import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REFERENCE_PREFETCH_LOG_STEP } from '../shared/constants.ts'
import { PREFETCH_ORDER, type PrefetchSource } from '../server/referencePipeline.ts'
import { createWorkspace } from '../server/workspace.ts'

// 참고 획순(Hanzi → 네이버)을 전 글자 내려받아 database/chusa1817.db의 reference_data에 저장한다.
// 이미 저장된 글자는 건너뛰므로 중간에 멈춰도 다시 실행하면 이어서 받는다. 테이블이 없으면 열 때 만든다.
// NAVER를 받는 경우 끝에서 글자별 획수도 NAVER 기준으로 맞춘다.
// 사용법: npm run prefetch:refs [-- --retry-missing] [-- mmh|naver]
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rootDir = path.join(appDir, '..')
const args = process.argv.slice(2)
const retryMissing = args.includes('--retry-missing')
const picked = PREFETCH_ORDER.filter((source) => args.some((arg) => arg.toUpperCase() === source))
const sources: readonly PrefetchSource[] = picked.length > 0 ? picked : PREFETCH_ORDER

const ws = createWorkspace(rootDir)
try {
  for (const source of sources) {
    console.log(`[${source}] 받기 시작`)
    const [summary] = await ws.prefetchReferences([source], {
      retryMissing,
      onProgress: (done, total) => {
        if (done % REFERENCE_PREFETCH_LOG_STEP === 0 || done === total) console.log(`[${source}] ${done}/${total}`)
      },
    })
    console.log(`[${source}] 전체 ${summary.total}자 · 이미 저장 ${summary.cached} · 이번에 있음 ${summary.found} · 없음 ${summary.missing} · 실패 ${summary.failed.length}`)
    if (summary.failed.length > 0) console.log(`[${source}] 실패한 글자(다시 실행하면 이어서 받음): ${summary.failed.join('')}`)
  }
  // 획 정보의 기준은 NAVER다: 작업 획이 없는 글자의 획수를 저장된 NAVER 원본 획수에 맞춘다.
  if (sources.includes('NAVER')) {
    const { checked, updated } = ws.syncStrokeCountsFromNaver()
    console.log(`[획수] NAVER 기준으로 ${checked}자를 확인해 ${updated}자의 획수를 맞췄습니다.`)
  }
} finally {
  ws.close()
}
