import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, callMatchesAction, evaluatePolicy } from '../src/policy'

const base = { resource: 'github:repo:acme/app', requestedScopes: [] as string[], mode: 'proxy' as const }

describe('policy engine — default-deny posture', () => {
  it('auto-allows recognized low-risk actions', () => {
    const d = evaluatePolicy({ ...base, action: 'pull_request.create' })
    expect(d.effect).toBe('allow')
    expect(d.requiresApproval).toBe(false)
  })

  it('routes sensitive actions through approval and forces proxy', () => {
    for (const action of ['deploy.delete', 'billing.charge', 'secret.read', 'iam.admin']) {
      const d = evaluatePolicy({ ...base, action, mode: 'mint' })
      expect(d.effect, action).toBe('approval')
      expect(d.requiresApproval, action).toBe(true)
      expect(d.mode, action).toBe('proxy') // forced even though mint requested
      expect(d.forcedProxy, action).toBe(true)
    }
  })

  it('hard-denies destructive actions', () => {
    for (const action of ['db.destroy', 'repo.force_push', 'table.truncate']) {
      expect(evaluatePolicy({ ...base, action }).effect, action).toBe('deny')
    }
  })

  it('never silently allows an unrecognized action (default to approval)', () => {
    const d = evaluatePolicy({ ...base, action: 'some.weird_unknown_verb' })
    expect(d.effect).toBe('approval')
    expect(d.effect).not.toBe('allow')
    expect(d.matchedRule).toBe('default')
  })

  it('default posture is never allow (config invariant)', () => {
    expect(DEFAULT_POLICY.defaultEffect).not.toBe('allow')
  })

  // Lightweight fuzz: random action strings must always resolve to a valid,
  // never-silently-allowed-by-default effect.
  it('always returns a valid effect for arbitrary input', () => {
    const fragments = ['delete', 'read', 'foo', 'charge', 'create', 'x', 'destroy', '', '.', 'admin.x']
    for (let i = 0; i < 200; i++) {
      const action = Array.from({ length: (i % 4) + 1 }, (_, j) => fragments[(i + j) % fragments.length]).join('.')
      const d = evaluatePolicy({ ...base, action })
      expect(['allow', 'approval', 'deny']).toContain(d.effect)
      if (d.matchedRule === 'default') expect(d.effect).not.toBe('allow')
    }
  })
})

describe('callMatchesAction — proxied call is bound to the action verb', () => {
  it('permits the matching method', () => {
    expect(callMatchesAction('pull_request.create', 'POST').ok).toBe(true)
    expect(callMatchesAction('repo.read', 'GET').ok).toBe(true)
    expect(callMatchesAction('deploy.delete', 'DELETE').ok).toBe(true)
  })

  it('rejects a method outside the verb class (read grant cannot DELETE)', () => {
    expect(callMatchesAction('repo.read', 'DELETE').ok).toBe(false)
    expect(callMatchesAction('issue.list', 'POST').ok).toBe(false)
  })

  it('does not over-constrain unknown verbs', () => {
    expect(callMatchesAction('custom.frobnicate', 'POST').ok).toBe(true)
  })
})
