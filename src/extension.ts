import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let statusBarItem: vscode.StatusBarItem;
let popupPanel: vscode.WebviewPanel | undefined;

let lightWarningThreshold = 200;
let sternWarningThreshold = 500;
let lastNotifiedLight = false;
let lastNotifiedStern = false;
let lastNotificationTime = 0;
let reminderInterval = 5; // minutes
let prevTotalLines = -1;

export async function activate(context: vscode.ExtensionContext) {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    // Command to open the popup
    const openPopupCommandId = 'gitDiffStatus.openPopup';
    context.subscriptions.push(vscode.commands.registerCommand(openPopupCommandId, () => {
        showPopup(context);
    }));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = openPopupCommandId;
    statusBarItem.tooltip = "Local diff vs HEAD — click for settings & commands";
    context.subscriptions.push(statusBarItem);

    if (!rootPath) {
        statusBarItem.text = `$(git-commit) No workspace`;
        statusBarItem.show();
        return;
    }

    try {
        const { stdout } = await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--is-inside-work-tree']);
        if (!stdout.includes('true')) {
            statusBarItem.text = `$(git-commit) No git repo`;
            statusBarItem.show();
            return;
        }
    } catch {
        statusBarItem.text = `$(git-commit) No git repo`;
        statusBarItem.show();
        return;
    }

    await updateStatusBar(rootPath);
    statusBarItem.show();

    // Debouncer
    let updateTimeout: NodeJS.Timeout | undefined;
    const scheduleUpdate = () => {
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
            updateStatusBar(rootPath);
            updateTimeout = undefined;
        }, 1000);
    };

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(scheduleUpdate));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
        scheduleUpdate();
        updateStatusBar(rootPath); // immediate update on save
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(rootPath)));

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootPath, '**'));
    context.subscriptions.push(watcher.onDidCreate(scheduleUpdate));
    context.subscriptions.push(watcher.onDidChange(scheduleUpdate));
    context.subscriptions.push(watcher.onDidDelete(scheduleUpdate));
    context.subscriptions.push(watcher);
}

async function updateStatusBar(rootPath: string) {
    try {
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--numstat'], { cwd: rootPath, maxBuffer: 1_000_000 });
        let added = 0;
        let removed = 0;

        const lines = stdout.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const a = parseInt(parts[0], 10);
                const r = parseInt(parts[1], 10);
                if (!isNaN(a) && !isNaN(r)) {
                    added += a;
                    removed += r;
                }
            }
        }

        statusBarItem.text = `🟩 +${added}   🟥 -${removed}`;

        const totalLines = added + removed;
        const currentTime = Date.now();
        const intervalMs = reminderInterval * 60 * 1000;
        
        if (totalLines > sternWarningThreshold) {
            const timeSinceLast = currentTime - lastNotificationTime;
            if (!lastNotifiedStern || timeSinceLast > intervalMs || totalLines > prevTotalLines + 50) { 
                vscode.window.showWarningMessage(`Git Diff: ${totalLines} lines changed! Time to commit!`, 'Got it');
                lastNotifiedStern = true;
                lastNotifiedLight = false;
                lastNotificationTime = currentTime;
            }
        } else if (totalLines > lightWarningThreshold) {
            const timeSinceLast = currentTime - lastNotificationTime;
            if (!lastNotifiedLight || timeSinceLast > intervalMs || totalLines > prevTotalLines + 50) {
                vscode.window.showInformationMessage(`Git Diff: ${totalLines} lines changed. Getting large!`, 'Got it');
                lastNotifiedLight = true;
                lastNotifiedStern = false;
                lastNotificationTime = currentTime;
            }
        } else {
            lastNotifiedLight = false;
            lastNotifiedStern = false;
        }
        prevTotalLines = totalLines;

    } catch (e) {
        statusBarItem.text = `$(git-commit) git error`;
    }
}

let unsavedState: any = null;

function showPopup(context: vscode.ExtensionContext) {
    if (popupPanel) {
        popupPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    popupPanel = vscode.window.createWebviewPanel(
        'gitDiffStatusPopup',
        'Git Diff Status Settings',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true
        }
    );

    const savedNotes = context.workspaceState.get<string>('gitDiffNotes', '');
    popupPanel.webview.html = getWebviewContent(savedNotes);

    popupPanel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'autoSave':
                    if (message.light !== undefined && !isNaN(parseInt(message.light, 10))) {
                        lightWarningThreshold = parseInt(message.light, 10);
                    }
                    if (message.stern !== undefined && !isNaN(parseInt(message.stern, 10))) {
                        sternWarningThreshold = parseInt(message.stern, 10);
                    }
                    if (message.interval !== undefined && !isNaN(parseInt(message.interval, 10))) {
                        reminderInterval = parseInt(message.interval, 10);
                    }
                    if (message.notes !== undefined) {
                        await context.workspaceState.update('gitDiffNotes', message.notes);
                    }
                    return;
                case 'toggleTerminal':
                    vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
                    return;
                case 'sendSnippet':
                    // Get the active terminal or create one if none exists
                    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
                    terminal.show(true); // show but don't take strict focus
                    terminal.sendText(message.text, message.run);
                    vscode.commands.executeCommand('workbench.action.terminal.focus');
                    return;
                case 'sendToAgent':
                    vscode.env.clipboard.writeText(message.text);
                    vscode.commands.executeCommand('workbench.action.chat.open', { query: message.text }).then(undefined, () => {
                        vscode.commands.executeCommand('aipane.action.newChat');
                    });
                    vscode.window.showInformationMessage('Opened Agent with prompt copied. You may need to manually select "@Commit" from the dropdown to create an active context link.');
                    return;
            }
        },
        undefined,
        context.subscriptions
    );

    popupPanel.onDidDispose(() => {
        popupPanel = undefined;
    }, null, context.subscriptions);
}

function getWebviewContent(savedNotes: string) {
    // Escape string for HTML text area
    const htmlNotes = savedNotes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Git Diff Settings</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 5px 20px 20px 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        .group { margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 15px; }
        h3 { margin-top: 10px; margin-bottom: 15px; }
        .flex-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        label { margin-bottom: 0; font-weight: bold; }
        input[type="number"], input[type="text"] { width: 100%; padding: 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: var(--vscode-editor-font-family); }
        .number-input { max-width: 80px !important; text-align: right; margin-bottom: 0 !important; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 12px; cursor: pointer; border-radius: 4px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        textarea { width: 100%; max-width: 100%; box-sizing: border-box; padding: 5px; margin-bottom: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: var(--vscode-editor-font-family); font-size: 0.9em; line-height: 20px; resize: none; overflow-y: hidden; }
        .snippet-section { margin-bottom: 25px; }
        .snippet-header { font-weight: bold; margin-bottom: 6px; margin-top: 17px; }
        .command-row { display: flex; gap: 8px; align-items: center; margin-left: 15px; margin-bottom: 6px; }
        .command-input { flex: 1; margin-bottom: 0 !important; font-size: 0.9em; }
        .action-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 1.25em; }
        .action-btn:hover { background: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <div class="group">
        <h3>Threshold Settings</h3>
        <div class="flex-row">
            <label>Light Warning (total lines)</label>
            <input type="number" style="font-size: 0.8em; color: var(--vscode-descriptionForeground);" id="lightInput" value="${lightWarningThreshold}" oninput="checkDirty()" class="number-input" />
        </div>
        <div class="flex-row">
            <label>Stern Warning (total lines)</label>
            <input type="number" style="font-size: 0.8em; color: var(--vscode-descriptionForeground);" id="sternInput" value="${sternWarningThreshold}" oninput="checkDirty()" class="number-input" />
        </div>
        <div class="flex-row">
            <label>Reminder Interval (minutes)</label>
            <input type="number" style="font-size: 0.8em; color: var(--vscode-descriptionForeground);" id="intervalInput" value="${reminderInterval}" oninput="checkDirty()" class="number-input" />
        </div>
    </div>

    <div class="group">
        <h3>Notes to Self</h3>
        <textarea id="notesInput" rows="3" oninput="resizeTextarea(this); checkDirty()">${htmlNotes}</textarea>
        <div id="saveStatus" style="font-size: 0.8em; color: var(--vscode-descriptionForeground); text-align: right; height: 1em; margin-top: 5px;"></div>
    </div>

    <div class="group">
        <h3>Terminal</h3>
        <button onclick="toggleTerminal()">Toggle Cursor Terminal</button>
    </div>

    <div class="group snippet-section">
        <h3>Quick Commands</h3>
        
        <div class="snippet-header">List last 5 commits</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-log', true)" title="Run in Terminal">🚀</button>
            <input type="text" class="command-input" id="cmd-log" value="git log --oneline -n 5" />
        </div>

        <div class="snippet-header">List all changed files</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-status', true)" title="Run in Terminal">🚀</button>
            <input type="text" class="command-input" id="cmd-status" value="git status" />
        </div>

        <div class="snippet-header">Increase version by PATCH, MINOR or MAJOR</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-patch', false)" title="Copy to Terminal">📋</button>
            <input type="text" class="command-input" id="cmd-patch" value="npm version patch --no-git-tag-version" />
        </div>

        <div class="snippet-header">Stage all changed files</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-add', true)" title="Run in Terminal">🚀</button>
            <input type="text" class="command-input" id="cmd-add" value="git add ." />
        </div>

        <div class="snippet-header">Ask agent for a diff summary</div>
        <div class="command-row">
            <button class="action-btn" onclick="copyToAgent()" title="Open in Agent">🤖</button>
            <input type="text" class="command-input" id="cmd-agent" value="SPARK @Commit Make a commit..." disabled />
        </div>

        <div class="snippet-header">Commit all changed files (enter your own comment)</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-commit', false)" title="Copy to Terminal">📋</button>
            <input type="text" class="command-input" id="cmd-commit" value='git commit -m "COMMENT"' />
        </div>

        <div class="snippet-header">Push all commited changes to web</div>
        <div class="command-row">
            <button class="action-btn" onclick="sendSnippet('cmd-push', true)" title="Run in Terminal">🚀</button>
            <input type="text" class="command-input" id="cmd-push" value="git push" />
        </div>
    </div>

    </div>

    <script>
        const vscode = acquireVsCodeApi();

        let saveTimeout;
        const statusEl = document.getElementById('saveStatus');

        function checkDirty() {
            statusEl.innerText = 'Saving...';
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                const light = document.getElementById('lightInput').value;
                const stern = document.getElementById('sternInput').value;
                const interval = document.getElementById('intervalInput').value;
                const notes = document.getElementById('notesInput').value;
                vscode.postMessage({ command: 'autoSave', light, stern, interval, notes });
                statusEl.innerText = 'Saved';
                setTimeout(() => { if (statusEl.innerText === 'Saved') statusEl.innerText = ''; }, 2000);
            }, 600);
        }

        function resizeTextarea(el) {
            el.style.height = 'auto'; // Reset
            const minHeight = 3 * 20 + 10; // 3 lines
            const maxHeight = 6 * 20 + 10; // 6 lines
            const newHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
            el.style.height = newHeight + 'px';
            if (el.scrollHeight > maxHeight) {
                el.style.overflowY = 'auto';
            } else {
                el.style.overflowY = 'hidden';
            }
        }

        // Initialize textarea height
        window.addEventListener('load', () => resizeTextarea(document.getElementById('notesInput')));

        function toggleTerminal() {
            vscode.postMessage({ command: 'toggleTerminal' });
        }

        function sendSnippet(id, run) {
            const text = document.getElementById(id).value;
            if (text.trim()) {
                vscode.postMessage({ command: 'sendSnippet', text, run });
            }
        }
        
        function copyToAgent() {
            const agentPrompt = \`SPARK @Commit
You are generating a commit message. Follow these rules:

First, output a human‑readable section titled "## Human Readable"
- Include one line below it that summarizes the most important change(s).
- Include 1-7 NUMBERED entries that address the meaningful changes made since last commit.
- Each entry must [1] Be numbered [2] Have a **brief inline title in bold**. [3] A brief high-level summary of the change. It should be 1 sentence, at most 2, that includes what changed and, if not obvious, WHY. You do not need to fill the space if the change was straight-forward. You also should keep things relatively high-level when possible.

Second, output a second section titled "## Terminal Commit"
- Below the header include the text from the first section as a git command using repeated -m flags and no illegal characters ( : ", ', \\\\, $, !, | ) except the required outer quotes.\`;
            vscode.postMessage({ command: 'sendToAgent', text: agentPrompt });
        }
    </script>
</body>
</html>`;
}

export function deactivate() {}
