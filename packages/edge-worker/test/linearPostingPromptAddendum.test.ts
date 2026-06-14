import { describe, expect, it } from "vitest";
import {
	appendLinearPostingAddendum,
	LINEAR_POSTING_PROMPT_ADDENDUM,
} from "../src/prompts/linearPostingPromptAddendum.js";

describe("linear-posting prompt addendum", () => {
	it("steers to the native comment tool and away from the hosted one", () => {
		expect(LINEAR_POSTING_PROMPT_ADDENDUM).toContain(
			"mcp__cyrus-tools__linear_post_comment",
		);
		expect(LINEAR_POSTING_PROMPT_ADDENDUM).toContain(
			"mcp__linear__save_comment",
		);
		expect(LINEAR_POSTING_PROMPT_ADDENDUM).toMatch(
			/requires re-authorization/i,
		);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendLinearPostingAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(LINEAR_POSTING_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendLinearPostingAddendum(undefined)).toBe(
			LINEAR_POSTING_PROMPT_ADDENDUM,
		);
		expect(appendLinearPostingAddendum(null)).toBe(
			LINEAR_POSTING_PROMPT_ADDENDUM,
		);
		expect(appendLinearPostingAddendum("")).toBe(
			LINEAR_POSTING_PROMPT_ADDENDUM,
		);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendLinearPostingAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${LINEAR_POSTING_PROMPT_ADDENDUM}`);
	});
});
