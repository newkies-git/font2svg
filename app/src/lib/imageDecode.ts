import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, IMAGE_MIMES } from '../../shared/constants.ts'
import { binarize, grayscaleOf, otsuThreshold, shouldInvert, traceImageMask } from '../../shared/imageTrace.ts'

const HEX_RADIX = 16
const HEX_DIGITS_PER_BYTE = 2
const BYTES_PER_MEGABYTE = 1024 * 1024

export type ImageImportBody = {
  contours: string[]
  image: { name: string; mime: string; sha256: string; width: number; height: number; threshold: number; invert: boolean }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, '0')).join('')
}

// 래스터 이미지 파일을 읽어 서버에 보낼 글자 윤곽으로 바꾼다.
// 브라우저가 이미지를 디코딩하고(PNG·JPEG·WebP), 이진화(Otsu)·윤곽 추적은 shared/imageTrace.ts가 한다.
// 원본 이미지는 서버로 보내지 않고, SHA-256과 변환 설정만 함께 보낸다.
export async function buildImageImport(file: File): Promise<ImageImportBody> {
  const mime = IMAGE_MIMES.find((type) => type === file.type)
  if (!mime) throw new Error(`지원하지 않는 이미지 형식입니다(${IMAGE_MIMES.join(', ')}만 가능).`)
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`이미지가 너무 큽니다(${IMAGE_MAX_BYTES / BYTES_PER_MEGABYTE}MB까지).`)

  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  try {
    const ratio = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * ratio))
    const height = Math.max(1, Math.round(bitmap.height * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('이미지를 읽을 수 있는 캔버스를 만들지 못했습니다.')
    context.drawImage(bitmap, 0, 0, width, height)

    const gray = grayscaleOf(context.getImageData(0, 0, width, height).data, width * height)
    const threshold = otsuThreshold(gray)
    const invert = shouldInvert(gray, threshold)
    const { contours } = traceImageMask(binarize(gray, threshold, invert), width, height)
    return { contours, image: { name: file.name, mime, sha256, width: bitmap.width, height: bitmap.height, threshold, invert } }
  } finally {
    bitmap.close()
  }
}
