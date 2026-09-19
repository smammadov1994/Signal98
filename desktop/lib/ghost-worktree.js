import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
export async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

// Build an isolated baseline from the files currently on disk. A private index
// includes staged, unstaged, deleted and non-ignored new files without changing
// the user's index, branch or working tree. Ignored .env/data/build files stay out.
export async function snapshotWorkingTree(top) {
  if ((await git(top, "ls-files", "--unmerged")).trim()) {
    throw new Error("Resolve the repository's merge conflicts before starting Ghost.");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signal98-snapshot-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, "index") };
  const isolated = async (...args) => (await exec("git", ["-C", top, ...args], { env, maxBuffer: 20 * 1024 * 1024 })).stdout.trim();
  try {
    const head = (await git(top, "rev-parse", "HEAD")).trim();
    await isolated("read-tree", head);
    await isolated("add", "-A", "--", ".");
    const tree = await isolated("write-tree");
    if (tree === (await git(top, "rev-parse", `${head}^{tree}`)).trim()) return head;
    return await isolated("-c", "user.name=signal98 ghost", "-c", "user.email=ghost@signal98.local",
      "commit-tree", tree, "-p", head, "-m", "signal98: snapshot current working files for Ghost");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// A three-way apply implicitly uses the real index: new, uncommitted files are
// absent there and dirty tracked files don't match it. Apply to working files
// only. Git rejects a conflicting patch atomically, without conflict markers.
export async function applyWorkingTreeDiff(top, diff) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signal98-apply-"));
  const file = path.join(temp, "fix.patch");
  try {
    fs.writeFileSync(file, diff);
    await git(top, "apply", "--check", "--whitespace=nowarn", file);
    await git(top, "apply", "--whitespace=nowarn", file);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
