import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderRunbook } from "./index";

const ctx = testContext({ projectId: "shop-0123456789ab" });

/** The runbook's "Database backups" section. */
function backupsSection(content: string): string {
  return content.slice(
    content.indexOf("## Database backups"),
    content.indexOf("## Change settings"),
  );
}

// Contabo's Auto Backup (027 R15): turned on through Contabo's API, priced on its order page.
describe("renderRunbook for Contabo's Auto Backup", () => {
  it("says what Auto Backup keeps and how to restore one in the panel", () => {
    const content = renderRunbook(testPlan({ provider: "contabo", backups: true }), ctx).content;
    expect(content).toContain(
      "| Database | PostgreSQL 17 on the server, data in `/srv/data/shop` (see Components); Contabo's Auto Backup is on |",
    );
    expect(backupsSection(content)).toContain(
      "Contabo's Auto Backup takes a backup of the whole server every day, keeps up to 10 and stores them off the server. Restore one in Contabo's Customer Control Panel (Servers & Hosting → VPS Auto Backup): a restore overwrites the server, which is down until it ends.",
    );
  });

  it("points to Contabo's order page for the price when it is off, never to design", () => {
    const content = renderRunbook(testPlan({ provider: "contabo", backups: false }), ctx).content;
    expect(backupsSection(content)).toContain(
      "Automated server backups are **off**. Turn them on with `opscrew design` (they cost extra; check the price on Contabo's order page) or make your own backups:",
    );
    expect(content).not.toContain("it shows the price");
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
