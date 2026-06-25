const fs = require("fs");

const DEFAULT_TAIL_READ_BYTES = 512 * 1024;

/** Read the last `limit` JSONL lines without loading the whole file into memory. */
function tailLogFile(logFilePath, limit = 50, maxReadBytes = DEFAULT_TAIL_READ_BYTES) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return [];
  }
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  let stat;
  try {
    stat = fs.statSync(logFilePath);
  } catch (_error) {
    return [];
  }
  if (!stat.size) {
    return [];
  }

  const readSize = Math.min(stat.size, maxReadBytes);
  const start = stat.size - readSize;
  const fd = fs.openSync(logFilePath, "r");
  try {
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      if (firstBreak >= 0) {
        text = text.slice(firstBreak + 1);
      }
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-cappedLimit).map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return { raw: line.length > 500 ? `${line.slice(0, 499)}…` : line };
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

/** Stream JSONL lines for summaries; stops after `maxLines` from the end when set. */
async function forEachLogLine(logFilePath, onLine, options = {}) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return 0;
  }
  const maxLines = Number.isFinite(Number(options.maxLines))
    ? Math.max(0, Math.floor(Number(options.maxLines)))
    : 0;
  let kept = [];
  let total = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(logFilePath, { encoding: "utf8" });
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() || "";
      for (const line of parts) {
        if (!line.trim()) {
          continue;
        }
        total += 1;
        if (maxLines > 0) {
          kept.push(line);
          if (kept.length > maxLines) {
            kept.shift();
          }
        } else {
          try {
            onLine(JSON.parse(line), total);
          } catch (_error) {
            onLine({ raw: line }, total);
          }
        }
      }
    });
    stream.on("end", () => {
      if (pending.trim()) {
        total += 1;
        if (maxLines > 0) {
          kept.push(pending);
          if (kept.length > maxLines) {
            kept.shift();
          }
        } else {
          try {
            onLine(JSON.parse(pending), total);
          } catch (_error) {
            onLine({ raw: pending }, total);
          }
        }
      }
      if (maxLines > 0) {
        kept.forEach((line, index) => {
          try {
            onLine(JSON.parse(line), index + 1);
          } catch (_error) {
            onLine({ raw: line }, index + 1);
          }
        });
      }
      resolve();
    });
    stream.on("error", reject);
  });

  return total;
}

module.exports = {
  tailLogFile,
  forEachLogLine,
  DEFAULT_TAIL_READ_BYTES
};
