import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const pad = (n: number) => String(n).padStart(2, '0')
const d = new Date()
const DAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const CONFIG = {
  ledger_dir: '/ledger', day_min_minutes: 495, day_max_minutes: 540, me: 'Alex Example',
  reviewer: 'Sam Reviewer',
  providers: {
    tickets: { type: 'jira', site: 'https://example.atlassian.net' }, code: { type: 'github' },
    chat: { type: 'teams' },
  },
  // the action bar is configuration: these are the ones a user with these skills would set
  actions: {
    primary: { key: 'timesheet', label: 'Propose timesheet', command: '/timesheet' },
    buttons: [
      { key: 'status', label: 'Draft status', command: '/status', hint: 'for {reviewer}' },
      { key: 'scrum', label: 'Add scrum', command: '/scrum', hint: 'tomorrow' },
      { key: 'start', label: 'Start ticket', command: '/start', hint: 'next {next_ticket}' },
    ],
    time_short: '/timesheet',
  },
  schedule: [{ at: '09:00', commands: ['/scrum'] }, { at: '17:30', commands: ['/timesheet', '/status'] }],
}
const LEDGER = {
  day: DAY,
  gathered_at: `${DAY}T09:02:00+05:00`,
  sources: { github: { ok: true }, jira: { ok: true }, teams: { ok: true }, outlook: { ok: false } },
  github: {
    login: 'alex',
    prs: [{
      number: 470, title: 'PROJ-214 to 216', url: 'https://github.com/x/y/pull/470', state: 'OPEN',
      mergedAt: null, reviewDecision: '', tickets: ['PROJ-214', 'PROJ-215', 'PROJ-216'],
      comments: [], reviews: [],
      inline_comments: [
        { by: 'sam', at: `${DAY}T10:00:00Z` },
        { by: 'sam', at: `${DAY}T10:05:00Z` },
      ],
    }],
  },
  jira: {
    logged_today_minutes: 380,
    week_minutes: { [DAY]: 380 },
    tickets: [
      { key: 'PROJ-214', summary: 'Folder models', status: 'In Development', start_date: DAY, due_date: null, worklogs_today: [{ seconds: 7800 }] },
      { key: 'PROJ-206', summary: 'Sign-up step', status: 'In Review', start_date: DAY, due_date: DAY, worklogs_today: [] },
      { key: 'PROJ-217', summary: 'Search helpers', status: 'Backlog', start_date: null, due_date: null, worklogs_today: [] },
    ],
  },
  teams: {
    questions: [
      { topic: 'Release notes owner', to: 'Sam', status: 'open' },
      { topic: 'Default folder name', to: 'Sam', status: 'answered' },
    ],
    asks_for_me: [],
  },
}

const PANE = {
  plugin: 'daybook',
  component: 'Pane',
  requestId: 'daybook',
  props: {
    title: 'Daybook', isFocused: false, bodyColumns: 48, placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 }, view: {},
  },
} as const

function engine(on: Parameters<TestBody>[1], submitted: string[], ledger: object = LEDGER, ranToday: string | null = DAY) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('config.json') ? JSON.stringify(CONFIG) : JSON.stringify(ledger),
  }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: ranToday }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', (_, e) => {
    submitted.push(`/${e.command}`)
    return { text: '' }
  })
}

test('needs, time, waiting and tickets show on desktop and terminal', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /#470 · 2 new comments from sam/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /short of today's range/ }))?.text).toBe('Time · 1h 55m short of today\'s range')
    expect((await ui.find({ type: 'Text', text: /^6h 20m$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1h 55m to go/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Good (morning|afternoon|evening), Alex/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^This week$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Due$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /2 comments/ }))).toBeTruthy()
    const next = (await ui.findAll({ type: 'Link' })).find(l => l.props.label === 'next PROJ-217')
    if (surface === 'desktop') expect(next?.props.href).toBe('https://example.atlassian.net/browse/PROJ-217')
    expect((await ui.find({ type: 'Text', text: /All clear/ }))).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /Outlook not checked/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Release notes owner/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Default folder name/ }))).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /Folder models/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('nothing waiting shows All clear', async ($, on) => {
  engine(on, [], { ...LEDGER, github: { login: 'alex', prs: [] },
    jira: { ...LEDGER.jira, logged_today_minutes: 520 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /All clear/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /In range/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /NEEDS YOU/ }))).toBeFalsy()
  await ui.unmount()
})

test('the buttons start the skills as prompts', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'timesheet' })
  await ui.press({ key: 'status' })
  await ui.press({ key: 'scrum' })
  expect(submitted).toEqual(['/timesheet', '/status', '/scrum'])
  await ui.unmount()
})

test('a commit with Claude attribution is refused; a clean one runs', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  const bad = await $.tool.call({
    tool: 'Bash',
    command: 'git commit -m "PROJ-217: logic\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"',
  })
  expect(bad.deny).toContain('no Claude attribution')

  const good = await $.tool.call({ tool: 'Bash', command: 'git commit -m "PROJ-217: logic"' })
  expect(good.deny).toBeUndefined()
})

const now = new Date().toISOString()
const BOARD_LEDGER = {
  ...LEDGER,
  sources: {
    github: { ok: true, at: now }, jira: { ok: true, at: now },
    teams: { ok: true, at: '2020-01-01T08:00:00Z' }, outlook: { ok: false },
  },
  jira: {
    ...LEDGER.jira,
    board: [
      { key: 'PROJ-421', summary: 'Export to PDF', status: 'In Development', area: 'backend', assignee: 'Alex Example', due_date: null },
      { key: 'PROJ-438', summary: 'App shell', status: 'Backlog', area: 'frontend', assignee: 'Alex Example', due_date: null },
      { key: 'PROJ-445', summary: 'Tags screen', status: 'In Review', area: 'frontend', assignee: 'Jo Other', due_date: null },
      { key: 'PROJ-495', summary: 'Backup job', status: 'Backlog', area: 'devops', assignee: null, due_date: null },
    ],
  },
}
const QUESTIONS = {
  questions: [
    { id: 'q-send', topic: 'PROJ-227 settings screen', text: 'Should the theme switch sit on the settings page?', tickets: ['PROJ-227'], to: 'Sam Reviewer', status: 'to_send' },
    { id: 'q-wait', topic: 'Folder colours', to: 'Product owner', status: 'waiting', asked_at: '2026-11-02T00:00Z' },
    { id: 'q-ans', topic: 'PROJ-221 PDF page numbers', to: 'Sam Reviewer', status: 'answered', asked_at: now,
      answer: 'Page numbers at the foot; title on page one', answered_by: 'Sam Reviewer', answered_at: now, url: 'https://teams/x' },
    { id: 'q-old', topic: 'Very old answered question', status: 'answered', asked_at: '2020-01-01T00:00Z', answer: 'old', answered_at: '2020-01-01T00:00Z' },
  ],
}

function boardEngine(on: Parameters<TestBody>[1], writes: { path: string; text: string }[], copied: string[]) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('config.json') ? JSON.stringify({ ...CONFIG, questions_file: '/ledger/questions.json' })
      : e.path.endsWith('questions.json') ? (writes.at(-1)?.text ?? JSON.stringify(QUESTIONS))
      : JSON.stringify(BOARD_LEDGER),
  }))
  on('fs.write', (_, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('ui.copy', (_, e) => { copied.push(e.text); return { value: { isCopied: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
}

test('the board filters by area, status, search and mine', async ($, on) => {
  boardEngine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const keys = async () => (await ui.findAll({ type: 'Link' }))
    .map(l => String(l.props.label ?? '')).filter(label => /^4\d\d$/.test(label))

  expect(await keys()).toEqual(['421', '438', '445', '495'])
  await ui.select({ key: 'board-area', value: 'frontend' })
  expect(await keys()).toEqual(['438', '445'])
  await ui.select({ key: 'board-status', value: 'In Review' })
  expect(await keys()).toEqual(['445'])
  await ui.press({ key: 'board-clear' })
  expect(await keys()).toEqual(['421', '438', '445', '495'])
  await ui.input({ key: 'board-search', text: 'backup' })
  expect(await keys()).toEqual(['495'])
  await ui.input({ key: 'board-search', text: '' })
  await ui.press({ key: 'board-mine' })
  expect(await keys()).toEqual(['421', '438'])
  expect((await ui.find({ type: 'Text', text: /^DevOps$/ }))).toBeFalsy()
  await ui.unmount()
})

test('last update times show per source, and an old one is flagged', async ($, on) => {
  boardEngine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /updated \d\d:\d\d · / }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Teams \d\d:\d\d \(old\)/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Jira \d\d:\d\d$/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Outlook not checked/ }))).toBeTruthy()
  await ui.unmount()
})

test('questions: to send can be copied and marked sent; answered ones show the reply', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const copied: string[] = []
  boardEngine(on, writes, copied)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /TO SEND \(1\)/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER \(1\)/ }))).toBeTruthy()
  // Answered questions sit in their own card, folded at first.
  expect((await ui.find({ type: 'Text', text: /→ Page numbers at the foot; title on page one/ }))).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^1 answered · newest: PROJ-221 PDF page numbers$/ }))).toBeTruthy()
  await ui.press({ key: 'fold-answered' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /→ Page numbers at the foot; title on page one/ }))).toBeTruthy()
  const links = (await ui.findAll({ type: 'Link' })).map(l => [String(l.props.label), String(l.props.href)])
  expect(links).toContainEqual(['Open in Teams ↗', 'https://teams/x'])
  expect(links).toContainEqual(['PROJ-227', 'https://example.atlassian.net/browse/PROJ-227'])
  expect((await ui.find({ type: 'Text', text: /Very old answered question/ }))).toBeFalsy()

  await ui.press({ key: 'copy-q-send' })
  expect(copied).toEqual(['Should the theme switch sit on the settings page?'])

  await ui.press({ key: 'sent-q-send' })
  expect(writes).toHaveLength(1)
  const saved = JSON.parse(writes[0]?.text ?? '{}') as typeof QUESTIONS
  expect(saved.questions.find(q => q.id === 'q-send')?.status).toBe('waiting')
  expect(saved.questions).toHaveLength(4)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /TO SEND/ }))).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER \(2\)/ }))).toBeTruthy()
  await ui.unmount()
})

test('Mark answered moves a waiting question to answered; Not a question hides it; both are overrides', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  boardEngine(on, writes, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER \(1\)/ }))).toBeTruthy()

  await ui.press({ key: 'answered-q-wait' })
  const saved = JSON.parse(writes.at(-1)?.text ?? '{}') as { questions: { id: string; status: string; override?: { status: string } }[] }
  const q = saved.questions.find(x => x.id === 'q-wait')
  expect(q?.override?.status).toBe('answered')
  expect(q?.status).toBe('waiting') // the script's status is left alone; the override decides the view
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER/ }))).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^2 answered/ }))).toBeTruthy()
  // Undo, from the answered card, puts it back to waiting.
  await ui.press({ key: 'fold-answered' })
  await ui.redraw()
  await ui.press({ key: 'undo-q-wait' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER \(1\)/ }))).toBeTruthy()
  await ui.unmount()
})

test('Not a question hides a question, and Restore brings it back', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  boardEngine(on, writes, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'notq-q-wait' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /Folder colours/ }))).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER/ }))).toBeFalsy()
  // It is kept in a folded "hidden" list, and Restore brings it back.
  await ui.press({ key: 'fold-hidden' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /Folder colours/ }))).toBeTruthy()
  await ui.press({ key: 'restore-q-wait' })
  await ui.redraw()
  const saved = JSON.parse(writes.at(-1)?.text ?? '{}') as { questions: { id: string; override?: unknown }[] }
  expect(saved.questions.find(x => x.id === 'q-wait')?.override).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /WAITING FOR AN ANSWER \(1\)/ }))).toBeTruthy()
  await ui.unmount()
})

test('outside 09:00–09:30 and 17:30–18:00 the timer starts nothing, even if not run today', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted, LEDGER, null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const now = new Date()
  const hm = now.getHours() * 60 + now.getMinutes()
  const inWindow = (hm >= 540 && hm < 570) || (hm >= 1050 && hm < 1080)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (!inWindow) expect(submitted).toEqual([])
  await ui.unmount()
})

test('Refresh runs /daybook-refresh once, and Teams and Outlook read checking…', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted, { ...LEDGER, sources: { github: { ok: true }, jira: { ok: true }, teams: { ok: false }, outlook: { ok: false } } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Teams not checked/ }))).toBeTruthy()

  await ui.press({ key: 'refresh' })
  await ui.redraw()
  expect(submitted).toEqual(['/daybook-refresh'])
  expect((await ui.find({ type: 'Text', text: /Teams checking…/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Outlook checking…/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /GitHub checking/ }))).toBeFalsy()

  await ui.press({ key: 'refresh' })
  await ui.redraw()
  expect(submitted).toEqual(['/daybook-refresh'])
  await ui.unmount()
})

const OTHER = (() => { const o = new Date(d); o.setDate(o.getDate() - 1); return `${o.getFullYear()}-${pad(o.getMonth() + 1)}-${pad(o.getDate())}` })()
const MISSING = (() => { const o = new Date(d); o.setDate(o.getDate() - 2); return `${o.getFullYear()}-${pad(o.getMonth() + 1)}-${pad(o.getDate())}` })()
const nine = Array.from({ length: 9 }, (_, i) => ({
  key: `PROJ-${700 + i}`, summary: `Ticket ${i}`, status: 'In Review', start_date: DAY, due_date: DAY,
  worklogs_today: [{ seconds: (30 + i * 15) * 60 }],
}))
const WEEK_LEDGER = {
  ...LEDGER,
  jira: { logged_today_minutes: 525, week_minutes: { [MISSING]: 0, [OTHER]: 510, [DAY]: 525 }, tickets: nine },
}
const OTHER_LEDGER = {
  ...LEDGER, day: OTHER,
  jira: { logged_today_minutes: 510, week_minutes: {}, tickets: [
    { key: 'PROJ-218', summary: 'Notes service', status: 'In Review', start_date: OTHER, due_date: OTHER, worklogs_today: [{ seconds: 9900 }] },
    { key: 'PROJ-220', summary: 'Sharing', status: 'In Review', start_date: OTHER, due_date: OTHER, worklogs_today: [{ seconds: 9900 }] },
    { key: 'PROJ-219', summary: 'Search service', status: 'In Review', start_date: OTHER, due_date: OTHER, worklogs_today: [{ seconds: 10800 }] },
  ] },
}


const timeTitle = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  String((await ui.findAll({ type: 'Button' })).find(b => / TIME/.test(String(b.props.label)))?.props.label ?? '')

function weekEngine(on: Parameters<TestBody>[1], stored: Record<string, unknown> = {}) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(CONFIG) }
    if (e.path.endsWith(`${MISSING}.json`)) throw new Error('ENOENT')
    if (e.path.endsWith(`${OTHER}.json`)) return { value: JSON.stringify(OTHER_LEDGER) }
    return { value: JSON.stringify(WEEK_LEDGER) }
  })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('command.run', () => ({ text: '' }))
}

test('every ticket of the day is listed, and the charts are drawn interactive', async ($, on) => {
  weekEngine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  const bars = svgs.filter(s => /^PROJ-7\d\d /.test(String(s.props.alt)))
  expect(bars).toHaveLength(9)
  expect(String(bars[0]?.props.source)).toContain('<animate attributeName="width"')
  expect(svgs.every(s => s.props.isInteractive === true)).toBe(true)
  const links = (await ui.findAll({ type: 'Link' })).filter(l => /^7\d\d$/.test(String(l.props.label)))
  expect(new Set(links.map(l => l.props.href)).size).toBe(9)
  expect(links.find(l => l.props.label === '708')?.props.href).toBe('https://example.atlassian.net/browse/PROJ-708')
  const week = svgs.find(s => String(s.props.alt).startsWith('Minutes logged this week'))
  expect(String(week?.props.source)).toContain('>8h 30m<animate')
  expect(String(week?.props.source)).toContain('>8h 45m<animate')
  expect(await timeTitle(ui)).toBe('▾ TIME TODAY')
  await ui.unmount()
})

test('picking a day shows that day; a day with no file says so; Back to today returns', async ($, on) => {
  weekEngine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: `day-${OTHER}` })
  await ui.redraw()
  expect(await timeTitle(ui)).toMatch(/^▾ TIME · /)
  expect((await ui.find({ type: 'Text', text: /^8h 30m$/ }))).toBeTruthy()
  const bars = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).filter(a => /^PROJ-\d+ /.test(a))
  expect(bars).toEqual(['PROJ-219 3h', 'PROJ-218 2h 45m', 'PROJ-220 2h 45m'])
  const link = (await ui.findAll({ type: 'Link' })).find(l => l.props.label === '219')
  expect(link?.props.href).toBe('https://example.atlassian.net/browse/PROJ-219')

  await ui.press({ key: `day-${MISSING}` })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /No data for this day/ }))).toBeTruthy()

  await ui.press({ key: 'day-today' })
  await ui.redraw()
  expect(await timeTitle(ui)).toBe('▾ TIME TODAY')
  expect((await ui.find({ type: 'Text', text: /^8h 45m$/ }))).toBeTruthy()
  await ui.unmount()
})

test('cards fold and unfold, Collapse all folds every card, and the choice is saved', async ($, on) => {
  const stored: Record<string, unknown> = {}
  weekEngine(on, stored)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'fold-time' })
  await ui.redraw()
  expect(await timeTitle(ui)).toBe('▸ TIME TODAY')
  expect((await ui.find({ type: 'Text', text: /^8h 45m · in range · week / }))).toBeTruthy()
  expect((await ui.findAll({ type: 'Svg' })).filter(s => String(s.props.alt).startsWith('PROJ-'))).toHaveLength(0)
  expect((stored.folded as Record<string, boolean>).time).toBe(true)

  await ui.press({ key: 'fold-time' })
  await ui.redraw()
  expect(await timeTitle(ui)).toBe('▾ TIME TODAY')

  await ui.press({ key: 'fold-all' })
  await ui.redraw()
  expect(Object.values(stored.folded as Record<string, boolean>).every(Boolean)).toBe(true)
  expect(await timeTitle(ui)).toBe('▸ TIME TODAY')
  await ui.press({ key: 'fold-all' })
  await ui.redraw()
  expect(await timeTitle(ui)).toBe('▾ TIME TODAY')
  await ui.unmount()
})

test('Settings lists each category with its tool and whether the last gather reached it', async ($, on) => {
  weekEngine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  expect(texts).toContain('Jira')
  expect(texts).toContain('GitHub')
  expect(texts.filter(t => t.startsWith('● connected'))).toHaveLength(3)
  expect(texts.filter(t => t === '○ off')).toHaveLength(3)
  expect(texts.some(t => t.startsWith('Change a tool in /.claude/daybook/config.json') || t.includes('config.json'))).toBe(true)
  await ui.unmount()
})

const MANY = {
  ...BOARD_LEDGER,
  jira: { ...BOARD_LEDGER.jira, board: Array.from({ length: 12 }, (_, i) => ({
    key: `PROJ-${800 + i}`, summary: `Board ticket ${i}`, status: 'In Review', area: 'backend', assignee: null, due_date: null,
  })) },
}

test('the board pages by 10: numbers, Prev and Next, and a range; a filter goes back to page 1', async ($, on) => {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('config.json') ? JSON.stringify(CONFIG) : JSON.stringify(MANY) }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const keys = async () => (await ui.findAll({ type: 'Link' })).map(l => String(l.props.label)).filter(l => /^8\d\d$/.test(l))

  expect(await keys()).toHaveLength(10)
  expect((await ui.find({ type: 'Text', text: /^1–10 of 12$/ }))).toBeTruthy()
  await ui.press({ key: 'board-next' })
  expect(await keys()).toEqual(['810', '811'])
  expect((await ui.find({ type: 'Text', text: /^11–12 of 12$/ }))).toBeTruthy()
  await ui.press({ key: 'board-page-1' })
  expect(await keys()).toHaveLength(10)
  await ui.press({ key: 'board-page-2' })
  await ui.input({ key: 'board-search', text: 'Board' })
  expect((await ui.find({ type: 'Text', text: /^1–10 of 12$/ }))).toBeTruthy()
  await ui.press({ key: 'board-more' })
  expect(await keys()).toHaveLength(12)
  await ui.unmount()
})

test('a narrow pane drops the Area and Who columns; a wide one keeps them', async ($, on) => {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('config.json') ? JSON.stringify(CONFIG) : JSON.stringify(MANY) }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const heads = async (columns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns, rows: 40 } })
    const found = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t === 'Area' || t === 'Who')
    await ui.unmount()
    return found
  }
  expect(await heads(50)).toEqual([])
  expect(await heads(140)).toEqual(['Area', 'Who'])
})

test('a question to send opens a chat with the person and the question typed in, when the email is known', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  boardEngine(on, writes, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The board engine's config has no people, so no compose link: Copy stays.
  expect((await ui.findAll({ type: 'Link' })).find(l => String(l.props.label).startsWith('Send in'))).toBeFalsy()
  await ui.unmount()
})

test('with the recipient in people, Send in Teams carries the email and the encoded question', async ($, on) => {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('config.json')
      ? JSON.stringify({ ...CONFIG, questions_file: '/ledger/questions.json', people: { 'Sam Reviewer': 'sam@example.com' } })
      : e.path.endsWith('questions.json') ? JSON.stringify(QUESTIONS) : JSON.stringify(BOARD_LEDGER),
  }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const send = (await ui.findAll({ type: 'Link' })).find(l => l.props.label === 'Send in Teams ↗')
  expect(send?.props.href).toBe('https://teams.microsoft.com/l/chat/0/0?users=sam%40example.com&message=' +
    encodeURIComponent('Should the theme switch sit on the settings page?'))
  await ui.unmount()
})

// As if typed at the prompt.
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

test('/daybook demo fills every card with made-up data, reads no file and runs nothing', async ($, on) => {
  const reads: string[] = []
  const writes: string[] = []
  const stored: Record<string, unknown> = {}
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => { reads.push(e.path); throw new Error('no file') })
  on('fs.write', (_, e) => { writes.push(e.path); return { value: undefined } })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'daybook', args: 'demo', ...TYPED })
  expect(out.text).toMatch(/made-up data/)
  expect(stored.demo).toBe(true)
  reads.length = 0
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'DEMO' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Alex/ })).toBeTruthy()
  for (const title of ['QUESTIONS', 'PULL REQUESTS', 'TICKETS', 'BOARD']) {
    expect((await ui.findAll({ type: 'Button' })).some(b => String(b.props.label).includes(title))).toBe(true)
  }
  expect((await ui.findAll({ type: 'Link' })).some(l => String(l.props.href).includes('example'))).toBe(true)
  // a button in demo changes memory only
  await ui.press({ key: 'notq-demo-w1' })
  expect(writes).toEqual([])
  expect(reads.filter(p => !p.endsWith('config.json'))).toEqual([])
  await ui.unmount()
  await $.command.run({ command: 'daybook', args: 'live', ...TYPED })
  expect(stored.demo).toBe(false)
})

test('Check connections shows the doctor: how many are ok, and the exact fix for the rest', async ($, on) => {
  const stored: Record<string, unknown> = { demo: true }
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => { throw new Error('no file') })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'daybook', args: 'doctor', ...TYPED })
  expect(out.text).toMatch(/3 of 4 ok/)
  expect(out.text).toMatch(/→ sign the connector in/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'doctor' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^3 of 4 ok/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✘ mail: outlook: connector not signed in/ })).toBeTruthy()
  await ui.unmount()
})

test('with no actions in the config there is no action bar, and nothing is scheduled', async ($, on) => {
  const submitted: string[] = []
  const bare = { ...CONFIG, actions: undefined, schedule: undefined }
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('config.json') ? JSON.stringify(bare) : JSON.stringify(LEDGER) }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', (_, e) => { submitted.push(e.command); return { text: '' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  expect(labels).not.toContain('Propose timesheet')
  expect(labels).not.toContain('Draft status')
  expect(submitted.filter(c => c !== 'daybook-refresh')).toEqual([])
  await ui.unmount()
})
