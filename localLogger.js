// Local Logger (system_design_plan.md §3.7) — Step 8. Writes one JSON
// record per *conversation* (not per turn) to a local JSONL file, per
// system_design_plan.md §5's data model (turns nested under a shared
// record, since multi-turn sessions need to stay grouped for Phase 3
// curation to make sense of them).
//
// JSONL over SQLite (decisions.md has the full reasoning): node:sqlite
// was evaluated and confirmed to work cleanly in Electron 43's bundled
// Node runtime with no native-addon packaging risk, but was still not
// chosen — nothing in current/near-term scope needs relational querying,
// `turns` would just serialize into a JSON TEXT column either way, and
// data_pipeline.md's own curation workflow (hand-editing a bad answer)
// is a text-editor operation on a JSONL line, not SQL.
//
// Caller contract: `cropPath`/`contextPath` must already be moved out of
// app.getPath('temp') into permanent storage by the time this is called —
// this module only writes the record, it doesn't move files. See
// decisions.md's temp-file-lifecycle invariant (main.js's
// endChatSession() owns the move, and must call this only on the "keep"
// branch, only with the permanent paths).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const LOG_PATH = path.join(app.getPath('userData'), 'conversations.jsonl');

// app_hint/category/feedback default to null — nothing in the app detects
// the active app or captures a category/thumbs rating yet (see todo.md's
// "Next" section); those default to null until that UI exists, and get
// filled in during Phase 3 curation for category, or a future feedback
// capture step for the other two.
function logConversation({
  cropPath,
  contextPath,
  appHint = null,
  turns,
  category = null,
  feedback = null,
  source = 'real_usage',
  startedAt,
  endedAt,
}) {
  const record = {
    id: crypto.randomUUID(),
    image_crop: cropPath,
    image_context: contextPath,
    app_hint: appHint,
    turns,
    category,
    feedback,
    source,
    started_at: startedAt,
    ended_at: endedAt,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
}

module.exports = { logConversation, LOG_PATH };
