/** Provider-owned discovery endpoints. Never send account tokens to a catalog mirror. */
export const MODEL_SOURCES = {
  xai: { name: 'Grok', url: 'https://api.x.ai/v1/language-models', api: 'openai-responses' },
  // Catalog-only sentinel used by OpenAI's own rust-release-prepare workflow.
  // Avoid freezing discovery to an old CLI version; inference is unchanged.
  'openai-codex': { name: 'ChatGPT', url: 'https://chatgpt.com/backend-api/codex/models?client_version=99.99.99', api: 'openai-codex-responses' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/models', api: 'openai-completions' },
  'kimi-coding': { name: 'Kimi', url: 'https://api.kimi.com/coding/v1/models', api: 'anthropic-messages' },
}

// xAI's language-models response omits context/reasoning limits. This supplement
// supplies documented capabilities ONLY if the account endpoint returns the id.
// https://docs.x.ai/developers/model-capabilities/text/reasoning
// (verified 2026-09-23). Only supplement ids returned by the account endpoint.
const XAI_CAPABILITIES = {
  'grok-4.6': { name: 'Grok 4.6', contextWindow: 500000, maxTokens: 500000,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } },
  'grok-4.7': { name: 'Grok 4.7', contextWindow: 500000, maxTokens: 500000,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } },
}
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const modalities = value => Array.isArray(value) ? [...new Set(value.filter(x => x === 'text' || x === 'image'))] : undefined

/** Convert data, never remote instructions or executable code, to the host schema. */
export function normalizeModels(provider, payload, bundled = []) {
  const rows = provider === 'xai' || provider === 'openai-codex' ? payload?.models : payload?.data
  if (!Array.isArray(rows) || rows.length > 20000) throw new Error('Invalid model catalog')
  const defaults = new Map(bundled.map(model => [model.id, model]))
  const result = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = provider === 'openai-codex' ? row.slug : row.id
    if (!validId(id) || result.has(id)) continue
    if (provider === 'openai-codex' && row.visibility !== 'list') continue
    if (provider === 'openrouter' && (!row.architecture?.output_modalities?.includes('text') || !row.supported_parameters?.includes('tools'))) continue
    if (provider === 'xai' && !row.output_modalities?.includes('text')) continue
    const base = defaults.get(id)
    const supplement = provider === 'xai' ? XAI_CAPABILITIES[id] : undefined
    let input, context, output, reasoning
    if (provider === 'xai') {
      input = modalities(row.input_modalities)
      context = positive(row.context_window) || positive(row.context_length)
      output = positive(row.max_output_tokens)
    } else if (provider === 'openrouter') {
      input = modalities(row.architecture.input_modalities)
      context = positive(row.context_length)
      output = positive(row.top_provider?.max_completion_tokens)
      reasoning = row.supported_parameters.includes('reasoning')
        ? { off: null, low: 'low', medium: 'medium', high: 'high' } : false
    } else if (provider === 'kimi-coding') {
      input = ['text', ...(row.supports_image_in === true ? ['image'] : [])]
      context = positive(row.context_length)
      output = positive(row.max_output_tokens)
      reasoning = row.supports_reasoning === true ? { low: 'low', medium: 'medium', high: 'high' } : false
    } else {
      input = modalities(row.input_modalities) || ['text']
      context = positive(row.context_window)
      output = positive(row.max_output_tokens)
      const offered = Array.isArray(row.supported_reasoning_levels)
        ? row.supported_reasoning_levels.map(item => item?.effort).filter(level => levels.has(level)) : []
      reasoning = offered.length ? Object.fromEntries(offered.map(level => [level, level === 'off' ? null : level])) : false
    }
    // Unknown capacities use the same conservative floor as a manually added
    // model. Do not copy another model's limits because its name looks similar.
    const contextWindow = context || supplement?.contextWindow || base?.contextWindow || 8192
    const maxTokens = Math.min(output || supplement?.maxTokens || base?.maxTokens || 4096, contextWindow)
    const name = row.display_name || row.name || supplement?.name || base?.name || id
    const model = {
      id, name: typeof name === 'string' && name.length <= 200 ? name : id,
      contextWindow, maxTokens, input: input?.length ? input : base?.input || ['text'],
    }
    const efforts = reasoning ?? supplement?.reasoningEfforts
    if (efforts !== undefined) model.reasoningEfforts = efforts
    else if (!base) model.reasoningEfforts = false
    // A known model keeps catalog protocol quirks. New models use provider
    // protocol defaults; arbitrary compat values from remote JSON are ignored.
    result.set(id, model)
  }
  if (!result.size) throw new Error('No compatible chat models returned')
  return [...result.values()]
}

/** Bounded body + deadline cover headers AND streaming JSON. No auth redirects. */
export async function fetchModelCatalog(provider, auth, signal, bundled) {
  const source = MODEL_SOURCES[provider]
  const headers = { Accept: 'application/json', Authorization: `Bearer ${auth.apiKey}` }
  if (provider === 'openai-codex') {
    headers.originator = 'codex_cli_rs'
    // The account header is account metadata, never copied from remote input.
    if (auth.headers?.['ChatGPT-Account-Id']) headers['ChatGPT-Account-Id'] = auth.headers['ChatGPT-Account-Id']
  }
  const response = await fetch(source.url, { headers, redirect: 'error', signal })
  if (!response.ok) throw new Error(`Model service returned HTTP ${response.status}`)
  const reader = response.body.getReader()
  let bytes = 0
  const chunks = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8 * 1024 * 1024) throw new Error('Model catalog is too large')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  signal.throwIfAborted()
  return normalizeModels(provider, JSON.parse(Buffer.concat(chunks).toString('utf8')), bundled)
}
