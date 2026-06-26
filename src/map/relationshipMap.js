/**
 * map/relationshipMap.js
 *
 * The shared foundation (PRD §1.4, §2.2, §2.3): a single JSON relationship
 * map combining same-language call/import graphs with cross-language
 * route/string-matched connections, plus per-connection metadata.
 *
 * Map-building here is purely mechanical/deterministic — no Mistral
 * involvement (PRD §1.4: "Mistral does not edit the relationship map or
 * make autonomous changes... map-building and updating stays mechanical
 * and deterministic so it remains debuggable and trustworthy").
 */

const path = require('path');
const fs = require('fs');
const { ParserRegistry } = require('../parsers/parserRegistry');
const { jsParserPlugin } = require('../parsers/jsParser');
const { pythonParserPlugin } = require('../parsers/pythonParser');
const { matchRoutes } = require('../matcher/routeMatcher');

function createDefaultRegistry() {
  const registry = new ParserRegistry();
  registry.register(jsParserPlugin);
  registry.register(pythonParserPlugin);
  return registry;
}

/**
 * Performs the one-time full scan (PRD §3.1, alt+a first press):
 *   - reads README for high-level context (handled by caller, see extension.js)
 *   - runs both parser plugins across all project files
 *   - runs the route/string matcher across the gathered routeRefs
 *   - builds the JSON map
 *
 * @param {Storage} storage
 * @param {ParserRegistry} [registry]
 * @returns {{map: object, fileResults: Array, stats: object}}
 */
function buildFullMap(storage, registry = createDefaultRegistry()) {
  const allExtensions = registry.supportedExtensions();
  const fallbackExtensions = ['html', 'json', 'txt', 'md', 'yml', 'yaml'];
  const candidateExtensions = [...allExtensions, ...fallbackExtensions];
  const candidateFiles = storage.listProjectFiles(candidateExtensions); // filter unsupported heavy binaries

  const fileResults = [];
  let fallbackCount = 0;
  let parsedCount = 0;

  for (const filePath of candidateFiles) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // unreadable (binary, permission) — skip, never block the scan
    }

    const relPath = storage.relative(filePath);
    const result = registry.parseFile(relPath, content, ext);
    fileResults.push(result);

    if (result.fallback) fallbackCount++;
    else parsedCount++;
  }

  const connections = matchRoutes(fileResults);

  // Build same-language call/import edges per file, keyed by language,
  // independent of the cross-language route connections above.
  const sameLanguageEdges = [];
  for (const fr of fileResults) {
    if (fr.fallback) continue;
    for (const call of fr.calls) {
      sameLanguageEdges.push({
        kind: 'call',
        language: fr.language,
        file: fr.filePath,
        callee: call.callee,
        line: call.line,
      });
    }
    for (const imp of fr.imports) {
      sameLanguageEdges.push({
        kind: 'import',
        language: fr.language,
        file: fr.filePath,
        from: imp.from,
        importedNames: imp.importedNames,
        line: imp.line,
      });
    }
  }

  const now = new Date().toISOString();

  const map = {
    version: 1,
    builtAt: now,
    lastUpdatedAt: now,
    stats: {
      filesScanned: fileResults.length,
      filesParsed: parsedCount,
      filesFallback: fallbackCount,
      connectionsFound: connections.length,
    },
    connections: connections.map(c => ({
      ...c,
      lastTouched: now,
      lastTouchedBy: 'initial-scan',
      flaggedBefore: false,
    })),
    sameLanguageEdges,
    symbols: fileResults
      .filter(fr => !fr.fallback)
      .flatMap(fr => fr.symbols.map(s => ({ ...s, file: fr.filePath, language: fr.language }))),
  };

  return {
    map,
    fileResults,
    stats: map.stats,
  };
}

/**
 * Incremental update for a single changed file (PRD §3.2: "watching
 * incrementally updates the existing map" rather than re-scanning from
 * scratch). Re-parses only the changed file(s), re-runs the route matcher
 * against the full updated routeRef set (cheap enough to redo in full,
 * and keeps matching logic in one place), and merges into the existing map.
 *
 * @param {object} existingMap
 * @param {Storage} storage
 * @param {string[]} changedFilePaths - absolute paths
 * @param {ParserRegistry} [registry]
 */
function updateMapForChangedFiles(existingMap, storage, changedFilePaths, registry = createDefaultRegistry()) {
  const updatedMap = JSON.parse(JSON.stringify(existingMap)); // deterministic deep copy, no mutation surprises
  const now = new Date().toISOString();

  // To re-run the route matcher meaningfully we need routeRefs from the
  // WHOLE project, not just the changed files — a backend route change
  // needs to be checked against frontend callers elsewhere. We rebuild
  // routeRefs/symbols from the full project file list, but reuse this as
  // a relatively cheap operation since only matching (not Mistral calls)
  // happens here. This keeps the "mechanical and deterministic" property
  // intact and avoids subtle drift between full-scan and incremental maps.
  const allExtensions = registry.supportedExtensions();
  const fallbackExtensions = ['html', 'json', 'txt', 'md', 'yml', 'yaml'];
  const candidateExtensions = [...allExtensions, ...fallbackExtensions];
  const candidateFiles = storage.listProjectFiles(candidateExtensions);
  const fileResults = [];

  for (const filePath of candidateFiles) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const relPath = storage.relative(filePath);
    fileResults.push(registry.parseFile(relPath, content, ext));
  }

  const freshConnections = matchRoutes(fileResults);
  const changedRelPaths = new Set(changedFilePaths.map(p => storage.relative(p)));

  // Preserve flaggedBefore / lastTouchedBy history where a connection
  // persists across scans, but refresh status/confidence/params from the
  // fresh scan, and mark lastTouched for connections whose files changed.
  const previousById = new Map(updatedMap.connections.map(c => [c.id, c]));

  const mergedConnections = freshConnections.map(fresh => {
    const prev = previousById.get(fresh.id);
    const touchedThisRound =
      (fresh.frontend && changedRelPaths.has(fresh.frontend.file)) ||
      (fresh.backend && changedRelPaths.has(fresh.backend.file));

    return {
      ...fresh,
      lastTouched: touchedThisRound ? now : (prev ? prev.lastTouched : now),
      lastTouchedBy: touchedThisRound ? 'agent-edit' : (prev ? prev.lastTouchedBy : 'initial-scan'),
      flaggedBefore: prev ? prev.flaggedBefore : false,
    };
  });

  const sameLanguageEdges = [];
  for (const fr of fileResults) {
    if (fr.fallback) continue;
    for (const call of fr.calls) {
      sameLanguageEdges.push({ kind: 'call', language: fr.language, file: fr.filePath, callee: call.callee, line: call.line });
    }
    for (const imp of fr.imports) {
      sameLanguageEdges.push({ kind: 'import', language: fr.language, file: fr.filePath, from: imp.from, importedNames: imp.importedNames, line: imp.line });
    }
  }

  updatedMap.lastUpdatedAt = now;
  updatedMap.connections = mergedConnections;
  updatedMap.sameLanguageEdges = sameLanguageEdges;
  updatedMap.symbols = fileResults
    .filter(fr => !fr.fallback)
    .flatMap(fr => fr.symbols.map(s => ({ ...s, file: fr.filePath, language: fr.language })));
  updatedMap.stats = {
    filesScanned: fileResults.length,
    filesParsed: fileResults.filter(f => !f.fallback).length,
    filesFallback: fileResults.filter(f => f.fallback).length,
    connectionsFound: mergedConnections.length,
  };

  return { updatedMap, freshConnections, previousConnections: updatedMap.connections };
}

module.exports = {
  createDefaultRegistry,
  buildFullMap,
  updateMapForChangedFiles,
};
