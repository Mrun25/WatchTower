/**
 * log/changeLog.js
 *
 * Change Logging Over Time (PRD §2.1 Capability 2, §6 Phase 2).
 * Records what an agent changed, in response to what prompt (to the
 * extent observable from file diffs, since Watchtower v1 has no direct
 * hook into Antigravity's native agent — PRD §1.5), across which files,
 * and whether the change was later reverted or repeated (thrash signal).
 */

const crypto = require('crypto');
const { THRASH_REPEAT_THRESHOLD } = require('../core/constants');

function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
}

/**
 * Records a single file-save event into the log. Since v1 has no clean
 * event API for "what prompt produced this diff" (PRD §1.5), the prompt
 * field is best-effort: it's populated when alt+p was used immediately
 * before the edit (the extension can correlate the two), otherwise it's
 * null and the entry is still useful purely as a diff record for thrash
 * detection.
 */
function recordChange(log, { filePath, diffSummary, contentHash, prompt = null, symbolsTouched = [] }) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    file: filePath,
    contentHash,
    diffSummary,
    prompt,
    symbolsTouched,
    reverted: false,
  };

  log.entries.push(entry);
  markRevertsAndThrash(log);
  return log;
}

/**
 * Walks the log and:
 *  - marks an entry as `reverted` if a later entry for the same file
 *    restores an earlier contentHash seen before that entry (a simple,
 *    deterministic revert heuristic).
 *  - computes a `thrash` flag per file: true if the same file has been
 *    touched THRASH_REPEAT_THRESHOLD+ times within the recent window.
 */
function markRevertsAndThrash(log) {
  const hashHistoryByFile = new Map();

  for (const entry of log.entries) {
    const history = hashHistoryByFile.get(entry.file) || [];

    // Revert detection: does this entry's hash match any earlier hash
    // for this file (other than the immediately preceding one, which
    // would just mean "no-op save")?
    const earlierHashes = history.slice(0, -1).map(h => h.contentHash);
    entry.reverted = earlierHashes.includes(entry.contentHash);

    history.push({ contentHash: entry.contentHash, timestamp: entry.timestamp });
    hashHistoryByFile.set(entry.file, history);
  }

  // Thrash: count touches per file across the whole log (v1 keeps this
  // simple/global rather than windowed, since the log itself is the
  // project's full history and isn't expected to grow unbounded within
  // a single working session).
  const touchCounts = new Map();
  for (const entry of log.entries) {
    touchCounts.set(entry.file, (touchCounts.get(entry.file) || 0) + 1);
  }

  log.thrashSignals = [...touchCounts.entries()]
    .filter(([, count]) => count >= THRASH_REPEAT_THRESHOLD)
    .map(([file, count]) => ({ file, touchCount: count }));

  return log;
}

/**
 * Returns the most relevant log entries for a given file or symbol,
 * capped at `maxEntries` to avoid the prompt-refinement / chat context
 * becoming token-wasteful itself (PRD §5 open question, §1.6 alt+p input).
 */
function getRelevantEntries(log, { file = null, maxEntries = 8 } = {}) {
  let entries = log.entries;
  if (file) {
    entries = entries.filter(e => e.file === file);
  }
  return entries.slice(-maxEntries).reverse(); // most recent first
}

function isThrashing(log, file) {
  return (log.thrashSignals || []).some(t => t.file === file);
}

module.exports = {
  hashContent,
  recordChange,
  markRevertsAndThrash,
  getRelevantEntries,
  isThrashing,
};
