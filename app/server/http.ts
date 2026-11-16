import { API_BODY_LIMIT_BYTES } from '../shared/constants.ts'

export const HTTP_OK = 200
export const HTTP_BAD_REQUEST = 400
export const HTTP_FORBIDDEN = 403
export const HTTP_NOT_FOUND = 404

// DB를 쓰는 API는 같은 컴퓨터에서 온 요청만 받는다(vite --host로 열어도 외부에서는 쓸 수 없게).
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

// JSON 본문을 읽는다. 본문이 없으면 {}. 상한을 넘으면 읽기를 멈추고 오류를 던진다.
export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  limitBytes = API_BODY_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of chunks) {
    size += chunk.byteLength
    if (size > limitBytes) throw new Error('요청 본문이 너무 큽니다.')
    parts.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(parts).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new Error('JSON 형식이 아닙니다.', { cause: error })
  }
}
