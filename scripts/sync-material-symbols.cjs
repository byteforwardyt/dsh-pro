'use strict'
/** Pinned, offline SVG artwork. No webfonts, remote requests, DOM replacement or vendor edits at runtime. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const spec = require('./material-symbols-map.cjs')
const root = path.resolve(__dirname, '..')
const asset = path.join(root, 'plugins/client-ui-theme-holo/material-symbols.json')
const theme = path.join(root, 'plugins/client-ui-theme-holo/lib/client.js')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const quote = value => JSON.stringify(String(value))
const names = [...new Set([...Object.values(spec.native), ...Object.values(spec.views), ...Object.values(spec.settings), ...Object.values(spec.controls), ...spec.dictionaries.flatMap(row => Object.values(row[2])), ...spec.preview])].sort()

async function download() {
  const base = `https://raw.githubusercontent.com/google/material-design-icons/${spec.revision}`
  const icons = {}
  // Bounded downloads from one pinned upstream revision, never executing remote code.
  for (let start = 0; start < names.length; start += 6) await Promise.all(names.slice(start, start + 6).map(async name => {
    const response = await fetch(`${base}/symbols/web/${name}/materialsymbolsrounded/${name}_24px.svg`)
    if (!response.ok) throw Error(`${name}: HTTP ${response.status}`)
    const svg = (await response.text()).trim()
    if (!/^<svg [^>]+><path d="[^"]+"\/><\/svg>$/.test(svg)) throw Error(`Unexpected SVG structure: ${name}`)
    icons[name] = svg
  }))
  const license = await fetch(base + '/LICENSE')
  if (!license.ok) throw Error('Material Symbols license unavailable')
  const data = { source: 'https://fonts.google.com/icons', revision: spec.revision, style: 'Rounded', weight: 400, fill: 0, opticalSize: 24, license: await license.text(), icons: Object.fromEntries(names.map(name => [name, icons[name]])) }
  fs.writeFileSync(asset, JSON.stringify(data, null, 2) + '\n')
}

function nativeArtwork() {
  const modules = path.join(root, 'node_modules/.pnpm')
  const folder = fs.readdirSync(modules).find(name => name.startsWith('@deepseek-ai+dsh-client-ui-primitives@'))
  const source = fs.readFileSync(path.join(modules, folder, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const start = source.indexOf('//#region lib/types/icons/shared-artwork.js'), end = source.indexOf('//#region lib/types/StateDot.js')
  if (start < 0 || end < start) throw Error('Upstream icon boundary changed; review before updating')
  const section = source.slice(start, end)
  const exports = [...section.matchAll(/const (Icon\w+(?:Regular|Medium)) =/g)].map(match => match[1])
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  return vm.runInNewContext(section + '\n;({' + exports.join(',') + '})', { jsx, jsxs: jsx, useId: () => 'icon-test' }, { timeout: 1000 })
}

function geometry(node, prefix = '>') {
  const props = node.props || {}, attrs = ['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'x1', 'x2', 'y1', 'y2', 'points']
    .filter(key => props[key] != null).map(key => `[${key}=${quote(props[key])}]`).join('')
  // Exclude defs/masks and dynamic IDs. Drawing geometry must still match exactly.
  if (['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(node.type)) return [`:has(${prefix}${node.type}${attrs})`]
  if (node.type === 'g') return [props.children].flat().filter(Boolean).flatMap(child => geometry(child, prefix + 'g>'))
  return []
}

function generate(data) {
  if (data.revision !== spec.revision || names.some(name => !data.icons[name])) throw Error('Material asset cache is stale; run --download')
  const rules = [], matched = new Map(), native = nativeArtwork()
  const mask = name => `url("data:image/svg+xml,${encodeURIComponent(data.icons[name])}")`
  function rule(selector, name) {
    const previous = matched.get(selector)
    if (previous && previous !== name) throw Error(`Ambiguous icon selector: ${previous} vs ${name}`)
    if (previous) return
    matched.set(selector, name)
    const full = 'body[data-dshd-desktop] ' + selector
    rules.push(`${full}{background-color:currentColor;mask:${mask(name)} center/contain no-repeat;flex-shrink:0}`)
    rules.push(`${full}>*{visibility:hidden}`)
  }
  for (const [name, render] of Object.entries(native)) {
    const semantic = name.replace(/^Icon/, '').replace(/(?:Outline|Fill)?(?:Regular|Medium)$/, '')
    if (semantic === 'Loading') continue // live spinner geometry and animation are not decorative controls
    const symbol = spec.native[semantic]
    if (!symbol) throw Error(`Unmapped native UI icon ${name}`)
    const node = render({}), children = [node.props.children].flat().filter(Boolean)
    const parts = children.flatMap(child => geometry(child))
    if (!parts.length) throw Error(`No stable geometry for ${name}`)
    const selector = `svg[viewBox=${quote(node.props.viewBox)}]:has(>:nth-child(${children.length}):last-child)` + parts.join('')
    rule(selector, symbol)
  }
  for (const [plugin, constant, mapping] of spec.dictionaries) {
    const source = read(`plugins/${plugin}/lib/client.js`)
    const object = source.match(new RegExp(`const ${constant} = (\\{[\\s\\S]*?\\n    \\});`))?.[1]
    if (!object) throw Error(`Missing ${plugin}/${constant}`)
    const paths = vm.runInNewContext('(' + object + ')', {}, { timeout: 1000 })
    for (const [name, d] of Object.entries(paths)) {
      if (!mapping[name]) throw Error(`Unmapped owned icon ${plugin}/${name}`)
      rule(`svg[viewBox="0 0 24 24"]:has(>path[d=${quote(d)}])`, mapping[name])
    }
  }
  const preview = [...read('plugins/client-ui-preview/lib/client.js').matchAll(/h\(Icon, \{ d: "([^"]+)"/g)]
  if (preview.length !== spec.preview.length) throw Error('Preview icons changed; review mapping')
  preview.forEach((match, i) => rule(`.dshd-pv svg:has(>path[d=${quote(match[1])}])`, spec.preview[i]))
  for (const [selector, symbol] of Object.entries(spec.controls)) rule(selector, symbol)
  for (const [id, symbol] of Object.entries(spec.settings)) rules.push(`body[data-dshd-desktop] [data-dshd-nav=${quote(id)}]{--dshd-nav-icon:${mask(symbol)}}`)
  rules.push('body[data-dshd-desktop] .sc-send>span{display:block;width:20px;height:20px;font-size:0}')
  return { css: rules.join('\n'), views: Object.fromEntries(Object.entries(spec.views).map(([id, name]) => [id, data.icons[name]])), count: matched.size }
}

async function main() {
  if (process.argv.includes('--download')) await download()
  const data = JSON.parse(fs.readFileSync(asset, 'utf8')), generated = generate(data)
  const begin = '    // BEGIN GENERATED Material Symbols', end = '    // END GENERATED Material Symbols'
  const source = fs.readFileSync(theme, 'utf8'), a = source.indexOf(begin), b = source.indexOf(end)
  if (a < 0 || b < a) throw Error('Missing generated icon region')
  const block = `${begin}\n    // Google Material Symbols Rounded, Apache-2.0; scripts/sync-material-symbols.cjs.\n    const MATERIAL_CSS = ${JSON.stringify(generated.css)};\n    const VIEW_ICONS = ${JSON.stringify(generated.views, null, 2)};\n${end}`
  const next = source.slice(0, a) + block + source.slice(b + end.length)
  if (process.argv.includes('--check')) {
    if (source !== next) throw Error('Material icon mappings are stale; run node scripts/sync-material-symbols.cjs')
  } else fs.writeFileSync(theme, next)
  console.log(`Material Symbols: ${names.length} bundled icons; ${generated.count} native/owned mappings verified.`)
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { generate, nativeArtwork, names }
