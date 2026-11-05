/**
 * Advise's report and an applied proposal in words (feature 021, US1, US2, US4), as `opscrew
 * advise` prints them and the `opscrew_advise` MCP tool returns them.
 */
import { formatMoney, listText, plural } from "@opscrew/core";
import type { AppliedProposal } from "./apply";
import type { AdviceReport, Basis, Proposal, ProposalPrice, Reason, Urgency } from "./types";

const HEADINGS: Record<Urgency, string> = {
  now: "Now:",
  soon: "Soon:",
  "when-convenient": "When convenient:",
};

/** Where a measured figure comes from; nothing for a fact of the plan or the account. */
function basisWords(basis: Basis): string | undefined {
  if (basis.kind === "history") return `over ${plural(Math.floor(basis.days), "day")}`;
  if (basis.kind === "one-reading") return "one reading";
  return undefined;
}

/**
 * `- why (figure, over 14 days)`: the figure (unless the text already says it) and its basis, when
 * it has them.
 */
function reasonLine(reason: Reason): string {
  const said = reason.figure !== undefined && reason.text.includes(reason.figure);
  const notes = [said ? undefined : reason.figure, basisWords(reason.basis)].filter(
    (n) => n !== undefined,
  );
  if (notes.length === 0) return `    - ${reason.text}`;
  return `    - ${reason.text.replace(/\.$/, "")} (${notes.join(", ")})`;
}

/** `€3.49 → €5.49 a month (live prices)`, or the static prices with their date. */
export function priceWords(price: ProposalPrice): string {
  const money = (amount: number) => formatMoney({ amount, currency: price.currency });
  const source =
    price.source === "live"
      ? "live prices"
      : `static prices${price.asOf === undefined ? "" : ` dated ${price.asOf.slice(0, 10)}`}`;
  return `${money(price.before)} → ${money(price.after)} a month (${source})`;
}

/** How to apply `proposal`: `advise --apply` with `flags`, its command, or what to do by hand. */
function applyLine(proposal: Proposal, flags: string): string {
  const { apply } = proposal;
  if (apply.kind === "plan") return `    Apply: opscrew advise --apply ${proposal.id}${flags}`;
  if (apply.kind === "command") return `    Run: ${apply.command}`;
  return `    By hand: ${apply.text}`;
}

function proposalLines(proposal: Proposal, flags: string): string[] {
  return [
    `  ${proposal.title} [${proposal.id}]`,
    ...proposal.reasons.map(reasonLine),
    `    Price: ${proposal.price === undefined ? "no change" : priceWords(proposal.price)}`,
    applyLine(proposal, flags),
  ];
}

/**
 * `report` in words: its proposals grouped by urgency (now, soon, when convenient), each with its
 * title and id, its reasons with their figures and basis, its monthly price before and after and
 * how to apply it; then what was checked and what couldn't be read; with `suggestMonitoring`
 * (monitoring off on a server OpsCrew created) and a server read once, a closing line on the two
 * weeks of figures monitoring gives. `flags` are the commands' ` --app …`/` --env …` (empty for
 * the default).
 */
export function renderAdviceReport(
  report: AdviceReport,
  flags: string,
  options: { suggestMonitoring: boolean },
): string {
  const groups = (["now", "soon", "when-convenient"] as const).flatMap((urgency) => {
    const proposals = report.proposals.filter((p) => p.urgency === urgency);
    if (proposals.length === 0) return [];
    return [
      "",
      HEADINGS[urgency],
      ...proposals.flatMap((p, i) => [...(i === 0 ? [] : [""]), ...proposalLines(p, flags)]),
    ];
  });
  const closing =
    options.suggestMonitoring && Object.values(report.basis).some((b) => b.kind === "one-reading");
  return [
    report.proposals.length === 0
      ? "Nothing to change: advise found nothing to propose."
      : "Advise's proposals, the most urgent first:",
    ...groups,
    "",
    `Checked: ${listText(report.checked)}.`,
    ...(report.notRead.length === 0
      ? []
      : ["", "Couldn't read:", ...report.notRead.map((entry) => `  - ${entry}`)]),
    ...(closing
      ? [
          "",
          `These figures are one reading. \`opscrew addon enable monitoring${flags}\` gives two weeks of figures, so advise can also propose smaller servers.`,
        ]
      : []),
  ].join("\n");
}

/**
 * What `opscrew advise --apply` did, in words: the plan change's summary, or the command that
 * applies the proposal, or what to do by hand (then advise changed nothing).
 */
export function renderAppliedProposal(applied: AppliedProposal): string {
  if ("summary" in applied) return applied.summary;
  if ("command" in applied) {
    return `Advise changed nothing: another command applies this one. Run:\n  ${applied.command}`;
  }
  return `Advise changed nothing: this one is done by hand.\n  ${applied.manual}`;
}
