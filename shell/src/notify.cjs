'use strict'
/**
 * OS notifications and the dock badge.
 *
 * The defining use of this app is a run that takes minutes in a window you
 * alt-tabbed away from, and until now the app had no way to say "I need you".
 * Upstream already computes the signal - every session carries a
 * pendingInteraction - so the only missing piece was the OS surface.
 *
 * Exactly two events earn an interrupt: a session needs input, and a turn
 * finished while the app was not focused. A third would train people to switch
 * all of them off, which costs more than the third event is worth.
 *
 * The page does not choose the WORDING. The renderer sends a kind, a reason and
 * a session title; the headline and the opening sentence both come from KINDS
 * here, and the title is appended after them. That ordering is the point. The
 * session title is model-written, on a machine where the agent reads web pages
 * and files, so a prompt-injected title reaching a macOS banner is a real path
 * rather than a hypothetical one. It cannot be the headline, it cannot be the
 * whole message, and it is stripped of the characters that let text render as
 * something it does not say.
 *
 * What remains is the residual every mail and chat client accepts: a body whose
 * tail is content someone else wrote. It is kept because the alternative -
 * dropping the title - makes the banner useless the moment two sessions are
 * running, which is exactly when this feature earns its place.
 *
 * Posting from the main process rather than from the page also means the
 * renderer keeps zero permissions: main.cjs denies every renderer permission
 * request, notifications included, and that stays true.
 */

const KINDS = {
  // A session is blocked on a person. The reason keys ARE upstream's
  // PendingInteractionStatus union - 'approval' | 'plan-review' | 'question',
  // declared in dsh-client-runtime/lib/types/client/sessions/pending.d.ts:14 -
  // so the renderer forwards the value it already has and there is no mapping
  // table between the two halves to fall out of step. The three display strings
  // in the sidebar are locale entries over the same union, not the values.
  'needs-input': {
    approval: { title: 'Waiting for approval', fallback: 'A step needs your approval.' },
    'plan-review': { title: 'Plan awaiting review', fallback: 'A plan is ready for you to review.' },
    question: { title: 'Waiting for your answer', fallback: 'The agent asked you a question.' },
  },
  // A turn ended. Only ever sent for a top-level session, never a subagent.
  'turn-complete': {
    done: { title: 'Turn complete', fallback: 'The agent finished working.' },
  },
}

/**
 * Longest session title shown in a banner before it is cut. Short because the
 * title now trails our own sentence rather than replacing it, and macOS gives a
 * banner body about two lines before it truncates on our behalf.
 */
const TITLE_LIMIT = 80

/**
 * How many posted notifications to keep referenced.
 *
 * Electron's Notification is a wrapper over a native one; a wrapper collected
 * before the user clicks takes its click handler with it. The ceiling exists
 * because 'close' is the only thing that releases an entry, and not every
 * platform is guaranteed to deliver it.
 */
const LIVE_LIMIT = 20

/** A repeat of the same session and reason inside this window is dropped. */
const REPEAT_MS = 4000

/** Ceiling on posts in any BURST_MS, whatever the renderer asks for. */
const BURST_LIMIT = 6
const BURST_MS = 30000

/**
 * Make one line of untrusted text safe to show in a banner.
 *
 * Control characters go because a newline in a macOS notification body lets one
 * line masquerade as two, which is how a session title becomes a fake second
 * field. The bidi controls go for the same reason one step further: U+202E and
 * the U+2066..U+2069 isolates reverse and reorder what is DISPLAYED, so a title
 * can be shown as something the string does not contain, and the zero-width
 * characters hide the seams where it was done. Returns '' when nothing legible
 * survives, and the caller falls back to its own wording rather than posting an
 * empty body.
 */
function cleanTitle (value) {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return ''
  return flat.length > TITLE_LIMIT ? flat.slice(0, TITLE_LIMIT - 1) + '\u2026' : flat
}

/**
 * The notifier.
 *
 * Every native edge is a parameter so the policy can be tested without an
 * Electron app: whether the window is focused, how to focus it, how to tell the
 * page to open a session, how to make a Notification, and the dock - absent off
 * macOS, where there is no dock badge at all.
 */
function createNotifier ({
  Notification, isFocused, focusWindow, openSession, dock = null, now = Date.now,
}) {
  const lastPost = new Map()
  let burst = []
  const live = new Set()
  let enabled = true
  let badge = 0

  /** Drop stale entries so a long-running app does not grow these forever. */
  function prune (at) {
    burst = burst.filter((stamp) => at - stamp < BURST_MS)
    for (const [key, stamp] of lastPost) if (at - stamp > REPEAT_MS) lastPost.delete(key)
  }

  const notifier = {
    /**
     * Post one notification, or say why not.
     *
     * Returns a reason string rather than a bare false, because most of the
     * ways this declines are ordinary: "focused" and "repeat" are the feature
     * working. Collapsing them into false would hide which one happened from
     * the tests and from anyone reading a log.
     */
    post (payload) {
      if (!enabled) return 'disabled'
      if (payload === null || typeof payload !== 'object') return 'malformed'
      const reasons = Object.hasOwn(KINDS, payload.kind) ? KINDS[payload.kind] : null
      if (reasons === null) return 'malformed'
      const message = Object.hasOwn(reasons, payload.reason) ? reasons[payload.reason] : null
      if (message === undefined || message === null) return 'malformed'
      const id = payload.sessionId
      const sessionId = typeof id === 'string' && id.length > 0 && id.length <= 200
        && !/[\u0000-\u001f]/.test(id)
        ? id
        : null
      if (sessionId === null) return 'malformed'

      // Focus is the whole gate. A banner over the window you are looking at,
      // for a state that window already renders in its own sidebar, is noise -
      // and the dock badge still counts it for when you do look away.
      if (isFocused()) return 'focused'

      const at = now()
      prune(at)
      const key = payload.kind + ':' + payload.reason + ':' + sessionId
      if (lastPost.has(key)) return 'repeat'
      if (burst.length >= BURST_LIMIT) return 'rate-limited'
      if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return 'unsupported'

      lastPost.set(key, at)
      burst.push(at)
      const title = cleanTitle(payload.sessionTitle)
      const notification = new Notification({
        title: message.title,
        // Our sentence first, the title as a trailing fragment after it. An
        // injected title can add to the banner; it cannot be the banner.
        body: title === '' ? message.fallback : message.fallback + ' \u00b7 ' + title,
      })
      live.add(notification)
      if (live.size > LIVE_LIMIT) live.delete(live.values().next().value)
      notification.on('close', () => { live.delete(notification) })
      // Clicking has to do both halves: raise the window, and land on the
      // session that asked. Raising alone drops you wherever you last were,
      // which for the one case this feature exists for is the wrong session.
      notification.on('click', () => {
        focusWindow()
        openSession(sessionId)
      })
      notification.show()
      return 'posted'
    },

    /**
     * The dock badge counts sessions waiting on a person, and nothing else.
     *
     * Never the running count: on this app that is non-zero for most of a
     * working session, so a badge showing it would be permanently lit and
     * therefore permanently ignored. A count of people-blocked sessions is zero
     * almost all the time, which is what makes it worth a glance.
     */
    setWaiting (count) {
      // Refuse while off. Without this the page re-badges the Dock through
      // dsh:notify-badge after the user turned notifications off, which is the
      // one thing turning them off is for.
      if (!enabled) return badge
      const waiting = Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 99) : 0
      if (waiting === badge) return badge
      badge = waiting
      // No dock off macOS. Windows and Linux take an overlay icon or taskbar
      // progress instead, which is a different design, not this one.
      if (dock !== null && typeof dock.setBadge === 'function') {
        dock.setBadge(waiting > 0 ? String(waiting) : '')
      }
      return badge
    },

    /** Whether the user wants any of this. Turning it off clears the badge. */
    setEnabled (value) {
      enabled = value !== false
      if (!enabled) {
        // Cleared here rather than through setWaiting, which now refuses while
        // disabled: routing through it would leave the Dock lit at whatever the
        // badge last showed.
        badge = 0
        if (dock !== null && typeof dock.setBadge === 'function') dock.setBadge('')
      }
      return enabled
    },

    isEnabled () { return enabled },
    waiting () { return badge },
  }
  return notifier
}

module.exports = { createNotifier, cleanTitle, KINDS, TITLE_LIMIT, REPEAT_MS, BURST_LIMIT, BURST_MS }
