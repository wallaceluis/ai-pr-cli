#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { AIError, DEFAULT_MAX_CHARS, buildMessages, generatePRDescription, resolveConfig } from "./ai";
import { GitError, getCommitSubjects, getCurrentBranch, getDiff } from "./git";

interface CliOptions {
  base?: string;
  staged?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  lang: string;
  maxChars: number;
  exclude: string[];
  output?: string;
  dryRun?: boolean;
}

const { version } = require("../package.json") as { version: string };

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// Progress goes to stderr so stdout stays pipeable (e.g. `ai-pr | gh pr create -F -`).
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function run(options: CliOptions): Promise<void> {
  const diff = await getDiff({ base: options.base, staged: options.staged, exclude: options.exclude });
  if (diff.files.length === 0) {
    log("No changes found. Stage or commit something, or pass --base <branch>.");
    process.exitCode = 1;
    return;
  }

  const useBase = Boolean(options.base) && !options.staged;
  const [branch, commits] = await Promise.all([
    getCurrentBranch().catch(() => undefined),
    useBase ? getCommitSubjects(options.base as string).catch(() => []) : [],
  ]);
  const promptOptions = { language: options.lang, maxChars: options.maxChars, branch, commits };

  log(`Found ${diff.files.length} changed file(s) (+${diff.additions} -${diff.deletions}).`);

  if (options.dryRun) {
    for (const message of buildMessages(diff, promptOptions)) {
      process.stdout.write(`--- ${message.role} ---\n${message.content}\n\n`);
    }
    return;
  }

  const config = resolveConfig({ provider: options.provider, model: options.model, baseUrl: options.baseUrl });
  log(`Generating description with ${config.provider} (${config.model})...`);
  const description = await generatePRDescription(diff, config, promptOptions);

  if (options.output) {
    await writeFile(options.output, `${description}\n`, "utf8");
    log(`Saved to ${options.output}`);
  } else {
    process.stdout.write(`${description}\n`);
  }
}

const program = new Command()
  .name("ai-pr")
  .description("Generate a Pull Request description from your git diff using OpenAI or OpenRouter.")
  .version(version)
  .option("-b, --base <ref>", "compare the current branch against this ref (e.g. main)")
  .option("-s, --staged", "use only staged changes")
  .option("-p, --provider <name>", "AI provider: openai or openrouter (default: detected from env)")
  .option("-m, --model <id>", "model to use (default: gpt-4o-mini)")
  .option("--base-url <url>", "override the API base URL (any OpenAI-compatible endpoint)")
  .option("-l, --lang <language>", "language of the generated description", "English")
  .option("--max-chars <n>", "max diff characters sent to the model", parsePositiveInt, DEFAULT_MAX_CHARS)
  .option("-x, --exclude <glob>", "exclude files matching this glob (repeatable)", collect, [])
  .option("-o, --output <file>", "write the description to a file instead of stdout")
  .option("--dry-run", "print the prompt without calling the API")
  .addHelpText(
    "after",
    `
Examples:
  $ ai-pr                          describe uncommitted changes
  $ ai-pr --staged                 describe staged changes only
  $ ai-pr --base main              describe everything this branch adds on top of main
  $ ai-pr -b main -l "Portuguese"  write the description in Portuguese
  $ ai-pr -b main | gh pr create --title "My PR" -F -

Environment:
  OPENAI_API_KEY       API key for OpenAI
  OPENROUTER_API_KEY   API key for OpenRouter
  AI_PR_MODEL          default model
  AI_PR_BASE_URL       default API base URL`,
  )
  .action(run);

program.parseAsync().catch((error: unknown) => {
  if (error instanceof GitError || error instanceof AIError) {
    log(`error: ${error.message}`);
  } else {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
