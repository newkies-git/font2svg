import { createHash } from 'node:crypto'
import fs from 'node:fs'
import opentype from 'opentype.js'
import { CANVAS, COORD_ROUND } from '../shared/constants.ts'

export type FontFile = {
  sha256: string
  unitsPerEm: number
  // 글자의 외곽선을 윤곽(contour)마다 SVG Path 한 개로 돌려준다. 좌표는 0~CANVAS, y축 위쪽. 글리프가 없으면 null.
  contours(char: string): string[] | null
}

const NOTDEF_GLYPH_INDEX = 0
// 궁서체는 글자가 Hanja 데이터보다 낮게 그려져 있다. 글자 전체 bbox의 중앙값 비교(Hanja y -42~842, 궁서체 y -129~740)로 구한 보정값만큼 올려 같은 높이에 놓는다.
const BASELINE_SHIFT = 95
const SFNT_HEADER_BYTES = 12
const SFNT_TABLE_RECORD_BYTES = 16
const CMAP_RECORD_BYTES = 8
const MAC_ROMAN_PLATFORM = 1
const MAC_ROMAN_ENCODING = 0
const UNUSED_ENCODING = 0xffff

// opentype.js는 cmap에 Mac Roman(플랫폼 1, 인코딩 0) 하위 표가 있으면 유니코드 표보다 먼저 골라 읽다가 실패한다.
// 메모리에 읽어 둔 사본에서만 그 표의 인코딩 번호를 지워 유니코드 표(format 4)를 쓰게 한다. 디스크의 폰트는 그대로다.
function hideMacRomanCmap(buffer: ArrayBuffer): void {
  const view = new DataView(buffer)
  const tableCount = view.getUint16(4)
  for (let index = 0; index < tableCount; index++) {
    const record = SFNT_HEADER_BYTES + index * SFNT_TABLE_RECORD_BYTES
    const tag = String.fromCharCode(view.getUint8(record), view.getUint8(record + 1), view.getUint8(record + 2), view.getUint8(record + 3))
    if (tag !== 'cmap') continue
    const cmap = view.getUint32(record + 8)
    const subtableCount = view.getUint16(cmap + 2)
    for (let sub = 0; sub < subtableCount; sub++) {
      const entry = cmap + 4 + sub * CMAP_RECORD_BYTES
      if (view.getUint16(entry) === MAC_ROMAN_PLATFORM && view.getUint16(entry + 2) === MAC_ROMAN_ENCODING) {
        view.setUint16(entry + 2, UNUSED_ENCODING)
      }
    }
    return
  }
}

export function loadFont(file: string): FontFile | null {
  if (!fs.existsSync(file)) return null
  const bytes = fs.readFileSync(file)
  let font: ReturnType<typeof opentype.parse>
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    hideMacRomanCmap(copy)
    font = opentype.parse(copy)
  } catch (error) {
    throw new Error(`TTF 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`)
  }
  const unitsPerEm = font.unitsPerEm
  const scale = CANVAS / unitsPerEm
  const round = (value: number) => Math.round(value * COORD_ROUND) / COORD_ROUND
  const px = (value: number) => round(value * scale)
  const py = (value: number) => round(-value * scale + BASELINE_SHIFT)

  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    unitsPerEm,
    contours(char) {
      const glyph = font.charToGlyph(char)
      if (glyph.index === NOTDEF_GLYPH_INDEX) return null
      // getPath는 y축이 아래쪽인 좌표를 돌려주므로 부호를 뒤집어 y축 위쪽으로 맞춘다.
      const commands = glyph.getPath(0, 0, unitsPerEm).commands
      const contours: string[] = []
      let current: string[] = []
      for (const command of commands) {
        if (command.type === 'M') {
          if (current.length > 0) contours.push(`${current.join(' ')} Z`)
          current = [`M ${px(command.x)} ${py(command.y)}`]
        } else if (command.type === 'L') {
          current.push(`L ${px(command.x)} ${py(command.y)}`)
        } else if (command.type === 'Q') {
          current.push(`Q ${px(command.x1)} ${py(command.y1)} ${px(command.x)} ${py(command.y)}`)
        } else if (command.type === 'C') {
          current.push(`C ${px(command.x1)} ${py(command.y1)} ${px(command.x2)} ${py(command.y2)} ${px(command.x)} ${py(command.y)}`)
        } else if (command.type === 'Z' && current.length > 0) {
          contours.push(`${current.join(' ')} Z`)
          current = []
        }
      }
      if (current.length > 0) contours.push(`${current.join(' ')} Z`)
      return contours.length > 0 ? contours : null
    },
  }
}
