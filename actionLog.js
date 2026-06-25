const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function resolveMaxBytes() {
  const n = Number(process.env.NEXIAN_ACTION_LOG_MAX_BYTES);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_MAX_BYTES;
}

function resolveArchiveDir(logFilePath) {
  const configured = String(process.env.NEXIAN_ACTION_LOG_ARCHIVE_DIR || "").trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  return path.join(path.dirname(logFilePath), "log-archive");
}

function formatArchiveStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function buildArchivePath(logFilePath, archiveDir, stamp = formatArchiveStamp()) {
  const ext = path.extname(logFilePath) || ".jsonl";
  const base = path.basename(logFilePath, ext) || "log";
  let candidate = path.join(archiveDir, `${base}-${stamp}${ext}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveDir, `${base}-${stamp}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function maybeRotateActionLog(logFilePath) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return { rotated: false };
  }

  let stat;
  try {
    stat = fs.statSync(logFilePath);
  } catch (_error) {
    return { rotated: false };
  }

  if (!stat.size || stat.size < resolveMaxBytes()) {
    return { rotated: false, bytes: stat.size || 0 };
  }

  const archiveDir = resolveArchiveDir(logFilePath);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = buildArchivePath(logFilePath, archiveDir);
  fs.renameSync(logFilePath, archivePath);
  return {
    rotated: true,
    archivePath,
    archivedBytes: stat.size
  };
}

function ensureLogDirectory(logFilePath) {
  const dir = path.dirname(logFilePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Append one JSONL line; rotate + archive the file first when over size limit. */
function appendActionLogLine(logFilePath, line) {
  ensureLogDirectory(logFilePath);
  const rotation = maybeRotateActionLog(logFilePath);
  fs.appendFileSync(logFilePath, line, "utf8");
  return rotation;
}

function listArchivedLogs(logFilePath) {
  const archiveDir = resolveArchiveDir(logFilePath);
  if (!fs.existsSync(archiveDir)) {
    return [];
  }
  return fs
    .readdirSync(archiveDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse()
    .map((name) => path.join(archiveDir, name));
}

module.exports = {
  appendActionLogLine,
  maybeRotateActionLog,
  listArchivedLogs,
  resolveArchiveDir,
  resolveMaxBytes,
  DEFAULT_MAX_BYTES
};
