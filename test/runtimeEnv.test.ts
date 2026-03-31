import { describe, expect, test } from "bun:test";
import { loadRuntimeEnv } from "../src/config/runtimeEnv.js";

describe("runtime env", () => {
  test("loads restart notify fallback without reference errors", () => {
    const previous = process.env.FEISHU_GENERAL_CHAT_ID;
    delete process.env.FEISHU_GENERAL_CHAT_ID;
    try {
      const env = loadRuntimeEnv();
      expect(typeof env.restartNotifyRouteId).toBe("string");
    } finally {
      if (previous === undefined) {
        delete process.env.FEISHU_GENERAL_CHAT_ID;
      } else {
        process.env.FEISHU_GENERAL_CHAT_ID = previous;
      }
    }
  });

  test("includes repo root in attachment roots", () => {
    const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
    const previousProjectsRoot = process.env.PROJECTS_ROOT;
    const previousRepoRoot = process.env.DISCORD_REPO_ROOT;
    const previousAttachmentRoots = process.env.DISCORD_ATTACHMENT_ROOTS;
    // Clear higher-priority vars to isolate DISCORD_REPO_ROOT behavior
    delete process.env.WORKSPACE_ROOT;
    delete process.env.PROJECTS_ROOT;
    process.env.DISCORD_REPO_ROOT = "/Volumes/data/workspace";
    delete process.env.DISCORD_ATTACHMENT_ROOTS;
    try {
      const env = loadRuntimeEnv();
      expect(env.attachmentRoots).toContain("/Volumes/data/workspace");
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.WORKSPACE_ROOT;
      } else {
        process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
      }
      if (previousProjectsRoot === undefined) {
        delete process.env.PROJECTS_ROOT;
      } else {
        process.env.PROJECTS_ROOT = previousProjectsRoot;
      }
      if (previousRepoRoot === undefined) {
        delete process.env.DISCORD_REPO_ROOT;
      } else {
        process.env.DISCORD_REPO_ROOT = previousRepoRoot;
      }
      if (previousAttachmentRoots === undefined) {
        delete process.env.DISCORD_ATTACHMENT_ROOTS;
      } else {
        process.env.DISCORD_ATTACHMENT_ROOTS = previousAttachmentRoots;
      }
    }
  });

  test("reads attachment log flag", () => {
    const previous = process.env.DISCORD_LOG_ATTACHMENTS;
    process.env.DISCORD_LOG_ATTACHMENTS = "1";
    try {
      const env = loadRuntimeEnv();
      expect(env.attachmentLogEnabled).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.DISCORD_LOG_ATTACHMENTS;
      } else {
        process.env.DISCORD_LOG_ATTACHMENTS = previous;
      }
    }
  });
});
