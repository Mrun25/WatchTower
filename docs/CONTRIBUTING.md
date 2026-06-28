# Contributing to Watchtower

First off, thank you for considering contributing to Watchtower!

## Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Mrun25/WatchTower.git
   cd WatchTower
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure API Keys (Optional for local unit tests):**
   To test the AI integration features (Alt+C, Alt+P), you will need a Mistral API key.
   ```bash
   # On Windows (PowerShell)
   $env:MISTRAL_API_KEY="your-api-key"
   ```

4. **Run the Extension:**
   Open the project in VS Code and press `F5` to launch the extension Development Host.

## Testing

Watchtower maintains a suite of deterministic unit and integration tests. It is critical that parsing and map generation remain entirely predictable.

1. **Run Unit Tests:**
   ```bash
   npm run test
   ```

2. **Run Integration Tests:**
   ```bash
   npm run test:integration
   ```

Ensure all tests pass before submitting a Pull Request. If you are adding a new parser or feature, please add corresponding fixtures in the `test-fixtures/` directory and assert them in `runTests.js`.

## Code Style

This project enforces code style via `.editorconfig`. Please make sure your editor is configured to use it (VS Code has an EditorConfig extension).
- JavaScript uses 2 spaces for indentation.
- Python uses 4 spaces.
- Unix line endings (LF).

## Submitting Pull Requests

1. Fork the repository and create your branch from `main`.
2. Write clean, self-documenting code.
3. Update the `ARCHITECTURE.md` if you introduce significant structural changes.
4. Ensure the test suite is completely green.
5. Submit a PR describing your changes, the rationale behind them, and any breaking API changes.
