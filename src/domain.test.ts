import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveReadingStatus,
  isDocumentKind,
  isReviewKind,
  isReviewOutcome,
  isReviewStatus,
  projectDisplayName,
} from "./domain.js";

test("derives reading status from progress on the current revision", () => {
  assert.equal(
    deriveReadingStatus({ revision: 1, openedRevision: null, completedRevision: null }),
    "unread",
  );
  assert.equal(
    deriveReadingStatus({ revision: 2, openedRevision: 2, completedRevision: null }),
    "reading",
  );
  assert.equal(
    deriveReadingStatus({ revision: 3, openedRevision: 3, completedRevision: 3 }),
    "done",
  );
});

test("a new revision is unread when progress belongs to older content", () => {
  assert.equal(
    deriveReadingStatus({ revision: 4, openedRevision: 3, completedRevision: 3 }),
    "unread",
  );
});

test("recognizes first-class change review documents and decisions", () => {
  assert.equal(isDocumentKind("change-review"), true);
  assert.equal(isReviewKind("change-decision"), true);
});

test("recognizes superseded as a terminal non-approval review result", () => {
  assert.equal(isReviewOutcome("superseded"), true);
  assert.equal(isReviewStatus("superseded"), true);
});

test("assembles project names from grounded identity and AI feature text", () => {
  assert.equal(
    projectDisplayName({
      repositoryName: "EyWizards",
      taskKey: "SA-2913",
      featureName: "COA Worker Continuity",
    }),
    "EyWizards / SA-2913 (COA Worker Continuity)",
  );
  assert.equal(
    projectDisplayName({ repositoryName: "EyWizards", taskKey: "SA-2913" }),
    "EyWizards / SA-2913",
  );
  assert.equal(
    projectDisplayName({
      repositoryName: "EyWizards",
      taskKey: "",
      featureName: "Worker Continuity",
    }),
    "EyWizards (Worker Continuity)",
  );
});
