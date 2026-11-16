// 이진 마스크(Uint8Array, 한 칸이 한 픽셀) 도구: 덩어리 나누기, 구멍 찾기, 넓히기.

// 구멍으로 인정하는 최소 크기(픽셀 수). 이보다 작은 틈은 래스터 오차로 보고 메운다.
const HOLE_MIN_PIXELS = 30

// 마스크를 8방향으로 이어진 덩어리로 나눈다(윤곽 추적과 같은 연결). 큰 덩어리부터.
export function connectedComponents(mask: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(mask.length)
  const components: number[][] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const pixels: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const index = stack.pop() as number
      pixels.push(index)
      const x = index % w
      const y = (index / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const next = ny * w + nx
          if (mask[next] && !seen[next]) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
    }
    components.push(pixels)
  }
  return components.sort((a, b) => b.length - a.length)
}

// starts에서 시작해 막히지 않은(blocked가 0인) 칸을 4방향으로 채운다. 이미 seen인 칸은 건너뛰고, 새로 채운 칸을 seen에 표시해 돌려준다.
function floodFill4(blocked: Uint8Array, seen: Uint8Array, starts: number[], w: number, h: number): number[] {
  const filled: number[] = []
  const stack: number[] = []
  const push = (index: number) => {
    if (blocked[index] || seen[index]) return
    seen[index] = 1
    stack.push(index)
  }
  for (const start of starts) push(start)
  while (stack.length > 0) {
    const index = stack.pop() as number
    filled.push(index)
    const x = index % w
    const y = (index / w) | 0
    if (x > 0) push(index - 1)
    if (x < w - 1) push(index + 1)
    if (y > 0) push(index - w)
    if (y < h - 1) push(index + w)
  }
  return filled
}

// 마스크 안쪽에 갇힌 빈 영역(구멍)들을 구멍마다 마스크로 돌려준다. 빈 칸은 4방향 연결로 본다(잉크의 8방향 연결과 짝).
export function enclosedHoles(mask: Uint8Array, w: number, h: number): Uint8Array[] {
  const seen = new Uint8Array(mask.length)
  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1)
  floodFill4(mask, seen, border, w, h)
  const holes: Uint8Array[] = []
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue
    const pixels = floodFill4(mask, seen, [start], w, h)
    if (pixels.length < HOLE_MIN_PIXELS) continue
    const hole = new Uint8Array(mask.length)
    for (const index of pixels) hole[index] = 1
    holes.push(hole)
  }
  return holes
}

// 마스크를 8방향으로 한 칸 넓힌다. 구멍을 넓히면 가장자리가 구멍 둘레의 잉크 픽셀을 지나, 바깥 윤곽이 잉크 가장자리를 따라가는 것과 같은 기준으로 구멍 윤곽을 뽑을 수 있다.
export function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const grown = mask.slice()
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const x = i % w
    const y = (i / w) | 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1
      }
    }
  }
  return grown
}
