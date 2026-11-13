import assert from "node:assert/strict";
import test from "node:test";

import {
  documentExportFilename,
  isExportImageSource,
  selfContainedDocumentHtml,
} from "./document-export.js";

test("names HTML exports after the title with portable, bounded filenames", () => {
  assert.equal(documentExportFilename("My document"), "My document.html");
  assert.equal(documentExportFilename("План змін 🐈"), "План змін 🐈.html");
  assert.equal(documentExportFilename(' ../A/B: C? * \"<>|\\\u0000\u202e '), "A B C.html");
  assert.equal(documentExportFilename(" . "), "Document.html");
  assert.equal(documentExportFilename("CON"), "_CON.html");
  assert.equal(documentExportFilename("a".repeat(300)).length, 125);
  assert.ok(new TextEncoder().encode(documentExportFilename("🐈".repeat(200))).length <= 255);
});

test("embeds only image data or the current document's opaque media routes", () => {
  const id = "doc-11111111111111111111";
  assert.equal(isExportImageSource(`/d/${id}/media/source-11111111111111111111`, id), true);
  for (const type of ["png", "jpeg", "gif", "webp", "svg+xml"]) {
    assert.equal(isExportImageSource(`data:image/${type};base64,AAAA`, id), true);
  }
  for (const src of [
    "https://example.com/private.png", "//example.com/a.svg", "file:///tmp/a.png",
    "/api/v1/documents", "data:text/html;base64,AAAA", "data:image/svg+xml,<svg/>",
    "/d/doc-22222222222222222222/media/source-11111111111111111111",
    `/d/${id}/media/source-11111111111111111111?token=secret`,
  ]) assert.equal(isExportImageSource(src, id), false, src);
});

test("creates a script-free offline shell with an escaped title and embedded styles", () => {
  const html = selfContainedDocumentHtml({
    title: '</title><script>alert("title")</script>',
    theme: "dark",
    content: '<article><h1 id="hello">Hello</h1><img src="data:image/png;base64,AAAA"></article>',
    styles: 'body { color: red; } /* </style><script>alert(1)</script> */',
  });
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /default-src 'none'; script-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.match(html, /font-src data:/);
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
  assert.match(html, /<h1 id="hello">Hello<\/h1>/);
  assert.doesNotMatch(html, /<\/style><script>/);
  assert.doesNotMatch(html, /<link|<script|\/assets\//);
});
