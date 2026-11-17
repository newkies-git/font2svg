import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { createApiMiddleware } from './server/apiMiddleware.ts'
import { getWorkspace } from './server/workspace.ts'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(appDir, '..')

// 개발 서버가 뜰 때 작업 공간(DB)을 열고 /api/*를 연결한다. 설정을 읽기만 하는 build에서는 DB를 열지 않는다.
function workspaceApi(): Plugin {
  return {
    name: 'hanja-workspace-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware(getWorkspace(rootDir)))
    },
  }
}

export default defineConfig({
  plugins: [vue(), workspaceApi()],
})
