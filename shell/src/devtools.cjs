'use strict'
/**
 * Development-only inspection helpers, gated on DSH_DESKTOP_CAPTURE.
 *
 * Wrapping someone else's web UI means our window chrome has to fit a layout we
 * do not control. Guessing at selectors and pixel offsets is slow and wrong;
 * capturing the real render and dumping the real DOM is fast and right.
 * None of this runs unless the env var is set.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * Is this a build where the automation surface may run at all?
 *
 * Fails closed. `require('electron')` throws outside the main process, and a
 * build we cannot identify is treated as packaged, so the only way to get a
 * true here is to be demonstrably running from source.
 */
function unpackaged () {
  try { return require('electron').app.isPackaged === false } catch { return false }
}

/**
 * The env var alone used to be the whole gate, which made this a remote-control
 * surface on every shipped copy: anything that could launch the app with the
 * variable set could then screenshot the window to a directory of its choosing,
 * dump the DOM, and click controls by their visible text — including the
 * provider sign-in buttons. Nothing about that is needed in a shipped build,
 * where the only user of these helpers is a developer running from source.
 */
const enabled = () => unpackaged() && Boolean(process.env.DSH_DESKTOP_CAPTURE)

/** Where captures land; defaults beside the app so they are easy to find. */
function outDir () {
  return process.env.DSH_DESKTOP_CAPTURE_DIR || path.join(process.cwd(), '.captures')
}

/** Screenshot the live window to a PNG. */
async function capture (win, name = 'window') {
  if (!enabled() || !win || win.isDestroyed()) return null
  const dir = outDir()
  fs.mkdirSync(dir, { recursive: true })
  // capturePage() intermittently rejects with UnknownVizError (a GPU/offscreen
  // hiccup). Retry a couple of times; never let it abort the capture sequence.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Capture twice and keep the second. capturePage() can return the frame
      // BEFORE the most recent composite — which produced screenshots one theme
      // behind: holo-dark.png held the light frame and holo-light.png held the
      // dark one. The first call forces the compositor to produce a current
      // frame; the second reads it.
      await win.webContents.capturePage()
      await new Promise((r) => setTimeout(r, 350))
      const image = await win.webContents.capturePage()
      const file = path.join(dir, `${name}.png`)
      fs.writeFileSync(file, image.toPNG())
      return file
    } catch (error) {
      if (attempt === 2) { console.log(`[dsh-desktop] capture ${name} failed: ${error.message}`); return null }
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  return null
}

/**
 * Dump the geometry of the top-left region so we can see exactly what the
 * traffic lights overlap, plus a shallow outline of the layout roots.
 */
async function probeChrome (win, name = 'chrome') {
  if (!enabled() || !win || win.isDestroyed()) return null
  const report = await win.webContents.executeJavaScript(`(() => {
    const describe = (el) => el && ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && String(el.className).slice(0, 120)) || '',
      rect: (({x, y, width, height}) => ({x: Math.round(x), y: Math.round(y),
        w: Math.round(width), h: Math.round(height)}))(el.getBoundingClientRect()),
    })
    // Whatever is painted where the macOS traffic lights sit.
    const atTrafficLights = document.elementsFromPoint(40, 20).slice(0, 6).map(describe)
    const roots = [...document.body.children].map(describe)
    // Anything that looks like the sidebar's top region.
    const nearTop = [...document.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 80 && r.height > 12 && r.top < 70 && r.left < 320
      })
      .slice(0, 14)
      .map(describe)
    return { atTrafficLights, roots, nearTop, title: document.title }
  })()`)
  const dir = outDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  return file
}

/**
 * Drive the UI to a named surface before capturing it. Used to screenshot panels
 * that are not on the default route.
 */
async function openSettings (win) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    // Structure first, text last. Matching /settings/i over all button text
    // clicked a SESSION whose title happened to contain the word "Settings"
    // (it was a session about a settings bug), opening its context menu and
    // leaving every later probe reporting that the settings nav did not exist.
    // The real trigger is the dialog opener in the sidebar foot.
    const real = document.querySelector('[class*="footArea"] button[aria-haspopup="dialog"]')
      || document.querySelector('[class*="settingsArea"] button')
    if (real) { real.click(); return true }
    const hit = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => /settings/i.test(el.getAttribute('aria-label') || el.textContent || ''))
    if (!hit) return false
    hit.click()
    return true
  })()`).catch(() => false)
}

/** Click a settings nav entry by visible label (e.g. "Accounts"). */
async function openSettingsTab (win, label) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    const hit = [...document.querySelectorAll('button, [role="tab"], [role="button"], a, li')]
      .find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.click()
    return true
  })()`).catch(() => false)
}

/**
 * What would actually receive a click aimed at this control?
 *
 * A control can be perfectly visible and still unclickable, because something
 * transparent is stacked over it — the failure mode a screenshot cannot show
 * and a `.click()` call papers over, since dispatching on the node bypasses
 * hit-testing entirely. This asks the document what is at the control's centre
 * point and reports the chain, so an intercepting overlay names itself.
 */
async function probeClickTarget (win, label) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const describe = (el) => el ? {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
      text: (el.textContent || '').trim().slice(0, 40),
      pointerEvents: getComputedStyle(el).pointerEvents,
      zIndex: getComputedStyle(el).zIndex,
    } : null
    const wanted = ${JSON.stringify(label)}
    const target = [...document.querySelectorAll('button, [role="tab"], [role="button"], a, li')]
      .find((el) => (el.textContent || '').trim() === wanted)
    if (!target) return { label: wanted, found: false }
    const box = target.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) {
      return { label: wanted, found: true, zeroSized: true, box: { w: box.width, h: box.height } }
    }
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const top = document.elementFromPoint(x, y)
    const reaches = Boolean(top && (top === target || target.contains(top) || top.contains(target)))
    return {
      label: wanted,
      found: true,
      reaches,
      box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      target: describe(target),
      topmost: describe(top),
      stack: document.elementsFromPoint(x, y).slice(0, 5).map(describe),
    }
  })()`).catch((error) => ({ label, error: String(error && error.message) }))
}

/**
 * Where does the conversation composer live in the DOM?
 *
 * The composer is drawn by the conversation shell below whichever
 * `conversation.view` occupant is active, so a non-chat view inherits a
 * "Message the agent" box it has no use for. Hiding it needs a selector, and
 * the class is hashed — this reports the chain from the textarea upwards so a
 * readable suffix can be picked deliberately rather than guessed.
 */
async function probeComposer (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('textarea, [contenteditable="true"]')
    if (!field) return { found: false }
    const chain = []
    let node = field
    for (let i = 0; i < 8 && node && node !== document.body; i += 1) {
      const box = node.getBoundingClientRect()
      chain.push({
        tag: node.tagName.toLowerCase(),
        cls: (typeof node.className === 'string' ? node.className : '').slice(0, 120),
        h: Math.round(box.height),
        w: Math.round(box.width),
      })
      node = node.parentElement
    }
    return { found: true, chain }
  })()`).catch((error) => ({ error: String(error && error.message) }))
}

/**
 * Walk a control's ancestor chain reporting the computed `-webkit-app-region`.
 *
 * A drag region is resolved by the OS before the event ever reaches the
 * renderer, so a control inside one is unclickable while every JS-visible
 * signal still says it is fine: elementFromPoint returns it, pointer-events is
 * auto, and a scripted .click() fires its handler. This is the only probe that
 * can see the difference.
 */
async function probeAppRegion (win, label) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(label)}
    const target = [...document.querySelectorAll('button, [role="button"], a, li')]
      .find((el) => (el.textContent || '').trim() === wanted)
    if (!target) return { label: wanted, found: false }
    const chain = []
    let node = target
    for (let i = 0; i < 12 && node && node !== document.documentElement; i += 1) {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      chain.push({
        tag: node.tagName.toLowerCase(),
        cls: (typeof node.className === 'string' ? node.className : '').slice(0, 70),
        region: style.getPropertyValue('-webkit-app-region') || style.webkitAppRegion || '(unset)',
        box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      })
      node = node.parentElement
    }
    return { label: wanted, found: true, chain }
  })()`).catch((error) => ({ label, error: String(error && error.message) }))
}

/**
 * The complete draggable-region picture: every element declaring drag or
 * no-drag, with the box it actually contributes.
 *
 * Chromium resolves the region from layout boxes, so an element with a 0x0 box
 * contributes nothing however emphatically it declares no-drag — which is
 * exactly how a whole column of controls can be dead to the mouse while every
 * other diagnostic reports health. Reading the boxes is what makes that
 * visible.
 */
async function probeDragRegions (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const rows = []
    for (const el of document.querySelectorAll('*')) {
      const region = getComputedStyle(el).getPropertyValue('-webkit-app-region')
      if (region !== 'drag' && region !== 'no-drag') continue
      const box = el.getBoundingClientRect()
      rows.push({
        region,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        tag: el.tagName.toLowerCase(),
        w: Math.round(box.width),
        h: Math.round(box.height),
        x: Math.round(box.left),
        y: Math.round(box.top),
      })
    }
    const drags = rows.filter((r) => r.region === 'drag')
    return {
      total: rows.length,
      drag: drags,
      // A no-drag that contributes nothing is the bug signature worth naming.
      emptyNoDrag: rows.filter((r) => r.region === 'no-drag' && r.w === 0 && r.h === 0).length,
      effectiveNoDrag: rows.filter((r) => r.region === 'no-drag' && r.w > 0 && r.h > 0).length,
    }
  })()`).catch((error) => ({ error: String(error && error.message) }))
}

/**
 * Seed a localStorage key before a capture.
 *
 * Views remember their last selection there (the Files root, the Preview URL),
 * and a screenshot needs a specific one rather than whatever the last run left
 * behind. Reloads afterwards so the value is read at mount.
 */
async function seedStorage (win, key, value) {
  if (!enabled() || !win || win.isDestroyed()) return false
  const ok = await win.webContents.executeJavaScript(
    `(() => { try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true } catch { return false } })()`,
  ).catch(() => false)
  if (ok) { win.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)) }
  return ok
}

/** Open the mode/preset picker in the composer, for a screenshot of the modes. */
async function openModePicker (win) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    const hit = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => /mode/i.test((el.textContent || '')) && (el.textContent||'').length < 40)
    if (!hit) return false
    hit.click()
    return true
  })()`).catch(() => false)
}

/** Click the first control whose visible text matches exactly. */
async function clickByText (win, label) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    const hit = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.click()
    return true
  })()`).catch(() => false)
}

/**
 * Read back what the Accounts panel is actually rendering. More reliable than a
 * screenshot for asserting behaviour, because it does not depend on paint timing.
 */
async function probeAccounts (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.dshd-acc')
    if (!panel) return { present: false }
    const text = (sel) => [...panel.querySelectorAll(sel)].map((el) => el.textContent.trim())
    return {
      present: true,
      cards: text('.dshd-card-name'),
      buttons: text('.dshd-btn'),
      live: text('.dshd-live .dshd-prompt-msg'),
      notices: text('.dshd-notice'),
      warnings: text('.dshd-warn'),
      errors: text('.dshd-err'),
    }
  })()`).catch((e) => ({ present: false, error: String(e) }))
}

/** Measure the sidebar foot so our action can match the Settings control exactly. */
async function probeFooter (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const pick = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        cls: String(el.className).slice(0, 60),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        font: cs.fontSize + '/' + cs.fontWeight,
        color: cs.color, opacity: cs.opacity,
        padding: cs.padding, gap: cs.gap, borderRadius: cs.borderRadius,
      }
    }
    const foot = document.querySelector('[class*="footArea"]')
    const settingsArea = document.querySelector('[class*="settingsArea"]')
    const settingsBtn = settingsArea && settingsArea.querySelector('button, a, [role="button"]')
    const settingsSvg = settingsArea && settingsArea.querySelector('svg')
    const settingsLabel = settingsBtn && [...settingsBtn.querySelectorAll('span,div')]
      .find((el) => (el.textContent || '').trim() === 'Settings')
    const yt = document.querySelector('.dshd-yt')
    const ytSvg = yt && yt.querySelector('svg')
    const ytLabel = yt && yt.querySelector('.dshd-yt-label')
    return {
      footArea: pick(foot),
      footerActions: pick(document.querySelector('[class*="footerActions"]')),
      settingsArea: pick(settingsArea),
      settingsButton: pick(settingsBtn),
      settingsIcon: pick(settingsSvg),
      settingsLabel: pick(settingsLabel),
      ytRow: pick(yt),
      ytIcon: pick(ytSvg),
      ytLabel: pick(ytLabel),
    }
  })()`).catch((e) => ({ error: String(e) }))
}

async function probeAbout (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.dshd-about')
    if (!el) return { present: false }
    return { present: true, text: el.innerText.slice(0, 400) }
  })()`).catch(() => ({ present: false }))
}

/** Flip the holographic theme + light/dark attributes for visual verification. */
async function setHolo (win, { holo, dark }) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    try { localStorage.setItem('dshd.theme.holo', ${JSON.stringify(String(holo ? 1 : 0))}) } catch {}
    if (${holo ? 'true' : 'false'}) document.body.setAttribute('data-dshd-holo', '')
    else document.body.removeAttribute('data-dshd-holo')
    if (${dark ? 'true' : 'false'}) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    return true
  })()`).catch(() => false)
}

/** Report whether the holo stylesheet parsed and its rules are live. */
async function probeHolo (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('dshd-holo-theme-style')
    if (!el) return { present: false }
    let rules = 0, err = null
    try { rules = el.sheet ? el.sheet.cssRules.length : -1 } catch (e) { err = String(e) }
    const center = document.querySelector('[class*="centerCol"]')
    const bg = center ? getComputedStyle(center, '::before').backgroundImage : ''
    const body = getComputedStyle(document.body)
    return {
      present: true,
      hasAttr: document.body.hasAttribute('data-dshd-holo'),
      ruleCount: rules,
      sheetError: err,
      textLen: el.textContent.length,
      bgBase: body.getPropertyValue('--dsw-alias-bg-base').trim(),
      sidebarFill: body.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      centerBefore: (bg || '').slice(0, 90),
    }
  })()`).catch((e) => ({ present: false, error: String(e) }))
}

/** Report the real class names of the composer and main column. */
async function probeSelectors (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const out = {}
    const ta = document.querySelector('textarea')
    if (ta) {
      const chain = []
      let el = ta
      for (let i = 0; i < 6 && el; i++) {
        const r = el.getBoundingClientRect()
        chain.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,80),
          w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(el).borderRadius })
        el = el.parentElement
      }
      out.composerChain = chain
    }
    // Widest tall container that is not the sidebar — the main column.
    const cands = [...document.querySelectorAll('div')].filter(e => {
      const r = e.getBoundingClientRect()
      return r.width > 500 && r.height > 400 && r.left > 200
    }).slice(0, 5)
    out.mainCols = cands.map(e => ({ cls: String(e.className).slice(0,80),
      w: Math.round(e.getBoundingClientRect().width) }))
    // Confirm the rounded-right-side chrome rule actually landed.
    const center = document.querySelector('[class*="centerCol"]')
    if (center) {
      const cs = getComputedStyle(center)
      out.centerCol = { radius: cs.borderRadius, overflow: cs.overflow }
    }
    return out
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * Open a session by its visible title. Sidebar rows are not buttons, so the
 * narrow clickByText selector misses them; search any element and click the
 * smallest match so we hit the row rather than a container.
 */
async function openSessionByTitle (win, title) {
  if (!enabled() || !win || win.isDestroyed()) return false
  return win.webContents.executeJavaScript(`(() => {
    const want = ${JSON.stringify(title)}
    const hits = [...document.querySelectorAll('div,li,a,button,[role="button"],[role="option"]')]
      .filter((el) => (el.textContent || '').trim().startsWith(want))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 10 })
    if (!hits.length) return false
    // Smallest box containing the label = the row itself.
    hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (ra.width * ra.height) - (rb.width * rb.height)
    })
    hits[0].click()
    return true
  })()`).catch(() => false)
}

/** Dump the conversation view ring so we can see which tabs actually registered. */
async function probeViews (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const tabish = [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
      .map((el) => ({ text: (el.textContent || '').trim().slice(0, 30),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 40) }))
      .filter((e) => e.text)
    const pv = document.querySelector('.dshd-pv')
    // Which of our own surfaces are actually mounted. Reading the module
    // loader's internals was a guess that always returned []; asking the DOM
    // whether our roots exist is the thing we actually want to know.
    const OURS = { preview: '.dshd-pv', accounts: '.dshd-acc', about: '.dshd-about',
      workspaces: '.dshd-ws-row', usage: '.dshd-uc', youtube: '.dshd-yt' }
    const loaded = Object.entries(OURS)
      .filter(([, sel]) => document.querySelector(sel))
      .map(([name]) => name)
    return {
      previewMounted: Boolean(pv),
      tabTexts: tabish.map((e) => e.text),
      dshdSurfaces: loaded,
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/** Read the live state of the Preview pane's webview: did it really load? */
async function probePreviewFrame (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const wv = document.querySelector('.dshd-pv webview')
    const fr = document.querySelector('.dshd-pv iframe')
    const el = wv || fr
    if (!el) return { frame: null }
    const r = el.getBoundingClientRect()
    return {
      frame: wv ? 'webview' : 'iframe',
      src: el.getAttribute('src') || el.src || null,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      canGoBack: wv && typeof wv.canGoBack === 'function' ? wv.canGoBack() : null,
      url: wv && typeof wv.getURL === 'function' ? wv.getURL() : null,
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * Open the popovers that could be clipped by the centerCol overflow rule and
 * report, for each, whether it lays out inside that box and whether its painted
 * rect escapes the box's bounds. Anything inside-and-overflowing is clipped.
 */
async function probePopoverClipping (win, label) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = new Set(document.querySelectorAll('body *'))
    const hit = [...document.querySelectorAll('button,[role="button"],[role="combobox"]')]
      .find((el) => (el.textContent || '').trim().includes(${JSON.stringify(label)}))
    if (!hit) return { opened: false, reason: 'trigger not found' }
    hit.click()
    await wait(1200)
    const center = document.querySelector('[class*="centerCol"]')
    const cRect = center ? center.getBoundingClientRect() : null
    // Newly-added nodes that are big enough to be the popover surface.
    const added = [...document.querySelectorAll('body *')].filter((el) => !before.has(el))
    const panels = added.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 120 && r.height > 60
    })
    const report = panels.slice(0, 4).map((el) => {
      const r = el.getBoundingClientRect()
      const insideCenter = Boolean(center && center.contains(el))
      const escapes = cRect
        ? (r.right > cRect.right + 1 || r.bottom > cRect.bottom + 1
           || r.left < cRect.left - 1 || r.top < cRect.top - 1)
        : false
      return {
        cls: String(el.className).slice(0, 44),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        insideCenter,
        escapesCenterBox: escapes,
        clipped: insideCenter && escapes,
      }
    })
    return { opened: true, centerRect: cRect && { x: Math.round(cRect.x), y: Math.round(cRect.y),
      w: Math.round(cRect.width), h: Math.round(cRect.height) }, panels: report }
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * The composer's moving edge, checked two ways: that it is actually moving
 * (computed background-position differs across a sample), and that nothing
 * outside the composer card paints the holographic gradient — the failure mode
 * of the withdrawn conic ring, which streaked across the whole pane.
 */
async function probeMovingEdge (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = document.querySelector('[class*="uV2eYG_card"]')
    if (!card) return { card: false }
    const read = () => getComputedStyle(card).backgroundPosition
    const a = read()
    await wait(1500)
    const b = read()
    // Who else paints a holographic gradient? Anything big enough to be a
    // full-pane streak is the bug we are guarding against.
    const strays = [...document.querySelectorAll('body *')].filter((el) => {
      if (el === card || card.contains(el)) return false
      const cs = getComputedStyle(el)
      const img = cs.backgroundImage + ' ' + (cs.getPropertyValue('background') || '')
      if (!/linear-gradient\\(100deg/.test(img)) return false
      const r = el.getBoundingClientRect()
      return r.width > 400 || r.height > 400
    }).map((el) => ({ cls: String(el.className).slice(0, 40) }))
    return { card: true, sampleA: a, sampleB: b, moving: a !== b, strays }
  })()`).catch((e) => ({ error: String(e) }))
}


/** Confirm the About panel's licence bridge exists and is name-gated. */
async function probeLicenseBridge (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__DSH_DESKTOP__
    const buttons = [...document.querySelectorAll('.dshd-about-legal button')]
      .map((b) => b.textContent.trim())
    if (!bridge || typeof bridge.openNotice !== 'function') {
      return { bridge: false, buttons }
    }
    // A name that is not in the allowlist must be refused without opening
    // anything. This is the injection surface, so assert it directly.
    const bogus = await bridge.openNotice('../../../etc/passwd')
    return { bridge: true, buttons, refusedBogusName: bogus === false }
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * What actually paints the traffic-light strip at the top of the sidebar, and
 * how it differs from the sidebar body right below it.
 */
async function probeTrafficStrip (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const describe = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        cls: String(el.className).slice(0, 46),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage.slice(0, 60),
        paddingTop: cs.paddingTop,
      }
    }
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    // Stack at a point inside the reserved strip, and one just below it.
    const inStrip = document.elementsFromPoint(120, 8).slice(0, 5).map(describe)
    const belowStrip = document.elementsFromPoint(120, 60).slice(0, 5).map(describe)
    return {
      sidebar: describe(sidebar),
      body: { bg: getComputedStyle(document.body).backgroundColor,
        bgImage: getComputedStyle(document.body).backgroundImage.slice(0, 60) },
      sidebarFillToken: getComputedStyle(document.body)
        .getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      inStrip,
      belowStrip,
      aboutLegalButtons: [...document.querySelectorAll('.dshd-about-legal button')]
        .map((b) => b.textContent.trim()),
      // Who paints an opaque fill inside the sidebar, and where does it start?
      sidebarChildren: sidebar ? [...sidebar.children].map((el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return { cls: String(el.className).slice(0, 40),
          top: Math.round(r.top), h: Math.round(r.height),
          bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 44) }
      }) : [],
      // Every element inside the sidebar that paints an opaque fill. One of
      // these is covering the column's gradient below the traffic-light strip.
      opaqueInSidebar: sidebar ? [...sidebar.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        if (!bg || bg === 'transparent' || bg.startsWith('rgba(0, 0, 0, 0')) return false
        const r = el.getBoundingClientRect()
        return r.width > 200 && r.height > 200
      }).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return { cls: String(el.className).slice(0, 44), tag: el.tagName.toLowerCase(),
          top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
          bg: cs.backgroundColor }
      }) : [],
      sidebarParent: (() => {
        const parent = sidebar && sidebar.parentElement
        if (!parent) return null
        const cs = getComputedStyle(parent)
        return { cls: String(parent.className).slice(0, 40), bg: cs.backgroundColor,
          bgImage: cs.backgroundImage.slice(0, 44) }
      })(),
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * Surfaces that stayed neutral grey while the holographic theme is on.
 *
 * The theme works by overriding design tokens. Anything painted from a token we
 * did not override keeps its stock neutral colour, which reads as "one part of
 * the app did not get the theme" — the New Session button against a violet
 * sidebar being the obvious case. Neutral means r/g/b within a few points of
 * each other; the holo palette is never neutral.
 */
async function probeUnthemedSurfaces (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const parse = (c) => {
      const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(c || '')
      if (!m) return null
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
    }
    const out = []
    for (const el of document.querySelectorAll('[class*="sidebarCol"] *')) {
      const cs = getComputedStyle(el)
      const c = parse(cs.backgroundColor)
      if (!c || c.a < 0.25) continue
      const r = el.getBoundingClientRect()
      if (r.width < 40 || r.height < 16) continue
      const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
      if (spread > 6) continue           // already tinted; fine
      if (c.r > 250 && c.g > 250 && c.b > 250) { /* pure white also stands out */ }
      out.push({ cls: String(el.className).slice(0, 40), tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 20),
        bg: cs.backgroundColor, spread,
        rect: { w: Math.round(r.width), h: Math.round(r.height) } })
    }
    // Deduplicate by class; a list renders the same class many times.
    const seen = new Set()
    return out.filter((e) => { if (seen.has(e.cls)) return false; seen.add(e.cls); return true }).slice(0, 10)
  })()`).catch((e) => ({ error: String(e) }))
}


/** Which element in the conversation column paints the opaque fill. */
async function probeCenterFill (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const center = document.querySelector('[class*="centerCol"]')
    if (!center) return { center: false }
    const opaque = [...center.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el)
      const bg = cs.backgroundColor
      if (!bg || bg.startsWith('rgba(0, 0, 0, 0')) return false
      const r = el.getBoundingClientRect()
      return r.width > 400 && r.height > 300
    }).slice(0, 5).map((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { cls: String(el.className).slice(0, 44), bg: cs.backgroundColor,
        pos: cs.position, z: cs.zIndex,
        rect: { top: Math.round(r.top), h: Math.round(r.height) } }
    })
    const firstChild = center.firstElementChild
    return {
      center: true,
      directChild: firstChild ? { cls: String(firstChild.className).slice(0, 40),
        display: getComputedStyle(firstChild).display,
        pos: getComputedStyle(firstChild).position } : null,
      opaque,
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/**
 * Block until the holographic theme has actually been APPLIED, not merely
 * requested.
 *
 * setHolo flips attributes; the style recalc and repaint land later, and
 * capturePage() will happily hand back the pre-repaint frame. That is how
 * holo-dark.png came out looking like the stock light theme while the probes
 * run moments later reported the theme correctly — the screenshot was real, it
 * was just early. Poll the computed token instead of sleeping on a guess.
 */
async function waitForHolo (win, { dark, timeoutMs = 6000 } = {}) {
  if (!enabled() || !win || win.isDestroyed()) return false
  const expected = dark ? '#131120' : '#f6f5fc'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const cs = getComputedStyle(document.body)
      return {
        holo: document.body.hasAttribute('data-dshd-holo'),
        dark: document.body.hasAttribute('data-ds-dark-theme'),
        base: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })()`).catch(() => null)
    if (state && state.holo && state.dark === Boolean(dark) && state.base) {
      if (!expected || state.base.toLowerCase() === expected) {
        // One more frame so the repaint is on screen, not just in style.
        await win.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
        ).catch(() => {})
        return true
      }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}


/**
 * The sidebar wash must survive a pointer entering the sidebar.
 *
 * The first attempt keyed the override to `quietBars`, a class the sidebar adds
 * only while the pointer is OUTSIDE it — so hovering restored the opaque fill
 * and brought the traffic-light seam back. Simulate both states and compare.
 */
async function probeSidebarHover (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('[class*="hHd-Xa_root"]')
    if (!root) return { root: false }
    const read = () => getComputedStyle(root).backgroundColor
    const quiet = [...root.classList].find((c) => c.includes('quietBars'))
    const before = read()
    // Drop the hover-sensitive modifier exactly as React does on pointerenter.
    if (quiet) root.classList.remove(quiet)
    const hovered = read()
    if (quiet) root.classList.add(quiet)
    const transparent = (c) => c === 'transparent' || /rgba\\(0, 0, 0, 0\\)/.test(c)
    return {
      root: true,
      hadQuietBars: Boolean(quiet),
      pointerOutside: before,
      pointerInside: hovered,
      survivesHover: transparent(before) && transparent(hovered),
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/** The hero block's DOM: where the brand mark sits relative to the title. */
async function probeHero (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const marks = [...document.querySelectorAll('.dshd-brand-mark')]
    const center = document.querySelector('[class*="centerCol"]')
    const mark = marks.find((m) => center && center.contains(m))
    if (!mark) return { mark: false, count: marks.length }
    const chain = []
    let el = mark
    for (let i = 0; i < 5 && el; i++) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      chain.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 46),
        display: cs.display, flexDirection: cs.flexDirection, gap: cs.gap,
        alignItems: cs.alignItems, marginTop: cs.marginTop, paddingTop: cs.paddingTop,
        text: (el.textContent || '').trim().slice(0, 26),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
      el = el.parentElement
    }
    return { mark: true, chain }
  })()`).catch((e) => ({ error: String(e) }))
}


/** How the settings nav renders each section's icon, so we can target ours. */
async function probeSettingsNav (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('[class*="dialog"] nav a, [class*="dialog"] nav button, [role="dialog"] button, [class*="settings"] button')]
      .filter((el) => /^(General|Accounts|Workspaces|Models|Plugins|Agent presets|About)$/
        .test((el.textContent || '').trim()))
    return items.map((el) => {
      const svg = el.querySelector('svg')
      const paths = svg ? [...svg.querySelectorAll('path,circle,rect,line')]
        .map((n) => (n.getAttribute('d') || n.tagName).slice(0, 44)) : null
      const own = el.querySelector('svg[class*=\"navIcon\"]')
      const box = own ? own.getBoundingClientRect() : null
      const before = getComputedStyle(el, '::before')
      return {
        label: (el.textContent || '').trim(),
        upstreamIcon: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
        ourIcon: { w: before.width, h: before.height },
        cls: String(el.className).slice(0, 50),
        dataAttrs: Object.fromEntries([...el.attributes]
          .filter((a) => a.name.startsWith('data-') || a.name === 'id' || a.name === 'aria-label')
          .map((a) => [a.name, a.value.slice(0, 40)])),
        hasSvg: Boolean(svg),
        svgCls: svg ? String(svg.getAttribute('class') || '').slice(0, 40) : null,
        shapes: paths ? paths.length : 0,
        firstShape: paths && paths[0] ? paths[0] : null,
      }
    })
  })()`).catch((e) => ({ error: String(e) }))
}


/** The settings dialog's real structure, before we style any of it. */
async function probeDialog (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const d = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el), r = el.getBoundingClientRect()
      return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 44),
        bg: cs.backgroundColor, overflow: cs.overflowY,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    }
    const dialog = document.querySelector('[role="dialog"]')
    const navList = document.querySelector('[class*="navList"]')
    const matchesHas = dialog ? dialog.matches(':has([class*=\"navList\"])') : null
    const navChild = dialog ? [...dialog.children].find((c) => c.tagName === 'NAV') : null
    // Everything inside the dialog whose class mentions "actions" or "options".
    const named = (word) => dialog
      ? [...dialog.querySelectorAll('[class*="' + word + '"]')].slice(0, 4).map(d)
      : []
    // Which element actually scrolls the content column?
    const scrollers = dialog
      ? [...dialog.querySelectorAll('*')].filter((el) => {
          const cs = getComputedStyle(el)
          return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4
        }).slice(0, 3).map(d)
      : []
    return {
      dialog: d(dialog), hasNavList: Boolean(navList), dialogMatchesHas: matchesHas,
      navIsDirectChild: Boolean(navChild), nav: d(navChild),
      actions: named('actions'), options: named('options'), scrollers,
      headerButtons: dialog
        ? [...dialog.querySelectorAll('button')].slice(0, 3)
            .map((b) => ({ text: (b.textContent || '').trim().slice(0, 28), cls: String(b.className).slice(0, 40) }))
        : [],
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/** The real width the Accounts grid gets, and how many columns it resolves to. */
async function probeGrid (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const acc = document.querySelector('.dshd-acc')
    const grid = document.querySelector('.dshd-grid')
    if (!grid) return { grid: false }
    const cs = getComputedStyle(grid)
    return {
      grid: true,
      accWidth: acc ? Math.round(acc.getBoundingClientRect().width) : null,
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      templateColumns: cs.gridTemplateColumns,
      columnCount: cs.gridTemplateColumns.split(' ').filter(Boolean).length,
      cardHeights: [...grid.children].map((c) => Math.round(c.getBoundingClientRect().height)),
    }
  })()`).catch((e) => ({ error: String(e) }))
}


/** The window's real bounds, for verifying restore-from-disk. */
async function probeBounds (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  const b = win.getNormalBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

/**
 * Ask the client which controls the native menu's actions can still find.
 *
 * Read-only: window.__DSHD_ACTIONS__.probe() locates and reports, and clicks
 * nothing. This exists because a menu item that stops working is invisible to
 * every other check we have - the accelerator still registers, the click still
 * runs, and nothing happens - so an upstream rename can quietly empty half the
 * View menu. Check it against a real render rather than trusting the selectors.
 */
async function probeMenuActions (win) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(() => {
    const actions = window.__DSHD_ACTIONS__
    if (!actions) return { exposed: false }
    return {
      exposed: true,
      names: Object.keys(actions).sort(),
      found: typeof actions.probe === 'function' ? actions.probe() : null,
    }
  })()`).catch((error) => ({ exposed: false, error: String(error && error.message) }))
}

/** Pin a workspace and report what the Workspaces panel then renders. */
async function probeWorkspaceGroups (win, pinKey) {
  if (!enabled() || !win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const read = () => ({
      headings: [...document.querySelectorAll('.dshd-ws-group')].map((h) => h.textContent.trim()),
      rowNames: [...document.querySelectorAll('.dshd-ws-name')].map((n) => n.textContent.trim()),
      lists: document.querySelectorAll('.dshd-ws-list').length,
    })
    const before = read()
    // Pin every workspace on screen, the case where the duplication was total.
    const pin = [...document.querySelectorAll('.dshd-ws-pin')][0]
    if (pin) { pin.click(); await wait(1800) }
    return { before, afterPin: read() }
  })()`).catch((e) => ({ error: String(e) }))
}

/**
 * Every helper is fenced at the boundary rather than in its own body.
 *
 * Most of them already opened with `if (!enabled()) return null`, but not all
 * did, and the ones that did not were the automation rather than the
 * screenshots — opening a session, clicking a control by its visible text. A
 * per-function check is also a rule a future helper can be written without
 * noticing. Wrapping the export table means a new helper inherits the fence by
 * existing, and the individual checks inside become redundant belt-and-braces
 * rather than the only defence.
 */
const surface = { capture, seedStorage, openModePicker, probeClickTarget, probeComposer, probeAppRegion, probeDragRegions, probeWorkspaceGroups, probeBounds, probeGrid, probeDialog, probeSettingsNav, probeHero, probeSidebarHover, waitForHolo, probeCenterFill, probeUnthemedSurfaces, probeTrafficStrip, probeLicenseBridge, probeMovingEdge, probePopoverClipping, probePreviewFrame, openSessionByTitle, probeViews, probeChrome, openSettings, openSettingsTab, clickByText, probeAccounts, probeAbout, probeFooter, setHolo, probeHolo, probeSelectors, probeMenuActions }

module.exports = Object.fromEntries([
  // `null` is what the guarded helpers already returned when disabled, so a
  // caller that logs the result reads the same either way.
  ...Object.entries(surface).map(([name, fn]) => [name, (...args) => (enabled() ? fn(...args) : null)]),
  ['enabled', enabled],
])
