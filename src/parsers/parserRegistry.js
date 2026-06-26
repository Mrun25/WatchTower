/**
 * parsers/parserRegistry.js
 *
 * Plugin-style architecture (PRD §1.6 "Same-language parsing approach"):
 * each language gets its own plugin implementing a common interface.
 * Unsupported file types fall back to string-matching only and never
 * block the scan (PRD §2.3, §4.1).
 *
 * Plugin interface:
 *   {
 *     extensions: string[]          // file extensions this plugin handles, e.g. ['js','jsx']
 *     language: string              // language id, e.g. 'javascript'
 *     parse(content, filePath): {
 *       symbols: [{ name, kind, line }],      // functions/classes defined
 *       calls: [{ caller, callee, line }],    // same-language call edges
 *       imports: [{ from, importedNames, line }], // import/require edges
 *       routeRefs: [{ route, method, params, kind, line }] // for cross-language matching
 *     }
 *   }
 */

class ParserRegistry {
  constructor() {
    this.plugins = [];
  }

  register(plugin) {
    this.plugins.push(plugin);
  }

  pluginForExtension(ext) {
    return this.plugins.find(p => p.extensions.includes(ext.toLowerCase()));
  }

  supportedExtensions() {
    return this.plugins.flatMap(p => p.extensions);
  }

  /**
   * Parses a single file. Returns a "fallback" result (empty symbols/calls,
   * but still eligible for route-string matching by the caller) if no
   * plugin is registered for the file's extension, or if the plugin throws.
   * This is the mechanism behind "graceful fallback... never block or
   * break the scan" (PRD §2.3).
   */
  parseFile(filePath, content, ext) {
    const plugin = this.pluginForExtension(ext);
    if (!plugin) {
      return this._fallbackResult(filePath, 'no-plugin-for-extension');
    }
    try {
      const result = plugin.parse(content, filePath);
      return {
        filePath,
        language: plugin.language,
        symbols: result.symbols || [],
        calls: result.calls || [],
        imports: result.imports || [],
        routeRefs: result.routeRefs || [],
        fallback: false,
      };
    } catch (err) {
      // A parser failure must never abort the whole scan — degrade to
      // fallback for this file only.
      return this._fallbackResult(filePath, `parser-error: ${err.message}`);
    }
  }

  _fallbackResult(filePath, reason) {
    return {
      filePath,
      language: null,
      symbols: [],
      calls: [],
      imports: [],
      routeRefs: [],
      fallback: true,
      fallbackReason: reason,
    };
  }
}

module.exports = { ParserRegistry };
