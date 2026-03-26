export function normalizeFinalSummaryText(text) {
  let normalized = collapseAdjacentDuplicateParagraphs(text);
  normalized = collapseConsecutiveDuplicateLines(normalized);
  normalized = collapseExactRepeatedBody(normalized);
  normalized = collapseRepeatedParagraphBlocks(normalized);
  normalized = collapseRepeatedShortParagraphSet(normalized);
  return normalized;
}

export function normalizeStreamingSnapshotText(text) {
  let normalized = typeof text === "string" ? text : String(text ?? "");
  normalized = collapseExactRepeatedBody(normalized);
  normalized = collapseRepeatedPrefixParagraphBlocks(normalized);
  normalized = collapseRepeatedParagraphBlocks(normalized);
  normalized = collapseRepeatedShortParagraphSet(normalized);
  return normalized;
}

export function extractStreamingAppend(existingText, incomingText) {
  const existing = typeof existingText === "string" ? existingText : String(existingText ?? "");
  const incoming = typeof incomingText === "string" ? incomingText : String(incomingText ?? "");
  if (!incoming) {
    return "";
  }
  if (!existing) {
    return incoming;
  }
  if (incoming === existing) {
    return "";
  }
  if (incoming.startsWith(existing)) {
    return incoming.slice(existing.length);
  }
  if (existing.startsWith(incoming)) {
    return "";
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return incoming.slice(overlap);
    }
  }

  return incoming;
}

function collapseAdjacentDuplicateParagraphs(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return source;
  }
  const paragraphs = source.split(/\n{2,}/);
  const deduped = [];
  for (const paragraph of paragraphs) {
    const normalized = paragraph.trim();
    if (!normalized) {
      continue;
    }
    const previous = deduped.length > 0 ? deduped[deduped.length - 1].trim() : "";
    if (previous && previous === normalized) {
      continue;
    }
    deduped.push(paragraph);
  }
  return deduped.join("\n\n");
}

function collapseConsecutiveDuplicateLines(text) {
  const source = typeof text === "string" ? text : "";
  if (!source) {
    return source;
  }
  const lines = source.split("\n");
  const deduped = [];
  for (const line of lines) {
    const normalized = line.trim();
    const previous = deduped.length > 0 ? deduped[deduped.length - 1].trim() : "";
    if (normalized && normalized === previous) {
      continue;
    }
    deduped.push(line);
  }
  return deduped.join("\n");
}

function collapseExactRepeatedBody(text) {
  const source = typeof text === "string" ? text : "";
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 400) {
    return source;
  }
  if (trimmed.length % 2 !== 0) {
    return source;
  }
  const half = trimmed.length / 2;
  const left = trimmed.slice(0, half).trim();
  const right = trimmed.slice(half).trim();
  if (!left || left !== right) {
    return source;
  }
  return left;
}

function collapseRepeatedParagraphBlocks(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return source;
  }

  const paragraphs = source.split(/\n{2,}/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (paragraphs.length < 2) {
    return source;
  }

  const maxBlockSize = Math.floor(paragraphs.length / 2);
  for (let blockSize = maxBlockSize; blockSize >= 1; blockSize -= 1) {
    if (paragraphs.length % blockSize !== 0) {
      continue;
    }
    const repeats = paragraphs.length / blockSize;
    if (repeats < 2) {
      continue;
    }

    const firstBlock = paragraphs.slice(0, blockSize);
    let matches = true;
    for (let repeatIndex = 1; repeatIndex < repeats && matches; repeatIndex += 1) {
      for (let offset = 0; offset < blockSize; offset += 1) {
        const expected = firstBlock[offset];
        const actual = paragraphs[repeatIndex * blockSize + offset];
        if (expected !== actual) {
          matches = false;
          break;
        }
      }
    }

    if (matches) {
      return firstBlock.join("\n\n");
    }
  }

  return source;
}

function collapseRepeatedPrefixParagraphBlocks(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return source;
  }

  let paragraphs = source.split(/\n{2,}/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (paragraphs.length < 3) {
    return source;
  }

  let changed = false;
  while (paragraphs.length >= 3) {
    let collapsed = false;
    const maxBlockSize = Math.floor(paragraphs.length / 2);
    for (let blockSize = maxBlockSize; blockSize >= 1; blockSize -= 1) {
      if (blockSize * 2 > paragraphs.length) {
        continue;
      }
      const firstBlock = paragraphs.slice(0, blockSize);
      const secondBlock = paragraphs.slice(blockSize, blockSize * 2);
      if (!paragraphBlocksEqual(firstBlock, secondBlock)) {
        continue;
      }
      paragraphs = firstBlock.concat(paragraphs.slice(blockSize * 2));
      collapsed = true;
      changed = true;
      break;
    }
    if (!collapsed) {
      break;
    }
  }

  return changed ? paragraphs.join("\n\n") : source;
}

function paragraphBlocksEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function collapseRepeatedShortParagraphSet(text) {
  const source = typeof text === "string" ? text : "";
  const paragraphs = source
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (paragraphs.length <= 1) {
    return source;
  }
  const first = paragraphs[0];
  if (!first || first.length > 160) {
    return source;
  }
  for (const paragraph of paragraphs) {
    if (paragraph !== first) {
      return source;
    }
  }
  return first;
}
