import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ThemeMode } from '../types.ts'

function applyTheme(mode: ThemeMode) {
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (mode === 'system') {
    if (meta) meta.setAttribute('content', 'light dark')
    delete document.documentElement.dataset.theme
    try {
      localStorage.removeItem('color-scheme')
    } catch {}
  } else {
    if (meta) meta.setAttribute('content', mode)
    document.documentElement.dataset.theme = mode
    try {
      localStorage.setItem('color-scheme', mode)
    } catch {}
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
    } catch {}
    window.addEventListener('storage', handleStorageChange)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('storage', handleStorageChange)
  })

  return { themeMode, setTheme }
}
