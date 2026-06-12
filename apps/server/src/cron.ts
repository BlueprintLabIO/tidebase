// Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC.
// Supports: * , - / and 0-7 for day-of-week (both 0 and 7 are Sunday).
// Standard union semantics: when both DOM and DOW are restricted, a time
// matches if either matches.

export type CronSpec = {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }
]

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`invalid cron "${expression}": expected 5 fields, got ${parts.length}`)
  }
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]))
  const dow = sets[4]
  if (dow.has(7)) dow.add(0) // 7 == Sunday == 0
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*'
  }
}

function parseField(part: string, field: { name: string; min: number; max: number }) {
  const values = new Set<number>()
  for (const term of part.split(',')) {
    const [rangePart, stepPart] = term.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step "${term}" in ${field.name}`)
    }
    let lo: number
    let hi: number
    if (rangePart === '*' || rangePart === '') {
      lo = field.min
      hi = field.max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      lo = a
      hi = b
    } else {
      lo = Number(rangePart)
      hi = stepPart === undefined ? lo : field.max
    }
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < field.min ||
      hi > field.max ||
      lo > hi
    ) {
      throw new Error(`invalid cron value "${term}" in ${field.name} (${field.min}-${field.max})`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) throw new Error(`empty cron field "${part}" in ${field.name}`)
  return values
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getUTCMinutes())) return false
  if (!spec.hour.has(date.getUTCHours())) return false
  if (!spec.month.has(date.getUTCMonth() + 1)) return false
  const domOk = spec.dom.has(date.getUTCDate())
  const dowOk = spec.dow.has(date.getUTCDay())
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

/** Next fire time strictly after `from` (UTC). */
export function nextFire(expression: string | CronSpec, from: Date): Date {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression
  const cursor = new Date(from)
  cursor.setUTCSeconds(0, 0)
  // up to five years of minutes; any valid spec fires within that window
  const limit = 5 * 366 * 24 * 60
  for (let i = 0; i < limit; i += 1) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
    if (matches(spec, cursor)) return new Date(cursor)
  }
  throw new Error(`cron "${typeof expression === 'string' ? expression : ''}" never fires`)
}
