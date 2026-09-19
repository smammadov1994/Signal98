import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, snapshotWorkingTree, applyWorkingTreeDiff } from "../lib/ghost-worktree.js";

process.env.SIGNAL98_DB = ":memory:";
delete process.env.TYPESAFE_API_KEY;
globalThis.fetch = () => { throw new Error("Ghost tests must not use the network"); };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal98-ghost-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\ndata/\nnode_modules/\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
  fs.writeFileSync(path.join(repo, "deleted.txt"), "remove me\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "baseline");
  const head = (await git(repo, "rev-parse", "HEAD")).trim();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "staged\n");
  await git(repo, "add", "tracked.txt");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "unstaged\n");
  fs.rmSync(path.join(repo, "deleted.txt"));
  const app = path.join(repo, "new shop");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "pay.js"), "export const broken = true;\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "TEST_SECRET=must-stay-out\n");
  fs.mkdirSync(path.join(repo, "data"));
  fs.writeFileSync(path.join(repo, "data", "db"), "ignored\n");
  const index = fs.readFileSync(path.join(repo, ".git", "index"));
  return { root, repo, app, head, index };
}

test("snapshot contains current staged, unstaged, new and deleted files without changing checkout or index", async (t) => {
  const f = await fixture(t);
  const snapshot = await snapshotWorkingTree(f.repo);
  assert.equal(await git(f.repo, "show", `${snapshot}:tracked.txt`), "unstaged\n");
  assert.equal(await git(f.repo, "show", `${snapshot}:new shop/pay.js`), "export const broken = true;\n");
  const files = await git(f.repo, "ls-tree", "-r", "--name-only", snapshot);
  assert.doesNotMatch(files, /deleted\.txt|\.env\.local|data\/db/);
  assert.equal((await git(f.repo, "rev-parse", "HEAD")).trim(), f.head);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git", "index")), f.index);
  assert.equal(fs.readFileSync(path.join(f.repo, "tracked.txt"), "utf8"), "unstaged\n");
});

test("a clean checkout uses its existing commit", async (t) => {
  const f = await fixture(t);
  await git(f.repo, "add", "-A");
  await git(f.repo, "commit", "-qm", "current files");
  assert.equal(await snapshotWorkingTree(f.repo), (await git(f.repo, "rev-parse", "HEAD")).trim());
});

test("apply changes an untracked file without staging it and rejects conflicts without partial edits", async (t) => {
  const f = await fixture(t);
  const base = await snapshotWorkingTree(f.repo);
  const wt = path.join(f.root, "worktree");
  await git(f.repo, "worktree", "add", "-q", "--detach", wt, base);
  fs.writeFileSync(path.join(wt, "new shop", "pay.js"), "export const broken = false;\n");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "fixed\n");
  const diff = await git(wt, "diff", "--binary", "--full-index");
  fs.writeFileSync(path.join(f.repo, "tracked.txt"), "concurrent user edit\n");
  await assert.rejects(applyWorkingTreeDiff(f.repo, diff));
  assert.equal(fs.readFileSync(path.join(f.app, "pay.js"), "utf8"), "export const broken = true;\n");
  assert.equal(fs.readFileSync(path.join(f.repo, "tracked.txt"), "utf8"), "concurrent user edit\n");
  assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git", "index")), f.index);
  fs.writeFileSync(path.join(f.repo, "tracked.txt"), "unstaged\n");
  await applyWorkingTreeDiff(f.repo, diff);
  assert.equal(fs.readFileSync(path.join(f.app, "pay.js"), "utf8"), "export const broken = false;\n");
  assert.equal(fs.readFileSync(path.join(f.repo, "tracked.txt"), "utf8"), "fixed\n");
  assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git", "index")), f.index);
});

test("Ghost run → isolated commit → apply → second attempt works on an uncommitted app (CLI stub)", async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, "fake-claude");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.equal(process.argv[process.argv.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write");
let prompt = "";
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  assert.match(prompt, /Preserve checkout retry behavior/);
  const code = fs.readFileSync("pay.js", "utf8");
  assert.match(code, /broken = true/);
  fs.writeFileSync("pay.js", code.replace("broken = true", "broken = false"));
  console.log(JSON.stringify({ type: "result", result: "Fixed the payment defect.", is_error: false, total_cost_usd: 0 }));
});
`, { mode: 0o755 });
  process.env.SIGNAL98_CLAUDE_BIN = bin;
  process.env.SIGNAL98_GHOST_PROVIDER = "claude-code";
  process.env.SIGNAL98_DATA_DIR = path.join(f.root, "data");
  const { q, getProject, saveProjectSettings } = await import("../lib/db.js");
  const { startAgentRun, applyRun } = await import("../lib/ghost.js");
  const settings = getProject(1).settings;
  saveProjectSettings(1, { ...settings, ghost: { ...settings.ghost, repoPath: f.app } });
  const issueId = Number(q("INSERT INTO issues (project_id, fingerprint, title, first_seen, last_seen) VALUES (1, 'ghost-test', 'payment defect', 1, 1)").run().lastInsertRowid);
  q("INSERT INTO issue_messages(project_id,issue_id,role,content,created_at) VALUES (1,?,'user','Preserve checkout retry behavior',1)").run(issueId);
  const wait = async (id) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = q("SELECT * FROM agent_runs WHERE id = ?").get(id);
      if (!["running", "queued"].includes(run.status) && !globalThis.__s98_ghost.running) return run;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail("Ghost did not finish");
  };
  const run = await wait((await startAgentRun(issueId)).id);
  assert.equal(run.status, "succeeded", run.summary);
  assert.match(run.diff, /broken = false/);
  assert.doesNotMatch(run.diff, /tracked\.txt|deleted\.txt|\.gitignore/);
  assert.equal(fs.existsSync(run.worktree), false);
  assert.equal((await git(f.repo, "rev-parse", "HEAD")).trim(), f.head);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git", "index")), f.index);
  assert.match(fs.readFileSync(path.join(f.app, "pay.js"), "utf8"), /broken = true/);
  await applyRun(run.id);
  assert.match(fs.readFileSync(path.join(f.app, "pay.js"), "utf8"), /broken = false/);
  assert.equal(q("SELECT status FROM issues WHERE id = ?").get(issueId).status, "resolved");
  assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git", "index")), f.index);
  // Simulate the defect recurring in the current working files.
  fs.writeFileSync(path.join(f.app, "pay.js"), "export const broken = true;\n");
  q("UPDATE issues SET status = 'open', regressed = 1 WHERE id = ?").run(issueId);
  const retry = await wait((await startAgentRun(issueId, "regression")).id);
  assert.equal(retry.status, "succeeded", retry.summary);
  assert.equal(retry.attempt, 2);
  assert.notEqual(retry.branch, run.branch);
});
