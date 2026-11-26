import type { QuestionRow, ScrumColumn, ScrumRow, ScrumView, ScrumYesterdayRow } from '../types'

// The Scrum card's plan file, <ledger_dir>/scrum.json: one entry per working day.
//   items: the day's committed tickets, each with its status when it was added or locked
//   locked_at: when the day's list was locked (null while it is still a draft)
//   moves: every Start / Done the card wrote to Jira that day, newest last
// The panel writes it; the collector reads its keys so planned tickets are fetched even when Done;
// the /scrum skill reads it for Today and Done last.
export type ScrumItem = {
  key: string; summary: string; status_at_lock?: string; carried_from?: string; reason?: string
  // which rule put it on the list ("pick" for one typed in by hand)
  picked_by?: RuleId | 'pick'
}
export type ScrumMove = { key: string; from: string; to: string; at: string }
export type ScrumDay = { locked_at: string | null; items: ScrumItem[]; moves?: ScrumMove[] }
export type ScrumFile = {
  days: Record<string, ScrumDay>
  // how today is picked (the card's "How today is picked" screen); absent = the default preset
  settings?: PickSettings
  // Next up: keys in the order you want them picked; a delivered one drops out
  queue?: string[]
}

// ── How today is picked ───────────────────────────────────────────────────────────────────────
// Rules run top to bottom; each adds tickets until the day is full. Carry-overs and tickets in
// progress always go on; the rest share the "new tickets a day" allowance.
export type RuleId = 'carry_over' | 'in_progress' | 'queue' | 'due_soon' | 'priority' | 'board' | 'custom'
export type PickSettings = {
  preset: PresetId | 'custom'
  rules: { id: RuleId; on: boolean }[]
  due_days: number
  new_per_day: number
  custom_jql: string
}
export type PresetId = 'urgent' | 'board' | 'priority' | 'queue_only'

export const RULE_LABEL: Record<RuleId, string> = {
  carry_over: 'Unfinished from yesterday',
  in_progress: 'Already in progress',
  queue: 'My Next up list',
  due_soon: 'Due soon',
  priority: 'Highest Jira priority',
  board: 'My board order',
  custom: 'My custom Jira search',
}
const ALL_RULES: RuleId[] = ['carry_over', 'in_progress', 'queue', 'due_soon', 'priority', 'board', 'custom']
const ruleSet = (on: RuleId[]): PickSettings['rules'] =>
  [...on.map(id => ({ id, on: true })), ...ALL_RULES.filter(id => !on.includes(id)).map(id => ({ id, on: false }))]

export const PRESETS: Record<PresetId, { label: string; rules: PickSettings['rules'] }> = {
  urgent: { label: 'Most urgent first', rules: ruleSet(['carry_over', 'in_progress', 'queue', 'due_soon', 'priority']) },
  board: { label: 'My board order', rules: ruleSet(['carry_over', 'in_progress', 'queue', 'board']) },
  priority: { label: 'Highest priority', rules: ruleSet(['carry_over', 'in_progress', 'queue', 'priority']) },
  queue_only: { label: 'Only what I queue', rules: ruleSet(['carry_over', 'in_progress', 'queue']) },
}
export const DEFAULT_SETTINGS: PickSettings = {
  preset: 'urgent', rules: PRESETS.urgent.rules, due_days: 2, new_per_day: 2, custom_jql: '',
}
// Settings as saved, filled out: a rule added in a later version shows up switched off.
export function settingsOf(file: ScrumFile): PickSettings {
  const saved = file.settings
  if (!saved) return DEFAULT_SETTINGS
  const known = (saved.rules ?? []).filter(r => ALL_RULES.includes(r.id))
  const rules = [...known, ...ALL_RULES.filter(id => !known.some(r => r.id === id)).map(id => ({ id, on: false }))]
  return {
    preset: saved.preset ?? 'custom', rules,
    due_days: Math.max(0, Math.min(30, Number(saved.due_days ?? 2))),
    new_per_day: Math.max(0, Math.min(10, Number(saved.new_per_day ?? 2))),
    custom_jql: saved.custom_jql ?? '',
  }
}

export type JiraLite = {
  key: string; summary: string; status: string; priority?: string | null; due_date?: string | null
}
export type PrLite = { tickets: string[]; state: string }

const TODO = ['Backlog', 'Open', 'Ready for Development', 'To Do', 'Selected for Development']
const DOING = ['In Development', 'In Progress']
const DELIVERED = ['In Review', 'Waiting QA', 'In QA', 'Production MR Ready', 'In Production MR', 'Done']

export const columnOf = (status: string): ScrumColumn =>
  TODO.includes(status) ? 'todo' : DOING.includes(status) ? 'doing' : DELIVERED.includes(status) ? 'delivered' : 'other'

const PRIORITY = ['Highest', 'Critical', 'Blocker', 'High', 'Medium', 'Low', 'Lowest']
const priorityRank = (p?: string | null) => {
  const i = PRIORITY.indexOf(p ?? '')
  return i < 0 ? PRIORITY.length : i
}

const num = (key: string) => Number(key.split('-')[1] ?? key.replace(/^\D+/, ''))
const label = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

export type ScrumInput = {
  day: string
  gatheredAt: string
  file: ScrumFile
  // every ticket the day file knows: mine (open + planned), the board and today's tickets
  known: JiraLite[]
  prs: PrLite[]
  questions: QuestionRow[]
  url: (key: string) => string
  // ticket keys in each query's own order (the board's rank, the custom search), and query errors
  orders?: Record<string, string[]>
  orderErrors?: Record<string, string>
}

// A ticket's status now: a move the card wrote after the day file was gathered wins, else the day file.
export function statusOf(input: ScrumInput, key: string): string {
  const since = Date.parse(input.gatheredAt) || 0
  const moves = Object.values(input.file.days).flatMap(d => d.moves ?? [])
    .filter(m => m.key === key && Date.parse(m.at) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return moves.at(-1)?.to ?? input.known.find(t => t.key === key)?.status ?? ''
}

// The last earlier day with a plan: "yesterday" for the scrum, which skips weekends and days off.
export function previousDay(file: ScrumFile, day: string): string | null {
  return Object.keys(file.days).filter(d => d < day && (file.days[d]?.items.length ?? 0) > 0).sort().at(-1) ?? null
}

// Today's list before anything is saved: the "How today is picked" rules, top to bottom.
export function suggest(input: ScrumInput, mine: JiraLite[]): ScrumItem[] {
  const settings = settingsOf(input.file)
  const out: ScrumItem[] = []
  let fresh = 0
  const add = (t: { key: string; summary: string }, status: string, by: RuleId, extra: Partial<ScrumItem> = {}) => {
    if (out.some(i => i.key === t.key)) return
    const counted = by !== 'carry_over' && by !== 'in_progress'
    if (counted && fresh >= settings.new_per_day) return
    if (counted) fresh += 1
    out.push({ key: t.key, summary: t.summary, status_at_lock: status, picked_by: by, ...extra })
  }
  const statusNow = (t: JiraLite) => statusOf(input, t.key) || t.status
  const todo = mine.filter(t => columnOf(statusNow(t)) === 'todo')
  const byKey = (a: JiraLite, b: JiraLite) => num(a.key) - num(b.key)
  const inOrder = (keys: string[]) => keys.map(k => todo.find(t => t.key === k)).filter((t): t is JiraLite => !!t)
  const today = new Date(`${input.day}T12:00:00`).getTime()
  const dueIn = (t: JiraLite) => t.due_date ? Math.round((new Date(`${t.due_date}T12:00:00`).getTime() - today) / 86_400_000) : Infinity

  for (const rule of settings.rules.filter(r => r.on)) {
    if (rule.id === 'carry_over') {
      const prev = previousDay(input.file, input.day)
      for (const i of prev ? input.file.days[prev]?.items ?? [] : []) {
        const status = statusOf(input, i.key)
        if (columnOf(status) !== 'delivered' && status !== 'Cancelled') {
          add(i, status, 'carry_over', { carried_from: prev ?? undefined })
        }
      }
    } else if (rule.id === 'in_progress') {
      for (const t of mine.filter(t => columnOf(statusNow(t)) === 'doing').sort(byKey)) add(t, statusNow(t), 'in_progress')
    } else if (rule.id === 'queue') {
      for (const t of inOrder(queueOf(input))) add(t, statusNow(t), 'queue')
    } else if (rule.id === 'due_soon') {
      for (const t of todo.filter(t => dueIn(t) <= settings.due_days).sort((a, b) => dueIn(a) - dueIn(b) || byKey(a, b))) {
        add(t, statusNow(t), 'due_soon')
      }
    } else if (rule.id === 'priority') {
      const sorted = [...todo].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || dueIn(a) - dueIn(b) || byKey(a, b))
      for (const t of sorted) add(t, statusNow(t), 'priority')
    } else if (rule.id === 'board' || rule.id === 'custom') {
      for (const t of inOrder(input.orders?.[rule.id] ?? [])) add(t, statusNow(t), rule.id)
    }
  }
  return out
}

// Next up, without what is delivered (or gone) since it was queued.
export function queueOf(input: ScrumInput): string[] {
  return (input.file.queue ?? []).filter(k => {
    const status = statusOf(input, k)
    return !status || ['todo', 'doing'].includes(columnOf(status))
  })
}

const shortDate = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

// Why a ticket is on today's list, in a few words.
export function whyOf(input: ScrumInput, item: ScrumItem, t: JiraLite | undefined): string {
  if (item.carried_from) return 'carried'
  const by = item.picked_by
  if (by === 'pick') return 'picked'
  if (by === 'in_progress') return 'in progress'
  if (by === 'queue') {
    const i = (input.file.queue ?? []).indexOf(item.key)
    return i >= 0 ? `Next up #${i + 1}` : 'Next up'
  }
  if (by === 'due_soon') return t?.due_date ? `due ${shortDate(t.due_date)}` : 'due soon'
  if (by === 'priority') return [t?.priority, t?.due_date ? `due ${shortDate(t.due_date)}` : ''].filter(Boolean).join(' · ') || 'priority'
  if (by === 'board') return 'board order'
  if (by === 'custom') return 'custom search'
  return ''
}

export function scrumView(input: ScrumInput, mine: JiraLite[]): ScrumView {
  const entry = input.file.days[input.day]
  const items = entry ? entry.items : suggest(input, mine)
  const hasPr = (key: string) => input.prs.some(p => p.tickets.includes(key) && p.state !== 'CLOSED')
  const today: ScrumRow[] = items.map(i => {
    const status = statusOf(input, i.key) || i.status_at_lock || ''
    return {
      key: i.key, title: i.summary, status, column: columnOf(status), url: input.url(i.key),
      hasPr: hasPr(i.key), reason: i.reason ?? '', carried: !!i.carried_from,
      why: whyOf(input, i, mine.find(t => t.key === i.key)), pickedBy: i.picked_by ?? '',
    }
  })

  const prev = previousDay(input.file, input.day)
  let yesterday: ScrumView['yesterday'] = null
  if (prev) {
    const rows: ScrumYesterdayRow[] = (input.file.days[prev]?.items ?? []).map(i => {
      const now = statusOf(input, i.key) || i.status_at_lock || ''
      return {
        key: i.key, title: i.summary, then: i.status_at_lock ?? '', now, column: columnOf(now),
        reason: i.reason ?? '', url: input.url(i.key), inToday: items.some(t => t.key === i.key),
      }
    })
    yesterday = { day: prev, label: label(prev), rows, delivered: rows.filter(r => r.column === 'delivered').length }
  }

  const addable = mine
    .filter(t => ['todo', 'doing'].includes(columnOf(statusOf(input, t.key) || t.status)) && !items.some(i => i.key === t.key))
    .sort((a, b) => num(a.key) - num(b.key))
    .map(t => ({ key: t.key, title: t.summary, status: statusOf(input, t.key) || t.status }))

  const blockers = input.questions.filter(q => q.status === 'waiting')
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
    .map(q => ({ text: `${q.to ? `${q.to.split(' ')[0]} · ` : ''}${q.topic}`, since: q.askedAt, url: q.url }))

  const settings = settingsOf(input.file)
  const queue = queueOf(input).map(k => ({ key: k, title: mine.find(t => t.key === k)?.summary ?? input.known.find(t => t.key === k)?.summary ?? '' }))
  const view: ScrumView = {
    day: input.day, saved: !!entry, lockedAt: entry?.locked_at ?? '', yesterday, today, addable, blockers, text: '',
    settings, queue,
    orderError: settings.rules.filter(r => r.on && (r.id === 'board' || r.id === 'custom'))
      .map(r => input.orderErrors?.[r.id] ? `${RULE_LABEL[r.id]}: ${input.orderErrors[r.id]}` : '').filter(Boolean).join(' · '),
  }
  view.text = scrumText(view)
  return view
}

const MARK: Record<ScrumColumn, string> = { delivered: '✅', doing: '🟡', todo: '🔴', other: '⚪' }

// The scrum in the log's shape: Done last, Today, Blockers, one bullet each.
export function scrumText(v: ScrumView): string {
  const lines: string[] = []
  if (v.yesterday) {
    lines.push(`Done last (${v.yesterday.label}): ${v.yesterday.delivered} of ${v.yesterday.rows.length} delivered`)
    for (const r of v.yesterday.rows) {
      lines.push(`- ${MARK[r.column]} ${r.key}: ${r.title} (${r.now || r.then})${r.reason ? `. ${r.reason}` : ''}`)
    }
    lines.push('')
  }
  lines.push(`Today (${label(v.day)})`)
  for (const r of v.today) lines.push(`- ${r.key}: ${r.title} (${r.status})${r.reason ? `. ${r.reason}` : ''}`)
  if (!v.today.length) lines.push('- Nothing planned yet.')
  lines.push('', 'Blockers')
  for (const b of v.blockers) lines.push(`- ${b.text}`)
  if (!v.blockers.length) lines.push('- No blockers.')
  return lines.join('\n')
}
