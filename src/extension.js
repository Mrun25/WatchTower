/**
 * extension.js
 *
 * Main VS Code extension entry point. Wires together every phase from the
 * PRD into the three keybindings (alt+a, alt+p, alt+c) plus the circular
 * HUD. This file deliberately contains little logic of its own — it's a
 * thin coordinator over the modules in src/, matching the PRD's
 * insistence that the four capabilities are "different views onto one
 * shared foundation" (§1.4) rather than separately-implemented features.
 */

const vscode = require('vscode');
const { Storage } = require('./core/storage');
const { HUD_STATES } = require('./core/constants');
const { Hud } = require('./hud/hud');
const { PseudoTerminal } = require('./core/pseudoTerminal');
const { Watcher } = require('./core/watcher');
const { buildFullMap } = require('./map/relationshipMap');
const { refinePrompt } = require('./prompt/promptRefiner');
const { answerQuestion } = require('./chat/chatAssistant');
const { MistralClient } = require('./mistral/mistralClient');

const SECRET_KEY_MISTRAL = 'watchtower.mistralApiKey';

let storage;
let hud;
let terminal;
let watcher;
let mistralClient;
let chatHistory = []; // in-memory per-session conversation history for alt+c
let watchingActive = false;

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

async function getApiKey(context) {
  const fromSecrets = await context.secrets.get(SECRET_KEY_MISTRAL);
  if (fromSecrets) return fromSecrets;
  const fromConfig = vscode.workspace.getConfiguration('watchtower').get('mistralApiKey');
  return fromConfig || process.env.MISTRAL_API_KEY || null;
}

function getFlagThreshold() {
  return vscode.workspace.getConfiguration('watchtower').get('flagThreshold') || 'balanced';
}

function getMaxLogEntries() {
  return vscode.workspace.getConfiguration('watchtower').get('maxLogEntriesInPromptContext') || 8;
}

/**
 * alt+a — first press runs the one-time full scan; subsequent presses
 * toggle passive watching on/off without re-scanning (PRD §1.6, §3.1, §3.2).
 */
async function handleToggleWatch(context) {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('Watchtower: open a project folder first.');
    return;
  }
  storage = storage || new Storage(root);
  if (watcher) {
    watcher.storage = storage;
  }

  const hasExistingMap = storage.mapExists();

  if (!hasExistingMap) {
    // First-ever press in this project: full scan (PRD §3.1).
    hud.setState(HUD_STATES.SCANNING);
    terminal.writeSystemMessage('First scan starting — reading README, running parser plugins, building relationship map...');

    try {
      const readmeContent = storage.readReadme();
      const { map, stats } = buildFullMap(storage);
      storage.writeMap(map);
      storage.writeLog({ entries: [] });

      terminal.writeSystemMessage(
        `Scan complete: ${stats.filesScanned} file(s) scanned (${stats.filesParsed} parsed, ${stats.filesFallback} fallback), ${stats.connectionsFound} connection(s) found.`
      );

      // Send summary to Mistral for plain-English project understanding
      // (PRD §1.6 alt+a first press, §3.1). Advisory only — does not feed
      // back into the map.
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
        terminal.writeSystemMessage('Project summary:');
        terminal.writeSystemMessage(summaryText);
      } catch (err) {
        terminal.writeSystemMessage(
          `(Could not generate Mistral project summary: ${err.message}. The relationship map was still built successfully and all other features will work.)`
        );
      }

      watchingActive = true;
      watcher.start();
      hud.setState(HUD_STATES.WATCHING);
      vscode.window.showInformationMessage('Watchtower: first scan complete. Passive watching is now on.');
    } catch (err) {
      hud.setState(HUD_STATES.OFF);
      vscode.window.showErrorMessage(`Watchtower scan failed: ${err.message}`);
    }
    return;
  }

  // Subsequent presses: toggle only (PRD §3.2).
  watchingActive = !watchingActive;
  if (watchingActive) {
    watcher.start();
    hud.setState(HUD_STATES.WATCHING);
    terminal.writeSystemMessage('Passive watching resumed.');
  } else {
    watcher.stop();
    hud.setState(HUD_STATES.OFF);
    terminal.writeSystemMessage('Passive watching paused.');
  }
}

/**
 * alt+p — prompt refinement (PRD §3.3, §6 Phase 4). Requires the first
 * scan to have completed at least once.
 */
async function handleRefinePrompt() {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('Watchtower: open a project folder first.');
    return;
  }
  storage = storage || new Storage(root);

  if (!storage.mapExists()) {
    vscode.window.showWarningMessage('Watchtower: press Alt+A first to build the relationship map before refining prompts.');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  let selection = editor ? editor.document.getText(editor.selection) : '';
  let activeFilePath = editor ? storage.relative(editor.document.uri.fsPath) : null;

  if (!selection || !selection.trim()) {
    selection = await vscode.window.showInputBox({
      prompt: 'Enter the rough prompt you want Watchtower to refine',
      placeHolder: 'e.g. Add validation to the user profile update'
    });
    if (!selection || !selection.trim()) return;
  }

  const map = storage.readMap();
  const log = storage.readLog();

  // Heuristic: if the selection looks like a prompt/note (short, prose-like,
  // not multi-line code), treat it as roughInput with no separate selectedCode.
  // Otherwise treat the selection as code and ask Mistral to infer the intent.
  const looksLikeProse = selection.trim().split('\n').length <= 2 && !/[{};]/.test(selection);
  const roughInput = looksLikeProse ? selection.trim() : '(See selected code below — infer what the user likely wants improved or changed.)';
  const selectedCode = looksLikeProse ? null : selection;

  try {
    terminal.writeSystemMessage('Refining prompt...');
    const { refinedPrompt, contextUsed } = await refinePrompt({
      roughInput,
      selectedCode,
      activeFilePath,
      map,
      log,
      mistralClient,
      maxLogEntries: getMaxLogEntries(),
    });

    await vscode.env.clipboard.writeText(refinedPrompt);
    terminal.writeRefinedPrompt(refinedPrompt, { contextUsed });
    vscode.window.showInformationMessage('Watchtower: refined prompt copied to clipboard. Paste into Antigravity with Ctrl+V.');
  } catch (err) {
    vscode.window.showErrorMessage(`Watchtower prompt refinement failed: ${err.message}`);
    terminal.writeSystemMessage(`Prompt refinement failed: ${err.message}`);
  }
}

/**
 * alt+c — context-aware chat (PRD §3.4, §6 Phase 5).
 */
async function handleOpenChat() {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('Watchtower: open a project folder first.');
    return;
  }
  storage = storage || new Storage(root);
  terminal.show();

  const question = await vscode.window.showInputBox({
    prompt: 'Ask Watchtower about this codebase',
    placeHolder: "e.g. \"what's wrong with the orders file?\" or \"why does this function exist?\"",
  });
  if (!question || !question.trim()) return;

  const map = storage.readMap();
  const log = storage.readLog();

  try {
    const { answer, contextUsed } = await answerQuestion({
      question,
      map,
      log,
      conversationHistory: chatHistory,
      mistralClient,
      maxLogEntries: getMaxLogEntries(),
      storage,
    });

    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: answer });
    // Keep history bounded so it doesn't grow unbounded across a long session.
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

    terminal.writeChatTurn({ question, answer, meta: { contextUsed } });
  } catch (err) {
    terminal.writeChatTurn({ question, answer: `(error: ${err.message})`, meta: {} });
  }
}

async function handleSetApiKey(context) {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Mistral API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return;
  await context.secrets.store(SECRET_KEY_MISTRAL, key);
  vscode.window.showInformationMessage('Watchtower: Mistral API key saved securely.');
}

function activate(context) {
  hud = new Hud(vscode);
  terminal = new PseudoTerminal(vscode);
  mistralClient = new MistralClient({
    getApiKey: () => getApiKey(context),
    model: vscode.workspace.getConfiguration('watchtower').get('mistralModel'),
  });

  const root = getWorkspaceRoot();
  if (root) {
    storage = new Storage(root);
  }

  watcher = new Watcher({
    vscode,
    storage: storage || new Storage(process.cwd()),
    getFlagThreshold,
    onFlags: (flags) => {
      hud.flash();
      for (const flag of flags) {
        terminal.writeFlag(flag);
      }
    },
  });

  hud.setState(HUD_STATES.OFF);

  context.subscriptions.push(
    vscode.commands.registerCommand('watchtower.toggleWatch', () => handleToggleWatch(context)),
    vscode.commands.registerCommand('watchtower.refinePrompt', () => handleRefinePrompt()),
    vscode.commands.registerCommand('watchtower.openChat', () => handleOpenChat()),
    vscode.commands.registerCommand('watchtower.showHud', () => hud.setState(watchingActive ? HUD_STATES.WATCHING : HUD_STATES.OFF)),
    vscode.commands.registerCommand('watchtower.setApiKey', () => handleSetApiKey(context))
  );
}

function deactivate() {
  if (watcher) watcher.stop();
  if (hud) hud.dispose();
  if (terminal) terminal.dispose();
}

module.exports = { activate, deactivate };
