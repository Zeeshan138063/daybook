// Demo mode: a whole working week of made-up data, dated around whatever day it is, so the panel
// can be shown, screenshotted and recorded without a config, a ledger or any real name in it.
// Everything here is invented: Alex Example, Sam Reviewer, PROJ- keys, example.com addresses.
// Turned on with `/daybook demo`, off with `/daybook live`. Nothing is read from disk in demo mode.

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00`).toISOString()

export const DEMO_ME = 'Alex Example'
const REVIEWER = 'Sam Reviewer'
const SITE = 'https://example.atlassian.net'

export function demoConfig() {
  return {
    me: DEMO_ME, call_me: 'Alex', reviewer: REVIEWER,
    ledger_dir: '(demo)', day_min_minutes: 495, day_max_minutes: 540,
    config_path: '(demo mode: /daybook live to leave)',
    people: { [REVIEWER]: 'sam@example.com' },
    providers: {
      code: { type: 'github', via: 'cli' as const },
      tickets: { type: 'jira', via: 'api' as const, site: SITE },
      chat: { type: 'teams', via: 'connector' as const },
      mail: { type: 'outlook', via: 'connector' as const },
      time: { type: 'jira_worklogs' },
      docs: { type: 'claude_docs' },
    },
  }
}

// The Monday to Friday around `day` (a weekend shows the week just gone).
function weekOf(day: string): string[] {
  const d = new Date(`${day}T12:00:00`)
  const back = (d.getDay() + 6) % 7
  const mon = new Date(d)
  mon.setDate(d.getDate() - back)
  return [0, 1, 2, 3, 4].map(i => {
    const x = new Date(mon)
    x.setDate(mon.getDate() + i)
    return isoDay(x)
  })
}

const TICKETS: [string, string, string, string][] = [
  // key, summary, status, area
  ['PROJ-101', 'Notes API: create, edit, delete', 'Done', 'backend'],
  ['PROJ-102', 'Folders and tags', 'Done', 'backend'],
  ['PROJ-103', 'Export a note to Markdown and PDF', 'Waiting QA', 'backend'],
  ['PROJ-104', 'Import notes from a zip file', 'In Review', 'backend'],
  ['PROJ-105', 'Share links that expire', 'In Review', 'backend'],
  ['PROJ-106', 'Account settings', 'In Review', 'backend'],
  ['PROJ-107', 'Full-text search', 'In Development', 'backend'],
  ['PROJ-108', 'Nightly backups', 'Backlog', 'backend'],
  ['PROJ-109', 'Trash that empties after 30 days', 'Backlog', 'backend'],
  ['PROJ-110', 'Editor with autosave', 'In Review', 'frontend'],
  ['PROJ-111', 'Drag notes between folders', 'In Development', 'frontend'],
  ['PROJ-112', 'Dark mode', 'Backlog', 'frontend'],
  ['PROJ-113', 'Keyboard shortcuts', 'Backlog', 'frontend'],
  ['PROJ-114', 'Translations', 'Done', 'frontend'],
  ['PROJ-115', 'End-to-end tests', 'Backlog', 'frontend'],
  ['PROJ-116', 'Staging environment', 'Backlog', 'devops'],
  ['PROJ-117', 'Secrets in the vault', 'In Development', 'devops'],
  ['PROJ-118', 'TLS for custom domains', 'Backlog', 'devops'],
  ['PROJ-119', 'Database upgrade', 'Backlog', 'devops'],
  ['PROJ-120', 'Release checklist', 'Backlog', 'devops'],
  ['PROJ-121', 'Offline sync', 'Backlog', 'backend'],
  ['PROJ-122', 'Mobile push notifications', 'Backlog', 'backend'],
]
const OTHERS = ['Robin Example', 'Kim Example', 'Jo Example']

export function demoLedger(day: string) {
  const week = weekOf(day)
  const idx = Math.max(0, week.indexOf(day))
  const isToday = day === isoDay(new Date())
  // Finished days land in range; the day in progress is a little short, so "Time" shows a need.
  const done = [512, 528, 503, 534, 519]
  const logged = isToday ? 390 : done[idx] ?? 510
  const week_minutes: Record<string, number> = {}
  week.forEach((d, i) => { week_minutes[d] = d < day ? done[i] ?? 0 : d === day ? logged : 0 })

  const split: [string, number][] = [['PROJ-107', 0.45], ['PROJ-104', 0.2], ['PROJ-105', 0.15], ['PROJ-111', 0.2]]
  const minutes = split.map(([k, f]) => [k, Math.round((logged * f) / 15) * 15] as const)
  const tickets = TICKETS.filter(t => t[2] !== 'Done').map(([key, summary, status]) => ({
    key, summary, status,
    start_date: status === 'Backlog' ? null : week[0] ?? day,
    due_date: status === 'In Review' ? week[Math.max(0, idx - 1)] ?? day : null,
    worklogs_today: minutes.filter(([k]) => k === key).map(([, m]) => ({ seconds: m * 60 })),
  }))
  const board = TICKETS.map(([key, summary, status, area], i) => ({
    key, summary, status, area,
    assignee: i % 4 === 3 ? OTHERS[i % OTHERS.length] ?? null : DEMO_ME,
    due_date: status === 'Backlog' ? null : week[i % 5] ?? null,
  }))
  const prs = [
    {
      number: 42, url: 'https://github.com/example/app/pull/42', state: 'OPEN', mergedAt: null,
      reviewDecision: '', tickets: ['PROJ-104', 'PROJ-105', 'PROJ-106'],
      comments: [{ by: 'alex-example', at: at(day, '09:05') }, { by: 'sam-reviewer', at: at(day, '10:40') }],
      inline_comments: [{ by: 'sam-reviewer', at: at(day, '10:38') }, { by: 'sam-reviewer', at: at(day, '10:39') }],
      reviews: [{ by: 'sam-reviewer', state: 'COMMENTED', at: at(day, '10:40') }],
    },
    {
      number: 41, url: 'https://github.com/example/web/pull/41', state: 'OPEN', mergedAt: null,
      reviewDecision: 'APPROVED', tickets: ['PROJ-110'], comments: [], inline_comments: [],
      reviews: [{ by: 'sam-reviewer', state: 'APPROVED', at: at(day, '09:30') }],
    },
    {
      number: 39, url: 'https://github.com/example/app/pull/39', state: 'MERGED', mergedAt: at(day, '08:50'),
      reviewDecision: 'APPROVED', tickets: ['PROJ-101', 'PROJ-102', 'PROJ-103'], comments: [], inline_comments: [],
      reviews: [{ by: 'sam-reviewer', state: 'APPROVED', at: at(day, '08:45') }],
    },
  ]
  const ok = { ok: true, at: at(day, '11:02') }
  return {
    day, gathered_at: at(day, '11:02'),
    sources: { github: ok, git: ok, jira: ok, teams: ok, outlook: ok },
    github: { login: 'alex-example', prs },
    jira: { tickets, board, logged_today_minutes: logged, week_minutes },
    teams: {
      asks_for_me: [{ from: 'Robin Example', text: 'Can you pair on the import edge cases after lunch?',
        url: 'https://teams.microsoft.com/l/chat/0/0?users=robin@example.com' }],
    },
  }
}

export function demoQuestions(day: string) {
  const week = weekOf(day)
  const d = (i: number) => week[Math.max(0, Math.min(i, week.length - 1))] ?? day
  const chat = 'https://teams.microsoft.com/l/message/demo'
  return {
    questions: [
      { id: 'demo-send', status: 'to_send', to: REVIEWER, tickets: ['PROJ-107'],
        topic: 'PROJ-107: search inside attachments too?',
        text: 'Should search also look inside attached PDFs, or only the note text for now?' },
      { id: 'demo-w1', status: 'waiting', to: REVIEWER, tickets: ['PROJ-118'], asked_at: at(day, '09:20'),
        topic: 'PROJ-118: which certificate issuer for custom domains?', url: `${chat}/1` },
      { id: 'demo-w2', status: 'waiting', to: 'Kim Example', tickets: ['PROJ-109'], asked_at: at(d(1), '14:10'),
        topic: 'PROJ-109: 30 days in the trash, or configurable?', url: `${chat}/2` },
      { id: 'demo-a1', status: 'answered', to: REVIEWER, tickets: ['PROJ-111'], asked_at: at(d(0), '10:00'),
        topic: 'PROJ-111: can a note sit in two folders?', answer: 'No: one folder per note, tags for the rest.',
        answered_by: REVIEWER, answered_at: at(d(1), '09:15'), url: `${chat}/3` },
      { id: 'demo-a2', status: 'answered', to: REVIEWER, tickets: ['PROJ-105'], asked_at: at(d(0), '15:30'),
        topic: 'PROJ-105: how long should a share link live?', answer: '7 days by default, up to 30.',
        answered_by: REVIEWER, answered_at: at(d(1), '08:40'), url: `${chat}/4` },
      { id: 'demo-a3', status: 'answered', to: 'Jo Example', tickets: ['PROJ-103'], asked_at: at(d(1), '11:00'),
        topic: 'PROJ-103: page numbers on the PDF export?', answer: 'Yes, "Page 1 of 2" at the foot.',
        answered_by: 'Jo Example', answered_at: at(d(2), '10:05'), url: `${chat}/5` },
    ],
  }
}
