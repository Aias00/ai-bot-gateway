import { describe, expect, test } from "bun:test";
import {
  buildResponseForServerRequest,
  parseApprovalButtonCustomId
} from "../src/codex/approvalPayloads.js";

describe("approval payloads", () => {
  test("maps exec/apply approval decisions to review decision format", () => {
    expect(buildResponseForServerRequest("execCommandApproval", {}, "accept")).toEqual({ decision: "approved" });
    expect(buildResponseForServerRequest("applyPatchApproval", {}, "decline")).toEqual({ decision: "denied" });
    expect(buildResponseForServerRequest("applyPatchApproval", {}, "cancel")).toEqual({ decision: "abort" });
  });

  test("builds tool request user input answers using matching option labels", () => {
    const response = buildResponseForServerRequest(
      "item/tool/requestUserInput",
      {
        questions: [
          {
            id: "confirm",
            options: [{ label: "Continue" }, { label: "Cancel" }]
          },
          {
            id: "mode",
            options: [{ label: "Decline" }, { label: "Approve" }]
          }
        ]
      },
      "accept"
    );

    expect(response).toEqual({
      answers: {
        confirm: { answers: ["Continue"] },
        mode: { answers: ["Approve"] }
      }
    });
  });

  test("parses approval button custom ids", () => {
    expect(parseApprovalButtonCustomId("approval:0007:accept", "approval:")).toEqual({
      token: "0007",
      decision: "accept"
    });
    expect(parseApprovalButtonCustomId("approval:0008:noop", "approval:")).toBeNull();
    expect(parseApprovalButtonCustomId("other:0008:accept", "approval:")).toBeNull();
  });
});
