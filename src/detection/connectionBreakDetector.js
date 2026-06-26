/**
 * detection/connectionBreakDetector.js
 *
 * Passive Connection-Break Detection (PRD §2.1 Capability 1, §6 Phase 2).
 * Compares a previous map state against a freshly-rebuilt one (after an
 * incremental update) and produces flags when a tracked connection
 * appears to have broken.
 *
 * Threshold-tunable per PRD §5 open question ("What counts as a
 * flag-worthy connection break vs. normal refactoring?") via
 * watchtower.flagThreshold setting -> FLAG_THRESHOLDS.
 */

const { FLAG_THRESHOLDS } = require('../core/constants');

function paramsDiffer(oldParams, newParams) {
  const a = new Set(oldParams || []);
  const b = new Set(newParams || []);
  if (a.size !== b.size) return true;
  for (const p of a) if (!b.has(p)) return true;
  return false;
}

/**
 * @param {Array} oldConnections - connections from the map before this update
 * @param {Array} newConnections - connections from the freshly rebuilt map
 * @param {string} thresholdProfile - 'strict' | 'balanced' | 'lenient'
 * @returns {Array} flags
 */
function detectBreaks(oldConnections, newConnections, thresholdProfile = 'balanced') {
  const threshold = FLAG_THRESHOLDS[thresholdProfile] || FLAG_THRESHOLDS.balanced;
  const flags = [];
  const newById = new Map(newConnections.map(c => [c.id, c]));

  for (const oldConn of oldConnections) {
    if (oldConn.status === 'orphan-backend') continue; // not a tracked two-sided connection

    const newConn = newById.get(oldConn.id);

    if (!newConn) {
      // The connection's id (method+route) no longer appears at all —
      // either the frontend call or the route string itself changed.
      if (oldConn.status === 'connected') {
        flags.push({
          connectionId: oldConn.id,
          issue: 'connection-disappeared',
          severity: 'high',
          detail: `The connection "${oldConn.id}" (previously linking ${oldConn.frontend?.file} to ${oldConn.backend?.file}) no longer appears in the codebase. The route string or method may have changed on one side without the other.`,
          frontendFile: oldConn.frontend?.file,
          backendFile: oldConn.backend?.file,
        });
      }
      continue;
    }

    if (oldConn.status === 'connected' && newConn.status === 'unmatched') {
      if (newConn.confidence <= 1 - threshold.minConfidenceToFlag + 0.001 || true) {
        flags.push({
          connectionId: oldConn.id,
          issue: 'backend-route-missing',
          severity: 'high',
          detail: `Frontend (${oldConn.frontend?.file}) still calls "${oldConn.id}", but no matching backend route was found anymore. The backend route may have been renamed, removed, or had its method changed.`,
          frontendFile: oldConn.frontend?.file,
          backendFile: oldConn.backend?.file,
        });
      }
      continue;
    }

    // Param-shape mismatch: frontend sends fields the backend no longer
    // reads (or vice versa), even though the route string itself still matches.
    if (oldConn.backend && newConn.backend && newConn.frontend) {
      const frontendParamsChanged = paramsDiffer(oldConn.frontend?.params, newConn.frontend.params);
      const backendParamsChanged = paramsDiffer(oldConn.backend?.params, newConn.backend.params);

      if (backendParamsChanged || frontendParamsChanged) {
        const frontendSends = new Set(newConn.frontend.params || []);
        const backendReads = new Set(newConn.backend.params || []);
        const missingOnBackend = [...frontendSends].filter(p => !backendReads.has(p));
        const missingOnFrontend = [...backendReads].filter(p => !frontendSends.has(p) && backendReads.has(p));

        if (missingOnBackend.length > 0) {
          flags.push({
            connectionId: oldConn.id,
            issue: 'param-shape-mismatch',
            severity: 'medium',
            detail: `Frontend (${newConn.frontend.file}) sends [${[...frontendSends].join(', ')}] to "${oldConn.id}", but backend (${newConn.backend.file}) no longer reads: [${missingOnBackend.join(', ')}].`,
            frontendFile: newConn.frontend.file,
            backendFile: newConn.backend.file,
          });
        } else if (backendParamsChanged && missingOnFrontend.length > 0 && frontendSends.size > 0) {
          flags.push({
            connectionId: oldConn.id,
            issue: 'backend-expects-more',
            severity: 'low',
            detail: `Backend (${newConn.backend.file}) for "${oldConn.id}" now reads [${missingOnFrontend.join(', ')}], which the frontend (${newConn.frontend.file}) doesn't currently send. This may be intentional (e.g. a new optional field) or a sign the frontend needs updating.`,
            frontendFile: newConn.frontend.file,
            backendFile: newConn.backend.file,
          });
        }
      }
    }

    // Confidence drop below threshold even without an outright status
    // change — e.g. a route match that's now only a loose segment match
    // rather than exact.
    if (newConn.confidence < threshold.minConfidenceToFlag && oldConn.confidence >= threshold.minConfidenceToFlag) {
      flags.push({
        connectionId: oldConn.id,
        issue: 'low-confidence-match',
        severity: 'low',
        detail: `The match confidence for "${oldConn.id}" dropped from ${oldConn.confidence.toFixed(2)} to ${newConn.confidence.toFixed(2)}. Worth a manual check.`,
        frontendFile: newConn.frontend?.file,
        backendFile: newConn.backend?.file,
      });
    }
  }

  return flags;
}

module.exports = { detectBreaks, paramsDiffer };
