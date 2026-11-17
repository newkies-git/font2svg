import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

// 형식(스타일) 규칙은 두지 않는다: 기존 코드 스타일을 존중하고, 버그 가능성이 있는 패턴만 잡는다.
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  // 기다리지 않은 Promise는 실패해도 조용히 사라진다. 타입 정보가 필요한 규칙이라 .ts 파일에만 둔다.
  // 테스트는 node:test의 test()가 Promise를 돌려주는 호출이 한가득이라 제외한다.
  {
    files: ['src/**/*.ts', 'server/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts', 'vite.config.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
)
