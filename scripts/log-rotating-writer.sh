#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --file <path> [--max-bytes <bytes>] [--max-files <count>]" >&2
}

LOG_FILE=""
MAX_BYTES="${DISCORD_LOG_ROTATE_MAX_BYTES:-10485760}"
MAX_FILES="${DISCORD_LOG_ROTATE_MAX_FILES:-5}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --file)
      LOG_FILE="${2:-}"
      shift 2
      ;;
    --max-bytes)
      MAX_BYTES="${2:-}"
      shift 2
      ;;
    --max-files)
      MAX_FILES="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${LOG_FILE}" ]]; then
  usage
  exit 1
fi

if ! [[ "${MAX_BYTES}" =~ ^[0-9]+$ ]] || ! [[ "${MAX_FILES}" =~ ^[0-9]+$ ]] || (( MAX_FILES < 1 )); then
  echo "Invalid rotation config: max-bytes=${MAX_BYTES}, max-files=${MAX_FILES}" >&2
  exit 1
fi

mkdir -p "$(dirname "${LOG_FILE}")"
touch "${LOG_FILE}"

rotate_if_needed() {
  local size idx
  size=0
  if [[ -f "${LOG_FILE}" ]]; then
    size="$(wc -c < "${LOG_FILE}" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "${size}" ]]; then
      size=0
    fi
  fi
  if ! [[ "${size}" =~ ^[0-9]+$ ]] || (( size < MAX_BYTES )); then
    return
  fi

  rm -f "${LOG_FILE}.${MAX_FILES}" 2>/dev/null || true
  idx=$((MAX_FILES - 1))
  while (( idx >= 1 )); do
    if [[ -f "${LOG_FILE}.${idx}" ]]; then
      mv "${LOG_FILE}.${idx}" "${LOG_FILE}.$((idx + 1))" 2>/dev/null || true
    fi
    idx=$((idx - 1))
  done
  if [[ -f "${LOG_FILE}" ]]; then
    mv "${LOG_FILE}" "${LOG_FILE}.1" 2>/dev/null || true
  fi
  : > "${LOG_FILE}"
}

while IFS= read -r line || [[ -n "${line:-}" ]]; do
  rotate_if_needed
  printf '%s\n' "${line}" >>"${LOG_FILE}"
done
