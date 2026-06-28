#!/usr/bin/env node
/**
 * WATCHTOWER — PHASE 0: DE-RISKING SPIKE
 * =======================================
 * Goal (per PRD §6, Phase 0): Prove the core detection idea works before
 * building anything else around it.
 *
 * Scope: JS-only relationship map + route/string matcher + one-time scan
 * dumping straight to JSON. No Mistral call, no alt+p, no chat, no HUD.
 *
 * Success Check: Can it actually catch a contrived version of the original
 * example — a frontend change breaking a tracked backend connection?
 *
 * USAGE:
 *   node spike.js scan            -> builds map.json from sample-project/
 *   node spike.js break           -> applies a contrived breaking edit to the frontend
 *   node spike.js check           -> re-scans and diffs against map.json to detect the break
 *   node spike.js demo            -> runs scan -> check (clean) -> break -> check (flagged) end-to-end
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, 'sample-project');
const MAP_PATH = path.join(__dirname, 'map.json');

// -----------------------------------------------------------------------
// 1. Extremely lightweight "parser": regex-based extraction of fetch calls
//    (frontend) and route definitions (backend). This is intentionally
//    crude — Phase 0 only needs to prove the matching+detection mechanism,
//    not ship a real parser. Real plugin-based parsing arrives in Phase 1.
// -----------------------------------------------------------------------

function extractFrontendCalls(fileContent, filePath) {
  // Matches fetch('/api/...', { method: 'POST', ... }) call sites.
  // We grab a generous window after the fetch( call and search within it
  // for method + body separately, since naive [^}]* brace matching breaks
  // on nested objects (e.g. headers: {...}) — Phase 0 only needs this to
  // be good enough to prove the detection mechanism, not a real parser.
  const calls = [];
  const fetchStartRegex = /fetch\(\s*['"`]([^'"`]+)['"`]\s*,/g;
  let startMatch;
  while ((startMatch = fetchStartRegex.exec(fileContent)) !== null) {
    const route = startMatch[1];
    const windowStart = startMatch.index;
    const window = fileContent.slice(windowStart, windowStart + 600);

    const methodMatch = window.match(/method\s*:\s*['"`](\w+)['"`]/);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

    const bodyMatch = window.match(/body\s*:\s*JSON\.stringify\(\s*\{([^}]*)\}/);
    const params = bodyMatch
      ? bodyMatch[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
      : [];

    calls.push({
      file: filePath,
      route,
      method,
      params,
      kind: 'frontend-call',
    });
  }
  return calls;
}

function extractBackendRoutes(fileContent, filePath) {
  // Matches app.post('/api/...', (req, res) => { ... req.body.x ... })
  const routes = [];
  const routeRegex = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\}\)/g;
  let match;
  while ((match = routeRegex.exec(fileContent)) !== null) {
    const method = match[1].toUpperCase();
    const route = match[2];
    const handlerBody = match[4];
    // crude param extraction: supports both `req.body.x` and destructured
    // `const { x, y } = req.body;` styles.
    const dottedMatches = [...handlerBody.matchAll(/req\.body\.(\w+)/g)];
    const destructureMatch = handlerBody.match(/const\s*\{\s*([^}]+)\}\s*=\s*req\.body/);
    const destructuredParams = destructureMatch
      ? destructureMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const params = [...new Set([...dottedMatches.map(m => m[1]), ...destructuredParams])];
    routes.push({
      file: filePath,
      route,
      method,
      params,
      kind: 'backend-route',
    });
  }
  return routes;
}

// -----------------------------------------------------------------------
// 2. Route matcher: language-agnostic, matches purely on the route string
//    (per PRD: "Language-agnostic by design: matches on shared strings").
// -----------------------------------------------------------------------

function buildRelationshipMap(projectDir) {
  const frontendDir = path.join(projectDir, 'frontend');
  const backendDir = path.join(projectDir, 'backend');

  let frontendCalls = [];
  let backendRoutes = [];

  for (const file of fs.readdirSync(frontendDir)) {
    const fullPath = path.join(frontendDir, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    frontendCalls.push(...extractFrontendCalls(content, path.relative(projectDir, fullPath)));
  }

  for (const file of fs.readdirSync(backendDir)) {
    const fullPath = path.join(backendDir, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    backendRoutes.push(...extractBackendRoutes(content, path.relative(projectDir, fullPath)));
  }

  // Match by (route, method) shared string key — this is the
  // "cross-language bridge" mechanism the full product will generalize.
  const connections = [];
  for (const call of frontendCalls) {
    const matchingRoute = backendRoutes.find(
      r => r.route === call.route && r.method === call.method
    );
    connections.push({
      id: `${call.method} ${call.route}`,
      frontend: call,
      backend: matchingRoute || null,
      status: matchingRoute ? 'connected' : 'unmatched',
      // confidence is naive in the spike: exact string match = high confidence
      confidence: matchingRoute ? 1.0 : 0.0,
      lastChecked: new Date().toISOString(),
    });
  }

  return {
    builtAt: new Date().toISOString(),
    connections,
  };
}

// -----------------------------------------------------------------------
// 3. Detection: compare a fresh scan against the previously saved map to
//    see if a tracked connection's params/shape has silently diverged.
// -----------------------------------------------------------------------

function diffConnections(oldMap, newMap) {
  const flags = [];

  for (const oldConn of oldMap.connections) {
    const newConn = newMap.connections.find(c => c.id === oldConn.id);

    if (!newConn) {
      flags.push({
        connectionId: oldConn.id,
        issue: 'connection-disappeared',
        detail: `The connection ${oldConn.id} no longer exists in the codebase.`,
      });
      continue;
    }

    if (oldConn.status === 'connected' && newConn.status === 'unmatched') {
      flags.push({
        connectionId: oldConn.id,
        issue: 'backend-route-missing',
        detail: `Frontend still calls ${oldConn.id}, but no matching backend route was found anymore.`,
      });
      continue;
    }

    // Param-shape mismatch: e.g. frontend sends {username, password} but
    // backend now only reads {email, password} -> silent break.
    if (oldConn.backend && newConn.backend) {
      const oldParams = new Set(oldConn.frontend.params);
      const newFrontendParams = new Set(newConn.frontend.params);
      const newBackendParams = new Set(newConn.backend.params);

      const frontendSends = [...newFrontendParams];
      const backendMissingParams = frontendSends.filter(p => !newBackendParams.has(p));

      const oldBackendParams = new Set(oldConn.backend.params);
      const backendParamsChanged =
        oldBackendParams.size !== newBackendParams.size ||
        [...oldBackendParams].some(p => !newBackendParams.has(p));

      if (backendParamsChanged && backendMissingParams.length > 0) {
        flags.push({
          connectionId: oldConn.id,
          issue: 'param-shape-mismatch',
          detail: `Frontend (${newConn.frontend.file}) sends [${frontendSends.join(', ')}] to ${oldConn.id}, but backend (${newConn.backend.file}) no longer reads: [${backendMissingParams.join(', ')}]. Backend params changed from [${[...oldBackendParams].join(', ')}] to [${[...newBackendParams].join(', ')}].`,
        });
      }
    }
  }

  return flags;
}

// -----------------------------------------------------------------------
// 4. CLI commands
// -----------------------------------------------------------------------

function cmdScan() {
  const map = buildRelationshipMap(PROJECT_DIR);
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
  console.log(`[scan] Wrote relationship map to ${MAP_PATH}`);
  console.log(`[scan] Found ${map.connections.length} connection(s):`);
  for (const c of map.connections) {
    console.log(`  - ${c.id}  [${c.status}]  frontend=${c.frontend.file}  backend=${c.backend ? c.backend.file : 'NONE'}`);
  }
  return map;
}

function cmdCheck() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error('[check] No existing map.json found. Run "node spike.js scan" first.');
    process.exit(1);
  }
  const oldMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));
  const newMap = buildRelationshipMap(PROJECT_DIR);
  const flags = diffConnections(oldMap, newMap);

  if (flags.length === 0) {
    console.log('[check] ✅ No connection breaks detected. All tracked connections intact.');
  } else {
    console.log(`[check] 🚨 ${flags.length} connection break(s) detected:`);
    for (const f of flags) {
      console.log(`  - [${f.issue}] ${f.connectionId}`);
      console.log(`    ${f.detail}`);
    }
  }

  // Update the stored map to the latest scan (mirrors how alt+a's passive
  // watching incrementally updates the map in the full product).
  fs.writeFileSync(MAP_PATH, JSON.stringify(newMap, null, 2));
  return flags;
}

function cmdBreak() {
  // Contrived breaking edit: the backend route stops reading `username`
  // and starts reading `email` instead, but the frontend still sends
  // `username`. This mirrors the PRD's running example (a UI change
  // silently breaking a backend connection) in spirit: a one-sided edit
  // that desyncs two previously-matched files.
  const backendFile = path.join(PROJECT_DIR, 'backend', 'auth.js');
  let content = fs.readFileSync(backendFile, 'utf-8');

  if (!content.includes('const { username, password } = req.body;')) {
    console.error('[break] Backend file does not look like the expected un-broken fixture. Aborting.');
    process.exit(1);
  }

  content = content
    .replace('const { username, password } = req.body;', 'const { email, password } = req.body;')
    .replace(/\busername\b/g, 'email');

  fs.writeFileSync(backendFile, content);
  console.log(`[break] Applied contrived breaking edit to ${path.relative(PROJECT_DIR, backendFile)}`);
  console.log('[break] Backend now reads `email` instead of `username`, but frontend still sends `username`.');
}

function cmdDemo() {
  console.log('=== STEP 1: Initial scan (clean state) ===');
  cmdScan();

  console.log('\n=== STEP 2: Check immediately (should be clean) ===');
  cmdCheck();

  console.log('\n=== STEP 3: Apply contrived breaking edit ===');
  cmdBreak();

  console.log('\n=== STEP 4: Check again (should flag the break) ===');
  const flags = cmdCheck();

  console.log('\n=== RESULT ===');
  if (flags.length > 0) {
    console.log('✅ SUCCESS: Phase 0 success check passed — the spike caught a contrived');
    console.log('   frontend change breaking a tracked backend connection.');
  } else {
    console.log('❌ FAILURE: The spike did not catch the break.');
    process.exit(1);
  }
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

const command = process.argv[2];
switch (command) {
  case 'scan':
    cmdScan();
    break;
  case 'check':
    cmdCheck();
    break;
  case 'break':
    cmdBreak();
    break;
  case 'demo':
    cmdDemo();
    break;
  default:
    console.log('Usage: node spike.js <scan|check|break|demo>');
    process.exit(1);
}
