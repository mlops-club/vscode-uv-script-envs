# Changelog

## 0.1.4

- README only: a header with the logo and badges, and the demos play inline on GitHub.

## 0.1.3

- First version in its own repository, published by CI.
- An icon, and two demo recordings linked from the README.
- Warns once when the Python Environments extension (`ms-python.vscode-python-envs`) is installed: with it,
  Pylance keeps resolving a script's imports against another environment.

## 0.1.2

- The script open when a window reloads gets its environment: the extension waits for the Python extension,
  and rechecks 3 and 10 seconds after startup.
- While a script is the active editor, its environment is reselected if something else changes the interpreter.
  Stops after five attempts in ten seconds.
- Logs every switch to the "uv Script Envs" output channel.

## 0.1.1

- Shows a notification when it switches the interpreter, in place of a brief status bar message.

## 0.1.0

- Opening or saving a Python script with a `# /// script` block runs `uv sync --script` on it and selects its
  interpreter.
