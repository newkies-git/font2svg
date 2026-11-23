import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { HTTP_BAD_REQUEST, HTTP_OK } from '../server/http.ts'
import { listOllamaStatus } from '../server/ids.ts'
import { handleApi } from '../server/routes.ts'
import { createWorkspace } from '../server/workspace.ts'
import { tempDir } from './helpers.ts'

function withFetch<T>(fn: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fn
  return run().finally(() => {
    globalThis.fetch = original
  })
}

function request(method: string, pathname: string, body: Record<string, unknown> = {}) {
  const url = new URL(pathname, 'http://localhost')
  return { method, pathname: url.pathname, searchParams: url.searchParams, readBody: async () => body }
}

test('listOllamaStatus: 연결 성공 시 모델 목록과 기본 모델을 반환하고, 실패 시 connected=false를 반환한다', async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3.5:9b' }] }), {
        status: 200,
      })) as typeof globalThis.fetch,
    async () => {
      const status = await listOllamaStatus()
      assert.equal(status.connected, true)
      assert.deepEqual(status.models, ['llama3.2:latest', 'qwen3.5:9b'])
      assert.equal(status.defaultModel, 'qwen3.5:9b')
    },
  )

  await withFetch(
    (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof globalThis.fetch,
    async () => {
      const status = await listOllamaStatus()
      assert.equal(status.connected, false)
      assert.deepEqual(status.models, [])
      assert.ok(status.error)
    },
  )
})

test('ollama-ids 라우트: 추론 미리보기(infer)와 작업 획 적용(apply)이 동작한다', async () => {
  const dir = tempDir()
  const ws = createWorkspace(dir)
  try {
    ws.importInitial([
      { 한자: '一', 음: '일' },
      { 한자: '二', 음: '이' },
    ])
    // 부품 '一'의 승인 획을 1개 등록
    ws.updateStrokes('U+4E00', [
      {
        outline_path: 'M 100 450 L 900 450 L 900 550 L 100 550 Z',
        median_points: [[100, 500], [900, 500]],
        stroke_width: 90,
        is_radical: 0,
        start_cap_type: 'NONE',
        end_cap_type: 'NONE',
      },
    ], '부품 등록')
    ws.approve('U+4E00')

    // 1. Ollama infer 모드로 '二'의 IDS 추론 (mock: ⿱一一)
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ response: '{"ids":"⿱一一"}' }), {
          status: 200,
        })) as typeof globalThis.fetch,
      async () => {
        const res = await handleApi(ws, request('POST', '/api/characters/U%2B4E8C/ollama-ids', { mode: 'infer', model: 'qwen3.5:9b' }))
        assert.equal(res.status, HTTP_OK, JSON.stringify(res.body))
        assert.deepEqual(res.body, {
          char: '二',
          model: 'qwen3.5:9b',
          ids: '⿱一一',
          valid: true,
          composable: true,
          strokeCount: 2,
        })
      },
    )

    // 2. 잘못된 IDS로 apply 시 400 반환
    const badRes = await handleApi(ws, request('POST', '/api/characters/U%2B4E8C/ollama-ids', { mode: 'apply', ids: '一' }))
    assert.equal(badRes.status, HTTP_BAD_REQUEST)

    // 3. 유효한 IDS('⿱一一')로 apply 시 작업 획(working_data)에 2획 저장되고 origin='OLLAMA_IDS', issue_status='DRAFT'
    const applyRes = await handleApi(ws, request('POST', '/api/characters/U%2B4E8C/ollama-ids', { mode: 'apply', ids: '⿱一一' }))
    assert.equal(applyRes.status, HTTP_OK, JSON.stringify(applyRes.body))
    const detail = applyRes.body as { working: boolean; origin: string; issue_status: string; strokes: unknown[]; ids: string }
    assert.equal(detail.working, true)
    assert.equal(detail.origin, 'OLLAMA_IDS')
    assert.equal(detail.issue_status, 'DRAFT')
    assert.equal(detail.strokes.length, 2)
    assert.equal(detail.ids, '⿱一一')

    // 4. write='append'로 적용 시 기존 2획 뒤에 2획이 추가되어 4획이 됨
    const appendRes = await handleApi(ws, request('POST', '/api/characters/U%2B4E8C/ollama-ids', { mode: 'apply', ids: '⿱一一', write: 'append' }))
    assert.equal(appendRes.status, HTTP_OK)
    const appended = appendRes.body as { strokes: unknown[] }
    assert.equal(appended.strokes.length, 4)

    // 5. 승인(strokes 행 존재) 후 write='replace'로 다시 적용하면 origin='OLLAMA_IDS', last_modified_by='user'와 이력이 기록됨
    ws.approve('U+4E8C')
    ws.updateStrokes('U+4E8C', [
      {
        outline_path: 'M 100 450 L 900 450 L 900 550 L 100 550 Z',
        median_points: [[100, 500], [900, 500]],
        stroke_width: 90,
        is_radical: 0,
        start_cap_type: 'NONE',
        end_cap_type: 'NONE',
      },
    ], '수작업 초기화')
    const replacedRes = await handleApi(ws, request('POST', '/api/characters/U%2B4E8C/ollama-ids', { mode: 'apply', ids: '⿱一一', write: 'replace' }))
    assert.equal(replacedRes.status, HTTP_OK, JSON.stringify(replacedRes.body))
    const replaced = replacedRes.body as { working: boolean; origin: string; last_modified_by: string; strokes: unknown[]; history_count: number }
    assert.equal(replaced.working, false)
    assert.equal(replaced.origin, 'OLLAMA_IDS')
    assert.equal(replaced.last_modified_by, 'user')
    assert.equal(replaced.strokes.length, 2)
    assert.ok(replaced.history_count >= 1)
  } finally {
    ws.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('IDS 합성: 부품 획의 모양은 Hanzi, 순서는 NAVER에서 가져오고 Hanzi가 없으면 NAVER를 쓴다', async () => {
  const dir = tempDir()
  const ws = createWorkspace(dir)
  const side = new DatabaseSync(path.join(dir, 'database', 'chusa1817.db'))
  try {
    ws.importInitial([{ 한자: '一', 음: '일' }, { 한자: '二', 음: '이' }])
    // 같은 부품 '一'에 출처마다 다른 중심선을 둔다: NAVER는 가로, Hanzi는 대각선.
    const insert = side.prepare(`INSERT INTO reference_data (unicode, source, source_version, raw_data, found) VALUES ('U+4E00', ?, 'test', ?, 1)`)
    const glyph = (median: number[][]) => JSON.stringify({ strokes: ['M 100 450 L 900 450 L 900 550 L 100 550 Z'], medians: [median] })
    insert.run('NAVER', glyph([[100, 500], [900, 500]]))
    const naverOnly = await ws.applyOllamaIds('U+4E8C', { ids: '⿱一一' })
    assert.ok(naverOnly)
    for (const stroke of naverOnly.strokes) {
      assert.equal(stroke.median_points[0][1], stroke.median_points[stroke.median_points.length - 1][1], 'Hanzi가 없으면 가로 중심선(NAVER)이다')
    }
    insert.run('MMH', glyph([[100, 100], [900, 900]]))
    const merged = await ws.applyOllamaIds('U+4E8C', { ids: '⿱一一' })
    assert.ok(merged)
    assert.equal(merged.strokes.length, 2)
    for (const stroke of merged.strokes) {
      const [first, last] = [stroke.median_points[0], stroke.median_points[stroke.median_points.length - 1]]
      assert.notEqual(first[1], last[1], '획 수가 같으면 모양은 Hanzi(대각선)여야 한다')
    }
  } finally {
    side.close()
    ws.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
