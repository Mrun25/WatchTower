/**
 * core/constants.js
 *
 * Shared constants used across the extension. Centralizing these keeps the
 * "single shared JSON map + log" design principle (PRD §1.4, §2.2) honest —
 * every module reads/writes the same file names and shapes.
 */

const WATCHTOWER_DIR = '.watchtower';
const MAP_FILENAME = 'relationship-map.json';
const LOG_FILENAME = 'change-log.json';
const PROJECT_SUMMARY_FILENAME = 'project-summary.json';

const HUD_STATES = Object.freeze({
  OFF: 'off',
  SCANNING: 'scanning',
  WATCHING: 'watching',
  FLAGGED: 'flagged',
});

const FLAG_FADE_MS = 4000; // PRD §2.1 Cap.1 / §1.6: brighten then fade after a few seconds

const SUPPORTED_LANGUAGES = Object.freeze({
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
});

const FLAG_THRESHOLDS = Object.freeze({
  strict: { minConfidenceToFlag: 0.3, paramMismatchSensitivity: 'high' },
  balanced: { minConfidenceToFlag: 0.6, paramMismatchSensitivity: 'medium' },
  lenient: { minConfidenceToFlag: 0.85, paramMismatchSensitivity: 'low' },
});

const THRASH_REPEAT_THRESHOLD = 3; // same symbol/file touched this many times -> thrash signal

module.exports = {
  WATCHTOWER_DIR,
  MAP_FILENAME,
  LOG_FILENAME,
  PROJECT_SUMMARY_FILENAME,
  HUD_STATES,
  FLAG_FADE_MS,
  SUPPORTED_LANGUAGES,
  FLAG_THRESHOLDS,
  THRASH_REPEAT_THRESHOLD,
};
