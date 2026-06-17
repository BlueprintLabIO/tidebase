/**
 * Grant policy engine — the "what may this agent do right now" decision point.
 *
 * Design posture: DEFAULT-DENY-ish. An unrecognized action is NEVER silently
 * brokered as an active credential; it falls through to human approval. Explicit
 * deny rules hard-stop, sensitive rules force a human gate + proxy mode, and only
 * recognized low-risk actions are auto-activated.
 *
 * Pure and synchronous so it can be exhaustively unit-tested and fuzzed without a
 * database. The grant handler snapshots the returned decision into grants.policy_json
 * for replay/audit.
 */

export type PolicyEffect = 'allow' | 'approval' | 'deny'
export type GrantMode = 'proxy' | 'mint'

export type PolicyInput = {
  action: string
  resource: string
  requestedScopes: string[]
  mode: GrantMode
}

export type PolicyRule = {
  id: string
  /** Tested against the action string. */
  match: RegExp
  effect: PolicyEffect
  /** Force proxy mode (secret never leaves the boundary) regardless of request. */
  forceProxy?: boolean
}

export type PolicyConfig = {
  rules: PolicyRule[]
  /** Effect when no rule matches. Must not be 'allow' — never silently broker. */
  defaultEffect: Exclude<PolicyEffect, 'allow'>
}

export type PolicyDecision = {
  effect: PolicyEffect
  mode: GrantMode
  requiresApproval: boolean
  forcedProxy: boolean
  matchedRule: string
  reason: string
}

// Evaluated top-to-bottom; first match wins, so order is significant: hard denies
// first, then sensitive→approval, then recognized→allow.
export const DEFAULT_POLICY: PolicyConfig = {
  rules: [
    {
      id: 'deny-destructive',
      match: /\b(destroy|wipe|purge|drop[-_]?database|truncate|force[-_]?push)\b/i,
      effect: 'deny'
    },
    {
      id: 'approval-sensitive',
      match: /\b(delete|remove|transfer|payment|charge|refund|deploy|admin|secret|token|grant|rotate|impersonate|billing)\b/i,
      effect: 'approval',
      forceProxy: true
    },
    {
      id: 'allow-standard',
      match: /\.(read|list|get|search|create|open|comment|update|write|label|assign)\b/i,
      effect: 'allow'
    }
  ],
  defaultEffect: 'approval'
}

export function evaluatePolicy(input: PolicyInput, policy: PolicyConfig = DEFAULT_POLICY): PolicyDecision {
  for (const rule of policy.rules) {
    if (rule.match.test(input.action)) {
      return decide(rule.effect, rule.forceProxy ?? false, input.mode, rule.id, `matched rule ${rule.id}`)
    }
  }
  // No rule matched: never auto-allow. Default to approval (or deny) and force proxy.
  return decide(policy.defaultEffect, true, input.mode, 'default', 'no rule matched; default posture applied')
}

function decide(
  effect: PolicyEffect,
  forceProxy: boolean,
  requestedMode: GrantMode,
  matchedRule: string,
  reason: string
): PolicyDecision {
  const mode: GrantMode = forceProxy ? 'proxy' : requestedMode
  return {
    effect,
    mode,
    requiresApproval: effect === 'approval',
    forcedProxy: forceProxy && requestedMode === 'mint',
    matchedRule,
    reason
  }
}

/**
 * Constrains a proxied HTTP call to the granted action's verb class, so a grant
 * for `*.read` cannot be replayed as a DELETE. Provider-specific path binding
 * (e.g. restricting to the resource's object) is a deliberate follow-up handled
 * by the resource provider seam; this is the provider-agnostic floor.
 */
export function callMatchesAction(action: string, method: string): { ok: boolean; reason?: string } {
  const verb = (action.split('.').pop() ?? '').toLowerCase()
  const m = method.toUpperCase()
  const allowed: Record<string, string[]> = {
    read: ['GET', 'HEAD'],
    list: ['GET', 'HEAD'],
    get: ['GET', 'HEAD'],
    search: ['GET', 'HEAD'],
    create: ['POST', 'PUT'],
    open: ['POST', 'PUT'],
    write: ['POST', 'PUT', 'PATCH'],
    update: ['PUT', 'PATCH', 'POST'],
    delete: ['DELETE'],
    remove: ['DELETE']
  }
  const methods = allowed[verb]
  if (!methods) return { ok: true } // unknown verb: method not constrained (approval/scope still apply)
  if (!methods.includes(m)) {
    return { ok: false, reason: `action '${action}' does not permit ${m} (expected ${methods.join('/')})` }
  }
  return { ok: true }
}
