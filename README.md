<div align="center">

<img src="icon.png" alt="uv Script Envs logo" width="128" />

# uv Script Envs

**Autocompletion for Python scripts that declare their own dependencies.**

<a href="https://marketplace.visualstudio.com/items?itemName=mlops-club.uv-script-envs"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-install-22C55E?style=for-the-badge&logo=uv&logoColor=white" alt="Install from the VS Code Marketplace" /></a>
<a href="https://github.com/mlops-club/vscode-uv-script-envs/releases/latest"><img src="https://img.shields.io/github/v/release/mlops-club/vscode-uv-script-envs?style=for-the-badge&logo=github&label=release&color=16A34A" alt="Latest release" /></a>
<a href="https://github.com/mlops-club/vscode-uv-script-envs/actions/workflows/build-test-lint-publish.yaml"><img src="https://img.shields.io/github/actions/workflow/status/mlops-club/vscode-uv-script-envs/build-test-lint-publish.yaml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=build" alt="Build status" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-15803D?style=for-the-badge&logo=apache&logoColor=white" alt="License: Apache 2.0" /></a>

</div>

Open a script with a [PEP 723](https://peps.python.org/pep-0723/) `# /// script` block, and this extension
creates the script's [uv](https://docs.astral.sh/uv/) environment if it doesn't exist and selects it as the
Python interpreter, so Pylance resolves the script's imports.

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "httpx",
#     "my-package",
# ]
#
# [tool.uv.sources]
# my-package = { path = "../my_package" }
# ///
import httpx        # resolves, with completion
import my_package   # so does this
```

## Demos

**Quick switch (6 s).** Clicking between two scripts in one folder, each getting its own interpreter.

https://github.com/user-attachments/assets/e8870eaa-458c-4161-83f2-f2eb26f730fe

**Slow switch (47 s).** The same, in depth: each script's `# /// script` block, and the imports that resolve
being the ones that block declares.

https://github.com/user-attachments/assets/7faca443-e531-4919-a5dc-e8e77cb2b6db

The videos play inline on GitHub. Elsewhere, such as the Marketplace page, open the files:
[quick switch](docs/quick-env-switch.mp4), [slow switch](docs/slow-env-switch.mp4).

## Requirements

- [uv](https://docs.astral.sh/uv/getting-started/installation/) on your `PATH`.
- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (`ms-python.python`).
- **Not** the Python Environments extension. See the next section.

## Not compatible with the Python Environments extension

With Microsoft's **Python Environments** extension (`ms-python.vscode-python-envs`) installed, this extension
selects the script's interpreter but Pylance keeps resolving imports against a different environment.

What that looked like, with Python Environments 1.39 in October 2026:

- The script's own imports stayed unresolved. Only packages that also happened to be installed in some other
  `.venv` in the workspace resolved.
- Choosing an interpreter by hand answered `"<some other env>" is already selected as the environment for: "<workspace>"`.

Uninstalling Python Environments fixed it. The cause inside that extension has not been tracked down, so
whether disabling it or setting `"python.useEnvironmentsExtension": false` is enough is untested.

uv Script Envs shows a warning once when it finds Python Environments installed.

## Install

From the [Marketplace](https://marketplace.visualstudio.com/items?itemName=mlops-club.uv-script-envs):

```sh
code --install-extension mlops-club.uv-script-envs
```

Or from a `.vsix`, attached to each [release](https://github.com/mlops-club/vscode-uv-script-envs/releases):

```sh
code --install-extension uv-script-envs-<version>.vsix
```

To recommend it to everyone who opens a repository, add it to that repository's `.vscode/extensions.json`:

```jsonc
{
  "recommendations": ["mlops-club.uv-script-envs"],
  "unwantedRecommendations": ["ms-python.vscode-python-envs"]
}
```

## What it does

When a Python file with a `# /// script` block becomes the active editor, or is saved:

1. It runs `uv sync --script <file>`. That creates the script's environment if there is none and installs
   what the block declares, `[tool.uv.sources]` included.
2. It runs `uv python find --script <file>` to get that environment's interpreter.
3. It selects that interpreter for the workspace folder, and shows a notification.

A script that hasn't changed since its last sync skips steps 1 and 2, so switching back to it is instant.
Saving a script after editing its dependencies syncs it again.

While a script is the active editor its environment stays selected: if something else changes the interpreter,
this extension changes it back. It stops after five attempts in ten seconds rather than fight another
extension forever.

Every `uv` command, its output, and every interpreter switch is logged to the **uv Script Envs** output channel.
That is the place to look when a sync fails.

## Things to know

- **There is no `.venv` folder.** The environment is the one `uv run script.py` already uses. uv keeps it in its
  cache (`~/.cache/uv/environments-v2/<script>-<hash>/` on macOS and Linux), keyed on the script's path. That is
  what lets two scripts in one folder have different environments.
- **VS Code has one interpreter per workspace folder.** Clicking from a script to a file in a project with its
  own `.venv` leaves the script's interpreter selected, unless something switches it. See the next section.
- **Path dependencies are copies.** `{ path = "../my_package" }` is installed into the script's environment, so
  go-to-definition lands in `site-packages` and edits to the package show up after the script is saved again.
  Add `editable = true` to the source for a live link.
- **The first open of a script can be slow**, as slow as installing its dependencies. A `uv: syncing …` item
  shows in the status bar meanwhile.

## Pairs with Python Envy

[Python Envy](https://marketplace.visualstudio.com/items?itemName=teticio.python-envy) switches the interpreter
to the nearest `.venv` folder above the open file. It never creates an environment and knows nothing about
scripts. With both installed, files in a uv project get the project's `.venv` and scripts get their own
environment.

## Settings

| Setting               | Default | What it is                                                                 |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| `uvScriptEnvs.uvPath` | `uv`    | The uv executable. Give a full path if VS Code can't find uv on its PATH. |

## Development

The extension is one plain JavaScript file, `extension.js`, with no build step.

```sh
npm ci
npm test          # node --test, against a stubbed vscode module and a fake uv
npm run lint      # biome check; `npm run format` fixes what it can
npm run package   # builds uv-script-envs-<version>.vsix
code --install-extension uv-script-envs-*.vsix   # then run "Developer: Reload Window"
```

The tests do not start VS Code, so they cannot see what Pylance does with the selected interpreter. Check that
by hand after a change to how the interpreter is selected.

## Releasing

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Merge to `main`.

CI publishes that version to the Marketplace, then tags it `v<version>` and attaches the `.vsix` to a GitHub
release. A push to `main` that leaves the version alone publishes nothing.

### How CI signs in to the Marketplace

Today, with a personal access token in the repository secret `VSCE_TOKEN`:

1. In [Azure DevOps](https://dev.azure.com/mlops-club/_usersSettings/tokens), create a token with
   **Organization: All accessible organizations** and the scope **Marketplace > Manage**. The account must be a
   member of the `mlops-club` publisher.
2. Store it: `gh secret set VSCE_TOKEN --repo mlops-club/vscode-uv-script-envs`.

**That stops working on December 1, 2026**, when Azure DevOps
[retires tokens scoped to all organizations](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/),
the only kind the Marketplace accepts.

The replacement, from the
[VS Code publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), is a
managed identity that GitHub Actions signs in as, with no stored secret. The workflow already has that path: it
takes it when the repository variable `AZURE_CLIENT_ID` is set. It has never run, because it needs an Azure
subscription and the `mlops-club` Microsoft account has none. With a subscription:

1. Create a user-assigned managed identity. An app registration signs in but is
   [reported](https://www.emrecodes.net/posts/2026/07/10/vscode-marketplace-managed-identity.html) to be refused
   at the publish step.
2. Add a federated credential to it: issuer `https://token.actions.githubusercontent.com`, subject
   `repo:mlops-club/vscode-uv-script-envs:ref:refs/heads/main`, audience `api://AzureADTokenExchange`.
3. Set the repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` from the identity's properties
   (`gh variable set`). They are identifiers, not secrets.
4. Run the workflow once. The publish job prints the identity's Marketplace ID, then fails because the identity
   is not a publisher member yet.
5. At <https://marketplace.visualstudio.com/manage/publishers/mlops-club>, add that ID as a member with the
   **Contributor** role, and re-run the job.
6. Delete the `VSCE_TOKEN` secret.
