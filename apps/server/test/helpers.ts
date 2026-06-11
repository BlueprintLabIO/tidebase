import type { Hono } from 'hono'

export type JsonResponse = { status: number; body: any }

export async function api(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse> {
  const response = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

export async function createRun(
  app: Hono,
  workflowName = 'test-workflow',
  payload: Record<string, unknown> = {}
) {
  const { status, body } = await api(app, 'POST', `/runs/${workflowName}`, payload)
  if (status !== 200) throw new Error(`failed to create run: ${status}`)
  return body.run as { id: string; status: string }
}

export async function getRunDetail(app: Hono, runId: string) {
  const { body } = await api(app, 'GET', `/runs/${runId}`)
  return body
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
