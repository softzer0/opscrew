import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  answeredKinds,
  buildComponentQuestions,
  buildPortainerQuestions,
  buildQuestions,
  buildServerQuestions,
  CHECK_PORTAINER_CERTIFICATE,
  type ConfirmPortainerCertificate,
  createPortainerAccess,
  hostedAdditions,
  inferredAnswers,
  NEW_CERTIFICATE_WARNING,
  PORTAINER_FIELDS,
  type PortainerAccess,
  PortainerCertificateError,
  type PortainerInterviewOptions,
  providerFromTokens,
  providerProfile,
  readServerAddresses,
  repositoryPrivate,
  requestedProvider,
  runInterview,
  SERVER_FIELDS,
  storageAnswerText,
  withPlanSettings,
} from "@opscrew/agents";
import { isUserFacingError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { detectProject, detectProjectDetails } from "@opscrew/detect";
import {
  type ProjectFacts,
  type Question,
  QuestionIdSchema,
  type Requirements,
  readArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, clientSupportsElicitation, elicitOptions } from "./elicitation";
import { projectDirInput, runTool, withHint } from "./shared";

/** Facts from `opscrew/architecture.json` when it is valid, otherwise fresh detection. */
async function loadFacts(
  paths: ProjectPaths,
): Promise<{ facts: ProjectFacts; source: "architecture" | "detected" }> {
  try {
    return {
      facts: (await readArtifact("architecture", paths.files.architecture)).facts,
      source: "architecture",
    };
  } catch {
    return { facts: await detectProject(paths.root), source: "detected" };
  }
}

/**
 * Previous requirements when `opscrew/requirements.yaml` exists and is valid, with signing and
 * deploy tags as `opscrew/plan.yaml` sets them (as `opscrew interview` reads them).
 */
async function loadPrevious(paths: ProjectPaths): Promise<Requirements | undefined> {
  try {
    return await withPlanSettings(
      paths,
      await readArtifact("requirements", paths.files.requirements),
    );
  } catch {
    return undefined;
  }
}

/** The kinds the requirements answer `keep` for, as one comma-separated entry, or none. */
function answered(requirements: Requirements, keep: boolean): string[] {
  const kinds = answeredKinds(requirements, keep);
  return kinds.length > 0 ? [kinds.join(", ")] : [];
}

function formatDefault(value: Question["default"]): string {
  if (value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value))
    return `${value.amount} ${value.currency}`;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** A question to render: an interview question or a follow-up about the user's own server. */
type ShownQuestion = Omit<Question, "id"> & { id: string };

/** One question as plain text: prompt, help, choices and default. */
function renderQuestion(question: ShownQuestion, index: number): string {
  const lines = [`${index + 1}. ${question.prompt} (answer id: ${question.id})`];
  if (question.help) lines.push(`   ${question.help}`);
  if (question.options && question.options.length > 0) {
    lines.push(
      `   Choices: ${question.options.map((o) => `${o.value} = ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("; ")}`,
    );
  }
  if (question.default !== undefined) lines.push(`   Default: ${formatDefault(question.default)}`);
  if (!question.required) lines.push("   Optional.");
  return lines.join("\n");
}

/** Loose value schema for one answer; `answersToRequirements` does the real validation. */
const AnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.object({ amount: z.union([z.number(), z.string()]), currency: z.string().optional() }),
  z.null(),
]);

const ANSWER_HELP: Record<string, string> = {
  provider:
    'Where the app runs: "hetzner" (Hetzner Cloud), "digitalocean" (DigitalOcean), "own" (a server the user already has; then also answer the server.* questions) or "portainer" (a Portainer the user already runs; then also answer the portainer.* questions).',
  expectedMonthlyUsers: "One of <1k, 1k-10k, 10k-100k, >100k.",
  budgetMonthly:
    'Monthly hosting budget, for example "10 EUR", "$20" or { amount: 10, currency: "EUR" }.',
  region: "Where most users are, for example eu-central.",
  uptime: "Acceptable downtime (a choice value from the question).",
  dataCriticality: "How bad losing data would be (a choice value from the question).",
  domain: "Domain name, for example app.example.com.",
  dnsProvider: "DNS provider (a choice value from the question).",
  keepExternalServices:
    "Not answered as one value: answer each hosted service of componentQuestions as keepExternalServices.<kind>, true to keep it where it is hosted, false to let OpsCrew run one on the server. An unanswered hosted service is kept. keepExternalServices.s3: false lets OpsCrew create a bucket for the app's files; true or no answer keeps the storage the app uses now, and no bucket is planned.",
  objectStorage:
    'Where OpsCrew creates the bucket when keepExternalServices.s3 is false: one of the choices of the objectStorage component question ("garage", "hetzner", "digitalocean" or "r2", as offered where the app runs). Without it, design picks the cheapest offer, but never Garage on a cloud server.',
  workerCommands:
    "Not answered as one value: give each worker's command as workerCommands.<worker>, as componentQuestions lists them.",
  contactEmail: "Contact email for certificates and alerts.",
  notes: "Anything else the user wants to note.",
  signImages:
    "true to sign each image with keyless cosign (default false). Pass on the question's help first: for a private repository its name and workflow path appear in Sigstore's public log.",
  deployTags: 'Tag each healthy deploy: "off" (default), "tag" or "tag-and-release".',
};

/** The follow-ups for a server the user already has (`provider: own`); never a password. */
const SERVER_ANSWER_HELP: Record<string, string> = {
  "server.host":
    "Own server: its IP address or host name. Kept on the user's computer only; leave it out to keep the saved one.",
  "server.port":
    "Own server: the SSH port this computer and GitHub Actions connect to, usually 22 (the forwarded port when a router forwards one to the server).",
  "server.user": "Own server: the SSH user, root or a user with passwordless sudo.",
  "server.key":
    'Own server: the path to the private key file (for example ~/.ssh/id_ed25519), or "agent" for the SSH agent. Never the key itself, a password or a passphrase.',
  "server.reachable":
    "Own server: true when the internet reaches it directly; false for a home server behind a router (then a Cloudflare Tunnel on the user's Cloudflare domain).",
};

/** The follow-ups for an existing Portainer (`provider: portainer`); never a token or password. */
const PORTAINER_ANSWER_HELP: Record<string, string> = {
  "portainer.url":
    "Existing Portainer: its HTTPS address, for example https://nas.local:9443 (plain http:// only for a Portainer on this computer). Kept on the user's computer only; leave it out to keep the saved one.",
  "portainer.environment":
    "Existing Portainer: the Docker environment to deploy to, by its name or id as Portainer lists it (OpsCrew names the environments it found when this is missing or wrong).",
  "portainer.redeploy":
    'Existing Portainer: how new versions reach it, "updater" (default: a small updater stack asks Portainer once a minute) or "cloudflare" (GitHub Actions calls Portainer through Cloudflare Access).',
  "portainer.web":
    'Existing Portainer: how visitors reach the app, "tunnel" (a Cloudflare Tunnel), "proxy" (the user\'s own reverse proxy on a host port) or "caddy" (Caddy on ports 80 and 443).',
  "portainer.port": "Existing Portainer with web 'proxy': the host port the app listens on.",
};

const answersShape = {
  ...Object.fromEntries(
    QuestionIdSchema.options.map((id) => [
      id,
      AnswerValueSchema.optional().describe(ANSWER_HELP[id] ?? `Answer for ${id}.`),
    ]),
  ),
  ...Object.fromEntries(
    // Every follow-up the agents ask (SERVER_FIELDS), described where this file knows it.
    SERVER_FIELDS.map((field) => `server.${field}`).map((id) => [
      id,
      AnswerValueSchema.optional().describe(
        SERVER_ANSWER_HELP[id] ??
          "Own server: the answer to this question from opscrew_interview_questions.",
      ),
    ]),
  ),
  ...Object.fromEntries(
    PORTAINER_FIELDS.map((field) => `portainer.${field}`).map((id) => [
      id,
      AnswerValueSchema.optional().describe(
        PORTAINER_ANSWER_HELP[id] ??
          "Existing Portainer: the answer to this question from opscrew_interview_questions.",
      ),
    ]),
  ),
};

/** Test-only collaborators for the interview tools (production uses the Portainer adapter). */
export interface InterviewToolOptions {
  /** How the interview reads Portainer's certificate and lists its environments. */
  portainerAccess?: PortainerAccess;
}

const CertificateAnswer = z.object({ trust: z.boolean().optional() });

/**
 * Asks the user (never the model) in a dialog (MCP elicitation) to trust Portainer's certificate:
 * shows its fingerprint (and the one pinned before, when it changed) and how to check it. Only an
 * explicit "trust" in the dialog trusts it; declines, cancels and client errors trust nothing.
 */
function certificateDialog(
  server: McpServer,
  deps: Pick<ResolvedMcpDeps, "redactor">,
  extra: CallExtra,
): ConfirmPortainerCertificate {
  return async ({ fingerprint, previous }) => {
    const message = [
      previous === undefined
        ? "OpsCrew connects to the user's Portainer for the first time. Before it sends the access token, the user must trust Portainer's certificate. Its SHA-256 fingerprint is:"
        : `The user's Portainer now presents a different certificate. OpsCrew pinned ${previous} before; it now presents:`,
      "",
      `    ${fingerprint}`,
      "",
      CHECK_PORTAINER_CERTIFICATE,
      ...(previous === undefined ? [] : [NEW_CERTIFICATE_WARNING]),
      "Your coding agent cannot confirm this for you.",
    ].join("\n");
    try {
      const result = await server.server.elicitInput(
        {
          mode: "form",
          message: deps.redactor.redact(message),
          requestedSchema: {
            type: "object",
            properties: {
              trust: {
                type: "boolean",
                title: "Trust this certificate",
                description: `Portainer's certificate ${fingerprint}`,
                default: false,
              },
            },
            required: ["trust"],
          },
        },
        elicitOptions(extra),
      );
      if (result.action !== "accept") return false;
      const answer = CertificateAnswer.safeParse(result.content ?? {});
      return answer.success && answer.data.trust === true;
    } catch {
      return false;
    }
  };
}

const CERTIFICATE_IN_TERMINAL =
  "Ask the user to run `npx opscrew interview` in a terminal in the project directory: it shows Portainer's certificate fingerprint to check and pins it. Then call this tool again (the saved answers are pre-filled). Never pass a fingerprint yourself.";

/** The next step after the interview stopped at Portainer's certificate, in a tool call. */
const CERTIFICATE_HINTS: Readonly<Record<PortainerCertificateError["reason"], string>> = {
  unconfirmed: `This MCP client cannot show the confirmation dialog. ${CERTIFICATE_IN_TERMINAL}`,
  declined: `The user did not trust the certificate in the dialog. If they checked it and want to continue: ${CERTIFICATE_IN_TERMINAL}`,
};

/**
 * `opscrew_interview_questions` (read-only) and `opscrew_save_requirements` (writes
 * `opscrew/requirements.yaml`): the deterministic interview in two steps, so the user's own agent
 * asks the questions.
 */
export function registerInterviewTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: InterviewToolOptions = {},
): void {
  server.registerTool(
    "opscrew_interview_questions",
    {
      title: "Interview questions",
      description:
        "List the deployment questions OpsCrew needs answered for this project (which app to deploy when the repository has several, where it runs (Hetzner Cloud, DigitalOcean, a server the user already has, with its SSH follow-up questions, or a Portainer the user already runs, with its follow-up questions), expected users, monthly budget, region, acceptable downtime, data criticality, domain, DNS, image signing, deploy tags, and the app's components: each hosted service to keep or run on the server, and each worker's command when no convention gives it). Questions that can be inferred from the code are left out; previous answers are pre-filled as defaults. Ask the user each question, then call opscrew_save_requirements with the answers keyed by answer id. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_interview_questions", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const { paths } = phase;
        const { facts, source } = await loadFacts(paths);
        const previous = await loadPrevious(paths);
        // In a repository with several apps, the first question is which one to deploy.
        const { appCandidates } = await detectProjectDetails(paths.root);
        // The provider default follows the token that is set, as in `opscrew init`/`interview`.
        const inferredProvider = providerFromTokens(deps.env);
        // The signing question says what signing makes public for this repository.
        const isPrivate = await repositoryPrivate(phase);
        const context = {
          ...(inferredProvider !== undefined ? { inferredProvider } : {}),
          ...(isPrivate !== undefined ? { repositoryPrivate: isPrivate } : {}),
        };
        const questions = buildQuestions(facts, previous, appCandidates, context);
        const inferred = inferredAnswers(facts, context);
        // The app's hosted services, its storage and its workers without a conventional command;
        // what running a hosted service would add is priced for the previous answers, when there
        // are any. The provider may change in the same answers, so the storage choices are every
        // storage, with where each is offered.
        const componentQuestions = buildComponentQuestions(
          facts,
          previous === undefined
            ? {
                keepExternalServices:
                  inferred.keepExternalServices as Requirements["keepExternalServices"],
              }
            : {
                keepExternalServices: previous.keepExternalServices,
                workerCommands: previous.workerCommands,
                objectStorage: previous.objectStorage,
              },
          previous === undefined ? undefined : await hostedAdditions(phase, facts, previous),
        );
        // How OpsCrew reached the user's own server or Portainer before (the defaults), if known.
        const recorded = await readServerAddresses(paths).catch(() => undefined);
        const server = recorded?.own;
        // The follow-ups for a server the user already has (asked only when provider is "own").
        const serverQuestions = buildServerQuestions(
          server === undefined ? {} : { previous: server },
        );
        // The follow-ups for an existing Portainer (asked only when provider is "portainer"). The
        // saved address is never shown: leaving portainer.url out keeps it.
        const portainer = recorded?.portainer;
        const portainerQuestions = buildPortainerQuestions({
          ...(portainer === undefined ? {} : { previous: portainer }),
          ...(previous === undefined
            ? {}
            : {
                cloudflareDomain:
                  previous.dnsProvider === "cloudflare" && previous.domain !== undefined,
                ...(previous.domain === undefined ? {} : { domain: previous.domain }),
              }),
        }).map((question) => {
          if (question.id !== "portainer.url") return question;
          const { default: _saved, ...rest } = question;
          return rest;
        });
        const text = [
          `Ask the user these ${questions.length} question${questions.length === 1 ? "" : "s"}, then call opscrew_save_requirements with the answers keyed by answer id.`,
          ...(previous !== undefined
            ? ["Previous answers from opscrew/requirements.yaml are shown as defaults."]
            : []),
          "",
          ...questions.map(renderQuestion),
          "",
          ...(componentQuestions.length > 0
            ? [
                "Also ask these about the app's components and pass them under their answer ids (keepExternalServices.<kind>: true keeps the hosted service, false lets OpsCrew run one on the server; keepExternalServices.s3: false lets OpsCrew create a bucket for the app's files, and objectStorage says where, from the choices offered for the provider the user picks; workerCommands.<worker>: the command that starts the worker). Never replace the app's storage unasked: without an answer it is kept.",
                "",
                ...componentQuestions.map(renderQuestion),
                "",
              ]
            : []),
          'Only when the user chooses "own" (a server they already have), also ask these and pass them as server.* answers. Never ask for a password, a passphrase or the private key itself: OpsCrew uses the key file or the SSH agent. The address stays on the user\'s computer only; do not write it into any file.',
          ...(server !== undefined
            ? ["How OpsCrew reached the server before is saved; leave server.host out to keep it."]
            : []),
          "",
          ...serverQuestions.map(renderQuestion),
          "",
          `Only when the user chooses "portainer" (a Portainer they already run), also ask these and pass them as portainer.* answers. The access token comes only from the PORTAINER_API_KEY environment variable of the MCP server: never ask for it or a password. The address stays on the user's computer only; do not write it into any file. When OpsCrew connects, the user confirms Portainer's certificate in a dialog; never confirm it or pass a fingerprint yourself. The choices for web and redeploy follow the domain answered above: a Cloudflare Tunnel and Cloudflare redeploys need a domain on Cloudflare, Caddy needs a domain.`,
          ...(portainer !== undefined
            ? [
                "How OpsCrew reached the user's Portainer before is saved; leave portainer.url out to keep it.",
              ]
            : []),
          "",
          ...portainerQuestions.map(renderQuestion),
        ].join("\n");
        return {
          text,
          data: {
            questions,
            componentQuestions,
            serverQuestions,
            portainerQuestions,
            inferred,
            prefilled: previous !== undefined,
            factsSource: source,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_save_requirements",
    {
      title: "Save the deployment requirements",
      description:
        "Validate the user's interview answers and write opscrew/requirements.yaml. Pass the answers keyed by the answer ids returned by opscrew_interview_questions. Answers that are not given fall back to the previous requirements, then to values inferred from the code. For a Portainer the user already runs it connects to Portainer with PORTAINER_API_KEY to list its environments; the first time (or when the certificate changed) the USER confirms Portainer's certificate in a dialog, which the coding agent cannot answer. Returns the saved requirements, or which answers are missing or invalid.",
      inputSchema: {
        ...projectDirInput,
        answers: z
          .looseObject(answersShape)
          .describe(
            "Answers keyed by answer id (the question ids from opscrew_interview_questions).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ projectDir, answers }, extra: CallExtra) =>
      runTool(deps, "opscrew_save_requirements", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        // The certificate is confirmed only by the user in a dialog, never from the tool's input;
        // a client without dialogs leaves nobody to confirm it, so the call stops.
        const portainer: PortainerInterviewOptions = {
          access: options.portainerAccess ?? createPortainerAccess({ redactor: deps.redactor }),
          ...(clientSupportsElicitation(server)
            ? { confirmCertificate: certificateDialog(server, deps, extra) }
            : {}),
        };
        const isPrivate = await repositoryPrivate(phase);
        let result: Awaited<ReturnType<typeof runInterview>>;
        try {
          result = await runInterview(phase, {
            answers: answers as Record<string, unknown>,
            portainer,
            ...(isPrivate !== undefined ? { repositoryPrivate: isPrivate } : {}),
          });
        } catch (error) {
          if (error instanceof PortainerCertificateError) {
            withHint(error, CERTIFICATE_HINTS[error.reason]);
          }
          // Missing or invalid answers; every other stop keeps its own next step.
          if (isUserFacingError(error) && error.code === "INVALID_INPUT") {
            withHint(
              error,
              "Ask the user for the missing or invalid answers and call opscrew_save_requirements again.",
            );
          }
          throw error;
        }
        const { requirements } = result;
        const file = toPosixRelative(phase.paths.root, phase.paths.files.requirements);
        const budget = requirements.budgetMonthly;
        const own = requirements.provider === "own";
        const inPortainer = requirements.provider === "portainer";
        const storage = storageAnswerText(requirements);
        const text = [
          `Saved ${file}.`,
          own
            ? "- Where it runs: a server the user already has (how to reach it is saved in .opscrew/server.json on this computer only, never in the repository)"
            : inPortainer
              ? `- Where it runs: the user's existing Portainer, environment "${result.portainer?.environmentName ?? "?"}" (its address is saved in .opscrew/server.json on this computer only; the token stays in PORTAINER_API_KEY and is never saved)`
              : `- Cloud provider: ${providerProfile(requestedProvider(requirements)).displayName}`,
          `- Expected monthly users: ${requirements.expectedMonthlyUsers}`,
          `- Budget: ${budget.amount} ${budget.currency} per month`,
          ...(requirements.region === undefined ? [] : [`- Region: ${requirements.region}`]),
          `- Acceptable downtime: ${requirements.uptime}`,
          `- Data criticality: ${requirements.dataCriticality}`,
          ...(requirements.domain !== undefined
            ? [`- Domain: ${requirements.domain} (DNS: ${requirements.dnsProvider})`]
            : ["- Domain: none yet"]),
          ...answered(requirements, true).map((kinds) => `- Keep where hosted: ${kinds}`),
          ...answered(requirements, false).map((kinds) => `- Run on the server: ${kinds}`),
          ...(storage === undefined ? [] : [`- Object storage: ${storage}`]),
          "",
          own
            ? "Next: call opscrew_design_options; it connects to the server (read-only) to check that it fits the app. The first connection asks the user to confirm the server's SSH host key."
            : inPortainer
              ? "Next: call opscrew_design_options to see the deployment in the user's Portainer (no server price: they already run it)."
              : "Next: call opscrew_design_options to see deployment options with monthly costs.",
        ].join("\n");
        return { text, data: { requirements, file } };
      }),
  );
}
