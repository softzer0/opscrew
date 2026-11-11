import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderRunbook } from "./index";

const ctx = testContext({ projectId: "shop-0123456789ab" });

// Contabo has no provider backups OpsCrew turns on (`offering.providerBackups: false`).
describe("renderRunbook for a provider without provider backups (Contabo)", () => {
  it("never offers to turn its backups on, and points to OpsCrew's data snapshots", () => {
    const content = renderRunbook(testPlan({ provider: "contabo" }), ctx).content;
    expect(content).toContain(
      "| Database | PostgreSQL 17 on the server, data in `/srv/data/shop` (see Components); snapshots with `opscrew snapshot` |",
    );
    const backups = content.slice(
      content.indexOf("## Database backups"),
      content.indexOf("## Change settings"),
    );
    expect(backups).toContain(
      [
        "Contabo has no automated server backups OpsCrew turns on; OpsCrew's own snapshots of the data take their place:",
        "`opscrew snapshot` takes one, `opscrew snapshot schedule on` takes them on a schedule, and",
        "`opscrew snapshot offsite on --to <provider>` keeps an encrypted copy of each off the server; both take",
        "effect with the next `opscrew provision`. `opscrew restore <id>` puts one back, and",
        "`opscrew restore <id> --from offsite --key-file <path>` puts one back from the off-server copy.",
        "You can also make your own backups:",
      ].join("\n"),
    );
    expect(content).not.toMatch(/Turn them on/);
    expect(content).not.toMatch(/backups are (\*\*)?off/);
  });

  it("points a server's size change to the two ways design names", () => {
    const content = renderRunbook(testPlan({ provider: "contabo" }), ctx).content;
    expect(content).toContain(
      [
        "- **Server size:** Contabo can't change a server's size in place. `opscrew design` names the two ways to",
        "  another size: a move to another provider (`opscrew retarget`), or a new server with the data put back from a snapshot.",
        "- **Location, domain:** run `opscrew design` and `opscrew provision`. OpsCrew shows the plan and the cost",
      ].join("\n"),
    );
    expect(content).not.toContain("Server size, location, domain");
  });
});
