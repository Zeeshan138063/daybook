import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  ActionButton, Area, BoardRow, DayTime, Doctor, Filters, ProviderRow, Need, PrRow, QuestionRow, QuestionStatus,
  PrFilters, ScrumPending, ScrumView, TicketRow, TicketTime, TrackerRow, TrackerStatus, View, WeekDay,
} from '../types'
import { demoConfig, demoLedger, demoQuestions, demoScrum } from './demo'
import { DEFAULT_SETTINGS, PRESETS, RULE_LABEL, scrumView, settingsOf } from './scrum'
import type { JiraLite, PickSettings, PresetId, RuleId, ScrumDay, ScrumFile, ScrumItem } from './scrum'

// The Daybook panel: what needs you, the day's time against its range and the week, your questions
// (to send, waiting, answered with the reply), PRs and today's tickets as tables, the project's
// board by area with status, search and "mine" filters, and buttons that start the skills.
//
// Everything personal lives in the config file: $DAYBOOK_CONFIG, else ~/.claude/daybook/config.json.
// The panel reads the day file (<ledger_dir>/<day>.json) the collectors write, in the shape of
// schema/day.schema.json, and the questions file; the one thing it writes is a question's "sent"
// mark in the questions file, and the Scrum card's plan (<ledger_dir>/scrum.json). The Scrum card's
// Start and Done write to Jira, each only after its own Confirm (scripts/run.sh scrum move). Every
// other write happens in a skill, after a yes.

const PANE = 'daybook'
const ATTRIBUTION = /Co-Authored-By:\s*Claude|Generated with \[?Claude Code/i
// The accent colour; the config's ui.accent replaces it when the config loads.
let TEAL = '#0f9d8a'

// Where the config lives, and ~ expanded against $HOME. Read once per session.
let homeDir = ''
async function home($: EngineInterface): Promise<string> {
  if (!homeDir) homeDir = (await $.env.get('HOME')) ?? ''
  return homeDir
}
async function configPath($: EngineInterface): Promise<string> {
  return expand(await home($), (await $.env.get('DAYBOOK_CONFIG')) || '~/.claude/daybook/config.json')
}
const expand = (h: string, p: string) => (p.startsWith('~/') ? `${h}${p.slice(1)}` : p)

// Demo mode (/daybook demo): made-up data from hooks/demo.ts, nothing read from or written to disk,
// no command run. Kept in $.store so a reload stays in the mode the person chose.
let demo = false
let demoQs: QuestionsFile | null = null
let demoPlan: ScrumFile | null = null
async function setDemo($: EngineInterface, on: boolean) {
  demo = on
  demoQs = null
  demoPlan = null
  await $.store.set('demo', on)
  await update($, picked, () => null)
}

async function readConfig($: EngineInterface): Promise<Config> {
  if (demo) return demoConfig() as Config
  const h = await home($)
  const path = await configPath($)
  const cfg = { ...(JSON.parse(await $.fs.read(path)) as Config), config_path: path.replace(h, '~') }
  if (cfg.ui?.accent) TEAL = cfg.ui.accent
  return {
    ...cfg,
    ledger_dir: expand(h, cfg.ledger_dir),
    questions_file: cfg.questions_file ? expand(h, cfg.questions_file) : undefined,
    gather_command: expand(h, cfg.gather_command ?? '~/.claude/daybook/gather.sh'),
  }
}

// A ticket's link: the tracker's url_template ({site}, {key}, {number}), else Jira's /browse/.
function ticketUrl(cfg: Config, key: string): string {
  const t = cfg.providers?.tickets
  const site = (t?.site ?? cfg.jira_site ?? '').replace(/\/$/, '')
  const template = t?.url_template ?? '{site}/browse/{key}'
  return site || t?.url_template
    ? template.replace('{site}', site).replace('{key}', key).replace('{number}', key.replace(/^\D+/, ''))
    : ''
}

// Several tickets at once: the tracker's search_url_template ({site}, {keys}), else a Jira JQL search.
function ticketsUrl(cfg: Config, keys: string[]): string {
  const t = cfg.providers?.tickets
  const site = (t?.site ?? cfg.jira_site ?? '').replace(/\/$/, '')
  if (!keys.length || !(site || t?.search_url_template)) return ''
  const template = t?.search_url_template ?? '{site}/issues/?jql=key%20in%20({keys})%20ORDER%20BY%20key'
  return template.replace('{site}', site).replace('{keys}', encodeURIComponent(keys.join(',')))
}

const CHAT_NAMES: Record<string, string> = { teams: 'Teams', slack: 'Slack' }
const COMPOSE_DEFAULTS: Record<string, string> = {
  teams: 'https://teams.microsoft.com/l/chat/0/0?users={email}&message={text}',
}
// A chat window to that person with the question already typed; sending stays with the user.
function composeUrl(cfg: Config, to: string, text: string): string {
  const chat = cfg.providers?.chat
  const template = chat?.compose_url ?? COMPOSE_DEFAULTS[chat?.type ?? 'teams'] ?? ''
  const email = Object.entries(cfg.people ?? {}).find(([name]) => samePerson(name, to))?.[1] ?? ''
  if (!template || (template.includes('{email}') && !email)) return ''
  return template.replace('{email}', encodeURIComponent(email)).replace('{text}', encodeURIComponent(text))
}

const STALE_MS = 2 * 60 * 60 * 1000
// A row under the pointer: a faint grey that reads in light and dark, never washing out the text.
const ROW_HOVER = '#8080801f'
const BOARD_PAGE = 10
const ANSWERED_DAYS = 7
const DEFAULT_FILTERS: Filters = { area: 'all', status: 'all', search: '', mineOnly: false, showAll: false, page: 0 }

const view = atom({ plugin: 'daybook', key: 'view' } as const, null, { shape: 'view-8' })
// The Scrum card: a Start or Done waiting for Confirm, the ticket being moved, the ticket whose
// "not done" reason is being typed.
const scrumPending = atom({ plugin: 'daybook', key: 'scrumPending' } as const, null, { shape: 'scrum-pending-1' })
const scrumBusy = atom({ plugin: 'daybook', key: 'scrumBusy' } as const, null, { shape: 'scrum-busy-1' })
const scrumReason = atom({ plugin: 'daybook', key: 'scrumReason' } as const, null, { shape: 'scrum-reason-1' })
// The ticket whose ⋯ is open (Not done, Take off today), and whether every blocker is shown.
const scrumMenu = atom({ plugin: 'daybook', key: 'scrumMenu' } as const, null, { shape: 'scrum-menu-1' })
const scrumAllBlockers = atom({ plugin: 'daybook', key: 'scrumAllBlockers' } as const, false, { shape: 'scrum-blockers-1' })
// The "How today is picked" screen, and its Advanced part (the custom Jira search).
const scrumSettingsOpen = atom({ plugin: 'daybook', key: 'scrumSettingsOpen' } as const, false, { shape: 'scrum-settings-1' })
// The Pull requests card's filters: open / merged / all, status, repository, search, merged window.
const DEFAULT_PR_FILTERS: PrFilters = { show: 'open', status: 'all', repo: 'all', search: '', days: 7 }
const prFilters = atom({ plugin: 'daybook', key: 'prFilters' } as const, DEFAULT_PR_FILTERS, { shape: 'pr-filters-1' })
const scrumAdvancedOpen = atom({ plugin: 'daybook', key: 'scrumAdvancedOpen' } as const, false, { shape: 'scrum-advanced-1' })
// The weekday picked in the Time card; null shows today.
const picked = atom({ plugin: 'daybook', key: 'picked' } as const, null, { shape: 'picked-2' })
const busy = atom({ plugin: 'daybook', key: 'busy' } as const, null, { shape: 'busy-1' })
const lastRun = atom({ plugin: 'daybook', key: 'lastRun' } as const, {}, { shape: 'last-run-1' })
const filters = atom({ plugin: 'daybook', key: 'filters' } as const, DEFAULT_FILTERS, { shape: 'filters-2' })
// When Refresh last started the daybook-gather agent (ISO), so Teams and Outlook read "checking…"
// until the agent's write lands, and a second press within AGENT_GAP_MS starts no second agent.
const checking = atom({ plugin: 'daybook', key: 'checking' } as const, null, { shape: 'checking-1' })
// Which cards are folded, by card id. Kept in $.store too, so it survives a new session.
const folded = atom({ plugin: 'daybook', key: 'folded' } as const, {}, { shape: 'folded-1' })
// The doctor's last report: is every tool connected, and the exact fix where not.
const doctor = atom({ plugin: 'daybook', key: 'doctor' } as const, null, { shape: 'doctor-1' })
const CARD_IDS = ['needs', 'scrum', 'time', 'questions', 'answered', 'prs', 'tickets', 'board', 'settings'] as const
// Folded until the user opens them: reference cards, not things to act on.
const FOLDED_AT_FIRST: string[] = ['answered', 'hidden']
async function setFolded($: EngineInterface, next: Record<string, boolean>) {
  await update($, folded, () => next)
  await $.store.set('folded', next)
}
const AGENT_GAP_MS = 5 * 60 * 1000
const AGENT_SOURCES = ['Teams', 'Outlook']

type Config = {
  ledger_dir: string; day_min_minutes: number; day_max_minutes: number; me?: string
  reviewer?: string
  call_me?: string
  config_path?: string
  jira_site?: string; questions_file?: string; gather_command?: string
  providers?: Providers
  ui?: { accent?: string }
  // name → email, for the chat's compose link (Teams opens a chat with the question typed in)
  people?: Record<string, string>
  // The action bar and the timed runs: commands (usually skills) the person has. Empty by default.
  actions?: {
    primary?: ActionConfig
    buttons?: ActionConfig[]
    // the command the "time short" need offers, e.g. /timesheet
    time_short?: string
  }
  // e.g. [{ "at": "09:00", "commands": ["/scrum"] }]: each runs once a working day, within 30 minutes
  schedule?: { at: string; commands: string[] }[]
  // what Refresh runs after the shell gather, for chat and mail (a skill that starts the gather agent)
  refresh_command?: string
}
// hint: text under the button; {reviewer} and {next_ticket} are filled in, and a next ticket becomes a link
type ActionConfig = { key?: string; label: string; command: string; hint?: string }
type BoardTicket = {
  key: string; summary: string; status: string; area?: string; assignee: string | null
  due_date: string | null
}
type QuestionEntry = {
  id?: string; topic: string; text?: string; tickets?: string[]; to?: string; status: string
  asked_at?: string; answer?: string | null; answered_by?: string | null; answered_at?: string | null
  url?: string | null
  // set from the panel; the merge script never changes it
  override?: { status: 'answered' | 'not_question'; at?: string }
}
type QuestionsFile = { questions: QuestionEntry[] }
type Comment = { by: string; at: string }
type Pr = {
  number: number; url: string; state: string; mergedAt: string | null; reviewDecision: string
  tickets: string[]; comments: Comment[]; inline_comments: Comment[]
  reviews: { by: string; state: string; at: string }[]
}
// Which tool fills each category. Phase 1 reads these for links, labels and the Settings card;
// the collectors still use the older top-level keys until they move behind the adapter layer.
type Provider = {
  type: string; via?: 'cli' | 'api' | 'connector'; site?: string; url_template?: string; project?: string
  search_url_template?: string; compose_url?: string
}
type Providers = Partial<Record<ProviderCategory, Provider>>
type ProviderCategory = 'code' | 'tickets' | 'chat' | 'mail' | 'time' | 'docs'

type Ticket = {
  key: string; summary: string; status: string; start_date: string | null; due_date: string | null
  worklogs_today: { seconds: number }[]
}
type Ask = { from: string; text: string; url?: string }
type Ledger = {
  day: string; gathered_at: string
  sources: Record<string, { ok: boolean; at?: string }>
  github?: {
    login?: string; prs?: Pr[]
    tracker?: {
      repo: string; label: string; number: number; title: string; url: string; tickets: string[]
      status: TrackerStatus; note: string; base: string; created_at?: string | null; merged_at?: string | null
    }[]
    tracker_error?: string
  }
  jira?: {
    tickets?: Ticket[]; board?: BoardTicket[]; logged_today_minutes?: number
    // open tickets assigned to me, plus the tickets the last week's scrum plans name
    mine?: JiraLite[]
    // ticket keys in your board's rank and in your custom search's order; failed queries
    orders?: Record<string, string[]>
    order_errors?: Record<string, string>
    week_minutes?: Record<string, number>
  }
  teams?: { questions?: QuestionEntry[]; asks_for_me?: Ask[] }
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = () => isoDay(new Date())
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const localTime = (iso: string) => (iso ? hhmm(new Date(iso)) : '')
const fmt = (m: number) => {
  const h = Math.floor(m / 60)
  const r = m % 60
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`
}
const shortDate = (day: string | null) =>
  day ? new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'
const longDate = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const num = (key: string) => Number(key.split('-')[1] ?? key.replace(/^\D+/, ''))
// A ticket's short label: the number alone when the key is PROJECT-123 or #123.
const shortKey = (key: string) => (/^[A-Z][A-Z0-9]*-\d+$/.test(key) || /^#\d+$/.test(key) ? key.replace(/^\D+/, '') : key)
const keyRange = (keys: string[]) => {
  const s = [...keys].sort((a, b) => num(a) - num(b)).map(k => String(num(k)))
  return s.length > 2 ? `${s[0]}…${s[s.length - 1]}` : s.join(', ')
}
const greeting = (name: string) => {
  const h = new Date().getHours()
  const first = name.split(' ')[0] || 'there'
  return `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${first}`
}

const ago = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime()
  if (!iso || Number.isNaN(ms)) return ''
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`
}
const stale = (iso: string) => !iso || Date.now() - new Date(iso).getTime() > STALE_MS
const words = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean))
const samePerson = (a: string, b: string) => {
  const x = words(a)
  const y = words(b)
  return x.size > 0 && x.size === y.size && [...x].every(w => y.has(w))
}
const dateTime = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso.replace(/x/gi, '0'))
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10)
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm(d)}`
}
const AREAS: Area[] = ['backend', 'frontend', 'devops']
const areaLabel = (a: Area) => (a === 'devops' ? 'DevOps' : a.charAt(0).toUpperCase() + a.slice(1))

function toQuestion(q: QuestionEntry, cfg: Config): QuestionRow {
  const manual = q.override?.status === 'answered'
  const status: QuestionStatus = q.override?.status === 'not_question' ? 'hidden'
    : q.status === 'answered' || manual ? 'answered' : q.status === 'to_send' ? 'to_send' : 'waiting'
  if (manual && q.status !== 'answered') {
    q = { ...q, answer: q.answer || 'Marked answered in the panel', answered_at: q.answered_at || q.override?.at || '' }
  }
  return {
    id: q.id ?? `${q.asked_at ?? ''}|${q.topic}`,
    topic: q.topic, text: q.text ?? '', tickets: q.tickets ?? [], to: q.to ?? '', status,
    askedAt: q.asked_at ?? '', answer: q.answer ?? '', answeredBy: q.answered_by ?? '',
    answeredAt: q.answered_at ?? '', url: q.url ?? '',
    ticketLinks: (q.tickets ?? []).map(k => ({ key: k, url: ticketUrl(cfg, k) })),
    composeUrl: q.status === 'to_send' ? composeUrl(cfg, q.to ?? '', q.text || q.topic) : '',
    manual: !!q.override,
  }
}

// A day's worklogs per ticket, largest first.
function ticketTimes(tickets: Ticket[], cfg: Config): TicketTime[] {
  return tickets
    .map(t => ({ id: t.key, key: shortKey(t.key), url: ticketUrl(cfg, t.key), title: t.summary, minutes: Math.round(t.worklogs_today.reduce((s, w) => s + w.seconds, 0) / 60) }))
    .filter(t => t.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || Number(a.key) - Number(b.key))
}

// The Settings card's rows: each category's tool, and whether the last gather reached it.
const CATEGORY_SOURCES: Record<ProviderCategory, string[]> = {
  code: ['github', 'gitlab', 'bitbucket', 'code'], tickets: ['jira', 'linear', 'tickets'],
  chat: ['teams', 'slack', 'chat'], mail: ['outlook', 'gmail', 'mail'], time: ['jira', 'time'], docs: ['docs'],
}
const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', jira: 'Jira', linear: 'Linear',
  github_issues: 'GitHub Issues', gitlab_issues: 'GitLab Issues', teams: 'Microsoft Teams', slack: 'Slack',
  outlook: 'Outlook', gmail: 'Gmail', jira_worklogs: 'Jira worklogs', tempo: 'Tempo', toggl: 'Toggl',
  harvest: 'Harvest', claude_docs: 'Claude Docs', markdown: 'Markdown file', none: 'Not used',
}
function providerRows(cfg: Config, l: Ledger): ProviderRow[] {
  const order: ProviderCategory[] = ['code', 'tickets', 'chat', 'mail', 'time', 'docs']
  return order.map(category => {
    const p = cfg.providers?.[category]
    const type = p?.type ?? 'none'
    const sourceKey = [type.replace(/_.*/, ''), ...CATEGORY_SOURCES[category]].find(k => l.sources[k])
    const src = sourceKey ? l.sources[sourceKey] : undefined
    return {
      category, tool: PROVIDER_NAMES[type] ?? type, via: p?.via ?? '',
      state: type === 'none' ? 'off' : !src ? 'unknown' : src.ok ? 'ok' : 'failing',
      at: src?.at ?? '',
    }
  })
}

const CATEGORY_LABELS: Record<string, string> = {
  code: 'Code', tickets: 'Tickets', chat: 'Chat', mail: 'Mail', time: 'Time', docs: 'Scrum log',
}

const weekdayLabel = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

function toView(l: Ledger, cfg: Config, questionsFile: QuestionsFile | null = null, scrumFile: ScrumFile = { days: {} }): View {
  const me = l.github?.login ?? ''
  const prs = l.github?.prs ?? []
  const tickets = l.jira?.tickets ?? []
  const logged = l.jira?.logged_today_minutes ?? 0
  const needs: Need[] = []
  const prRows: PrRow[] = []

  for (const pr of prs) {
    const all = [...pr.comments, ...pr.inline_comments]
    const lastMine = all.filter(c => c.by === me).map(c => c.at).sort().pop() ?? ''
    const fresh = all.filter(c => c.by !== me && c.at > lastMine)
    const changes = pr.reviews.some(r => r.state === 'CHANGES_REQUESTED' && r.at > lastMine)
    const isOpen = pr.state === 'OPEN'
    if (isOpen && (fresh.length || changes)) {
      const who = [...new Set(fresh.map(c => c.by.split('_')[0]))].join(', ')
      needs.push({
        text: fresh.length
          ? `#${pr.number} · ${fresh.length} new comment${fresh.length > 1 ? 's' : ''}${who ? ` from ${who}` : ''}`
          : `#${pr.number} · changes requested`,
        url: pr.url, linkLabel: 'Open',
      })
    }
    if (!isOpen && !(pr.mergedAt ?? '').startsWith(l.day)) continue
    const merged = pr.state === 'MERGED'
    prRows.push({
      pr: `#${pr.number}`,
      tickets: keyRange(pr.tickets),
      ticketsUrl: ticketsUrl(cfg, pr.tickets),
      review: fresh.length ? `${fresh.length} comment${fresh.length > 1 ? 's' : ''}`
        : pr.reviewDecision === 'APPROVED' ? 'approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'awaiting',
      state: merged ? `merged ${localTime(pr.mergedAt ?? '')}` : 'open',
      tone: merged ? 'done' : fresh.length || changes ? 'attn' : 'open',
      url: pr.url,
    })
  }
  for (const a of l.teams?.asks_for_me ?? []) {
    needs.push({ text: `${a.from.split(' ')[0]} · ${a.text}`, url: a.url, linkLabel: 'Reply' })
  }
  if (l.sources.jira?.ok && l.day === today() && logged < cfg.day_min_minutes) {
    needs.push({ text: `Time · ${fmt(cfg.day_min_minutes - logged)} short of today's range`,
      action: cfg.actions?.time_short ? 'timesheet' : undefined })
  }

  // The questions file is the list; the day file's questions are the fallback before it exists.
  const questions = (questionsFile?.questions ?? l.teams?.questions ?? []).map(q => toQuestion(q, cfg))

  const board: BoardRow[] = (l.jira?.board ?? []).map(t => ({
    key: t.key,
    title: t.summary,
    status: t.status,
    area: (AREAS as string[]).includes(t.area ?? '') ? (t.area as Area) : 'backend',
    assignee: t.assignee ?? '',
    mine: !!t.assignee && samePerson(t.assignee, cfg.me ?? ''),
    due: shortDate(t.due_date),
    url: ticketUrl(cfg, t.key),
  })).sort((a, b) => num(a.key) - num(b.key))

  const minutesOf = (t: Ticket) => Math.round(t.worklogs_today.reduce((s, w) => s + w.seconds, 0) / 60)
  const order = (s: string) => (s === 'In Development' ? 0 : s === 'In Review' ? 1 : 2)
  const toneOf = (s: string): TicketRow['tone'] =>
    s === 'In Development' ? 'dev' : s === 'In Review' ? 'review' : s === 'Waiting QA' ? 'qa' : 'other'
  const ticketRows: TicketRow[] = tickets
    .filter(t => ['In Development', 'In Review'].includes(t.status) || minutesOf(t) > 0)
    .sort((a, b) => order(a.status) - order(b.status) || minutesOf(b) - minutesOf(a) || num(a.key) - num(b.key))
    .map(t => ({
      key: String(num(t.key)),
      title: t.summary,
      status: t.status === 'In Development' ? 'Dev' : t.status === 'In Review' ? 'Review' : t.status === 'Waiting QA' ? 'QA' : t.status,
      tone: toneOf(t.status),
      start: shortDate(t.start_date),
      due: shortDate(t.due_date),
      today: minutesOf(t) ? fmt(minutesOf(t)) : '—',
      url: ticketUrl(cfg, t.key),
    }))

  const weekMap = l.jira?.week_minutes ?? {}
  const week: WeekDay[] = Object.keys(weekMap).sort().map(d => ({
    day: d,
    label: new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' }),
    minutes: weekMap[d] ?? 0,
    isToday: d === l.day,
  }))
  const next = tickets.filter(t => t.status === 'Backlog').sort((a, b) => num(a.key) - num(b.key))[0]
  const toButton = (a: ActionConfig, i: number): ActionButton => {
    const hint = (a.hint ?? '')
      .replace('{reviewer}', (cfg.reviewer ?? '').split(' ')[0] || 'your reviewer')
      .replace('{next_ticket}', next ? next.key : 'pick one')
    return {
      key: a.key ?? `action-${i}`, label: a.label, command: a.command, hint,
      hintUrl: a.hint?.includes('{next_ticket}') && next ? ticketUrl(cfg, next.key) : '',
    }
  }

  return {
    day: l.day,
    greeting: greeting(cfg.call_me ?? cfg.me ?? ''),
    dayLabel: longDate(l.day),
    updated: localTime(l.gathered_at),
    updatedIso: l.gathered_at,
    sources: ['github', 'jira', 'teams', 'outlook'].map(n => ({
      name: n === 'github' ? 'GitHub' : n.charAt(0).toUpperCase() + n.slice(1),
      ok: !!l.sources[n]?.ok,
      at: l.sources[n]?.at ?? '',
    })),
    needs,
    loggedMinutes: logged,
    minMinutes: cfg.day_min_minutes,
    maxMinutes: cfg.day_max_minutes,
    perTicket: ticketTimes(tickets, cfg),
    week,
    tickets: ticketRows,
    prs: prRows,
    board,
    questions,
    nextTicket: next ? next.key : '',
    nextTicketUrl: next ? ticketUrl(cfg, next.key) : '',
    primary: cfg.actions?.primary ? toButton({ key: 'primary', ...cfg.actions.primary }, 0) : null,
    buttons: (cfg.actions?.buttons ?? []).map(toButton),
    timeCommand: cfg.actions?.time_short ?? '',
    chatName: CHAT_NAMES[cfg.providers?.chat?.type ?? 'teams'] ?? 'chat',
    reviewer: cfg.reviewer ?? '',
    configPath: cfg.config_path ?? '',
    providers: providerRows(cfg, l),
    scrum: scrumView(scrumInput(l, cfg, questions, scrumFile), mineOf(l, cfg.me ?? '')),
    tracker: l.github?.tracker ? l.github.tracker.map((r): TrackerRow => ({
      repo: r.repo, label: r.label, number: r.number, title: r.title, url: r.url,
      tickets: r.tickets.map(k => ({ key: k, url: ticketUrl(cfg, k) })),
      status: r.status, note: r.note, base: r.base, at: (r.status === 'merged' ? r.merged_at : r.created_at) ?? '',
    })) : null,
    trackerError: l.github?.tracker_error ?? '',
  }
}

// ── The PR tracker ────────────────────────────────────────────────────────────────────────────
const PR_STATUS: Record<TrackerStatus, { label: string; color: 'warning' | 'suggestion' | 'success' | 'inactive' }> = {
  needs_fixes: { label: 'Needs fixes', color: 'warning' },
  blocked: { label: 'Blocked', color: 'warning' },
  back_for_review: { label: 'Back for review', color: 'suggestion' },
  in_review: { label: 'In review', color: 'inactive' },
  approved: { label: 'Approved', color: 'success' },
  draft: { label: 'Draft', color: 'inactive' },
  merged: { label: 'Merged', color: 'success' },
}
const PR_ORDER = Object.keys(PR_STATUS) as TrackerStatus[]

// What the filters let through: the merged window always applies to merged ones.
function filterTracker(rows: TrackerRow[], f: PrFilters, now = Date.now()): TrackerRow[] {
  const q = f.search.trim().toLowerCase()
  const since = now - f.days * 86_400_000
  return rows.filter(r =>
    (r.status !== 'merged' || (Date.parse(r.at) || 0) >= since) &&
    (f.show === 'all' || (f.show === 'merged') === (r.status === 'merged')) &&
    (f.status === 'all' || r.status === f.status) &&
    (f.repo === 'all' || r.label === f.repo) &&
    (!q || `${r.label} #${r.number} ${r.title} ${r.tickets.map(t => t.key).join(' ')}`.toLowerCase().includes(q)))
}

function trackerCounts(rows: TrackerRow[], days: number, now = Date.now()) {
  const since = now - days * 86_400_000
  return {
    open: rows.filter(r => r.status !== 'merged').length,
    fixes: rows.filter(r => r.status === 'needs_fixes').length,
    merged: rows.filter(r => r.status === 'merged' && (Date.parse(r.at) || 0) >= since).length,
  }
}

// The counts and one line per pull request, for a status update or a message.
function trackerText(rows: TrackerRow[], days: number): string {
  const c = trackerCounts(rows, days)
  const lines = [`PRs: ${c.open} open, ${c.fixes} need fixes, ${c.merged} merged in the last ${days} days`]
  for (const st of PR_ORDER) {
    const group = filterTracker(rows, { ...DEFAULT_PR_FILTERS, show: 'all', days: days as PrFilters['days'], status: st })
    if (!group.length) continue
    lines.push('', `${PR_STATUS[st].label} (${group.length})`)
    for (const r of group) {
      lines.push(`- ${r.label} #${r.number} ${r.tickets.map(t => t.key).join(', ') || r.title}${r.note ? `: ${r.note}` : ''}`)
    }
  }
  return lines.join('\n')
}

// Tickets for the Scrum card: the collector's open-and-planned list, else (an older day file) the
// day's tickets and my board rows.
function mineOf(l: Ledger, me: string): JiraLite[] {
  if (l.jira?.mine) return l.jira.mine
  const seen = new Map<string, JiraLite>()
  for (const t of [...(l.jira?.tickets ?? []), ...(l.jira?.board ?? []).filter(b => !!b.assignee && samePerson(b.assignee, me))]) {
    if (!seen.has(t.key)) seen.set(t.key, { key: t.key, summary: t.summary, status: t.status })
  }
  return [...seen.values()]
}

function scrumInput(l: Ledger, cfg: Config, questions: QuestionRow[], file: ScrumFile) {
  const known = [...mineOf(l, cfg.me ?? ''), ...(l.jira?.board ?? []), ...(l.jira?.tickets ?? [])]
  return {
    day: l.day, gatheredAt: l.gathered_at, file, known, questions,
    orders: l.jira?.orders ?? {}, orderErrors: l.jira?.order_errors ?? {},
    prs: (l.github?.prs ?? []).map(p => ({ tickets: p.tickets, state: p.state })),
    url: (key: string) => ticketUrl(cfg, key),
  }
}

// Yesterday's marks: drawn glyphs in the panel's own colours, not emoji.
const DOT: Record<string, string> = { delivered: '✓', doing: '◐', todo: '○', other: '!' }
const DOT_COLOR: Record<string, 'success' | 'suggestion' | 'inactive' | 'warning'> = {
  delivered: 'success', doing: 'suggestion', todo: 'inactive', other: 'warning',
}
const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const SHORT_STATUS: Record<string, string> = { 'In Development': 'Dev', 'In Review': 'Review', 'Waiting QA': 'QA', 'Ready for Development': 'Ready' }
const shortMove = (then: string, now: string) => {
  const s = (x: string) => SHORT_STATUS[x] ?? x
  return then && then !== now ? `${s(then)} → ${s(now)}` : s(now)
}

const EMPTY_SCRUM = (day: string): ScrumView => ({
  day, saved: false, lockedAt: '', yesterday: null, today: [], addable: [], blockers: [], text: '',
  settings: DEFAULT_SETTINGS, queue: [], orderError: '',
})

// The day's ring: the logged arc, and the 8h 15m–9h band as a lighter arc. Scale: 104% of the max.
// Drawn interactive, so the band fades in and the logged arc sweeps round from zero.
function ring(logged: number, min: number, max: number): string {
  const r = 34
  const c = 2 * Math.PI * r
  const scale = max * 1.04
  const at = (m: number) => (Math.min(m, scale) / scale) * c
  const bandStart = at(min)
  const bandLen = at(max) - bandStart
  const done = Math.max(at(logged), 0.01)
  const arc = (len: number, offset: number, color: string, opacity: number, cap: string, anim: string) =>
    `<circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="9" ` +
    `stroke-linecap="${cap}" stroke-dasharray="${len.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" ` +
    `transform="rotate(-90 42 42)">${anim}</circle>`
  const sweep = `<animate attributeName="stroke-dasharray" from="0.01 ${c.toFixed(1)}" to="${done.toFixed(1)} ${c.toFixed(1)}" ` +
    `dur="0.9s" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1" fill="freeze"/>`
  const fade = `<animate attributeName="stroke-opacity" from="0" to="0.3" dur="0.6s" fill="freeze"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84">` +
    `<title>${fmt(logged)} of ${fmt(min)} – ${fmt(max)}</title>` +
    arc(c, 0, '#8a8f98', 0.2, 'butt', '') + arc(bandLen, bandStart, TEAL, 0.3, 'butt', fade) +
    arc(done, 0, TEAL, 1, 'round', sweep) + `</svg>`
}

// Mon–Fri bars against the day band. Each bar grows up in turn; the picked day is full colour with
// one pulse, the others lighter; hovering a bar shows its time.
function weekStrip(v: View, selected: string): string {
  const W = 300
  const H = 44
  const LH = 16
  const TOP = 14
  const slot = W / 5
  const bw = 30
  const y = (m: number) => H - (Math.min(m, v.maxMinutes * 1.1) / (v.maxMinutes * 1.1)) * (H - 4)
  const band = `<rect x="0" y="${y(v.maxMinutes).toFixed(1)}" width="${W}" height="${(y(v.minMinutes) - y(v.maxMinutes)).toFixed(1)}" fill="${TEAL}" fill-opacity="0.14"/>`
  const bars = v.week.map((d, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(1)
    const tip = `<title>${d.label} · ${d.minutes ? fmt(d.minutes) : 'nothing logged'}</title>`
    if (!d.minutes) return `<rect x="${x}" y="${H - 3}" width="${bw}" height="3" rx="1.5" fill="#8a8f98" fill-opacity="0.35">${tip}</rect>`
    const top = y(d.minutes)
    const on = d.day === selected
    const begin = `${(i * 0.08).toFixed(2)}s`
    const grow = `<animate attributeName="y" from="${H}" to="${top.toFixed(1)}" begin="${begin}" dur="0.55s" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1" fill="freeze"/>` +
      `<animate attributeName="height" from="0" to="${(H - top).toFixed(1)}" begin="${begin}" dur="0.55s" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1" fill="freeze"/>`
    const pulse = on ? `<animate attributeName="fill-opacity" values="1;0.55;1" begin="0.7s" dur="0.8s"/>` : ''
    const cx = (i * slot + slot / 2).toFixed(1)
    const time = `<text x="${cx}" y="${(top - 4).toFixed(1)}" text-anchor="middle" font-size="10" font-family="system-ui, sans-serif" ` +
      `fill="#8a8f98" fill-opacity="${on ? 1 : 0.8}" font-weight="${on ? 600 : 400}" opacity="0">${fmt(d.minutes)}` +
      `<animate attributeName="opacity" from="0" to="1" begin="${(i * 0.08 + 0.45).toFixed(2)}s" dur="0.35s" fill="freeze"/></text>`
    return `<rect x="${x}" y="${H}" width="${bw}" height="0" rx="4" fill="${TEAL}" fill-opacity="${on ? 1 : 0.45}">${tip}${grow}${pulse}</rect>${time}`
  }).join('')
  const labels = v.week.map((d, i) => {
    const x = (i * slot + slot / 2).toFixed(1)
    const look = d.day === selected ? 'fill="#8a8f98" fill-opacity="1" font-weight="600"' : 'fill="#8a8f98" fill-opacity="0.8"'
    return `<text x="${x}" y="${H + LH - 3}" text-anchor="middle" font-size="11" font-family="system-ui, sans-serif" ${look}>${d.label}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOP + H + LH}" viewBox="0 0 ${W} ${TOP + H + LH}">` +
    `<g transform="translate(0 ${TOP})">${band}${bars}${labels}</g></svg>`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One ticket's bar, sized to its share of the day's largest, sliding in after the rows above it; its
// time fades in at the end. The ticket number beside it is a Link, since a drawing can't be clicked.
const ROW_H = 20
// One ticket's bar. It scales to the room left in its row (no fixed width), so it never pushes the
// row past the card; the time is drawn beside it as text, so it is never the part that gets cut.
const BAR_VB = 200
function ticketBar(r: TicketTime, i: number, most: number): string {
  const w = Math.max((r.minutes / Math.max(most, 1)) * BAR_VB, 3)
  const begin = `${(0.1 + i * 0.06).toFixed(2)}s`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_VB} ${ROW_H}" preserveAspectRatio="none">` +
    `<title>${esc(r.id)} · ${esc(r.title)} · ${fmt(r.minutes)}</title>` +
    `<rect x="0" y="5" width="${BAR_VB}" height="10" rx="5" fill="#8a8f98" fill-opacity="0.12"/>` +
    `<rect x="0" y="5" width="0" height="10" rx="5" fill="${TEAL}" fill-opacity="${i === 0 ? 1 : 0.75}">` +
    `<animate attributeName="width" from="0" to="${w.toFixed(1)}" begin="${begin}" dur="0.6s" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1" fill="freeze"/></rect></svg>`
}

const questionsPath = (cfg: Config) => cfg.questions_file ?? `${cfg.ledger_dir}/questions.json`

async function readQuestions($: EngineInterface, cfg: Config): Promise<QuestionsFile | null> {
  try {
    const parsed = JSON.parse(await $.fs.read(questionsPath(cfg))) as Partial<QuestionsFile>
    return Array.isArray(parsed.questions) ? { ...parsed, questions: parsed.questions } : null
  } catch {
    return null
  }
}

async function load($: EngineInterface, day = today()) {
  try {
    const cfg = await readConfig($)
    const ledger = demo ? demoLedger(day) as Ledger : JSON.parse(await $.fs.read(`${cfg.ledger_dir}/${day}.json`)) as Ledger
    if (demo && !demoQs) demoQs = demoQuestions(day) as QuestionsFile
    const questions = demo ? demoQs : await readQuestions($, cfg)
    if (demo && !demoPlan) demoPlan = demoScrum(day) as ScrumFile
    const plan = demo ? demoPlan ?? { days: {} } : await readScrum($, cfg)
    await update($, view, () => toView(ledger, cfg, questions, plan))
  } catch {
    await update($, view, old => old ?? {
      day, greeting: greeting(''), dayLabel: longDate(day), updated: '—', updatedIso: '', sources: [],
      needs: [], loggedMinutes: 0, minMinutes: 495, maxMinutes: 540, perTicket: [], week: [],
      tickets: [], prs: [], board: [], questions: [], nextTicket: '', nextTicketUrl: '', primary: null, buttons: [], timeCommand: '', chatName: 'chat', reviewer: '', configPath: '', providers: [], scrum: EMPTY_SCRUM(day), tracker: null, trackerError: '', error: 'No day file yet. Press Refresh.',
    })
  }
}

// A weekday picked in the Time card: that day's file, read as it is. Today goes back to the live view.
async function pickDay($: EngineInterface, day: string) {
  if (day === today()) {
    await update($, picked, () => null)
    return
  }
  const label = weekdayLabel(day)
  try {
    const cfg = await readConfig($)
    const l = demo ? demoLedger(day) as Ledger : JSON.parse(await $.fs.read(`${cfg.ledger_dir}/${day}.json`)) as Ledger
    const tickets = l.jira?.tickets ?? []
    await update($, picked, (): DayTime => ({
      day, label, logged: l.jira?.logged_today_minutes ?? 0, perTicket: ticketTimes(tickets, cfg), missing: false,
    }))
  } catch {
    await update($, picked, (): DayTime => ({ day, label, logged: 0, perTicket: [], missing: true }))
  }
}

// "Mark sent": the one write the panel makes. It reads the file fresh, so an agent's change since
// the last draw is kept, and only moves that one question from to_send to waiting.
async function markSent($: EngineInterface, id: string) {
  await editQuestion($, id, q => {
    if (q.status !== 'to_send') return false
    q.status = 'waiting'
    q.asked_at = new Date().toISOString()
    return true
  }, 'Marked as sent: it now waits for an answer.')
}

// "Mark answered" / "Not a question": an override the merge script keeps, for what the rules missed.
async function setOverride($: EngineInterface, id: string, status: 'answered' | 'not_question') {
  await editQuestion($, id, q => {
    q.override = { status, at: new Date().toISOString() }
    return true
  }, status === 'answered' ? 'Marked answered.' : 'Hidden: not a question.')
}

// Undo / Restore: drop the override, so the question is back to what the rules say.
async function clearOverride($: EngineInterface, id: string) {
  await editQuestion($, id, q => {
    if (!q.override) return false
    delete q.override
    return true
  }, 'Restored.')
}

// The panel's only writes, each to one question: read the file fresh, so an agent's change since
// the last draw is kept, change that one entry, write it back.
async function editQuestion($: EngineInterface, id: string, change: (q: QuestionEntry) => boolean, done: string) {
  if (demo) {  // demo: change the in-memory list only
    const q = demoQs?.questions.find(x => x.id === id)
    if (q && change(q)) {
      $.ui.toast(`${done} (demo: nothing saved)`)
      await load($)
    }
    return
  }
  try {
    const cfg = await readConfig($)
    const raw = JSON.parse(await $.fs.read(questionsPath(cfg))) as QuestionsFile
    const q = raw.questions.find(x => (x.id ?? `${x.asked_at ?? ''}|${x.topic}`) === id)
    if (!q || !change(q)) return
    await $.fs.write(questionsPath(cfg), `${JSON.stringify(raw, null, 2)}\n`)
    $.ui.toast(done)
    await load($)
  } catch (err) {
    $.ui.toast(`Could not change the question: ${String(err).slice(0, 100)}`)
  }
}

// ── The Scrum card ─────────────────────────────────────────────────────────────────────────────
const scrumPath = (cfg: Config) => `${cfg.ledger_dir}/scrum.json`

async function readScrum($: EngineInterface, cfg: Config): Promise<ScrumFile> {
  try {
    const parsed = JSON.parse(await $.fs.read(scrumPath(cfg))) as Partial<ScrumFile>
    return {
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      ...(parsed.settings ? { settings: parsed.settings } : {}),
      ...(Array.isArray(parsed.queue) ? { queue: parsed.queue } : {}),
    }
  } catch {
    return { days: {} }
  }
}

// Every change to the plan: read the file fresh, start today's entry from the suggestion the card
// shows when there is none yet, change it, write it back. Demo mode changes the in-memory plan only.
async function editScrum($: EngineInterface, change: (day: ScrumDay, all: ScrumFile) => boolean, done: string) {
  const v = await read($, view)
  if (!v) return
  try {
    const cfg = await readConfig($)
    const file = demo ? demoPlan ?? { days: {} } : await readScrum($, cfg)
    const day = file.days[v.day] ?? {
      locked_at: null,
      items: v.scrum.today.map((r): ScrumItem => ({ key: r.key, summary: r.title, status_at_lock: r.status,
        ...(r.pickedBy ? { picked_by: r.pickedBy as ScrumItem['picked_by'] } : {}),
        ...(r.carried && v.scrum.yesterday ? { carried_from: v.scrum.yesterday.day } : {}) })),
    }
    if (!change(day, file)) return
    file.days[v.day] = day
    if (demo) demoPlan = file
    else await $.fs.write(scrumPath(cfg), `${JSON.stringify(file, null, 2)}\n`)
    if (done) $.ui.toast(demo ? `${done} (demo: nothing saved)` : done)
    await load($)
  } catch (err) {
    $.ui.toast(`Could not save the scrum plan: ${String(err).slice(0, 100)}`)
  }
}

const statusNow = (v: View, key: string) => v.scrum.today.find(r => r.key === key)?.status
  ?? v.scrum.addable.find(r => r.key === key)?.status ?? ''

// The settings and Next up: the whole plan file, read fresh, changed, written back. Today's
// suggestion follows at once; a saved (locked or edited) day keeps its list.
async function editPlan($: EngineInterface, change: (file: ScrumFile) => boolean, done = '') {
  try {
    const cfg = await readConfig($)
    const file = demo ? demoPlan ?? { days: {} } : await readScrum($, cfg)
    if (!change(file)) return
    if (demo) demoPlan = file
    else await $.fs.write(scrumPath(cfg), `${JSON.stringify(file, null, 2)}\n`)
    if (done) $.ui.toast(demo ? `${done} (demo: nothing saved)` : done)
    await load($)
  } catch (err) {
    $.ui.toast(`Could not save: ${String(err).slice(0, 100)}`)
  }
}

const editSettings = ($: EngineInterface, change: (s: PickSettings) => PickSettings, done = '') =>
  editPlan($, file => { file.settings = change(settingsOf(file)); return true }, done)

const scrumPreset = ($: EngineInterface, id: PresetId) =>
  editSettings($, s => ({ ...s, preset: id, rules: PRESETS[id].rules.map(r => ({ ...r })) }), `Picking: ${PRESETS[id].label}.`)
const scrumToggleRule = ($: EngineInterface, id: RuleId) =>
  editSettings($, s => ({ ...s, preset: 'custom', rules: s.rules.map(r => (r.id === id ? { ...r, on: !r.on } : r)) }))
async function scrumMoveRule($: EngineInterface, id: RuleId, dir: -1 | 1) {
  await editSettings($, s => {
    const rules = [...s.rules]
    const i = rules.findIndex(r => r.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= rules.length) return s
    const [a, b] = [rules[i], rules[j]]
    if (!a || !b) return s
    rules[i] = b
    rules[j] = a
    return { ...s, preset: 'custom', rules }
  })
}
const scrumNumber = ($: EngineInterface, field: 'due_days' | 'new_per_day', delta: number) =>
  editSettings($, s => ({ ...s, [field]: Math.max(field === 'due_days' ? 0 : 0, Math.min(field === 'due_days' ? 30 : 10, s[field] + delta)) }))
const scrumCustomJql = ($: EngineInterface, jql: string) =>
  editSettings($, s => ({ ...s, custom_jql: jql.trim() }), jql.trim() ? 'Custom search saved: it is read at the next Refresh.' : 'Custom search cleared.')

// "885 934, PROJ-576" → PROJ-885, PROJ-934, PROJ-576: a bare number takes your tickets' project.
function parseKeys(text: string, v: View): string[] {
  const projects = [...v.scrum.today, ...v.scrum.addable].map(r => r.key.split('-')[0] ?? '')
  const project = projects.sort((a, b) => projects.filter(p => p === b).length - projects.filter(p => p === a).length)[0] ?? ''
  const keys = text.toUpperCase().split(/[\s,;]+/).filter(Boolean)
    .map(k => (/^\d+$/.test(k) && project ? `${project}-${k}` : k)).filter(k => /^[A-Z][A-Z0-9]*-\d+$/.test(k))
  return [...new Set(keys)]
}

async function scrumQueueAdd($: EngineInterface, text: string) {
  const v = await read($, view)
  if (!v) return
  const keys = parseKeys(text, v)
  if (!keys.length) { $.ui.toast('Type ticket keys or numbers, like 885 934.'); return }
  await editPlan($, file => {
    file.queue = [...(file.queue ?? []).filter(k => !keys.includes(k)), ...keys]
    return true
  }, `Next up: ${keys.join(', ')}.`)
}
const scrumQueueRemove = ($: EngineInterface, key: string) =>
  editPlan($, file => { file.queue = (file.queue ?? []).filter(k => k !== key); return true })

// Pick for today: straight onto today's list, whatever the rules say.
async function scrumPick($: EngineInterface, text: string) {
  const v = await read($, view)
  if (!v) return
  const keys = parseKeys(text, v)
  if (!keys.length) { $.ui.toast('Type ticket keys or numbers, like 885 934.'); return }
  const known = (k: string) => v.scrum.addable.find(t => t.key === k)
  await editScrum($, day => {
    let added = 0
    for (const k of keys) {
      if (day.items.some(i => i.key === k)) continue
      day.items.push({ key: k, summary: known(k)?.title ?? '', status_at_lock: known(k)?.status ?? '', picked_by: 'pick' })
      added += 1
    }
    return added > 0
  }, `Added to today: ${keys.join(', ')}.`)
}

async function scrumMoveRow($: EngineInterface, key: string, dir: -1 | 1) {
  await editScrum($, day => {
    const i = day.items.findIndex(t => t.key === key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= day.items.length) return false
    const [a, b] = [day.items[i], day.items[j]]
    if (!a || !b) return false
    day.items[i] = b
    day.items[j] = a
    return true
  }, '')
}

async function scrumAdd($: EngineInterface, key: string) {
  const v = await read($, view)
  const t = v?.scrum.addable.find(r => r.key === key)
  if (!v || !t) return
  await editScrum($, day => {
    if (day.items.some(i => i.key === key)) return false
    day.items.push({ key, summary: t.title, status_at_lock: t.status })
    return true
  }, `${key} added to today.`)
}

async function scrumCarry($: EngineInterface, key: string) {
  const v = await read($, view)
  const y = v?.scrum.yesterday
  const row = y?.rows.find(r => r.key === key)
  if (!v || !y || !row) return
  await editScrum($, day => {
    if (day.items.some(i => i.key === key)) return false
    day.items.push({ key, summary: row.title, status_at_lock: row.now, carried_from: y.day })
    return true
  }, `${key} carried over to today.`)
}

async function scrumRemove($: EngineInterface, key: string) {
  await editScrum($, day => {
    const before = day.items.length
    day.items = day.items.filter(i => i.key !== key)
    return day.items.length !== before
  }, `${key} taken off today.`)
}

// Lock: the list is today's commitment; each ticket's status now is what tomorrow compares with.
async function scrumLock($: EngineInterface) {
  const v = await read($, view)
  if (!v) return
  await editScrum($, day => {
    day.locked_at = new Date().toISOString()
    for (const i of day.items) i.status_at_lock = statusNow(v, i.key) || i.status_at_lock
    return true
  }, "Today's plan is locked.")
}

async function scrumSetReason($: EngineInterface, key: string, text: string) {
  await update($, scrumReason, () => null)
  await editScrum($, day => {
    const item = day.items.find(i => i.key === key)
    if (!item) return false
    if (text.trim()) item.reason = text.trim()
    else delete item.reason
    return true
  }, text.trim() ? `${key}: reason saved.` : `${key}: reason cleared.`)
}

type MoveResult = { key: string; from?: string; to?: string; transition?: { name: string } | null
  fields?: Record<string, [string | null, string]>; wrote: boolean; error: string | null }

async function runMove($: EngineInterface, key: string, move: 'start' | 'done', dryRun: boolean): Promise<MoveResult> {
  const argv = ['/bin/sh', `${$.plugin.root}/scripts/run.sh`, 'scrum', 'move', key, '--to', move, '--day', today()]
  const run = await $.process.run(dryRun ? [...argv, '--dry-run'] : argv, { timeoutMs: 90_000 })
  try {
    return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as MoveResult
  } catch {
    return { key, wrote: false, error: (run.stderr || run.stdout || 'no answer from the move script').slice(0, 200) }
  }
}

const previewOf = (r: MoveResult) => [
  `${r.key}: ${r.from} → ${r.to}${r.transition ? ` (${r.transition.name})` : ''}`,
  ...Object.entries(r.fields ?? {}).map(([name, [old, nu]]) => `${name}: ${old ?? 'empty'} → ${nu}`),
].join(' · ')

// Start or Done, step one: a dry run, shown for Confirm. Nothing is written yet.
async function scrumAsk($: EngineInterface, key: string, move: 'start' | 'done') {
  const v = await read($, view)
  const row = v?.scrum.today.find(r => r.key === key)
  if (!v || !row) return
  const noPr = move === 'done' && !row.hasPr
  if (demo) {
    const to = move === 'start' ? 'In Development' : 'In Review'
    const field = move === 'start' ? 'Start date: empty' : 'Due date: empty'
    await update($, scrumPending, (): ScrumPending => ({ key, move, noPr, error: '',
      preview: `${key}: ${row.status} → ${to} · ${field} → ${today()}` }))
    return
  }
  await update($, scrumBusy, () => key)
  try {
    const r = await runMove($, key, move, true)
    await update($, scrumPending, (): ScrumPending => ({ key, move, noPr, error: r.error ?? '', preview: r.error ? '' : previewOf(r) }))
  } catch (err) {
    await update($, scrumPending, (): ScrumPending => ({ key, move, noPr, error: String(err).slice(0, 160), preview: '' }))
  }
  await update($, scrumBusy, () => null)
}

// Step two, after Confirm: the move itself, recorded in today's plan so the card shows it at once.
async function scrumConfirm($: EngineInterface) {
  const p = await read($, scrumPending)
  if (!p || p.error) return
  await update($, scrumPending, () => null)
  await update($, scrumBusy, () => p.key)
  let r: MoveResult
  if (demo) {
    const v = await read($, view)
    r = { key: p.key, from: v ? statusNow(v, p.key) : '', to: p.move === 'start' ? 'In Development' : 'In Review', wrote: true, error: null }
  } else {
    try {
      r = await runMove($, p.key, p.move, false)
    } catch (err) {
      r = { key: p.key, wrote: false, error: String(err).slice(0, 160) }
    }
  }
  await update($, scrumBusy, () => null)
  if (!r.wrote) {
    $.ui.toast(`${p.key} not moved: ${r.error ?? 'unknown error'}`)
    return
  }
  await editScrum($, day => {
    day.moves = [...(day.moves ?? []), { key: p.key, from: r.from ?? '', to: r.to ?? '', at: new Date().toISOString() }]
    const item = day.items.find(i => i.key === p.key)
    if (item && p.move === 'done') delete item.reason
    return true
  }, `${p.key} is now ${r.to}.`)
}

function filterBoard(rows: BoardRow[], f: Filters): BoardRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter(r =>
    (f.area === 'all' || r.area === f.area) &&
    (f.status === 'all' || r.status === f.status) &&
    (!f.mineOnly || r.mine) &&
    (!q || r.key.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || String(num(r.key)) === q))
}

// Check connections: the doctor script (read-only), its JSON shown in the Settings card.
const DEMO_DOCTOR: Doctor['checks'] = [
  { area: 'code', ok: true, what: 'GitHub signed in as alex-example', fix: '' },
  { area: 'tickets', ok: true, what: 'Jira https://example.atlassian.net signed in as Alex Example', fix: '' },
  { area: 'chat', ok: true, what: "teams: reached by the agent's last run", fix: '' },
  { area: 'mail', ok: false, what: 'outlook: connector not signed in', fix: 'sign the connector in (Settings, Connectors), then press Refresh' },
]
async function runDoctor($: EngineInterface): Promise<Doctor> {
  const at = hhmm(new Date())
  let result: Doctor
  if (demo) {
    result = { at, checks: DEMO_DOCTOR }
  } else {
    try {
      const run = await $.process.run(['/bin/sh', `${$.plugin.root}/scripts/doctor.sh`, '--json'], { timeoutMs: 60_000 })
      result = { at, checks: (JSON.parse(run.stdout) as { checks: Doctor['checks'] }).checks }
    } catch (err) {
      result = { at, checks: [], error: String(err).slice(0, 160) }
    }
  }
  await update($, doctor, () => result)
  return result
}
const doctorText = (d: Doctor) => d.error ? `Doctor could not run: ${d.error}`
  : `${d.checks.map(c => `${c.ok ? '✔' : '✘'} ${c.area}: ${c.what}${c.fix ? `\n    → ${c.fix}` : ''}`).join('\n')}\n\n${
    d.checks.filter(c => c.ok).length} of ${d.checks.length} ok`

async function refresh($: EngineInterface) {
  if (demo) {
    $.ui.toast('Demo mode: nothing to refresh. /daybook live goes back to your own data.')
    return
  }
  await update($, busy, () => 'refreshing…')
  try {
    const cfg = await readConfig($)
    const run = await $.process.run(['/bin/sh', '-c', cfg.gather_command ?? ''], { timeoutMs: 180_000 })
    if (run.exitCode !== 0) $.ui.toast(`Daybook refresh failed: ${run.stderr.slice(0, 120)}`)
  } catch (err) {
    $.ui.toast(`Daybook refresh failed: ${String(err).slice(0, 120)}`)
  }
  await load($)
  await update($, busy, () => null)
  await gatherAgent($)
}

// Teams and Outlook go through the Microsoft 365 connector, which a shell can't reach, so the
// daybook-gather agent fills them. A mod's own $.agent.spawn has no request of the user's behind it,
// so auto mode's check refuses it; the /daybook-refresh skill runs through the chat instead, like
// the other buttons. The minute reload picks up the agent's write.
async function gatherAgent($: EngineInterface) {
  const last = await read($, checking)
  if (last && Date.now() - new Date(last).getTime() < AGENT_GAP_MS) return
  try {
    const cfg = await readConfig($)
    const usesAgent = (cfg.providers?.chat?.type ?? 'none') !== 'none' || (cfg.providers?.mail?.type ?? 'none') !== 'none'
    const command = (cfg.refresh_command ?? (usesAgent ? '/daybook-refresh' : '')).replace(/^\//, '')
    if (!command) return
    await $.command.run({ command })
    await update($, checking, () => new Date().toISOString())
  } catch (err) {
    $.ui.toast(`Teams and Outlook not refreshed: ${String(err).slice(0, 100)}`)
  }
}

// A source the agent fills reads "checking…" while the agent is running and hasn't written yet.
function isChecking(s: { name: string; ok: boolean; at: string }, since: string | null): boolean {
  if (!since || !AGENT_SOURCES.includes(s.name)) return false
  const t = new Date(since).getTime()
  if (Date.now() - t >= AGENT_GAP_MS) return false
  return !s.ok || !s.at || new Date(s.at).getTime() < t
}

// Skills run as slash commands, as if typed (a prompt starting with / is refused). A second press
// of the same button within two minutes is ignored, so one run is never queued twice.
const lastAsked = new Map<string, number>()
function ask($: EngineInterface, text: string) {
  if (demo) {
    $.ui.toast(`Demo mode: ${text} isn't run.`)
    return
  }
  const now = Date.now()
  if (now - (lastAsked.get(text) ?? 0) < 120_000) {
    $.ui.toast(`${text} is already running.`)
    return
  }
  lastAsked.set(text, now)
  $.ui.toast(`Starting ${text}…`)
  void update($, lastRun, runs => ({ ...runs, [text]: hhmm(new Date()) }))
  void $.command.run({ command: text.replace(/^\//, '') }).catch(() => $.ui.toast(`Could not start ${text}`))
}

// The 09:00 and 17:30 drafts fire only inside their half hour, once a working day, so loading the
// panel later in the day (or a reload) never fires them late or twice.
async function scheduled($: EngineInterface) {
  if (demo) return
  const d = new Date()
  if (d.getDay() === 0 || d.getDay() === 6) return
  const hm = d.getHours() * 60 + d.getMinutes()
  const key = today()
  const cfg = await readConfig($)
  const slots: [string, number, string[]][] = (cfg.schedule ?? []).flatMap(s => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.at)
    return m ? [[`at-${s.at}`, Number(m[1]) * 60 + Number(m[2]), s.commands] as [string, number, string[]]] : []
  })
  for (const [name, at, commands] of slots) {
    if (hm < at || hm >= at + 30 || (await $.store.get(name)) === key) continue
    await $.store.set(name, key)
    for (const c of commands) ask($, c)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'daybook', description: 'Open the Daybook panel (/daybook demo for made-up data, /daybook live to go back)' })
    demo = (await $.store.get('demo')) === true
    const saved = await $.store.get('folded')
    if (saved && typeof saved === 'object') await update($, folded, () => saved as Record<string, boolean>)
    void $.ui.open({ id: PANE, title: 'Daybook' })
    await load($)
    $.clock.every(60_000, async () => {
      await load($)
      await scheduled($)
    })
    return next(e)
  })

  on('command.run', { command: 'daybook' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'doctor') return { text: doctorText(await runDoctor($)) }
    if (arg === 'demo' || arg === 'live') await setDemo($, arg === 'demo')
    await $.ui.open({ id: PANE, title: 'Daybook' })
    await load($)
    return {
      text: arg === 'demo' ? 'Daybook demo: a week of made-up data. Nothing is read, saved or run. /daybook live to go back.'
        : arg === 'live' ? 'Daybook is showing your own data again.'
        : `Daybook panel opened${demo ? ' (demo mode: /daybook live to leave)' : ''}.`,
    }
  })

  // Guards: no Claude attribution in commits or PRs; reminders after a PR is raised or merged.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    const writesText = /\bgit\s+commit\b|\bgh\s+pr\s+(create|edit)\b/.test(cmd)
    if (writesText && ATTRIBUTION.test(cmd)) {
      return { deny: 'daybook: no Claude attribution in commits or PRs (Co-Authored-By / Generated with Claude Code).' }
    }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      if (/\bgh\s+pr\s+create\b/.test(cmd)) {
        $.ui.toast('PR raised: move its tickets to In Review and set the due date (/timesheet).')
      } else if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
        $.ui.toast('PR merged: move its tickets to Waiting QA.')
      }
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const Input = 'Input' in els ? els.Input : undefined
    const Select = 'Select' in els ? els.Select : undefined
    const v = await read($, view)
    const working = await read($, busy)
    const since = await read($, checking)
    const doc = await read($, doctor)
    const runs = await read($, lastRun)
    const f = await read($, filters)
    const pick = await read($, picked)
    const fold = await read($, folded)
    const pending = await read($, scrumPending)
    const moving = await read($, scrumBusy)
    const reasonFor = await read($, scrumReason)
    if (!v) return <Text color="inactive">Loading…</Text>
    const sc = v.scrum ?? EMPTY_SCRUM(v.day)
    const menuFor = await read($, scrumMenu)
    const allBlockers = await read($, scrumAllBlockers)
    const todo = sc.today.filter(r => r.column === 'todo' || r.column === 'other')
    const doing = sc.today.filter(r => r.column === 'doing')
    const delivered = sc.today.filter(r => r.column === 'delivered')
    const stackScrum = (e.viewport?.columns ?? 999) < 90
    const settingsOpen = await read($, scrumSettingsOpen)
    const advancedOpen = await read($, scrumAdvancedOpen)
    const pickSet = sc.settings ?? DEFAULT_SETTINGS
    const pf = { ...DEFAULT_PR_FILTERS, ...(await read($, prFilters)) }
    const setPf = (patch: Partial<PrFilters>) => { void update($, prFilters, old => ({ ...DEFAULT_PR_FILTERS, ...old, ...patch })) }
    const tracker = v.tracker ?? []
    const prShown = filterTracker(tracker, pf)
    const prCount = trackerCounts(tracker, pf.days)
    const prRepos = [...new Set(tracker.map(r => r.label))]
    const prFiltered = pf.show !== 'open' || pf.status !== 'all' || pf.repo !== 'all' || !!pf.search

    // Any filter change goes back to the first page.
    const setF = (patch: Partial<Filters>) => { void update($, filters, old => ({ ...old, ...patch, showAll: patch.showAll ?? false, page: patch.page ?? 0 })) }
    const shown = filterBoard(v.board, f)
    const pages = Math.max(1, Math.ceil(shown.length / BOARD_PAGE))
    const pageNo = Math.min(f.page ?? 0, pages - 1)
    const page = f.showAll ? shown : shown.slice(pageNo * BOARD_PAGE, (pageNo + 1) * BOARD_PAGE)
    const firstRow = shown.length ? (f.showAll ? 1 : pageNo * BOARD_PAGE + 1) : 0
    const lastRow = f.showAll ? shown.length : Math.min((pageNo + 1) * BOARD_PAGE, shown.length)
    const areaCount = (a: Area) => filterBoard(v.board, { ...f, area: a }).length
    const statuses = [...new Set(v.board.map(r => r.status))]
      .sort((a, b) => ['Backlog', 'In Development', 'In Review', 'Waiting QA', 'Done'].indexOf(a) -
        ['Backlog', 'In Development', 'In Review', 'Waiting QA', 'Done'].indexOf(b))
    const recent = Date.now() - ANSWERED_DAYS * 86_400_000
    const toSend = v.questions.filter(q => q.status === 'to_send')
    const hiddenQs = v.questions.filter(q => q.status === 'hidden')
    const waitingQs = v.questions.filter(q => q.status === 'waiting')
      .sort((a, b) => b.askedAt.localeCompare(a.askedAt))
    const answered = v.questions
      .filter(q => q.status === 'answered' && new Date((q.answeredAt || q.askedAt).replace(/x/gi, '0')).getTime() >= recent)
      .sort((a, b) => (b.answeredAt || b.askedAt).localeCompare(a.answeredAt || a.askedAt))

    const isFoldedId = (id: string) => fold[id] ?? FOLDED_AT_FIRST.includes(id)
    // A card: its header folds and unfolds it; folded, it shows a one-line summary instead.
    const Card = (p: { id: string; title: string; count?: number; tone?: 'warning'; summary?: string; children: RenderChildren }) => {
      const isFolded = isFoldedId(p.id)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={p.tone ?? 'subtle'} paddingX={1} marginX={1} marginTop={1}>
          <Box justifyContent="space-between" alignItems="center" gap={1}>
            <Button key={`fold-${p.id}`} plain label={`${isFolded ? '▸' : '▾'} ${p.title.toUpperCase()}`}
              onPress={() => { void setFolded($, { ...fold, [p.id]: !isFolded }) }} />
            {isFolded && p.summary
              ? <Text size="caption" color={p.tone ?? 'inactive'} wrap="truncate-end">{p.summary}</Text>
              : p.count !== undefined && <Text size="caption" color={p.tone ?? 'inactive'} tabular>{String(p.count)}</Text>}
          </Box>
          {!isFolded && <Box flexDirection="column" marginTop={1}>{p.children}</Box>}
        </Box>
      )
    }
    const allFolded = CARD_IDS.every(id => isFoldedId(id))
    // A table row: fixed-share cells, the title cell takes the rest.
    // minWidth 0 + overflow hidden let a long title truncate inside its cell instead of pushing the
    // next columns right; a small right padding keeps neighbouring text from touching.
    const Cell = (p: { w?: string; right?: true; children: RenderChildren }) => (
      <Box width={p.w} flexGrow={p.w ? 0 : 1} flexShrink={p.w ? 0 : 1} minWidth={0} overflow="hidden"
        paddingRight={p.right ? 0 : 1} justifyContent={p.right ? 'flex-end' : 'flex-start'}>
        {p.children}
      </Box>
    )
    const Head = (p: { cols: [string, string | undefined, boolean?][] }) => (
      <Box>
        {p.cols.map(([label, w, right]) => (
          <Cell key={`head-${label}`} w={w} right={right ? true : undefined}>
            <Text size="caption" color="inactive" wrap="truncate-end">{label}</Text>
          </Cell>
        ))}
      </Box>
    )
    // Responsive: a narrow pane (a terminal split, a phone) drops the columns it can live without.
    const narrow = (e.viewport?.columns ?? 999) < 72
    // The Time card puts its ticket list under the ring when there is no room beside it.
    const stackTime = (e.viewport?.columns ?? 999) < 90
    const pillColor = (tone: TicketRow['tone']) =>
      tone === 'dev' ? 'suggestion' : tone === 'review' ? 'merged' : tone === 'qa' ? 'success' : 'inactive'
    // The Time card shows the picked day, else today.
    const dayShown = pick?.day ?? v.day
    const logged = pick ? pick.logged : v.loggedMinutes
    const perTicket = pick ? pick.perTicket : v.perTicket
    const pct = logged / Math.max(v.minMinutes, 1)
    const inRange = logged >= v.minMinutes && logged <= v.maxMinutes
    const weekTotal = v.week.reduce((s, d) => s + d.minutes, 0)
    const pastDays = v.week.filter(d => d.day <= v.day && (d.minutes > 0 || d.day < v.day))
    const weekInRange = pastDays.length > 0 && pastDays.every(d => d.minutes >= v.minMinutes && d.minutes <= v.maxMinutes)

    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {/* header */}
          <Box justifyContent="space-between" alignItems="center" paddingX={1} paddingTop={1}>
            <Box flexDirection="column">
              <Box gap={1} alignItems="center">
                <Text size="heading" weight="bold">{v.greeting}</Text>
                {demo && <Text size="caption" weight="semibold" color="warning">DEMO</Text>}
              </Box>
              <Text size="caption" color="inactive">
                {`${v.dayLabel} · ${working ?? `updated ${v.updated}${v.updatedIso ? ` · ${ago(v.updatedIso)}` : ''}`}`}
              </Text>
            </Box>
            <Box gap={1} alignItems="center">
              <Button key="fold-all" plain label={allFolded ? 'Expand all' : 'Collapse all'}
                onPress={() => { void setFolded($, Object.fromEntries(CARD_IDS.map(id => [id, !allFolded]))) }} />
              <Button key="refresh" label="↻ Refresh" variant="secondary" onPress={() => { void refresh($) }} />
            </Box>
          </Box>
          <Box paddingX={1} gap={2} flexWrap="wrap">
            {v.sources.map(s => {
              if (isChecking(s, since)) {
                return (
                  <Text size="caption" color="inactive">
                    <Text color="inactive">●</Text>
                    {` ${s.name} checking…`}
                  </Text>
                )
              }
              const old = s.ok && stale(s.at)
              const tone = !s.ok || old ? 'warning' : 'success'
              return (
                <Text size="caption" color={tone === 'warning' ? 'warning' : 'inactive'}>
                  <Text color={tone}>●</Text>
                  {` ${s.name} ${!s.ok ? 'not checked' : s.at ? localTime(s.at) : ''}${old ? ' (old)' : ''}`}
                </Text>
              )
            })}
          </Box>
          {v.error && <Box paddingX={1} paddingTop={1}><Text color="warning">{v.error}</Text></Box>}

          {/* attention */}
          {v.needs.length > 0 ? (
            <Card id="needs" title="Needs you" count={v.needs.length} tone="warning"
              summary={`${v.needs.length} waiting · ${v.needs[0]?.text ?? ''}`}>
              {v.needs.map(n => (
                <Box justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end">{n.text}</Text>
                  {n.action === 'timesheet'
                    ? <Button key="need-timesheet" label="Propose" plain onPress={() => ask($, v.timeCommand)} />
                    : n.url ? <Link href={n.url} label={`${n.linkLabel ?? 'Open'} ↗`} /> : null}
                </Box>
              ))}
            </Card>
          ) : (
            <Box marginX={1} marginTop={1} paddingX={1} borderStyle="round" borderColor="success">
              <Text color="success" weight="semibold">✓ All clear</Text>
              <Text size="caption" color="inactive">{'  nothing is waiting on you'}</Text>
            </Box>
          )}

          {/* scrum: three tiles, today as To do / In progress / Delivered, yesterday, blockers */}
          <Card id="scrum" title={`Scrum · ${shortDay(sc.day)}`} count={sc.today.length}
            summary={`${sc.yesterday ? `yesterday ${sc.yesterday.delivered} of ${sc.yesterday.rows.length} · ` : ''}today ${sc.today.length} · ${sc.lockedAt ? 'locked' : 'not locked'}`}>
            <Box justifyContent="space-between" alignItems="center" gap={1}>
              <Text size="caption" color="inactive">
                {sc.lockedAt ? `Locked ${localTime(sc.lockedAt)}` : sc.saved ? 'Draft: not locked yet' : 'Suggested: not locked yet'}
              </Text>
              <Box gap={1} alignItems="center">
                <Button key="scrum-settings" plain label={settingsOpen ? 'Close picking ▴' : 'How today is picked ▾'}
                  onPress={() => { void update($, scrumSettingsOpen, old => !old) }} />
                {!sc.lockedAt && sc.today.length > 0 &&
                  <Button key="scrum-lock" label="Lock today" variant="secondary" onPress={() => { void scrumLock($) }} />}
              </Box>
            </Box>
            {settingsOpen && (
              <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="subtle">
                <Text size="caption" color="inactive">Start from</Text>
                <Box gap={1} flexWrap="wrap">
                  {(Object.keys(PRESETS) as PresetId[]).map(id => (
                    <Button key={`scrum-preset-${id}`} label={`${pickSet.preset === id ? '● ' : ''}${PRESETS[id].label}`}
                      {...(pickSet.preset === id ? { variant: 'secondary' as const } : { plain: true as const })}
                      onPress={() => { void scrumPreset($, id) }} />
                  ))}
                  {pickSet.preset === 'custom' && <Text size="caption" color="inactive">● Custom</Text>}
                </Box>
                <Box marginTop={1}><Text size="caption" color="inactive">Rules, top one first. Yesterday's and in-progress tickets always fit; the rest share the daily allowance.</Text></Box>
                {pickSet.rules.map((r, i) => (
                  <Box key={`scrum-rule-${r.id}`} gap={1} alignItems="center">
                    <Box width={6} flexShrink={0}>
                      <Button key={`scrum-rule-on-${r.id}`} label={r.on ? 'On' : 'Off'} {...(r.on ? { variant: 'secondary' as const } : { plain: true as const })}
                        onPress={() => { void scrumToggleRule($, r.id) }} />
                    </Box>
                    <Box flexGrow={1} minWidth={0} gap={1} alignItems="center">
                      <Text size="caption" color={r.on ? undefined : 'inactive'} wrap="truncate-end">{RULE_LABEL[r.id]}</Text>
                      {r.id === 'due_soon' && <Box gap={1} alignItems="center">
                        <Text size="caption" color="inactive">within</Text>
                        <Button key="scrum-due-minus" label="−" plain onPress={() => { void scrumNumber($, 'due_days', -1) }} />
                        <Text size="caption" tabular>{`${pickSet.due_days} ${pickSet.due_days === 1 ? 'day' : 'days'}`}</Text>
                        <Button key="scrum-due-plus" label="+" plain onPress={() => { void scrumNumber($, 'due_days', 1) }} />
                      </Box>}
                      {r.id === 'custom' && !pickSet.custom_jql && <Text size="caption" color="inactive">(set it under Advanced)</Text>}
                    </Box>
                    <Box flexShrink={0} gap={1}>
                      {i > 0 && <Button key={`scrum-rule-up-${r.id}`} label="↑" plain onPress={() => { void scrumMoveRule($, r.id, -1) }} />}
                      {i < pickSet.rules.length - 1 && <Button key={`scrum-rule-down-${r.id}`} label="↓" plain onPress={() => { void scrumMoveRule($, r.id, 1) }} />}
                    </Box>
                  </Box>
                ))}
                <Box gap={1} alignItems="center" marginTop={1}>
                  <Text size="caption">New tickets a day</Text>
                  <Button key="scrum-new-minus" label="−" plain onPress={() => { void scrumNumber($, 'new_per_day', -1) }} />
                  <Text size="caption" weight="semibold" tabular>{String(pickSet.new_per_day)}</Text>
                  <Button key="scrum-new-plus" label="+" plain onPress={() => { void scrumNumber($, 'new_per_day', 1) }} />
                </Box>

                <Box marginTop={1}><Text size="caption" color="inactive">Next up · picked in this order, and dropped once delivered</Text></Box>
                <Box gap={1} flexWrap="wrap" alignItems="center">
                  {sc.queue.length === 0 && <Text size="caption" color="inactive">Empty.</Text>}
                  {sc.queue.map((q, i) => (
                    <Box key={`scrum-q-${q.key}`} gap={0} alignItems="center">
                      <Text size="caption" mono>{`${i + 1} · ${q.key}`}</Text>
                      <Button key={`scrum-q-remove-${q.key}`} label="×" plain onPress={() => { void scrumQueueRemove($, q.key) }} />
                    </Box>
                  ))}
                </Box>
                {Input && <Input key="scrum-queue-input" placeholder="885 934" value="" submitLabel="add"
                  onSubmit={value => { void scrumQueueAdd($, value) }} />}

                <Box marginTop={1}>
                  <Button key="scrum-advanced" plain label={advancedOpen ? 'Advanced ▴' : 'Advanced: a custom Jira search ▾'}
                    onPress={() => { void update($, scrumAdvancedOpen, old => !old) }} />
                </Box>
                {advancedOpen && Input && (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text size="caption" color="inactive">Any Jira search (JQL), used in its own order by "My custom Jira search". Read at the next Refresh.</Text>
                    <Input key="scrum-jql" placeholder="assignee = currentUser() AND sprint in openSprints() ORDER BY Rank" value={pickSet.custom_jql} submitLabel="save"
                      onSubmit={value => { void scrumCustomJql($, value) }} />
                  </Box>
                )}
              </Box>
            )}
            {sc.orderError && <Text size="caption" color="warning">{`Not used this time: ${sc.orderError}`}</Text>}

            {/* one status line instead of stat tiles: the numbers below already show the detail */}
            <Box gap={2} flexWrap="wrap">
              <Text size="caption" color="inactive">
                {'Yesterday '}<Text size="caption" weight="semibold" color={sc.yesterday && sc.yesterday.delivered === sc.yesterday.rows.length ? 'success' : undefined}>
                  {sc.yesterday ? `${sc.yesterday.delivered} of ${sc.yesterday.rows.length} delivered` : 'no plan'}</Text>
              </Text>
              <Text size="caption" color="inactive">
                {'Today '}<Text size="caption" weight="semibold">{`${sc.today.length} planned, ${doing.length} in progress`}</Text>
              </Text>
              {sc.blockers.length > 0
                ? <Button key="scrum-blockers" plain label={`Blockers ${sc.blockers.length} ${allBlockers ? '▴' : '▾'}`}
                    onPress={() => { void update($, scrumAllBlockers, old => !old) }} />
                : <Text size="caption" color="inactive">Blockers 0</Text>}
            </Box>
            {/* the blockers themselves, opened from the status line: each one, who it waits on, since when, and its thread */}
            {allBlockers && sc.blockers.length > 0 && (
              <Box flexDirection="column" marginTop={1} paddingLeft={2}>
                <Text size="caption" color="inactive">Questions still waiting for an answer, oldest first. Mark answered in Questions to clear one.</Text>
                {sc.blockers.map((b, i) => (
                  <Box key={`scrum-b-${i}`} gap={1} alignItems="center">
                    <Box flexGrow={1} minWidth={0}><Text size="caption" wrap="truncate-end">{b.text}</Text></Box>
                    <Box flexShrink={0}><Text size="caption" color="warning" tabular>{b.since ? ago(b.since) : ''}</Text></Box>
                    <Box flexShrink={0} width={7} justifyContent="flex-end">{b.url ? <Link href={b.url} label="Open ↗" /> : <Text size="caption" color="inactive">—</Text>}</Box>
                  </Box>
                ))}
              </Box>
            )}

            {/* today as a board */}
            <Box gap={1} marginTop={1} flexDirection={stackScrum ? 'column' : 'row'} alignItems="flex-start">
              {([['To do', todo], ['In progress', doing], ['Delivered', delivered]] as const).map(([title, rows]) => (
                <Box key={`scrum-col-${title}`} flexDirection="column" flexGrow={1} minWidth={0}
                  width={stackScrum ? '100%' : undefined}>
                  <Box gap={1} marginBottom={1}>
                    <Text size="caption" weight="semibold">{title}</Text>
                    <Text size="caption" color="inactive" tabular>{String(rows.length)}</Text>
                  </Box>
                  {rows.length === 0 && <Text size="caption" color="inactive">{title === 'To do' ? 'Add a ticket below' : '—'}</Text>}
                  {rows.map(r => (
                    <Box key={`scrum-t-${r.key}`} flexDirection="column" marginBottom={1}>
                      <Box justifyContent="space-between" alignItems="center" gap={1}>
                        {r.url ? <Link href={r.url} label={r.key} /> : <Text size="caption" mono>{r.key}</Text>}
                        <Box gap={1} alignItems="center" flexShrink={0}>
                          {r.column === 'doing' && r.hasPr && <Text size="caption" color="success">PR up</Text>}
                          {r.column === 'delivered' && <Text size="caption" color="success">{r.status}</Text>}
                          {r.column === 'other' && <Text size="caption" color="warning">{r.status}</Text>}
                          {r.why && <Text size="caption" color="inactive">{r.why}</Text>}
                          {moving === r.key && <Text size="caption" color="inactive">working…</Text>}
                          {moving !== r.key && r.column === 'todo' &&
                            <Button key={`scrum-start-${r.key}`} label="Start" variant="secondary" onPress={() => { void scrumAsk($, r.key, 'start') }} />}
                          {moving !== r.key && r.column === 'doing' &&
                            <Button key={`scrum-done-${r.key}`} label="Done" variant="secondary" onPress={() => { void scrumAsk($, r.key, 'done') }} />}
                          {r.column !== 'delivered' &&
                            <Button key={`scrum-more-${r.key}`} label="More" plain
                              onPress={() => { void update($, scrumMenu, old => (old === r.key ? null : r.key)) }} />}
                        </Box>
                      </Box>
                      <Text size="caption" color={r.column === 'delivered' ? 'inactive' : undefined} wrap="truncate-end">{r.title}</Text>
                      {r.reason && <Text size="caption" color="warning" wrap="truncate-end">{`Not done: ${r.reason}`}</Text>}
                      {menuFor === r.key && (
                        <Box gap={1}>
                          <Button key={`scrum-up-${r.key}`} label="↑" plain onPress={() => { void scrumMoveRow($, r.key, -1) }} />
                          <Button key={`scrum-down-${r.key}`} label="↓" plain onPress={() => { void scrumMoveRow($, r.key, 1) }} />
                          <Button key={`scrum-notdone-${r.key}`} label="Not done…" plain
                            onPress={() => { void update($, scrumMenu, () => null); void update($, scrumReason, () => r.key) }} />
                          <Button key={`scrum-remove-${r.key}`} label="Take off today" plain
                            onPress={() => { void update($, scrumMenu, () => null); void scrumRemove($, r.key) }} />
                        </Box>
                      )}
                      {pending?.key === r.key && (
                        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                          {pending.error
                            ? <Text size="caption" color="error">{pending.error}</Text>
                            : <Text size="caption">{pending.preview.replace(`${r.key}: `, '')}</Text>}
                          {pending.noPr && !pending.error &&
                            <Text size="caption" color="warning">No PR in today's data names this ticket. Done is for a ticket whose PR is up.</Text>}
                          <Box gap={1}>
                            {!pending.error && <Button key={`scrum-confirm-${r.key}`} label={pending.noPr ? 'Confirm anyway' : 'Confirm'} variant="primary"
                              onPress={() => { void scrumConfirm($) }} />}
                            <Button key={`scrum-cancel-${r.key}`} label={pending.error ? 'Close' : 'Cancel'} plain
                              onPress={() => { void update($, scrumPending, () => null) }} />
                          </Box>
                        </Box>
                      )}
                      {reasonFor === r.key && Input && (
                        <Box marginTop={1}>
                          <Input key={`scrum-reason-${r.key}`} placeholder="Blocked, waiting on review…" value={r.reason} submitLabel="save"
                            onSubmit={value => { void scrumSetReason($, r.key, value) }} />
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
            {Input && (
              <Box marginTop={1}>
                <Input key="scrum-pick" placeholder="Pick for today: 885 934" value="" submitLabel="add"
                  onSubmit={value => { void scrumPick($, value) }} />
              </Box>
            )}
            {Select && sc.addable.length > 0 && (
              <Box marginTop={1}>
                <Select key="scrum-add" label="Add ticket" value=""
                  options={[{ value: '', label: `Add one of ${sc.addable.length}…` },
                    ...sc.addable.map(t => ({ value: t.key, label: `${t.key} · ${t.title} (${t.status})` }))]}
                  onSelect={value => { if (value) void scrumAdd($, value) }} />
              </Box>
            )}

            {/* yesterday */}
            <Box flexDirection="column" marginTop={1}>
              <Text size="caption" weight="semibold" color="inactive">
                {sc.yesterday ? `Yesterday · ${sc.yesterday.label}` : 'Yesterday'}
              </Text>
              {!sc.yesterday && <Text size="caption" color="inactive">Lock today's list, and tomorrow this shows how it went.</Text>}
              {sc.yesterday?.rows.map(r => (
                <Box key={`scrum-y-${r.key}`} gap={1} alignItems="center">
                  <Box width={2} flexShrink={0}><Text size="caption" color={DOT_COLOR[r.column]}>{DOT[r.column]}</Text></Box>
                  <Box flexShrink={0}>{r.url ? <Link href={r.url} label={r.key} /> : <Text size="caption" mono>{r.key}</Text>}</Box>
                  <Box flexGrow={1} minWidth={0}><Text size="caption" wrap="truncate-end">{r.reason ? `${r.title} · ${r.reason}` : r.title}</Text></Box>
                  {!narrow && <Box flexShrink={0}><Text size="caption" color="inactive">{shortMove(r.then, r.now)}</Text></Box>}
                  <Box flexShrink={0}>
                    {r.column !== 'delivered' && !r.inToday
                      ? <Button key={`scrum-carry-${r.key}`} label="Carry over" plain onPress={() => { void scrumCarry($, r.key) }} />
                      : <Text size="caption" color="inactive">{r.inToday && r.column !== 'delivered' ? 'carried' : ''}</Text>}
                  </Box>
                </Box>
              ))}
            </Box>

            <Box gap={1} marginTop={1}>
              <Button key="scrum-copy" label="Copy scrum" variant="secondary" onPress={press => {
                void $.ui.copy({ text: sc.text, surface: press.surface })
                  .then(res => $.ui.toast(res.isCopied ? 'Scrum copied.' : 'Could not copy.'))
              }} />
              <Button key="scrum-write" label="Write to scrum doc" plain onPress={() => ask($, '/scrum')} />
            </Box>
          </Card>

          {/* time: today, or the weekday picked below */}
          <Card id="time" title={pick ? `Time · ${pick.label}` : 'Time today'}
            summary={`${fmt(logged)} · ${inRange ? 'in range' : pct < 1 ? `${fmt(v.minMinutes - logged)} short` : `${fmt(logged - v.maxMinutes)} over`} · week ${fmt(weekTotal)}`}>
            {pick?.missing ? (
              <Text color="inactive">No data for this day.</Text>
            ) : (
              <Box gap={2} alignItems={stackTime ? 'stretch' : 'center'} flexDirection={stackTime ? 'column' : 'row'}>
                <Box gap={2} alignItems="center" flexShrink={0}>
                {Svg && <Svg key={`ring-${dayShown}-${logged}`} source={ring(logged, v.minMinutes, v.maxMinutes)} alt={`${fmt(logged)} of ${fmt(v.minMinutes)} to ${fmt(v.maxMinutes)}`} width={84} height={84} isInteractive />}
                <Box flexDirection="column" flexShrink={0}>
                  <Text size="title" weight="bold" tabular wrap="truncate-end">{fmt(logged)}</Text>
                  <Text size="caption" color="inactive" tabular>{`of ${fmt(v.minMinutes)} – ${fmt(v.maxMinutes)}`}</Text>
                  <Text size="caption" weight="semibold" color={inRange ? 'success' : pct < 1 ? 'warning' : 'error'}>
                    {inRange ? '✓ In range' : pct < 1 ? `${fmt(v.minMinutes - logged)} ${pick ? 'short' : 'to go'}` : `${fmt(logged - v.maxMinutes)} over`}
                  </Text>
                </Box>
                </Box>
                <Box flexDirection="column" flexGrow={1} minWidth={0}>
                  {perTicket.length === 0 && <Text size="caption" color="inactive">Nothing logged.</Text>}
                  {perTicket.map((t, i) => (
                    <Box key={`t-${dayShown}-${t.key}`} gap={1} alignItems="center">
                      <Box width={5} flexShrink={0}>{t.url ? <Link href={t.url} label={t.key} /> : <Text size="caption" mono>{t.key}</Text>}</Box>
                      <Box flexGrow={1} minWidth={0}>
                        {Svg && <Svg key={`bar-${dayShown}-${t.key}-${t.minutes}`} source={ticketBar(t, i, perTicket[0]?.minutes ?? 1)}
                          alt={`${t.id} ${fmt(t.minutes)}`} height={ROW_H} isInteractive />}
                      </Box>
                      <Box width={7} flexShrink={0} justifyContent="flex-end">
                        <Text size="caption" color="inactive" tabular>{fmt(t.minutes)}</Text>
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            )}
            {v.week.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Box justifyContent="space-between">
                  <Text size="caption" color="inactive">This week</Text>
                  <Text size="caption" color={weekInRange ? 'success' : 'inactive'} tabular>
                    {`${fmt(weekTotal)} logged${weekInRange ? ' · every day in range' : ''}`}
                  </Text>
                </Box>
                {Svg && <Svg key={`week-${dayShown}-${v.week.map(d => d.minutes).join(',')}`} source={weekStrip(v, dayShown)} alt={`Minutes logged this week: ${v.week.map(d => `${d.label} ${fmt(d.minutes)}`).join(', ')}`} width={300} height={74} isInteractive />}
                <Box gap={1} flexWrap="wrap" marginTop={1}>
                  {v.week.map(d => (
                    <Button key={`day-${d.day}`} label={d.isToday ? `${d.label} · today` : d.label}
                      variant={d.day === dayShown ? 'primary' : 'secondary'} onPress={() => { void pickDay($, d.day) }} />
                  ))}
                  {pick && <Button key="day-today" label="Back to today" plain onPress={() => { void pickDay($, v.day) }} />}
                </Box>
              </Box>
            )}
          </Card>

          {/* questions to act on: to send, and waiting for an answer */}
          {(toSend.length + waitingQs.length + hiddenQs.length) > 0 && (
            <Card id="questions" title="Questions" count={toSend.length + waitingQs.length}
              summary={`${toSend.length} to send · ${waitingQs.length} waiting`}>
              {toSend.length > 0 && (
                <Box flexDirection="column" marginBottom={1}>
                  <Text size="caption" weight="semibold" color="warning">{`TO SEND (${toSend.length})`}</Text>
                  {toSend.map(q => (
                    <Box key={`send-${q.id}`} flexDirection="column" marginTop={1}>
                      <Text weight="semibold">{q.topic}</Text>
                      {q.text && <Text size="caption">{q.text}</Text>}
                      <Box justifyContent="space-between" gap={1}>
                        <Box gap={1}>
                          {q.to && <Text size="caption" color="inactive">{`for ${q.to.split(' ')[0]}`}</Text>}
                          {q.ticketLinks.map(t => t.url ? <Link key={`send-${q.id}-${t.key}`} href={t.url} label={t.key} /> : <Text size="caption" color="inactive">{t.key}</Text>)}
                        </Box>
                        <Box gap={1}>
                          {q.composeUrl && <Link href={q.composeUrl} label={`Send in ${v.chatName} ↗`} />}
                          <Button key={`copy-${q.id}`} label="Copy" plain onPress={press => {
                            void $.ui.copy({ text: q.text || q.topic, surface: press.surface })
                              .then(r => $.ui.toast(r.isCopied ? `Copied: paste it in ${v.chatName}.` : 'Could not copy.'))
                          }} />
                          <Button key={`sent-${q.id}`} label="Mark sent" plain onPress={() => { void markSent($, q.id) }} />
                        </Box>
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
              {waitingQs.length > 0 && (
                <Box flexDirection="column">
                  <Text size="caption" weight="semibold" color="inactive">{`WAITING FOR AN ANSWER (${waitingQs.length})`}</Text>
                  {waitingQs.map(q => (
                    <Box key={`wait-${q.id}`} flexDirection="column" marginBottom={1} hover={{ backgroundColor: ROW_HOVER }}>
                      <Text wrap="truncate-end">{q.topic}</Text>
                      <Box gap={1} flexWrap="wrap" alignItems="center">
                        <Text size="caption" color="inactive">{[q.to.split(' ')[0], dateTime(q.askedAt)].filter(Boolean).join(' · ')}</Text>
                        {q.ticketLinks.map(t => t.url ? <Link key={`wait-${q.id}-${t.key}`} href={t.url} label={t.key} /> : null)}
                        {q.url && <Link href={q.url} label={`Open in ${v.chatName} ↗`} />}
                        <Box borderStyle="round" borderColor="success">
                          <Button key={`answered-${q.id}`} label="Mark answered" onPress={() => { void setOverride($, q.id, 'answered') }}>
                            <Text color="success" weight="semibold">✓ Mark answered</Text>
                          </Button>
                        </Box>
                        <Box borderStyle="round" borderColor="warning">
                          <Button key={`notq-${q.id}`} label="Not a question" onPress={() => { void setOverride($, q.id, 'not_question') }}>
                            <Text color="warning" weight="semibold">✕ Not a question</Text>
                          </Button>
                        </Box>
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
              {/* hidden with "Not a question": kept, folded, each with Restore */}
              {hiddenQs.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Button key="fold-hidden" plain label={`${isFoldedId('hidden') ? '▸' : '▾'} Hidden as not a question (${hiddenQs.length})`}
                    onPress={() => { void setFolded($, { ...fold, hidden: !isFoldedId('hidden') }) }} />
                  {!isFoldedId('hidden') && hiddenQs.map(q => (
                    <Box key={`hid-${q.id}`} justifyContent="space-between" gap={1} alignItems="center">
                      <Box minWidth={0} flexShrink={1} overflow="hidden">
                        <Text size="caption" color="inactive" wrap="truncate-end">{q.topic}</Text>
                      </Box>
                      <Button key={`restore-${q.id}`} label="Restore" plain onPress={() => { void clearOverride($, q.id) }} />
                    </Box>
                  ))}
                </Box>
              )}
            </Card>
          )}

          {/* answered in the last days, with the reply: reference, folded at first */}
          {answered.length > 0 && (
            <Card id="answered" title={`Answered · last ${ANSWERED_DAYS} days`} count={answered.length}
              summary={`${answered.length} answered · newest: ${answered[0]?.topic ?? ''}`}>
              {answered.map(q => (
                <Box key={`ans-${q.id}`} flexDirection="column" marginBottom={1}>
                  <Box justifyContent="space-between" gap={1}>
                    <Text weight="semibold" wrap="truncate-end">{q.topic}</Text>
                    {q.url && <Link href={q.url} label={`Open in ${v.chatName} ↗`} />}
                  </Box>
                  <Text size="caption">{`→ ${q.answer || 'answered'}`}</Text>
                  <Box gap={1}>
                    <Text size="caption" color="inactive">{[q.answeredBy.split(' ')[0], dateTime(q.answeredAt)].filter(Boolean).join(' · ')}</Text>
                    {q.ticketLinks.map(t => t.url ? <Link key={`ans-${q.id}-${t.key}`} href={t.url} label={t.key} /> : null)}
                    {q.manual && <Button key={`undo-${q.id}`} label="Undo" plain onPress={() => { void clearOverride($, q.id) }} />}
                  </Box>
                </Box>
              ))}
            </Card>
          )}

          {/* PR tracker: open, needs fixes, merged; filters; grouped by status. An older day file has
              no tracker, so the day's PR table shows instead. */}
          {v.tracker !== null ? (
            <Card id="prs" title="Pull requests" count={prCount.open}
              summary={`${prCount.open} open · ${prCount.fixes} need fixes · ${prCount.merged} merged in ${pf.days} days`}>
              {/* the counts are the main filter: press one to show just those */}
              <Box gap={1} flexWrap="wrap" alignItems="center">
                {([
                  ['open', `Open ${prCount.open}`, pf.show === 'open' && pf.status === 'all', { show: 'open', status: 'all' }],
                  ['fixes', `Needs fixes ${prCount.fixes}`, pf.status === 'needs_fixes', { show: 'open', status: 'needs_fixes' }],
                  ['merged', `Merged ${prCount.merged} in ${pf.days}d`, pf.show === 'merged', { show: 'merged', status: 'all' }],
                  ['all', 'All', pf.show === 'all' && pf.status === 'all', { show: 'all', status: 'all' }],
                ] as const).map(([k, text, active, patch]) => (
                  <Button key={`pr-count-${k}`} label={text}
                    {...(active ? { variant: 'secondary' as const } : { plain: true as const })}
                    onPress={() => setPf(patch)} />
                ))}
              </Box>
              {v.trackerError && <Text size="caption" color="warning">{`Not refreshed: ${v.trackerError}`}</Text>}
              <Box gap={1} flexWrap="wrap" marginTop={1} alignItems="center">
                {Select && <Select key="pr-status" label="Status" value={pf.status}
                  options={[{ value: 'all', label: 'All statuses' },
                    ...PR_ORDER.map(st => ({ value: st, label: `${PR_STATUS[st].label} (${filterTracker(tracker, { ...pf, status: st, show: 'all' }).length})` }))]}
                  onSelect={value => setPf({ status: value as PrFilters['status'] })} />}
                {Select && prRepos.length > 1 && <Select key="pr-repo" label="Repo" value={pf.repo}
                  options={[{ value: 'all', label: 'All repos' }, ...prRepos.map(r => ({ value: r, label: r }))]}
                  onSelect={value => setPf({ repo: value })} />}
                <Box gap={0} alignItems="center">
                  <Text size="caption" color="inactive">Merged in</Text>
                  {([7, 14, 30] as const).map(d => (
                    <Button key={`pr-days-${d}`} label={`${d}d`}
                      {...(pf.days === d ? { variant: 'secondary' as const } : { plain: true as const })}
                      onPress={() => setPf({ days: d })} />
                  ))}
                </Box>
              </Box>
              {Input && (
                <Box marginTop={1}>
                  <Input key="pr-search" placeholder="Search PR number, ticket or title" value={pf.search} submitLabel="search"
                    onInput={value => setPf({ search: value })} onSubmit={value => setPf({ search: value })} />
                </Box>
              )}
              {prShown.length === 0 && <Box marginTop={1}><Text size="caption" color="inactive">
                {tracker.length === 0 ? 'No pull requests of yours, open or merged lately.' : 'Nothing matches these filters.'}</Text></Box>}
              {PR_ORDER.map(st => {
                const group = prShown.filter(r => r.status === st)
                if (!group.length) return null
                return (
                  <Box key={`pr-group-${st}`} flexDirection="column" marginTop={1}>
                    <Box gap={1}>
                      <Text size="caption" weight="semibold" color={PR_STATUS[st].color}>{PR_STATUS[st].label}</Text>
                      <Text size="caption" color="inactive" tabular>{String(group.length)}</Text>
                    </Box>
                    {group.map(r => (
                      <Box key={`pr-${r.label}-${r.number}`} hover={{ backgroundColor: ROW_HOVER }} gap={1} alignItems="center">
                        <Box flexShrink={0} width={10}><Link href={r.url} label={`${r.label} #${r.number}`} /></Box>
                        <Box flexShrink={0} gap={1}>
                          {r.tickets.length ? r.tickets.map(t => t.url
                            ? <Link key={`pr-t-${r.number}-${t.key}`} href={t.url} label={t.key} />
                            : <Text key={`pr-t-${r.number}-${t.key}`} size="caption" mono>{t.key}</Text>)
                            : <Text size="caption" color="inactive" wrap="truncate-end">{r.title}</Text>}
                        </Box>
                        <Box flexGrow={1} minWidth={0}><Text size="caption" color="inactive" wrap="truncate-end">{r.note}</Text></Box>
                        <Box flexShrink={0}><Text size="caption" color="inactive" tabular>{r.at ? ago(r.at).replace(' ago', '') : ''}</Text></Box>
                      </Box>
                    ))}
                  </Box>
                )
              })}
              <Box gap={1} marginTop={1}>
                <Button key="pr-copy" label="Copy summary" variant="secondary" onPress={press => {
                  void $.ui.copy({ text: trackerText(tracker, pf.days), surface: press.surface })
                    .then(res => $.ui.toast(res.isCopied ? 'PR summary copied.' : 'Could not copy.'))
                }} />
                {prFiltered && <Button key="pr-clear" label="Clear filters" plain onPress={() => setPf({ ...DEFAULT_PR_FILTERS, days: pf.days })} />}
              </Box>
            </Card>
          ) : (
          v.prs.length > 0 && (
            <Card id="prs" title="Pull requests" count={v.prs.length}
              summary={v.prs.map(r => `${r.pr} ${r.review}`).join(' · ')}>
              <Head cols={[['PR', '16%'], ['Tickets', undefined], ['Review', '26%'], ['State', '28%', true]]} />
              {v.prs.map(p => (
                <Box key={`pr-${p.pr}`} hover={{ backgroundColor: ROW_HOVER }}>
                  <Cell w="16%"><Link href={p.url} label={p.pr} /></Cell>
                  <Cell>{p.ticketsUrl ? <Link href={p.ticketsUrl} label={p.tickets} /> : <Text mono size="caption" color="inactive">{p.tickets}</Text>}</Cell>
                  <Cell w="26%">
                    <Text size="caption" color={p.tone === 'attn' ? 'warning' : p.review === 'approved' ? 'success' : 'inactive'}>{p.review}</Text>
                  </Cell>
                  <Cell w="28%" right>
                    <Text size="caption" tabular color={p.tone === 'done' ? 'success' : 'text'}>{p.state}</Text>
                  </Cell>
                </Box>
              ))}
            </Card>
          )
          )}

          {/* tickets table */}
          <Card id="tickets" title="Tickets" count={v.tickets.length}
            summary={`${v.tickets.filter(t => t.tone === 'dev').length} in development · ${v.tickets.filter(t => t.tone === 'review').length} in review`}>
            <Head cols={narrow
              ? [['Key', '12%'], ['Title', undefined], ['Status', '22%'], ['Today', '18%', true]]
              : [['Key', '8%'], ['Title', undefined], ['Status', '14%'], ['Start', '10%', true], ['Due', '10%', true], ['Today', '11%', true]]} />
            {v.tickets.length === 0 && <Text size="caption" color="inactive">No active tickets.</Text>}
            {v.tickets.map(t => (
              <Box key={`t-${t.key}`} hover={{ backgroundColor: ROW_HOVER }}>
                <Cell w={narrow ? '12%' : '8%'}>{t.url ? <Link href={t.url} label={t.key} /> : <Text mono size="caption" color="inactive">{t.key}</Text>}</Cell>
                <Cell><Text size="caption" wrap="truncate-end">{t.title}</Text></Cell>
                <Cell w={narrow ? '22%' : '14%'}><Text size="caption" weight="semibold" wrap="truncate-end" color={pillColor(t.tone)}>{`● ${t.status}`}</Text></Cell>
                {!narrow && <Cell w="10%" right><Text size="caption" tabular color="inactive">{t.start}</Text></Cell>}
                {!narrow && <Cell w="10%" right><Text size="caption" tabular color="inactive">{t.due}</Text></Cell>}
                <Cell w={narrow ? '18%' : '11%'} right><Text size="caption" tabular>{t.today}</Text></Cell>
              </Box>
            ))}
          </Card>

          {/* the merge's whole board: area, status, search, mine */}
          {v.board.length > 0 && (
            <Card id="board" title="Board" count={shown.length}
              summary={`${shown.length} tickets · ${AREAS.map(a => `${areaLabel(a)} ${areaCount(a)}`).join(' · ')}`}>
              {Select && (
                <Box gap={1} flexWrap="wrap">
                  <Select key="board-area" label="Area" value={f.area}
                    options={[
                      { value: 'all', label: `All (${filterBoard(v.board, { ...f, area: 'all' }).length})` },
                      ...AREAS.map(a => ({ value: a, label: `${areaLabel(a)} (${areaCount(a)})` })),
                    ]}
                    onSelect={value => setF({ area: value as Filters['area'] })} />
                  <Select key="board-status" label="Status" value={f.status}
                    options={[{ value: 'all', label: 'All statuses' }, ...statuses.map(s => ({ value: s, label: s }))]}
                    onSelect={value => setF({ status: value })} />
                  <Button key="board-mine" label={f.mineOnly ? '● Mine only' : '○ Mine only'} plain
                    onPress={() => setF({ mineOnly: !f.mineOnly })} />
                </Box>
              )}
              {Input && (
                <Box marginTop={1}>
                  <Input key="board-search" placeholder="Search key or title" value={f.search} submitLabel="search"
                    onInput={value => setF({ search: value })} onSubmit={value => setF({ search: value })} />
                </Box>
              )}
              <Box marginTop={1} flexDirection="column">
                <Head cols={narrow
                  ? [['Key', '12%'], ['Title', undefined], ['Status', '28%'], ['Due', '16%', true]]
                  : [['Key', '8%'], ['Title', undefined], ['Area', '12%'], ['Status', '18%'], ['Who', '10%'], ['Due', '9%', true]]} />
              </Box>
              {shown.length === 0 && <Text size="caption" color="inactive">No tickets match.</Text>}
              {page.map(r => (
                <Box key={`b-${r.key}`} hover={{ backgroundColor: ROW_HOVER }}>
                  <Cell w={narrow ? '12%' : '8%'}><Link href={r.url} label={String(num(r.key))} /></Cell>
                  <Cell><Text size="caption" wrap="truncate-end">{r.title}</Text></Cell>
                  {!narrow && <Cell w="12%"><Text size="caption" color="inactive" wrap="truncate-end">{areaLabel(r.area)}</Text></Cell>}
                  <Cell w={narrow ? '28%' : '18%'}>
                    <Text size="caption" weight="semibold" wrap="truncate-end" color={pillColor(
                      r.status === 'In Development' ? 'dev' : r.status === 'In Review' ? 'review' : r.status === 'Waiting QA' || r.status === 'Done' ? 'qa' : 'other')}>
                      {`● ${r.status}`}
                    </Text>
                  </Cell>
                  {!narrow && <Cell w="10%"><Text size="caption" color={r.mine ? 'text' : 'inactive'} wrap="truncate-end">{r.mine ? 'me' : r.assignee.split(' ')[0] || '—'}</Text></Cell>}
                  <Cell w={narrow ? '16%' : '9%'} right><Text size="caption" tabular color="inactive">{r.due}</Text></Cell>
                </Box>
              ))}
              {shown.length > 0 && (
                <Box marginTop={1} justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
                  <Text size="caption" color="inactive" tabular>{`${firstRow}–${lastRow} of ${shown.length}`}</Text>
                  {pages > 1 && (
                    <Box gap={1} alignItems="center">
                      {!f.showAll && (
                        <Box gap={1} alignItems="center">
                          {pageNo > 0 && <Button key="board-prev" label="‹ Prev" plain onPress={() => setF({ page: pageNo - 1 })} />}
                          {Array.from({ length: pages }, (_, i) => i === pageNo
                            ? <Button key={`board-page-${i + 1}`} label={String(i + 1)} variant="primary" onPress={() => setF({ page: i })} />
                            : <Button key={`board-page-${i + 1}`} label={String(i + 1)} plain onPress={() => setF({ page: i })} />)}
                          {pageNo < pages - 1 && <Button key="board-next" label="Next ›" plain onPress={() => setF({ page: pageNo + 1 })} />}
                        </Box>
                      )}
                      <Button key="board-more" label={f.showAll ? 'Pages' : 'Show all'} plain
                        onPress={() => { void update($, filters, old => ({ ...old, showAll: !old.showAll, page: 0 })) }} />
                    </Box>
                  )}
                </Box>
              )}
              {(f.area !== 'all' || f.status !== 'all' || f.search || f.mineOnly) && (
                <Box marginTop={1}>
                  <Button key="board-clear" label="Clear filters" plain onPress={() => { void update($, filters, () => DEFAULT_FILTERS) }} />
                </Box>
              )}
            </Card>
          )}
          {/* settings: which tool fills each category, and whether the last gather reached it */}
          <Card id="settings" title="Settings" count={v.providers.filter(r => r.state === 'ok').length}
            summary={`${v.providers.filter(r => r.state === 'ok').length} of ${v.providers.filter(r => r.state !== 'off').length} connected`}>
            {v.providers.map(r => (
              <Box key={`provider-${r.category}`} gap={1} alignItems="center">
                <Cell w="18%"><Text size="caption" color="inactive">{CATEGORY_LABELS[r.category] ?? r.category}</Text></Cell>
                <Cell><Text size="caption" weight="semibold">{r.tool}</Text>{r.via ? <Text size="caption" color="inactive">{`  via ${r.via}`}</Text> : null}</Cell>
                <Cell w="30%" right>
                  <Text size="caption" color={r.state === 'ok' ? 'success' : r.state === 'failing' ? 'warning' : 'inactive'}>
                    {r.state === 'ok' ? `● connected${r.at ? ` ${localTime(r.at)}` : ''}`
                      : r.state === 'failing' ? '● not reached' : r.state === 'off' ? '○ off' : '○ not gathered yet'}
                  </Text>
                </Cell>
              </Box>
            ))}
            {/* the doctor: a tick or the exact fix for each tool */}
            <Box marginTop={1} gap={1} alignItems="center" flexWrap="wrap">
              <Button key="doctor" label="Check connections" plain onPress={() => { void runDoctor($) }} />
              {doc && !doc.error && (
                <Text size="caption" color={doc.checks.every(c => c.ok) ? 'success' : 'warning'}>
                  {`${doc.checks.filter(c => c.ok).length} of ${doc.checks.length} ok · ${doc.at}`}
                </Text>
              )}
            </Box>
            {doc?.error && <Text size="caption" color="warning">{`Doctor could not run: ${doc.error}`}</Text>}
            {doc?.checks.filter(c => !c.ok).map((c, i) => (
              <Box key={`doc-${i}`} flexDirection="column" marginTop={1}>
                <Text size="caption" color="warning">{`✘ ${c.area}: ${c.what}`}</Text>
                {c.fix && <Text size="caption" mono>{`→ ${c.fix}`}</Text>}
              </Box>
            ))}
            <Box marginTop={1}>
              <Text size="caption" color="inactive">{`Change a tool in ${v.configPath || 'your config file'} (schema/config.schema.json lists every option).`}</Text>
            </Box>
          </Card>
        </Box>

        {/* actions */}
        {(v.primary || v.buttons.length > 0) && (
          <Box flexDirection="column" gap={1} padding={1}>
            {v.primary && <Button key={v.primary.key} label={v.primary.label} variant="primary" onPress={() => ask($, v.primary?.command ?? '')} />}
            {v.buttons.length > 0 && (
              <Box gap={1} flexWrap="wrap">
                {v.buttons.map(b => {
                  const hint = runs[b.command] ? `last ${runs[b.command]}` : b.hint
                  return (
                    <Box key={`act-${b.key}`} flexDirection="column" flexGrow={1} alignItems="center">
                      <Button key={b.key} label={b.label} variant="secondary" onPress={() => ask($, b.command)} />
                      {b.hintUrl && !runs[b.command] ? <Link href={b.hintUrl} label={hint} />
                        : hint ? <Text size="caption" color="inactive">{hint}</Text> : null}
                    </Box>
                  )
                })}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
