import { expect, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

// The PR tracker card: counts, groups by status, the filters, the merged window, Copy summary,
// and the old table for a day file that has no tracker yet.

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const DAY = iso(new Date())
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const CONFIG = {
  ledger_dir: '/ledger', day_min_minutes: 495, day_max_minutes: 540, me: 'Alex Example',
  providers: { tickets: { type: 'jira', site: 'https://example.atlassian.net' }, code: { type: 'github' } },
}
const row = (label: string, number: number, status: string, note: string, at: string, tickets: string[] = [`PROJ-${number}`]) => ({
  repo: `x/${label.toLowerCase()}`, label, number, title: `PROJ-${number}: thing`, url: `https://github.com/x/${label}/pull/${number}`,
  tickets, status, note, base: 'develop', created_at: at, merged_at: status === 'merged' ? at : null,
})
const TRACKER = [
  row('API', 629, 'needs_fixes', 'Sam: 2 comments · 2026-11-27', ago(1)),
  row('API', 630, 'blocked', 'waits for API #629', ago(1)),
  row('WEB', 570, 'in_review', 'asked Sam', ago(0.5)),
  row('API', 625, 'merged', '', ago(2)),
  row('WEB', 556, 'merged', '', ago(10)),
]
const LEDGER = {
  day: DAY, gathered_at: new Date().toISOString(), sources: { github: { ok: true }, jira: { ok: true } },
  github: { login: 'alex', prs: [], tracker: TRACKER },
  jira: { logged_today_minutes: 0, week_minutes: {}, tickets: [] },
}
const PANE = {
  plugin: 'daybook', component: 'Pane', requestId: 'daybook',
  props: { title: 'Daybook', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

function engine(on: Parameters<TestBody>[1], copied: string[], ledger: object = LEDGER) {
  on('command.register', () => ({ value: { command: 'daybook' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(CONFIG) }
    if (e.path.endsWith('questions.json') || e.path.endsWith('scrum.json')) throw new Error('no file')
    return { value: JSON.stringify(ledger) }
  })
  on('ui.copy', (_, e) => { copied.push(e.text); return { value: { isCopied: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: DAY }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
}
const prLinks = async (ui: Mounted<'desktop', 'Pane'>) => (await ui.findAll({ type: 'Link' }))
  .map(l => String(l.props.label ?? '')).filter(l => /^(API|WEB) #\d+$/.test(l))

test('the counts, and open pull requests grouped by status, needs fixes first', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await prLinks(ui)).toEqual(['API #629', 'API #630', 'WEB #570'])
  expect(await ui.find({ type: 'Text', text: 'Needs fixes' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'waits for API #629' })).toBeTruthy()
  // Open 3 · Needs fixes 1 · Merged 1 in 7 days (the 10-day-old merge is outside the window)
  expect((await ui.find({ type: 'Button', key: 'pr-count-merged' }))?.props.label).toBe('Merged 1 in 7d')
  expect((await ui.find({ type: 'Button', key: 'pr-count-fixes' }))?.props.label).toBe('Needs fixes 1')
  expect((await ui.find({ type: 'Button', key: 'pr-count-open' }))?.props.label).toBe('Open 3')
  await ui.unmount()
})

test('the filters: merged, the window, status, repository and search', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pr-count-merged' })
  expect(await prLinks(ui)).toEqual(['API #625'])
  await ui.press({ key: 'pr-days-14' })
  expect(await prLinks(ui)).toEqual(['API #625', 'WEB #556'])
  await ui.press({ key: 'pr-count-all' })
  await ui.select({ key: 'pr-status', value: 'blocked' })
  expect(await prLinks(ui)).toEqual(['API #630'])
  await ui.select({ key: 'pr-status', value: 'all' })
  await ui.select({ key: 'pr-repo', value: 'WEB' })
  expect(await prLinks(ui)).toEqual(['WEB #570', 'WEB #556'])
  await ui.press({ key: 'pr-clear' })
  await ui.input({ key: 'pr-search', text: '629' })
  expect(await prLinks(ui)).toEqual(['API #629'])
  await ui.input({ key: 'pr-search', text: 'nothing-like-this' })
  expect(await ui.find({ type: 'Text', text: 'Nothing matches these filters.' })).toBeTruthy()
  await ui.unmount()
})

test('pressing a count shows just those: needs fixes, merged, open', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pr-count-fixes' })
  expect(await prLinks(ui)).toEqual(['API #629'])
  expect((await ui.find({ type: 'Button', key: 'pr-count-fixes' }))?.props.variant).toBe('secondary')
  await ui.press({ key: 'pr-count-merged' })
  expect(await prLinks(ui)).toEqual(['API #625'])
  await ui.press({ key: 'pr-count-open' })
  expect(await prLinks(ui)).toEqual(['API #629', 'API #630', 'WEB #570'])
  await ui.unmount()
})

test('Copy summary gives the counts and a line per pull request', async ($, on) => {
  const copied: string[] = []
  engine(on, copied)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pr-copy' })
  expect(copied[0]?.split('\n')[0]).toBe('PRs: 3 open, 1 need fixes, 1 merged in the last 7 days')
  expect(copied[0]).toContain('- API #630 PROJ-630: waits for API #629')
  expect(copied[0]).not.toContain('WEB #556')
  await ui.unmount()
})

test('a day file without the tracker keeps the old pull request table', async ($, on) => {
  engine(on, [], { ...LEDGER, github: { login: 'alex', prs: [{
    number: 7, url: 'https://github.com/x/y/pull/7', state: 'OPEN', mergedAt: null, reviewDecision: '',
    tickets: ['PROJ-7'], comments: [], inline_comments: [], reviews: [],
  }] } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'pr-count-open' })).toBeFalsy()
  expect((await ui.findAll({ type: 'Link' })).some(l => l.props.href === 'https://github.com/x/y/pull/7')).toBe(true)
  await ui.unmount()
})
