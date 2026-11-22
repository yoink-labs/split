#!/usr/bin/env bash
# Prepare (and optionally submit) the Split App Store version together with
# the "Tip the devs" consumables (dev.yoinklabs.split.tip.*).
#
#   scripts/submit-appstore-tips.sh            # dry run (default): read-only plan + readiness check
#   scripts/submit-appstore-tips.sh --submit   # apply the plan, then submit for review if validate is clean
#   scripts/submit-appstore-tips.sh --submit --force   # submit even if validate reports blocking issues
#   scripts/submit-appstore-tips.sh --submit --iaps-selected-in-asc
#       # the tips were ticked by hand under "In-App Purchases and Subscriptions"
#       # on the version page; skip attaching and only verify they're staged
#
# First-time consumables can't be added to a review submission through the
# public API (STATE_ERROR.FIRST_CONSUMABLE_MUST_BE_SUBMITTED_ON_VERSION). The
# script tries the public API, then asc's documented web-session command
# `asc web review iaps attach`. If both refuse, it stops before submitting:
# tick the tips on the version page in App Store Connect, then rerun with
# --iaps-selected-in-asc. The version is never submitted without every
# READY_TO_SUBMIT tip staged next to it.
#
# Steps
#   1. Read MARKETING_VERSION from project.yml. It is never bumped here.
#   2. Find the editable App Store version (or plan to create one with that
#      string). With --submit, set its versionString to MARKETING_VERSION if it
#      differs.
#   3. Pick the newest VALID, unexpired build of MARKETING_VERSION and attach it.
#   4. List READY_TO_SUBMIT tip IAPs and their editable IAP versions.
#   5. Run `asc validate`. Only with --submit, and only when there are no
#      blocking issues (or --force): stage the App Store version and the tip IAP
#      versions in a review submission draft and submit it.
#
# Dry run makes only read-only asc calls. Requires asc (v7+) and python3.
set -euo pipefail

APP_ID="6836072005"
PLATFORM="IOS"
TIP_PREFIX="dev.yoinklabs.split.tip."

MODE="dry-run"
FORCE=0
IAPS_SELECTED=0

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --submit) MODE="submit" ;;
    --force) FORCE=1 ;;
    --iaps-selected-in-asc) IAPS_SELECTED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_YML="$ROOT/project.yml"

command -v asc >/dev/null || { echo "asc is not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
plan() { printf '   PLAN  %s\n' "$*"; }
ok()   { printf '   OK    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*"; }
die()  { printf '   ERROR %s\n' "$*" >&2; exit 1; }

# Run a read-only asc call and save its JSON stdout. stderr goes to a log file.
asc_json() {
  local out="$1"; shift
  if ! asc "$@" --output json >"$out" 2>"$out.err"; then
    sed 's/^/         /' "$out.err" >&2
    die "asc $* failed"
  fi
}

# Run a mutating asc call; refuses to run in dry-run mode.
asc_mutate() {
  [[ "$MODE" == "submit" ]] || die "internal: mutation attempted in dry-run: asc $*"
  printf '   RUN   asc %s\n' "$*"
  asc "$@" --output json >"$TMP/mutate.json" 2>"$TMP/mutate.err" || {
    sed 's/^/         /' "$TMP/mutate.err" >&2
    die "asc $1 $2 failed"
  }
}

# JSON helper: py FILE 'python expression using d' (d = parsed JSON)
py() {
  local file="$1" code="$2"
  python3 -I -c "
import json, sys
d = json.load(open(sys.argv[1]))
$code
" "$file"
}

say "Split App Store submission ($MODE)  app=$APP_ID platform=$PLATFORM"
[[ "$MODE" == "dry-run" ]] && say "Dry run: read-only asc calls only. Pass --submit to apply."

# ---------------------------------------------------------------------------
step "1. Marketing version (project.yml)"
MVS="$(sed -nE "s/^[[:space:]]*MARKETING_VERSION:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$PROJECT_YML" | sort -u)"
[[ -n "$MVS" && "$(printf '%s\n' "$MVS" | wc -l | tr -d ' ')" == "1" ]] \
  || die "expected exactly one MARKETING_VERSION in project.yml, found: $(echo $MVS)"
MV="$MVS"
ok "MARKETING_VERSION = $MV (never bumped by this script)"

# ---------------------------------------------------------------------------
step "2. Editable App Store version"
asc_json "$TMP/versions.json" versions list --app "$APP_ID" --platform "$PLATFORM" --paginate
EDITABLE_STATES="PREPARE_FOR_SUBMISSION DEVELOPER_REJECTED REJECTED METADATA_REJECTED INVALID_BINARY READY_FOR_REVIEW"
read -r VERSION_ID VERSION_STRING VERSION_STATE < <(py "$TMP/versions.json" "
editable = set('$EDITABLE_STATES'.split())
vs = [v for v in d.get('data', []) if (v['attributes'].get('appVersionState') or v['attributes'].get('appStoreState')) in editable]
vs.sort(key=lambda v: v['attributes'].get('createdDate') or '', reverse=True)
if vs:
    a = vs[0]['attributes']
    print(vs[0]['id'], a.get('versionString'), a.get('appVersionState') or a.get('appStoreState'))
else:
    print('-', '-', '-')
")
# A non-editable version that already uses MV means MV was shipped/in review: stop, never bump.
TAKEN="$(py "$TMP/versions.json" "
print(' '.join(v['id'] + ':' + (v['attributes'].get('appVersionState') or v['attributes'].get('appStoreState') or '?')
  for v in d.get('data', []) if v['attributes'].get('versionString') == '$MV' and v['id'] != '$VERSION_ID'))
")"
[[ -z "$TAKEN" ]] || die "version string $MV is already used by another version ($TAKEN). Bump MARKETING_VERSION in project.yml yourself; this script never bumps."

NEW_VERSION=0
if [[ "$VERSION_ID" == "-" ]]; then
  NEW_VERSION=1
  plan "create App Store version $MV ($PLATFORM)"
  if [[ "$MODE" == "submit" ]]; then
    asc_mutate versions create --app "$APP_ID" --platform "$PLATFORM" --version "$MV"
    VERSION_ID="$(py "$TMP/mutate.json" "print(d['data']['id'])")"
    VERSION_STRING="$MV"; NEW_VERSION=0
    ok "created version $MV ($VERSION_ID)"
  fi
else
  ok "editable version $VERSION_STRING ($VERSION_ID) state=$VERSION_STATE"
  if [[ "$VERSION_STRING" != "$MV" ]]; then
    plan "set versionString $VERSION_STRING -> $MV (matches the build's marketing version)"
    if [[ "$MODE" == "submit" ]]; then
      asc_mutate versions update --version-id "$VERSION_ID" --version "$MV"
      VERSION_STRING="$MV"
      ok "versionString is now $MV"
    fi
  else
    ok "versionString already matches $MV"
  fi
fi

# ---------------------------------------------------------------------------
step "3. Build"
asc_json "$TMP/builds.json" builds list --app "$APP_ID" --platform "$PLATFORM" --version "$MV" \
  --processing-state VALID --exclude-expired --sort -uploadedDate --include preReleaseVersion --limit 200
read -r BUILD_ID BUILD_NUMBER BUILD_UPLOADED < <(py "$TMP/builds.json" "
pre = {i['id']: i['attributes'].get('version') for i in d.get('included', []) if i['type'] == 'preReleaseVersions'}
bs = []
for b in d.get('data', []):
    a = b['attributes']
    rel = ((b.get('relationships') or {}).get('preReleaseVersion') or {}).get('data') or {}
    if a.get('processingState') != 'VALID' or a.get('expired'):
        continue
    if pre and pre.get(rel.get('id')) not in (None, '$MV'):
        continue
    bs.append(b)
bs.sort(key=lambda b: b['attributes'].get('uploadedDate') or '', reverse=True)
if bs:
    print(bs[0]['id'], bs[0]['attributes'].get('version'), bs[0]['attributes'].get('uploadedDate'))
else:
    print('-', '-', '-')
")
[[ "$BUILD_ID" != "-" ]] || die "no VALID, unexpired $MV build found. Upload one first."
ok "newest VALID build: $MV ($BUILD_NUMBER) uploaded $BUILD_UPLOADED id=$BUILD_ID"

ATTACHED_BUILD="-"
if [[ "$NEW_VERSION" == "0" ]]; then
  asc_json "$TMP/version.json" versions view --version-id "$VERSION_ID" --include-build
  ATTACHED_BUILD="$(py "$TMP/version.json" "
rel = ((d['data'].get('relationships') or {}).get('build') or {}).get('data') or {}
inc = [i['id'] for i in d.get('included', []) if i.get('type') == 'builds']
print(rel.get('id') or (inc[0] if inc else '-'))
")"
fi
if [[ "$ATTACHED_BUILD" == "$BUILD_ID" ]]; then
  ok "build $BUILD_NUMBER is already attached"
else
  plan "attach build $MV ($BUILD_NUMBER) to version $MV (currently attached: $ATTACHED_BUILD)"
  if [[ "$MODE" == "submit" ]]; then
    asc_mutate versions attach-build --version-id "$VERSION_ID" --build-id "$BUILD_ID"
    ok "attached build $BUILD_NUMBER"
  fi
fi

# ---------------------------------------------------------------------------
step "4. Tip in-app purchases ($TIP_PREFIX*)"
asc_json "$TMP/iaps.json" iap list --app "$APP_ID" --paginate
py "$TMP/iaps.json" "
for i in sorted(d.get('data', []), key=lambda i: i['attributes'].get('productId') or ''):
    a = i['attributes']
    if (a.get('productId') or '').startswith('$TIP_PREFIX'):
        print(i['id'], a.get('productId'), a.get('state'))
" >"$TMP/tips.txt"
[[ -s "$TMP/tips.txt" ]] || warn "no tip IAPs found"

IAP_VERSION_IDS=()
IAP_LABELS=()
while read -r IAP_ID PRODUCT_ID IAP_STATE; do
  if [[ "$IAP_STATE" != "READY_TO_SUBMIT" ]]; then
    warn "$PRODUCT_ID is $IAP_STATE, skipped"
    continue
  fi
  asc_json "$TMP/iapv-$IAP_ID.json" iap versions list --iap-id "$IAP_ID"
  IAPV="$(py "$TMP/iapv-$IAP_ID.json" "
vs = [v for v in d.get('data', []) if v['attributes'].get('state') == 'PREPARE_FOR_SUBMISSION']
vs.sort(key=lambda v: v['attributes'].get('version') or 0, reverse=True)
print(vs[0]['id'] if vs else '-')
")"
  if [[ "$IAPV" == "-" ]]; then
    warn "$PRODUCT_ID has no editable IAP version, skipped"
    continue
  fi
  IAP_VERSION_IDS+=("$IAPV")
  IAP_LABELS+=("$PRODUCT_ID")
  plan "add $PRODUCT_ID (IAP $IAP_ID, IAP version $IAPV) to the review submission"
done <"$TMP/tips.txt"
ok "${#IAP_VERSION_IDS[@]} tip IAP(s) READY_TO_SUBMIT"

# Existing review submissions for the app
asc_json "$TMP/subs.json" review submissions-list --app "$APP_ID" --platform "$PLATFORM" --paginate
read -r DRAFT_ID BUSY < <(py "$TMP/subs.json" "
subs = d.get('data', [])
draft = [s['id'] for s in subs if s['attributes'].get('state') == 'READY_FOR_REVIEW']
busy = [s['id'] + ':' + s['attributes'].get('state') for s in subs if s['attributes'].get('state') in ('WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES', 'CANCELING', 'COMPLETING')]
print(draft[0] if draft else '-', ','.join(busy) or '-')
")
[[ "$BUSY" == "-" ]] || warn "open review submission(s): $BUSY. Resolve them before submitting again."
if [[ "$DRAFT_ID" != "-" ]]; then
  ok "existing review submission draft $DRAFT_ID will be reused"
else
  plan "create a review submission draft ($PLATFORM)"
fi
plan "add App Store version $MV to the draft, then submit the draft (only with --submit and a clean validate)"

# ---------------------------------------------------------------------------
step "5. Readiness (asc validate)"
if [[ "$NEW_VERSION" == "1" ]]; then
  warn "the version does not exist yet; validate runs after --submit creates it"
  BLOCKING=-1
else
  asc validate --app "$APP_ID" --version-id "$VERSION_ID" --output json >"$TMP/validate.json" 2>"$TMP/validate.err" || true
  [[ -s "$TMP/validate.json" ]] || { sed 's/^/         /' "$TMP/validate.err" >&2; die "asc validate produced no output"; }
  # Issues this script's own steps resolve in --submit mode (dry run only).
  RESOLVED=""
  if [[ "$MODE" == "dry-run" && "$ATTACHED_BUILD" != "$BUILD_ID" ]]; then RESOLVED="build.required.missing"; fi
  BLOCKING="$(py "$TMP/validate.json" "
from collections import OrderedDict
resolved = set('$RESOLVED'.split())
groups = OrderedDict()
for c in d.get('checks', []):
    if c.get('severity') != 'error':
        continue
    key = (c.get('id'), c.get('message'))
    groups.setdefault(key, 0)
    groups[key] += 1
remaining = 0
for (cid, msg), n in groups.items():
    tag = 'resolved by --submit' if cid in resolved else 'BLOCKING'
    if cid not in resolved:
        remaining += n
    sys.stderr.write('   %-20s %s: %s%s\n' % (tag, cid, msg, (' (x%d)' % n) if n > 1 else ''))
warns = [c for c in d.get('checks', []) if c.get('severity') == 'warning']
for c in warns:
    sys.stderr.write('   %-20s %s: %s\n' % ('warning', c.get('id'), c.get('message')))
s = d.get('summary', {})
sys.stderr.write('   summary: %s errors, %s warnings (version %s)\n' % (s.get('errors'), s.get('warnings'), d.get('versionString')))
sys.stderr.flush()
print(remaining)
")"
  say "   Remaining blocking issues: $BLOCKING"
  say "   Not covered by asc validate: App Privacy (nutrition labels) and export compliance answers."
fi

# ---------------------------------------------------------------------------
step "Summary"
say "   Version : $MV ($([[ "$NEW_VERSION" == "1" ]] && echo new || echo "$VERSION_ID"))"
say "   Build   : $MV ($BUILD_NUMBER) $BUILD_ID"
say "   IAPs    : ${IAP_LABELS[*]:-none}"

if [[ "$MODE" == "dry-run" ]]; then
  say ""
  say "Dry run complete. Nothing was changed in App Store Connect."
  exit 0
fi

if [[ "$BUSY" != "-" ]]; then
  die "an existing review submission is in progress ($BUSY); not submitting"
fi
if [[ "$BLOCKING" != "0" ]]; then
  if [[ "$FORCE" == "1" ]]; then
    warn "validate reports $BLOCKING blocking issue(s); continuing because of --force"
  else
    say ""
    say "Not submitted: asc validate reports $BLOCKING blocking issue(s). Fix them, or pass --force."
    exit 1
  fi
fi

step "Submit for review"
if [[ "$DRAFT_ID" == "-" ]]; then
  asc_mutate review submissions-create --app "$APP_ID" --platform "$PLATFORM"
  DRAFT_ID="$(py "$TMP/mutate.json" "print(d['data']['id'])")"
  ok "created review submission draft $DRAFT_ID"
fi
asc_mutate review items-add --submission "$DRAFT_ID" --item-type appStoreVersions --item-id "$VERSION_ID" --if-exists skip
ok "added App Store version $MV"

# IAP version ids currently staged in the draft.
staged_iaps() {
  asc review items-list --submission "$DRAFT_ID" --paginate --output json >"$TMP/items.json" 2>"$TMP/items.err" \
    || { sed 's/^/         /' "$TMP/items.err" >&2; die "asc review items-list failed"; }
  py "$TMP/items.json" "
ids = set()
for it in d.get('data', []):
    rel = (it.get('relationships') or {}).get('inAppPurchaseVersion') or {}
    if (rel.get('data') or {}).get('id'):
        ids.add(rel['data']['id'])
print(' '.join(sorted(ids)))
"
}

if [[ "$IAPS_SELECTED" == "1" ]]; then
  say "   --iaps-selected-in-asc: not attaching; checking the tips are staged"
else
  STAGED=" $(staged_iaps) "
  for ((idx = 0; idx < ${#IAP_VERSION_IDS[@]}; idx++)); do
    IAPV="${IAP_VERSION_IDS[$idx]}"; LABEL="${IAP_LABELS[$idx]}"
    if [[ "$STAGED" == *" $IAPV "* ]]; then ok "$LABEL already staged"; continue; fi
    printf '   RUN   asc review items-add --submission %s --item-type inAppPurchaseVersions --item-id %s\n' "$DRAFT_ID" "$IAPV"
    if asc review items-add --submission "$DRAFT_ID" --item-type inAppPurchaseVersions --item-id "$IAPV" \
         --if-exists skip --output json >"$TMP/iapadd.json" 2>"$TMP/iapadd.err"; then
      ok "added $LABEL (public API)"
      continue
    fi
    warn "public API refused $LABEL:"
    sed 's/^/         /' "$TMP/iapadd.err" >&2
    printf '   RUN   asc web review iaps attach --app %s --iap-id %s --submission %s --confirm\n' "$APP_ID" "$LABEL" "$DRAFT_ID"
    if asc web review iaps attach --app "$APP_ID" --iap-id "$LABEL" --submission "$DRAFT_ID" --confirm \
         --output json >"$TMP/webattach.json" 2>"$TMP/webattach.err"; then
      ok "added $LABEL (asc web review iaps attach)"
    else
      warn "asc web review iaps attach refused $LABEL:"
      sed 's/^/         /' "$TMP/webattach.err" >&2
    fi
  done
fi

# Never submit the version without every READY_TO_SUBMIT tip next to it.
STAGED=" $(staged_iaps) "
MISSING=()
for ((idx = 0; idx < ${#IAP_VERSION_IDS[@]}; idx++)); do
  [[ "$STAGED" == *" ${IAP_VERSION_IDS[$idx]} "* ]] || MISSING+=("${IAP_LABELS[$idx]}")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  say ""
  say "Not submitted. These tips aren't staged in review submission $DRAFT_ID: ${MISSING[*]}"
  say "In App Store Connect, open the $MV version page, tick them under"
  say "\"In-App Purchases and Subscriptions\", save, then run:"
  say "  scripts/submit-appstore-tips.sh --submit --iaps-selected-in-asc"
  exit 3
fi
ok "all ${#IAP_VERSION_IDS[@]} tip IAPs are staged with version $MV"
asc_mutate review submissions-submit --id "$DRAFT_ID" --confirm
ok "submitted review submission $DRAFT_ID for App Review"
