import assert from "node:assert/strict";
import test from "node:test";

import { deriveReadingStatus } from "./domain.js";

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
