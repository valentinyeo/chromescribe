#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE="${TLA_CACHE:-$ROOT/.cache/tla}"
JAR="$CACHE/tla2tools.jar"
VER="1.7.4"
SHA_A="936a262061c914694dfd669a543be245"
SHA_B="73c45d5aa0ff20a8b96b23d01e050e88"
SHA="${SHA_A}${SHA_B}"
URL="https://github.com/tlaplus/tlaplus/releases/download/v${VER}/tla2tools.jar"
JAVA_BIN="${JAVA:-java}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ensure_jar() {
  mkdir -p "$CACHE"
  if [[ ! -f "$JAR" ]]; then
    curl -fsSL -o "$JAR.partial" "$URL"
    mv "$JAR.partial" "$JAR"
  fi
  got="$(sha256sum "$JAR" | awk '{print $1}')"
  if [[ "$got" != "$SHA" ]]; then
    echo "tla2tools.jar sha256 mismatch: got $got want $SHA" >&2
    exit 1
  fi
}

run_tlc() {
  local cfg="$1"
  local out="$2"
  cp "$DIR/Queue.tla" "$WORK/Queue.tla"
  cp "$cfg" "$WORK/Queue.cfg"
  set +e
  (
    cd "$WORK"
    "$JAVA_BIN" -XX:+UseParallelGC -jar "$JAR" -config Queue.cfg -workers 1 -deadlock Queue
  ) >"$out" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

expect_pass() {
  local label="$1"
  local cfg="$2"
  local out="$WORK/${label}.out"
  local rc=0
  run_tlc "$cfg" "$out" || rc=$?
  if ! grep -q "Model checking completed. No error has been found." "$out"; then
    echo "FAIL: $label expected pass" >&2
    tail -n 40 "$out" >&2
    exit 1
  fi
  echo "PASS: $label"
  grep -E "states generated|distinct states|Finish computing" "$out" || true
  return 0
}

expect_fail() {
  local label="$1"
  local cfg="$2"
  local inv="$3"
  local out="$WORK/${label}.out"
  local rc=0
  run_tlc "$cfg" "$out" || rc=$?
  if grep -q "Model checking completed. No error has been found." "$out"; then
    echo "FAIL: $label expected invariant $inv to break" >&2
    exit 1
  fi
  if ! grep -q "Invariant $inv is violated" "$out"; then
    echo "FAIL: $label did not violate $inv" >&2
    tail -n 60 "$out" >&2
    exit 1
  fi
  echo "PASS: $label breaks $inv"
  grep -E "Invariant $inv is violated|states generated|distinct states" "$out" || true
}

write_cfg() {
  local path="$1"
  local crash="$2"
  local broken="$3"
  local invs="$4"
  cat >"$path" <<EOF
CONSTANTS
  Videos = {v1, v2}
  Drainers = {d1, d2}
  MaxAttempts = 2
  MaxShares = 2
  EnableCrash = $crash
  Broken = "$broken"

SPECIFICATION Spec

INVARIANT TypeOK
INVARIANT Bound
$invs

CHECK_DEADLOCK FALSE
EOF
}

ensure_jar

MODE="${1:-}"
VARIANT="${2:-}"

if [[ "$MODE" == "--broken" ]]; then
  case "$VARIANT" in
    claim-no-guard)
      write_cfg "$WORK/b.cfg" FALSE claim-no-guard "INVARIANT NoDoubleProcess"
      expect_fail "broken-claim-no-guard" "$WORK/b.cfg" "NoDoubleProcess"
      ;;
    enqueue-no-dedupe)
      write_cfg "$WORK/b.cfg" FALSE enqueue-no-dedupe "INVARIANT NoDupPending"
      expect_fail "broken-enqueue-no-dedupe" "$WORK/b.cfg" "NoDupPending"
      ;;
    crash-no-recovery)
      write_cfg "$WORK/b.cfg" TRUE none "INVARIANT LiveClaim
INVARIANT NoLost"
      expect_fail "broken-crash-no-recovery" "$WORK/b.cfg" "LiveClaim"
      ;;
    *)
      echo "unknown broken variant: $VARIANT" >&2
      echo "usage: $0 [--broken claim-no-guard|enqueue-no-dedupe|crash-no-recovery]" >&2
      exit 2
      ;;
  esac
  exit 0
fi

if [[ -n "$MODE" ]]; then
  echo "usage: $0 [--broken claim-no-guard|enqueue-no-dedupe|crash-no-recovery]" >&2
  exit 2
fi

write_cfg "$WORK/main.cfg" FALSE none "INVARIANT NoDupPending
INVARIANT NoDoubleProcess
INVARIANT NoLost
INVARIANT LiveClaim"
expect_pass "main" "$WORK/main.cfg"

write_cfg "$WORK/finding.cfg" TRUE none "INVARIANT LiveClaim"
expect_fail "finding-crash-stuck" "$WORK/finding.cfg" "LiveClaim"

write_cfg "$WORK/b1.cfg" FALSE claim-no-guard "INVARIANT NoDoubleProcess"
expect_fail "broken-claim-no-guard" "$WORK/b1.cfg" "NoDoubleProcess"

write_cfg "$WORK/b2.cfg" FALSE enqueue-no-dedupe "INVARIANT NoDupPending"
expect_fail "broken-enqueue-no-dedupe" "$WORK/b2.cfg" "NoDupPending"

write_cfg "$WORK/b3.cfg" TRUE none "INVARIANT NoLost"
expect_fail "broken-crash-no-recovery" "$WORK/b3.cfg" "NoLost"

echo "formal/queue check ok"
