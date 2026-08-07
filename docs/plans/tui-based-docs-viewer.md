# TUI-Based mdmaid.show Viewer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Define how mdmaid.show can offer both the existing web-based documentation viewer and a terminal-native TUI viewer powered by mdmaid's ASCII rendering path.

**Architecture:** mdmaid.show should be a thin viewer/product layer over mdmaid. The web viewer keeps using mdmaid's HTML/server output. The TUI viewer delegates rendering to `mdmaid show --viewer tui` / `mdmaid tui`, which in turn uses Veol first, `beautiful-mermaid` second, and source fallback last.

**Tech Stack:** mdmaid CLI/API, optional web app/server for browser viewer, terminal stdout/TUI mode, Veol CLI, `beautiful-mermaid` fallback through mdmaid.

---

## Product idea

mdmaid.show becomes the user-facing command/place for reading docs rendered through mdmaid:

```bash
mdmaid.show README.md --viewer web
mdmaid.show README.md --viewer tui
mdmaid.show README.md --viewer auto
```

Or, if implemented as mdmaid subcommands instead of a separate binary:

```bash
mdmaid show README.md --viewer web
mdmaid show README.md --viewer tui
mdmaid show README.md --viewer auto
```

The same document can be opened in:

- Browser for beautiful/high-fidelity Mermaid.
- Terminal for SSH/Termius/tmux/CI/native Neovim workflows.

---

## Why this viewer exists

The web viewer is still best when a browser is available. But terminal access is universal:

- SSH into a server.
- Open docs from Termius.
- Use inside tmux.
- Render from Neovim without leaving the editor.
- Read agent-generated Markdown in a terminal.

TUI preview does not need Kitty/Sixel/iTerm image protocols. It renders diagrams as text, so it works anywhere Unicode terminal output works.

---

## Viewer modes

### Web viewer

Purpose: high-fidelity, browser-based reading.

Implementation:

```text
mdmaid.show web
  -> mdmaid serve / renderMarkdown
  -> browser page with live reload, ToC, Mermaid client/SVG rendering
```

Behavior:

- Keep almost exactly the current mdmaid web behavior.
- Later improvements can be incremental: cleaner route names, viewer selector, shared config.
- Use official Mermaid/SVG path for exact rendering.

### TUI viewer

Purpose: terminal-native reading.

Implementation:

```text
mdmaid.show tui
  -> mdmaid tui / mdmaid show --viewer tui
  -> stdout or pager-like terminal view
  -> Veol renders Markdown + Mermaid ASCII
```

Behavior:

- Print rendered docs to stdout for universal composition.
- Optional pager mode later.
- Accept stdin:

```bash
cat README.md | mdmaid.show --viewer tui -
```

- Respect terminal width:

```bash
mdmaid.show README.md --viewer tui --width 100
```

---

## Backend contract with mdmaid

mdmaid.show should not directly own Mermaid parsing policy. It should call mdmaid:

```bash
mdmaid show README.md --viewer tui --backend auto
```

mdmaid decides:

1. Veol available? Use `veol --plain`.
2. Else `beautiful-mermaid` available? Render Mermaid blocks to ASCII.
3. Else preserve fenced source.

This prevents duplicate backend logic between mdmaid, mdmaid.nvim, and mdmaid.show.

---

## Task 1: Decide packaging boundary

**Objective:** Decide whether mdmaid.show is a separate repo/package or a subcommand inside mdmaid.

**Options:**

1. Separate package/repo:

```text
mdmaid.show
  depends on mdmaid
  exposes CLI/web app focused on viewing docs
```

2. mdmaid subcommand only:

```text
mdmaid show README.md --viewer web|tui|auto
```

**Recommendation:** Start with mdmaid subcommand. Create a separate mdmaid.show package later only if the viewer grows into a standalone product/site.

**Verification:** Document the decision in README/ADR.

---

## Task 2: Add viewer command wrapper

**Objective:** Provide a stable entry point for web vs TUI viewing.

**Files if separate repo:**

- Create: `src/cli.ts`
- Create: `src/index.ts`
- Create: `README.md`

**Files if inside mdmaid:**

- Modify: `src/cli/index.ts`
- Modify: `README.md`

**Commands:**

```bash
mdmaid.show <file> --viewer auto|web|tui
mdmaid.show <file> --web
mdmaid.show <file> --tui
mdmaid.show - --viewer tui
```

**Verification:**

```bash
mdmaid.show README.md --viewer tui
mdmaid.show README.md --viewer web
```

Expected: TUI prints to terminal; web opens/serves browser preview.

---

## Task 3: Add viewer auto-detection

**Objective:** Make `--viewer auto` useful without being surprising.

**Rules:**

```text
if --web: web
else if --tui: tui
else if stdin is not TTY: tui stdout
else if SSH_CONNECTION exists: tui
else if NVIM exists or TERM_PROGRAM indicates terminal-only workflow: tui
else: web
```

Keep an escape hatch:

```bash
mdmaid.show README.md --viewer web
mdmaid.show README.md --viewer tui
```

**Verification:** Unit-test the resolver with env/stdin/stdout cases.

---

## Task 4: Add docs and examples

**Objective:** Explain why there are two viewers.

**Docs must include:**

```text
Web viewer:
  beautiful, high fidelity, official Mermaid/SVG, browser required

TUI viewer:
  terminal-native, SSH/Termius/tmux/nvim, ASCII/Unicode Mermaid, approximate but portable
```

Examples:

```bash
mdmaid.show docs/index.md --viewer web
mdmaid.show docs/index.md --viewer tui
ssh server 'mdmaid.show README.md --viewer tui'
cat README.md | mdmaid.show - --viewer tui
```

---

## Task 5: Integrate with mdmaid.nvim docs

**Objective:** Align terminology between packages.

mdmaid.nvim should say:

- Browser preview calls web viewer.
- TUI preview calls TUI viewer.
- Inline Mermaid preview calls block-level ASCII renderer.

This keeps user mental model consistent:

```text
mdmaid.show web = browser docs
mdmaid.show tui = terminal docs
mdmaid.nvim web = open browser
mdmaid.nvim tui = show inside Neovim
```

---

## Open questions

1. Is mdmaid.show a separate repo/package now, or just the `mdmaid show` subcommand?
2. Should TUI mode be stdout-only first, or ship with a pager immediately?
3. Should web mode always open a browser, or only print a local URL by default?
4. Should `auto` default to web on local desktop terminals or TUI everywhere in terminals?

---

## Acceptance criteria

- User can choose web or TUI viewer explicitly.
- TUI viewer works over SSH and Termius.
- Web viewer keeps the existing mdmaid browser experience.
- Viewer code delegates actual rendering to mdmaid, not duplicate Mermaid logic.
- mdmaid.nvim can depend on the same viewer vocabulary and commands.
