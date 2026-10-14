'use strict'
/**
 * Window-chrome adaptation for a web UI we do not own.
 *
 * The harness frontend is built for a browser tab, so its sidebar starts at y=0.
 * Under `hiddenInset` the macOS traffic lights land at roughly x 20-75, y 12-26 —
 * directly on top of the brand button, which the DOM probe measured at x:16 y:24.
 *
 * Rather than reposition the traffic lights (every free spot collides with some
 * other control), we reserve a strip at the top of the SIDEBAR ONLY. The main
 * column starts at x=280 and is never under the lights, so it is left alone.
 *
 * Selector stability: the frontend uses CSS Modules, whose class names are a hash
 * plus the ORIGINAL name (`pI_x6G_sidebarCol`). Matching on the readable suffix
 * with [class*="..."] survives every rebuild that keeps the source class name,
 * whereas the full hashed name would break on the next upstream release.
 */

/** Height reserved above the sidebar content, in CSS pixels. */
const TRAFFIC_LIGHT_STRIP = 22

const CHROME_CSS = `
/* Reserve room for the macOS traffic lights above the sidebar's brand row. */
[class*="sidebarCol"] {
  box-sizing: border-box;
  padding-top: ${TRAFFIC_LIGHT_STRIP}px;
}

/* The upstream collapsed rail is 56px, narrower than the traffic lights.
   Reserve another 32px in the frame and give it to the rail. Details remain
   anchored to the right; expanded sidebar resizing is unchanged. */
[class~="pI_x6G_frame"][data-sidebar-collapsed] {
  padding-left: 32px;
  box-sizing: border-box;
}
[class~="pI_x6G_frame"][data-sidebar-collapsed] > [class*="sidebarCol"] {
  width: 88px;
  margin-left: -32px;
}

/* Rounded right side.
   The harness is built for a browser tab, so its main column runs flush to the
   viewport edge and looks square inside a macOS window. Rounding the column's
   right corners a little wider than the system's own window radius makes the
   curve read as the app's, with the window ground showing through behind it.

   Only the RIGHT corners: the left edge butts against the sidebar and a radius
   there would open a seam.

   The overflow:hidden is what actually clips the corner, and it is the risky
   half — anything laid out inside this box that overflows it gets cut off.
   Measured, rather than assumed: the model picker and the access-mode picker do
   NOT portal to <body>, they lay out inside this column. They survive because
   the host flips them to stay in view, and "in view" here is this column, so
   their painted rects sit strictly inside its bounds (probePopoverClipping
   reports escapesCenterBox:false for both). The settings dialog is position:
   fixed and is unaffected. If an upstream release ever lets a popover spill past
   the column edge, this rule is the first suspect. */
[class*="centerCol"] {
  border-top-right-radius: 14px;
  border-bottom-right-radius: 14px;
  overflow: hidden;
}

/* ── The reserved traffic-light strip should drag the window ───────────────
   The strip above the sidebar's brand row exists to keep the macOS traffic
   lights off our controls. It was inert: dragging there did nothing, which on
   a frameless window reads as broken. The padding belongs to sidebarCol
   itself, so the column drags and everything drawn inside it does not, which
   leaves a drag handle exactly where the empty strip is and nowhere else.

   The opt-out MUST be a descendant selector, not a child one. Chromium
   computes the draggable region from LAYOUT boxes: a drag ancestor claims its
   whole rect, and only a descendant that generates a box and declares no-drag
   subtracts from it. sidebarCol's sole direct child is a display:contents
   wrapper — it produces no layout box at all, so a child-combinator opt-out
   subtracted an empty rect and the entire 280x860 column stayed draggable.
   Every control in the sidebar was then dead to a real mouse while looking
   perfectly healthy to script: elementFromPoint still returned the button,
   pointer-events was still auto, and a dispatched click() still ran its
   handler, because a drag region is resolved by the window server before the
   event is ever offered to the renderer. Measured, not deduced — see
   devtools.probeAppRegion, which prints the computed value up the chain. */
[class*="sidebarCol"] {
  -webkit-app-region: drag;
}
[class*="sidebarCol"] * {
  -webkit-app-region: no-drag;
}

/* The brand row is a deliberate SECOND drag handle, so it is re-claimed after
   that blanket opt-out — (0,2,0) beats (0,1,0) — and everything drawn inside
   it opts out again at (0,2,0) plus source order. Qualifying all three on
   sidebarCol is what keeps the ordering legible: they live together, in the
   order they resolve.

   The opt-out is a blanket descendant selector rather than a list of
   button/a/[role=button] on purpose. That list would be an enumeration over
   UPSTREAM's markup, which upstream can invalidate on any release: an <input>,
   a [tabindex] host or a <select> added to the brand row would be dead with
   nothing to signal it. Only the blanket form is correct by construction. */
[class*="sidebarCol"] [class*="logoRow"] {
  -webkit-app-region: drag;
}
[class*="sidebarCol"] [class*="logoRow"] * {
  -webkit-app-region: no-drag;
}

/* Desktop-owned title bars follow the same blanket descendant opt-out. */
.dshd-home-toolbar,
[class~="VOzbGW_nav"],
[class~="VOzbGW_header"],
.dshd-tools-head {
  -webkit-app-region: drag;
}
.dshd-home-toolbar *,
[class~="VOzbGW_nav"] *,
[class~="VOzbGW_header"] *,
.dshd-tools-head * {
  -webkit-app-region: no-drag;
}
`

/**
 * Apply the chrome adaptation to a webContents.
 * Re-applied on every navigation because insertCSS is per-document.
 */
async function applyChrome (webContents) {
  try {
    return await webContents.insertCSS(CHROME_CSS)
  } catch {
    // Cosmetic only — never let a styling failure take down the launch.
    return null
  }
}

module.exports = { applyChrome, TRAFFIC_LIGHT_STRIP }
