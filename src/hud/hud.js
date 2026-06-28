/**
 * hud/hud.js
 *
 * Circular HUD (PRD §1.6, §2.1 Supporting Element, §6 Phase 3).
 * A small, glanceable circular status indicator implemented as a VS Code
 * webview panel pinned in the editor. States: Off (hidden) / Scanning
 * (first run only) / Watching (dim, default) / Flagged (brightens/changes
 * color then fades back to dim after a few seconds, no unread/acknowledged
 * state in v1 — PRD §1.6, §4.2).
 *
 * This module is intentionally decoupled from VS Code's API surface where
 * possible (it receives a `createPanel` function) so the rendering logic
 * can be unit-tested without a real extension host.
 */

const { HUD_STATES, FLAG_FADE_MS } = require('../core/constants');

function renderHudHtml(state) {
  const colorByState = {
    [HUD_STATES.OFF]: 'transparent',
    [HUD_STATES.SCANNING]: '#5b8def',
    [HUD_STATES.WATCHING]: '#3a3f4b',
    [HUD_STATES.FLAGGED]: '#e2574c',
  };

  const animationByState = {
    [HUD_STATES.SCANNING]: 'pulse 1.1s ease-in-out infinite',
    [HUD_STATES.FLAGGED]: 'flash 0.6s ease-in-out 2',
    [HUD_STATES.WATCHING]: 'none',
    [HUD_STATES.OFF]: 'none',
  };

  const color = colorByState[state] || colorByState[HUD_STATES.WATCHING];
  const animation = animationByState[state] || 'none';
  const visible = state !== HUD_STATES.OFF;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  html, body {
    margin: 0; padding: 0; background: transparent;
    height: 100%; overflow: hidden;
  }
  .hud-dot {
    width: 16px; height: 16px; border-radius: 50%;
    background: ${color};
    opacity: ${visible ? 1 : 0};
    box-shadow: 0 0 6px ${color};
    transition: background 0.4s ease, opacity 0.4s ease, box-shadow 0.4s ease;
    animation: ${animation};
    position: absolute;
    left: calc(50% - 8px);
    top: calc(50% - 8px);
    cursor: grab;
  }
  .hud-dot:active { cursor: grabbing; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 0.6; }
    50% { transform: scale(1.25); opacity: 1; }
  }
  @keyframes flash {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.4); }
  }
</style>
</head>
<body>
  <div class="hud-dot" id="dot" title="Watchtower: ${state}"></div>
  <script>
    const dot = document.getElementById('dot');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    dot.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = dot.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      const maxX = window.innerWidth - 16;
      const maxY = window.innerHeight - 16;
      x = Math.max(0, Math.min(x, maxX));
      y = Math.max(0, Math.min(y, maxY));
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateState') {
        const state = message.state;
        const HUD_STATES = { OFF: 'off', SCANNING: 'scanning', WATCHING: 'watching', FLAGGED: 'flagged' };
        const colorByState = {
          [HUD_STATES.OFF]: 'transparent',
          [HUD_STATES.SCANNING]: '#5b8def',
          [HUD_STATES.WATCHING]: '#3a3f4b',
          [HUD_STATES.FLAGGED]: '#e2574c',
        };
        const animationByState = {
          [HUD_STATES.SCANNING]: 'pulse 1.1s ease-in-out infinite',
          [HUD_STATES.FLAGGED]: 'flash 0.6s ease-in-out 2',
          [HUD_STATES.WATCHING]: 'none',
          [HUD_STATES.OFF]: 'none',
        };
        const color = colorByState[state] || colorByState[HUD_STATES.WATCHING];
        dot.style.background = color;
        dot.style.boxShadow = '0 0 6px ' + color;
        dot.style.animation = animationByState[state] || 'none';
        dot.style.opacity = state !== HUD_STATES.OFF ? 1 : 0;
        dot.title = "Watchtower: " + state;
      }
    });
  </script>
</body>
</html>`;
}

class Hud {
  /**
   * @param {{ createWebviewPanel: Function }} vscodeLike - the real \`vscode\`
   *   module, or a fake with a compatible createWebviewPanel for tests.
   */
  constructor(vscodeLike) {
    this.vscode = vscodeLike;
    this.panel = null;
    this.state = HUD_STATES.OFF;
    this._fadeTimer = null;
  }

  _ensurePanel() {
    if (this.panel) return this.panel;
    this.panel = this.vscode.window.createWebviewPanel(
      'watchtowerHud',
      'Watchtower',
      { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.html = renderHudHtml(this.state);
    return this.panel;
  }

  setState(newState) {
    this.state = newState;
    if (newState === HUD_STATES.OFF) {
      if (this.panel) {
        this.panel.dispose();
        this.panel = null;
      }
      return;
    }
    const panel = this._ensurePanel();
    panel.webview.postMessage({ type: 'updateState', state: newState });
  }

  /**
   * Flagged state: brighten/change color, then automatically fade back to
   * "watching" after FLAG_FADE_MS regardless of whether the user looked
   * (PRD §1.6 HUD flagged behavior — explicitly no unread/acknowledged
   * state in v1).
   */
  flash() {
    this.setState(HUD_STATES.FLAGGED);
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => {
      this.setState(HUD_STATES.WATCHING);
    }, FLAG_FADE_MS);
  }

  dispose() {
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    if (this.panel) this.panel.dispose();
  }
}

module.exports = { Hud, renderHudHtml };
