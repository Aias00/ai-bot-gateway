import { describe, expect, test } from "bun:test";
import { extractStreamingAppend, normalizeFinalSummaryText, normalizeStreamingSnapshotText } from "../src/turns/textNormalization.js";

describe("normalizeFinalSummaryText", () => {
  test("collapses repeated paragraph blocks", () => {
    const text = [
      "我刚重新扫了一遍 /Users/jonashan/ai-agent：",
      "",
      "- ls -la 只有 . 和 ..",
      "",
      "结论很直接：这里是个空目录。",
      "",
      "我刚重新扫了一遍 /Users/jonashan/ai-agent：",
      "",
      "- ls -la 只有 . 和 ..",
      "",
      "结论很直接：这里是个空目录。"
    ].join("\n");

    expect(normalizeFinalSummaryText(text)).toBe([
      "我刚重新扫了一遍 /Users/jonashan/ai-agent：",
      "",
      "- ls -la 只有 . 和 ..",
      "",
      "结论很直接：这里是个空目录。"
    ].join("\n"));
  });

  test("extractStreamingAppend keeps only the new suffix from snapshot-like deltas", () => {
    expect(extractStreamingAppend("", "第一段")).toBe("第一段");
    expect(extractStreamingAppend("第一段", "第一段")).toBe("");
    expect(extractStreamingAppend("第一段", "第一段\n\n第二段")).toBe("\n\n第二段");
    expect(extractStreamingAppend("第一段\n\n第二段", "第一段\n\n第二段\n\n第三段")).toBe("\n\n第三段");
  });

  test("normalizeStreamingSnapshotText collapses repeated prefix paragraph blocks", () => {
    const text = [
      "一句话结论",
      "",
      "- 对每个路由做 turn 队列串行执行",
      "",
      "最关键的 3 个风险",
      "",
      "一句话结论",
      "",
      "- 对每个路由做 turn 队列串行执行",
      "",
      "最关键的 3 个风险",
      "",
      "下一步建议"
    ].join("\n");

    expect(normalizeStreamingSnapshotText(text)).toBe([
      "一句话结论",
      "",
      "- 对每个路由做 turn 队列串行执行",
      "",
      "最关键的 3 个风险",
      "",
      "下一步建议"
    ].join("\n"));
  });
});
