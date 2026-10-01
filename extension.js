// Opening a Python script that declares its own dependencies (a PEP 723 `# /// script` block) builds the
// environment uv runs it in and selects that as the interpreter, so Pylance completes the script's packages.
//
// The environment is the one `uv run script.py` uses. uv keeps it in its cache, keyed on the script's path,
// not in a .venv folder beside the script: two scripts in one folder each get their own.
//
// Python Envy does the same job for projects, by switching to the nearest .venv folder above the open file.
// It never creates an environment and it knows nothing about scripts, which is the gap this fills.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const vscode = require("vscode");

const execFileAsync = promisify(execFile);

const SCRIPT_BLOCK_START = /^# \/\/\/ script\s*$/m;
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

// After a reload the Python extension settles on an interpreter late, and may not announce it as a change.
const STARTUP_RECHECK_DELAYS_MS = [3000, 10000];

// A second extension that insists on another interpreter must not start a tug of war.
const MAX_SWITCHES_PER_SCRIPT = 5;
const SWITCH_WINDOW_MS = 10 * 1000;

const PYTHON_ENVIRONMENTS_EXTENSION_ID = "ms-python.vscode-python-envs";
const WARNED_ABOUT_PYTHON_ENVIRONMENTS_KEY = "warnedAboutPythonEnvironmentsExtension";

/** Script path -> the interpreter synced for it, and the script's mtime at that sync. */
const syncedScripts = new Map();

/** Script path -> the sync in flight for it, so two quick clicks on one file share one `uv sync`. */
const syncsInFlight = new Map();

/** Script path -> when this extension last switched the interpreter to it. */
const recentSwitches = new Map();

let log;

/** bin/python and bin/python3 of one environment are the same interpreter; the Python extension reports either. */
function isSameEnvironment(pythonPath, otherPythonPath) {
  return path.dirname(pythonPath) === path.dirname(otherPythonPath);
}

function mayRepeatSwitch(scriptPath) {
  const now = Date.now();
  const recent = (recentSwitches.get(scriptPath) ?? []).filter((time) => now - time < SWITCH_WINDOW_MS);
  if (recent.length >= MAX_SWITCHES_PER_SCRIPT) {
    return false;
  }
  recentSwitches.set(scriptPath, [...recent, now]);
  return true;
}

function hasInlineDependencies(text) {
  return SCRIPT_BLOCK_START.test(text);
}

async function runUv(args, cwd) {
  const uvPath = vscode.workspace.getConfiguration("uvScriptEnvs").get("uvPath", "uv");
  log.appendLine(`$ ${uvPath} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileAsync(uvPath, args, { cwd, timeout: SYNC_TIMEOUT_MS });
  if (stderr.trim()) {
    log.appendLine(stderr.trim());
  }
  return stdout.trim();
}

/** Create or update the script's environment and return its interpreter. Skips uv when the script is unchanged. */
async function syncScript(scriptPath) {
  const mtimeMs = fs.statSync(scriptPath).mtimeMs;
  const synced = syncedScripts.get(scriptPath);
  if (synced && synced.mtimeMs === mtimeMs && fs.existsSync(synced.pythonPath)) {
    return synced.pythonPath;
  }

  const cwd = path.dirname(scriptPath);
  await runUv(["sync", "--script", scriptPath], cwd);
  const pythonPath = await runUv(["python", "find", "--script", scriptPath], cwd);
  syncedScripts.set(scriptPath, { mtimeMs, pythonPath });
  return pythonPath;
}

function syncScriptOnce(scriptPath) {
  let sync = syncsInFlight.get(scriptPath);
  if (!sync) {
    sync = vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Window, title: `uv: syncing ${path.basename(scriptPath)}` },
        () => syncScript(scriptPath),
      )
      .then(
        (pythonPath) => {
          syncsInFlight.delete(scriptPath);
          return pythonPath;
        },
        (error) => {
          syncsInFlight.delete(scriptPath);
          throw error;
        },
      );
    syncsInFlight.set(scriptPath, sync);
  }
  return sync;
}

async function selectScriptEnvironment(document, pythonApi) {
  if (
    document.uri.scheme !== "file" ||
    document.languageId !== "python" ||
    !hasInlineDependencies(document.getText())
  ) {
    return;
  }
  const scriptPath = document.uri.fsPath;

  let pythonPath;
  try {
    pythonPath = await syncScriptOnce(scriptPath);
  } catch (error) {
    log.appendLine(String(error.stderr || error.message));
    const choice = await vscode.window.showErrorMessage(
      `uv Script Envs: could not sync ${path.basename(scriptPath)}`,
      "Show Log",
    );
    if (choice === "Show Log") {
      log.show();
    }
    return;
  }

  // The sync can take a while on a first install. Leave the interpreter alone if the user has moved on.
  if (vscode.window.activeTextEditor?.document.uri.fsPath !== scriptPath) {
    log.appendLine(`${scriptPath}: no longer the active editor, interpreter left alone`);
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const active = pythonApi.environments.getActiveEnvironmentPath(workspaceFolder?.uri);
  if (isSameEnvironment(active.path, pythonPath)) {
    return;
  }
  if (!mayRepeatSwitch(scriptPath)) {
    log.appendLine(`${scriptPath}: something keeps undoing the interpreter, giving up for now`);
    return;
  }
  log.appendLine(`${scriptPath}: interpreter ${active.path} -> ${pythonPath}`);
  await pythonApi.environments.updateActiveEnvironmentPath(pythonPath, workspaceFolder?.uri);
  vscode.window.showInformationMessage(
    `uv Script Envs: interpreter set to the uv environment of ${path.basename(scriptPath)}`,
  );
}

function selectForActiveEditor(pythonApi) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    selectScriptEnvironment(editor.document, pythonApi).catch((error) => log.appendLine(String(error)));
  }
}

/**
 * With Microsoft's Python Environments extension installed, Pylance kept resolving imports against another
 * environment after this extension had selected the script's. Uninstalling it was the fix, so say so once.
 */
async function warnAboutPythonEnvironmentsExtension(context) {
  if (!vscode.extensions.getExtension(PYTHON_ENVIRONMENTS_EXTENSION_ID)) {
    return;
  }
  log.appendLine(`${PYTHON_ENVIRONMENTS_EXTENSION_ID} is installed: script imports may not resolve, see the README`);
  if (context.globalState.get(WARNED_ABOUT_PYTHON_ENVIRONMENTS_KEY)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "uv Script Envs: the Python Environments extension is installed. With it, a script's imports may stay " +
      "unresolved even after its environment is selected. Uninstall or disable it if that happens.",
    "Don't Show Again",
  );
  if (choice === "Don't Show Again") {
    await context.globalState.update(WARNED_ABOUT_PYTHON_ENVIRONMENTS_KEY, true);
  }
}

async function activate(context) {
  log = vscode.window.createOutputChannel("uv Script Envs");
  const pythonApi = await vscode.extensions.getExtension("ms-python.python").activate();
  warnAboutPythonEnvironmentsExtension(context).catch((error) => log.appendLine(String(error)));

  context.subscriptions.push(
    log,
    vscode.window.onDidChangeActiveTextEditor(() => selectForActiveEditor(pythonApi)),
    // Saving is when edited dependencies take effect: the mtime moves, so the next sync runs uv again.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.window.activeTextEditor?.document === document) {
        selectForActiveEditor(pythonApi);
      }
    }),
    // While a script is the open file its environment stays the interpreter, whatever else selects one. Seen on a
    // window reload: the Python extension came up on the interpreter it had last, after this extension had run.
    pythonApi.environments.onDidChangeActiveEnvironmentPath(() => selectForActiveEditor(pythonApi)),
  );

  await pythonApi.ready;
  selectForActiveEditor(pythonApi);
  for (const delayMs of STARTUP_RECHECK_DELAYS_MS) {
    const timer = setTimeout(() => selectForActiveEditor(pythonApi), delayMs);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

function deactivate() {}

module.exports = { activate, deactivate, hasInlineDependencies, isSameEnvironment, syncScript };
