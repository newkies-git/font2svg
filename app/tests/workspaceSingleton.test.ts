import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'
import { getWorkspace } from '../server/workspace.ts'
import { tempDir } from './helpers.ts'

const first = tempDir()
const second = tempDir()
const ws = getWorkspace(first)
after(() => {
  ws.close()
  fs.rmSync(first, { recursive: true, force: true })
  fs.rmSync(second, { recursive: true, force: true })
})

test('같은 폴더로 다시 부르면 같은 작업 공간을, 다른 폴더면 던진다', () => {
  assert.equal(getWorkspace(first), ws)
  assert.throws(() => getWorkspace(second), /이미 .* 열려 있습니다/)
})
