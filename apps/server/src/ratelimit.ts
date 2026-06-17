/**
 * Multi-replica abuse controls backed by Postgres (shared across replicas), so a
 * rate limit or a challenge-replay check holds regardless of which instance the
 * request lands on. Replaces the earlier per-process maps.
 */
import { pool } from './db.js'

/**
 * Fixed-window rate limit. Atomic upsert: increment within the current window,
 * reset at a window boundary. Returns true if the request is within the limit.
 */
export async function rateLimitPg(
  bucket: string,
  limit: number,
  windowMs: number,
  now: Date = new Date()
): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
  const res = await pool.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count)
     values ($1, $2, 1)
     on conflict (bucket) do update set
       count = case when rate_limits.window_start = excluded.window_start
                    then rate_limits.count + 1 else 1 end,
       window_start = excluded.window_start
     returning count`,
    [bucket, windowStart]
  )
  return Number(res.rows[0].count) <= limit
}

/**
 * Single-use guard for keypair challenges. Inserts the challenge hash; a conflict
 * means it was already consumed (a replay). Returns true on first use.
 */
export async function consumeChallengePg(challengeHash: string, expiresAt: Date): Promise<boolean> {
  const res = await pool.query(
    `insert into consumed_challenges (challenge_hash, expires_at)
     values ($1, $2)
     on conflict (challenge_hash) do nothing
     returning challenge_hash`,
    [challengeHash, expiresAt]
  )
  return res.rows.length > 0
}

/** Reconciler housekeeping: drop stale limiter windows and expired challenges. */
export async function sweepAbuseStores(now: Date = new Date()): Promise<void> {
  await pool.query('delete from consumed_challenges where expires_at < $1', [now])
  // Limiter rows older than a generous multiple of any window are dead weight.
  await pool.query(`delete from rate_limits where window_start < $1`, [new Date(now.getTime() - 3_600_000)])
}
