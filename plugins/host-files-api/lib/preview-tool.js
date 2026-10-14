/**
 * `preview_open` — let the agent put what it just built in front of the user.
 *
 * The agent already writes the page and starts the dev server; until now the
 * user still had to find it themselves, and the Preview tab's own scan was the
 * only thing connecting the two. This closes that gap: the agent names a target
 * and the pane goes there.
 *
 * Two fences, both mandatory and both here rather than in the client, because
 * the client is the thing being driven:
 *
 *   - scheme — only http and https. A file:// or data: target rendered in the
 *     preview surface is a way to get local bytes or attacker-authored markup
 *     onto a privileged origin, and the pane's own protections assume a real
 *     remote page.
 *   - containment — a workspace path is run through the same realpath fence the
 *     file routes use, so a symlink or a `..` cannot reach outside the folders
 *     the user opened.
 *
 * The return value is deliberately honest about reach. Publishing an intent is
 * not the same as a page rendering, so the tool reports whether a pane was
 * actually listening instead of claiming the user can see it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { containedPath } from './roots.js'

/** Anything else is refused before it can reach the preview surface. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function previewTool (ctx, intents) {
  return defineTool({
    name: 'preview_open',
    description:
      'Show a page in the user\'s Preview tab. Give either an http(s) address — typically a dev '
      + 'server you just started — or the absolute path of a standalone HTML file inside an open workspace. '
      + 'Use this after building or serving something so the user can see it without hunting for '
      + 'the URL. Reports whether the Preview pane was open to receive it.',
    parameters: {
      url: {
        type: 'string',
        description: 'An http:// or https:// address to open. Use this for a running dev server.',
      },
      path: {
        type: 'string',
        description:
          'Absolute path of an .html file inside an open workspace, for a page with no server. '
          + 'Ignored when url is given.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target: { type: 'string' },
          kind: { type: 'string' },
          visible: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Could not open the preview: ${value.error}` }]
        return [{
          type: 'text',
          text: value.visible
            ? `Preview navigation requested for ${value.target}. This does not verify that the page rendered successfully.`
            : `Preview is set to ${value.target}. The user has not opened the Preview tab yet, so tell them where to look.`,
        }]
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute (args, exec) {
      const sessionId = exec?.agent?.session?.header?.id || ''
      const raw = typeof args?.url === 'string' ? args.url.trim() : ''
      if (raw) {
        let parsed
        try { parsed = new URL(raw) } catch { return { ok: false, error: `"${raw}" is not a valid address` } }
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
          return { ok: false, error: `only http and https can be previewed, not "${parsed.protocol}"` }
        }
        const published = intents.publish({ kind: 'url', url: parsed.href, sessionId })
        if (!published) return { ok: false, error: 'the preview service is shutting down' }
        return { ok: true, kind: 'url', target: parsed.href, visible: published.readers > 0 }
      }

      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      if (!requested) return { ok: false, error: 'give either a url or a path' }
      const contained = await containedPath(ctx, requested)
      if (!contained) return { ok: false, error: 'that path is outside every open workspace' }
      if (!/\.html?$/i.test(contained.path)) {
        return { ok: false, error: 'only .html files can be opened directly; start a dev server for anything else' }
      }
      if (/^index\.html?$/i.test(basename(contained.path))) {
        try {
          await access(join(dirname(contained.path), 'package.json'))
          return { ok: false, error: 'this game index.html belongs to a package project; start its dev server and pass the local URL instead' }
        } catch { /* Standalone HTML can use the static preview server. */ }
      }
      const published = intents.publish({ kind: 'file', path: contained.path, sessionId })
      if (!published) return { ok: false, error: 'the preview service is shutting down' }
      return { ok: true, kind: 'file', target: contained.path, visible: published.readers > 0 }
    },
  })
}
