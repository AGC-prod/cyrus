import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { LinearAgentSessionPromptedWebhook } from "cyrus-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");

/**
 * CYRUS_MERGE_AUTHORIZED on the resume path (CRATE-164 follow-up).
 *
 * The original CRATE-164 fix only set CYRUS_MERGE_AUTHORIZED in the
 * new-session path. A "merge" reply on an issue with an existing session
 * goes through resumeAgentSession, which never set the env var — so the
 * pre-bash-guard.sh merge block could never be bypassed in practice.
 */
describe("EdgeWorker - Merge authorization on resume", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockAgentSessionManager: any;
	let capturedClaudeRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		capturedClaudeRunnerConfig = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "A test issue",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Review" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			workflowStates: vi.fn().mockResolvedValue({
				nodes: [
					{ id: "state-1", name: "Todo", type: "unstarted", position: 0 },
					{ id: "state-2", name: "In Progress", type: "started", position: 1 },
				],
			}),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
			comments: vi.fn().mockResolvedValue({ nodes: [] }),
			rawRequest: vi.fn(),
		};
		vi.mocked(LinearClient).mockImplementation(function () {
			return mockLinearClient;
		});

		// Mock ClaudeRunner to capture config
		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-123" }),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(function (config: any) {
			capturedClaudeRunnerConfig = config;
			return mockClaudeRunner;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				claudeSessionId: "claude-session-123",
				issueId: "issue-123",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspaces/TEST-123" },
				claudeRunner: mockClaudeRunner,
			}),
			addAgentRunner: vi.fn(),
			getAllClaudeRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		// Mock SharedApplicationServer
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		// Mock LinearEventTransport
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		// Mock type guards
		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(false);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(true);

		// Mock readFile to return a default prompt template
		vi.mocked(readFile).mockImplementation(async () => {
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Inject mock issue tracker for the test repository
		const mockIssueTracker = {
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
				return mockLinearClient.issue(issueId);
			}),
			getIssueLabels: vi.fn().mockResolvedValue([]),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(
			mockRepository.linearWorkspaceId,
			mockIssueTracker,
		);

		// Pre-cache the repository for this issue (simulating that a session
		// was already created) — required for prompted webhooks which use
		// getCachedRepository.
		const repositoryRouter = (edgeWorker as any).repositoryRouter;
		repositoryRouter
			.getIssueRepositoryCache()
			.set("issue-123", [mockRepository.id]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function buildPromptedWebhook(
		body: string,
	): LinearAgentSessionPromptedWebhook {
		return {
			type: "Issue",
			action: "agentSessionPrompted",
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					team: { key: "TEST" },
				},
			},
			agentActivity: {
				content: {
					type: "user",
					body,
				},
			},
		} as LinearAgentSessionPromptedWebhook;
	}

	it("sets CYRUS_MERGE_AUTHORIZED when the resume prompt requests a merge", async () => {
		const handleUserPromptedAgentActivity = (
			edgeWorker as any
		).handleUserPromptedAgentActivity.bind(edgeWorker);
		await handleUserPromptedAgentActivity(
			buildPromptedWebhook("Looks good — merge it"),
			[mockRepository],
		);

		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig).toBeDefined();
		expect(capturedClaudeRunnerConfig.additionalEnv).toMatchObject({
			CYRUS_MERGE_AUTHORIZED: "1",
		});
		// The authorization must also be stated in-band: resumed sessions carry
		// stale "never merge" prose in their conversation context and won't
		// check the env var on their own.
		expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith(
			expect.stringContaining("<merge-authorization>"),
		);
	});

	it("does not set CYRUS_MERGE_AUTHORIZED for prompts without a merge request", async () => {
		const handleUserPromptedAgentActivity = (
			edgeWorker as any
		).handleUserPromptedAgentActivity.bind(edgeWorker);
		await handleUserPromptedAgentActivity(
			buildPromptedWebhook("Please fix this bug"),
			[mockRepository],
		);

		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig).toBeDefined();
		expect(
			capturedClaudeRunnerConfig.additionalEnv?.CYRUS_MERGE_AUTHORIZED,
		).toBeUndefined();
		expect(mockClaudeRunner.startStreaming).not.toHaveBeenCalledWith(
			expect.stringContaining("<merge-authorization>"),
		);
	});

	it('does not authorize on the word "merged" (past tense is not a request)', async () => {
		const handleUserPromptedAgentActivity = (
			edgeWorker as any
		).handleUserPromptedAgentActivity.bind(edgeWorker);
		await handleUserPromptedAgentActivity(
			buildPromptedWebhook("FYI the other PR already got merged"),
			[mockRepository],
		);

		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig).toBeDefined();
		expect(
			capturedClaudeRunnerConfig.additionalEnv?.CYRUS_MERGE_AUTHORIZED,
		).toBeUndefined();
	});
});
