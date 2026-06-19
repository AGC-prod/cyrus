/**
 * Shared session environment and MCP config utilities.
 *
 * These helpers DRY up logic that was previously duplicated between
 * ClaudeRunner (query options) and EdgeWorker (warmup / startup).
 */

/**
 * Auth-related env vars forwarded from the parent process.
 * The SDK subprocess needs these for API calls.
 */
const AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Cyrus-specific env vars injected into every Claude Code subprocess.
 * Both `ClaudeRunner.start()` and `EdgeWorker.warmupRecentSessions()`
 * must use the same set — keep this as the single source of truth.
 *
 * Note: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not included
 * while the Linux bubblewrap sandbox side effects it triggers are being
 * investigated. See CYPACK-1108.
 *
 * - MCP_CONNECTION_NONBLOCKING lets MCP servers connect in the background so
 *   both cold-start and pre-warm sessions return faster.
 */
export const CYRUS_SESSION_ENV = {
	CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
	CLAUDE_CODE_ENABLE_TASKS: "true",
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
	CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
	MCP_CONNECTION_NONBLOCKING: "true",
} as const;

/**
 * Context auto-compaction defaults.
 *
 * Long iterative sessions — especially resumed ones, which replay the entire
 * prior transcript every turn — accumulate stale context (old file reads, tool
 * output, finished sub-tasks) and degrade in both quality and latency well
 * before the model's hard context limit. On the default 1M window the CLI's
 * ~95% auto-compaction trigger fires near ~950k, which real Cyrus sessions
 * never reach (observed peak ~46% of 1M / ~464k), so the transcript grows
 * unbounded and the model "bogs down."
 *
 * We pin the effective window to 200k and compact at 80% (~160k) so each
 * session periodically sheds stale context down to a summary plus recent turns.
 * The CLI persists the compaction into the transcript and splices the preserved
 * segment back on resume, so the win carries across Cyrus's resume-per-comment
 * pattern — not just within a single turn.
 *
 * Applied as DEFAULTS (see buildBaseSessionEnv): an operator can override either
 * knob via the launchd plist / .env (process.env) without a rebuild — e.g. set
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75 for a wider safety margin on long
 * multi-file issues, or CLAUDE_CODE_DISABLE_1M_CONTEXT=0 to restore the 1M
 * window for a specific run.
 *
 * Both knobs are read by the bundled Claude Code CLI subprocess.
 */
export const CONTEXT_COMPACTION_ENV_DEFAULTS = {
	// Pin the effective context window to 200k (disable the 1M window).
	CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
	// Trigger auto-compaction at 80% of the window (~160k tokens).
	CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
} as const;

/**
 * Build the base `env` object for a Claude SDK session.
 *
 * Overlays the full parent `process.env` so HOME (and other inherited vars) are
 * available to tools that depend on them — GPG-signed commits, `gh` CLI auth,
 * etc. claude-agent-sdk v0.2.113 reverted to no longer overlaying process.env
 * itself, so we must do it here. Then applies the shared Cyrus session flags
 * on top. Callers can spread additional vars on top (e.g., repository .env
 * for live runs).
 */
export function buildBaseSessionEnv(
	extra?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
	};

	// Forward PATH
	if (process.env.PATH) {
		env.PATH = process.env.PATH;
	}

	// Forward auth credentials from the parent process — the SDK needs these
	// for API calls. See: https://code.claude.com/docs/en/env-vars
	for (const key of AUTH_ENV_KEYS) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}

	// Apply context-compaction knobs as defaults: only set them when the
	// operator hasn't already provided a value (env is seeded from process.env
	// above), so the launchd plist / .env can override without a rebuild.
	for (const [key, value] of Object.entries(CONTEXT_COMPACTION_ENV_DEFAULTS)) {
		if (env[key] === undefined || env[key] === "") {
			env[key] = value;
		}
	}

	return {
		...env,
		...CYRUS_SESSION_ENV,
		...extra,
	};
}

/**
 * Normalize MCP server configs loaded from JSON files.
 *
 * Config files (.mcp.json, mcp-*.json) often omit the `type` field,
 * but the SDK requires an explicit discriminator for non-stdio transports.
 * If a config has a `url` but no `type`, set `type = "http"`.
 *
 * Mutates the input records in place.
 */
export function normalizeMcpHttpTransport(
	servers: Record<string, Record<string, unknown>>,
): void {
	for (const cfg of Object.values(servers)) {
		if (!cfg.type && typeof cfg.url === "string") {
			cfg.type = "http";
		}
	}
}
