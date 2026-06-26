/**
 * parsers/jsParser.js
 *
 * JS/Node parser plugin (PRD §1.6, §2.3, §3.1). Deliberately regex/heuristic
 * based rather than a full AST parser (e.g. via @babel/parser) to keep the
 * extension dependency-free and fast on large codebases, while still
 * capturing the relationships the product actually needs:
 *   - function/class definitions (symbols)
 *   - same-file and cross-file function calls
 *   - import/require edges
 *   - fetch()/axios()-style calls and Express-style route definitions,
 *     surfaced as routeRefs for the language-agnostic cross-language matcher
 *
 * A production version would likely swap this out for a real AST parser
 * while keeping the same plugin interface — that swap is intentionally
 * isolated to this one file.
 */

const path = require('path');

const FUNCTION_DECL_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ARROW_FN_CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/g;
const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g;
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const REQUIRE_RE = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const IMPORT_RE = /import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s+['"`]([^'"`]+)['"`]/g;
const FETCH_RE = /fetch\(\s*['"`]([^'"`]+)['"`]\s*(?:,)?/g;
const AXIOS_RE = /axios\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
const EXPRESS_ROUTE_RE = /\b(?:app|router)\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g;

const RESERVED_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'new', 'in', 'of', 'do', 'else', 'try', 'finally', 'await', 'yield',
]);

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractSymbols(content) {
  const symbols = [];

  for (const m of content.matchAll(FUNCTION_DECL_RE)) {
    symbols.push({ name: m[1], kind: 'function', line: lineOf(content, m.index) });
  }
  for (const m of content.matchAll(ARROW_FN_CONST_RE)) {
    symbols.push({ name: m[1], kind: 'function', line: lineOf(content, m.index) });
  }
  for (const m of content.matchAll(CLASS_DECL_RE)) {
    symbols.push({ name: m[1], kind: 'class', line: lineOf(content, m.index) });
  }

  return symbols;
}

function extractCalls(content, symbols) {
  const symbolNames = new Set(symbols.map(s => s.name));
  const calls = [];

  for (const m of content.matchAll(CALL_RE)) {
    const name = m[1];
    if (RESERVED_WORDS.has(name)) continue;
    // Only record calls to names we know are locally-defined symbols —
    // this keeps the call graph meaningful rather than matching every
    // built-in/library call in the file.
    if (symbolNames.has(name)) {
      calls.push({ callee: name, line: lineOf(content, m.index) });
    }
  }

  return calls;
}

function extractImports(content) {
  const imports = [];

  for (const m of content.matchAll(REQUIRE_RE)) {
    imports.push({ from: m[1], importedNames: [], line: lineOf(content, m.index) });
  }
  for (const m of content.matchAll(IMPORT_RE)) {
    const named = m[1] ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    const defaultImport = m[2] ? [m[2]] : [];
    imports.push({
      from: m[3],
      importedNames: [...defaultImport, ...named],
      line: lineOf(content, m.index),
    });
  }

  return imports;
}

function extractParamsNear(content, index, windowSize = 600) {
  const window = content.slice(index, index + windowSize);
  const bodyMatch = window.match(/body\s*:\s*JSON\.stringify\(\s*\{([^}]*)\}/);
  if (bodyMatch) {
    return bodyMatch[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
  }
  // axios.post(url, { a, b }) style — second arg object literal
  const directObjMatch = window.match(/^[^(]*\(\s*['"`][^'"`]+['"`]\s*,\s*\{([^}]*)\}/);
  if (directObjMatch) {
    return directObjMatch[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
  }
  return [];
}

function extractMethodNear(content, index, windowSize = 400) {
  const window = content.slice(index, index + windowSize);
  const methodMatch = window.match(/method\s*:\s*['"`](\w+)['"`]/);
  return methodMatch ? methodMatch[1].toUpperCase() : null;
}

function findNextRouteBoundary(content, fromIndex) {
  // Stop the handler-param search window at the next app./router. route
  // definition, if any, so two adjacent route handlers (e.g. GET and PUT
  // on the same path) never bleed into each other's extracted params.
  const rest = content.slice(fromIndex + 1);
  const nextRouteMatch = rest.match(/\b(?:app|router)\.(?:get|post|put|delete|patch|all)\(\s*['"`]/);
  if (!nextRouteMatch) return Math.min(rest.length, 2000);
  return Math.min(nextRouteMatch.index + 1, 2000);
}

function extractHandlerParams(content, startIndex) {
  // Find the arrow-function/handler body that follows a route definition
  // and extract req.body.x / destructured { x, y } = req.body references.
  const windowEnd = findNextRouteBoundary(content, startIndex);
  const window = content.slice(startIndex, startIndex + windowEnd);
  const dotted = [...window.matchAll(/req\.body\.(\w+)/g)].map(m => m[1]);
  const destructureMatch = window.match(/const\s*\{\s*([^}]+)\}\s*=\s*req\.body/);
  const destructured = destructureMatch
    ? destructureMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];
  return [...new Set([...dotted, ...destructured])];
}

function extractRouteRefs(content) {
  const routeRefs = [];

  for (const m of content.matchAll(FETCH_RE)) {
    const route = m[1];
    if (!route.startsWith('/') && !route.startsWith('http')) continue;
    const method = extractMethodNear(content, m.index) || 'GET';
    const params = extractParamsNear(content, m.index);
    routeRefs.push({
      route, method, params, kind: 'frontend-call', line: lineOf(content, m.index),
    });
  }

  for (const m of content.matchAll(AXIOS_RE)) {
    const method = m[1].toUpperCase();
    const route = m[2];
    const params = extractParamsNear(content, m.index);
    routeRefs.push({
      route, method, params, kind: 'frontend-call', line: lineOf(content, m.index),
    });
  }

  for (const m of content.matchAll(EXPRESS_ROUTE_RE)) {
    const method = m[1].toUpperCase();
    const route = m[2];
    const params = extractHandlerParams(content, m.index);
    routeRefs.push({
      route, method, params, kind: 'backend-route', line: lineOf(content, m.index),
    });
  }

  return routeRefs;
}

const jsParserPlugin = {
  extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'html'],
  language: 'javascript',

  parse(content, filePath) {
    const symbols = extractSymbols(content);
    const calls = extractCalls(content, symbols);
    const imports = extractImports(content);
    const routeRefs = extractRouteRefs(content);

    return { symbols, calls, imports, routeRefs };
  },
};

module.exports = { jsParserPlugin };
