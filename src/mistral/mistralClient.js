/**
 * mistral/mistralClient.js
 *
 * Mistral cloud API wrapper (PRD §1.4, §1.6 "Mistral's role", §4.2).
 * Strictly advisory/reasoning: refines prompts, answers chat questions,
 * explains flagged issues, and produces the plain-English project summary.
 * NEVER edits the relationship map or the codebase — callers must not
 * feed Mistral's output back into map-building logic.
 *
 * Hosting: cloud API only (PRD §1.6, §4.2 — no local/offline Mistral in v1).
 */

const https = require('https');

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-large-latest';

class MistralClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string|null>} opts.getApiKey - async getter so the
   *   caller can pull from VS Code SecretStorage without this module
   *   needing to know about the VS Code API directly (keeps this module
   *   testable outside the extension host).
   * @param {string} [opts.model]
   */
  constructor({ getApiKey, model = DEFAULT_MODEL }) {
    this.getApiKey = getApiKey;
    this.model = model;
  }

  async _chat(messages, { maxTokens = 800, temperature = 0.3 } = {}) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'No Mistral API key configured. Run "Watchtower: Set Mistral API Key" first.'
      );
    }

    const body = JSON.stringify({
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

    return new Promise((resolve, reject) => {
      const url = new URL(MISTRAL_API_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Mistral API error (${res.statusCode}): ${data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.message?.content || '';
              resolve(content);
            } catch (err) {
              reject(new Error(`Failed to parse Mistral response: ${err.message}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Phase 1 (alt+a first press): produce a plain-English project
   * understanding from the README + map summary.
   */
  async summarizeProject({ readmeContent, mapStats, sampleConnections }) {
    const system = [
      'You are a senior engineer onboarding onto an unfamiliar codebase.',
      'Given a README excerpt and a structural summary of detected file',
      'connections, write a concise plain-English explanation of what this',
      'project is and how its pieces fit together. Be factual and grounded',
      'only in what is given to you — do not invent features or files.',
      'Keep it under 200 words.',
    ].join(' ');

    const userContent = JSON.stringify(
      {
        readmeExcerpt: (readmeContent || '').slice(0, 3000),
        mapStats,
        sampleConnections: sampleConnections.slice(0, 15),
      },
      null,
      2
    );

    return this._chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      { maxTokens: 400 }
    );
  }

  /**
   * Phase 4 (alt+p): rewrite a rough prompt into a structured, explicit
   * one, grounded in relationship-map + change-log context.
   */
  async refinePrompt({ roughInput, selectedCode, mapContext, logContext }) {
    const system = [
      'You refine vague prompts that a human is about to send to an AI',
      'coding agent (Antigravity). You are NOT the coding agent yourself —',
      'you never write or edit code directly. Given the rough prompt/note,',
      'optionally some selected code, and structural context about how',
      'this code connects to the rest of the project (a relationship map',
      'and recent change history), rewrite the prompt to be explicit and',
      'well-constrained. Call out specific files, functions, or shared',
      'handlers that the agent should NOT modify if the context indicates',
      'doing so would break a tracked connection. Be concrete and concise.',
      'Output ONLY the refined prompt text, with no preamble, no markdown',
      'code fences, and no explanation of what you changed.',
    ].join(' ');

    const userContent = JSON.stringify(
      {
        roughInput,
        selectedCode: selectedCode ? selectedCode.slice(0, 4000) : null,
        relevantConnections: mapContext.slice(0, 10),
        recentChangeHistory: logContext.slice(0, 8),
      },
      null,
      2
    );

    return this._chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      { maxTokens: 500 }
    );
  }

  /**
   * Phase 5 (alt+c): answer a chat question grounded in the relationship
   * map and change log, not generic code explanation.
   */
  async answerChatQuestion({ question, mapContext, logContext, fileMetadataContext = null, fileContentsContext = [], conversationHistory = [] }) {
    const system = [
      'You answer questions about a codebase using ONLY the structural',
      'context provided: a relationship map (file/function connections,',
      'cross-language API bridges) and a change log.',
      'If the user asks for implementation details beyond relationships,',
      'use the provided fileContents to act as a RAG system and generate answers.',
      'Ground every answer in this real project data rather',
      'than generic programming explanations. If the context does not',
      'contain enough information to answer confidently, say so plainly',
      'rather than guessing. Be concise.',
      'CRITICAL: Answer using simple terms and natural language (NLP).',
      'Do NOT use technical jargon or code language. Explain concepts clearly',
      'so they are accessible to non-technical users.',
      'If asked about file sizes, line counts, or lines of code, use the provided',
      'fileMetadataContext to answer accurately.',
    ].join(' ');

    const userContent = JSON.stringify(
      {
        question,
        relevantConnections: mapContext.slice(0, 10),
        recentChangeHistory: logContext.slice(0, 8),
        fileMetadata: fileMetadataContext,
        fileContents: fileContentsContext,
      },
      null,
      2
    );

    const messages = [
      { role: 'system', content: system },
      ...conversationHistory,
      { role: 'user', content: userContent },
    ];

    return this._chat(messages, { maxTokens: 700 });
  }

  /**
   * Used by the detector/HUD to produce a human-readable explanation of
   * a flagged issue on demand (e.g. when the user clicks the HUD or asks
   * about it in chat) — separate from the deterministic flag detection
   * itself, which never depends on Mistral.
   */
  async explainFlag({ flag, mapContext, logContext }) {
    const system = [
      'You explain a single flagged connection-break issue to a developer.',
      'The flag was detected mechanically (not by you) by comparing two',
      'scans of the codebase. Explain what likely happened in plain',
      'English, grounded in the provided context, and suggest one',
      'concrete next step. Keep it under 120 words.',
    ].join(' ');

    const userContent = JSON.stringify({ flag, mapContext: mapContext.slice(0, 5), logContext: logContext.slice(0, 5) }, null, 2);

    return this._chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      { maxTokens: 250 }
    );
  }
}

module.exports = { MistralClient, DEFAULT_MODEL };
