# Vibe Trace

Local-first trace tooling for AI coding sessions.

This first local slice includes:

- Unified Trace JSON Schema and TypeScript types.
- A generic JSON/JSONL parser plus a manual file adapter.
- A local file store under `VIBETRACE_HOME` or `~/.vibetrace`.
- A local Web UI served at `http://localhost:4317`.

## Develop

```bash
npm install
npm run dev
```

The server seeds one fixture trace into the local store when the store is empty.

## Useful Commands

```bash
npm run typecheck
npm test
npm run build
```

## Import Local Agent History

```bash
npm run import:local
```

By default this scans local Cursor, Claude Code, and Codex data and writes unified
trace JSON files into `~/.vibetrace/traces`. To do a smaller smoke test:

```bash
npm run import:local -- --limit-per-source=3
npm run import:local -- --sources=codex,claude_code
```

## Codex Skill

This repository includes an installable Codex skill at `skills/vibe-trace`.

### Install from GitHub

In Codex, ask:

```text
Use $skill-installer to install https://github.com/Clark-zhang/vibe_trace/tree/main/skills/vibe-trace
```

Restart Codex after installing the skill.

Command-line alternative:

```bash
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo Clark-zhang/vibe_trace \
  --path skills/vibe-trace
```

### Install from a Local Checkout

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/vibe-trace "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Then restart Codex.
