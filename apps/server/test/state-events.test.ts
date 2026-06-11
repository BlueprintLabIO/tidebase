import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api, createRun, getRunDetail } from './helpers'

const app = createApp()

describe('run state versioning', () => {
  it('PUT replaces state, PATCH merges, and the version counter is monotonic', async () => {
    const run = await createRun(app)

    const put = await api(app, 'PUT', `/runs/${run.id}/state`, { value: { phase: 'draft', n: 1 } })
    expect(put.body.state.version).toBe(1)

    const patch = await api(app, 'PATCH', `/runs/${run.id}/state`, { value: { n: 2 } })
    expect(patch.body.state.version).toBe(2)
    expect(patch.body.state.value).toEqual({ phase: 'draft', n: 2 })

    const replace = await api(app, 'PUT', `/runs/${run.id}/state`, { value: { phase: 'final' } })
    expect(replace.body.state.version).toBe(3)
    expect(replace.body.state.value).toEqual({ phase: 'final' })
  })

  it('every state write records a gap-free version history in its stream', async () => {
    const run = await createRun(app)
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 1 } })
    await api(app, 'PATCH', `/runs/${run.id}/state`, { value: { n: 2 } })
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 3 } })

    const versions = await api(app, 'GET', `/runs/${run.id}/state/versions?stream=run`)
    expect(versions.body.stateVersions.map((v: any) => v.version)).toEqual([1, 2, 3])
    expect(versions.body.stateVersions.at(-1).value).toEqual({ n: 3 })
  })

  it('save() labels the current value as a milestone without changing it', async () => {
    const run = await createRun(app)
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 7 } })

    const saved = await api(app, 'POST', `/runs/${run.id}/state/save`, { label: 'pre-publish' })
    expect(saved.status).toBe(200)
    expect(saved.body.stateVersion.label).toBe('pre-publish')
    expect(saved.body.stateVersion.importance).toBe('milestone')
    expect(saved.body.stateVersion.value).toEqual({ n: 7 })

    const labeled = await api(app, 'GET', `/runs/${run.id}/state/versions?labeled=true`)
    expect(labeled.body.stateVersions).toHaveLength(1)
  })

  it('saving state for a run with no state yet returns 404', async () => {
    const run = await createRun(app)
    const saved = await api(app, 'POST', `/runs/${run.id}/state/save`, { label: 'nothing' })
    expect(saved.status).toBe(404)
  })

  it('snapshots only list labeled versions', async () => {
    const run = await createRun(app)
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 1 } })
    await api(app, 'POST', `/runs/${run.id}/snapshots`, {
      label: 'reviewed',
      state: { doc: 'v1' }
    })

    const snapshots = await api(app, 'GET', `/runs/${run.id}/snapshots`)
    expect(snapshots.body.snapshots).toHaveLength(1)
    expect(snapshots.body.snapshots[0].label).toBe('reviewed')
    expect(snapshots.body.snapshots[0].value).toEqual({ doc: 'v1' })
  })
})

describe('event log integrity', () => {
  it('a run lifecycle produces a strictly ordered, gap-free event log', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`, undefined, { 'x-tidebase-worker': 'w1' })
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 1 } })
    const begin = await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 's1',
      inputHash: 'h1',
      leaseOwner: 'w1'
    })
    await api(app, 'POST', `/runs/${run.id}/steps/${begin.body.step.id}/complete`, {
      leaseOwner: 'w1',
      output: 'done'
    })
    await api(app, 'POST', `/runs/${run.id}/complete`, { result: 'done' })

    const detail = await getRunDetail(app, run.id)
    const seqs = detail.events.map((event: any) => event.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
    expect(detail.events.map((event: any) => event.type)).toEqual([
      'run.created',
      'run.started',
      'state.updated',
      'step.started',
      'step.completed',
      'run.completed'
    ])
  })

  it('concurrent writers across endpoints never drop or duplicate event sequence numbers', async () => {
    const run = await createRun(app)
    const writes = [
      ...[1, 2, 3, 4].map((n) =>
        api(app, 'PUT', `/runs/${run.id}/state`, { value: { n } })
      ),
      ...[1, 2, 3, 4].map((n) =>
        api(app, 'POST', `/runs/${run.id}/usage`, { kind: 'llm', inputTokens: n, outputTokens: n })
      )
    ]
    const results = await Promise.all(writes)
    for (const result of results) {
      expect(result.status).toBe(200)
    }

    const detail = await getRunDetail(app, run.id)
    const seqs = detail.events.map((event: any) => event.seq)
    // run.created + 8 writes, contiguous from 1 with no duplicates.
    expect(seqs).toEqual(Array.from({ length: 9 }, (_, i) => i + 1))
  })
})

describe('usage records', () => {
  it('derives totalTokens from input + output when not supplied', async () => {
    const run = await createRun(app)
    const usage = await api(app, 'POST', `/runs/${run.id}/usage`, {
      kind: 'llm',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50
    })
    expect(usage.body.usage.totalTokens).toBe(150)

    const explicit = await api(app, 'POST', `/runs/${run.id}/usage`, {
      kind: 'llm',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 999
    })
    expect(explicit.body.usage.totalTokens).toBe(999)
  })

  it('rejects negative token counts with a 400', async () => {
    const run = await createRun(app)
    const response = await api(app, 'POST', `/runs/${run.id}/usage`, { inputTokens: -5 })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid request body')
  })
})
