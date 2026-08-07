# Repository Instructions

## Scope

This repository owns the persistent mdmaid.desk presentation service:
catalog, daemon, watcher, stable document routes, web and TUI workspaces, and
local CLI/API.

## Boundaries

- `mdmaid` owns rendering primitives.
- `agentctl` is a configurator only.
- Harnesses and tools produce documents through generic interfaces.
- `mdmaid.nvim` owns Neovim-specific interaction.
- Opening or registering a document never grants workflow approval.

## Engineering

- Use tests first.
- Keep strict TypeScript enabled.
- Validate structured input at runtime.
- Resolve and authorize real filesystem paths before reading.
- Preserve atomic, user-only state writes.
- Avoid ambient dependencies from parent workspaces.

## Verification

```bash
npm run check
```
