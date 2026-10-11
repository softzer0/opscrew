/** Code-change: the adapt phase (deterministic files, Code-change agent, commit, push, PR). */
export {
  PLAYBOOKS,
  type Playbook,
  type PlaybookId,
  playbookFor,
  playbookInstructions,
} from "./playbooks";
export {
  PULL_REQUEST_FOOTER,
  PULL_REQUEST_TITLE,
  type PullRequestBodyInput,
  renderPullRequestBody,
} from "./pr";
export {
  buildCodeChangePrompt,
  CODE_CHANGE_MODEL,
  CODE_CHANGE_SYSTEM_PROMPT,
  type CodeChangePromptInput,
  type CodeChangeReport,
  CodeChangeReportSchema,
  manualInstructions,
} from "./prompts";
export {
  ADAPT_BRANCH,
  ADAPT_COMMIT_SUBJECT,
  type AdaptGitHub,
  type AdaptResult,
  type ManualChange,
  type RunAdaptOptions,
  runAdapt,
} from "./run";
