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
    }
  }
}
