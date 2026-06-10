import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api, createRun, getRunDetail } from './helpers'

const app = createApp()

async function beginGate(runId: string, name = 'approve') {
  return api(app, 'POST', `/runs/${runId}/gates/begin`, {
    name,
    prompt: 'Approve this?',
    data: { amount: 100 }
  })
}

describe('gates (human approval)', () => {
  it('gate begin is idempotent by name within a run', async () => {
    const run = await createRun(app)
    const first = await beginGate(run.id)
    const second = await beginGate(run.id)
    expect(first.body.gate.id).toBe(second.body.gate.id)
    expect(second.body.action).toBe('wait')

    const detail = await getRunDetail(app, run.id)
    expect(detail.gates).toHaveLength(1)
  })

  it('concurrent first-begins of the same gate yield a single gate', async () => {
    const run = await createRun(app)
    const results = await Promise.all([
      beginGate(run.id, 'race'),
      beginGate(run.id, 'race'),
      beginGate(run.id, 'race')
    ])
    for (const result of results) {
      expect(result.status).toBe(200)
    }
    expect(new Set(results.map((result) => result.body.gate.id)).size).toBe(1)
  })

  it('resolution requires the resolve token', async () => {
    const run = await createRun(app)
    const gate = (await beginGate(run.id)).body.gate

    const forged = await api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
      token: 'not-the-token',
      decision: 'approved'
    })
    expect(forged.status).toBe(409)

    const real = await api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
      token: gate.resolveToken,
      decision: 'approved',
      actor: 'yao'
    })
    expect(real.status).toBe(200)
    expect(real.body.gate.status).toBe('approved')
    expect(real.body.gate.actor).toBe('yao')
  })

  it('a gate resolves exactly once — the second decision is rejected and the first stands', async () => {
    const run = await createRun(app)
    const gate = (await beginGate(run.id)).body.gate

    const approve = await api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
      token: gate.resolveToken,
      decision: 'approved'
    })
    expect(approve.status).toBe(200)

    const reject = await api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
      token: gate.resolveToken,
      decision: 'rejected'
    })
    expect(reject.status).toBe(409)

    const detail = await getRunDetail(app, run.id)
    expect(detail.gates[0].decision).toBe('approved')
  })

  it('concurrent conflicting decisions: exactly one wins', async () => {
    const run = await createRun(app)
    const gate = (await beginGate(run.id)).body.gate

    const [a, b] = await Promise.all([
      api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
        token: gate.resolveToken,
        decision: 'approved'
      }),
      api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
        token: gate.resolveToken,
        decision: 'rejected'
      })
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('begin after resolution returns the decision so resumed workflows do not block', async () => {
    const run = await createRun(app)
    const gate = (await beginGate(run.id)).body.gate
    await api(app, 'POST', `/runs/${run.id}/gates/${gate.id}/resolve`, {
      token: gate.resolveToken,
      decision: 'rejected'
    })

    const replay = await beginGate(run.id)
    expect(replay.body.action).toBe('return')
    expect(replay.body.gate.decision).toBe('rejected')
  })
})

describe('child runs (fan-out)', () => {
  it('child creation is idempotent by edge name, so resumed parents reuse children', async () => {
    const parent = await createRun(app, 'parent-workflow')
    const payload = { name: 'shard-1', workflowName: 'child-workflow', input: { shard: 1 } }

    const first = await api(app, 'POST', `/runs/${parent.id}/children`, payload)
    expect(first.body.created).toBe(true)

    const second = await api(app, 'POST', `/runs/${parent.id}/children`, payload)
    expect(second.body.created).toBe(false)
    expect(second.body.run.id).toBe(first.body.run.id)

    const detail = await getRunDetail(app, parent.id)
    expect(detail.childRuns).toHaveLength(1)
    expect(detail.runEdges).toHaveLength(1)
  })

  it('concurrent child creation with the same edge name yields a single child', async () => {
    const parent = await createRun(app, 'parent-workflow')
    const payload = { name: 'shard-x', workflowName: 'child-workflow' }
    const results = await Promise.all([
      api(app, 'POST', `/runs/${parent.id}/children`, payload),
      api(app, 'POST', `/runs/${parent.id}/children`, payload),
      api(app, 'POST', `/runs/${parent.id}/children`, payload)
    ])
    const ok = results.filter((result) => result.status === 200)
    const ids = new Set(ok.map((result) => result.body.run.id))
    expect(ids.size).toBe(1)

    const detail = await getRunDetail(app, parent.id)
    expect(detail.childRuns).toHaveLength(1)
  })

  it('children of a missing parent are rejected', async () => {
    const response = await api(app, 'POST', '/runs/run_doesnotexist/children', {
      name: 'orphan',
      workflowName: 'child-workflow'
    })
    expect(response.status).toBe(404)
  })

  it('child runs record their lineage in metadata and on the edge', async () => {
    const parent = await createRun(app, 'parent-workflow')
    const child = await api(app, 'POST', `/runs/${parent.id}/children`, {
      name: 'shard-2',
      workflowName: 'child-workflow',
      edgeType: 'fanout'
    })
    expect(child.body.run.metadata.parentRunId).toBe(parent.id)
    expect(child.body.edge.edgeType).toBe('fanout')
  })
})
