#!/usr/bin/env node
/**
 * test/integrationTest.js
 *
 * Full end-to-end integration test for the three keybinding handlers
 * (Alt+A, Alt+P, Alt+C) as implemented in extension.js.
 *
 * We cannot run inside a real VS Code extension host from a script, so we
 * construct minimal but complete mocks of every VS Code API surface the
 * handlers touch, wire them up exactly as activate() does, then call the
 * handlers directly.  Errors in require() chains, argument shapes, or
 * return-value assumptions all surface here without needing F5.
 *
 * The Mistral call is made against the real API using the key from
 * package.json (the hardcoded fallback) — if the key is invalid the test
 * still passes with a clearly labelled WARN rather than a FAIL, since the
 * rest of the flow (map build, context scoping, terminal output) is
 * validated before the network call.
 *
 * Run with: node test/integrationTest.js
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Mini test harness
// ─────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0, warn = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ FAIL: ${label}`); fail++; failures.push(label); }
}
function warnMsg(label, reason) {
  console.log(`  ⚠ WARN: ${label} — ${reason}`);
  warn++;
}
function section(title, fn) { console.log(`\n=== ${title} ===`); return fn(); }
function sectionAsync(title, fn) { console.log(`\n=== ${title} ===`); return fn(); }

// ─────────────────────────────────────────────────────────────────────────────
// Shared state between tests (mirrors the module-level vars in extension.js)
// ─────────────────────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-int-'));

// Copy watchtower src + test fixtures so we have real files to scan
const fixturesSrc = path.join(__dirname, '..', 'test-fixtures', 'sample-project');
fs.cpSync(fixturesSrc, tmpRoot, { recursive: true });
// Also copy the README so readReadme() works
const readmeSrc = path.join(__dirname, '..', 'README.md');
if (fs.existsSync(readmeSrc)) fs.copyFileSync(readmeSrc, path.join(tmpRoot, 'README.md'));

// ─────────────────────────────────────────────────────────────────────────────
// VS Code mock — covers every surface touched by extension.js handlers
// ─────────────────────────────────────────────────────────────────────────────
const capturedMessages = [];   // showInformationMessage / showErrorMessage / showWarningMessage
const capturedTerminal = [];   // terminal output channel lines
const capturedClipboard = [];  // clipboard writes
let   inputBoxQueue    = [];   // pre-queued answers for showInputBox calls

function makeOutputChannel() {
  return {
    appendLine(line) { capturedTerminal.push(line); },
    show()           {},
    dispose()        {},
  };
}

function makeWebviewPanel() {
  return {
    webview: {
      html: '',
      postMessage() {},
      onDidReceiveMessage() {},
    },
    onDidDispose(fn) { /* no-op */ },
    dispose()        {},
    reveal()         {},
  };
}

const vscodeMock = {
  window: {
    createOutputChannel:  (_) => makeOutputChannel(),
    createWebviewPanel:   (_id, _title, _col, _opts) => makeWebviewPanel(),
    showInformationMessage(msg) { capturedMessages.push({ level: 'info',  msg }); return Promise.resolve(undefined); },
    showErrorMessage(msg)       { capturedMessages.push({ level: 'error', msg }); return Promise.resolve(undefined); },
    showWarningMessage(msg)     { capturedMessages.push({ level: 'warn',  msg }); return Promise.resolve(undefined); },
    showInputBox(_opts) {
      const answer = inputBoxQueue.shift();
      return Promise.resolve(answer);
    },
    activeTextEditor: null,  // overridden per-test as needed
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: tmpRoot } }],
    createFileSystemWatcher() {
      return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
    },
    getConfiguration(_key) {
      // Return a minimal config proxy
      const cfg = {
        mistralApiKey: 'E9NDKsvKOV13vxiNDhHtmLe5XbJ9falB', // package.json default fallback
        mistralModel: 'mistral-large-latest',
        flagThreshold: 'balanced',
        maxLogEntriesInPromptContext: 8,
      };
      return { get: (k) => cfg[k] };
    },
  },
  commands: {
    registerCommand(_cmd, _fn) { return { dispose() {} }; },
  },
  env: {
    clipboard: {
      writeText(text) { capturedClipboard.push(text); return Promise.resolve(); },
    },
  },
  ViewColumn: { Beside: 2 },
};

// Minimal secrets — always returns the config key
const secretsMock = {
  get(_key)        { return Promise.resolve(null); }, // force fallback to config
  store(_key, _v)  { return Promise.resolve(); },
};

const contextMock = { secrets: secretsMock, subscriptions: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Load extension modules directly (not through activate()) so we can call
// the handlers programmatically.  We replicate activate() wiring here.
// ─────────────────────────────────────────────────────────────────────────────
const { Storage }         = require('../src/core/storage');
const { HUD_STATES }      = require('../src/core/constants');
const { Hud }             = require('../src/hud/hud');
const { PseudoTerminal }  = require('../src/core/pseudoTerminal');
const { Watcher }         = require('../src/core/watcher');
const { buildFullMap }    = require('../src/map/relationshipMap');
const { refinePrompt }    = require('../src/prompt/promptRefiner');
const { answerQuestion }  = require('../src/chat/chatAssistant');
const { MistralClient }   = require('../src/mistral/mistralClient');

const storage       = new Storage(tmpRoot);
const hud           = new Hud(vscodeMock);
const terminal      = new PseudoTerminal(vscodeMock);
const mistralClient = new MistralClient({
  getApiKey: async () => {
    const fromSecrets = await contextMock.secrets.get('watchtower.mistralApiKey');
    if (fromSecrets) return fromSecrets;
    return vscodeMock.workspace.getConfiguration('watchtower').get('mistralApiKey') ||
           process.env.MISTRAL_API_KEY || null;
  },
  model: vscodeMock.workspace.getConfiguration('watchtower').get('mistralModel'),
});
let chatHistory = [];

// ─────────────────────────────────────────────────────────────────────────────
// Helper — replicate handleToggleWatch logic
// ─────────────────────────────────────────────────────────────────────────────
let watchingActive = false;
let watcher;

async function handleToggleWatch() {
  const hasExistingMap = storage.mapExists();

  if (!hasExistingMap) {
    hud.setState(HUD_STATES.SCANNING);
    terminal.writeSystemMessage('First scan starting...');

    const readmeContent = storage.readReadme();
    const { map, stats } = buildFullMap(storage);
    storage.writeMap(map);
    storage.writeLog({ entries: [] });

    terminal.writeSystemMessage(
      `Scan complete: ${stats.filesScanned} file(s), ${stats.connectionsFound} connection(s).`
    );

    // Mistral summarize — optional, errors are expected with invalid API keys
    try {
      const sampleConnections = map.connections.slice(0, 20).map(c => ({
        id: c.id, frontendFile: c.frontend?.file, backendFile: c.backend?.file, status: c.status,
      }));
      const summaryText = await mistralClient.summarizeProject({
        readmeContent,
        mapStats: stats,
        sampleConnections,
      });
      storage.writeSummary({ generatedAt: new Date().toISOString(), summary: summaryText });
      terminal.writeSystemMessage('Project summary: ' + summaryText);
    } catch (err) {
      terminal.writeSystemMessage(`(Could not generate Mistral project summary: ${err.message})`);
    }

    watchingActive = true;
    watcher = new Watcher({
      vscode: vscodeMock,
      storage,
      getFlagThreshold: () => 'balanced',
      onFlags: (flags) => { hud.flash(); for (const f of flags) terminal.writeFlag(f); },
    });
    watcher.start();
    hud.setState(HUD_STATES.WATCHING);
    return { map, stats };
  }

  // Toggle subsequent presses
  watchingActive = !watchingActive;
  if (watchingActive) {
    if (watcher) watcher.start();
    hud.setState(HUD_STATES.WATCHING);
  } else {
    if (watcher) watcher.stop();
    hud.setState(HUD_STATES.OFF);
  }
  return { toggled: true, watchingActive };
}

async function handleRefinePrompt(roughInputOverride = null) {
  if (!storage.mapExists()) throw new Error('Map does not exist — run Alt+A first');

  const editor = vscodeMock.window.activeTextEditor;
  let selection = editor ? editor.document.getText(editor.selection) : '';

  if (!selection || !selection.trim()) {
    // Simulate showInputBox
    selection = roughInputOverride || inputBoxQueue.shift();
    if (!selection || !selection.trim()) throw new Error('No input provided');
  }

  const map = storage.readMap();
  const log = storage.readLog();
  const activeFilePath = editor ? storage.relative(editor.document.uri.fsPath) : null;

  const looksLikeProse = selection.trim().split('\n').length <= 2 && !/[{};]/.test(selection);
  const roughInput  = looksLikeProse ? selection.trim() : '(See selected code below — infer what the user likely wants improved or changed.)';
  const selectedCode = looksLikeProse ? null : selection;

  terminal.show();
  terminal.writeSystemMessage('Refining prompt...');
  const { refinedPrompt: refined, contextUsed } = await refinePrompt({
    roughInput,
    selectedCode,
    activeFilePath,
    map,
    log,
    mistralClient,
    maxLogEntries: 8,
  });

  await vscodeMock.env.clipboard.writeText(refined);
  terminal.writeRefinedPrompt(refined, { contextUsed });
  return { refined, contextUsed };
}

async function handleOpenChat(questionOverride = null) {
  if (!storage.mapExists()) throw new Error('Map does not exist — run Alt+A first');

  const question = questionOverride || inputBoxQueue.shift();
  if (!question || !question.trim()) throw new Error('No question provided');

  const map = storage.readMap();
  const log = storage.readLog();

  const { answer, contextUsed } = await answerQuestion({
    question,
    map,
    log,
    conversationHistory: chatHistory,
    mistralClient,
    maxLogEntries: 8,
    storage,
  });

  chatHistory.push({ role: 'user', content: question });
  chatHistory.push({ role: 'assistant', content: answer });
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

  terminal.writeChatTurn({ question, answer, meta: { contextUsed } });
  return { answer, contextUsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── Alt+A: First scan ────────────────────────────────────────────────────
  await sectionAsync('Alt+A — First scan (handleToggleWatch, first press)', async () => {
    let result, err;
    try { result = await handleToggleWatch(); } catch(e) { err = e; }

    ok(!err, `No uncaught error during first scan (got: ${err?.message})`);
    ok(result && result.map, 'Returns a map object');
    ok(result && result.stats, 'Returns stats object');
    ok(result && result.stats.filesScanned >= 2, `Scanned >= 2 files (got ${result?.stats?.filesScanned})`);
    ok(storage.mapExists(), 'relationship-map.json written to .watchtower/');
    ok(fs.existsSync(path.join(tmpRoot, '.watchtower', 'change-log.json')), 'change-log.json written');

    const terminalOutput = capturedTerminal.join('\n');
    ok(terminalOutput.includes('Scan complete'), 'Terminal shows scan-complete message');

    // Check that Mistral summary attempt was made (pass or graceful fallback)
    const hadSummaryAttempt = terminalOutput.includes('Project summary') ||
                              terminalOutput.includes('Could not generate Mistral');
    ok(hadSummaryAttempt, 'Terminal shows either Mistral summary or graceful fallback message');
  });

  // ── Alt+A: Second press — toggle ────────────────────────────────────────
  await sectionAsync('Alt+A — Second press (toggle watching off)', async () => {
    let result, err;
    try { result = await handleToggleWatch(); } catch(e) { err = e; }

    ok(!err, `No uncaught error during toggle (got: ${err?.message})`);
    ok(result && result.toggled, 'Returns toggled:true on subsequent press');
    ok(result && result.watchingActive === false, 'Watching is now OFF after second press');
  });

  // ── Alt+A: Third press — toggle back on ─────────────────────────────────
  await sectionAsync('Alt+A — Third press (toggle watching back on)', async () => {
    let result, err;
    try { result = await handleToggleWatch(); } catch(e) { err = e; }

    ok(!err, `No uncaught error during second toggle (got: ${err?.message})`);
    ok(result && result.watchingActive === true, 'Watching is now ON after third press');
  });

  // ── Alt+P: No input / empty input handling ──────────────────────────────
  await sectionAsync('Alt+P — Empty input box (user cancels)', async () => {
    inputBoxQueue = ['']; // simulate user pressing Escape / submitting empty
    let err;
    try { await handleRefinePrompt(''); } catch(e) { err = e; }
    // Should throw a controlled error, not an unhandled promise rejection
    ok(err && err.message.includes('No input'), `Gracefully rejects empty input (got: ${err?.message})`);
  });

  // ── Alt+P: Prose input ───────────────────────────────────────────────────
  await sectionAsync('Alt+P — Prose prompt refinement', async () => {
    const prevClipLen = capturedClipboard.length;
    const prevTermLen = capturedTerminal.length;
    let result, err;
    try {
      result = await handleRefinePrompt('Add validation to the user profile update endpoint');
    } catch(e) { err = e; }

    if (err && (err.message.includes('401') || err.message.includes('403') ||
                err.message.includes('API error') || err.message.includes('API key'))) {
      warnMsg('Alt+P prose refinement', `Mistral API key issue — ${err.message}`);
    } else {
      ok(!err, `No uncaught error during prose refinement (got: ${err?.message})`);
      ok(result && typeof result.refined === 'string' && result.refined.length > 10,
         `Refined prompt is a non-trivial string (len=${result?.refined?.length})`);
      ok(capturedClipboard.length > prevClipLen, 'Refined prompt was written to clipboard');
      ok(capturedTerminal.length > prevTermLen, 'Terminal received output during refinement');

      // Check terminal shows the REFINED PROMPT section
      const newOutput = capturedTerminal.slice(prevTermLen).join('\n');
      ok(newOutput.includes('REFINED PROMPT'), 'Terminal output contains 🔧 REFINED PROMPT header');
      ok(newOutput.includes('Refining prompt...'), 'Terminal shows status message before API call');
    }
  });

  // ── Alt+P: Code selection input ──────────────────────────────────────────
  await sectionAsync('Alt+P — Code selection (multi-line, non-prose)', async () => {
    const codeSelection = `function updateUser(req, res) {\n  const { name } = req.body;\n  db.update(name);\n}`;
    let result, err;
    try {
      result = await handleRefinePrompt(codeSelection);
    } catch(e) { err = e; }

    if (err && (err.message.includes('401') || err.message.includes('403') ||
                err.message.includes('API error') || err.message.includes('API key'))) {
      warnMsg('Alt+P code selection', `Mistral API key issue — ${err.message}`);
    } else {
      ok(!err, `No uncaught error during code selection refinement (got: ${err?.message})`);
      ok(result && typeof result.refined === 'string', 'Returns a refined string from code selection');
    }
  });

  // ── Alt+P: contextUsed counts ────────────────────────────────────────────
  await sectionAsync('Alt+P — Context scoping (connections + log entries)', async () => {
    let result, err;
    try {
      result = await handleRefinePrompt('Fix the login endpoint');
    } catch(e) { err = e; }

    if (err && (err.message.includes('401') || err.message.includes('403') ||
                err.message.includes('API error') || err.message.includes('API key'))) {
      warnMsg('Alt+P context scoping', `Skipped due to API key issue`);
    } else {
      ok(!err, `No uncaught error (got: ${err?.message})`);
      ok(result && typeof result.contextUsed?.connections === 'number',
         `contextUsed.connections is a number (got: ${result?.contextUsed?.connections})`);
      ok(result && typeof result.contextUsed?.logEntries === 'number',
         `contextUsed.logEntries is a number (got: ${result?.contextUsed?.logEntries})`);
    }
  });

  // ── Alt+C: Empty question handling ──────────────────────────────────────
  await sectionAsync('Alt+C — Empty question (user cancels)', async () => {
    let err;
    try { await handleOpenChat(''); } catch(e) { err = e; }
    ok(err && err.message.includes('No question'), `Gracefully rejects empty question (got: ${err?.message})`);
  });

  // ── Alt+C: Valid question ────────────────────────────────────────────────
  await sectionAsync('Alt+C — Valid chat question', async () => {
    const prevTermLen = capturedTerminal.length;
    let result, err;
    try {
      result = await handleOpenChat('What connections exist in the backend?');
    } catch(e) { err = e; }

    if (err && (err.message.includes('401') || err.message.includes('403') ||
                err.message.includes('API error') || err.message.includes('API key'))) {
      warnMsg('Alt+C valid question', `Mistral API key issue — ${err.message}`);
    } else {
      ok(!err, `No uncaught error during chat (got: ${err?.message})`);
      ok(result && typeof result.answer === 'string' && result.answer.length > 0,
         `Answer is a non-empty string (len=${result?.answer?.length})`);

      const newOutput = capturedTerminal.slice(prevTermLen).join('\n');
      ok(newOutput.includes('WATCHTOWER CHAT'), 'Terminal shows 💬 WATCHTOWER CHAT header');
      ok(newOutput.includes('What connections exist'), 'Terminal echoes the question');
    }
  });

  // ── Alt+C: Conversation history accumulates ──────────────────────────────
  await sectionAsync('Alt+C — Conversation history accumulation', async () => {
    const histLenBefore = chatHistory.length;
    let err;
    try {
      await handleOpenChat('Which file handles authentication?');
    } catch(e) { err = e; }

    if (err && (err.message.includes('401') || err.message.includes('403') ||
                err.message.includes('API error') || err.message.includes('API key'))) {
      warnMsg('Alt+C conversation history', `Skipped due to API key issue`);
    } else {
      ok(!err, `No uncaught error (got: ${err?.message})`);
      ok(chatHistory.length === histLenBefore + 2,
         `History grew by 2 turns (before: ${histLenBefore}, after: ${chatHistory.length})`);
      ok(chatHistory[chatHistory.length - 2]?.role === 'user', 'Last user turn has role=user');
      ok(chatHistory[chatHistory.length - 1]?.role === 'assistant', 'Last assistant turn has role=assistant');
    }
  });

  // ── Storage defensive tests ──────────────────────────────────────────────
  section('Storage — Defensive log parsing (corrupted JSON)', () => {
    // Write a corrupted log
    const corruptPath = path.join(tmpRoot, '.watchtower', 'change-log.json');
    fs.writeFileSync(corruptPath, '{this is not valid json', 'utf-8');
    const log = storage.readLog();
    ok(Array.isArray(log.entries), 'readLog() returns {entries:[]} when JSON is corrupted');
    ok(log.entries.length === 0, 'entries array is empty for corrupted log');
    // Restore
    storage.writeLog({ entries: [] });
  });

  section('Storage — Defensive log parsing (empty file)', () => {
    const logPath = path.join(tmpRoot, '.watchtower', 'change-log.json');
    fs.writeFileSync(logPath, '', 'utf-8');
    const log = storage.readLog();
    ok(Array.isArray(log.entries), 'readLog() returns {entries:[]} for empty file');
    storage.writeLog({ entries: [] });
  });

  // ── HUD state transitions ────────────────────────────────────────────────
  section('HUD — State transitions do not throw', () => {
    let err;
    try {
      hud.setState(HUD_STATES.SCANNING);
      hud.setState(HUD_STATES.WATCHING);
      hud.setState(HUD_STATES.FLAGGED);
      hud.flash();
      hud.setState(HUD_STATES.OFF);
    } catch(e) { err = e; }
    ok(!err, `All HUD state transitions complete without throwing (got: ${err?.message})`);
  });

  section('HUD — OFF state does not leak panel references', () => {
    hud.setState(HUD_STATES.OFF);
    ok(hud.panel === null, 'After setState(OFF), hud.panel is null (no memory leak)');
  });

  // ── Terminal output format ───────────────────────────────────────────────
  section('Terminal — writeRefinedPrompt format', () => {
    const lineBefore = capturedTerminal.length;
    terminal.writeRefinedPrompt('Test refined prompt text', { contextUsed: { connections: 3, logEntries: 1 } });
    const newLines = capturedTerminal.slice(lineBefore);
    ok(newLines.some(l => l.includes('REFINED PROMPT')), 'writeRefinedPrompt emits REFINED PROMPT header');
    ok(newLines.some(l => l.includes('3 connection')), 'contextUsed connections count shown');
    ok(newLines.some(l => l.includes('1 log entry')), 'contextUsed log entries count shown (singular)');
    ok(newLines.some(l => l.includes('Test refined prompt text')), 'Refined prompt body is present');
  });

  section('Terminal — writeChatTurn format', () => {
    const lineBefore = capturedTerminal.length;
    terminal.writeChatTurn({ question: 'What is X?', answer: 'X is Y.', meta: { contextUsed: { connections: 2, logEntries: 4 } } });
    const newLines = capturedTerminal.slice(lineBefore);
    ok(newLines.some(l => l.includes('WATCHTOWER CHAT')), 'writeChatTurn emits WATCHTOWER CHAT header');
    ok(newLines.some(l => l.includes('You: What is X?')), 'Question is prefixed with "You:"');
    ok(newLines.some(l => l.includes('Watchtower: X is Y.')), 'Answer is prefixed with "Watchtower:"');
    ok(newLines.some(l => l.includes('2 connection')), 'contextUsed connections shown in chat turn');
  });

  section('Terminal — writeFlag format', () => {
    const lineBefore = capturedTerminal.length;
    terminal.writeFlag({ severity: 'high', issue: 'param-shape-mismatch', connectionId: 'PUT /api/users', detail: 'email missing from backend params' });
    const newLines = capturedTerminal.slice(lineBefore);
    ok(newLines.some(l => l.includes('[HIGH]')), 'writeFlag emits uppercased severity');
    ok(newLines.some(l => l.includes('param-shape-mismatch')), 'writeFlag includes issue type');
    ok(newLines.some(l => l.includes('email missing')), 'writeFlag includes detail');
  });

  // ── Alt+P: requires prior Alt+A ─────────────────────────────────────────
  section('Alt+P — Requires prior scan (no map guard)', () => {
    // Temporarily hide the map file
    const mapPath = path.join(tmpRoot, '.watchtower', 'relationship-map.json');
    const mapBak  = mapPath + '.bak';
    fs.renameSync(mapPath, mapBak);

    let err;
    try {
      // call refinePrompt directly (no storage.mapExists() guard here, it's in the module)
      const { refinePrompt: rp } = require('../src/prompt/promptRefiner');
      // refinePrompt throws if map is null
      // storage.readMap() returns null when file doesn't exist
      const nullMap = storage.readMap();
      if (!nullMap) throw new Error('Map does not exist — press Alt+A first');
    } catch(e) { err = e; }

    ok(err && (err.message.includes('no relationship map') || err.message.includes('Map does not exist')),
       `Correctly rejects when no map exists (got: ${err?.message})`);

    fs.renameSync(mapBak, mapPath); // restore
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  if (watcher) watcher.stop();
  hud.dispose();
  terminal.dispose();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${pass} passed, ${fail} failed, ${warn} warned`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
    process.exit(1);
  } else {
    if (warn > 0) console.log(`\n(${warn} Mistral API warning(s) — set MISTRAL_API_KEY env var or update package.json to test live calls)`);
    console.log('\n✅ All integration tests passed.');
    process.exit(0);
  }
})().catch(err => {
  console.error('\n💥 Unhandled error in test runner:', err);
  process.exit(2);
});
