# CodeMapper

CodeMapper is a local-first VS Code extension that statically maps Python repositories and generates portable repository context. It parses Python source with the standard-library `ast` module; it never imports or runs project code and does not send source to a service.

## Requirements

- VS Code 1.140 or later.
- Python 3.9 or later on `PATH` (`python3` on macOS/Linux, `py -3` on Windows), or set `codemapper.pythonPath`.
- Node.js and npm for extension development.

The analyzer uses `ast.unparse` (Python 3.9+). CodeMapper keeps its persistent JSON index in VS Code extension storage, not in the project.

## Develop and run

```sh
npm ci
npm run compile
npm run test:analyzer
npm test
```

Open this folder in VS Code and press **F5** to start the Extension Development Host. In that host, open a separate Python repository. After the workspace is trusted, CodeMapper indexes it in the background. The activity bar has a **CodeMapper** view containing modules, files, classes, methods, and functions. Select a symbol to navigate to its source.

Use **CodeMapper: Open Graph** for an interactive calls/dependencies graph. Search and select a node to navigate, use **Focus selected neighborhood** to reduce the view, and use **Fit** to frame it.

Use **CodeMapper: Export Context** to write:

```text
.codemapper/
  CODEBASE.md
  architecture.md
  entrypoints.md
  graph.json
  functions.json
  graph.mmd
  modules/
```

Generated output is opt-in unless `codemapper.autoExport` is enabled. **CodeMapper: Update AGENTS.md Context** separately asks permission before creating or changing an `AGENTS.md` section. It uses begin/end markers and does not claim all assistants automatically discover that file.

## Commands

- `CodeMapper: Index Repository`
- `CodeMapper: Rebuild Index`
- `CodeMapper: Open Graph`
- `CodeMapper: Show Function Callers`
- `CodeMapper: Show Function Callees`
- `CodeMapper: Export Context`
- `CodeMapper: Refresh Explorer`
- `CodeMapper: Update AGENTS.md Context` (optional, explicit confirmation)

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `codemapper.enabled` | `true` | Enable CodeMapper. |
| `codemapper.autoIndex` | `true` | Index trusted Python workspaces on startup. |
| `codemapper.autoUpdate` | `true` | Re-index after Python file create/change/delete/save events. |
| `codemapper.autoExport` | `false` | Regenerate context output after an index update. |
| `codemapper.pythonPath` | `""` | Python 3 executable; empty uses platform detection. |
| `codemapper.exclude` | common generated folders | Workspace-relative folders/globs to exclude. |
| `codemapper.maxGraphNodes` | `200` | Cap graph nodes to keep large graphs navigable. |
| `codemapper.outputDirectory` | `.codemapper` | Workspace-relative export directory. |

Python indexing honors common generated-directory exclusions and simple `.gitignore` rules. Negated `.gitignore` rules and all Git ignore edge cases are not fully implemented. The explicit `codemapper.exclude` setting is also applied.

## Analysis behavior and limitations

Node IDs use a repository-relative path plus qualified symbol name. Renaming a symbol or moving its file changes the ID; there is no history-based rename matching. Imports and calls are best-effort static relationships, not runtime execution traces. Dynamic dispatch, reflection, monkey-patching, re-exports, and some relative/import alias patterns can remain unresolved. Unresolved calls are explicitly represented. Syntax errors are recorded per file while other files remain indexable.

The MVP currently rebuilds the graph from Python files when a change event arrives. It removes deleted-file facts correctly, but does not yet perform AST-level per-file incremental parsing. `.gitignore` filtering is intentionally small and local; it does not invoke Git.

The graph is persisted as an atomic JSON cache. SQLite migration can be introduced later behind the `WorkspaceIndexer` storage boundary if index size warrants it. JavaScript/TypeScript parsing, MCP integration, and Marketplace packaging are not included in this MVP.

## Repository layout

- `src/` contains the VS Code extension and its integration tests.
- `analyzers/python/` contains the standalone Python AST analyzer.
- `test/` contains analyzer tests and Python fixtures.
- `media/` contains extension assets.
- `.github/workflows/` runs lint, compile, analyzer tests, and extension tests on pushes and pull requests.

Generated build output, local virtual environments, VS Code test data, packaged `.vsix` files, and exported `.codemapper/` context are intentionally excluded from Git.

## Tests

`npm run test:analyzer` runs the Python fixture suite covering extraction, imported and aliased calls, unresolved calls, circular imports, syntax recovery, persistence-shape serialization, modifications, deletions, entry points, and stable analysis output. `npm test` also runs the VS Code extension integration suite.
