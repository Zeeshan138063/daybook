import { expect, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

// The Scrum card: yesterday's target against now, today's plan (suggested, then locked), Carry over,
// Start and Done through a dry run and a Confirm, and a demo that runs nothing.

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const DAY = iso(new Date())
const PREV = (() => { const p = new Date(); do p.setDate(p.getDate() - 1); while (p.getDay() === 0 || p.getDay() === 6); return iso(p) })()

const CONFIG = {
  ledger_dir: '/ledger', day_min_minutes: 495, day_max_minutes: 540, me: 'Alex Example',
  providers: { tickets: { type: 'jira', site: 'https://example.atlassian.net' }, code: { type: 'github' } },
}
const LEDGER = {
  day: DAY,
  gathered_at: `${DAY}T08:00:00Z`,
  sources: { github: { ok: true }, jira: { ok: true } },
  github: { login: 'alex', prs: [{ number: 7, url: 'https://github.com/x/y/pull/7', state: 'OPEN', mergedAt: null,
    reviewDecision: '', tickets: ['PROJ-2'], comments: [], inline_comments: [], reviews: [] }] },
  jira: {
    logged_today_minutes: 0, week_minutes: {}, tickets: [],
    mine: [
      { key: 'PROJ-1', summary: 'Shipped yesterday', status: 'In Review' },
      { key: 'PROJ-2', summary: 'Still going', status: 'In Development' },
      { key: 'PROJ-3', summary: 'Not started', status: 'Backlog' },
      { key: 'PROJ-4', summary: 'Next up', status: 'Backlog' },
      { key: 'PROJ-5', summary: 'After that', status: 'Backlog' },
      { key: 'PROJ-6', summary: 'No PR yet', status: 'In Development' },
    ],
  },
}
const PLAN = {
  days: {
    [PREV]: {
      locked_at: `${PREV}T09:00:00Z`,
      items: [
        { key: 'PROJ-1', summary: 'Shipped yesterday', status_at_lock: 'In Development' },
        { key: 'PROJ-2', summary: 'Still going', status_at_lock: 'Backlog' },
        { key: 'PROJ-3', summary: 'Not started', status_at_lock: 'Backlog', reason: 'waiting on design' },
      ],
    },
  },
}

const PANE = {
  plugin: 'daybook', component: 'Pane', requestId: 'daybook',
  props: { title: 'Daybook', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

type Run = { argv: readonly string[] }
function engine(on: Parameters<TestBody>[1], runs: Run[], writes: { path: string; text: string }[], answer: (argv: readonly string[]) => object, questions?: object) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(CONFIG) }
    if (e.path.endsWith('scrum.json')) return { value: writes.filter(w => w.path.endsWith('scrum.json')).at(-1)?.text ?? JSON.stringify(PLAN) }
    if (e.path.endsWith('questions.json')) { if (questions) return { value: JSON.stringify(questions) }; throw new Error('no file') }
    return { value: JSON.stringify(LEDGER) }
  })
  on('fs.write', (_, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv })
    return { value: { exitCode: 0, stdout: JSON.stringify(answer(e.argv)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
}

const moveAnswer = (argv: readonly string[]) => {
  const key = argv[argv.indexOf('move') + 1]
  const start = argv[argv.indexOf('--to') + 1] === 'start'
  const dry = argv.includes('--dry-run')
  return {
    key, from: start ? 'Backlog' : 'In Development', to: start ? 'In Development' : 'In Review',
    transition: { name: start ? 'Start Development' : 'Submit for Review' },
    fields: start ? { 'Start date': [null, DAY] } : { 'Due date': [null, DAY] }, wrote: !dry, error: null,
  }
}
type Plan = { days: Record<string, { locked_at: string | null; items: { key: string }[]; moves?: { key: string; from: string; to: string }[] }> }
const lastPlan = (writes: { path: string; text: string }[]) =>
  JSON.parse(writes.filter(w => w.path === '/ledger/scrum.json').at(-1)?.text ?? '{}') as Plan

test('yesterday shows each ticket then and now, and today is suggested from it', async ($, on) => {
  engine(on, [], [], moveAnswer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^1 of 3 delivered$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Dev → Review' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Not started · waiting on design/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Suggested: not locked yet$/ })).toBeTruthy()
  // carry-overs (2, 3), mine in progress (6), then the next two To Do by key (4, 5)
  const startKeys = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key ?? ''))
  for (const k of ['scrum-done-PROJ-2', 'scrum-start-PROJ-3', 'scrum-done-PROJ-6', 'scrum-start-PROJ-4', 'scrum-start-PROJ-5']) {
    expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  }
  expect(startKeys.includes('scrum-start-PROJ-1')).toBe(false)
  await ui.unmount()
})

test('Blockers in the status line opens every waiting question with its thread', async ($, on) => {
  engine(on, [], [], moveAnswer, { questions: [
    { id: 'q1', topic: 'PROJ-3 design call', to: 'Sam Reviewer', status: 'waiting', asked_at: '2026-01-02T09:00:00Z', url: 'https://teams/q1' },
    { id: 'q2', topic: 'Old answered', to: 'Sam', status: 'answered', asked_at: '2026-01-01T09:00:00Z', answer: 'yes' },
  ] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'scrum-blockers' }))?.props.label).toBe('Blockers 1 ▾')
  expect(await ui.find({ type: 'Text', text: /Sam · PROJ-3 design call/ })).toBeFalsy()
  await ui.press({ key: 'scrum-blockers' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: 'Sam · PROJ-3 design call' })).toBeTruthy()
  expect((await ui.findAll({ type: 'Link' })).some(l => l.props.href === 'https://teams/q1')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Old answered/ })).toBeFalsy()
  await ui.unmount()
})

test('Lock saves today with each status, and Carry over adds yesterday\'s ticket', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, [], writes, moveAnswer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-more-PROJ-3' })
  await ui.redraw()
  await ui.press({ key: 'scrum-remove-PROJ-3' })
  await ui.redraw()
  expect(lastPlan(writes).days[DAY]?.items.map(i => i.key)).toEqual(['PROJ-2', 'PROJ-6', 'PROJ-4', 'PROJ-5'])
  await ui.press({ key: 'scrum-carry-PROJ-3' })
  await ui.press({ key: 'scrum-lock' })
  await ui.redraw()
  const day = lastPlan(writes).days[DAY]
  expect(day?.locked_at).toBeTruthy()
  expect(day?.items.find(i => i.key === 'PROJ-3')).toEqual(
    { key: 'PROJ-3', summary: 'Not started', status_at_lock: 'Backlog', carried_from: PREV })
  expect(lastPlan(writes).days[PREV]).toEqual(PLAN.days[PREV])
  expect(await ui.find({ type: 'Text', text: /^Locked \d/ })).toBeTruthy()
  await ui.unmount()
})

test('Start shows the dry run and writes nothing to Jira until Confirm', async ($, on) => {
  const runs: Run[] = []
  const writes: { path: string; text: string }[] = []
  engine(on, runs, writes, moveAnswer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-start-PROJ-4' })
  await ui.redraw()
  expect(runs.length).toBe(1)
  expect(runs[0]?.argv).toContain('--dry-run')
  expect(await ui.find({ type: 'Text', text: `Backlog → In Development (Start Development) · Start date: empty → ${DAY}` })).toBeTruthy()
  await ui.press({ key: 'scrum-cancel-PROJ-4' })
  await ui.redraw()
  expect(runs.length).toBe(1)
  expect(writes).toEqual([])

  await ui.press({ key: 'scrum-start-PROJ-4' })
  await ui.press({ key: 'scrum-confirm-PROJ-4' })
  await ui.redraw()
  expect(runs.map(r => r.argv.includes('--dry-run'))).toEqual([true, true, false])
  expect(lastPlan(writes).days[DAY]?.moves?.[0]).toMatchObject({ key: 'PROJ-4', from: 'Backlog', to: 'In Development' })
  expect(await ui.find({ type: 'Button', key: 'scrum-done-PROJ-4' })).toBeTruthy()
  await ui.unmount()
})

test('Done on a ticket no PR names warns before Confirm; one with a PR does not', async ($, on) => {
  engine(on, [], [], moveAnswer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-done-PROJ-6' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /No PR in today's data names this ticket/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'scrum-confirm-PROJ-6' }))?.props.label).toBe('Confirm anyway')
  await ui.press({ key: 'scrum-done-PROJ-2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /No PR in today's data/ })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'scrum-confirm-PROJ-2' }))?.props.label).toBe('Confirm')
  await ui.unmount()
})

test('a move the script refuses shows its error and offers no Confirm', async ($, on) => {
  engine(on, [], [], argv => ({ key: argv[argv.indexOf('move') + 1], wrote: false, error: 'PROJ-4 is In Review; start moves a ticket from Backlog' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-start-PROJ-4' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /PROJ-4 is In Review/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'scrum-confirm-PROJ-4' })).toBeFalsy()
  await ui.unmount()
})

test('in demo mode Start and Confirm run nothing and save nothing', async ($, on) => {
  const runs: Run[] = []
  const writes: { path: string; text: string }[] = []
  const stored: Record<string, unknown> = { demo: true }
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => { throw new Error('no file') })
  on('fs.write', (_, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('process.run', (_, e) => { runs.push({ argv: e.argv }); throw new Error('no process in demo') })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /of 4 delivered$/ })).toBeTruthy()
  const start = (await ui.findAll({ type: 'Button' })).find(b => String(b.props.key ?? '').startsWith('scrum-start-'))
  expect(start).toBeTruthy()
  const key = String(start?.props.key).replace('scrum-start-', '')
  await ui.press({ key: `scrum-start-${key}` })
  await ui.press({ key: `scrum-confirm-${key}` })
  await ui.press({ key: 'scrum-lock' })
  await ui.redraw()
  expect(runs).toEqual([])
  expect(writes).toEqual([])
  expect(await ui.find({ type: 'Button', key: `scrum-done-${key}` })).toBeTruthy()
  await ui.unmount()
})

// ── How today is picked ──────────────────────────────────────────────────────────────────────
const inDays = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return iso(x) }
const PICK_LEDGER = {
  ...LEDGER,
  jira: {
    ...LEDGER.jira,
    mine: [
      { key: 'PROJ-20', summary: 'Low, no date', status: 'Backlog', priority: 'Low', due_date: null },
      { key: 'PROJ-21', summary: 'Highest', status: 'Backlog', priority: 'Highest', due_date: null },
      { key: 'PROJ-22', summary: 'Due tomorrow', status: 'Backlog', priority: 'Medium', due_date: inDays(1) },
      { key: 'PROJ-23', summary: 'High, due later', status: 'Backlog', priority: 'High', due_date: inDays(9) },
      { key: 'PROJ-24', summary: 'Going', status: 'In Development', priority: 'Low', due_date: null },
    ],
    orders: { board: ['PROJ-23', 'PROJ-20', 'PROJ-21'] },
    order_errors: {},
  },
}
function pickEngine(on: Parameters<TestBody>[1], writes: { path: string; text: string }[], ledger: object = PICK_LEDGER, plan: object = { days: {} }) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(CONFIG) }
    if (e.path.endsWith('scrum.json')) return { value: writes.filter(w => w.path.endsWith('scrum.json')).at(-1)?.text ?? JSON.stringify(plan) }
    if (e.path.endsWith('questions.json')) throw new Error('no file')
    return { value: JSON.stringify(ledger) }
  })
  on('fs.write', (_, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('process.run', () => { throw new Error('no process') })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
}
type Ui = Mounted<'desktop', 'Pane'>
// today's ticket keys in the order the board lists them (To do, then In progress, then Delivered)
const todayKeys = async (ui: Ui) => (await ui.findAll({ type: 'Button' }))
  .map(b => String(b.props.key ?? '')).filter(k => /^scrum-(start|done)-/.test(k)).map(k => k.replace(/^scrum-(start|done)-/, ''))
const tagOf = async (ui: Ui, text: string) => !!(await ui.find({ type: 'Text', text }))

test('most urgent first: in progress, then due soon, then priority, within the daily allowance', async ($, on) => {
  pickEngine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // allowance 2: due tomorrow (22), then the highest priority (21); in progress (24) always fits
  expect(await todayKeys(ui)).toEqual(['PROJ-22', 'PROJ-21', 'PROJ-24'])
  expect(await tagOf(ui, /^due \d+ \w+$/ as unknown as string)).toBe(true)
  expect(await tagOf(ui, 'Highest')).toBe(true)
  expect(await tagOf(ui, 'in progress')).toBe(true)
  await ui.unmount()
})

test('a preset, a rule switched off or moved, and the allowance change the suggestion and are saved', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  pickEngine(on, writes)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-settings' })
  await ui.press({ key: 'scrum-preset-board' })
  await ui.redraw()
  expect(await todayKeys(ui)).toEqual(['PROJ-23', 'PROJ-20', 'PROJ-24'])
  expect(await tagOf(ui, 'board order')).toBe(true)
  const saved = () => JSON.parse(writes.at(-1)?.text ?? '{}') as { settings: { preset: string; new_per_day: number; rules: { id: string; on: boolean }[] } }
  expect(saved().settings.preset).toBe('board')

  await ui.press({ key: 'scrum-new-plus' })
  await ui.redraw()
  expect(await todayKeys(ui)).toEqual(['PROJ-23', 'PROJ-20', 'PROJ-21', 'PROJ-24'])
  expect(saved().settings.new_per_day).toBe(3)

  await ui.press({ key: 'scrum-rule-on-priority' })
  await ui.press({ key: 'scrum-rule-up-priority' })
  await ui.press({ key: 'scrum-rule-up-priority' })
  await ui.redraw()
  expect(saved().settings.preset).toBe('custom')
  // priority now runs before the board order: 21 (Highest), 23 (High), 22 (Medium)
  expect(await todayKeys(ui)).toEqual(['PROJ-21', 'PROJ-23', 'PROJ-22', 'PROJ-24'])
  await ui.unmount()
})

test('Next up is picked first in its own order, and a typed pick goes straight onto today', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  pickEngine(on, writes)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scrum-settings' })
  await ui.input({ key: 'scrum-queue-input', text: '20 23', kind: 'submit' })
  await ui.redraw()
  expect((JSON.parse(writes.at(-1)?.text ?? '{}') as { queue: string[] }).queue).toEqual(['PROJ-20', 'PROJ-23'])
  expect(await todayKeys(ui)).toEqual(['PROJ-20', 'PROJ-23', 'PROJ-24'])
  expect(await tagOf(ui, 'Next up #1')).toBe(true)
  await ui.press({ key: 'scrum-q-remove-PROJ-20' })
  await ui.redraw()
  expect((JSON.parse(writes.at(-1)?.text ?? '{}') as { queue: string[] }).queue).toEqual(['PROJ-23'])

  await ui.input({ key: 'scrum-pick', text: 'PROJ-21', kind: 'submit' })
  await ui.redraw()
  const day = (JSON.parse(writes.at(-1)?.text ?? '{}') as Plan).days[DAY]
  expect(day?.items.map(i => i.key)).toContain('PROJ-21')
  expect(await tagOf(ui, 'picked')).toBe(true)
  await ui.unmount()
})

test('a failed custom search is said on the card and the other rules still pick', async ($, on) => {
  pickEngine(on, [], { ...PICK_LEDGER, jira: { ...PICK_LEDGER.jira, orders: { board: [] }, order_errors: { custom: '400 bad JQL' } } },
    { days: {}, settings: { preset: 'custom', rules: [{ id: 'custom', on: true }, { id: 'in_progress', on: true }, { id: 'priority', on: true }],
      due_days: 2, new_per_day: 1, custom_jql: 'nonsense' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not used this time: My custom Jira search: 400 bad JQL/ })).toBeTruthy()
  expect(await todayKeys(ui)).toEqual(['PROJ-21', 'PROJ-24'])
  await ui.unmount()
})
