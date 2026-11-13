import type { CharacterDetail, IssueStatus } from '../types.ts'

export const ISSUE_LABELS: Record<IssueStatus, string> = { OPEN: '작업 전', DRAFT: '승인 대기', APPROVED: '승인됨' }

export function issueLabel(detail: CharacterDetail): string {
  if (!detail.issue_status) return ''
  return `${ISSUE_LABELS[detail.issue_status]}${detail.in_font ? ' · 궁서체 있음' : ''}`
}
