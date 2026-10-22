// How each CLI is run as a processor: once, non-interactively, with no
// usable tools, writing nothing and keeping no record. The input is
// untrusted, so every flag here is needed; they are exactly the ones
// verified on 2026-10-05 (docs/reference/cli-version-alignment.md). The prompt goes on stdin, never in argv.

// Codex CLI 0.160.0's features to turn off. Codex exits 1 on a name it
// doesn't know, so a new version has to be checked again
// (docs/reference/cli-version-alignment.md).
export const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'image_generation', 'multi_agent', 'goals', 'hooks', 'browser_use',
  'browser_use_external', 'computer_use', 'view_image', 'sleep_tool', 'code_mode_host', 'tool_suggest', 'skill_search',
  'in_app_browser', 'remote_plugin', 'shell_snapshot', 'realtime_conversation', 'skill_mcp_dependency_install',
  'workspace_dependencies', 'tool_call_mcp_elicitation', 'auth_elicitation',
] as const;

/**
 * `codex exec` for one run: no tools but the fail-closed ones gpt-6-luna
 * insists on (exec, wait; request_user_input can't be used in exec mode),
 * no user config, rules, MCP, hooks or plugins, a read-only sandbox, no
 * rollout or history (--ephemeral), the answer held to the schema.
 */
export function codexExecArgs(options: { model: string; effort: string | null; runnerDir: string; schemaFile: string; outputFile: string }): string[] {
  return [
    'exec', '-m', options.model,
    ...(options.effort ? ['-c', `model_reasoning_effort=${options.effort}`] : []),
    '-c', 'web_search="disabled"', '-c', 'agents.enabled=false',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check',
    '-C', options.runnerDir, '--output-schema', options.schemaFile, '-o', options.outputFile, '-',
  ];
}

/**
 * `claude -p` for one run: an empty tool list, no transcript, and
 * --safe-mode --strict-mcp-config, without which the user's own hooks still
 * run (a SessionEnd hook did, on 2026-10-05).
 */
export function claudePrintArgs(options: { model: string; schema: string }): string[] {
  return [
    '-p', '--model', options.model, '--no-session-persistence', '--tools', '', '--safe-mode', '--strict-mcp-config',
    '--output-format', 'json', '--json-schema', options.schema,
  ];
}
