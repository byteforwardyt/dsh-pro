/** Read explicitly saved configuration locally; never expose it over HTTP.
 * The 0.2 settings service owns forms, while ConfigEditor owns raw overrides.
 * Ownership checks must not use redacted forms or schema-injected defaults.
 */
export function settingsAccess(ctx) {
  const settings = ctx.get('settings')
  if (!settings) return undefined
  const editor = ctx.get('configEditor')
  if (!editor) throw new Error('DSH settings require the profile configuration editor')
  return {
    describe: options => settings.describe(options),
    mutate: (...args) => settings.mutate(...args),
    section: ns => editor.configuration().find(row => row.entry.options.id === ns)?.override,
  }
}

export const settingsNamespace = value => value
