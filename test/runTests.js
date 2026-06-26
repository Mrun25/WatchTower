#!/usr/bin/env node
/**
 * test/runTests.js
 *
 * Lightweight assertion-based test runner (no external test framework
 * dependency, keeping the extension's own install footprint at zero
 * dependencies). Exercises the mechanical core of every phase:
 *   - Phase 1: parsers (JS + Python) + route matcher + full map build
 *   - Phase 2: incremental map updates, change log, thrash detection,
 *     connection-break detection
 *   - Phase 4/5 plumbing: context-scoping logic in promptRefiner /
 *     chatAssistant (using a fake MistralClient so no network call is made)
 *
 * Run with: node test/runTests.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { jsParserPlugin } = require('../src/parsers/jsParser');
const { pythonParserPlugin } = require('../src/parsers/pythonParser');
const { matchRoutes } = require('../src/matcher/routeMatcher');
const { Storage } = require('../src/core/storage');
const { buildFullMap, updateMapForChangedFiles } = require('../src/map/relationshipMap');
const { recordChange, hashContent, isThrashing } = require('../src/log/changeLog');
const { detectBreaks } = require('../src/detection/connectionBreakDetector');
const { findRelevantConnections } = require('../src/prompt/promptRefiner');
const { retrieveRelevantConnections } = require('../src/chat/chatAssistant');

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passCount++;
  } else {
    failCount++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title, fn) {
  console.log(`\n=== ${title} ===`);
  fn();
}

// -----------------------------------------------------------------------
// Phase 1: JS parser plugin
// -----------------------------------------------------------------------
section('Phase 1 — JS parser plugin', () => {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'sample-project', 'frontend', 'userProfile.js');
  const content = fs.readFileSync(fixturePath, 'utf-8');
  const result = jsParserPlugin.parse(content, 'frontend/userProfile.js');

  assert(result.symbols.some(s => s.name === 'fetchUserProfile'), 'detects fetchUserProfile function symbol');
  assert(result.symbols.some(s => s.name === 'updateUserProfile'), 'detects updateUserProfile function symbol');
  assert(result.symbols.some(s => s.name === 'renderProfile'), 'detects renderProfile function symbol');

  const getRef = result.routeRefs.find(r => r.method === 'GET');
  const putRef = result.routeRefs.find(r => r.method === 'PUT');
  assert(!!getRef, 'detects GET fetch call');
  assert(!!putRef, 'detects PUT fetch call');
  assertEqual(putRef && putRef.params.sort(), ['email', 'name'], 'extracts PUT body params correctly');
});

// -----------------------------------------------------------------------
// Phase 1: Python parser plugin
// -----------------------------------------------------------------------
section('Phase 1 — Python parser plugin', () => {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'sample-project', 'backend', 'users.py');
  const content = fs.readFileSync(fixturePath, 'utf-8');
  const result = pythonParserPlugin.parse(content, 'backend/users.py');

  assert(result.symbols.some(s => s.name === 'get_user'), 'detects get_user function symbol');
  assert(result.symbols.some(s => s.name === 'find_user'), 'detects find_user function symbol');

  const getRoute = result.routeRefs.find(r => r.method === 'GET');
  const putRoute = result.routeRefs.find(r => r.method === 'PUT');
  assert(!!getRoute, 'detects Flask GET route');
  assert(!!putRoute, 'detects Flask PUT route');
  assert(getRoute && getRoute.route.includes('/api/users/'), 'GET route path captured correctly');
  assert(putRoute && putRoute.params.includes('name') && putRoute.params.includes('email'), 'PUT route params captured (name, email)');
});

// -----------------------------------------------------------------------
// Phase 1: cross-language route matcher
// -----------------------------------------------------------------------
section('Phase 1 — Cross-language route matcher', () => {
  const jsContent = fs.readFileSync(
    path.join(__dirname, '..', 'test-fixtures', 'sample-project', 'frontend', 'userProfile.js'), 'utf-8'
  );
  const pyContent = fs.readFileSync(
    path.join(__dirname, '..', 'test-fixtures', 'sample-project', 'backend', 'users.py'), 'utf-8'
  );

  const jsResult = jsParserPlugin.parse(jsContent, 'frontend/userProfile.js');
  const pyResult = pythonParserPlugin.parse(pyContent, 'backend/users.py');

  const fileResults = [
    { filePath: 'frontend/userProfile.js', language: 'javascript', routeRefs: jsResult.routeRefs },
    { filePath: 'backend/users.py', language: 'python', routeRefs: pyResult.routeRefs },
  ];

  const connections = matchRoutes(fileResults);
  const getConn = connections.find(c => c.id.startsWith('GET'));
  const putConn = connections.find(c => c.id.startsWith('PUT'));

  assert(!!getConn, 'GET connection exists');
  assert(getConn && getConn.status === 'connected', 'GET connection matched across JS<->Python (param-style route)');
  assert(!!putConn, 'PUT connection exists');
  assert(putConn && putConn.status === 'connected', 'PUT connection matched across JS<->Python');
  assert(putConn && putConn.frontend.file === 'frontend/userProfile.js', 'PUT connection frontend file correct');
  assert(putConn && putConn.backend.file === 'backend/users.py', 'PUT connection backend file correct');
});

// -----------------------------------------------------------------------
// Phase 1: full map build against the sample project on disk
// -----------------------------------------------------------------------
let tmpProjectDir;
section('Phase 1 — Full map build (buildFullMap)', () => {
  // Copy fixtures into a temp dir so we can mutate them for Phase 2 tests
  // without touching the checked-in fixtures.
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-test-'));
  fs.cpSync(path.join(__dirname, '..', 'test-fixtures', 'sample-project'), tmpProjectDir, { recursive: true });

  const storage = new Storage(tmpProjectDir);
  const { map, stats } = buildFullMap(storage);

  assert(stats.filesScanned >= 2, 'scanned at least the 2 fixture source files (+ README)');
  assert(stats.connectionsFound >= 2, 'found at least 2 connections (GET + PUT)');
  assert(map.connections.some(c => c.status === 'connected'), 'at least one connection is "connected"');
  assert(Array.isArray(map.symbols) && map.symbols.length > 0, 'map captures symbols');

  storage.writeMap(map);
  storage.writeLog({ entries: [] });
  assert(storage.mapExists(), 'map file written to .watchtower/relationship-map.json');
});

// -----------------------------------------------------------------------
// Phase 2: incremental update + connection-break detection (the core
// "Phase 0 idea, now in the real architecture" validation)
// -----------------------------------------------------------------------
section('Phase 2 — Incremental update + break detection', () => {
  const storage = new Storage(tmpProjectDir);
  const originalMap = storage.readMap();

  // Apply a contrived breaking edit to the Python backend: rename the
  // PUT handler's expected field from `email` to `contact_email`,
  // mirroring the PRD's running example of a silent cross-file break.
  const backendFile = path.join(tmpProjectDir, 'backend', 'users.py');
  let backendContent = fs.readFileSync(backendFile, 'utf-8');
  assert(backendContent.includes("request.json.get('email')"), 'precondition: fixture has expected unbroken content');
  backendContent = backendContent.replace("request.json.get('email')", "request.json.get('contact_email')");
  fs.writeFileSync(backendFile, backendContent);

  const { updatedMap, freshConnections } = updateMapForChangedFiles(originalMap, storage, [backendFile]);
  const flags = detectBreaks(originalMap.connections, freshConnections, 'balanced');

  assert(flags.length > 0, 'detects at least one flag after the breaking edit');
  const paramFlag = flags.find(f => f.issue === 'param-shape-mismatch');
  assert(!!paramFlag, 'flag is specifically a param-shape-mismatch');
  assert(paramFlag && paramFlag.connectionId.startsWith('PUT'), 'flag correctly identifies the PUT connection');
  assert(paramFlag && paramFlag.detail.includes('email'), 'flag detail mentions the missing "email" param');

  storage.writeMap(updatedMap);

  // Re-running detection against the now-stable state should NOT re-flag
  // identical content (idempotency check).
  const mapAfter = storage.readMap();
  const { freshConnections: freshConnections2 } = updateMapForChangedFiles(mapAfter, storage, []);
  const flags2 = detectBreaks(mapAfter.connections, freshConnections2, 'balanced');
  assert(flags2.length === 0, 'no new flags when nothing changed (idempotent re-check)');

  // Restore the fixture for cleanliness.
  fs.writeFileSync(backendFile, backendContent.replace("request.json.get('contact_email')", "request.json.get('email')"));
});

// -----------------------------------------------------------------------
// Phase 2: change log + thrash detection
// -----------------------------------------------------------------------
section('Phase 2 — Change log + thrash detection', () => {
  let log = { entries: [] };
  const file = 'backend/users.py';

  for (let i = 0; i < 4; i++) {
    log = recordChange(log, {
      filePath: file,
      diffSummary: `edit #${i}`,
      contentHash: hashContent(`content-version-${i}`),
    });
  }

  assert(log.entries.length === 4, 'recorded 4 change entries');
  assert(isThrashing(log, file), 'file touched 4x is flagged as thrashing (threshold 3)');
  assert(!isThrashing(log, 'some/other/file.js'), 'untouched file is not flagged as thrashing');

  // Revert detection: re-apply an earlier hash and confirm it's marked reverted.
  log = recordChange(log, {
    filePath: file,
    diffSummary: 'revert back to version 0',
    contentHash: hashContent('content-version-0'),
  });
  const lastEntry = log.entries[log.entries.length - 1];
  assert(lastEntry.reverted === true, 'reverting to an earlier content hash is detected as a revert');
});

// -----------------------------------------------------------------------
// Phase 4/5 plumbing: context scoping (no network call, pure logic)
// -----------------------------------------------------------------------
section('Phase 4/5 — Context scoping logic', () => {
  const fakeMap = {
    connections: [
      { id: 'GET /api/users/:id', frontend: { file: 'frontend/userProfile.js', route: '/api/users/1' }, backend: { file: 'backend/users.py' }, status: 'connected', flaggedBefore: false },
      { id: 'POST /api/orders', frontend: { file: 'frontend/orders.js', route: '/api/orders' }, backend: { file: 'backend/orders.py' }, status: 'connected', flaggedBefore: true },
    ],
    symbols: [],
  };

  const relevantForFile = findRelevantConnections(fakeMap, { filePath: 'frontend/userProfile.js', selectedCode: null });
  assert(relevantForFile.length === 1 && relevantForFile[0].id === 'GET /api/users/:id', 'promptRefiner scopes connections to the active file');

  const relevantForQuestion = retrieveRelevantConnections(fakeMap, 'why does the orders endpoint keep breaking?');
  assert(relevantForQuestion.some(c => c.id === 'POST /api/orders'), 'chatAssistant retrieves connections matching question keywords');
});

// -----------------------------------------------------------------------
// HUD rendering (pure function, no real webview needed)
// -----------------------------------------------------------------------
section('Phase 3 — HUD state rendering', () => {
  const { renderHudHtml } = require('../src/hud/hud');
  const { HUD_STATES } = require('../src/core/constants');

  const offHtml = renderHudHtml(HUD_STATES.OFF);
  const watchingHtml = renderHudHtml(HUD_STATES.WATCHING);
  const flaggedHtml = renderHudHtml(HUD_STATES.FLAGGED);
  const scanningHtml = renderHudHtml(HUD_STATES.SCANNING);

  assert(offHtml.includes('opacity: 0'), 'OFF state renders hidden (opacity 0)');
  assert(watchingHtml.includes('#3a3f4b'), 'WATCHING state renders dim color');
  assert(flaggedHtml.includes('#e2574c'), 'FLAGGED state renders brightened/alert color');
  assert(scanningHtml.includes('pulse'), 'SCANNING state has a pulse animation');
});

// -----------------------------------------------------------------------
// Regression: adjacent routes on the same path must not bleed params
// into each other (bug found during Phase 2 testing — GET/PUT sharing a
// path had their param-extraction windows overlap).
// -----------------------------------------------------------------------
section('Regression — adjacent same-path routes do not bleed params', () => {
  const jsSource = `
const express = require('express');
const app = express();

app.get('/api/items/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.put('/api/items/:id', (req, res) => {
  const { title, price } = req.body;
  res.json({ title, price });
});
`;
  const jsResult = jsParserPlugin.parse(jsSource, 'backend/items.js');
  const getRoute = jsResult.routeRefs.find(r => r.method === 'GET');
  const putRoute = jsResult.routeRefs.find(r => r.method === 'PUT');
  assert(getRoute && getRoute.params.length === 0, 'GET handler (no req.body) has no leaked params from the PUT handler below it');
  assert(putRoute && putRoute.params.includes('title') && putRoute.params.includes('price'), 'PUT handler correctly captures its own params');

  const pySource = `
from flask import Flask, request, jsonify
app = Flask(__name__)

@app.route('/api/items/<int:item_id>', methods=['GET'])
def get_item(item_id):
    return jsonify({'id': item_id})

@app.route('/api/items/<int:item_id>', methods=['PUT'])
def update_item(item_id):
    title = request.json.get('title')
    price = request.json.get('price')
    return jsonify({'title': title, 'price': price})
`;
  const pyResult = pythonParserPlugin.parse(pySource, 'backend/items.py');
  const pyGetRoute = pyResult.routeRefs.find(r => r.method === 'GET');
  const pyPutRoute = pyResult.routeRefs.find(r => r.method === 'PUT');
  assert(pyGetRoute && !pyGetRoute.params.includes('title') && !pyGetRoute.params.includes('price'), 'Flask GET handler does not leak params from the PUT handler below it');
  assert(pyPutRoute && pyPutRoute.params.includes('title') && pyPutRoute.params.includes('price'), 'Flask PUT handler correctly captures its own params');
});

// -----------------------------------------------------------------------
// Cleanup + summary
// -----------------------------------------------------------------------
if (tmpProjectDir) {
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('✅ All tests passed.');
  process.exit(0);
}
