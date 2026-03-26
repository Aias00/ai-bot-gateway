import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentInputBuilder } from "../src/attachments/inputBuilder.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    })
  );
});

describe("attachment input builder", () => {
  test("includes rich metadata and preview for text file attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-text-"));
    tempDirs.add(tempDir);
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf8");

    const builder = createAttachmentInputBuilder({
      fs,
      imageCacheDir: tempDir,
      maxImagesPerMessage: 4,
      discordToken: "",
      fetch: globalThis.fetch,
      formatInputTextForSetup: (text: string) => text,
      logger: console
    });

    const inputItems = await builder.buildTurnInputFromMessage(
      { id: "msg-1" },
      "please inspect the file",
      [
        {
          kind: "file",
          path: filePath,
          name: "notes.txt",
          contentType: "text/plain"
        }
      ],
      null
    );

    expect(inputItems).toHaveLength(1);
    expect(inputItems[0]?.type).toBe("text");
    const text = String(inputItems[0]?.text ?? "");
    expect(text).toContain("please inspect the file");
    expect(text).toContain("[Attached files from chat]");
    expect(text).toContain(`path: ${filePath}`);
    expect(text).toContain("name: notes.txt");
    expect(text).toContain("extension: .txt");
    expect(text).toContain("content-type: text/plain");
    expect(text).toContain("size-bytes:");
    expect(text).toContain("preview-status: complete");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  test("skips preview body for binary attachments while keeping metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-bin-"));
    tempDirs.add(tempDir);
    const filePath = path.join(tempDir, "archive.zip");
    await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));

    const builder = createAttachmentInputBuilder({
      fs,
      imageCacheDir: tempDir,
      maxImagesPerMessage: 4,
      discordToken: "",
      fetch: globalThis.fetch,
      formatInputTextForSetup: (text: string) => text,
      logger: console
    });

    const inputItems = await builder.buildTurnInputFromMessage(
      { id: "msg-2" },
      "",
      [
        {
          kind: "file",
          path: filePath,
          name: "archive.zip",
          contentType: "application/zip"
        }
      ],
      null
    );

    expect(inputItems).toHaveLength(1);
    const text = String(inputItems[0]?.text ?? "");
    expect(text).toContain(`path: ${filePath}`);
    expect(text).toContain("name: archive.zip");
    expect(text).toContain("content-type: application/zip");
    expect(text).toContain("preview-status: skipped (non-text attachment)");
    expect(text).not.toContain("preview:\n");
  });

  test("parses uploaded xlsx attachments into a sheet preview", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-xlsx-"));
    tempDirs.add(tempDir);

    const builder = createAttachmentInputBuilder({
      fs: {
        ...fs,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
        rm: fs.rm
      },
      imageCacheDir: tempDir,
      maxImagesPerMessage: 4,
      attachmentMaxBytes: 1024 * 1024,
      discordToken: "",
      fetch: async (url: string) => {
        expect(url).toBe("https://files.example/report.xlsx");
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from("fake-xlsx-binary")
        };
      },
      execFileAsync: async (_command: string, args: string[]) => {
        const entry = args[2];
        const byEntry: Record<string, string> = {
          "xl/workbook.xml":
            '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
          "xl/_rels/workbook.xml.rels":
            '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
          "xl/sharedStrings.xml":
            '<?xml version="1.0"?><sst><si><t>name</t></si><si><t>cpu</t></si><si><t>srv-a</t></si><si><t>16</t></si></sst>',
          "xl/worksheets/sheet1.xml":
            '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>'
        };
        if (!(entry in byEntry)) {
          throw new Error(`missing unzip entry: ${entry}`);
        }
        return { stdout: byEntry[entry] };
      },
      formatInputTextForSetup: (text: string) => text,
      logger: console
    });

    const inputItems = await builder.buildTurnInputFromMessage(
      {
        id: "msg-3",
        attachments: new Map([
          [
            "file-1",
            {
              id: "file-1",
              name: "report.xlsx",
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              url: "https://files.example/report.xlsx"
            }
          ]
        ])
      },
      "分析这个表格",
      [],
      null
    );

    expect(inputItems).toHaveLength(1);
    const text = String(inputItems[0]?.text ?? "");
    expect(text).toContain("分析这个表格");
    expect(text).toContain("[Attached files from chat]");
    expect(text).toContain("Spreadsheet: report.xlsx");
    expect(text).toContain("Sheet: Sheet1");
    expect(text).toContain("Columns: name | cpu");
    expect(text).toContain("srv-a | 16");
  });
});
