import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Files that add a lot of noise to the prompt and almost no signal. */
export const DEFAULT_EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "composer.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
];

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ParsedDiff {
  raw: string;
  files: FileChange[];
  additions: number;
  deletions: number;
}

export interface DiffOptions {
  /** Compare the current branch against this ref (uses `<base>...HEAD`). */
  base?: string;
  /** Only look at staged changes. */
  staged?: boolean;
  /** Extra glob patterns to leave out of the diff. */
  exclude?: string[];
  cwd?: string;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new GitError("git was not found in PATH.");
    }
    const detail = err.stderr?.trim() || err.message;
    throw new GitError(`git ${args[0]} failed: ${detail}`);
  }
}

export async function assertGitRepo(cwd?: string): Promise<void> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    throw new GitError("Not inside a git repository.");
  }
}

export function buildDiffArgs(options: DiffOptions = {}): string[] {
  const args = ["diff", "--no-color", "--no-ext-diff"];

  if (options.staged) {
    args.push("--cached");
  } else if (options.base) {
    args.push(`${options.base}...HEAD`);
  } else {
    // Staged + unstaged changes against the last commit.
    args.push("HEAD");
  }

  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  args.push("--", ".", ...excludes.map((glob) => `:(exclude,glob)**/${glob}`));
  return args;
}

/** Runs `git diff` and returns the parsed result. */
export async function getDiff(options: DiffOptions = {}): Promise<ParsedDiff> {
  await assertGitRepo(options.cwd);
  const raw = await git(buildDiffArgs(options), options.cwd);
  return parseDiff(raw);
}

/** Subjects of the commits that are on HEAD but not on `base`, oldest first. */
export async function getCommitSubjects(base: string, cwd?: string): Promise<string[]> {
  const out = await git(["log", "--reverse", "--pretty=format:%s", `${base}..HEAD`], cwd);
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

/** Splits a raw diff into one chunk per file. */
export function splitByFile(raw: string): string[] {
  return raw.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
}

function parseFile(chunk: string): FileChange {
  const lines = chunk.split("\n");
  const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");

  const file: FileChange = {
    path: header?.[2] ?? "unknown",
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
  };

  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) file.additions++;
      else if (line.startsWith("-")) file.deletions++;
      continue;
    }

    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else if (line.startsWith("+++ b/")) {
      file.path = line.slice("+++ b/".length);
    } else if (line.startsWith("--- a/") && file.status === "deleted") {
      file.path = line.slice("--- a/".length);
    }
  }

  return file;
}

export function parseDiff(raw: string): ParsedDiff {
  const files = splitByFile(raw).map(parseFile);
  return {
    raw,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

const TRUNCATION_MARKER = "\n[... diff truncated ...]\n";

/**
 * Keeps the diff under `maxChars` by giving every file an equal share of the
 * budget, so one huge file cannot push the others out of the prompt.
 */
export function truncateDiff(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) return { text: raw, truncated: false };

  const chunks = splitByFile(raw);
  if (chunks.length === 0) {
    return { text: raw.slice(0, maxChars) + TRUNCATION_MARKER, truncated: true };
  }

  // Small files do not use their whole share; hand the leftover to the rest.
  let remaining = maxChars;
  let pending = chunks.length;
  const budgets = new Map<number, number>();
  const bySize = chunks.map((chunk, index) => ({ index, size: chunk.length })).sort((a, b) => a.size - b.size);
  for (const { index, size } of bySize) {
    const share = Math.floor(remaining / pending);
    const budget = Math.min(size, share);
    budgets.set(index, budget);
    remaining -= budget;
    pending--;
  }

  const text = chunks
    .map((chunk, index) => {
      const budget = budgets.get(index) ?? 0;
      return chunk.length <= budget ? chunk : chunk.slice(0, budget) + TRUNCATION_MARKER;
    })
    .join("");

  return { text, truncated: true };
}

export function summarizeFiles(diff: ParsedDiff): string {
  return diff.files
    .map((file) => {
      const stats = file.binary ? "binary" : `+${file.additions} -${file.deletions}`;
      return `- ${file.path} (${file.status}, ${stats})`;
    })
    .join("\n");
}
