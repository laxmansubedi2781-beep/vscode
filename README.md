<div align="center">

# CloudeIDE

**Your coding agent for building ambitious software.**

[Download](https://cloudeide.com) · [Dashboard](https://api.cloudeide.com/app)

</div>

---

CloudeIDE is a code editor with an agent in it that can actually do the work.

Ask for a change in plain words. It reads the real files on your machine —
not an upload, not a copy — searches the project for what it needs, and edits
across as many files as the change takes, creating new ones where it has to.

Nothing is written until you have seen it. Every change comes back as a diff
with an Apply button.

## Install

| | |
|---|---|
| **Windows** | [CloudeIDE-win32-x64.zip](https://github.com/laxmansubedi7/cloudevs/releases/latest/download/CloudeIDE-win32-x64.zip) |
| **macOS** | Apple Silicon — building; not published yet |
| **Linux** | [.deb](https://github.com/laxmansubedi7/cloudevs/releases/latest/download/CloudeIDE-linux-x64.deb) · [.tar.gz](https://github.com/laxmansubedi7/cloudevs/releases/latest/download/CloudeIDE-linux-x64.tar.gz) |

Sign in from inside the app. There is no key to paste and no key to lose —
the agent runs on your CloudeIDE account.

## Everything else still works

This is a fork of [Visual Studio Code](https://github.com/microsoft/vscode),
so it is not a different editor with a familiar look. It is that editor.

Your extensions, your keybindings, your themes, your settings, your terminal,
your debugger, your git, your tasks, your remote and dev container work — all
of it, unchanged. Nothing to relearn and nothing to move.

## Choose the model

Six, from two providers, on one bill. Sonnet by default because a coding turn
is a loop of tool calls and the difference between models shows up as how many
it takes. Set `cloudeide.model` to change it.

## Ship it

When the change is right, Deploy puts the folder on a live URL — build,
hosting and certificate included, and a custom domain if you add one. No
pipeline to write.

## Build from source

```bash
npm install
npm run watch      # then press F5, or:
./scripts/code.sh
```

The editor's own code is under `src/`. The parts that are CloudeIDE's rather
than upstream's are `src/vs/workbench/contrib/cloudeide/` — the panel, the
agent and its tools.

## License

MIT, as upstream. See [LICENSE.txt](LICENSE.txt).
