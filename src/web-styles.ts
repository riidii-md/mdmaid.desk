export const WEB_STYLES = `
@font-face {
  font-family: "Departure Mono";
  src: url("/assets/departure-mono.woff2") format("woff2");
  font-display: swap;
}

:root {
  color-scheme: light;
  --bg: #f4f1e8;
  --surface: #fffdf5;
  --surface-2: #ebe7dc;
  --ink: #161612;
  --muted: #6f6c63;
  --line: #c8c3b7;
  --accent: #ff5a36;
  --accent-soft: #ffe0d7;
  --reading: #3569e8;
  --done: #27825c;
  --diff-add: #d4f1dc;
  --diff-add-emphasis: #8fd6a1;
  --diff-delete: #ffd7d0;
  --diff-delete-emphasis: #ff9f92;
  --syntax-comment: #63705f;
  --syntax-function: #005f73;
  --syntax-keyword: #7a2e8e;
  --syntax-literal: #a01852;
  --syntax-number: #9a3412;
  --syntax-operator: #4b5563;
  --syntax-property: #1f5f8b;
  --syntax-string: #8a4b08;
  --syntax-type: #175b87;
  --shadow: 5px 5px 0 #161612;
  font-family: "Departure Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #151512;
  --surface: #1f1f1a;
  --surface-2: #2a2923;
  --ink: #f6f1e5;
  --muted: #aaa69a;
  --line: #4a4840;
  --accent: #ff7758;
  --accent-soft: #4a261e;
  --reading: #7ca0ff;
  --done: #69c69a;
  --diff-add: #1e5239;
  --diff-add-emphasis: #347b55;
  --diff-delete: #5c262a;
  --diff-delete-emphasis: #873b3d;
  --syntax-comment: #a6b49c;
  --syntax-function: #7dd3e8;
  --syntax-keyword: #e3a6ef;
  --syntax-literal: #ff9fc6;
  --syntax-number: #ffb285;
  --syntax-operator: #d1d5db;
  --syntax-property: #91c9ff;
  --syntax-string: #ffd18a;
  --syntax-type: #8ecbff;
  --shadow: 5px 5px 0 #000;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--line) 18%, transparent) 1px, transparent 1px),
    linear-gradient(color-mix(in srgb, var(--line) 18%, transparent) 1px, transparent 1px),
    var(--bg);
  background-size: 24px 24px;
  color: var(--ink);
}

button, input, textarea { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 62px;
  padding: 10px 18px;
  border-bottom: 2px solid var(--ink);
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  backdrop-filter: blur(12px);
}

.brand { display: flex; align-items: baseline; gap: 12px; }
.brand strong { font-size: 17px; letter-spacing: -.04em; }
.brand span, .eyebrow {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
}

.top-actions { display: flex; gap: 9px; align-items: center; }
.live { font-size: 10px; color: var(--done); text-transform: uppercase; }
.live.offline { color: var(--accent); }

.icon-button, .action, .status-filter, .grouping-button, .project-button, .document-card {
  border: 1px solid var(--ink);
  background: var(--surface);
  cursor: pointer;
}
.icon-button, .action { padding: 8px 11px; }
.icon-button:hover, .action:hover { background: var(--ink); color: var(--surface); }

.workspace {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  min-height: calc(100vh - 62px);
}

.sidebar {
  position: sticky;
  top: 62px;
  align-self: start;
  height: calc(100vh - 62px);
  overflow-y: auto;
  border-right: 2px solid var(--ink);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  padding: 24px 14px;
}

.sidebar h2, .queue-header h1 {
  margin: 0;
  font-size: 11px;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.project-nav { display: grid; gap: 7px; margin-top: 14px; }
.project-button {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 10px;
  text-align: left;
  border-color: transparent;
  background: transparent;
}
.project-button:hover { border-color: var(--line); background: var(--surface-2); }
.project-button.active { border-color: var(--ink); background: var(--ink); color: var(--surface); }
.count { opacity: .68; font-variant-numeric: tabular-nums; }
.actions-nav { margin-top: 28px; }
.actions-nav h2 { margin-bottom: 10px; }
.actions-nav .project-button { border-color: var(--line); }
.actions-nav .project-button.active { border-color: var(--ink); }

.reader-toc {
  margin-top: 30px;
  padding: 12px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
}
.reader-toc h2 { margin-bottom: 10px; }
.toc-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.toc-item a {
  display: block;
  padding: 5px 6px;
  color: var(--ink);
  font-size: 10px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-decoration: none;
  border-bottom: 1px dashed transparent;
}
.toc-item a:hover, .toc-item a:focus-visible {
  border-bottom-color: var(--ink);
  outline: none;
}
.toc-level-1 { font-weight: 700; }
.toc-level-2 { padding-left: 8px; }
.toc-level-3 { padding-left: 16px; opacity: .88; }
.toc-level-4 { padding-left: 24px; opacity: .8; }
.toc-level-5, .toc-level-6 { padding-left: 32px; opacity: .72; }

.shortcut-card {
  margin-top: 30px;
  padding: 12px;
  border: 1px dashed var(--line);
  color: var(--muted);
  font-size: 10px;
  line-height: 1.8;
}
kbd { border: 1px solid var(--line); padding: 1px 4px; background: var(--surface); color: var(--ink); }

.main { min-width: 0; padding: 28px clamp(16px, 4vw, 60px) 60px; }
.queue-header { display: grid; gap: 18px; margin-bottom: 22px; }
.queue-title-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
.queue-title-row h1 { font-size: clamp(20px, 4vw, 36px); letter-spacing: -.06em; text-transform: none; }
.queue-title-row p { margin: 0; color: var(--muted); font-size: 11px; }

.controls { display: flex; flex-wrap: wrap; gap: 9px; }
.search {
  min-width: min(340px, 100%);
  flex: 1;
  border: 1px solid var(--ink);
  background: var(--surface);
  color: var(--ink);
  padding: 11px 12px;
  outline: none;
}
.search:focus { box-shadow: 3px 3px 0 var(--accent); }
.status-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.status-filter { padding: 9px 10px; font-size: 10px; text-transform: uppercase; }
.status-filter.active { background: var(--ink); color: var(--surface); }

.grouping-switch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grouping-label { margin-right: 3px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.grouping-button { padding: 7px 9px; font-size: 10px; text-transform: uppercase; }
.grouping-button:hover { background: var(--surface-2); }
.grouping-button.active { background: var(--ink); color: var(--surface); }

.document-queue {
  display: grid;
  gap: 28px;
}

.document-group { display: grid; gap: 12px; }
.document-group h2 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--line);
  font-size: 15px;
}
.document-group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(310px, 100%), 1fr));
  gap: 16px;
}

.document-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-height: 184px;
  padding: 16px;
  text-align: left;
  box-shadow: var(--shadow);
  transition: transform .12s, box-shadow .12s;
}
.document-card:hover, .document-card:focus-visible {
  transform: translate(-2px, -2px);
  box-shadow: 8px 8px 0 var(--ink);
  outline: none;
}
.document-card::before {
  content: "";
  position: absolute;
  top: -1px; left: -1px; bottom: -1px;
  width: 6px;
  background: var(--accent);
}
.document-card.status-reading::before { background: var(--reading); }
.document-card.status-done::before { background: var(--done); }
.document-card.source-missing::before { background: var(--muted); }
.card-topline { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 9px; text-transform: uppercase; }
.status-label { color: var(--accent); }
.status-reading .status-label { color: var(--reading); }
.status-done .status-label { color: var(--done); }
.source-missing .status-label { color: var(--muted); }
.document-card strong { font-size: 17px; line-height: 1.35; }
.card-detail { color: var(--muted); font-size: 10px; line-height: 1.6; }
.action-required { color: var(--accent); font-weight: 700; text-transform: uppercase; }
.tag-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: auto; }
.tag { padding: 3px 6px; background: var(--surface-2); font-size: 9px; color: var(--muted); }

.empty {
  border: 1px dashed var(--line);
  padding: 48px 20px;
  text-align: center;
  color: var(--muted);
}
.error-state { border-color: var(--accent); }
.error-state strong { display: block; color: var(--accent); font-size: 18px; }
.error-state p { max-width: 700px; margin: 14px auto 0; line-height: 1.7; }

.reader { width: 100%; max-width: 1600px; margin: 0 auto; }
.reader-toolbar {
  position: sticky;
  top: 74px;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 10px;
  border: 1px solid var(--ink);
  background: var(--surface);
  box-shadow: 3px 3px 0 var(--ink);
}
.reader-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: end; }
.reader-heading { margin: 34px 0 20px; }
.reader-heading h1 { margin: 0 0 10px; font-size: clamp(25px, 5vw, 48px); line-height: 1.12; letter-spacing: -.07em; }
.reader-heading p { color: var(--muted); font-size: 10px; text-transform: uppercase; }

.change-view-switcher {
  display: flex;
  gap: 6px;
  margin: 0 0 10px;
}
.change-view-switcher .active { background: var(--ink); color: var(--surface); }
.change-review-viewer {
  margin-bottom: 24px;
  border: 1px solid var(--ink);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.change-review-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--ink);
  background: var(--surface-2);
}
.change-review-navigation { display: flex; flex-wrap: wrap; gap: 6px; }
.change-position { color: var(--muted); font-size: 10px; text-transform: uppercase; }
.change-review-workspace {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
  min-height: 520px;
}
.change-file-sidebar {
  padding: 14px 10px;
  border-right: 1px solid var(--ink);
  background: var(--surface-2);
  overflow: auto;
}
.change-file-sidebar > strong {
  display: block;
  margin: 0 7px 12px;
  color: var(--accent);
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.change-file-list { display: grid; gap: 4px; }
.change-file-button {
  width: 100%;
  padding: 8px;
  overflow-wrap: anywhere;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  line-height: 1.45;
  text-align: left;
}
.change-file-button:hover { border-color: var(--line); color: var(--ink); }
.change-file-button.active { border-color: var(--ink); background: var(--ink); color: var(--surface); }
.change-diff-stage { min-width: 0; padding: 16px; overflow: auto; }
.change-warning {
  margin: 0 0 10px;
  padding: 9px 11px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}
.change-file-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.change-file-heading strong { overflow-wrap: anywhere; }
.change-file-heading span { color: var(--muted); font-size: 10px; }
.change-feedback-button { margin-left: auto; white-space: nowrap; }
.change-hunk-header {
  padding: 8px 10px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  white-space: pre-wrap;
}
.change-empty { color: var(--muted); }
.native-diff {
  min-width: max-content;
  border: 1px solid var(--line);
  border-top: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
}
.diff-labels, .diff-row { display: grid; grid-template-columns: minmax(360px, 1fr) minmax(360px, 1fr); }
.diff-labels span {
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: 9px;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.diff-labels span + span, .diff-row > :nth-child(2) { border-left: 1px solid var(--line); }
.diff-cell { display: grid; grid-template-columns: 5ch max-content; min-height: 1.55em; }
.diff-unified-line { display: grid; grid-template-columns: 5ch 5ch max-content; min-width: 100%; }
.diff-cell code, .diff-unified-line code { padding: 0 10px; white-space: pre; }
.diff-line-number {
  padding: 0 1ch;
  border-right: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  color: var(--muted);
  text-align: right;
  user-select: none;
}
button.diff-line-number {
  margin: 0;
  border-top: 0;
  border-bottom: 0;
  border-left: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
button.diff-line-number:hover,
button.diff-line-number:focus-visible {
  background: var(--reading-soft);
  color: var(--ink);
  outline: 1px solid var(--reading);
}
.diff-cell.addition, .diff-unified-line.addition { background: var(--diff-add); }
.diff-cell.deletion, .diff-unified-line.deletion { background: var(--diff-delete); }
.diff-cell.context, .diff-unified-line.context { background: var(--surface); }
.diff-cell.empty-cell { background: var(--surface-2); opacity: .55; }
.native-diff mark {
  border-radius: 2px;
  color: inherit;
  font-weight: 700;
}
.native-diff .addition mark { background: var(--diff-add-emphasis); }
.native-diff .deletion mark { background: var(--diff-delete-emphasis); }
.native-diff .syntax-comment { color: var(--syntax-comment); font-style: italic; }
.native-diff .syntax-function { color: var(--syntax-function); }
.native-diff .syntax-keyword { color: var(--syntax-keyword); font-weight: 700; }
.native-diff .syntax-literal { color: var(--syntax-literal); font-weight: 700; }
.native-diff .syntax-number { color: var(--syntax-number); }
.native-diff .syntax-operator { color: var(--syntax-operator); }
.native-diff .syntax-property { color: var(--syntax-property); }
.native-diff .syntax-string { color: var(--syntax-string); }
.native-diff .syntax-type { color: var(--syntax-type); }

.review-panel {
  margin: 0 0 24px;
  padding: 20px;
  border: 2px solid var(--accent);
  background: var(--accent-soft);
  box-shadow: 4px 4px 0 var(--ink);
}
.review-panel h2 { margin: 8px 0 14px; font-size: 22px; }
.review-panel label { display: block; margin: 18px 0 7px; font-size: 10px; text-transform: uppercase; }
.review-message, .review-status { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.review-status { color: var(--muted); font-size: 11px; text-transform: uppercase; }
.review-feedback-section {
  margin: 18px 0 4px;
  padding: 12px;
  border: 1px solid var(--ink);
  background: color-mix(in srgb, var(--surface) 76%, transparent);
}
.review-feedback-heading,
.review-feedback-item,
.review-feedback-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.review-feedback-heading span { color: var(--muted); font-size: 10px; }
.review-feedback-list { display: grid; gap: 7px; margin-top: 10px; }
.review-feedback-item {
  padding-top: 7px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
.review-feedback-item span { overflow-wrap: anywhere; }
.review-feedback-composer { margin-top: 10px; }
.review-feedback-actions { justify-content: flex-start; margin-top: 8px; }
.review-panel textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--ink);
  background: var(--surface);
  color: var(--ink);
  padding: 12px;
  line-height: 1.5;
}
.review-panel textarea:focus { outline: 2px solid var(--reading); outline-offset: 2px; }
.review-error { min-height: 1.4em; margin: 8px 0; color: var(--accent); font-size: 11px; }
.review-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.reader-content {
  overflow-wrap: anywhere;
  border: 1px solid var(--ink);
  background: var(--surface);
  padding: clamp(20px, 5vw, 64px);
  box-shadow: var(--shadow);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px;
  line-height: 1.7;
}
.reader-content .mermaid-error {
  padding: 14px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
}
.reader-content h1, .reader-content h2, .reader-content h3 { font-family: "Departure Mono", monospace; line-height: 1.25; }
.reader-content h1, .reader-content h2, .reader-content h3,
.reader-content h4, .reader-content h5, .reader-content h6 { scroll-margin-top: 145px; }
.reader-content h2 { margin-top: 2.3em; border-bottom: 1px dashed var(--line); padding-bottom: .35em; }
.reader-content pre { overflow: auto; padding: 16px; background: var(--surface-2); border-left: 4px solid var(--accent); }
.reader-content code { font-family: "Departure Mono", monospace; font-size: .88em; }
.reader-content table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.reader-content th, .reader-content td { border: 1px solid var(--line); padding: 8px 10px; }
.reader-content img, .reader-content svg { max-width: 100%; height: auto; }
.reader-content a { color: var(--reading); text-decoration-thickness: 1px; }
.reader-content.source-missing {
  border-style: dashed;
  border-color: var(--accent);
  color: var(--muted);
}
.reader-content.source-missing strong { color: var(--accent); font-size: 20px; }
.action:disabled { cursor: not-allowed; opacity: .4; }
.mermaid { overflow-x: auto; padding: 20px 0; text-align: center; }

.source-page .topbar .action { color: var(--ink); text-decoration: none; }
.source-page .topbar .action:hover { color: var(--surface); }
.source-viewer {
  width: 100%;
  max-width: 1600px;
  margin: 0 auto;
  padding: clamp(22px, 4vw, 60px);
}
.source-viewer h1 {
  margin: 10px 0 26px;
  font-size: clamp(24px, 4vw, 44px);
  line-height: 1.15;
  letter-spacing: -.06em;
  overflow-wrap: anywhere;
}
.source-code {
  display: block;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--ink);
  background: var(--surface);
  box-shadow: var(--shadow);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.65;
}
.source-line {
  display: grid;
  grid-template-columns: 6ch max-content;
  min-width: 100%;
  scroll-margin-top: 76px;
}
.source-line:target { background: var(--accent-soft); }
.source-line-number {
  padding: 0 1.5ch 0 1ch;
  border-right: 1px solid var(--line);
  color: var(--muted);
  text-align: right;
  text-decoration: none;
  user-select: none;
}
.source-line code { padding-left: 1.5ch; white-space: pre; }

@media print {
  @page { margin: 16mm; }
  :root, :root[data-theme="dark"] {
    color-scheme: light;
    --bg: #fff;
    --surface: #fff;
    --surface-2: #f2f2f2;
    --ink: #000;
    --muted: #444;
    --line: #aaa;
    --reading: #000;
    --shadow: none;
  }
  body { min-height: auto; background: #fff; color: #000; }
  .topbar, .sidebar, .reader-toolbar, #queue-panel, .review-panel,
  .change-view-switcher, .change-review-toolbar, .change-file-sidebar { display: none !important; }
  .workspace { display: block; min-height: auto; }
  .main { padding: 0; }
  .reader { width: 100%; max-width: none; margin: 0; }
  .reader-heading { margin: 0 0 18px; }
  .reader-heading h1 { font-size: 28px; letter-spacing: -.04em; }
  .reader-content {
    padding: 0;
    border: 0;
    background: #fff;
    box-shadow: none;
    color: #000;
    overflow-wrap: normal;
  }
  .change-review-viewer { border: 0; box-shadow: none; }
  .change-review-workspace { display: block; min-height: auto; }
  .change-diff-stage { padding: 0; }
  .reader-content a { color: #000; }
  .reader-content .mermaid, .reader-content pre, .reader-content table,
  .reader-content img, .reader-content svg {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}

@media (max-width: 760px) {
  .workspace { grid-template-columns: 1fr; }
  .sidebar {
    position: static;
    height: auto;
    overflow-y: visible;
    border-right: 0;
    border-bottom: 2px solid var(--ink);
  }
  .project-nav { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .reader-toc { max-height: 240px; overflow-y: auto; }
  .shortcut-card { display: none; }
  .queue-title-row { align-items: start; flex-direction: column; }
  .reader-toolbar { top: 68px; flex-direction: column; }
  .change-review-toolbar { align-items: stretch; flex-direction: column; }
  .change-review-workspace { grid-template-columns: 1fr; }
  .change-file-sidebar { max-height: 210px; border-right: 0; border-bottom: 1px solid var(--ink); }
  .source-page .brand span { display: none; }
  .source-viewer { padding: 18px 12px 36px; }
  .source-code { font-size: 12px; }
}
`;
