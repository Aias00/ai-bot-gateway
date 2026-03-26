import path from "node:path";

const DEFAULT_FILE_PREVIEW_MAX_BYTES = 16 * 1024;
const DEFAULT_FILE_PREVIEW_MAX_CHARS = 4000;
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".zsh",
  ".bash",
  ".sql",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".lock",
  ".csv"
]);

export function createAttachmentInputBuilder(deps) {
  const {
    fs,
    imageCacheDir,
    maxImagesPerMessage,
    discordToken,
    fetch,
    formatInputTextForSetup,
    logger,
    filePreviewMaxBytes = DEFAULT_FILE_PREVIEW_MAX_BYTES,
    filePreviewMaxChars = DEFAULT_FILE_PREVIEW_MAX_CHARS,
    attachmentMaxBytes,
    execFileAsync
  } = deps;

  function collectImageAttachments(message) {
    if (!message?.attachments?.size) {
      return [];
    }
    const all = [...message.attachments.values()];
    return all.filter((attachment) => isImageAttachment(attachment)).slice(0, Math.max(0, maxImagesPerMessage));
  }

  async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
    const inputItems = [];
    const normalizedAttachments = normalizeAttachments(imageAttachments);
    const trimmed = typeof text === "string" ? text.trim() : "";
    const documentAttachmentBlocks = await downloadDocumentAttachments(message, normalizedAttachments);
    const combinedText = combinePromptAndTextAttachments(trimmed, documentAttachmentBlocks, setup);
    if (combinedText) {
      inputItems.push({ type: "text", text: combinedText });
    }

    const localImages = await downloadImageAttachments(collectImageLikeAttachments(normalizedAttachments), message.id);
    inputItems.push(...localImages);
    return inputItems;
  }

  function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments)) {
      return [];
    }
    return attachments.filter((attachment) => attachment && typeof attachment === "object");
  }

  function collectImageLikeAttachments(attachments) {
    return attachments.filter((attachment) => isImageAttachment(attachment));
  }

  async function downloadImageAttachments(attachments, messageId) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    await fs.mkdir(imageCacheDir, { recursive: true });
    const images = [];

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const downloaded = await downloadImageAttachment(attachment, messageId, index + 1);
      if (downloaded) {
        images.push(downloaded);
        continue;
      }
      if (typeof attachment?.url === "string" && attachment.url) {
        images.push({ type: "image", url: attachment.url });
      }
    }

    return images;
  }

  async function downloadImageAttachment(attachment, messageId, ordinal) {
    const localPath = resolveLocalImagePath(attachment);
    if (localPath) {
      return { type: "localImage", path: localPath };
    }

    const sourceUrls = [attachment?.proxyURL, attachment?.url]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (sourceUrls.length === 0) {
      return null;
    }

    try {
      const bytes = await fetchDiscordAttachmentBytes(sourceUrls);
      if (bytes.length === 0) {
        return null;
      }
      const extension = guessImageExtension(attachment);
      const fileName = `${Date.now()}-${messageId}-${ordinal}${extension}`;
      const filePath = path.join(imageCacheDir, fileName);
      await fs.writeFile(filePath, bytes);
      return { type: "localImage", path: filePath };
    } catch (error) {
      logger?.warn?.(`failed to download Discord image attachment ${attachment?.id ?? "unknown"}: ${error.message}`);
      return null;
    }
  }

  async function fetchDiscordAttachmentBytes(sourceUrls) {
    const seen = new Set();
    const urls = [];
    for (const sourceUrl of sourceUrls) {
      if (!seen.has(sourceUrl)) {
        seen.add(sourceUrl);
        urls.push(sourceUrl);
      }
    }

    const authHeaders = discordToken ? { Authorization: `Bot ${discordToken}` } : null;
    const attempts = [];
    for (const sourceUrl of urls) {
      attempts.push({ sourceUrl, headers: authHeaders });
      attempts.push({ sourceUrl, headers: null });
    }

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.sourceUrl, {
          headers: attempt.headers ?? undefined
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("attachment download failed");
  }

  async function downloadDocumentAttachments(message, imageAttachments) {
    const attachments = collectDocumentAttachments(message, imageAttachments);
    if (attachments.length === 0) {
      return [];
    }

    const blocks = [];
    for (const attachment of attachments) {
      const localPath = resolveLocalAttachmentPath(attachment);
      if (localPath) {
        blocks.push(await buildLocalAttachmentBlock(attachment, localPath));
        continue;
      }

      if (!isTextAttachment(attachment) && !isSpreadsheetAttachment(attachment)) {
        blocks.push(formatSkippedAttachmentBlock(attachment, "unsupported attachment type"));
        continue;
      }

      const sourceUrls = [attachment?.proxyURL, attachment?.url]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
      if (sourceUrls.length === 0) {
        continue;
      }

      try {
        const bytes = await fetchDiscordAttachmentBytes(sourceUrls);
        if (bytes.length === 0) {
          continue;
        }
        if (attachmentMaxBytes && bytes.length > attachmentMaxBytes) {
          blocks.push(formatSkippedAttachmentBlock(attachment, `too large (${bytes.length} bytes)`));
          continue;
        }

        if (isSpreadsheetAttachment(attachment)) {
          const spreadsheetBlock = await parseSpreadsheetAttachment(attachment, bytes);
          blocks.push(spreadsheetBlock ?? formatSkippedAttachmentBlock(attachment, "spreadsheet parse failed"));
          continue;
        }

        const decoded = decodeTextAttachment(bytes);
        if (!decoded) {
          blocks.push(formatSkippedAttachmentBlock(attachment, "unsupported binary or non-text content"));
          continue;
        }

        blocks.push(formatTextAttachmentBlock(attachment, decoded.text, decoded.truncated));
      } catch (error) {
        logger?.warn?.(`failed to download Discord text attachment ${attachment?.id ?? "unknown"}: ${error.message}`);
      }
    }

    return blocks;
  }

  function collectDocumentAttachments(message, imageAttachments) {
    const imageIds = new Set((Array.isArray(imageAttachments) ? imageAttachments : []).map((entry) => entry?.id).filter(Boolean));
    const messageAttachments = message?.attachments?.size ? [...message.attachments.values()] : [];
    const directAttachments = Array.isArray(imageAttachments) ? imageAttachments : [];
    const merged = [...directAttachments, ...messageAttachments];
    const seenKeys = new Set();
    return merged.filter((attachment) => {
      if (!attachment || imageIds.has(attachment.id)) {
        return false;
      }
      const key = attachment.id ?? attachment.path ?? attachment.url ?? attachment.proxyURL ?? attachment.name;
      if (key && seenKeys.has(key)) {
        return false;
      }
      if (key) {
        seenKeys.add(key);
      }
      return true;
    });
  }

  function isImageAttachment(attachment) {
    if (!attachment) {
      return false;
    }
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    if (contentType.startsWith("image/")) {
      return true;
    }
    const name = String(attachment.name ?? "").toLowerCase();
    return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(name);
  }

  function isTextAttachment(attachment) {
    if (!attachment) {
      return false;
    }
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    if (
      contentType.startsWith("text/") ||
      /^(application\/json|application\/(xml|yaml|x-yaml)|application\/javascript|application\/typescript)$/.test(contentType)
    ) {
      return true;
    }

    const name = String(attachment.name ?? "").toLowerCase();
    return /\.(txt|md|markdown|json|ya?ml|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|sh|zsh|bash|sql|toml|ini|cfg|conf|env|lock|csv)$/i.test(
      name
    );
  }

  function isSpreadsheetAttachment(attachment) {
    if (!attachment) {
      return false;
    }
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    if (
      contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      contentType === "application/vnd.ms-excel.sheet.macroenabled.12"
    ) {
      return true;
    }
    const name = String(attachment.name ?? "").toLowerCase();
    return /\.xlsx$/i.test(name);
  }

  function guessImageExtension(attachment) {
    const byName = path.extname(String(attachment?.name ?? "")).toLowerCase();
    if (byName && byName.length <= 10) {
      return byName;
    }
    const contentType = String(attachment?.contentType ?? "").toLowerCase();
    const known = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/bmp": ".bmp",
      "image/tiff": ".tif",
      "image/svg+xml": ".svg"
    };
    return known[contentType] ?? ".png";
  }

  function resolveLocalAttachmentPath(attachment) {
    if (!attachment || typeof attachment !== "object") {
      return "";
    }
    const localPath = typeof attachment.path === "string" ? attachment.path.trim() : "";
    return localPath ? path.resolve(localPath) : "";
  }

  function resolveLocalImagePath(attachment) {
    return resolveLocalAttachmentPath(attachment);
  }

  async function buildLocalAttachmentBlock(attachment, localPath) {
    const normalized = {
      path: localPath,
      name:
        typeof attachment?.name === "string" && attachment.name.trim()
          ? attachment.name.trim()
          : path.basename(localPath),
      contentType: typeof attachment?.contentType === "string" ? attachment.contentType.trim() : "",
      sizeBytes:
        Number.isFinite(Number(attachment?.sizeBytes)) && Number(attachment.sizeBytes) >= 0
          ? Number(attachment.sizeBytes)
          : null
    };

    if (isSpreadsheetAttachment(normalized)) {
      return await parseXlsxFileToText(localPath, normalized);
    }

    const extension = path.extname(normalized.path).toLowerCase();
    let sizeBytes = normalized.sizeBytes;
    if (sizeBytes === null) {
      try {
        const stats = await fs.stat(normalized.path);
        if (stats?.isFile?.()) {
          sizeBytes = stats.size;
        }
      } catch (error) {
        logger?.warn?.(`failed to stat attachment ${normalized.path}: ${error.message}`);
      }
    }

    let previewStatus = "";
    let previewText = "";
    if (isTextPreviewCandidate(normalized, extension)) {
      try {
        const preview = await readTextPreview(normalized.path, sizeBytes);
        previewStatus = preview.status;
        previewText = preview.text;
      } catch (error) {
        previewStatus = `preview-read-failed (${error.message})`;
      }
    } else {
      previewStatus = "skipped (non-text attachment)";
    }

    const lines = ["- file", `  path: ${normalized.path}`];
    if (normalized.name) {
      lines.push(`  name: ${normalized.name}`);
    }
    if (extension) {
      lines.push(`  extension: ${extension}`);
    }
    if (normalized.contentType) {
      lines.push(`  content-type: ${normalized.contentType}`);
    }
    if (sizeBytes !== null) {
      lines.push(`  size-bytes: ${sizeBytes}`);
    }
    if (previewStatus) {
      lines.push(`  preview-status: ${previewStatus}`);
    }
    if (previewText) {
      lines.push("  preview:");
      lines.push("  ```text");
      lines.push(indentMultilineText(previewText, "  "));
      lines.push("  ```");
    }
    return lines.join("\n");
  }

  async function parseSpreadsheetAttachment(attachment, bytes) {
    if (typeof execFileAsync !== "function") {
      return formatSkippedAttachmentBlock(attachment, "spreadsheet parsing is unavailable on this host");
    }

    await fs.mkdir(imageCacheDir, { recursive: true });
    const baseName = sanitizeAttachmentFileName(String(attachment?.name ?? "attachment.xlsx"));
    const filePath = path.join(imageCacheDir, `${Date.now()}-${attachment?.id ?? "sheet"}-${baseName}`);

    try {
      await fs.writeFile(filePath, bytes);
      return await parseXlsxFileToText(filePath, attachment);
    } catch (error) {
      logger?.warn?.(`failed to parse Discord spreadsheet attachment ${attachment?.id ?? "unknown"}: ${error.message}`);
      return formatSkippedAttachmentBlock(attachment, "spreadsheet parse failed");
    } finally {
      if (typeof fs.rm === "function") {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    }
  }

  async function parseXlsxFileToText(filePath, attachment) {
    const workbookXml = await unzipEntry(filePath, "xl/workbook.xml");
    const workbookRelsXml = await unzipEntry(filePath, "xl/_rels/workbook.xml.rels");
    const sharedStringsXml = await tryUnzipEntry(filePath, "xl/sharedStrings.xml");
    const sharedStrings = parseSharedStrings(sharedStringsXml);
    const sheets = parseWorkbookSheets(workbookXml, workbookRelsXml);

    if (sheets.length === 0) {
      return formatSkippedAttachmentBlock(attachment, "no readable worksheet found");
    }

    const sections = [`Spreadsheet: ${String(attachment?.name ?? "attachment.xlsx").trim() || "attachment.xlsx"}`];
    for (const sheet of sheets.slice(0, 5)) {
      const worksheetXml = await tryUnzipEntry(filePath, sheet.entryPath);
      if (!worksheetXml) {
        continue;
      }
      const rows = parseWorksheetRows(worksheetXml, sharedStrings).slice(0, 50);
      sections.push(renderWorksheetPreview(sheet.name, rows));
    }

    return sections.join("\n\n");
  }

  async function unzipEntry(filePath, entryPath) {
    const result = await execFileAsync("unzip", ["-p", filePath, entryPath], { maxBuffer: 8 * 1024 * 1024 });
    return String(result?.stdout ?? "");
  }

  async function tryUnzipEntry(filePath, entryPath) {
    try {
      return await unzipEntry(filePath, entryPath);
    } catch {
      return "";
    }
  }

  function parseWorkbookSheets(workbookXml, workbookRelsXml) {
    const relTargets = new Map();
    for (const relationship of matchAll(workbookRelsXml, /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)) {
      relTargets.set(relationship[1], relationship[2]);
    }

    const sheets = [];
    for (const match of matchAll(workbookXml, /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
      const name = decodeXmlEntities(match[1]);
      const relId = match[2];
      const target = relTargets.get(relId);
      if (!target) {
        continue;
      }
      const normalizedTarget = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\/?/, "")}`;
      sheets.push({ name, entryPath: normalizedTarget.replace(/^xl\/xl\//, "xl/") });
    }
    return sheets;
  }

  function parseSharedStrings(xml) {
    if (!xml) {
      return [];
    }
    return matchAll(xml, /<si\b[^>]*>([\s\S]*?)<\/si>/g).map((match) => extractXmlText(match[1]));
  }

  function parseWorksheetRows(xml, sharedStrings) {
    const rows = [];
    for (const rowMatch of matchAll(xml, /<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of matchAll(rowMatch[1], /<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1] ?? "";
        const body = cellMatch[2] ?? "";
        const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const columnIndex = refMatch ? columnLettersToIndex(refMatch[1]) : cells.length;
        const cellValue = parseWorksheetCellValue(typeMatch?.[1] ?? "", body, sharedStrings);
        while (cells.length < columnIndex) {
          cells.push("");
        }
        cells[columnIndex] = cellValue;
      }
      if (cells.some((value) => String(value ?? "").trim().length > 0)) {
        rows.push(cells.map((value) => String(value ?? "").trim()));
      }
    }
    return rows;
  }

  function parseWorksheetCellValue(type, body, sharedStrings) {
    if (type === "inlineStr") {
      return extractXmlText(body);
    }
    const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
    if (type === "s") {
      const index = Number.parseInt(rawValue, 10);
      return Number.isFinite(index) ? String(sharedStrings[index] ?? "") : "";
    }
    return decodeXmlEntities(rawValue);
  }

  function renderWorksheetPreview(sheetName, rows) {
    if (!rows.length) {
      return `Sheet: ${sheetName}\n[Empty sheet]`;
    }

    const normalizedRows = rows
      .map((row) => row.map((value) => normalizeCellPreview(value)))
      .filter((row) => row.some((value) => value.length > 0));

    if (!normalizedRows.length) {
      return `Sheet: ${sheetName}\n[Empty sheet]`;
    }

    const maxColumns = Math.min(
      12,
      normalizedRows.reduce((max, row) => Math.max(max, row.length), 0)
    );
    const previewRows = normalizedRows.slice(0, 20).map((row) => row.slice(0, maxColumns));
    const header = previewRows[0];
    const body = previewRows.slice(1);

    const lines = [`Sheet: ${sheetName}`];
    lines.push(`Columns: ${header.map((value, index) => value || `col_${index + 1}`).join(" | ")}`);
    for (const row of body) {
      lines.push(row.map((value) => value || "").join(" | "));
    }
    if (normalizedRows.length > previewRows.length) {
      lines.push(`[${normalizedRows.length - previewRows.length} more rows omitted]`);
    }
    return lines.join("\n");
  }

  function normalizeCellPreview(value) {
    return String(value ?? "")
      .replace(/\r\n/g, " ")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function extractXmlText(xml) {
    return decodeXmlEntities(String(xml ?? "").replace(/<[^>]+>/g, ""));
  }

  function decodeXmlEntities(text) {
    return String(text ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function columnLettersToIndex(letters) {
    let index = 0;
    for (const char of String(letters ?? "")) {
      index = index * 26 + (char.charCodeAt(0) - 64);
    }
    return Math.max(0, index - 1);
  }

  function matchAll(text, pattern) {
    return [...String(text ?? "").matchAll(pattern)];
  }

  function sanitizeAttachmentFileName(name) {
    return String(name ?? "attachment")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "attachment";
  }

  function combinePromptAndTextAttachments(text, textAttachmentBlocks, setup) {
    const sections = [];
    const formattedPrompt = formatInputTextForSetup(text, setup);
    if (formattedPrompt) {
      sections.push(formattedPrompt);
    }
    if (Array.isArray(textAttachmentBlocks) && textAttachmentBlocks.length > 0) {
      if (!formattedPrompt) {
        sections.push("Analyze the uploaded file attachment(s).");
      }
      sections.push("[Attached files from chat]");
      sections.push("The user sent file attachment(s). Use the metadata, preview, and local paths below when available:");
      sections.push(textAttachmentBlocks.join("\n\n"));
    }
    return sections.join("\n\n").trim();
  }

  function isTextPreviewCandidate(attachment, extension) {
    const normalizedContentType = String(attachment?.contentType ?? "").toLowerCase();
    if (normalizedContentType.startsWith("text/")) {
      return true;
    }
    if (
      normalizedContentType.includes("json") ||
      normalizedContentType.includes("xml") ||
      normalizedContentType.includes("yaml") ||
      normalizedContentType.includes("javascript")
    ) {
      return true;
    }
    return TEXT_PREVIEW_EXTENSIONS.has(extension);
  }

  async function readTextPreview(filePath, knownSizeBytes) {
    const buffer = await fs.readFile(filePath);
    const sizeBytes = Number.isFinite(Number(knownSizeBytes)) ? Number(knownSizeBytes) : buffer.length;
    const maxPreviewBytes = filePreviewMaxBytes || DEFAULT_FILE_PREVIEW_MAX_BYTES;
    const maxPreviewChars = filePreviewMaxChars || DEFAULT_FILE_PREVIEW_MAX_CHARS;
    const truncatedByBytes = buffer.length > maxPreviewBytes;
    const previewBuffer = truncatedByBytes ? buffer.subarray(0, maxPreviewBytes) : buffer;
    const decodedText = previewBuffer.toString("utf8");
    const normalizedDecodedText = normalizePreviewText(decodedText);
    const previewText = truncatePreviewText(decodedText, maxPreviewChars);
    if (!previewText.trim()) {
      return {
        status: "empty-text-preview",
        text: ""
      };
    }
    if (truncatedByBytes || previewText.length < normalizedDecodedText.length || sizeBytes > maxPreviewBytes) {
      return {
        status: `truncated (${Math.min(sizeBytes, maxPreviewBytes)}/${sizeBytes} bytes shown)`,
        text: previewText
      };
    }
    return {
      status: `complete (${sizeBytes} bytes)`,
      text: previewText
    };
  }

  function truncatePreviewText(text, maxPreviewChars) {
    const normalized = normalizePreviewText(text);
    if (normalized.length <= maxPreviewChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(1, maxPreviewChars - 1))}…`;
  }

  function normalizePreviewText(text) {
    return String(text ?? "").replace(/\0/g, "").trim();
  }

  function indentMultilineText(text, prefix) {
    return String(text ?? "")
      .split(/\r?\n/)
      .map((line) => `${prefix}${line}`)
      .join("\n");
  }

  function formatTextAttachmentBlock(attachment, text, truncated) {
    const name = String(attachment?.name ?? "attachment.txt").trim() || "attachment.txt";
    const fence = guessCodeFence(name);
    const suffix = truncated ? " (truncated)" : "";
    return [`File: ${name}${suffix}`, `\`\`\`${fence}`, text.replace(/\u0000/g, ""), "```"].join("\n");
  }

  function formatSkippedAttachmentBlock(attachment, reason) {
    const name = String(attachment?.name ?? "attachment").trim() || "attachment";
    return `File: ${name}\n[Skipped: ${reason}]`;
  }

  function guessCodeFence(name) {
    const extension = path.extname(String(name ?? "")).toLowerCase().replace(/^\./, "");
    const known = new Set([
      "txt",
      "md",
      "json",
      "yaml",
      "yml",
      "xml",
      "html",
      "htm",
      "css",
      "scss",
      "less",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "php",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "sh",
      "zsh",
      "bash",
      "sql",
      "toml",
      "ini",
      "env",
      "csv"
    ]);
    return known.has(extension) ? extension : "";
  }

  function decodeTextAttachment(bytes) {
    const maxInlineBytes = 128 * 1024;
    const truncated = bytes.length > maxInlineBytes;
    const slice = bytes.subarray(0, maxInlineBytes);
    const text = Buffer.from(slice).toString("utf8");
    if (!looksLikeText(text)) {
      return null;
    }
    return { text: text.trimEnd(), truncated };
  }

  function looksLikeText(text) {
    if (!text) {
      return true;
    }
    if (text.includes("\u0000")) {
      return false;
    }
    const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
    if (replacementChars > Math.max(4, Math.floor(text.length * 0.02))) {
      return false;
    }
    return true;
  }

  return {
    collectImageAttachments,
    buildTurnInputFromMessage
  };
}
