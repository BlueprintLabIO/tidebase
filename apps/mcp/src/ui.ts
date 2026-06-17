import { createUIResource } from '@mcp-ui/server'
import { GUEST_BUNDLE } from './guestBundle.generated.js'

export const STUDIO_URI = 'ui://tidebase/studio'

/**
 * The Tidebase Studio ui:// resource. The HTML is a minimal shell hosting the
 * bundled guest MCP-App (guest/studio-app.ts → esbuild IIFE). At runtime the
 * guest speaks the MCP-Apps protocol to the host over postMessage; it does not
 * fetch anything itself, so a strict sandbox CSP is fine.
 */
const SAFE_BUNDLE = GUEST_BUNDLE.replace(/<\/script>/gi, '<\\/script>')
const STUDIO_HTML = `<!doctype html><html><head><meta charset="utf-8" /></head><body><script>${SAFE_BUNDLE}</script></body></html>`

export function studioResource() {
  return createUIResource({
    uri: STUDIO_URI,
    content: { type: 'rawHtml', htmlString: STUDIO_HTML },
    encoding: 'text'
  })
}
