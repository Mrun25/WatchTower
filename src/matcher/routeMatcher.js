/**
 * matcher/routeMatcher.js
 *
 * Language-agnostic cross-language bridge (PRD §1.6 "Cross-language
 * matching approach"): matches on shared strings (API route paths, config
 * keys) rather than parsing syntax, so it works for any language pair
 * (including files with no parser plugin at all, per the "graceful
 * fallback" requirement in §2.3 / §4.1).
 *
 * Input: a flat list of routeRefs gathered from every parsed file
 * (frontend-call and backend-route kinds), regardless of which language
 * plugin produced them — or none, if the routeRef came from a fallback
 * string scan.
 */

function normalizeRoute(route) {
  // Strip query strings, trailing slashes, and template-literal style
  // path params (`:id`, `{id}`, `${id}`) down to a comparable shape so
  // that minor formatting differences don't prevent a real match.
  let r = route.split('?')[0].trim();
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  r = r.replace(/\$\{[^}]+\}/g, ':param').replace(/\{[^}]+\}/g, ':param');
  return r;
}

function routesMatch(a, b) {
  const na = normalizeRoute(a);
  const nb = normalizeRoute(b);
  if (na === nb) return { match: true, confidence: 1.0 };

  // Segment-wise comparison treating :param-like segments as wildcards,
  // to catch e.g. /api/users/:id vs /api/users/${userId}
  const segA = na.split('/');
  const segB = nb.split('/');
  if (segA.length === segB.length) {
    let allMatch = true;
    for (let i = 0; i < segA.length; i++) {
      const isParamA = segA[i].startsWith(':');
      const isParamB = segB[i].startsWith(':');
      if (isParamA || isParamB) continue;
      if (segA[i] !== segB[i]) { allMatch = false; break; }
    }
    if (allMatch) return { match: true, confidence: 0.85 };
  }

  return { match: false, confidence: 0 };
}

/**
 * Builds connections by matching every frontend-call routeRef against
 * every backend-route routeRef across the whole project, regardless of
 * which file or language produced them.
 *
 * @param {Array} fileResults - array of { filePath, language, routeRefs, fallback }
 * @returns {Array} connections
 */
function matchRoutes(fileResults) {
  const frontendRefs = [];
  const backendRefs = [];

  for (const fr of fileResults) {
    for (const ref of fr.routeRefs) {
      const entry = { ...ref, file: fr.filePath, language: fr.language };
      if (ref.kind === 'frontend-call') frontendRefs.push(entry);
      else if (ref.kind === 'backend-route') backendRefs.push(entry);
    }
  }

  const connections = [];
  const matchedBackendKeys = new Set();

  for (const call of frontendRefs) {
    let best = null;
    for (const route of backendRefs) {
      if (call.method !== route.method) continue;
      const { match, confidence } = routesMatch(call.route, route.route);
      if (match && (!best || confidence > best.confidence)) {
        best = { route, confidence };
      }
    }

    const id = `${call.method} ${normalizeRoute(call.route)}`;
    connections.push({
      id,
      frontend: {
        file: call.file,
        language: call.language,
        route: call.route,
        method: call.method,
        params: call.params || [],
        line: call.line,
      },
      backend: best
        ? {
            file: best.route.file,
            language: best.route.language,
            route: best.route.route,
            method: best.route.method,
            params: best.route.params || [],
            line: best.route.line,
          }
        : null,
      status: best ? 'connected' : 'unmatched',
      confidence: best ? best.confidence : 0,
    });

    if (best) {
      matchedBackendKeys.add(`${best.route.file}:${best.route.line}`);
    }
  }

  // Backend routes with no matching frontend caller are still worth
  // recording (e.g. as "orphan" routes) — useful context for chat/prompt
  // refinement even though they're not a "connection" in the break sense.
  for (const route of backendRefs) {
    const key = `${route.file}:${route.line}`;
    if (matchedBackendKeys.has(key)) continue;
    connections.push({
      id: `${route.method} ${normalizeRoute(route.route)} (orphan-backend)`,
      frontend: null,
      backend: {
        file: route.file,
        language: route.language,
        route: route.route,
        method: route.method,
        params: route.params || [],
        line: route.line,
      },
      status: 'orphan-backend',
      confidence: 0,
    });
  }

  return connections;
}

module.exports = { matchRoutes, normalizeRoute, routesMatch };
