# Watchtower Architecture

Watchtower is a VS Code extension that maintains a deterministic, cross-language dependency map of your project and provides Context-Aware RAG (Retrieval-Augmented Generation) chat features powered by Mistral AI.

## High-Level System Flow

```mermaid
graph TD
    A[VS Code Workspace] -->|Read Files| B(AST Parsers)
    B -->|JS/TS/Python| C{Route Matcher}
    B -->|Fallback| C
    C -->|Generate| D[(relationship-map.json)]
    D --> E(Change Log & Diff Detector)
    E -->|Write| F[(change-log.json)]
    
    subgraph AI Features
        D --> G(RAG Context Builder)
        F --> G
        G -->|Send Map + Log + Question| H((Mistral API))
        H -->|Refined Prompt / Chat Answer| I[HUD & Terminal]
    end
```

## Component Architecture

```mermaid
graph LR
    subgraph VS Code Extension Host
        Ext[extension.js]
        Ext --> Core[Core Module]
        
        Core --> Watcher[File Watcher]
        Core --> Storage[Storage JSON]
        
        Watcher --> MapBuilder[Map Builder]
        MapBuilder --> Parsers[Parsers: JS, Python]
        MapBuilder --> Matcher[Route Matcher]
        
        Watcher --> Detector[Break Detector]
        Detector --> HUD[Status HUD Webview]
        
        Ext --> Prompter[Prompt Refiner]
        Ext --> Chat[Context Chat]
        
        Prompter --> Mistral[Mistral API Client]
        Chat --> Mistral
    end
```

## Sequence Diagram: Passive Watching (Alt+A)

```mermaid
sequenceDiagram
    participant User
    participant Ext as extension.js
    participant Watcher as File Watcher
    participant Map as relationshipMap.js
    participant Detect as Connection Break Detector
    participant HUD as Status HUD

    User->>Ext: Press Alt+A
    Ext->>HUD: Show "Scanning"
    Ext->>Map: buildFullMap()
    Map-->>Ext: map generated
    Ext->>HUD: Show "Watching"
    Ext->>Watcher: Start watching files
    
    Note over User, HUD: Later...
    User->>Watcher: Edits and saves a file
    Watcher->>Map: incrementalUpdate(file)
    Map-->>Watcher: map updated
    Watcher->>Detect: detectBreaks(oldMap, newMap)
    alt Connection Broken
        Detect->>HUD: Show "Flagged"
    else Safe Edit
        Detect->>HUD: Show "Watching"
    end
```

## Directory Structure

```text
watchtower/
├── docs/                     # System architecture and documentation
├── src/
│   ├── chat/                 # NLP/Chat assistant & RAG context builder
│   ├── core/                 # Storage, Constants, Watcher coordinator
│   ├── detection/            # Connection break heuristics
│   ├── hud/                  # Webview UI (Status overlay)
│   ├── log/                  # Change tracking & thrash detection
│   ├── map/                  # Full & incremental map builder
│   ├── matcher/              # Cross-language route string matching
│   ├── mistral/              # Mistral API client
│   ├── parsers/              # Plugin-based AST parsers (JS/Py)
│   └── prompt/               # Prompt refinement logic (Alt+P)
├── test/                     # Unit and Integration tests
├── test-fixtures/            # Fixtures for tests
├── scripts/                  # Utilities for installation/testing
├── archive/                  # Previous spikes and deprecated code
└── package.json              # Extension manifest
```

## Core Subsystems

### 1. AST Parsers & Plugin Architecture (`src/parsers/`)
Watchtower uses a plugin-based parsing system to extract symbols, calls, imports, and route definitions from files. Currently supported:
- **JavaScript**: Uses `acorn` and `acorn-walk`.
- **Python**: Uses `python-ast`.
- **Fallback**: Unrecognized files return a simple structure with `fallback: true`, allowing their raw paths to still be used in RAG.

### 2. The Map (`src/map/` & `src/matcher/`)
The map is a purely deterministic JSON structure (`.watchtower/relationship-map.json`) built independently of any AI. It contains:
- `connections`: Matched frontend -> backend routes.
- `sameLanguageEdges`: Call and import graphs within the same language.
- `files`: Metadata (sizeBytes, lineCount) about all scanned files for RAG.
- `symbols`: Exported functions and classes.

### 3. Connection Break Detector (`src/detection/`)
When the VS Code watcher detects a file change, the detector compares the updated map to the previous map. If a previously connected route changes its parameters or URL, a flag is emitted to the HUD.

### 4. Mistral RAG Client (`src/mistral/`)
Mistral is used **strictly** as an advisory engine. It never edits the relationship map directly.
- **Alt+C (Chat)**: Answers plain-language questions using the map and `fileContents` as context.
- **Alt+P (Prompt Refinement)**: Rewrites vague developer intentions into strict agentic prompts, explicitly warning agents not to break known connections.

### 5. Head-Up Display (HUD) (`src/hud/`)
A lightweight, non-intrusive VS Code Webview panel that stays pinned. It shows:
- Initializing
- Watching
- Broken (Flagged Connection)
- Paused
