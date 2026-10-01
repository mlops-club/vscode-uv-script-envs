// The extension against a stubbed `vscode` module and a fake `uv` executable.
//
// The fake uv records each call and answers `uv python find --script x.py` with an interpreter path that exists,
// so these tests need neither VS Code nor a network. They do not cover what Pylance does with the selection.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");

const EXTENSION_PATH = path.join(__dirname, "..", "extension.js");
const PROJECT_PYTHON = "/workspace/project/.venv/bin/python";

const FAKE_UV = `#!/bin/sh
echo "$@" >> "$FAKE_UV_CALLS"
if [ "$1" = python ]; then
  echo "$FAKE_UV_ENVS/$(basename "$4" .py)/bin/python3"
fi
`;

let contexts;
let directory;
let editor;
let extension;
let listeners;
let messages;
let installedExtensions;
let pythonApi;

function fakeVscode() {
  return {
    ProgressLocation: { Window: 10 },
    workspace: {
      getConfiguration: () => ({ get: () => path.join(directory, "uv") }),
      getWorkspaceFolder: () => ({ uri: { fsPath: directory } }),
      onDidSaveTextDocument: (listener) => {
        listeners.save = listener;
        return {};
      },
    },
    window: {
      get activeTextEditor() {
        return editor;
      },
      createOutputChannel: () => ({ appendLine: (line) => messages.log.push(line), show() {} }),
      withProgress: (_options, task) => task(),
      onDidChangeActiveTextEditor: (listener) => {
        listeners.editor = listener;
        return {};
      },
      showInformationMessage: async (message) => {
        messages.info.push(message);
      },
      showWarningMessage: async (message) => {
        messages.warning.push(message);
      },
      showErrorMessage: async (message) => {
        messages.error.push(message);
      },
    },
    extensions: {
      getExtension: (id) => (id === "ms-python.python" ? { activate: async () => pythonApi } : installedExtensions[id]),
    },
  };
}

function writeScript(name, text) {
  const scriptPath = path.join(directory, name);
  fs.writeFileSync(scriptPath, text);
  fs.mkdirSync(path.join(directory, "envs", path.basename(name, ".py"), "bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, "envs", path.basename(name, ".py"), "bin", "python3"), "");
  return scriptPath;
}

function open(scriptPath, languageId = "python") {
  editor = {
    document: {
      uri: { scheme: "file", fsPath: scriptPath },
      languageId,
      getText: () => fs.readFileSync(scriptPath, "utf8"),
    },
  };
  listeners.editor?.(editor);
}

function uvCalls() {
  const calls = path.join(directory, "uv-calls");
  return fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
}

function interpreterOf(name) {
  return path.join(directory, "envs", name, "bin", "python3");
}

/** Wait for the extension's background work: it runs uv in a child process and never hands back a promise. */
async function settled(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for the extension");
}

async function quiet() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function context() {
  const state = new Map();
  const created = {
    subscriptions: [],
    globalState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) },
  };
  contexts.push(created);
  return created;
}

// The extension leaves startup timers running; dispose them as VS Code would, so the test process can exit.
afterEach(() => {
  for (const created of contexts) {
    for (const subscription of created.subscriptions) {
      subscription.dispose?.();
    }
  }
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "uv-script-envs-"));
  fs.writeFileSync(path.join(directory, "uv"), FAKE_UV, { mode: 0o755 });
  process.env.FAKE_UV_CALLS = path.join(directory, "uv-calls");
  process.env.FAKE_UV_ENVS = path.join(directory, "envs");

  contexts = [];
  editor = undefined;
  listeners = {};
  messages = { log: [], info: [], warning: [], error: [] };
  installedExtensions = {};
  pythonApi = {
    ready: Promise.resolve(),
    active: PROJECT_PYTHON,
    updates: [],
    environments: {
      getActiveEnvironmentPath: () => ({ path: pythonApi.active }),
      updateActiveEnvironmentPath: async (pythonPath) => {
        pythonApi.updates.push(pythonPath);
        // The Python extension reports bin/python where it was given bin/python3.
        pythonApi.active = pythonPath.replace(/python3$/, "python");
        listeners.environment?.();
      },
      onDidChangeActiveEnvironmentPath: (listener) => {
        listeners.environment = listener;
        return {};
      },
    },
  };

  const load = Module._load;
  Module._load = (request, ...rest) => (request === "vscode" ? fakeVscode() : load(request, ...rest));
  delete require.cache[EXTENSION_PATH];
  extension = require(EXTENSION_PATH);
  Module._load = load;
});

test("a script block is recognised only as its own comment line", () => {
  assert.equal(extension.hasInlineDependencies('# /// script\n# dependencies = ["rich"]\n# ///\n'), true);
  assert.equal(extension.hasInlineDependencies("#!/usr/bin/env -S uv run --script\n# /// script\n# ///\n"), true);
  assert.equal(extension.hasInlineDependencies("import rich\n"), false);
  assert.equal(extension.hasInlineDependencies('text = "# /// script"\n'), false);
});

test("bin/python and bin/python3 of one environment are the same environment", () => {
  assert.equal(extension.isSameEnvironment("/envs/a/bin/python", "/envs/a/bin/python3"), true);
  assert.equal(extension.isSameEnvironment("/envs/a/bin/python", "/envs/b/bin/python"), false);
});

test("opening a script syncs its environment and selects it", async () => {
  const script = writeScript("fetch.py", "# /// script\n# ///\n");
  await extension.activate(context());

  open(script);
  await settled(() => pythonApi.updates.length === 1);

  assert.deepEqual(uvCalls(), [`sync --script ${script}`, `python find --script ${script}`]);
  assert.deepEqual(pythonApi.updates, [interpreterOf("fetch")]);
  assert.equal(messages.info.length, 1);
});

test("the script open at startup is selected without a click", async () => {
  const script = writeScript("fetch.py", "# /// script\n# ///\n");
  open(script);

  await extension.activate(context());
  await settled(() => pythonApi.updates.length === 1);

  assert.deepEqual(pythonApi.updates, [interpreterOf("fetch")]);
});

test("two scripts in one folder each get their own environment", async () => {
  const fetch = writeScript("fetch.py", "# /// script\n# ///\n");
  const report = writeScript("report.py", "# /// script\n# ///\n");
  await extension.activate(context());

  open(fetch);
  await settled(() => pythonApi.updates.length === 1);
  open(report);
  await settled(() => pythonApi.updates.length === 2);

  assert.deepEqual(pythonApi.updates, [interpreterOf("fetch"), interpreterOf("report")]);
});

test("coming back to an unchanged script does not run uv again", async () => {
  const fetch = writeScript("fetch.py", "# /// script\n# ///\n");
  const report = writeScript("report.py", "# /// script\n# ///\n");
  await extension.activate(context());

  open(fetch);
  await settled(() => pythonApi.updates.length === 1);
  open(report);
  await settled(() => pythonApi.updates.length === 2);
  open(fetch);
  await settled(() => pythonApi.updates.length === 3);

  assert.equal(uvCalls().filter((call) => call === `sync --script ${fetch}`).length, 1);
});

test("a file without a script block leaves the interpreter alone", async () => {
  const plain = writeScript("plain.py", "import os\n");
  await extension.activate(context());

  open(plain);
  await quiet();

  assert.deepEqual(uvCalls(), []);
  assert.deepEqual(pythonApi.updates, []);
});

test("a script takes its interpreter back when something else changes it", async () => {
  const script = writeScript("fetch.py", "# /// script\n# ///\n");
  await extension.activate(context());
  open(script);
  await settled(() => pythonApi.updates.length === 1);

  pythonApi.active = PROJECT_PYTHON;
  listeners.environment();
  await settled(() => pythonApi.updates.length === 2);

  assert.equal(pythonApi.active, interpreterOf("fetch").replace(/python3$/, "python"));
});

test("it gives up when something keeps undoing the interpreter", async () => {
  const script = writeScript("fetch.py", "# /// script\n# ///\n");
  await extension.activate(context());
  open(script);
  await settled(() => pythonApi.updates.length === 1);

  for (let round = 0; round < 10; round++) {
    pythonApi.active = PROJECT_PYTHON;
    listeners.environment();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await quiet();

  assert.equal(pythonApi.updates.length, 5);
  assert.equal(pythonApi.active, PROJECT_PYTHON);
});

test("a failed sync reports an error and leaves the interpreter alone", async () => {
  const script = writeScript("fetch.py", "# /// script\n# ///\n");
  fs.writeFileSync(path.join(directory, "uv"), "#!/bin/sh\necho 'No solution found' >&2\nexit 1\n", { mode: 0o755 });
  await extension.activate(context());

  open(script);
  await settled(() => messages.error.length === 1);

  assert.deepEqual(pythonApi.updates, []);
  assert.ok(messages.log.some((line) => line.includes("No solution found")));
});

test("it warns once that the Python Environments extension is installed", async () => {
  installedExtensions["ms-python.vscode-python-envs"] = {};

  await extension.activate(context());
  await settled(() => messages.warning.length === 1);

  assert.match(messages.warning[0], /Python Environments/);
});

test("it says nothing when the Python Environments extension is absent", async () => {
  await extension.activate(context());
  await quiet();

  assert.deepEqual(messages.warning, []);
});
