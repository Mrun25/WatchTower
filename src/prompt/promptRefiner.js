/**
 * prompt/promptRefiner.js
 *
 * Prompt Refinement (PRD §2.1 Capability 3, §3.3, §6 Phase 4).
 * Takes a rough/vague prompt or selected code, gathers context from the
 * relationship map + change log scoped to the selection, and calls
 * Mistral to produce a structured, explicit prompt. Output is handed back
 * to the caller (extension.js) for display in the pseudo-terminal +
 * clipboard copy — this module has no knowledge of VS Code UI.
 */

const { getRelevantEntries } = require('../log/changeLog');

/**
 * Finds map connections relevant to a given file path and/or selected
 * code text, so the context sent to Mistral is scoped rather than
 * dumping the entire map (PRD §5 open question on over-stuffing context).
 */
function findRelevantConnections(map, { filePath, selectedCode }) {
  if (!map || !map.connections) return [];

  const relevant = map.connections.filter((c) => {
    if (filePath && (c.frontend?.file === filePath || c.backend?.file === filePath)) {
      return true;
    }
    if (selectedCode) {
      const routeMentioned =
        (c.frontend?.route && selectedCode.includes(c.frontend.route)) ||
        (c.backend?.route && selectedCode.includes(c.backend.route));
      if (routeMentioned) return true;
    }
    return false;
  });

  // Fall back to a small sample of high-confidence connections if nothing
  // matched directly, so Mistral still has some grounding rather than none.
  if (relevant.length === 0) {
    return map.connections.filter(c => c.status === 'connected').slice(0, 5);
  }

  return relevant;
}

function findRelevantEdges(map, { filePath, selectedCode }) {
  if (!map || !map.sameLanguageEdges) return [];
  return map.sameLanguageEdges.filter(e => {
    if (filePath && e.file === filePath) return true;
    if (selectedCode && e.callee && selectedCode.includes(e.callee)) return true;
    if (selectedCode && e.from && selectedCode.includes(e.from)) return true;
    return false;
  }).slice(0, 10);
}

function findRelevantSymbols(map, selectedCode) {
  if (!map || !map.symbols || !selectedCode) return [];
  return map.symbols.filter(s => selectedCode.includes(s.name)).slice(0, 10);
}

/**
 * @param {object} opts
 * @param {string} opts.roughInput - the rough prompt or note the user typed/selected
 * @param {string|null} opts.selectedCode - selected code text, if any
 * @param {string|null} opts.activeFilePath - the relative path of the active file
 * @param {object} opts.map - the current relationship map
 * @param {object} opts.log - the current change log
 * @param {MistralClient} opts.mistralClient
 * @param {number} [opts.maxLogEntries]
 */
async function refinePrompt({
  roughInput,
  selectedCode,
  activeFilePath,
  map,
  log,
  mistralClient,
  maxLogEntries = 8,
}) {
  if (!map) {
    throw new Error(
      'Watchtower has no relationship map yet. Press Alt+A to run the first scan before refining prompts.'
    );
  }

  const relevantConnections = findRelevantConnections(map, {
    filePath: activeFilePath,
    selectedCode,
  });
  const relevantSymbols = findRelevantSymbols(map, selectedCode);
  const relevantLogEntries = getRelevantEntries(log, {
    file: activeFilePath,
    maxEntries: maxLogEntries,
  });

  const relevantEdges = findRelevantEdges(map, {
    filePath: activeFilePath,
    selectedCode,
  });

  const mapContext = relevantConnections.map(c => ({
    id: c.id,
    frontendFile: c.frontend?.file,
    backendFile: c.backend?.file,
    status: c.status,
    flaggedBefore: c.flaggedBefore,
  }));

  if (relevantEdges.length > 0) {
    mapContext.push({ internalEdges: relevantEdges });
  }

  if (relevantSymbols.length > 0) {
    mapContext.push({ relatedSymbols: relevantSymbols.map(s => `${s.name} (${s.file}:${s.line})`) });
  }

  const logContext = relevantLogEntries.map(e => ({
    file: e.file,
    diffSummary: e.diffSummary,
    reverted: e.reverted,
    timestamp: e.timestamp,
  }));

  const refined = await mistralClient.refinePrompt({
    roughInput,
    selectedCode,
    mapContext,
    logContext,
  });

  return {
    refinedPrompt: refined.trim(),
    contextUsed: { connections: relevantConnections.length, logEntries: relevantLogEntries.length },
  };
}

module.exports = { refinePrompt, findRelevantConnections, findRelevantSymbols };
