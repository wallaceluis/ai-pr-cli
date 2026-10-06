# ai-pr-cli

Generate Pull Request descriptions straight from your `git diff`, using OpenAI or OpenRouter.

`ai-pr` reads the changes in your repository, sends them to an LLM and prints a ready-to-paste Markdown description with a title, summary, list of changes, test steps and notes.

```console
$ ai-pr --base main
Found 4 changed file(s) (+182 -37).
Generating description with openai (gpt-4o-mini)...
# Add retry with backoff to the payment webhook handler

## Summary
...
```

## Features

- **Three diff modes**: uncommitted changes, staged changes only, or everything your branch adds on top of a base ref.
- **OpenAI and OpenRouter** out of the box, plus any OpenAI-compatible endpoint through `--base-url`.
- **Noise filtering**: lock files, minified assets and source maps are left out of the prompt; add your own globs with `--exclude`.
- **Fair truncation**: large diffs are trimmed per file, so one huge file cannot push the others out of the context window.
- **Pipe friendly**: the description goes to `stdout`, progress and errors go to `stderr`.
- **No SDK dependency**: uses the native `fetch` of Node.js 18+. The only runtime dependency is `commander`.

## Requirements

- Node.js 18 or newer
- git
- An API key from [OpenAI](https://platform.openai.com/api-keys) or [OpenRouter](https://openrouter.ai/keys)

## Installation

```bash
git clone https://github.com/wallaceluis/ai-pr-cli.git
cd ai-pr-cli
npm install
npm run build
npm link
```

`npm link` makes the `ai-pr` command available globally. To run it without linking, use `node dist/cli.js`.

## Configuration

Export the key of the provider you want to use:

```bash
export OPENAI_API_KEY="sk-..."
# or
export OPENROUTER_API_KEY="sk-or-..."
```

| Variable             | Description                                         |
| -------------------- | --------------------------------------------------- |
| `OPENAI_API_KEY`     | API key for OpenAI                                  |
| `OPENROUTER_API_KEY` | API key for OpenRouter                              |
| `AI_PR_MODEL`        | Default model (overridden by `--model`)             |
| `AI_PR_BASE_URL`     | Default API base URL (overridden by `--base-url`)   |

When `--provider` is not passed, the provider is picked from whichever key is set. If both are set, OpenAI wins.

## Usage

```bash
# Describe uncommitted changes (staged + unstaged)
ai-pr

# Describe staged changes only
ai-pr --staged

# Describe everything the current branch adds on top of main
ai-pr --base main

# Use OpenRouter with a specific model, answer in Portuguese
ai-pr --base main --provider openrouter --model anthropic/claude-sonnet-4.5 --lang Portuguese

# Save to a file
ai-pr --base main --output PR.md

# Open the PR with the GitHub CLI
ai-pr --base main | gh pr create --title "My change" --body-file -

# Inspect the prompt without spending tokens
ai-pr --base main --dry-run
```

### Options

| Option                  | Description                                                    | Default            |
| ----------------------- | -------------------------------------------------------------- | ------------------ |
| `-b, --base <ref>`      | Compare the current branch against this ref (`<ref>...HEAD`)   | —                  |
| `-s, --staged`          | Use only staged changes                                        | `false`            |
| `-p, --provider <name>` | `openai` or `openrouter`                                       | detected from env  |
| `-m, --model <id>`      | Model to use                                                   | `gpt-4o-mini`      |
| `--base-url <url>`      | Any OpenAI-compatible API base URL                             | provider default   |
| `-l, --lang <language>` | Language of the generated description                          | `English`          |
| `--max-chars <n>`       | Maximum diff characters sent to the model                      | `24000`            |
| `-x, --exclude <glob>`  | Exclude files matching this glob (repeatable)                  | —                  |
| `-o, --output <file>`   | Write the description to a file instead of stdout              | —                  |
| `--dry-run`             | Print the prompt without calling the API                       | `false`            |
| `-V, --version`         | Print the version                                              |                    |
| `-h, --help`            | Show help                                                      |                    |

Without `--base` or `--staged`, the diff is taken against `HEAD`. Untracked files are not part of `git diff`: run `git add` first if you want new files included.

## How it works

```
git diff ──► parse + filter + truncate ──► prompt ──► chat/completions ──► Markdown
 git.ts               git.ts                ai.ts          ai.ts            cli.ts
```

| File         | Responsibility                                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| `src/git.ts` | Runs `git diff`, parses per-file stats, truncates large diffs                  |
| `src/ai.ts`  | Resolves the provider config, builds the prompt, calls the API                 |
| `src/cli.ts` | Command-line interface built with `commander`                                  |

With `--base`, the commit subjects of the branch are added to the prompt as extra context.

## Privacy

Your diff is sent to the provider you choose. Review what you are about to send with `--dry-run`, and use `--exclude` to keep files out of the prompt.

## Development

```bash
npm run dev        # compile in watch mode
npm run typecheck  # type-check without emitting
npm run build      # compile to dist/
```

## License

[MIT](LICENSE)
