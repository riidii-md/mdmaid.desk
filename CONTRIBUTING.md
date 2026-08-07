# Contributing

## Setup

```bash
npm install
npm test
```

## Development Rules

- Write tests before behavior changes.
- Use Node built-ins unless a dependency removes substantial complexity.
- Treat every registered path and Markdown file as untrusted input.
- Keep mdmaid.desk independent from agentctl, harnesses, and mdmaid.nvim.
- Do not add approval state to the presentation catalog.
- Do not add credentials, transcripts, or real private documents to fixtures.

## Verification

```bash
npm run check
git diff --check
```
