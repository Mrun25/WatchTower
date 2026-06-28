/**
 * chat/chatAssistant.js
 *
 * Context-Aware Chat (PRD §2.1 Capability 4, §3.4, §6 Phase 5).
 * Retrieves relevant context from the JSON map and change log, then asks
 * Mistral to answer grounded in the project's actual structure and
 * history rather than generic explanation.
 */

const { getRelevantEntries, isThrashing } = require('../log/changeLog');

/**
 * Very lightweight keyword-overlap retrieval: pulls connections whose
 * file paths, route strings, or symbol names appear in the question text.
 * This is intentionally simple (no embeddings/vector search) to keep
 * the extension dependency-free; it can be swapped for a real retrieval
 * step later without changing the chat interface.
 */
function retrieveRelevantConnections(map, question) {
  if (!map || !map.connections) return [];
  const q = question.toLowerCase();

  const scored = map.connections.map((c) => {
    let score = 0;
    const haystacks = [
      c.frontend?.file, c.backend?.file, c.frontend?.route, c.backend?.route, c.id,
    ].filter(Boolean).map(s => s.toLowerCase());

    for (const h of haystacks) {
      const tokens = h.split(/[\/\.\-_\s\\]+/).filter(t => t.length > 2);
      for (const t of tokens) {
        if (q.includes(t)) score += 1;
      }
    }
    if (c.flaggedBefore) score += 0.5; // slight bias toward known-flagged connections
    return { connection: c, score };
  });

  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (matched.length > 0) {
    return matched.slice(0, 10).map(s => s.connection);
  }

  // No keyword overlap — fall back to recently-flagged connections so
  // generic questions ("what's wrong?") still get something useful.
  return map.connections.filter(c => c.flaggedBefore).slice(0, 5);
}

function retrieveRelevantFiles(map, question) {
  if (!map || !map.files) return [];
  const q = question.toLowerCase();

  const scored = map.files.map((f) => {
    let score = 0;
    const tokens = f.file.split(/[\/\.\-_\s\\]+/).filter(t => t.length > 2);
    for (const t of tokens) {
      if (q.includes(t)) score += 1;
    }
    return { fileMetadata: f, score };
  });

  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return matched.slice(0, 5).map(s => s.fileMetadata);
}

function retrieveRelevantLogEntries(log, question, maxEntries) {
  const q = question.toLowerCase();
  const fileMentioned = (log.entries || []).find(e => {
    const filename = e.file?.toLowerCase().split(/[\/\\]/).pop() || '~~none~~';
    const basename = filename.split('.')[0];
    return q.includes(filename) || q.includes(basename);
  });
  if (fileMentioned) {
    return getRelevantEntries(log, { file: fileMentioned.file, maxEntries });
  }
  return getRelevantEntries(log, { maxEntries });
}

/**
 * @param {object} opts
 * @param {string} opts.question
 * @param {object} opts.map
 * @param {object} opts.log
 * @param {Array} [opts.conversationHistory] - prior {role, content} turns in this chat session
 * @param {MistralClient} opts.mistralClient
 * @param {number} [opts.maxLogEntries]
 */
async function answerQuestion({
  question,
  map,
  log,
  conversationHistory = [],
  mistralClient,
  maxLogEntries = 8,
  storage,
}) {
  if (!map) {
    return {
      answer:
        "Watchtower hasn't scanned this project yet. Press Alt+A first so I have a relationship map and history to ground answers in.",
      contextUsed: { connections: 0, logEntries: 0 },
    };
  }

  const relevantConnections = retrieveRelevantConnections(map, question);
  const relevantLogEntries = retrieveRelevantLogEntries(log, question, maxLogEntries);
  const relevantFiles = retrieveRelevantFiles(map, question);

  let totalLines = 0;
  let totalBytes = 0;
  if (map.files) {
    for (const f of map.files) {
      totalLines += f.lineCount || 0;
      totalBytes += f.sizeBytes || 0;
    }
  }

  const fileMetadataContext = {
    projectTotals: { totalLines, totalBytes, fileCount: (map.files || []).length },
    relevantFiles: relevantFiles.map(f => ({
      file: f.file,
      sizeBytes: f.sizeBytes,
      lineCount: f.lineCount,
      language: f.language
    }))
  };

  const mapContext = relevantConnections.map(c => ({
    id: c.id,
    frontendFile: c.frontend?.file,
    backendFile: c.backend?.file,
    status: c.status,
    confidence: c.confidence,
    flaggedBefore: c.flaggedBefore,
  }));

  const q = question.toLowerCase();
  const relevantEdges = (map.sameLanguageEdges || []).filter(e => {
    const fileBase = e.file ? e.file.split(/[\/\\]/).pop().split('.')[0].toLowerCase() : '';
    const calleeBase = e.callee ? e.callee.toLowerCase() : '';
    const fromBase = e.from ? e.from.split(/[\/\\]/).pop().split('.')[0].toLowerCase() : '';
    return (fileBase && q.includes(fileBase)) || (calleeBase && q.includes(calleeBase)) || (fromBase && q.includes(fromBase));
  }).slice(0, 5);

  const relevantSymbols = (map.symbols || []).filter(s => {
    const fileBase = s.file ? s.file.split(/[\/\\]/).pop().split('.')[0].toLowerCase() : '';
    return (s.name && q.includes(s.name.toLowerCase())) || (fileBase && q.includes(fileBase));
  }).slice(0, 5);

  if (relevantEdges.length > 0) {
    mapContext.push({ internalEdges: relevantEdges });
  }
  if (relevantSymbols.length > 0) {
    mapContext.push({ internalSymbols: relevantSymbols.map(s => `${s.name} (${s.kind}) in ${s.file}:${s.line}`) });
  }

  const logContext = relevantLogEntries.map(e => ({
    file: e.file,
    diffSummary: e.diffSummary,
    reverted: e.reverted,
    timestamp: e.timestamp,
    thrashing: isThrashing(log, e.file),
  }));

  const fileContents = [];
  if (storage && storage.projectRoot) {
    const fs = require('fs');
    const path = require('path');
    const filesToRead = new Set();

    relevantConnections.forEach(c => {
      if (c.frontend?.file) filesToRead.add(c.frontend.file);
      if (c.backend?.file) filesToRead.add(c.backend.file);
    });
    relevantEdges.forEach(e => {
      if (e.file) filesToRead.add(e.file);
    });
    relevantSymbols.forEach(s => {
      if (s.file) filesToRead.add(s.file);
    });
    relevantFiles.forEach(f => {
      if (f.file) filesToRead.add(f.file);
    });

    for (const f of [...filesToRead].slice(0, 3)) {
      try {
        const fullPath = path.join(storage.projectRoot, f);
        const content = fs.readFileSync(fullPath, 'utf-8');
        fileContents.push({ file: f, content: content.slice(0, 3000) });
      } catch (err) {
        // silently ignore read errors
      }
    }
  }

  const answer = await mistralClient.answerChatQuestion({
    question,
    mapContext,
    logContext,
    fileMetadataContext,
    fileContentsContext: fileContents,
    conversationHistory,
  });

  return {
    answer: answer.trim(),
    contextUsed: { connections: relevantConnections.length, logEntries: relevantLogEntries.length },
  };
}

module.exports = { answerQuestion, retrieveRelevantConnections, retrieveRelevantLogEntries, retrieveRelevantFiles };
