---
name: Git diff status extension
overview: "Add a minimal VS Code/Cursor extension in the current directory: a status bar item showing summed line adds/removes from `git diff HEAD --numstat`, with 1s debounced updates, git-workspace detection, and click-to-open popup."
todos:
  - id: scaffold-folder
    content: Scaffold package.json (activation *, contributes {}, main, engines), tsconfig (outDir out/, module commonjs), npm scripts in the current directory
    status: pending
  - id: implement-extension
    content: "Implement src/extension.ts: git probe, StatusBarItem, numstat parser, updateStatusBar with threshold notifications (200 light, 500 stern), shared 1s debounce, click -> open Webview popup with settings and terminal commands"
    status: pending
  - id: verify-tsc
    content: Run tsc --noEmit and document F5/manual test steps
    status: pending
isProject: false
---

# Minimal git diff status bar extension

## Scope and location

- We will work directly within the **current directory**, as it was created specifically for this extension.
- Standard layout: `package.json`, `tsconfig.json`, `src/extension.ts`, optional `.vscodeignore` for packaging.

## package.json

- `**activationEvents`**: `["*"]` as requested.
- `**contributes`**: `{}`.
- **Minimal metadata**: `name`, `displayName`, `version`, `publisher` (placeholder), `engines.vscode` (e.g. `^1.80.0`), `main` pointing to compiled output (e.g. `out/extension.js`).
- **Scripts**: `compile` / `watch` via `tsc`; `vscode:prepublish` runs compile.
- **Dev deps**: `typescript`, `@types/vscode`, `@types/node` (for `child_process`).

## extension.ts behavior

1. `**activate(context)`**
  - Resolve workspace root from `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`. If missing, set status text to `No git repo` (or equivalent), register nothing else, return.
  - Run `**git -C <root> rev-parse --is-inside-work-tree`** (e.g. `execFile` with `encoding: 'utf8'`). On failure or stdout not `true`, same: show `No git repo`, return.
  - Create `**StatusBarItem`** (`Left` alignment, default priority), set tooltip briefly (e.g. “Local diff vs HEAD — click for settings & commands”). The `**command`** will trigger a Webview popup. Register a command (e.g., `gitDiffStatus.openPopup`) that creates a small Webview panel or popup. The HTML within the popup will contain:
    1. Input boxes for Light Warning (default 200) and Stern Warning (default 500) thresholds.
    2. A "Show Cursor Terminal" button.
    3. Three input boxes for code snippets, each with a "Send to Terminal" icon/button that opens the Cursor terminal (if closed) and executes the snippet.
  - Call `**updateStatusBar()`** once, then wire subscriptions below.
2. `**updateStatusBar()`**
  - If not in git mode (early exit path), do nothing further.
  - `**execFile('git', ['diff', 'HEAD', '--numstat'], { cwd: root, maxBuffer: 1_000_000 })`**
  - **Parse**: split stdout by newlines; each non-empty line, split on `\t`; take fields 0 and 1; `**parseInt` / regex** — only sum if both are finite non-negative integers; **skip** binary lines (`-` or non-numeric).
  - Set text: `🟩 +<added>   🟥 -<removed>` (spacing as you prefer; keep ASCII `+`/`-` for numbers is fine).
  - **Notification Logic**: Compare the total changed lines (added + removed) against the thresholds. If > Stern Warning threshold (default 500), show a stern warning via `vscode.window.showWarningMessage`. If > Light Warning threshold (default 200), show a lighter information via `vscode.window.showInformationMessage`. Track if warnings were shown so we don't spam notifications on every keystroke.
  - On git error (e.g. not a repo mid-session), show a short fallback message (e.g. `No git repo` or `git error`).
3. **Triggers (all `context.subscriptions.push`)**
  - `**vscode.workspace.onDidChangeTextDocument`**: schedule debounced `updateStatusBar` (1s). Clear previous timeout on each event.
  - `**vscode.workspace.onDidSaveTextDocument`**: optional immediate update or reset debounce and run once — simplest: **also** schedule debounced update (save often follows burst of edits; 1s debounce still OK) **or** call update immediately on save **in addition** to debounce — recommend **immediate update on save** for snappiness after save, plus debounce for typing.
  - `**vscode.window.onDidChangeActiveTextEditor`**: call `updateStatusBar()` (no debounce needed) or debounced — immediate is fine.
  - `**vscode.workspace.createFileSystemWatcher`** with `vscode.RelativePattern(workspaceFolder, '**')` — on `create`/`change`/`delete`, debounced same 1s timer (shared debounce function). Note: broad watchers can fire often; **shared 1s debounce** across watcher + `onDidChangeTextDocument` is enough.
4. **Debounce helper**
  - Single `let t: NodeJS.Timeout | undefined`; function `scheduleUpdate()` clears `t`, sets `t = setTimeout(() => { updateStatusBar(); t = undefined; }, 1000)`.
5. **No `deactivate`** unless you need to clear timers — optional `deactivate` clearing timeout for cleanliness; user said not required.

## Local development / Cursor

- Add short **README** in the extension folder: “Open folder in Cursor, Run Extension” or `F5` with generated `.vscode/launch.json` in extension folder — only if you want; user did not ask for README in deliverables — **omit README** unless you want one line in plan: developer runs “Extension Development Host” from the extension directory.

## Verification

- Run `npm install` and `npx tsc --noEmit` in the extension folder.
- Manual: open a git repo in Extension Host, edit file, wait 1s, confirm counts; save and switch files; open non-git folder, see `No git repo`; click status bar, terminal focuses.

## Diagram (data flow)

```mermaid
flowchart LR
  triggers[Triggers]
  debounce[Debounce1s]
  gitRun[git_diff_HEAD_numstat]
  parse[Parse_and_sum]
  sb[StatusBarItem]
  triggers --> debounce
  triggers -->|save_editor| gitRun
  debounce --> gitRun
  gitRun --> parse
  parse --> sb
  click[Click] --> popup[Webview Popup]
  popup --> updateThresholds[Update Thresholds]
  popup --> showTerminal[Show Terminal]
  popup --> sendSnippet[Send Snippet to Terminal]
  sb --> click
```



