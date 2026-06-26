/**
 * parsers/pythonParser.js
 *
 * Python parser plugin (PRD §1.6, §2.3, §3.1). Same heuristic, regex-based
 * approach as the JS plugin — captures defs/classes, calls, imports, and
 * Flask/FastAPI-style route definitions for cross-language matching.
 */

const DEF_RE = /^[ \t]*def\s+([A-Za-z_]\w*)\s*\(/gm;
const CLASS_RE = /^[ \t]*class\s+([A-Za-z_]\w*)/gm;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const IMPORT_RE = /^[ \t]*(?:from\s+([\w.]+)\s+import\s+([\w,\s*]+)|import\s+([\w.,\s]+))/gm;
const FLASK_ROUTE_RE = /@(?:app|bp|blueprint)\.route\(\s*['"`]([^'"`]+)['"`](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g;
const FASTAPI_ROUTE_RE = /@(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
const REQUESTS_RE = /requests\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;

const RESERVED_WORDS = new Set([
  'if', 'for', 'while', 'def', 'class', 'return', 'elif', 'else', 'try',
  'except', 'finally', 'with', 'lambda', 'print', 'len', 'range', 'str',
  'int', 'float', 'list', 'dict', 'set', 'tuple', 'isinstance', 'super',
]);

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractSymbols(content) {
  const symbols = [];
  for (const m of content.matchAll(DEF_RE)) {
    symbols.push({ name: m[1], kind: 'function', line: lineOf(content, m.index) });
  }
  for (const m of content.matchAll(CLASS_RE)) {
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
    if (symbolNames.has(name)) {
      calls.push({ callee: name, line: lineOf(content, m.index) });
    }
  }
  return calls;
}

function extractImports(content) {
  const imports = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    if (m[1]) {
      const names = m[2].split(',').map(s => s.trim()).filter(Boolean);
      imports.push({ from: m[1], importedNames: names, line: lineOf(content, m.index) });
    } else if (m[3]) {
      const modules = m[3].split(',').map(s => s.trim()).filter(Boolean);
      for (const mod of modules) {
        imports.push({ from: mod, importedNames: [], line: lineOf(content, m.index) });
      }
    }
  }
  return imports;
}

function findNextBoundary(content, fromIndex) {
  // Stop the search window at whichever comes first after fromIndex:
  // the next route decorator (@app.route / @app.get etc.) or the next
  // top-level `def`/`class` declaration at column 0. This prevents a
  // route handler's param-extraction window from bleeding into the next
  // handler when two routes are defined close together (e.g. GET and PUT
  // on the same path, one right after another).
  const rest = content.slice(fromIndex);
  const nextDecoratorMatch = rest.slice(1).match(/@(?:app|bp|blueprint|router)\.(?:route|get|post|put|delete|patch)\(/);
  const nextTopLevelDefMatch = rest.slice(1).match(/^\s*\n(?:def|class)\s+\w+/m);

  const candidates = [];
  if (nextDecoratorMatch) candidates.push(nextDecoratorMatch.index + 1);
  if (nextTopLevelDefMatch) candidates.push(nextTopLevelDefMatch.index + 1);

  if (candidates.length === 0) {
    return Math.min(rest.length, 2000); // no boundary found — cap generously
  }
  return Math.min(Math.min(...candidates), 2000);
}

function extractParamsFromDecoratedFunction(content, decoratorIndex) {
  // Look just after the decorator for the function def and its body, then
  // pull out request.json[...] / request.json.get(...) param reads (Flask)
  // or Pydantic-model-style parameter names (FastAPI) as a best-effort
  // signal. The window is scoped to stop before the next route handler
  // (see findNextBoundary) so adjacent handlers never bleed into each
  // other's extracted params.
  const windowEnd = findNextBoundary(content, decoratorIndex);
  const window = content.slice(decoratorIndex, decoratorIndex + windowEnd);

  const bracketReads = [...window.matchAll(/request\.json\[['"`](\w+)['"`]\]/g)].map(m => m[1]);
  const getReads = [...window.matchAll(/request\.json\.get\(\s*['"`](\w+)['"`]/g)].map(m => m[1]);

  // FastAPI: def create_user(payload: UserCreate) -> can't resolve model
  // fields without deeper analysis; instead capture the param identifiers
  // themselves as a coarse signal.
  const defMatch = window.match(/def\s+\w+\s*\(([^)]*)\)/);
  let fnParams = [];
  if (defMatch) {
    fnParams = defMatch[1]
      .split(',')
      .map(s => s.split(':')[0].trim())
      .filter(p => p && p !== 'self' && p !== 'request');
  }

  return [...new Set([...bracketReads, ...getReads, ...fnParams])];
}

function extractRouteRefs(content) {
  const routeRefs = [];

  for (const m of content.matchAll(FLASK_ROUTE_RE)) {
    const route = m[1];
    const methodsBlock = m[2];
    const methods = methodsBlock
      ? methodsBlock.split(',').map(s => s.replace(/['"`\s]/g, '').toUpperCase()).filter(Boolean)
      : ['GET'];
    const params = extractParamsFromDecoratedFunction(content, m.index);
    for (const method of methods) {
      routeRefs.push({ route, method, params, kind: 'backend-route', line: lineOf(content, m.index) });
    }
  }

  for (const m of content.matchAll(FASTAPI_ROUTE_RE)) {
    const method = m[1].toUpperCase();
    const route = m[2];
    const params = extractParamsFromDecoratedFunction(content, m.index);
    routeRefs.push({ route, method, params, kind: 'backend-route', line: lineOf(content, m.index) });
  }

  for (const m of content.matchAll(REQUESTS_RE)) {
    const method = m[1].toUpperCase();
    const route = m[2];
    routeRefs.push({ route, method, params: [], kind: 'frontend-call', line: lineOf(content, m.index) });
  }

  return routeRefs;
}

const pythonParserPlugin = {
  extensions: ['py'],
  language: 'python',

  parse(content, filePath) {
    const symbols = extractSymbols(content);
    const calls = extractCalls(content, symbols);
    const imports = extractImports(content);
    const routeRefs = extractRouteRefs(content);

    return { symbols, calls, imports, routeRefs };
  },
};

module.exports = { pythonParserPlugin };
