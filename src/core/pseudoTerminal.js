/**
 * core/pseudoTerminal.js
 *
 * The pseudo-terminal surface used by both alt+p (prompt refinement
 * output) and alt+c (chat mode) — PRD §3.3, §3.4, §6 Phase 5 success
 * check requires "clear visual separation from alt+p's refined-prompt
 * output in the same terminal."
 *
 * Implemented as a VS Code OutputChannel-backed pseudo-terminal rather
 * than a real pty, since Watchtower doesn't need actual shell semantics —
 * just a readable, append-only conversational/log surface (PRD §1.6:
 * "Shown in pseudo-terminal").
 */

const SEPARATOR = '─'.repeat(60);

class PseudoTerminal {
  /**
   * @param {{ createOutputChannel: Function }} vscodeLike
   */
  constructor(vscodeLike) {
    this.vscode = vscodeLike;
    this.channel = null;
  }

  _ensureChannel() {
    if (!this.channel) {
      this.channel = this.vscode.window.createOutputChannel('Watchtower');
    }
    return this.channel;
  }

  show() {
    this._ensureChannel().show(true);
  }

  /** Distinct, clearly-labeled block for alt+p's refined-prompt output. */
  writeRefinedPrompt(refinedPrompt, meta = {}) {
    const ch = this._ensureChannel();
    ch.appendLine('');
    ch.appendLine(SEPARATOR);
    ch.appendLine('🔧 REFINED PROMPT  (auto-copied to clipboard — paste into Antigravity with Ctrl+V)');
    if (meta.contextUsed) {
      ch.appendLine(`   context used: ${meta.contextUsed.connections} connection(s), ${meta.contextUsed.logEntries} log entr${meta.contextUsed.logEntries === 1 ? 'y' : 'ies'}`);
    }
    ch.appendLine(SEPARATOR);
    ch.appendLine(refinedPrompt);
    ch.appendLine(SEPARATOR);
    ch.appendLine('');
    this.show();
  }

  /** Distinct, clearly-labeled block for alt+c chat turns. */
  writeChatTurn({ question, answer, meta = {} }) {
    const ch = this._ensureChannel();
    ch.appendLine('');
    ch.appendLine(SEPARATOR);
    ch.appendLine('💬 WATCHTOWER CHAT');
    ch.appendLine(SEPARATOR);
    ch.appendLine(`You: ${question}`);
    ch.appendLine('');
    ch.appendLine(`Watchtower: ${answer}`);
    if (meta.contextUsed) {
      ch.appendLine(`   (grounded in ${meta.contextUsed.connections} connection(s), ${meta.contextUsed.logEntries} log entr${meta.contextUsed.logEntries === 1 ? 'y' : 'ies'})`);
    }
    ch.appendLine(SEPARATOR);
    ch.appendLine('');
    this.show();
  }

  writeSystemMessage(message) {
    const ch = this._ensureChannel();
    ch.appendLine(`[watchtower] ${message}`);
    this.show();
  }

  writeFlag(flag) {
    const ch = this._ensureChannel();
    ch.appendLine('');
    ch.appendLine(`🚨 [${flag.severity.toUpperCase()}] ${flag.issue} — ${flag.connectionId}`);
    ch.appendLine(`   ${flag.detail}`);
  }

  dispose() {
    if (this.channel) this.channel.dispose();
  }
}

module.exports = { PseudoTerminal };
