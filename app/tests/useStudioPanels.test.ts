import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYER_ID } from '../shared/constants.ts'
import { useStudioPanels } from '../src/composables/useStudioPanels.ts'
import { bar, layerOf, setupWorkspace } from './studioHarness.ts'

const work = (...strokes: ReturnType<typeof bar>[]) => layerOf(LAYER_ID.strokes, 'STROKES', { name: '작업 획', strokes })
const fontLayer = (paths: string[] = ['M 0 0 Z']) => layerOf(LAYER_ID.font, 'FONT', { name: '궁서체', paths })

test('획 윤곽 길잡이: 획이 있는 레이어만, 작업 획을 맨 앞에 둔다', () => {
  const { workspace } = setupWorkspace([
    fontLayer(),
    layerOf(LAYER_ID.naver, 'NAVER', { strokes: [bar(100)], z_index: 1 }),
    layerOf(LAYER_ID.outline, 'OUTLINE', { strokes: [bar(100)] }),
    layerOf(LAYER_ID.mmh, 'MMH'),
    work(bar(100)),
  ])
  const panels = useStudioPanels(workspace)
  assert.deepEqual(panels.outlineGuideLayers.value.map((layer) => layer.id), [LAYER_ID.strokes, LAYER_ID.naver])
})

test('점 편집 가능 여부: 궁서체는 윤곽 경로, 그 밖은 선택한 획의 윤곽으로 판단한다', () => {
  const { workspace } = setupWorkspace([fontLayer(['M 0 0 Z']), work(bar(100))], { activeLayerId: LAYER_ID.strokes })
  const panels = useStudioPanels(workspace)
  assert.equal(panels.canEditPathPoints.value, true)
  workspace.selectedStrokeIndex.value = 5
  assert.equal(panels.canEditPathPoints.value, false)
})

test('기필·수필을 직접 그리기로 정하면 정점 도구로 넘어간다', () => {
  const { workspace } = setupWorkspace([fontLayer(), work(bar(100))], { activeLayerId: LAYER_ID.strokes })
  const panels = useStudioPanels(workspace)
  panels.onSetCap(0, 'start', 'POINTED')
  assert.notEqual(workspace.activeTool.value, 'bezier')
  panels.onSetCap(0, 'start', 'MANUAL')
  assert.equal(workspace.activeTool.value, 'bezier')
})

test('잠기거나 숨겨진 편집 레이어를 풀고 보이게 한다', () => {
  const { workspace } = setupWorkspace([fontLayer(), layerOf(LAYER_ID.strokes, 'STROKES', { strokes: [bar(100)], locked: true, visible: false })], { activeLayerId: LAYER_ID.strokes })
  const panels = useStudioPanels(workspace)
  panels.unlockActiveLayers()
  const layer = workspace.layers.value.find((item) => item.id === LAYER_ID.strokes)
  assert.equal(layer?.locked, false)
  assert.equal(layer?.visible, true)
})
