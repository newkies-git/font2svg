import { CANVAS, GRAY_MAX, IMAGE_MAX_COMPONENTS, IMAGE_MIMES, IMAGE_NAME_MAX_LENGTH, IMAGE_SIDE_MAX, IMAGE_SPLITS, SHA256_HEX_LENGTH, type ImageSplit } from '../shared/constants.ts'
import { isValidSvgPath, pathBBox } from '../shared/paths.ts'

type ImageSource = {
  name: string
  mime: string
  sha256: string
  width: number
  height: number
  threshold: number
  invert: boolean
}

export type ImageImportRequest = { contours: string[]; image: ImageSource; split: ImageSplit }

const SHA256_RE = new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH}}$`)

function integerIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}은(는) ${min}~${max} 사이의 정수여야 합니다.`)
  }
  return value
}

// 폴더 경로가 섞여 들어와도 파일 이름만 남긴다. DB에는 표시용으로만 쓴다.
function fileNameOf(value: unknown): string {
  const name = typeof value === 'string' ? (value.split(/[\\/]/).pop() ?? '').trim() : ''
  return (name || '이미지').slice(0, IMAGE_NAME_MAX_LENGTH)
}

// 화면이 이미지를 읽어 만든 윤곽과 원본 정보를 검사한다. 윤곽은 저장 좌표계 안의 닫힌 경로여야 한다.
export function parseImageImport(raw: unknown): ImageImportRequest {
  const body = (raw ?? {}) as { contours?: unknown; image?: unknown; split?: unknown }
  if (!Array.isArray(body.contours) || body.contours.length === 0) throw new Error('변환할 윤곽이 없습니다.')
  if (body.contours.length > IMAGE_MAX_COMPONENTS) throw new Error(`윤곽은 ${IMAGE_MAX_COMPONENTS}개까지만 받을 수 있습니다.`)
  const contours = body.contours.map((contour, index) => {
    if (typeof contour !== 'string' || !isValidSvgPath(contour)) throw new Error(`${index + 1}번째 윤곽 경로가 올바르지 않습니다.`)
    const box = pathBBox(contour)
    if (!box || box.minX < 0 || box.minY < 0 || box.maxX > CANVAS || box.maxY > CANVAS) {
      throw new Error(`${index + 1}번째 윤곽이 저장 좌표 범위(0~${CANVAS})를 벗어났습니다.`)
    }
    return contour
  })

  const image = (body.image ?? {}) as Record<string, unknown>
  const mime = IMAGE_MIMES.find((type) => type === image.mime)
  if (!mime) throw new Error(`지원하지 않는 이미지 형식입니다(${IMAGE_MIMES.join(', ')}만 가능).`)
  if (typeof image.sha256 !== 'string' || !SHA256_RE.test(image.sha256)) throw new Error('원본 이미지의 SHA-256이 올바르지 않습니다.')
  if (typeof image.invert !== 'boolean') throw new Error('반전 여부가 올바르지 않습니다.')
  const split = body.split === undefined ? 'AUTO' : IMAGE_SPLITS.find((type) => type === body.split)
  if (!split) throw new Error(`획 나누기 방식이 올바르지 않습니다(${IMAGE_SPLITS.join(', ')}).`)
  return {
    contours,
    split,
    image: {
      name: fileNameOf(image.name),
      mime,
      sha256: image.sha256,
      width: integerIn(image.width, 1, IMAGE_SIDE_MAX, '이미지 너비'),
      height: integerIn(image.height, 1, IMAGE_SIDE_MAX, '이미지 높이'),
      threshold: integerIn(image.threshold, 0, GRAY_MAX, '이진화 경계'),
      invert: image.invert,
    },
  }
}
