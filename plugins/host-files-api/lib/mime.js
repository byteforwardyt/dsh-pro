/**
 * Content types for the byte route.
 *
 * The harness's own static server carries a seven-entry table with no image,
 * audio, video or PDF types in it, because it only ever serves the frontend
 * bundle. A Files view has to name the type correctly or the browser will not
 * play the file: an `<audio>` element handed `application/octet-stream` fails
 * silently rather than sniffing.
 */

const TYPES = {
  // Text the viewer may render inline.
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  html: 'text/html; charset=utf-8',
  // .htm is the same as .html — the preview picker already advertises both
  // (/\.html?$/), and without this entry a .htm page served as octet-stream
  // never renders.
  htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',

  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',

  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',

  pdf: 'application/pdf',

  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/**
 * @returns the content type for a filename, defaulting to octet-stream.
 *
 * HTML is deliberately NOT served as `text/html` from the byte route — see the
 * `X-Content-Type-Options` note in `raw.js`. This table is consulted for the
 * declared type; the route decides whether to downgrade it.
 */
export function contentTypeFor (name) {
  const lower = String(name || '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  return TYPES[lower.slice(dot + 1)] ?? 'application/octet-stream'
}

/** Types the browser can be trusted to render in a frame or a media element. */
export function isRenderable (type) {
  return type.startsWith('image/') || type.startsWith('audio/') ||
    type.startsWith('video/') || type === 'application/pdf'
}
