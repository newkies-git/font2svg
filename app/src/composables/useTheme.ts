import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ThemeMode } from '../../shared/types.ts'

function applyTheme(mode: ThemeMode) {
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (mode === 'system') {
    if (meta) meta.setAttribute('content', 'light dark')
    delete document.documentElement.dataset.theme
    try {
      localStorage.removeItem('color-scheme')
    } catch {
      // localStorage가 막혀 있어도(사생활 보호 모드 등) 테마 적용은 계속한다.
    }
  } else {
    if (meta) meta.setAttribute('content', mode)
    document.documentElement.dataset.theme = mode
    try {
      localStorage.setItem('color-scheme', mode)
    } catch {
      // 저장하지 못해도 이번 화면의 테마는 이미 적용됐다.
    }
  }
}

export function useTheme() {
  const themeMode = ref<ThemeMode>('system')

  function setTheme(mode: ThemeMode) {
    themeMode.value = mode
    applyTheme(mode)
  }

  function handleStorageChange(e: StorageEvent) {
    if (e.key === 'color-scheme') {
      const val = e.newValue
      if (val === 'dark' || val === 'light') {
        themeMode.value = val
        applyTheme(val)
      } else {
        themeMode.value = 'system'
        applyTheme('system')
      }
    }
  }

  onMounted(() => {
    try {
      const saved = localStorage.getItem('color-scheme')
      if (saved === 'dark' || saved === 'light') {
        themeMode.value = saved
      } else {
        themeMode.value = 'system'
      }
    } catch {
      // localStorage를 읽을 수 없으면 시스템 테마를 쓴다.
    }
    window.addEventListener('storage', handleStorageChange)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('storage', handleStorageChange)
  })

  return { themeMode, setTheme }
}
