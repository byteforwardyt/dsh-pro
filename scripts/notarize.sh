#!/usr/bin/env bash
#
# Notarize and staple every built DMG.
#
# Deliberately a separate step rather than `build.mac.notarize` in
# shell/package.json. Wiring it into the build would make every `npm run pack`
# depend on network access, Apple's queue, and a keychain profile being present
# — so a routine local build would start failing for reasons that have nothing
# to do with the code. Notarization matters when you are about to hand the DMG
# to someone else, which is not most builds.
#
#   ./scripts/notarize.sh
#
# Requires the `dshpro-notary` keychain profile. Create it once:
#
#   xcrun notarytool store-credentials "dshpro-notary" \
#     --key ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
#     --key-id <KEYID> --issuer <ISSUER-UUID>
#
# Notarization is per-artifact: both the arm64 and the x64 DMG must be
# submitted, and each must be stapled so it validates without a network round
# trip on the user's machine.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSHPRO_NOTARY_PROFILE:-dshpro-notary}"

# Prefer an API key by path; fall back to a keychain profile. Reading or writing
# a notarytool keychain profile can need a user-consent prompt, and a build from
# a non-interactive shell then fails with "User interaction is not allowed" —
# which is how this broke mid-release. A key on disk has no such dependency and
# is the only form that works unattended.
AUTH=(--keychain-profile "$PROFILE")
if [ -n "${DSHPRO_NOTARY_KEY:-}" ] && [ -n "${DSHPRO_NOTARY_KEY_ID:-}" ] && [ -n "${DSHPRO_NOTARY_ISSUER:-}" ]; then
  AUTH=(--key "${DSHPRO_NOTARY_KEY/#\~/$HOME}" --key-id "$DSHPRO_NOTARY_KEY_ID" --issuer "$DSHPRO_NOTARY_ISSUER")
fi

shopt -s nullglob
# Scope to the version this checkout builds. electron-builder does not remove
# other-version DMGs from release/, so an unscoped glob re-notarizes every past
# build — minutes of dead time per stale artifact. Read the shell's version and
# match only its DMGs; fall back to all DMGs if the lookup fails.
VERSION="$(node -p "require('$ROOT/shell/package.json').version" 2>/dev/null || true)"
if [ -n "$VERSION" ]; then
  dmgs=("$ROOT"/release/*"-$VERSION-"*.dmg)
  [ ${#dmgs[@]} -eq 0 ] && dmgs=("$ROOT"/release/*.dmg)
else
  dmgs=("$ROOT"/release/*.dmg)
fi
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "no DMG under release/ — run: npm run pack"
  exit 1
fi
echo "notarizing ${#dmgs[@]} DMG(s)${VERSION:+ for $VERSION}"

# Probe auth before submitting: a 174MB upload that fails on credentials at the
# far end wastes several minutes per artifact.
if ! xcrun notarytool history "${AUTH[@]}" >/dev/null 2>&1; then
  echo "cannot authenticate to the notary service."
  echo
  echo "notarytool reports a missing keychain item for BOTH an absent profile and"
  echo "one it cannot read, so check the profile exists before assuming it does:"
  echo
  echo "  xcrun notarytool history --keychain-profile $PROFILE"
  echo
  echo "The durable fix is an API key by path, which needs no keychain and is the"
  echo "only form that works unattended. The .p8 lives under"
  echo "~/.appstoreconnect/private_keys/; the key id is in its filename, and the"
  echo "issuer uuid comes from App Store Connect > Users and Access > Integrations:"
  echo
  echo "  export DSHPRO_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8"
  echo "  export DSHPRO_NOTARY_KEY_ID=<KEYID>"
  echo "  export DSHPRO_NOTARY_ISSUER=<issuer-uuid>"
  echo
  echo "Notarization credentials stay on this machine. Note the app bundles inside each DMG are notarized"
  echo "separately by build/afterSign.cjs and are unaffected by this failure —"
  echo "./scripts/verify-release.sh reports the two independently."
  exit 1
fi

fail=0
for dmg in "${dmgs[@]}"; do
  name="$(basename "$dmg")"
  echo "== $name"

  # --wait blocks until Apple returns a terminal status. Without it the command
  # returns immediately with a submission id and the staple below would fail
  # against a ticket that does not exist yet.
  if ! xcrun notarytool submit "$dmg" "${AUTH[@]}" --wait 2>&1 | sed 's/^/   /'; then
    echo "   submit FAILED"
    fail=$((fail + 1))
    continue
  fi

  # Stapling attaches the ticket to the artifact so Gatekeeper accepts it
  # offline. An unstapled but notarized DMG still passes on a machine that can
  # reach Apple, and fails on one that cannot — the worst kind of intermittent.
  if xcrun stapler staple "$dmg" 2>&1 | sed 's/^/   /'; then
    echo "   stapled"
  else
    echo "   staple FAILED"
    fail=$((fail + 1))
  fi
  echo
done

echo "== Gatekeeper assessment"
"$ROOT/scripts/verify-release.sh" 2>&1 | grep -A2 '\.dmg' | sed 's/^/   /'

if [ "$fail" -eq 0 ]; then
  echo
  echo "all artifacts notarized and stapled"
  exit 0
fi
echo
echo "$fail step(s) FAILED — xcrun notarytool log <submission-id> with the same auth args"
exit 1
