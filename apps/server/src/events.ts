import type pg from 'pg'
import { pool } from './db.js'

type Listener = (event: TideEvent) => void

export type TideEvent = {
  id: number
  runId: string
  seq: number
  type: string
  payload: unknown
  createdAt: string
}

const listeners = new Map<string, Set<Listener>>()

export function subscribe(runId: string, listener: Listener) {
  const set = listeners.get(runId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(runId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(runId)
  }
}

export async function appendEvent(
  client: pg.PoolClient,
  runId: string,
  type: string,
  payload: unknown
) {
  // Serialize event writers per run: max(seq) + 1 is computed per transaction, so
  // concurrent writers would otherwise collide on unique(run_id, seq).
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [runId])
  const seqResult = await client.query<{ next_seq: string }>(
    'select coalesce(max(seq), 0) + 1 as next_seq from events where run_id = $1',
    [runId]
  )
  const seq = Number(seqResult.rows[0]?.next_seq ?? 1)
  const result = await client.query<{
    id: string
    run_id: string
    seq: string
    type: string
    payload_json: unknown
    created_at: Date
  }>(
    `insert into events (run_id, seq, type, payload_json)
     values ($1, $2, $3, $4)
     returning id, run_id, seq, type, payload_json, created_at`,
    [runId, seq, type, JSON.stringify(payload ?? {})]
  )
  const event = mapEvent(result.rows[0])
  queueMicrotask(() => {
    listeners.get(runId)?.forEach((listener) => listener(event))
  })
  return event
}

export async function listEvents(runId: string, afterSeq = 0, target: pg.Pool = pool) {
  const result = await target.query(
    `select id, run_id, seq, type, payload_json, created_at
     from events
     where run_id = $1 and seq > $2
     order by seq asc`,
    [runId, afterSeq]
  )
  return result.rows.map(mapEvent)
}

function mapEvent(row: {
  id: string
  run_id: string
  seq: string
  type: string
  payload_json: unknown
  created_at: Date
}): TideEvent {
  return {
    id: Number(row.id),
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload_json,
    createdAt: row.created_at.toISOString()
  }
}
