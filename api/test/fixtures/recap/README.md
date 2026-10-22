# Recap runner captures

What `codex exec` and `claude -p` printed when run the way the recap runner
runs them (`api/src/recap/runner.ts`), read by `test/recap/runner.test.ts`
through `classifyCodexRun` / `classifyClaudeRun`. From the 2026-10-05
validation run of the real CLIs;
the scratch folder's path is shortened to `/state/recap-runner-validation`.

File name: `<cli>.<what>.<version>.<stream>`. When a CLI version changes
what it prints, add its capture here, fix the classifier, then update
`docs/reference/cli-version-alignment.md`.

| File | Source |
|---|---|
| `codex.output.0.160.0.json` | Codex CLI 0.160.0, the final command (C8): the `-o` file, the answer itself with a space before its last brace |
| `codex.ok.0.160.0.stderr` | The plain command (C1): stderr of a successful run — header, prompt, answer, `tokens used` |
| `codex.model-not-supported.0.160.0.stderr` | `-m gpt-no-such-model` (C9), exit 1, no `-o` file |
| `codex.invalid-schema.0.160.0.stderr` | A schema that isn't strict (C9), exit 1 |
| `claude.result.2.1.289.json` | Claude Code 2.1.289 with `--safe-mode --strict-mcp-config` (L2): stdout, `structured_output` holds the answer |
| `claude.unrecognized-model.2.1.289.json` / `.stderr` | `--model no-such-model` (L4), exit 1: `is_error: true` with `subtype: "success"` |
| `claude.loose-schema.2.1.289.json` | A schema with one optional field (L4): Claude doesn't hold the model to it |
