/**
 * core/watcher.js
 *
 * Drives Phase 2's passive monitoring loop (PRD §3.2): watches file saves,
 * incrementally updates the JSON map and log, runs break detection on
 * each update, and reports flags back to the caller (which drives the
 * HUD flash + pseudo-terminal logging). This module wraps VS Code's
 * FileSystemWatcher API behind a small interface so the control flow can
 * be tested independently of a real extension host.
 */

const path = require('path');
const { updateMapForChangedFiles } = require('../map/relationshipMap');
const { detectBreaks } = require('../detection/connectionBreakDetector');
const { recordChange, hashContent } = require('../log/changeLog');

class Watcher {
  /**
   * @param {object} opts
   * @param {{ workspace: object }} opts.vscode
   * @param {Storage} opts.storage
   * @param {() => string} opts.getFlagThreshold
   * @param {(flags: Array) => void} opts.onFlags
   * @param {(filePath: string) => void} [opts.onAnyChange]
   */
  constructor({ vscode, storage, getFlagThreshold, onFlags, onAnyChange }) {
    this.vscode = vscode;
    this.storage = storage;
    this.getFlagThreshold = getFlagThreshold;
    this.onFlags = onFlags;
    this.onAnyChange = onAnyChange || (() => {});
    this.fsWatcher = null;
    this.active = false;
    this._debounceTimer = null;
    this._pendingFiles = new Set();
  }

  start() {
    if (this.active) return;
    this.active = true;

    // Watch broadly; per-file filtering (skip node_modules etc.) happens
    // inside Storage.listProjectFiles when we actually rebuild, and here
    // we just gate which saves trigger a debounced update at all.
    this.fsWatcher = this.vscode.workspace.createFileSystemWatcher('**/*');
    const handleUri = (uri) => this._queueChange(uri.fsPath);

    this.fsWatcher.onDidChange(handleUri);
    this.fsWatcher.onDidCreate(handleUri);
    // Deletions could also break connections (e.g. a backend file removed
    // entirely) — treat them the same as a change for re-scan purposes.
    this.fsWatcher.onDidDelete(handleUri);
  }

  stop() {
    this.active = false;
    if (this.fsWatcher) {
      this.fsWatcher.dispose();
      this.fsWatcher = null;
    }
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
  }

  _queueChange(fsPath) {
    if (this._shouldIgnore(fsPath)) return;
    this._pendingFiles.add(fsPath);
    this.onAnyChange(fsPath);

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._processPending(), 400);
  }

  _shouldIgnore(fsPath) {
    const ignoredSegments = ['.git', 'node_modules', '.watchtower', '__pycache__', '.venv'];
    return ignoredSegments.some(seg => fsPath.includes(`${path.sep}${seg}${path.sep}`) || fsPath.includes(`${path.sep}${seg}`));
  }

  _processPending() {
    const changedFiles = [...this._pendingFiles];
    this._pendingFiles.clear();
    if (changedFiles.length === 0) return;

    const existingMap = this.storage.readMap();
    if (!existingMap) return; // shouldn't happen post-first-scan, but be defensive

    const { updatedMap, freshConnections } = updateMapForChangedFiles(existingMap, this.storage, changedFiles);
    const flags = detectBreaks(existingMap.connections, freshConnections, this.getFlagThreshold());

    // Mark flagged connections so future scans retain "flaggedBefore" history.
    if (flags.length > 0) {
      const flaggedIds = new Set(flags.map(f => f.connectionId));
      updatedMap.connections = updatedMap.connections.map(c =>
        flaggedIds.has(c.id) ? { ...c, flaggedBefore: true } : c
      );
    }

    this.storage.writeMap(updatedMap);

    // Record each changed file into the log as a best-effort diff summary.
    const log = this.storage.readLog();
    const fs = require('fs');
    for (const filePath of changedFiles) {
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        content = '<deleted-or-unreadable>';
      }
      const relPath = this.storage.relative(filePath);
      recordChange(log, {
        filePath: relPath,
        diffSummary: `File saved/changed: ${relPath}`,
        contentHash: hashContent(content),
      });
    }
    this.storage.writeLog(log);

    if (flags.length > 0) {
      this.onFlags(flags);
    }
  }
}

module.exports = { Watcher };
