#!/usr/bin/env bash
set -euo pipefail

# Host-managed restart supervisor for agent-gateway.
# Watches a restart-request signal file and restarts the bridge process.
#
# Usage:
#   scripts/restart-supervisor.sh -- bun run start
#
# Env overrides:
#   RESTART_REQUEST_PATH   (default: data/restart-request.json)
#   RESTART_ACK_PATH       (default: data/restart-ack.json)
#   HEARTBEAT_PATH         (default: data/bridge-heartbeat.json)
#   RESTART_POLL_INTERVAL  (seconds, default: 3)
#   RESTART_MIN_INTERVAL   (seconds, default: 15)
#   RESTART_DRAIN_TIMEOUT  (seconds, default: 120)
#   RESTART_DRAIN_POLL     (seconds, default: 2)

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: $0 -- <bridge command...>" >&2
  exit 1
fi
shift

if [[ "$#" -eq 0 ]]; then
  echo "Missing bridge command. Example: $0 -- bun run start" >&2
  exit 1
fi

# launchd ProgramArguments can accidentally include empty entries.
while [[ "$#" -gt 0 && -z "${1}" ]]; do
  shift
done

if [[ "$#" -eq 0 ]]; then
  echo "Bridge command is empty after '--' (check LaunchAgent ProgramArguments)." >&2
  exit 1
fi

RESTART_REQUEST_PATH="${RESTART_REQUEST_PATH:-data/restart-request.json}"
RESTART_ACK_PATH="${RESTART_ACK_PATH:-data/restart-ack.json}"
HEARTBEAT_PATH="${HEARTBEAT_PATH:-data/bridge-heartbeat.json}"
RESTART_POLL_INTERVAL="${RESTART_POLL_INTERVAL:-3}"
RESTART_MIN_INTERVAL="${RESTART_MIN_INTERVAL:-15}"
RESTART_DRAIN_TIMEOUT="${RESTART_DRAIN_TIMEOUT:-120}"
RESTART_DRAIN_POLL="${RESTART_DRAIN_POLL:-2}"
RESTART_SUPERVISOR_LOG_PATH="${RESTART_SUPERVISOR_LOG_PATH:-data/restart-supervisor.log}"
BRIDGE_STDOUT_LOG_PATH="${DISCORD_STDOUT_LOG_PATH:-data/logs/bridge.stdout.log}"
BRIDGE_STDERR_LOG_PATH="${DISCORD_STDERR_LOG_PATH:-data/logs/bridge.stderr.log}"
DISCORD_LOG_ROTATE_MAX_BYTES="${DISCORD_LOG_ROTATE_MAX_BYTES:-10485760}"
DISCORD_LOG_ROTATE_MAX_FILES="${DISCORD_LOG_ROTATE_MAX_FILES:-5}"
RESTART_MAX_ATTEMPTS_WINDOW="${RESTART_MAX_ATTEMPTS_WINDOW:-6}"
RESTART_WINDOW_SECONDS="${RESTART_WINDOW_SECONDS:-300}"
RESTART_COOLDOWN_SECONDS="${RESTART_COOLDOWN_SECONDS:-120}"

LOG_WRITER_SCRIPT="${LOG_WRITER_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/log-rotating-writer.sh}"

child_pid=""
last_request_sig=""
last_restart_epoch=0
restart_history_file=""

init_restart_history_file() {
  local tmp_root
  tmp_root="${TMPDIR:-/tmp}"
  restart_history_file="${tmp_root%/}/agent-gateway-restart-history.$$"
  : >"${restart_history_file}"
}

cleanup_restart_history_file() {
  if [[ -n "${restart_history_file}" ]]; then
    rm -f "${restart_history_file}" 2>/dev/null || true
  fi
}

register_restart_timestamp() {
  local now cutoff count
  now="$(date +%s)"
  cutoff=$((now - RESTART_WINDOW_SECONDS))
  echo "${now}" >>"${restart_history_file}"
  awk -v cutoff="${cutoff}" '{ if ($1 >= cutoff) print $1 }' "${restart_history_file}" >"${restart_history_file}.tmp"
  mv "${restart_history_file}.tmp" "${restart_history_file}"
  count="$(wc -l < "${restart_history_file}" | tr -d '[:space:]')"
  if [[ "${count}" =~ ^[0-9]+$ ]] && (( count > RESTART_MAX_ATTEMPTS_WINDOW )); then
    echo "[supervisor] restart storm detected (${count}/${RESTART_MAX_ATTEMPTS_WINDOW} in ${RESTART_WINDOW_SECONDS}s); cooling down ${RESTART_COOLDOWN_SECONDS}s"
    log_supervisor_event "restart_cooldown" "restart_storm" "count=${count}, window=${RESTART_WINDOW_SECONDS}s, cooldown=${RESTART_COOLDOWN_SECONDS}s"
    sleep "${RESTART_COOLDOWN_SECONDS}"
    : >"${restart_history_file}"
  fi
}

log_supervisor_event() {
  local event reason detail now
  event="$1"
  reason="${2:-}"
  detail="${3:-}"
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$(dirname "${RESTART_SUPERVISOR_LOG_PATH}")" 2>/dev/null || true
  printf '{"timestamp":"%s","event":"%s","reason":"%s","detail":"%s","pid":%s}\n' \
    "${now}" "${event}" "${reason}" "${detail}" "${$}" >>"${RESTART_SUPERVISOR_LOG_PATH}" 2>/dev/null || true
}

start_child() {
  echo "[supervisor] starting bridge: $*"
  log_supervisor_event "bridge_start" "spawn" "$*"
  mkdir -p "$(dirname "${BRIDGE_STDOUT_LOG_PATH}")" "$(dirname "${BRIDGE_STDERR_LOG_PATH}")"
  if [[ -x "${LOG_WRITER_SCRIPT}" ]]; then
    "$@" \
      > >("${LOG_WRITER_SCRIPT}" --file "${BRIDGE_STDOUT_LOG_PATH}" --max-bytes "${DISCORD_LOG_ROTATE_MAX_BYTES}" --max-files "${DISCORD_LOG_ROTATE_MAX_FILES}") \
      2> >("${LOG_WRITER_SCRIPT}" --file "${BRIDGE_STDERR_LOG_PATH}" --max-bytes "${DISCORD_LOG_ROTATE_MAX_BYTES}" --max-files "${DISCORD_LOG_ROTATE_MAX_FILES}") &
  else
    echo "[supervisor] warning: log writer not executable (${LOG_WRITER_SCRIPT}); falling back to direct append" >&2
    "$@" >>"${BRIDGE_STDOUT_LOG_PATH}" 2>>"${BRIDGE_STDERR_LOG_PATH}" &
  fi
  child_pid="$!"
}

stop_child() {
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    echo "[supervisor] stopping bridge pid=${child_pid}"
    log_supervisor_event "bridge_stop" "signal_term" "pid=${child_pid}"
    kill "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  child_pid=""
}

read_active_turns() {
  if [[ ! -f "${HEARTBEAT_PATH}" ]]; then
    echo ""
    return
  fi
  sed -n 's/.*"activeTurns"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${HEARTBEAT_PATH}" | head -n 1
}

wait_for_turn_drain() {
  local start_epoch now_epoch waited active_turns
  start_epoch="$(date +%s)"
  while true; do
    active_turns="$(read_active_turns)"
    if [[ -n "${active_turns}" && "${active_turns}" -eq 0 ]]; then
      return
    fi
    now_epoch="$(date +%s)"
    waited=$((now_epoch - start_epoch))
    if (( waited >= RESTART_DRAIN_TIMEOUT )); then
      echo "[supervisor] drain timeout reached (${RESTART_DRAIN_TIMEOUT}s); forcing restart"
      log_supervisor_event "restart_drain_timeout" "force_restart" "waited=${waited}s"
      return
    fi
    echo "[supervisor] restart pending: waiting for active turns to drain (activeTurns=${active_turns:-unknown}, waited=${waited}s)"
    sleep "${RESTART_DRAIN_POLL}"
  done
}

handle_exit() {
  stop_child
  cleanup_restart_history_file
  exit 0
}

trap handle_exit INT TERM

init_restart_history_file

start_child "$@"
register_restart_timestamp

while true; do
  if [[ -n "${child_pid}" ]] && ! kill -0 "${child_pid}" 2>/dev/null; then
    wait "${child_pid}" 2>/dev/null || true
    echo "[supervisor] bridge exited unexpectedly; restarting"
    log_supervisor_event "bridge_exit" "unexpected_exit" "pid=${child_pid}"
    start_child "$@"
    register_restart_timestamp
  fi

  if [[ -f "${RESTART_REQUEST_PATH}" ]]; then
    request_sig="$(cat "${RESTART_REQUEST_PATH}" 2>/dev/null | shasum | awk '{print $1}')"
    if [[ -n "${request_sig}" && "${request_sig}" != "${last_request_sig}" ]]; then
      now_epoch="$(date +%s)"
      since_last=$((now_epoch - last_restart_epoch))
      if (( since_last < RESTART_MIN_INTERVAL )); then
        sleep_for=$((RESTART_MIN_INTERVAL - since_last))
        echo "[supervisor] restart requested but throttled (${since_last}s < ${RESTART_MIN_INTERVAL}s). sleeping ${sleep_for}s"
        log_supervisor_event "restart_throttled" "min_interval" "sleep=${sleep_for}s"
        sleep "${sleep_for}"
      fi

      echo "[supervisor] restart request detected at ${RESTART_REQUEST_PATH}"
      log_supervisor_event "restart_requested" "signal_file" "path=${RESTART_REQUEST_PATH}"
      last_request_sig="${request_sig}"
      last_restart_epoch="$(date +%s)"
      mkdir -p "$(dirname "${RESTART_ACK_PATH}")"
      cat >"${RESTART_ACK_PATH}" <<EOF
{
  "acknowledgedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "requestSignature": "${request_sig}"
}
EOF
      wait_for_turn_drain
      stop_child
      start_child "$@"
      register_restart_timestamp
      log_supervisor_event "restart_completed" "bridge_restarted" "request_path=${RESTART_REQUEST_PATH}"
      rm -f "${RESTART_REQUEST_PATH}" 2>/dev/null || true
    fi
  fi

  sleep "${RESTART_POLL_INTERVAL}"
done
