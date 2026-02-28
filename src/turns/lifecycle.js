export const TURN_PHASE = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  RECONNECTING: "reconnecting",
  FINALIZING: "finalizing",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [TURN_PHASE.QUEUED]: new Set([TURN_PHASE.RUNNING, TURN_PHASE.CANCELLED, TURN_PHASE.FAILED]),
  [TURN_PHASE.RUNNING]: new Set([
    TURN_PHASE.RECONNECTING,
    TURN_PHASE.FINALIZING,
    TURN_PHASE.DONE,
    TURN_PHASE.FAILED,
    TURN_PHASE.CANCELLED
  ]),
  [TURN_PHASE.RECONNECTING]: new Set([
    TURN_PHASE.RUNNING,
    TURN_PHASE.FINALIZING,
    TURN_PHASE.DONE,
    TURN_PHASE.FAILED,
    TURN_PHASE.CANCELLED
  ]),
  [TURN_PHASE.FINALIZING]: new Set([TURN_PHASE.DONE, TURN_PHASE.FAILED, TURN_PHASE.CANCELLED]),
  [TURN_PHASE.DONE]: new Set(),
  [TURN_PHASE.FAILED]: new Set(),
  [TURN_PHASE.CANCELLED]: new Set()
});

export function canTransitionTurnPhase(current, next) {
  if (!current || !next) {
    return false;
  }
  if (current === next) {
    return true;
  }
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed) {
    return false;
  }
  return allowed.has(next);
}

export function transitionTurnPhase(tracker, nextPhase) {
  if (!tracker || typeof tracker !== "object" || !nextPhase) {
    return false;
  }
  const currentPhase = typeof tracker.lifecyclePhase === "string" ? tracker.lifecyclePhase : TURN_PHASE.QUEUED;
  if (!canTransitionTurnPhase(currentPhase, nextPhase)) {
    return false;
  }
  tracker.lifecyclePhase = nextPhase;
  return true;
}

export function isTerminalTurnPhase(phase) {
  return phase === TURN_PHASE.DONE || phase === TURN_PHASE.FAILED || phase === TURN_PHASE.CANCELLED;
}
