import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildDiffArgs, getDiff, parseDiff, splitByFile, summarizeFiles, truncateDiff } from "../src/git";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x from "x";
-const a = 1;
+const a = 2;
+const b = 3;
`;

const ADDED = `diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+Text
`;

const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

const RENAMED = `diff --git a/a.ts b/b.ts
similarity index 100%
rename from a.ts
rename to b.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("buildDiffArgs", () => {
  it("diffs the working tree against HEAD by default", () => {
    const args = buildDiffArgs();
    assert.deepEqual(args.slice(0, 4), ["diff", "--no-color", "--no-ext-diff", "HEAD"]);
    assert.ok(args.includes(":(exclude,glob)**/package-lock.json"));
  });

  it("uses --cached for staged changes, even when a base is given", () => {
    assert.equal(buildDiffArgs({ staged: true, base: "main" })[3], "--cached");
  });

  it("uses a three-dot range against the base branch", () => {
    assert.equal(buildDiffArgs({ base: "origin/main" })[3], "origin/main...HEAD");
  });

  it("appends user excludes after the defaults", () => {
    const args = buildDiffArgs({ exclude: ["*.snap"] });
    assert.equal(args[args.length - 1], ":(exclude,glob)**/*.snap");
  });
});

describe("parseDiff", () => {
  it("counts additions and deletions per file and in total", () => {
    const diff = parseDiff(MODIFIED + ADDED);
    assert.equal(diff.files.length, 2);
    assert.deepEqual(diff.files[0], { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false });
    assert.equal(diff.additions, 4);
    assert.equal(diff.deletions, 1);
  });

  it("detects added, deleted, renamed and binary files", () => {
    const [added, deleted, renamed, binary] = parseDiff(ADDED + DELETED + RENAMED + BINARY).files;
    assert.equal(added?.status, "added");
    assert.equal(deleted?.status, "deleted");
    assert.equal(deleted?.path, "old.txt");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.path, "b.ts");
    assert.equal(binary?.binary, true);
  });

  it("does not count +++/--- header lines as changes", () => {
    const [file] = parseDiff(DELETED).files;
    assert.equal(file?.additions, 0);
    assert.equal(file?.deletions, 1);
  });

  it("returns an empty result for an empty diff", () => {
    assert.deepEqual(parseDiff(""), { raw: "", files: [], additions: 0, deletions: 0 });
  });
});

describe("truncateDiff", () => {
  it("leaves small diffs untouched", () => {
    assert.deepEqual(truncateDiff(MODIFIED, 10_000), { text: MODIFIED, truncated: false });
  });

  it("keeps small files whole and trims the large one", () => {
    const huge = `diff --git a/big.ts b/big.ts\n@@ -0,0 +1 @@\n${"+x\n".repeat(5_000)}`;
    const raw = MODIFIED + huge + ADDED;
    const { text, truncated } = truncateDiff(raw, 2_000);

    assert.equal(truncated, true);
    assert.ok(text.includes(MODIFIED), "first small file kept");
    assert.ok(text.includes(ADDED), "last small file kept");
    assert.ok(text.includes("[... diff truncated ...]"));
    assert.ok(text.length < 2_100);
  });

  it("falls back to a plain cut when the text is not a git diff", () => {
    const { text, truncated } = truncateDiff("a".repeat(100), 10);
    assert.equal(truncated, true);
    assert.ok(text.startsWith("a".repeat(10)));
  });
});

describe("splitByFile / summarizeFiles", () => {
  it("splits on diff headers and summarizes each file", () => {
    assert.equal(splitByFile(MODIFIED + BINARY).length, 2);
    assert.equal(
      summarizeFiles(parseDiff(MODIFIED + BINARY)),
      "- src/app.ts (modified, +2 -1)\n- logo.png (modified, binary)",
    );
  });
});

describe("getDiff (real git repository)", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-pr-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads unstaged changes and skips lock files", async () => {
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\nexport const b = 3;\n");
    writeFileSync(join(dir, "package-lock.json"), '{"changed":true}\n');

    const diff = await getDiff({ cwd: dir });
    assert.deepEqual(diff.files.map((f) => f.path), ["app.ts"]);
    assert.equal(diff.additions, 2);
    assert.equal(diff.deletions, 1);
  });

  it("reads only staged changes with staged: true", async () => {
    writeFileSync(join(dir, "new.ts"), "export {};\n");
    git("add", "new.ts");

    const diff = await getDiff({ cwd: dir, staged: true });
    assert.deepEqual(diff.files.map((f) => [f.path, f.status]), [["new.ts", "added"]]);
  });

  it("rejects a directory that is not a git repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      await assert.rejects(getDiff({ cwd: outside }), /Not inside a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
