#!/usr/bin/env bash
#
# Verify what actually shipped, against the artifact rather than the config.
#
# electron-builder reports what it INTENDED to do. This checks the bytes: that
# each .app is signed by the expected identity with the hardened runtime on,
# that the DMG carries the same, and that the staged harness inside really holds
# the target architecture's native binaries — the one failure that is otherwise
# silent, because an arm64-only tree launches fine here and dies on Intel with
# MODULE_NOT_FOUND.
#
#   ./scripts/verify-release.sh
#
# Exits non-zero if anything is wrong. Notarization is reported but does not
# fail the run, because it is a deliberate separate step (see docs/SIGNING.md).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="$ROOT/release"
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release.local.env"
if [ -f "$LOCAL_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_ENV"
  set +a
fi
EXPECTED_TEAM="${DSHPRO_TEAM_ID:-}"
EXPECTED_ID="pro.digitaldive.dshpro"

fail=0
note () { printf '  %s\n' "$*"; }
ok   () { printf 'ok    %s\n' "$*"; }
bad  () { printf 'FAIL  %s\n' "$*"; fail=$((fail + 1)); }

if [ ! -d "$RELEASE" ]; then
  echo "no release/ directory — run: npm run pack"
  exit 1
fi

# ── Each packaged .app ───────────────────────────────────────────────────────
shopt -s nullglob
apps=("$RELEASE"/mac*/*.app)
if [ ${#apps[@]} -eq 0 ]; then
  bad "no .app found under $RELEASE"
fi

for app in ${apps[@]+"${apps[@]}"}; do
  name="$(basename "$app")"
  slice="$(basename "$(dirname "$app")")"
  echo "== $slice / $name"

  if codesign --verify --deep --strict "$app" 2>/dev/null; then
    ok "signature verifies (deep, strict)"
  else
    bad "signature does NOT verify"
    codesign --verify --deep --strict "$app" 2>&1 | sed 's/^/      /' | head -5
  fi

  info="$(codesign -dv --verbose=2 "$app" 2>&1)"

  if grep -q "Identifier=$EXPECTED_ID" <<<"$info"; then
    ok "bundle id $EXPECTED_ID"
  else
    bad "unexpected bundle id: $(grep -o 'Identifier=[^ ]*' <<<"$info" | head -1)"
  fi

  if [ -z "$EXPECTED_TEAM" ]; then
    note "team id check skipped; set DSHPRO_TEAM_ID locally to verify the signing team"
  elif grep -q "TeamIdentifier=$EXPECTED_TEAM" <<<"$info"; then
    ok "team matches the local signing setting"
  else
    bad "unexpected team: $(grep -o 'TeamIdentifier=[^ ]*' <<<"$info" | head -1)"
  fi

  # 0x10000 is the runtime flag. Without it the notary service rejects the
  # submission outright, so this is worth failing on rather than warning.
  if grep -q 'flags=.*runtime' <<<"$info"; then
    ok "hardened runtime enabled"
  else
    bad "hardened runtime NOT enabled"
  fi

  # Architecture of the shipped executable, and of the harness natives beside it.
  exe="$app/Contents/MacOS/$(basename "$app" .app)"
  exe_arch="$(lipo -archs "$exe" 2>/dev/null || file -b "$exe")"
  ok "executable arch: $exe_arch"

  # electron-builder names the arm64 output dir "mac-arm64" but the x64 one
  # just "mac" — no suffix. Treating an unsuffixed dir as "unknown" silently
  # skipped the architecture check on the exact slice most likely to be wrong.
  want=""
  case "$slice" in
    *arm64*) want="arm64" ;;
    *x64*|*intel*) want="x86_64" ;;
    mac) want="x86_64" ;;
  esac

  # The shipped icon. A missing build/icon/icon.icns does NOT fail the build —
  # electron-builder logs a warning and falls back to the stock Electron icon,
  # then signs and notarizes it happily. Comparing the bytes is the only way to
  # notice you shipped someone else's logo.
  src_icon="$ROOT/build/icon/icon.icns"
  app_icon="$app/Contents/Resources/icon.icns"
  if [ ! -f "$app_icon" ]; then
    bad "no icon.icns in the bundle — it shipped with the stock Electron icon"
  elif [ ! -f "$src_icon" ]; then
    bad "build/icon/icon.icns is missing from the tree — regenerate with npm run make-icon"
  elif [ "$(shasum -a 256 "$src_icon" | cut -d' ' -f1)" = "$(shasum -a 256 "$app_icon" | cut -d' ' -f1)" ]; then
    ok "app icon matches build/icon/icon.icns"
  else
    bad "app icon does NOT match build/icon/icon.icns — stale or fallback icon shipped"
  fi

  harness="$app/Contents/Resources/harness/node_modules"
  if [ -d "$harness" ]; then
    # koffi is the package that made this check necessary; check its real bytes.
    # The -o needs grouping: `-maxdepth 2 -name a -o -maxdepth 2 -name b`
    # parses as (-maxdepth -name a) OR (-maxdepth -name b) with the depth limit
    # applying only to the first branch, and it matched directories too. This
    # reported "tree is incomplete" against two builds whose koffi was present
    # and correct.
    koffi="$(find "$harness/@koromix" -type f \( -name '*.dylib' -o -name '*.node' \) 2>/dev/null | head -1)"
    if [ -n "$koffi" ]; then
      koffi_arch="$(lipo -archs "$koffi" 2>/dev/null || file -b "$koffi")"
      if [ -n "$want" ] && [[ "$koffi_arch" != *"$want"* ]]; then
        bad "harness koffi is $koffi_arch but this slice needs $want — would die on the target"
      else
        ok "harness koffi arch: $koffi_arch"
      fi
    else
      bad "no koffi binary in the staged harness — the tree is incomplete"
    fi

    # Nothing belonging to the other architecture should have shipped.
    other=""
    [ "$want" = "arm64" ] && other="x64"
    [ "$want" = "x86_64" ] && other="arm64"
    if [ -n "$other" ]; then
      strays="$(find "$harness" -maxdepth 2 -type d -name "*-darwin-$other" 2>/dev/null | wc -l | tr -d ' ')"
      if [ "$strays" = "0" ]; then
        ok "no foreign-arch (-darwin-$other) packages shipped"
      else
        note "$strays foreign-arch package(s) shipped — dead weight, not a defect"
      fi
    fi
  else
    bad "no staged harness at Contents/Resources/harness"
  fi
  echo
done

# ── Each DMG ─────────────────────────────────────────────────────────────────
#
# spctl on the DMG itself is the wrong test and used to give the wrong answer.
# electron-builder signs the .app, not the disk image, so `spctl --assess` on a
# perfectly notarized-and-stapled DMG reports "rejected / no usable signature" —
# it is looking for a code signature the container never had. This reported two
# correctly notarized artifacts as not notarized.
#
# The right questions are: does the DMG carry a stapled ticket, and would
# Gatekeeper accept the app a user actually drags out of it? Answer the second
# by mounting the image and assessing the app inside.
dmgs=("$RELEASE"/*.dmg)
# Guard the count, exactly as the .app loop does. Without it a tree with no DMG
# at all printed the ok lines from the .app section, silently skipped this whole
# section, and finished with "all checks passed" and exit 0 — green for a
# release that produced no artifact. (It also diverged by shell: under bash 3.2
# the unguarded expansion aborts with "dmgs[@]: unbound variable".)
if [ ${#dmgs[@]} -eq 0 ]; then
  bad "no .dmg found under $RELEASE — did the build produce an artifact?"
fi
for dmg in ${dmgs[@]+"${dmgs[@]}"}; do
  echo "== $(basename "$dmg")"

  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    ok "notarization ticket stapled to the disk image"
  else
    note "no stapled ticket — run: npm run notarize"
    note "(Gatekeeper on another Mac will block until right-click > Open.)"
    echo
    continue
  fi

  mount="$(hdiutil attach "$dmg" -nobrowse -readonly 2>/dev/null | tail -1 | sed 's/.*\(\/Volumes\/.*\)/\1/')"
  if [ -z "$mount" ] || [ ! -d "$mount" ]; then
    bad "could not mount the image to check the app inside"
    echo
    continue
  fi

  inner="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
  if [ -n "$inner" ]; then
    assess="$(spctl --assess --type execute -vv "$inner" 2>&1)"
    if grep -q "source=Notarized Developer ID" <<<"$assess"; then
      ok "Gatekeeper accepts the app inside: Notarized Developer ID"
    else
      bad "Gatekeeper does NOT accept the app inside: $(head -2 <<<"$assess" | tr '\n' ' ')"
    fi

    # An app that is accepted only because Gatekeeper could reach Apple will
    # fail on a machine that cannot. A stapled ticket travels with the bundle.
    if xcrun stapler validate "$inner" >/dev/null 2>&1; then
      ok "app inside is stapled — validates offline"
    else
      note "app inside is NOT stapled: it passes only while Apple is reachable."
      note "Build with DSHPRO_NOTARIZE=1 so afterSign staples it before packaging."
    fi
  else
    bad "no .app found inside the image"
  fi

  hdiutil detach "$mount" >/dev/null 2>&1
  echo
done

if [ "$fail" -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi
echo "$fail check(s) FAILED"
exit 1
