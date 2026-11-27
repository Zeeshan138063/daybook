export type Need = { text: string; action?: 'timesheet'; url?: string; linkLabel?: string }
export type Source = { name: string; ok: boolean; at: string }
export type TicketRow = {
  key: string; title: string; status: string
  tone: 'dev' | 'review' | 'qa' | 'other'
  start: string; due: string; today: string; url: string
}
export type PrRow = {
  pr: string; tickets: string; ticketsUrl: string; review: string; state: string
  tone: 'open' | 'attn' | 'done'; url: string
}
export type WeekDay = { day: string; label: string; minutes: number; isToday: boolean }
export type TicketTime = { id: string; key: string; url: string; title: string; minutes: number }
// One day's time, read from that day's file when a weekday is picked in the Time card.
export type DayTime = { day: string; label: string; logged: number; perTicket: TicketTime[]; missing: boolean }
// One row of the Settings card: a category, the tool the config names, and the last gather's result.
export type ProviderRow = {
  category: string; tool: string; via: string
  state: 'ok' | 'failing' | 'unknown' | 'off'; at: string
}
export type Area = 'backend' | 'frontend' | 'devops'
export type BoardRow = {
  key: string; title: string; status: string; area: Area
  assignee: string; mine: boolean; due: string; url: string
}
export type QuestionStatus = 'to_send' | 'waiting' | 'answered' | 'hidden'
export type QuestionRow = {
  id: string; topic: string; text: string; tickets: string[]; to: string
  status: QuestionStatus; askedAt: string; answer: string; answeredBy: string
  answeredAt: string; url: string
  ticketLinks: { key: string; url: string }[]
  composeUrl: string
  // answered or hidden by a panel button, so the panel offers Undo / Restore
  manual: boolean
}

// The Scrum card. A ticket's column comes from its Jira status: To Do, In Progress (In Development),
// Delivered (In Review or anything after it; Jira's own Done means deployed to production).
export type ScrumColumn = 'todo' | 'doing' | 'delivered' | 'other'
export type ScrumRow = {
  key: string; title: string; status: string; column: ScrumColumn; url: string
  // a PR in the day file names this ticket
  hasPr: boolean
  reason: string
  carried: boolean
  // why it is on today's list ("carried", "Next up #1", "High · due 27 Nov", "board order")
  why: string
  pickedBy: string
}
export type ScrumYesterdayRow = {
  key: string; title: string; then: string; now: string; column: ScrumColumn; reason: string; url: string
  // already on today's list
  inToday: boolean
}
export type ScrumView = {
  day: string
  // today's plan is in scrum.json (else it is the suggestion)
  saved: boolean
  lockedAt: string
  yesterday: { day: string; label: string; rows: ScrumYesterdayRow[]; delivered: number } | null
  today: ScrumRow[]
  addable: { key: string; title: string; status: string }[]
  blockers: { text: string; since: string; url: string }[]
  // Done last / Today / Blockers as bullets, for Copy scrum
  text: string
  // how today is picked, and the Next up list
  settings: ScrumSettings
  queue: { key: string; title: string }[]
  // a board-order or custom-search query that failed at the last gather
  orderError: string
}
export type ScrumRuleId = 'carry_over' | 'in_progress' | 'queue' | 'due_soon' | 'priority' | 'board' | 'custom'
export type ScrumSettings = {
  preset: 'urgent' | 'board' | 'priority' | 'queue_only' | 'custom'
  rules: { id: ScrumRuleId; on: boolean }[]
  due_days: number
  new_per_day: number
  custom_jql: string
}
// A Start or Done waiting for its Confirm: what the dry run says will change.
export type ScrumPending = {
  key: string; move: 'start' | 'done'; preview: string; error: string; noPr: boolean
}

// The PR tracker: my open pull requests and the ones merged lately, each with a status.
export type TrackerStatus = 'needs_fixes' | 'blocked' | 'back_for_review' | 'in_review' | 'approved' | 'draft' | 'merged'
export type TrackerRow = {
  repo: string; label: string; number: number; title: string; url: string
  tickets: { key: string; url: string }[]
  status: TrackerStatus; note: string; base: string
  // when it was opened (open ones) or merged (merged ones), ISO
  at: string
}
export type PrFilters = {
  show: 'open' | 'merged' | 'all'
  status: 'all' | TrackerStatus
  repo: string
  search: string
  days: 7 | 14 | 30
}

export type View = {
  day: string
  greeting: string
  dayLabel: string
  updated: string
  updatedIso: string
  sources: Source[]
  needs: Need[]
  loggedMinutes: number
  minMinutes: number
  maxMinutes: number
  perTicket: TicketTime[]
  week: WeekDay[]
  tickets: TicketRow[]
  prs: PrRow[]
  board: BoardRow[]
  questions: QuestionRow[]
  nextTicket: string
  // the action bar, from config.actions (empty by default)
  primary: ActionButton | null
  buttons: ActionButton[]
  // the command behind the "time short" need's button, or '' for none
  timeCommand: string
  nextTicketUrl: string
  chatName: string
  reviewer: string
  configPath: string
  providers: ProviderRow[]
  scrum: ScrumView
  // the PR tracker; null when the day file predates it (the old table shows instead)
  tracker: TrackerRow[] | null
  trackerError: string
  error?: string
}

// One line of the doctor's report (collectors/daybook_collect/doctor.py --json).
export type DoctorCheck = { area: string; ok: boolean; what: string; fix: string }
export type Doctor = { at: string; checks: DoctorCheck[]; error?: string }

export type ActionButton = { key: string; label: string; command: string; hint: string; hintUrl: string }

export type Filters = {
  area: 'all' | Area
  status: string
  search: string
  mineOnly: boolean
  showAll: boolean
  page: number
}

declare module 'claude-code' {
  interface PluginState {
    daybook: {
      view: Shaped<View | null>
      busy: Shaped<string | null>
      lastRun: Shaped<Record<string, string>>
      filters: Shaped<Filters>
      checking: Shaped<string | null>
      picked: Shaped<DayTime | null>
      folded: Shaped<Record<string, boolean>>
      doctor: Shaped<Doctor | null>
      scrumPending: Shaped<ScrumPending | null>
      scrumBusy: Shaped<string | null>
      scrumReason: Shaped<string | null>
      scrumMenu: Shaped<string | null>
      scrumAllBlockers: Shaped<boolean>
      scrumSettingsOpen: Shaped<boolean>
      scrumAdvancedOpen: Shaped<boolean>
      prFilters: Shaped<PrFilters>
    }
  }
}
