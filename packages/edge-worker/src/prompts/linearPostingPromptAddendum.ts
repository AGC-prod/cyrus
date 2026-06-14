/**
 * Single source of truth for the Linear comment-posting guidance appended to
 * every customer-facing system prompt.
 *
 * Why this lives in the SYSTEM PROMPT (not the per-repo `appendInstruction`):
 * `appendInstruction` only reaches a session's FIRST prompt, so resumed turns
 * never see it — and resumed/long-lived sessions are exactly the ones whose
 * hosted Linear MCP token rotates and starts failing `save_comment` with
 * `requires re-authorization` (see CRATE-254, and [[cyrus-linear-token-refresh]]).
 * A system-prompt addendum is structurally present on every turn, including
 * resumes, so the steer survives where it's needed most.
 *
 * Covered entrypoints mirror `applyFailureModeAddendum` (Linear issue sessions,
 * Slack chat, GitHub PR chat) — every surface that has the hosted `linear` MCP
 * alongside `cyrus-tools`.
 */
export const LINEAR_POSTING_PROMPT_ADDENDUM = `
<linear_comment_posting>
To post a comment on a Linear issue — plans, briefs, wrap-ups, escalations, any top-level deliverable — use the MCP tool \`mcp__cyrus-tools__linear_post_comment\` (fields: \`issueId\`, \`body\`, and optional \`parentId\` for a reply; omit \`parentId\` for a top-level comment).

Do NOT use the hosted \`mcp__linear__save_comment\` for this. On long or resumed sessions the hosted Linear connection's token can rotate mid-session, after which that tool fails with \`requires re-authorization\`. \`mcp__cyrus-tools__linear_post_comment\` goes through Cyrus's own auto-refreshing Linear client and is unaffected — the same reason you prefer \`mcp__cyrus-tools__linear_update_issue_status\` over the hosted \`save_issue\` for status changes.
</linear_comment_posting>
`.trim();

/**
 * Append the Linear-posting addendum to a system prompt fragment, normalizing
 * spacing so the boundary doesn't collide with prior content.
 */
export function appendLinearPostingAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return LINEAR_POSTING_PROMPT_ADDENDUM;
	return `${base}\n\n${LINEAR_POSTING_PROMPT_ADDENDUM}`;
}
