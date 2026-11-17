import type { Ref } from 'vue'

// 보이는 획 수(shown)를 한 획씩 옮기고, 그 획을 선택하며, 진행 중이던 그리기(reveal)를 끝낸다.
// 처음·끝에서 더 갈 수 없으면 아무것도 바꾸지 않는다(단추는 그 자리에서 비활성이고, 단축키는 무시된다).
export function useStrokeStepper(strokeCount: () => number, shown: Ref<number>, reveal: Ref<number>, selectedIndex: Ref<number>) {
  function moveTo(next: number) {
    shown.value = next
    reveal.value = 1
    selectedIndex.value = next - 1
  }

  function first() {
    if (shown.value > 1) moveTo(1)
  }

  function prev() {
    if (shown.value > 1) moveTo(shown.value - 1)
  }

  function next() {
    if (shown.value < strokeCount()) moveTo(shown.value + 1)
  }

  return { first, prev, next }
}
