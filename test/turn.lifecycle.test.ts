import { describe, expect, test } from "bun:test";
import { TURN_PHASE, canTransitionTurnPhase, transitionTurnPhase } from "../src/turns/lifecycle.js";

describe("turn lifecycle", () => {
  test("allows running -> reconnecting -> running -> finalizing -> done", () => {
    const tracker: Record<string, unknown> = { lifecyclePhase: TURN_PHASE.RUNNING };
    expect(canTransitionTurnPhase(TURN_PHASE.RUNNING, TURN_PHASE.RECONNECTING)).toBe(true);
    expect(transitionTurnPhase(tracker, TURN_PHASE.RECONNECTING)).toBe(true);
    expect(tracker.lifecyclePhase).toBe(TURN_PHASE.RECONNECTING);
    expect(transitionTurnPhase(tracker, TURN_PHASE.RUNNING)).toBe(true);
    expect(transitionTurnPhase(tracker, TURN_PHASE.FINALIZING)).toBe(true);
    expect(transitionTurnPhase(tracker, TURN_PHASE.DONE)).toBe(true);
  });

  test("rejects terminal -> running transition", () => {
    const tracker: Record<string, unknown> = { lifecyclePhase: TURN_PHASE.DONE };
    expect(canTransitionTurnPhase(TURN_PHASE.DONE, TURN_PHASE.RUNNING)).toBe(false);
    expect(transitionTurnPhase(tracker, TURN_PHASE.RUNNING)).toBe(false);
    expect(tracker.lifecyclePhase).toBe(TURN_PHASE.DONE);
  });
});
