import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { Catalog, DocumentSourceMissingError } from "./catalog.js";
import { SqliteCatalogStorage } from "./sqlite-storage.js";

async function fixture(): Promise<{
  catalog: Catalog;
  statePath: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "reports"), { recursive: true });
  const statePath = join(root, "state", "catalog.sqlite3");
  const catalog = await Catalog.open(statePath);
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  return { catalog, statePath, workspace };
}

test("registers documents idempotently and persists the catalog", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "plan.md");
  await writeFile(documentPath, "# Plan\n", "utf8");

  const first = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "PROJECT-123",
    kind: "plan",
    title: "Implementation plan",
    path: documentPath,
    attention: "approval",
  });
  const second = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "PROJECT-123",
    kind: "plan",
    title: "Updated implementation plan",
    path: documentPath,
    attention: "approval",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.revision, 1);
  assert.equal(second.status, "unread");
  assert.equal(catalog.listDocuments().length, 1);
  assert.equal(catalog.listDocuments()[0]?.title, "Updated implementation plan");

  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments(), catalog.listDocuments());

  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("rejects registration when a Mermaid block is invalid", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "broken-diagram.md");
  await writeFile(documentPath, [
    "# Broken diagram",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  [*] -->",
    "```",
  ].join("\n"), "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "review",
      title: "Broken diagram",
      path: documentPath,
      attention: "review",
    }),
    /Mermaid diagram 1.*line 3.*parse error/is,
  );
  assert.equal(catalog.listDocuments().length, 0);
  catalog.close();
});

test("reuses one AI-named project across workspaces for the same repository task", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-projects-"));
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  const statePath = join(root, "catalog.sqlite3");
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  const firstPath = join(firstWorkspace, "plan.md");
  const secondPath = join(secondWorkspace, "review.md");
  await writeFile(firstPath, "# Plan\n", "utf8");
  await writeFile(secondPath, "# Review\n", "utf8");

  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  for (const [id, workspace] of [
    ["first", firstWorkspace],
    ["second", secondWorkspace],
  ] as const) {
    await catalog.addWorkspace({
      id,
      name: id,
      root: workspace,
      artifactRoots: [workspace],
      repository: "github.com/riidii-md/eywizards",
      repositoryName: "EyWizards",
    });
  }

  const first = await catalog.registerDocument({
    workspaceId: "first",
    taskId: "sa-2913",
    featureName: "COA Worker Continuity",
    kind: "plan",
    title: "Plan",
    path: firstPath,
    attention: "none",
  });
  const second = await catalog.registerDocument({
    workspaceId: "second",
    taskId: "SA-2913",
    featureName: "Different AI wording",
    kind: "review",
    title: "Review",
    path: secondPath,
    attention: "none",
  });

  assert.equal(second.projectId, first.projectId);
  assert.equal(first.projectName, "EyWizards / SA-2913 (COA Worker Continuity)");
  assert.equal(second.projectName, first.projectName);
  catalog.close();

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(
    restored.listDocuments().map(({ projectId, projectName }) => ({
      projectId,
      projectName,
    })),
    [
      { projectId: first.projectId, projectName: first.projectName },
      { projectId: first.projectId, projectName: first.projectName },
    ],
  );
  restored.close();
});

test("normalizes repository URLs without persisting credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-repository-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "catalog.sqlite3");
  await mkdir(workspace);
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
    repository: "https://private-user:private-token@GitHub.com/Riidii-MD/EyWizards.git",
    repositoryName: "EyWizards",
  });
  catalog.close();

  const database = new Database(statePath, { readonly: true });
  const repository = database
    .prepare<[], { repository_key: string }>(
      "SELECT repository_key FROM workspace_repositories",
    )
    .get();
  assert.equal(repository?.repository_key, "github.com/riidii-md/eywizards");
  assert.doesNotMatch(JSON.stringify(repository), /private-user|private-token/);
  database.close();
});

test("supports SSH repository identity, ticketless projects, and late AI naming", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-ticketless-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "brief.md");
  await mkdir(workspace);
  await writeFile(documentPath, "# Brief\n", "utf8");
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Temporary workspace name",
    root: workspace,
    artifactRoots: [workspace],
    repository: "git@GitHub.com:Riidii-MD/EyWizards.git",
  });
  await catalog.addWorkspace({
    id: "example",
    name: "Renamed workspace",
    root: workspace,
    artifactRoots: [workspace],
  });

  const unnamed = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Brief",
    path: documentPath,
    attention: "none",
  });
  assert.equal(unnamed.projectName, "eywizards");

  const named = await catalog.registerDocument({
    workspaceId: "example",
    featureName: "Ticketless Work",
    kind: "brief",
    title: "Brief",
    path: documentPath,
    attention: "none",
  });
  assert.equal(named.projectId, unnamed.projectId);
  assert.equal(named.projectName, "eywizards (Ticketless Work)");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      featureName: "Unsafe\nName",
      kind: "brief",
      title: "Brief",
      path: documentPath,
      attention: "none",
    }),
    /invalid document registration input/,
  );
  await assert.rejects(
    catalog.addWorkspace({
      id: "invalid",
      name: "Invalid",
      root: workspace,
      artifactRoots: [workspace],
      repository: "not a repository?secret=yes",
    }),
    /invalid repository identity/,
  );
  await assert.rejects(
    catalog.addWorkspace({
      id: "missing-host",
      name: "Missing host",
      root: workspace,
      artifactRoots: [workspace],
      repository: "file:///repository",
    }),
    /invalid repository identity/,
  );
  await assert.rejects(
    catalog.addWorkspace({
      id: "missing-name",
      name: "Missing name",
      root: workspace,
      artifactRoots: [workspace],
      repository: "https://github.com/.git",
    }),
    /repository identity has no name/,
  );
  await assert.rejects(
    catalog.addWorkspace({
      id: "invalid-url",
      name: "Invalid URL",
      root: workspace,
      artifactRoots: [workspace],
      repository: "https://[",
    }),
    /invalid repository identity/,
  );
  await assert.rejects(
    catalog.addWorkspace({
      id: "invalid-name",
      name: "Invalid name",
      root: workspace,
      artifactRoots: [workspace],
      repository: "github.com/example/repository",
      repositoryName: "Unsafe\nRepository",
    }),
    /invalid repository name/,
  );
  catalog.close();
});

test("manages normalized Spaces and sanitized repository inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-spaces-"));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  await catalog.addWorkspace({
    id: "first",
    name: "First workspace",
    root: firstRoot,
    artifactRoots: [firstRoot],
    repository: "https://github.com/Acme/App.git",
    repositoryName: "Zulu",
  });
  await catalog.addWorkspace({
    id: "second",
    name: "Second workspace",
    root: secondRoot,
    artifactRoots: [secondRoot],
    repository: "git@github.com:acme/app.git",
    repositoryName: "Alpha",
  });

  assert.deepEqual(catalog.listRepositories(), [
    {
      key: "github.com/acme/app",
      name: "Alpha",
      workspaceIds: ["first", "second"],
      kind: "remote",
    },
  ]);

  const work = catalog.createSpace({
    id: "work",
    name: " Work ",
    matchers: [
      { kind: "repository", value: "https://github.com/Acme/App.git" },
      { kind: "repository", value: "git@github.com:acme/app.git" },
      { kind: "repository-namespace", value: "GitHub.com/Acme" },
      { kind: "tag", value: " Client-Work " },
    ],
  });
  assert.deepEqual(work, {
    id: "work",
    name: "Work",
    matchers: [
      { kind: "repository", value: "github.com/acme/app" },
      { kind: "repository-namespace", value: "github.com/acme" },
      { kind: "tag", value: "client-work" },
    ],
  });
  catalog.createSpace({
    id: "home",
    name: "Home",
    matchers: [{ kind: "tag", value: "home" }],
  });
  assert.deepEqual(catalog.listSpaces().map(({ id }) => id), ["home", "work"]);

  assert.deepEqual(catalog.renameSpace("work", "Client work").name, "Client work");
  assert.deepEqual(
    catalog.replaceSpaceMatchers("work", {
      matchers: [{ kind: "repository", value: "github.com/acme/app" }],
    }).matchers,
    [{ kind: "repository", value: "github.com/acme/app" }],
  );
  assert.throws(
    () => catalog.replaceSpaceMatchers("work", { matchers: [] }),
    /at least one matcher/,
  );
  assert.deepEqual(catalog.getSpace("work")?.matchers, [
    { kind: "repository", value: "github.com/acme/app" },
  ]);

  assert.throws(
    () => catalog.createSpace({ id: "work", name: "Again", matchers: [
      { kind: "tag", value: "again" },
    ] }),
    /space work already exists/,
  );
  assert.deepEqual(catalog.deleteSpace("home"), { id: "home" });
  assert.equal(catalog.getSpace("home"), undefined);
  assert.throws(() => catalog.deleteSpace("home"), /unknown space home/);
  catalog.close();
});

test("rejects invalid Space matcher values atomically", async () => {
  const { catalog } = await fixture();
  const original = catalog.createSpace({
    id: "work",
    name: "Work",
    matchers: [{ kind: "tag", value: "work" }],
  });

  for (const matcher of [
    { kind: "repository-namespace", value: "github.com" },
    { kind: "repository-namespace", value: "local:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    { kind: "repository", value: "not a repository?secret=yes" },
    { kind: "tag", value: "unsafe tag" },
    { kind: "unknown", value: "work" },
  ]) {
    assert.throws(
      () => catalog.replaceSpaceMatchers("work", { matchers: [matcher] }),
      /invalid|unknown|namespace|tag/,
    );
    assert.deepEqual(catalog.getSpace("work"), original);
  }
  catalog.close();
});

test("derives scoped documents, workspaces, and reviews from current facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-space-scope-"));
  const catalog = await Catalog.open(join(root, "catalog.sqlite3"), {
    legacyStatePath: false,
  });
  const workspaceInputs = [
    ["acme", "github.com/acme/app"],
    ["acme-labs", "github.com/acme-labs/app"],
    ["partner", "github.com/partner/tool"],
  ] as const;
  for (const [id, repository] of workspaceInputs) {
    const workspaceRoot = join(root, id);
    await mkdir(workspaceRoot);
    await catalog.addWorkspace({
      id,
      name: id,
      root: workspaceRoot,
      artifactRoots: [workspaceRoot],
      repository,
    });
    await writeFile(join(workspaceRoot, "plan.md"), `# ${id}\n`, "utf8");
  }
  const acme = await catalog.registerDocument({
    workspaceId: "acme",
    kind: "plan",
    title: "Acme",
    path: join(root, "acme", "plan.md"),
    attention: "approval",
    tags: ["client"],
  });
  await catalog.registerDocument({
    workspaceId: "acme-labs",
    kind: "plan",
    title: "Acme Labs",
    path: join(root, "acme-labs", "plan.md"),
    attention: "none",
  });
  const partner = await catalog.registerDocument({
    workspaceId: "partner",
    kind: "plan",
    title: "Partner",
    path: join(root, "partner", "plan.md"),
    attention: "none",
    tags: ["client"],
  });
  const review = await catalog.createReviewRequest({
    documentId: acme.id,
    kind: "plan-decision",
    requestMessage: "Review Acme",
  });

  catalog.createSpace({
    id: "acme-org",
    name: "Acme org",
    matchers: [{ kind: "repository-namespace", value: "github.com/acme" }],
  });
  catalog.createSpace({
    id: "clients",
    name: "Clients",
    matchers: [{ kind: "tag", value: "client" }],
  });
  catalog.createSpace({
    id: "partner",
    name: "Partner",
    matchers: [{ kind: "repository", value: "github.com/partner/tool" }],
  });

  assert.deepEqual(
    catalog.listDocuments({}, { spaceId: "acme-org" }).map(({ title }) => title),
    ["Acme"],
  );
  assert.deepEqual(
    catalog.listWorkspaces({ spaceId: "acme-org" }).map(({ id }) => id),
    ["acme"],
  );
  assert.equal(catalog.getDocument(partner.id, { spaceId: "acme-org" }), undefined);
  assert.deepEqual(
    catalog.listReviewRequests({}, { spaceId: "acme-org" }).map(({ id }) => id),
    [review.id],
  );
  assert.equal(
    catalog.getReviewRequest(review.id, { spaceId: "partner" }),
    undefined,
  );
  assert.deepEqual(
    catalog.listDocuments({}, { spaceId: "clients" }).map(({ title }) => title).sort(),
    ["Acme", "Partner"],
  );

  await catalog.setDocumentTags(partner.id, []);
  assert.deepEqual(
    catalog.listDocuments({}, { spaceId: "clients" }).map(({ title }) => title),
    ["Acme"],
  );
  const futurePath = join(root, "partner", "future.md");
  await writeFile(futurePath, "# Future\n", "utf8");
  const future = await catalog.registerDocument({
    workspaceId: "partner",
    kind: "brief",
    title: "Future",
    path: futurePath,
    attention: "none",
  });
  assert.equal(catalog.getDocument(future.id, { spaceId: "partner" })?.title, "Future");

  assert.throws(
    () => catalog.listDocuments({}, { spaceId: "missing" }),
    /unknown space missing/,
  );
  assert.throws(
    () => catalog.listDocuments({}, { spaceId: "Invalid Space" }),
    /invalid Space id/,
  );
  assert.equal(catalog.listDocuments().length, 4);
  catalog.close();
});

test("keeps derived Space membership indexed and query-count constant at scale", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-scope-plan-"));
  const statePath = join(root, "catalog.sqlite3");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  const documentIds: string[] = [];
  const reviewIds: string[] = [];
  for (let workspaceIndex = 0; workspaceIndex < 32; workspaceIndex += 1) {
    const workspaceId = `workspace-${workspaceIndex}`;
    const workspaceRoot = join(root, workspaceId);
    await mkdir(workspaceRoot);
    await catalog.addWorkspace({
      id: workspaceId,
      name: `Workspace ${workspaceIndex}`,
      root: workspaceRoot,
      artifactRoots: [workspaceRoot],
      repository: `https://github.com/org-${workspaceIndex % 4}/repo-${workspaceIndex}.git`,
      repositoryName: `Repo ${workspaceIndex}`,
    });
    for (let documentIndex = 0; documentIndex < 8; documentIndex += 1) {
      const path = join(workspaceRoot, `document-${documentIndex}.md`);
      await writeFile(path, `# ${workspaceId} document ${documentIndex}\n`, "utf8");
      const document = await catalog.registerDocument({
        workspaceId,
        taskId: `TASK-${documentIndex}`,
        kind: documentIndex === 0 ? "review" : "plan",
        title: `${workspaceId} document ${documentIndex}`,
        path,
        attention: "review",
        tags: [
          `tag-${documentIndex % 4}`,
          `team-${workspaceIndex % 4}`,
          `row-${documentIndex}`,
          "shared",
        ],
      });
      documentIds.push(document.id);
      if (documentIndex === 0) {
        const review = await catalog.createReviewRequest({
          documentId: document.id,
          kind: "plan-decision",
          requestMessage: "Review at scale",
        });
        reviewIds.push(review.id);
      }
    }
  }
  catalog.createSpace({
    id: "scope-small",
    name: "Small",
    matchers: [
      { kind: "repository", value: "github.com/org-0/repo-0" },
      { kind: "repository", value: "github.com/org-1/repo-1" },
      { kind: "repository-namespace", value: "github.com/unused-0" },
      { kind: "repository-namespace", value: "github.com/unused-1" },
      { kind: "tag", value: "unused-0" },
      { kind: "tag", value: "unused-1" },
      { kind: "tag", value: "unused-2" },
      { kind: "tag", value: "unused-3" },
    ],
  });
  catalog.createSpace({
    id: "scope-full",
    name: "Full",
    matchers: [
      { kind: "repository-namespace", value: "github.com/org-0" },
      { kind: "repository-namespace", value: "github.com/org-1" },
      { kind: "repository-namespace", value: "github.com/org-2" },
      { kind: "repository-namespace", value: "github.com/org-3" },
      { kind: "tag", value: "tag-0" },
      { kind: "tag", value: "tag-1" },
      { kind: "tag", value: "tag-2" },
      { kind: "tag", value: "tag-3" },
    ],
  });
  for (let index = 0; index < 10; index += 1) {
    catalog.createSpace({
      id: `scope-extra-${index}`,
      name: `Extra ${index}`,
      matchers: Array.from({ length: 8 }, (_, matcherIndex) => ({
        kind: "tag" as const,
        value: `extra-${index}-${matcherIndex}`,
      })),
    });
  }
  assert.equal(catalog.listDocuments().length, 256);
  catalog.close();

  const database = new Database(statePath);
  const membership = `EXISTS (
    SELECT 1 FROM space_matchers sm
    WHERE sm.space_id = ? AND (
      (sm.kind = 'repository' AND sm.value = wr.repository_key)
      OR (sm.kind = 'repository-namespace'
        AND substr(wr.repository_key, 1, length(sm.value) + 1) = sm.value || '/')
      OR (sm.kind = 'tag' AND EXISTS (
        SELECT 1 FROM document_tags scope_tags
        WHERE scope_tags.document_id = d.id AND scope_tags.tag_name = sm.value
      ))
    )
  )`;
  const documentSelect = `SELECT d.id FROM documents d
    JOIN document_projects dp ON dp.document_id = d.id
    JOIN projects p ON p.id = dp.project_id
    JOIN workspace_repositories wr ON wr.workspace_id = d.workspace_id`;
  const queryShapes: Array<{ sql: string; parameters: string[] }> = [
    { sql: `${documentSelect} WHERE d.archived_at IS NULL AND ${membership}`, parameters: ["scope-full"] },
    { sql: `${documentSelect} WHERE d.id = ? AND ${membership}`, parameters: [documentIds[0]!, "scope-full"] },
    { sql: `SELECT rr.id FROM review_requests rr JOIN documents d ON d.id = rr.document_id JOIN workspace_repositories wr ON wr.workspace_id = d.workspace_id WHERE ${membership}`, parameters: ["scope-full"] },
    { sql: `SELECT rr.id FROM review_requests rr JOIN documents d ON d.id = rr.document_id JOIN workspace_repositories wr ON wr.workspace_id = d.workspace_id WHERE rr.id = ? AND ${membership}`, parameters: [reviewIds[0]!, "scope-full"] },
    { sql: `SELECT w.id FROM workspaces w WHERE EXISTS (SELECT 1 FROM documents d JOIN workspace_repositories wr ON wr.workspace_id = d.workspace_id WHERE d.workspace_id = w.id AND d.archived_at IS NULL AND ${membership})`, parameters: ["scope-full"] },
  ];
  const planDetails = queryShapes.flatMap(({ sql, parameters }) =>
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
      .map((row) => String((row as { detail: string }).detail)),
  );
  assert.ok(
    planDetails.some((detail) => /SEARCH sm(?: EXISTS)? USING/.test(detail)),
    planDetails.join("\n"),
  );
  assert.ok(
    planDetails.some((detail) => /SEARCH scope_tags USING/.test(detail)),
    planDetails.join("\n"),
  );
  assert.ok(
    planDetails.some((detail) => /SEARCH wr USING/.test(detail)),
    planDetails.join("\n"),
  );
  for (const relation of ["sm", "scope_tags", "wr"]) {
    assert.equal(
      planDetails.some((detail) => new RegExp(`(?:^| )SCAN ${relation}(?: |$)`).test(detail)),
      false,
      planDetails.join("\n"),
    );
  }

  const matcherIndexDisabledPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${documentSelect} WHERE d.archived_at IS NULL AND ${membership.replace(
      "space_matchers sm",
      "space_matchers sm NOT INDEXED",
    )}`)
    .all("scope-full")
    .map((row) => String((row as { detail: string }).detail));
  assert.ok(matcherIndexDisabledPlan.some((detail) => /SCAN sm(?: |$)/.test(detail)));

  const tagIndexDisabledPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${documentSelect} WHERE d.archived_at IS NULL AND ${membership.replace(
      "document_tags scope_tags",
      "document_tags scope_tags NOT INDEXED",
    )}`)
    .all("scope-full")
    .map((row) => String((row as { detail: string }).detail));
  assert.ok(tagIndexDisabledPlan.some((detail) => /SCAN scope_tags(?: |$)/.test(detail)));

  const repositoryIndexDisabledPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${documentSelect.replace(
      "JOIN workspace_repositories wr ON",
      "JOIN workspace_repositories wr NOT INDEXED ON",
    )} WHERE d.archived_at IS NULL AND ${membership}`)
    .all("scope-full")
    .map((row) => String((row as { detail: string }).detail));
  assert.ok(repositoryIndexDisabledPlan.some((detail) => /SCAN wr(?: |$)/.test(detail)));

  database.close();

  const observedQueries: string[] = [];
  const measuredStorage = SqliteCatalogStorage.open(statePath, {
    onQuery: (sql) => observedQueries.push(sql),
  });
  const refreshQueryCount = (spaceId: string): number => {
    observedQueries.length = 0;
    measuredStorage.listDocuments({}, { spaceId });
    measuredStorage.listReviewRequests({}, { spaceId });
    measuredStorage.listWorkspaces({ spaceId });
    return observedQueries.filter((sql) => /^\s*SELECT\b/i.test(sql)).length;
  };
  const smallQueryCount = refreshQueryCount("scope-small");
  const fullQueryCount = refreshQueryCount("scope-full");
  assert.equal(
    fullQueryCount,
    smallQueryCount,
    `small=${smallQueryCount}, full=${fullQueryCount}`,
  );
  assert.ok(fullQueryCount <= 8, `full=${fullQueryCount}`);
  measuredStorage.close();
});

test("contains direct reads, mutations, reviews, and reference targets by Space", async () => {
  const { catalog, workspace } = await fixture();
  const inPath = join(workspace, "reports", "in-scope.md");
  const outPath = join(workspace, "reports", "out-of-scope.md");
  await writeFile(
    inPath,
    "# In scope\n\n[Registered target](./out-of-scope.md)\n",
    "utf8",
  );
  await writeFile(outPath, "# Out of scope\n", "utf8");
  const inScope = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "In scope",
    path: inPath,
    attention: "approval",
    tags: ["client"],
  });
  const outOfScope = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Out of scope",
    path: outPath,
    attention: "approval",
  });
  const review = await catalog.createReviewRequest({
    documentId: outOfScope.id,
    kind: "plan-decision",
    requestMessage: "Must stay outside",
  });
  catalog.createSpace({
    id: "client",
    name: "Client",
    matchers: [{ kind: "tag", value: "client" }],
  });
  const scope = { spaceId: "client" };

  await assert.rejects(catalog.readDocument(outOfScope.id, scope), /unknown document/);
  await assert.rejects(catalog.markDocumentOpened(outOfScope.id, scope), /unknown document/);
  await assert.rejects(
    catalog.respondToReviewRequest(review.id, { outcome: "approved", message: "" }, scope),
    /unknown review request/,
  );
  assert.deepEqual(catalog.resolveDocumentSourceTargets(inScope.id, scope), new Map());

  const removed = await catalog.setDocumentTags(inScope.id, [], scope);
  assert.deepEqual(removed.tags, []);
  assert.equal(catalog.getDocument(inScope.id, scope), undefined);
  await assert.rejects(catalog.readDocument(inScope.id, scope), /unknown document/);
  catalog.close();
});

test("publishes metadata-free invalidation once for committed catalog changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "transactional-invalidation.md");
  await writeFile(documentPath, "# Transactional invalidation\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Transactional invalidation",
    path: documentPath,
    attention: "approval",
  });
  const events: Array<Record<string, never>> = [];
  catalog.subscribeInvalidation(() => {
    throw new Error("observer failure");
  });
  const unsubscribe = catalog.subscribeInvalidation(() => events.push({}));

  const space = catalog.createSpace({
    id: "work",
    name: "Work",
    matchers: [{ kind: "tag", value: "work" }],
  });
  assert.deepEqual(events, [{}]);
  catalog.renameSpace(space.id, "Work");
  catalog.replaceSpaceMatchers(space.id, { matchers: space.matchers });
  assert.equal(events.length, 1);
  catalog.renameSpace(space.id, "Office");
  assert.equal(events.length, 2);
  assert.throws(
    () => catalog.replaceSpaceMatchers(space.id, { matchers: [] }),
    /at least one matcher/,
  );
  assert.equal(events.length, 2);
  catalog.deleteSpace(space.id);
  assert.equal(events.length, 3);

  const archived = await catalog.archiveDocument(document.id);
  assert.notEqual(archived.archivedAt, null);
  assert.notEqual(catalog.getDocument(document.id)?.archivedAt, null);
  assert.equal(events.length, 4);

  unsubscribe();
  catalog.close();
});

test("registers workspace-local source links and persists their safe mappings", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const sourceDirectory = join(workspace, "Backend", "Features");
  const sourcePath = join(sourceDirectory, "AgentTurnV2.cs");
  const documentPath = join(workspace, "reports", "evidence.md");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    sourcePath,
    "public sealed class AgentTurnV2\n{\n    // evidence\n}\n",
    "utf8",
  );
  await writeFile(
    documentPath,
    [
      "# Evidence",
      "",
      "[local source][agent-turn]",
      "[external](https://example.com/reference)",
      "[mail](mailto:reader@example.com)",
      "[section](#evidence)",
      "",
      "[agent-turn]: ../Backend/Features/AgentTurnV2.cs#L2",
      "[unused]: ../../outside-secret.cs",
      "",
    ].join("\n"),
    "utf8",
  );

  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Evidence",
    path: documentPath,
    attention: "review",
  });

  assert.equal(document.sourceLinks.length, 1);
  const sourceLink = document.sourceLinks[0]!;
  assert.match(sourceLink.id, /^source-[a-f0-9]{20}$/);
  assert.deepEqual(sourceLink, {
    id: sourceLink.id,
    href: "../Backend/Features/AgentTurnV2.cs#L2",
    workspacePath: join("Backend", "Features", "AgentTurnV2.cs"),
  });
  assert.equal(sourceLink.workspacePath, relative(workspace, sourcePath));

  const source = await catalog.readDocumentSource(document.id, sourceLink.id);
  assert.equal(source.name, "AgentTurnV2.cs");
  assert.equal(
    source.content,
    "public sealed class AgentTurnV2\n{\n    // evidence\n}\n",
  );

  await catalog.markDocumentOpened(document.id);
  assert.deepEqual(catalog.getDocument(document.id)?.sourceLinks, [sourceLink]);
  catalog.close();

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(restored.getDocument(document.id)?.sourceLinks, [sourceLink]);
  assert.equal(
    (await restored.readDocumentSource(document.id, sourceLink.id)).content,
    source.content,
  );
  restored.close();
});

test("discovers Markdown image references as authorized local media", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "explanation.md");
  const mediaPath = join(workspace, "reports", "flow.svg");
  await writeFile(
    mediaPath,
    '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"><animateMotion path="M0 0 L10 0" dur="1s" repeatCount="indefinite"/></circle></svg>\n',
    "utf8",
  );
  await writeFile(
    documentPath,
    [
      "# Change explanation",
      "",
      "![Animated request flow][flow]",
      "",
      "[flow]: flow.svg",
      "",
    ].join("\n"),
    "utf8",
  );

  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "showcase",
    title: "Change explanation",
    path: documentPath,
    attention: "review",
  });

  const media = document.sourceLinks.find(({ href }) => href === "flow.svg");
  assert.ok(media);
  assert.equal(media.workspacePath, relative(workspace, mediaPath));

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(
    restored.getDocument(document.id)?.sourceLinks,
    document.sourceLinks,
  );
  restored.close();
  catalog.close();
});

test("resolves registered Markdown source links to catalog documents", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "index.md");
  const targetPath = join(workspace, "reports", "guide.md");
  const draftPath = join(workspace, "reports", "draft.md");
  const snapshotPath = join(workspace, "reports", "snapshot.md");
  await writeFile(targetPath, "# Guide\n\n## Details\n", "utf8");
  await writeFile(draftPath, "# Draft\n", "utf8");
  await writeFile(snapshotPath, "# Snapshot\n", "utf8");
  await writeFile(
    documentPath,
    [
      "[guide](guide.md#details)",
      "[draft](draft.md)",
      "[snapshot](snapshot.md)",
      "",
    ].join("\n"),
    "utf8",
  );

  const target = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Guide",
    path: targetPath,
    attention: "none",
  });
  await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Snapshot",
    path: snapshotPath,
    attention: "none",
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Index",
    path: documentPath,
    attention: "none",
  });

  const guideLink = document.sourceLinks.find(
    ({ href }) => href === "guide.md#details",
  );
  const draftLink = document.sourceLinks.find(({ href }) => href === "draft.md");
  const snapshotLink = document.sourceLinks.find(
    ({ href }) => href === "snapshot.md",
  );
  assert.ok(guideLink);
  assert.ok(draftLink);
  assert.ok(snapshotLink);

  const targets = catalog.resolveDocumentSourceTargets(document.id);
  assert.equal(targets.get(guideLink.id), target.id);
  assert.equal(targets.has(draftLink.id), false);
  assert.equal(targets.has(snapshotLink.id), false);
  catalog.close();
});

test("replaces source-link mappings when a document is registered again", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "changing-links.md");
  const firstSource = join(workspace, "first.ts");
  const secondSource = join(workspace, "second.ts");
  await writeFile(firstSource, "export const first = true;\n", "utf8");
  await writeFile(secondSource, "export const second = true;\n", "utf8");
  await writeFile(documentPath, "[first](../first.ts)\n", "utf8");

  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Changing links",
    path: documentPath,
    attention: "none",
  });
  await writeFile(documentPath, "[second](../second.ts)\n", "utf8");
  const second = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Changing links",
    path: documentPath,
    attention: "none",
  });

  assert.equal(first.sourceLinks.length, 1);
  assert.deepEqual(
    second.sourceLinks.map(({ href }) => href),
    ["../second.ts"],
  );
  await assert.rejects(
    catalog.readDocumentSource(first.id, first.sourceLinks[0]!.id),
    /unknown document source link/,
  );
  catalog.close();
});

test("reconciles changed reference content, progress, links, and reviews on read", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "live.md");
  const firstSource = join(workspace, "first.ts");
  const secondSource = join(workspace, "second.ts");
  await writeFile(firstSource, "export const first = true;\n", "utf8");
  await writeFile(secondSource, "export const second = true;\n", "utf8");
  await writeFile(documentPath, "# First\n\n[first](../first.ts)\n", "utf8");

  const registered = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Live document",
    path: documentPath,
    attention: "review",
  });
  await catalog.markDocumentOpened(registered.id);
  await catalog.markDocumentRead(registered.id);
  const review = await catalog.createReviewRequest({
    documentId: registered.id,
    kind: "plan-decision",
    requestMessage: "Review this exact source.",
  });

  await writeFile(
    documentPath,
    "# Second\n\n[second](../second.ts)\n",
    "utf8",
  );
  const read = await catalog.readDocument(registered.id);

  assert.equal(read.content, "# Second\n\n[second](../second.ts)\n");
  assert.equal(read.document.revision, 2);
  assert.equal(read.document.status, "unread");
  assert.equal(read.document.openedRevision, 1);
  assert.equal(read.document.completedRevision, 1);
  assert.deepEqual(
    read.document.sourceLinks.map(({ href }) => href),
    ["../second.ts"],
  );
  assert.equal(catalog.getReviewRequest(review.id)?.status, "stale");

  const repeated = await catalog.readDocument(registered.id);
  assert.equal(repeated.document.revision, 2);
  catalog.close();
});

test("reports distinct reference reconciliation transitions without duplicate revisions", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "transitions.md");
  await writeFile(documentPath, "# Original\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Transitions",
    path: documentPath,
    attention: "none",
  });

  const unchanged = await catalog.reconcileReferenceDocument(document.id);
  assert.equal(unchanged.action, "unchanged");
  assert.equal(unchanged.document.revision, 1);

  await rm(documentPath);
  const missing = await catalog.reconcileReferenceDocument(document.id);
  assert.equal(missing.action, "source-missing");
  assert.equal(missing.document.revision, 1);
  assert.notEqual(missing.document.missingAt, null);
  assert.equal(
    (await catalog.reconcileReferenceDocument(document.id)).action,
    "unchanged",
  );

  await writeFile(documentPath, "# Original\n", "utf8");
  const restored = await catalog.reconcileReferenceDocument(document.id);
  assert.equal(restored.action, "source-restored");
  assert.equal(restored.document.revision, 1);
  assert.equal(restored.document.missingAt, null);

  await writeFile(documentPath, "# Changed\n", "utf8");
  const concurrent = await Promise.all([
    catalog.reconcileReferenceDocument(document.id),
    catalog.reconcileReferenceDocument(document.id),
  ]);
  assert.deepEqual(
    concurrent.map(({ action }) => action),
    ["source-changed", "unchanged"],
  );
  assert.equal(catalog.getDocument(document.id)?.revision, 2);
  catalog.close();
});

test("reconciliation rejects managed documents and unsafe source replacements", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "safe.md");
  const outsidePath = join(workspace, "..", "outside-live.md");
  await writeFile(documentPath, "# Safe\n", "utf8");
  await writeFile(outsidePath, "# Outside\n", "utf8");
  const reference = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Safe",
    path: documentPath,
    attention: "none",
  });
  const managed = await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Snapshot",
    path: outsidePath,
    attention: "none",
  });

  await assert.rejects(
    catalog.reconcileReferenceDocument(managed.id),
    /managed document is not a live reference/,
  );

  await rm(documentPath);
  await symlink(outsidePath, documentPath);
  await assert.rejects(
    catalog.reconcileReferenceDocument(reference.id),
    /document path must not be a symlink/,
  );
  assert.equal(catalog.getDocument(reference.id)?.revision, 1);
  assert.equal(catalog.getDocument(reference.id)?.missingAt, null);
  catalog.close();
});

test("rejects local source links that escape the workspace or use symlinks", async () => {
  const { catalog, workspace } = await fixture();
  const outside = join(workspace, "..", "outside-secret.cs");
  const traversalDocument = join(workspace, "reports", "traversal.md");
  await writeFile(outside, "secret\n", "utf8");
  await writeFile(traversalDocument, "[secret](../../outside-secret.cs)\n", "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Traversal",
      path: traversalDocument,
      attention: "none",
    }),
    /local source link is outside workspace root/,
  );

  const linkedSource = join(workspace, "linked-source.cs");
  const symlinkDocument = join(workspace, "reports", "symlink.md");
  await symlink(outside, linkedSource);
  await writeFile(symlinkDocument, "[secret](../linked-source.cs)\n", "utf8");
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Symlink",
      path: symlinkDocument,
      attention: "none",
    }),
    /local source link must not be a symlink/,
  );
  catalog.close();
});

test("re-authorizes linked sources when they are read", async () => {
  const { catalog, workspace } = await fixture();
  const sourcePath = join(workspace, "source.ts");
  const outside = join(workspace, "..", "replacement-secret.ts");
  const documentPath = join(workspace, "reports", "source-link.md");
  await writeFile(sourcePath, "export const safe = true;\n", "utf8");
  await writeFile(outside, "export const secret = true;\n", "utf8");
  await writeFile(documentPath, "[source](../source.ts)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Source link",
    path: documentPath,
    attention: "none",
  });
  const sourceLink = document.sourceLinks[0]!;

  await rm(sourcePath);
  await symlink(outside, sourcePath);
  await assert.rejects(
    catalog.readDocumentSource(document.id, sourceLink.id),
    /linked source must not be a symlink/,
  );

  await rm(sourcePath);
  await assert.rejects(
    catalog.readDocumentSource(document.id, sourceLink.id),
    /linked source is missing/,
  );
  catalog.close();
});

test("bounds source-link expansion and rejects binary linked sources", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "bounded-links.md");
  const sourcePath = join(workspace, "binary.dat");
  await writeFile(sourcePath, Buffer.from([0]));
  await writeFile(documentPath, "[binary](../binary.dat)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Bounded links",
    path: documentPath,
    attention: "none",
  });
  await assert.rejects(
    catalog.readDocumentSource(document.id, document.sourceLinks[0]!.id),
    /linked source must contain UTF-8 text/,
  );

  await writeFile(
    documentPath,
    Array.from(
      { length: 513 },
      (_, index) => `[source ${index}](../binary.dat#L${index + 1})`,
    ).join("\n"),
    "utf8",
  );
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Too many links",
      path: documentPath,
      attention: "none",
    }),
    /more than 512 links/,
  );
  catalog.close();
});

test("marks disappeared sources missing and clears the state when they return", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "temporary.md");
  await writeFile(documentPath, "# Temporary\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Temporary",
    path: documentPath,
    attention: "none",
  });

  await rm(documentPath);
  await assert.rejects(
    catalog.readDocument(document.id),
    (error: unknown) => {
      assert.ok(error instanceof DocumentSourceMissingError);
      assert.equal(error.document.id, document.id);
      assert.equal(error.message, "Document source is missing");
      return true;
    },
  );
  assert.notEqual(catalog.getDocument(document.id)?.missingAt, null);

  await writeFile(documentPath, "# Restored\n", "utf8");
  const restored = await catalog.readDocument(document.id);
  assert.equal(restored.content, "# Restored\n");
  assert.equal(restored.document.missingAt, null);
  catalog.close();
});

test("rejects documents outside registered artifact roots", async () => {
  const { catalog, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Outside",
      path: outsidePath,
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
});

test("imports an outside Markdown source into durable private storage", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "agent-output.md");
  await writeFile(outsidePath, "# Durable agent output\n", "utf8");

  const imported = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });

  assert.equal(imported.storage, "managed");
  assert.notEqual(imported.path, outsidePath);
  assert.match(imported.path, /[/\\]managed[/\\]example[/\\]doc-[a-f0-9]{20}-[a-f0-9]{64}\.md$/);
  assert.equal((await stat(imported.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(statePath, "..", "managed"))).mode & 0o777, 0o700);

  const repeated = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });
  assert.equal(repeated.id, imported.id);
  assert.equal(repeated.revision, 1);

  await writeFile(outsidePath, "# Durable agent output v2\n", "utf8");
  const changed = await catalog.importDocument({
    workspaceId: "example",
    producer: "claude-code",
    kind: "brief",
    title: "Durable agent output",
    path: outsidePath,
    attention: "review",
    tags: ["agent"],
  });
  assert.equal(changed.id, imported.id);
  assert.equal(changed.revision, 2);
  assert.notEqual(changed.path, imported.path);

  await rm(outsidePath);
  assert.equal(
    (await catalog.readDocument(imported.id)).content,
    "# Durable agent output v2\n",
  );

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.equal(restored.getDocument(imported.id)?.storage, "managed");
  assert.equal(
    (await restored.readDocument(imported.id)).content,
    "# Durable agent output v2\n",
  );
  restored.close();
  catalog.close();
});

test("keeps registration root policy separate from managed imports", async () => {
  const { catalog, workspace } = await fixture();
  const outsidePath = join(workspace, "..", "outside-managed.md");
  const symlinkPath = join(workspace, "..", "outside-link.md");
  await writeFile(outsidePath, "# Managed\n", "utf8");
  await symlink(outsidePath, symlinkPath);

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Reference",
      path: outsidePath,
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Symlink",
      path: symlinkPath,
      attention: "none",
    }),
    /must not be a symlink/,
  );

  const imported = await catalog.importDocument({
    workspaceId: "example",
    kind: "other",
    title: "Managed",
    path: outsidePath,
    attention: "none",
  });
  await assert.doesNotReject(
    catalog.addWorkspace({
      id: "example",
      name: "Example renamed",
      root: workspace,
      artifactRoots: [workspace],
    }),
  );
  assert.equal(catalog.getDocument(imported.id)?.storage, "managed");
  catalog.close();
});

test("rejects symlink escapes from registered artifact roots", async () => {
  const { catalog, workspace } = await fixture();
  const outsideDir = await mkdtemp(join(tmpdir(), "mdmaid-desk-outside-"));
  const outsidePath = join(outsideDir, "secret.md");
  await writeFile(outsidePath, "# Secret\n", "utf8");
  await symlink(outsideDir, join(workspace, "linked"));

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Escaped",
      path: join(workspace, "linked", "secret.md"),
      attention: "none",
    }),
    /outside registered artifact roots/,
  );
});

test("rejects non-Markdown and oversized files", async () => {
  const { catalog, workspace } = await fixture();
  const textPath = join(workspace, "notes.txt");
  const largePath = join(workspace, "large.md");
  await writeFile(textPath, "notes", "utf8");
  await writeFile(largePath, "x".repeat(257), "utf8");

  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Notes",
      path: textPath,
      attention: "none",
    }),
    /Markdown files/,
  );
  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Notes",
      path: textPath,
      attention: "none",
    }),
    /Markdown files/,
  );

  const smallCatalog = await Catalog.open(join(workspace, ".state", "catalog.sqlite3"), {
    maxDocumentBytes: 256,
  });
  await smallCatalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  await assert.rejects(
    smallCatalog.registerDocument({
      workspaceId: "example",
      kind: "other",
      title: "Large",
      path: largePath,
      attention: "none",
    }),
    /exceeds 256 bytes/,
  );
  await assert.rejects(
    smallCatalog.importDocument({
      workspaceId: "example",
      kind: "other",
      title: "Large import",
      path: largePath,
      attention: "none",
    }),
    /exceeds 256 bytes/,
  );
});

test("rejects symlinked managed storage without writing through it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-managed-symlink-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "catalog.sqlite3");
  const redirected = join(root, "redirected");
  const sourcePath = join(root, "outside.md");
  await mkdir(workspace);
  await mkdir(redirected);
  await writeFile(sourcePath, "# Outside\n", "utf8");
  const catalog = await Catalog.open(statePath, { legacyStatePath: false });
  await catalog.addWorkspace({
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  });
  await symlink(redirected, join(root, "state", "managed"));

  await assert.rejects(
    catalog.importDocument({
      workspaceId: "example",
      kind: "brief",
      title: "Outside",
      path: sourcePath,
      attention: "none",
    }),
    /non-symlink directory/,
  );
  assert.deepEqual(await readFile(sourcePath, "utf8"), "# Outside\n");
  assert.deepEqual(await readdir(redirected), []);
  catalog.close();
});

test("rejects malformed legacy catalog entries without consuming the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-invalid-state-"));
  const statePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        {
          id: "example",
          name: "Example",
          root: root,
          artifactRoots: "not-an-array",
        },
      ],
      documents: [],
    }),
    "utf8",
  );

  await assert.rejects(
    Catalog.open(statePath, { legacyStatePath }),
    /invalid workspace entry/,
  );
  await assert.doesNotReject(access(legacyStatePath));
});

test("rejects workspace updates that would orphan registered documents", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "review.md");
  const otherRoot = join(workspace, "other");
  await mkdir(otherRoot);
  await writeFile(documentPath, "# Review\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "review",
    title: "Review",
    path: documentPath,
    attention: "review",
  });

  await assert.rejects(
    catalog.addWorkspace({
      id: "example",
      name: "Example",
      root: workspace,
      artifactRoots: [otherRoot],
    }),
    /exclude registered document/,
  );
});

test("freezes workspace repository identity after the first document", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "identity.md");
  await writeFile(documentPath, "# Identity\n", "utf8");

  await catalog.addWorkspace({
    id: "example",
    name: "Example before registration",
    root: workspace,
    artifactRoots: [workspace],
    repository: "github.com/acme/original",
    repositoryName: "Original",
  });
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Identity",
    path: documentPath,
    attention: "none",
  });
  const beforeWorkspace = catalog.listWorkspaces();
  const beforeDocuments = catalog.listDocuments();

  await assert.rejects(
    catalog.addWorkspace({
      id: "example",
      name: "Must not persist",
      root: workspace,
      artifactRoots: [workspace],
      repository: "github.com/acme/replacement",
      repositoryName: "Replacement",
    }),
    /repository identity cannot change after documents exist/,
  );
  assert.deepEqual(catalog.listWorkspaces(), beforeWorkspace);
  assert.deepEqual(catalog.listDocuments(), beforeDocuments);
  assert.equal(catalog.getDocument(document.id)?.projectId, document.projectId);

  await catalog.addWorkspace({
    id: "example",
    name: "Allowed metadata rename",
    root: workspace,
    artifactRoots: [workspace],
    repository: "git@github.com:acme/original.git",
    repositoryName: "Original",
  });
  assert.equal(catalog.listWorkspaces()[0]?.name, "Allowed metadata rename");
});

test("tracks reading progress by content revision", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "status.md");
  await writeFile(documentPath, "# First revision\n", "utf8");

  const registered = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Status plan",
    path: documentPath,
    attention: "review",
    tags: ["Architecture", "architecture", "urgent"],
  });
  assert.equal(registered.revision, 1);
  assert.equal(registered.status, "unread");
  assert.deepEqual(registered.tags, ["architecture", "urgent"]);

  const opened = await catalog.markDocumentOpened(registered.id);
  assert.equal(opened.status, "reading");
  assert.equal(opened.openedRevision, 1);

  const completed = await catalog.markDocumentRead(registered.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.completedRevision, 1);

  const metadataOnly = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Renamed status plan",
    path: documentPath,
    attention: "none",
    tags: ["architecture", "urgent"],
  });
  assert.equal(metadataOnly.revision, 1);
  assert.equal(metadataOnly.status, "done");

  await writeFile(documentPath, "# Second revision\n", "utf8");
  const changed = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Renamed status plan",
    path: documentPath,
    attention: "none",
    tags: ["architecture", "urgent"],
  });
  assert.equal(changed.revision, 2);
  assert.equal(changed.status, "unread");
  assert.equal(changed.openedRevision, 1);
  assert.equal(changed.completedRevision, 1);

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments(), [changed]);
  restored.close();
});

test("persists explicit review requests separately from reading progress", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "approval.md");
  await writeFile(documentPath, "# Approval\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    producer: "codex",
    kind: "plan",
    title: "Approval plan",
    path: documentPath,
    attention: "approval",
  });

  assert.deepEqual(catalog.listReviewRequests(), []);
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    documentRevision: document.revision,
    kind: "plan-decision",
    requestMessage: "Please verify rollback coverage.\r\nKeep the rationale.",
  });
  assert.match(request.id, /^review-[a-f0-9]{20}$/);
  assert.equal(request.status, "pending");
  assert.equal(
    request.requestMessage,
    "Please verify rollback coverage.\nKeep the rationale.",
  );
  assert.equal(request.response, null);

  await catalog.markDocumentOpened(document.id);
  await catalog.markDocumentRead(document.id);
  assert.equal(catalog.getReviewRequest(request.id)?.status, "pending");

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.getReviewRequest(request.id), request);
  restored.close();
});

test("binds change decisions to change-review documents", async () => {
  const { catalog, workspace } = await fixture();
  const changePath = join(workspace, "reports", "change-review.md");
  const planPath = join(workspace, "reports", "ordinary-plan.md");
  await writeFile(changePath, "# Change review\n", "utf8");
  await writeFile(planPath, "# Plan\n", "utf8");
  const changeReview = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Change review",
    path: changePath,
    attention: "approval",
  });
  const plan = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Plan",
    path: planPath,
    attention: "approval",
  });

  await assert.rejects(
    catalog.createReviewRequest({
      documentId: plan.id,
      kind: "change-decision",
      requestMessage: "This is not a change review.",
    }),
    /change-decision requires a change-review document/,
  );
  await assert.rejects(
    catalog.createReviewRequest({
      documentId: changeReview.id,
      kind: "plan-decision",
      requestMessage: "This is not a plan decision.",
    }),
    /change-review documents require a change-decision/,
  );
  const request = await catalog.createReviewRequest({
    documentId: changeReview.id,
    documentRevision: changeReview.revision,
    kind: "change-decision",
    requestMessage: "Review this exact implementation.",
  });
  assert.equal(request.kind, "change-decision");
  catalog.close();
});

test("records one durable human response and requires reasons for changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "decision.md");
  await writeFile(documentPath, "# Decision\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Decision plan",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "Check the deployment order.",
  });

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "   ",
    }),
    /response message or anchored feedback is required/,
  );
  const responded = await catalog.respondToReviewRequest(request.id, {
    outcome: "changes_requested",
    message: "Move the database migration before the daemon restart.",
  });
  assert.equal(responded.status, "changes_requested");
  assert.equal(
    responded.response?.message,
    "Move the database migration before the daemon restart.",
  );

  await catalog.archiveDocument(document.id);

  assert.deepEqual(
    await catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "Move the database migration before the daemon restart.",
    }),
    responded,
  );
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "",
    }),
    /already has a different response/,
  );
  catalog.close();
});

test("supersedes an obsolete review without treating it as rejection", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "superseded.md");
  await writeFile(documentPath, "# First proposal\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "First proposal",
    path: documentPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "change-decision",
    requestMessage: "Review this proposal.",
  });

  const superseded = await catalog.respondToReviewRequest(request.id, {
    outcome: "superseded",
    message: "A newer review replaces this one.",
  });

  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.response?.outcome, "superseded");
  assert.equal(catalog.listReviewRequests({ status: "pending" }).length, 0);
  assert.deepEqual(
    await catalog.respondToReviewRequest(request.id, {
      outcome: "superseded",
      message: "A newer review replaces this one.",
    }),
    superseded,
  );

  catalog.close();
  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(restored.getReviewRequest(request.id), superseded);
  restored.close();
});

test("persists structured file, hunk, line, and todo feedback", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "change-feedback.md");
  await writeFile(documentPath, "# Change feedback\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Change feedback",
    path: documentPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "change-decision",
    requestMessage: "Review the exact implementation.",
  });
  const items = [
    {
      id: "feedback-11111111111111111111",
      kind: "feedback" as const,
      path: "src/auth.ts",
      hunkId: "hunk-11111111111111111111",
      line: 14,
      endLine: 17,
      side: "new" as const,
      message: "Use constant-time comparison here.",
    },
    {
      id: "feedback-33333333333333333333",
      kind: "feedback" as const,
      path: "src/auth.ts",
      message: "Keep the public contract stable.",
    },
    {
      id: "feedback-22222222222222222222",
      kind: "todo" as const,
      path: "test/auth.test.ts",
      message: "Cover the expired-token boundary.",
    },
  ];

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "rejected",
      message: "Do not publish.",
      items,
    }),
    /feedback items require an approved or changes_requested outcome/,
  );

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "Address the anchored feedback.",
      items: [{ ...items[0]!, path: "../../private.txt" }],
    }),
    /invalid review feedback item/,
  );
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "changes_requested",
      message: "Address the anchored feedback.",
      items: [{ ...items[0]!, endLine: 13 }],
    }),
    /invalid review feedback item/,
  );

  const anchoredOnly = await catalog.respondToReviewRequest(request.id, {
    outcome: "changes_requested",
    message: "",
    items,
  });
  assert.deepEqual(anchoredOnly.response?.items, items);
  assert.equal(anchoredOnly.response?.message, "");
  catalog.close();

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(restored.getReviewRequest(request.id)?.response?.items, items);
  restored.close();
});

test("persists anchored feedback as non-blocking approval comments", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "approved-feedback.md");
  await writeFile(documentPath, "# Approved feedback\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "change-review",
    title: "Approved feedback",
    path: documentPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "change-decision",
    requestMessage: "Review this exact implementation.",
  });
  const items = [{
    id: "feedback-44444444444444444444",
    kind: "feedback" as const,
    path: "src/auth.ts",
    message: "Approved, but consider simplifying this later.",
  }];

  const approved = await catalog.respondToReviewRequest(request.id, {
    outcome: "approved",
    message: "Safe to publish.",
    items,
  });
  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.response?.items, items);
  catalog.close();

  const restored = await Catalog.open(statePath, { legacyStatePath: false });
  assert.deepEqual(restored.getReviewRequest(request.id)?.response?.items, items);
  restored.close();
});

test("stales a pending review when document content changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "revision-gate.md");
  await writeFile(documentPath, "# Version one\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Revision gate",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: first.id,
    documentRevision: first.revision,
    kind: "plan-decision",
    requestMessage: "Review this exact revision.",
  });

  await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Metadata only",
    path: documentPath,
    attention: "review",
  });
  assert.equal(catalog.getReviewRequest(request.id)?.status, "pending");

  await writeFile(documentPath, "# Version two\n", "utf8");
  await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Revision gate",
    path: documentPath,
    attention: "none",
  });
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "",
    }),
    /review request is stale/,
  );
  catalog.close();
});

test("refuses a response when the source changed without re-registration", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "unobserved-revision.md");
  await writeFile(documentPath, "# Reviewed version\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Unobserved revision",
    path: documentPath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "Review this exact file content.",
  });

  await writeFile(documentPath, "# Changed behind the catalog\n", "utf8");

  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "Looks good.",
    }),
    /review request is stale/,
  );
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");
  catalog.close();
});

test("refuses to create a review for unregistered source changes", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "unregistered-create.md");
  await writeFile(documentPath, "# Registered version\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Registered version",
    path: documentPath,
    attention: "none",
  });

  await writeFile(documentPath, "# Changed before review creation\n", "utf8");

  await assert.rejects(
    catalog.createReviewRequest({
      documentId: document.id,
      kind: "plan-decision",
      requestMessage: "Review the current content.",
    }),
    /document content changed/,
  );
  assert.deepEqual(catalog.listReviewRequests(), []);
  catalog.close();
});

test("fails review creation and response closed when sources disappear", async () => {
  const { catalog, workspace } = await fixture();
  const responsePath = join(workspace, "reports", "missing-response.md");
  await writeFile(responsePath, "# Response source\n", "utf8");
  const responseDocument = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Response source",
    path: responsePath,
    attention: "none",
  });
  const request = await catalog.createReviewRequest({
    documentId: responseDocument.id,
    kind: "plan-decision",
    requestMessage: "Review before it disappears.",
  });
  await rm(responsePath);
  await assert.rejects(
    catalog.respondToReviewRequest(request.id, {
      outcome: "approved",
      message: "Approved.",
    }),
    /review request is stale/,
  );
  assert.equal(catalog.getReviewRequest(request.id)?.status, "stale");

  const createPath = join(workspace, "reports", "missing-create.md");
  await writeFile(createPath, "# Creation source\n", "utf8");
  const createDocument = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Creation source",
    path: createPath,
    attention: "none",
  });
  await rm(createPath);
  await assert.rejects(
    catalog.createReviewRequest({
      documentId: createDocument.id,
      kind: "plan-decision",
      requestMessage: "This cannot be reviewed.",
    }),
    /document source is unavailable/,
  );
  catalog.close();
});

test("creates pending review requests idempotently and rejects conflicts", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "idempotent-review.md");
  await writeFile(documentPath, "# Plan\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Plan",
    path: documentPath,
    attention: "none",
  });
  const input = {
    documentId: document.id,
    documentRevision: document.revision,
    kind: "plan-decision" as const,
    requestMessage: "Review it.",
  };
  const first = await catalog.createReviewRequest(input);
  await assert.rejects(
    catalog.archiveDocument(document.id),
    /document has a pending review request/,
  );
  assert.deepEqual(await catalog.createReviewRequest(input), first);
  await assert.rejects(
    catalog.createReviewRequest({
      ...input,
      requestMessage: "Review a different concern.",
    }),
    /already has a pending review request/,
  );
  await assert.rejects(
    catalog.createReviewRequest({
      ...input,
      documentRevision: 99,
    }),
    /document revision changed/,
  );
  await catalog.respondToReviewRequest(first.id, {
    outcome: "approved",
    message: "Approved.",
  });
  await catalog.archiveDocument(document.id);
  await assert.rejects(
    catalog.createReviewRequest(input),
    /document is archived/,
  );
  catalog.close();
});

test("persists tags and filters status, archive, and missing state", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const planPath = join(workspace, "reports", "plan.md");
  const reviewPath = join(workspace, "reports", "review.md");
  await writeFile(planPath, "# Plan\n", "utf8");
  await writeFile(reviewPath, "# Review\n", "utf8");

  const plan = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-1",
    kind: "plan",
    title: "Plan's title",
    path: planPath,
    attention: "approval",
    tags: ["architecture", "task-1"],
  });
  const review = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-2",
    kind: "review",
    title: "Review",
    path: reviewPath,
    attention: "review",
    tags: ["task-1"],
  });

  await catalog.markDocumentRead(plan.id);
  await catalog.markDocumentMissing(review.id);
  await catalog.archiveDocument(review.id);

  assert.deepEqual(
    catalog.listDocuments({ tag: "architecture" }).map(({ id }) => id),
    [plan.id],
  );
  assert.deepEqual(
    catalog.listDocuments({ status: "done" }).map(({ id }) => id),
    [plan.id],
  );
  assert.deepEqual(
    catalog.listDocuments({ archived: true, missing: true }).map(({ id }) => id),
    [review.id],
  );
  assert.equal(catalog.listDocuments().some(({ id }) => id === review.id), false);

  catalog.close();
  const restored = await Catalog.open(statePath);
  assert.deepEqual(restored.listDocuments({ archived: true })[0]?.tags, ["task-1"]);
  restored.close();
});

test("imports a legacy JSON catalog once and preserves it as a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-legacy-state-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  const databasePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await mkdir(workspace);
  await writeFile(documentPath, "# Imported plan\n", "utf8");
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        {
          id: "example",
          name: "Example",
          root: workspace,
          artifactRoots: [workspace],
        },
      ],
      documents: [
        {
          id: "doc-0123456789abcdefabcd",
          workspaceId: "example",
          kind: "plan",
          title: "Imported plan",
          path: documentPath,
          attention: "none",
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath });
  assert.equal(catalog.listWorkspaces().length, 1);
  assert.equal(catalog.listDocuments()[0]?.revision, 1);
  assert.equal(catalog.listDocuments()[0]?.status, "unread");
  catalog.close();

  await assert.rejects(access(legacyStatePath), { code: "ENOENT" });
  assert.equal(
    JSON.parse(await readFile(`${legacyStatePath}.migrated`, "utf8")).schemaVersion,
    1,
  );

  const restored = await Catalog.open(databasePath, { legacyStatePath });
  assert.equal(restored.listDocuments().length, 1);
  restored.close();
});

test("applies the SQLite schema migration and rejects a future schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-schema-"));
  const databasePath = join(root, "catalog.sqlite3");
  const catalog = await Catalog.open(databasePath, { legacyStatePath: false });
  catalog.close();

  const versionOne = new Database(databasePath);
  versionOne.exec("ALTER TABLE documents DROP COLUMN source_path");
  versionOne.exec("ALTER TABLE documents DROP COLUMN storage_kind");
  versionOne.exec(
    "DROP TABLE space_matchers; DROP TABLE spaces; DROP INDEX workspace_repositories_key_idx",
  );
  versionOne.pragma("user_version = 1");
  versionOne.close();
  const migrated = await Catalog.open(databasePath, { legacyStatePath: false });
  migrated.close();

  const versionTwo = new Database(databasePath);
  versionTwo.exec("DROP TABLE document_source_links");
  versionTwo.exec(
    "DROP TABLE space_matchers; DROP TABLE spaces; DROP INDEX workspace_repositories_key_idx",
  );
  versionTwo.pragma("user_version = 2");
  versionTwo.close();
  const migratedAgain = await Catalog.open(databasePath, {
    legacyStatePath: false,
  });
  migratedAgain.close();

  const versionThree = new Database(databasePath);
  versionThree.exec("DROP TABLE review_responses");
  versionThree.exec("DROP TABLE review_requests");
  versionThree.exec(
    "DROP TABLE space_matchers; DROP TABLE spaces; DROP INDEX workspace_repositories_key_idx",
  );
  versionThree.pragma("user_version = 3");
  versionThree.close();
  const migratedReviews = await Catalog.open(databasePath, {
    legacyStatePath: false,
  });
  migratedReviews.close();

  const database = new Database(databasePath, { readonly: true });
  assert.equal(database.pragma("user_version", { simple: true }), 9);
  assert.deepEqual(
    database
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map(({ name }) => name)
      .filter((name) => name === "storage_kind" || name === "source_path"),
    ["storage_kind", "source_path"],
  );
  assert.deepEqual(
    database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name),
    [
      "document_projects",
      "document_source_links",
      "document_tags",
      "documents",
      "projects",
      "review_requests",
      "review_responses",
      "space_matchers",
      "spaces",
      "tags",
      "workspace_artifact_roots",
      "workspace_repositories",
      "workspaces",
    ],
  );
  database.close();

  const constraints = new Database(databasePath);
  constraints
    .prepare("INSERT INTO spaces (id, name) VALUES (?, ?)")
    .run("work", "Work");
  constraints
    .prepare(
      "INSERT INTO space_matchers (space_id, kind, value) VALUES (?, ?, ?)",
    )
    .run("work", "tag", "client-work");
  assert.throws(
    () => constraints
      .prepare(
        "INSERT INTO space_matchers (space_id, kind, value) VALUES (?, ?, ?)",
      )
      .run("work", "tag", "client-work"),
    /UNIQUE constraint failed/,
  );
  constraints.prepare("DELETE FROM spaces WHERE id = ?").run("work");
  assert.equal(
    constraints
      .prepare<[], { count: number }>("SELECT count(*) AS count FROM space_matchers")
      .get()?.count,
    0,
  );
  constraints.close();

  const futurePath = join(root, "future.sqlite3");
  const future = new Database(futurePath);
  future.pragma("user_version = 99");
  future.close();
  await assert.rejects(
    Catalog.open(futurePath, { legacyStatePath: false }),
    /unsupported SQLite catalog schema 99/,
  );
});

test("rolls back a failed version nine migration", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "preserved.md");
  await writeFile(documentPath, "# Preserved\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Preserved",
    path: documentPath,
    attention: "none",
  });
  catalog.close();

  const broken = new Database(statePath);
  broken.exec("DROP TABLE space_matchers; DROP TABLE spaces");
  broken.exec("CREATE TABLE spaces (broken TEXT) STRICT");
  broken.pragma("user_version = 8");
  broken.close();

  await assert.rejects(
    Catalog.open(statePath, { legacyStatePath: false }),
    /table spaces already exists/,
  );

  const inspected = new Database(statePath, { readonly: true });
  assert.equal(inspected.pragma("user_version", { simple: true }), 8);
  assert.equal(
    inspected
      .prepare<[string], { title: string }>("SELECT title FROM documents WHERE id = ?")
      .get(document.id)?.title,
    "Preserved",
  );
  assert.deepEqual(
    inspected.prepare<[], { name: string }>("PRAGMA table_info(spaces)").all(),
    [{ cid: 0, name: "broken", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }],
  );
  inspected.close();
});

test("migrates version four review requests without losing decisions", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "existing-plan.md");
  await writeFile(documentPath, "# Existing plan\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Existing plan",
    path: documentPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "Preserve this request.",
  });
  await catalog.respondToReviewRequest(request.id, {
    outcome: "approved",
    message: "Preserve this response too.",
  });
  catalog.close();

  const versionFour = new Database(statePath);
  versionFour.exec(
    "DROP TABLE space_matchers; DROP TABLE spaces; DROP INDEX workspace_repositories_key_idx",
  );
  versionFour.pragma("user_version = 4");
  versionFour.close();

  const migrated = await Catalog.open(statePath, { legacyStatePath: false });
  assert.equal(migrated.getReviewRequest(request.id)?.status, "approved");
  assert.equal(
    migrated.getReviewRequest(request.id)?.response?.message,
    "Preserve this response too.",
  );
  migrated.close();

  const database = new Database(statePath, { readonly: true });
  assert.equal(database.pragma("user_version", { simple: true }), 9);
  const schema = database
    .prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_requests'",
    )
    .get()?.sql;
  assert.match(schema ?? "", /change-decision/);
  database.close();
});

test("rolls back the entire legacy import when one document conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-legacy-rollback-"));
  const workspace = join(root, "workspace");
  const documentPath = join(workspace, "plan.md");
  const databasePath = join(root, "catalog.sqlite3");
  const legacyStatePath = join(root, "catalog.json");
  await mkdir(workspace);
  await writeFile(documentPath, "# Plan\n", "utf8");

  const workspaceEntry = {
    id: "example",
    name: "Example",
    root: workspace,
    artifactRoots: [workspace],
  };
  const documentEntry = {
    id: "doc-11111111111111111111",
    workspaceId: "example",
    kind: "plan",
    title: "Plan",
    path: documentPath,
    attention: "none",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  };
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [workspaceEntry],
      documents: [
        documentEntry,
        { ...documentEntry, id: "doc-22222222222222222222" },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    Catalog.open(databasePath, { legacyStatePath }),
    /UNIQUE constraint failed/,
  );
  await writeFile(
    legacyStatePath,
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [workspaceEntry],
      documents: [documentEntry],
    }),
    "utf8",
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath });
  assert.deepEqual(
    catalog.listDocuments().map(({ id }) => id),
    [documentEntry.id],
  );
  catalog.close();
  await assert.rejects(access(legacyStatePath), { code: "ENOENT" });
  await assert.doesNotReject(access(`${legacyStatePath}.migrated`));
});

test("rejects a symlink used as the SQLite catalog path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-db-symlink-"));
  const targetPath = join(root, "target.sqlite3");
  const linkedPath = join(root, "catalog.sqlite3");
  const database = new Database(targetPath);
  database.close();
  await symlink(targetPath, linkedPath);

  await assert.rejects(
    Catalog.open(linkedPath, { legacyStatePath: false }),
    /regular, non-symlink file/,
  );
});

test("supports lifecycle updates and all persisted document filters", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "lifecycle.md");
  await writeFile(documentPath, "# Lifecycle\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    taskId: "DESK-3",
    producer: "claude",
    kind: "review",
    title: "Lifecycle",
    path: documentPath,
    attention: "changes_requested",
    tags: ["Initial"],
  });

  assert.equal(catalog.listDocuments({ workspaceId: "example" }).length, 1);
  assert.equal(catalog.listDocuments({ taskId: "DESK-3" }).length, 1);
  assert.equal(catalog.listDocuments({ kind: "review" }).length, 1);
  assert.equal(
    catalog.listDocuments({ attention: "changes_requested" }).length,
    1,
  );
  assert.equal(catalog.listDocuments({ status: "unread" }).length, 1);
  assert.equal(catalog.listDocuments({ missing: false }).length, 1);

  await catalog.markDocumentOpened(document.id);
  assert.equal(catalog.listDocuments({ status: "reading" }).length, 1);
  await catalog.markDocumentRead(document.id);
  assert.equal(catalog.listDocuments({ status: "done" }).length, 1);
  assert.equal((await catalog.markDocumentUnread(document.id)).status, "unread");

  const tagged = await catalog.setDocumentTags(document.id, ["Updated", "final"]);
  assert.deepEqual(tagged.tags, ["final", "updated"]);
  await assert.rejects(
    catalog.setDocumentTags(document.id, ["not a valid tag"]),
    /tags must use/,
  );

  await catalog.markDocumentMissing(document.id);
  assert.equal((await catalog.markDocumentPresent(document.id)).missingAt, null);
  const archived = await catalog.archiveDocument(document.id);
  assert.equal((await catalog.archiveDocument(document.id)).archivedAt, archived.archivedAt);
  assert.equal((await catalog.restoreDocument(document.id)).archivedAt, null);

  await assert.rejects(
    catalog.markDocumentRead("invalid"),
    /invalid document id/,
  );
  await assert.rejects(
    catalog.markDocumentRead("doc-00000000000000000000"),
    /unknown document/,
  );
  catalog.close();
});

test("archives and restores document batches atomically", async () => {
  const { catalog, workspace } = await fixture();
  const firstPath = join(workspace, "reports", "bulk-first.md");
  const secondPath = join(workspace, "reports", "bulk-second.md");
  await writeFile(firstPath, "# First\n", "utf8");
  await writeFile(secondPath, "# Second\n", "utf8");
  const first = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "First",
    path: firstPath,
    attention: "none",
  });
  const second = await catalog.registerDocument({
    workspaceId: "example",
    kind: "review",
    title: "Second",
    path: secondPath,
    attention: "approval",
  });
  const request = await catalog.createReviewRequest({
    documentId: second.id,
    kind: "plan-decision",
    requestMessage: "Review before archiving.",
  });

  await assert.rejects(
    catalog.archiveDocuments([first.id, second.id]),
    /document has a pending review request/,
  );
  assert.deepEqual(
    catalog.listDocuments().map(({ id }) => id).sort(),
    [first.id, second.id].sort(),
  );

  await catalog.respondToReviewRequest(request.id, {
    outcome: "approved",
    message: "Done.",
  });
  assert.equal((await catalog.archiveDocuments([first.id, second.id])).length, 2);
  assert.equal(catalog.listDocuments().length, 0);
  assert.equal(catalog.listDocuments({ archived: true }).length, 2);
  assert.equal((await catalog.restoreDocuments([first.id, second.id])).length, 2);
  assert.equal(catalog.listDocuments().length, 2);
  catalog.close();
});

test("purges catalog history without deleting referenced Markdown", async () => {
  const { catalog, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "purge-reference.md");
  await writeFile(documentPath, "# Keep source\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "plan",
    title: "Purge reference",
    path: documentPath,
    attention: "approval",
    tags: ["purge-test"],
  });
  const request = await catalog.createReviewRequest({
    documentId: document.id,
    kind: "plan-decision",
    requestMessage: "This history will be purged.",
  });

  assert.deepEqual(await catalog.purgeDocuments([document.id]), [document.id]);
  assert.equal(catalog.getDocument(document.id), undefined);
  assert.equal(catalog.getReviewRequest(request.id), undefined);
  assert.equal(await readFile(documentPath, "utf8"), "# Keep source\n");
  catalog.close();
});

test("purges every private managed copy while preserving its original source", async () => {
  const { catalog, workspace } = await fixture();
  const sourcePath = join(workspace, "..", "purge-managed.md");
  await writeFile(sourcePath, "# Managed v1\n", "utf8");
  const first = await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Managed purge",
    path: sourcePath,
    attention: "none",
  });
  await writeFile(sourcePath, "# Managed v2\n", "utf8");
  const second = await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Managed purge",
    path: sourcePath,
    attention: "none",
  });
  assert.equal(second.id, first.id);
  assert.notEqual(second.path, first.path);
  const unrelatedPath = join(dirname(first.path), `${first.id}-notes.md`);
  await writeFile(unrelatedPath, "# Not a managed revision\n", "utf8");

  assert.deepEqual(await catalog.purgeDocuments([first.id]), [first.id]);
  await assert.rejects(access(first.path));
  await assert.rejects(access(second.path));
  assert.equal(
    await readFile(unrelatedPath, "utf8"),
    "# Not a managed revision\n",
  );
  assert.equal(await readFile(sourcePath, "utf8"), "# Managed v2\n");
  catalog.close();
});

test("restores every staged managed revision after an interrupted purge", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const sourcePath = join(workspace, "..", "purge-recovery.md");
  await writeFile(sourcePath, "# Managed v1\n", "utf8");
  const first = await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Managed recovery",
    path: sourcePath,
    attention: "none",
  });
  await writeFile(sourcePath, "# Managed v2\n", "utf8");
  const second = await catalog.importDocument({
    workspaceId: "example",
    kind: "brief",
    title: "Managed recovery",
    path: sourcePath,
    attention: "none",
  });
  catalog.close();

  for (const path of [first.path, second.path]) {
    await rename(
      path,
      join(dirname(path), `.${basename(path)}.deadbeef.purging`),
    );
  }
  const recovered = await Catalog.open(statePath);
  await access(first.path);
  await access(second.path);
  assert.equal(recovered.getDocument(first.id)?.path, second.path);
  recovered.close();
});

test("validates structured catalog input at runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdmaid-desk-validation-"));
  const databasePath = join(root, "catalog.sqlite3");
  await assert.rejects(Catalog.open("", { legacyStatePath: false }), /database path/);
  await assert.rejects(
    Catalog.open(databasePath, { maxDocumentBytes: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    Catalog.open(databasePath, { legacyStatePath: "" }),
    /legacyStatePath/,
  );

  const catalog = await Catalog.open(databasePath, { legacyStatePath: false });
  await assert.rejects(
    catalog.addWorkspace({
      id: "Invalid ID",
      name: "Invalid",
      root,
      artifactRoots: [root],
    }),
    /invalid workspace input/,
  );
  await assert.rejects(
    catalog.registerDocument({
      workspaceId: "unknown",
      kind: "other",
      title: "Unknown",
      path: join(root, "unknown.md"),
      attention: "none",
    }),
    /unknown workspace/,
  );
  assert.throws(
    () => catalog.listDocuments({ status: "invalid" as never }),
    /invalid status filter/,
  );
  assert.throws(
    () => catalog.listDocuments({ tag: "not a valid tag" }),
    /invalid tag filter/,
  );
  catalog.close();
});

test("rejects malformed rows read from the SQLite catalog", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "tampered.md");
  await writeFile(documentPath, "# Tampered\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "other",
    title: "Tampered",
    path: documentPath,
    attention: "none",
  });
  catalog.close();

  const database = new Database(statePath);
  database
    .prepare("UPDATE documents SET kind = ? WHERE id = ?")
    .run("not-a-kind", document.id);
  database.close();

  const reopened = await Catalog.open(statePath, { legacyStatePath: false });
  assert.throws(() => reopened.listDocuments(), /invalid document row/);
  reopened.close();
});

test("rejects malformed private source-link mappings read from SQLite", async () => {
  const { catalog, statePath, workspace } = await fixture();
  const documentPath = join(workspace, "reports", "linked.md");
  const sourcePath = join(workspace, "source.ts");
  await writeFile(sourcePath, "export const value = true;\n", "utf8");
  await writeFile(documentPath, "[source](../source.ts)\n", "utf8");
  const document = await catalog.registerDocument({
    workspaceId: "example",
    kind: "other",
    title: "Linked",
    path: documentPath,
    attention: "none",
  });
  catalog.close();

  const database = new Database(statePath);
  database
    .prepare(
      "UPDATE document_source_links SET workspace_path = ? WHERE document_id = ?",
    )
    .run("../outside.ts", document.id);
  database.close();

  const reopened = await Catalog.open(statePath, { legacyStatePath: false });
  assert.throws(() => reopened.getDocument(document.id), /invalid document row/);
  reopened.close();
});
