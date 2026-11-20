import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { LAYER_ID } from '../shared/constants.ts'
import { HTTP_OK } from '../server/http.ts'
import { splitFontByOllamaGuide } from '../server/ollamaSplit.ts'
import { handleApi } from '../server/routes.ts'
import { createWorkspace } from '../server/workspace.ts'
import { rectPath, tempDir } from './helpers.ts'

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

test('splitFontByOllamaGuide: Ollama가 보정한 중심선·윤곽 인덱스로 궁서체 윤곽을 획순에 맞게 분리한다', async () => {
  const topStroke = rectPath(100, 620, 900, 720)
  const bottomStroke = rectPath(100, 220, 900, 320)

  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            strokes: [
              { strokeOrder: 1, contourIndices: [0], median: [[120, 670], [880, 670]] },
              { strokeOrder: 2, contourIndices: [1], median: [[120, 270], [880, 270]] },
            ],
          }),
        }),
        { status: 200 },
      )) as typeof globalThis.fetch,
    async () => {
      const result = await splitFontByOllamaGuide({
        char: '二',
        source: 'NAVER',
        contours: [topStroke, bottomStroke],
        guideStrokes: [
          { stroke_order: 1, median_points: [[150, 700], [850, 700]] },
          { stroke_order: 2, median_points: [[150, 300], [850, 300]] },
        ],
        model: 'qwen3.5:9b',
      })
      assert.equal(result.outlines.length, 2)
      assert.equal(result.unmatched.length, 0)
      assert.equal(result.source, 'NAVER')
      assert.equal(result.model, 'qwen3.5:9b')
    },
  )
})

test('ollama-split 라우트: 현재 궁서체(FONT 레이어)를 Hanzi(MMH) 획순에 맞게 분리해 저장한다', async () => {
  const dir = tempDir()
  const ws = createWorkspace(dir)
  try {
    ws.importInitial([{ 한자: '二', 음: '이' }])
    const topStroke = rectPath(100, 620, 900, 720)
    const bottomStroke = rectPath(100, 220, 900, 320)

    // 현재 기준 궁서체(FONT 레이어) 잠금 해제 후 2개 윤곽 설정
    ws.updateLayersMeta('U+4E8C', [{ id: LAYER_ID.font, locked: false }])
    ws.saveLayer('U+4E8C', LAYER_ID.font, { paths: [topStroke, bottomStroke] })

    // MMH(Hanzi) 레퍼런스 응답 + Ollama 응답 mock
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('127.0.0.1:11434')) {
          return new Response(
            JSON.stringify({
              response: JSON.stringify({
                strokes: [
                  { strokeOrder: 1, contourIndices: [0], median: [[120, 670], [880, 670]] },
                  { strokeOrder: 2, contourIndices: [1], median: [[120, 270], [880, 270]] },
                ],
              }),
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            character: '二',
            strokes: [topStroke, bottomStroke],
            medians: [
              [[150, 700], [850, 700]],
              [[150, 300], [850, 300]],
            ],
            radicals: [0, 1],
          }),
          { status: 200 },
        )
      }) as typeof globalThis.fetch,
      async () => {
        const res = await handleApi(
          ws,
          request('POST', '/api/characters/U%2B4E8C/ollama-split', { source: 'MMH', model: 'gemma4:12b' }),
        )
        assert.equal(res.status, HTTP_OK, JSON.stringify(res.body))
        const body = res.body as {
          strokes: unknown[]
          origin: string
          fit_status: string
          unmatched_strokes: number[]
          source: string
          model: string
        }
        assert.equal(body.strokes.length, 2)
        assert.equal(body.origin, 'MMH')
        assert.equal(body.fit_status, 'fitted')
        assert.deepEqual(body.unmatched_strokes, [])
        assert.equal(body.source, 'MMH')
        assert.equal(body.model, 'gemma4:12b')
      },
    )
  } finally {
    ws.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
