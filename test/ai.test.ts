import { strict as assert } from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { AIError, buildMessages, complete, resolveConfig, type AIConfig } from "../src/ai";
import { parseDiff } from "../src/git";

const DIFF = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`);

describe("resolveConfig", () => {
  it("defaults to OpenAI when its key is set", () => {
    const config = resolveConfig({}, { OPENAI_API_KEY: "sk-1" });
    assert.deepEqual(config, {
      provider: "openai",
      apiKey: "sk-1",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("picks OpenRouter when only its key is set", () => {
    const config = resolveConfig({}, { OPENROUTER_API_KEY: "sk-or" });
    assert.equal(config.provider, "openrouter");
    assert.equal(config.model, "openai/gpt-4o-mini");
  });

  it("prefers OpenAI when both keys are set", () => {
    assert.equal(resolveConfig({}, { OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b" }).provider, "openai");
  });

  it("lets flags override env, and env override defaults", () => {
    const env = { OPENAI_API_KEY: "k", AI_PR_MODEL: "env-model", AI_PR_BASE_URL: "http://env/v1/" };
    assert.equal(resolveConfig({}, env).model, "env-model");
    assert.equal(resolveConfig({}, env).baseUrl, "http://env/v1");
    assert.equal(resolveConfig({ model: "flag-model" }, env).model, "flag-model");
  });

  it("fails on an unknown provider or a missing key", () => {
    assert.throws(() => resolveConfig({ provider: "claude" }, {}), /Unknown provider/);
    assert.throws(() => resolveConfig({ provider: "openrouter" }, { OPENAI_API_KEY: "x" }), /OPENROUTER_API_KEY/);
    assert.throws(() => resolveConfig({}, {}), AIError);
  });
});

describe("buildMessages", () => {
  it("includes branch, commits, file list and diff", () => {
    const [system, user] = buildMessages(DIFF, { branch: "feat/x", commits: ["Add a", "Fix b"], language: "Portuguese" });
    assert.match(system!.content, /Write the description in Portuguese\.$/);
    assert.match(user!.content, /Branch: feat\/x/);
    assert.match(user!.content, /- Add a\n- Fix b/);
    assert.match(user!.content, /Files changed \(1 files, \+1 -1\)/);
    assert.match(user!.content, /```diff\n/);
    assert.doesNotMatch(user!.content, /truncated to fit/);
  });

  it("warns the model when the diff was truncated", () => {
    const [, user] = buildMessages(DIFF, { maxChars: 10 });
    assert.match(user!.content, /truncated to fit/);
  });
});

describe("complete", () => {
  const config: AIConfig = { provider: "openrouter", apiKey: "k", model: "m", baseUrl: "http://llm.test/v1" };
  const reply = (status: number, body: unknown) =>
    mock.method(globalThis, "fetch", async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

  afterEach(() => mock.restoreAll());

  it("posts to /chat/completions and returns the trimmed content", async () => {
    const fetchMock = reply(200, { choices: [{ message: { content: "  # Title\n" } }] });
    assert.equal(await complete(config, [{ role: "user", content: "hi" }]), "# Title");

    const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.equal(url, "http://llm.test/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer k");
    assert.equal(headers["X-Title"], "ai-pr-cli");
    assert.equal(JSON.parse(String(init.body)).model, "m");
  });

  it("surfaces the API error message on non-2xx responses", async () => {
    reply(401, { error: { message: "Invalid API key" } });
    await assert.rejects(complete(config, []), /openrouter API returned 401: Invalid API key/);
  });

  it("treats a 200 without content as an error (OpenRouter style)", async () => {
    reply(200, { error: "model overloaded" });
    await assert.rejects(complete(config, []), /empty response: model overloaded/);
  });

  it("handles non-JSON error bodies", async () => {
    reply(502, "Bad Gateway");
    await assert.rejects(complete(config, []), /returned 502: Bad Gateway/);
  });
});
