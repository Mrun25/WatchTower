/**
 * core/storage.js
 *
 * Thin wrapper around filesystem access for Watchtower's data directory
 * (.watchtower/ inside the project root). All map/log reads and writes
 * should go through here so there is exactly one place that knows about
 * file paths and JSON serialization — this is what keeps "map-building and
 * updating mechanical and deterministic" (PRD §1.4) rather than scattering
 * file I/O across every module.
 */

const fs = require('fs');
const path = require('path');
const {
  WATCHTOWER_DIR,
  MAP_FILENAME,
  LOG_FILENAME,
  PROJECT_SUMMARY_FILENAME,
} = require('./constants');

class Storage {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.dataDir = path.join(projectRoot, WATCHTOWER_DIR);
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  get mapPath() {
    return path.join(this.dataDir, MAP_FILENAME);
  }

  get logPath() {
    return path.join(this.dataDir, LOG_FILENAME);
  }

  get summaryPath() {
    return path.join(this.dataDir, PROJECT_SUMMARY_FILENAME);
  }

  mapExists() {
    return fs.existsSync(this.mapPath);
  }

  readMap() {
    if (!this.mapExists()) return null;
    return JSON.parse(fs.readFileSync(this.mapPath, 'utf-8'));
  }

  writeMap(map) {
    this.ensureDataDir();
    fs.writeFileSync(this.mapPath, JSON.stringify(map, null, 2), 'utf-8');
  }

  readLog() {
    if (!fs.existsSync(this.logPath)) {
      return { entries: [] };
    }
    return JSON.parse(fs.readFileSync(this.logPath, 'utf-8'));
  }

  writeLog(log) {
    this.ensureDataDir();
    fs.writeFileSync(this.logPath, JSON.stringify(log, null, 2), 'utf-8');
  }

  readSummary() {
    if (!fs.existsSync(this.summaryPath)) return null;
    return JSON.parse(fs.readFileSync(this.summaryPath, 'utf-8'));
  }

  writeSummary(summary) {
    this.ensureDataDir();
    fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  }

  /** Recursively list project files, skipping common noise directories. */
  listProjectFiles(extensions) {
    const results = [];
    const skipDirs = new Set([
      'node_modules', '.git', WATCHTOWER_DIR, 'dist', 'build',
      '__pycache__', '.venv', 'venv', '.next', 'out', 'coverage',
    ]);

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return; // permission errors etc. — skip silently, never block the scan
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.watchtower') {
          if (entry.isDirectory()) continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(fullPath);
        } else {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (!extensions || extensions.includes(ext)) {
            results.push(fullPath);
          }
        }
      }
    };

    walk(this.projectRoot);
    return results;
  }

  readReadme() {
    const candidates = ['README.md', 'README.txt', 'README', 'readme.md'];
    for (const name of candidates) {
      const full = path.join(this.projectRoot, name);
      if (fs.existsSync(full)) {
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  relative(absPath) {
    return path.relative(this.projectRoot, absPath);
  }
}

module.exports = { Storage };
