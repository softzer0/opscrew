import { BUILDPACKS_OFFERS, RUNTIME_DEFAULTS } from "@opscrew/iac-templates";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts } from "../testing";
import { offered, resolveRuntime } from "./runtime-version";

type Versions = ProjectFacts["runtimeVersions"];
type Evidence = NonNullable<ProjectFacts["runtimeEvidence"]>;

const facts = (runtimeVersions: Versions = {}, runtimeEvidence?: Evidence) =>
  makeFacts({ runtimeVersions, ...(runtimeEvidence ? { runtimeEvidence } : {}) });

const version = (...args: Parameters<typeof resolveRuntime>) =>
  resolveRuntime(...args).runtime.version;

describe("resolveRuntime: rule 1, exact", () => {
  it("keeps an exact version as declared, never raised", () => {
    expect(version("node", facts({ node: "20.11.1" }), undefined)).toBe("20.11.1");
    expect(version("node", facts({ node: "v22" }), undefined)).toBe("22");
    expect(version("python", facts({ python: "3.12.4" }), undefined)).toBe("3.12.4");
    expect(version("ruby", facts({ ruby: "ruby-4.0.7" }), undefined)).toBe("4.0.7");
    expect(version("go", facts({ go: "1.26" }), undefined)).toBe("1.26");
    expect(version("java", facts({ java: "1.8" }), undefined)).toBe("8");
    expect(version("rust", facts({ rust: "1.83.0" }), undefined)).toBe("1.83.0");
  });

  it("reads nvm's LTS aliases", () => {
    expect(version("node", facts({ node: "lts/*" }), undefined)).toBe(RUNTIME_DEFAULTS.node);
    expect(version("node", facts({ node: "lts/iron" }), undefined)).toBe("20");
    expect(version("node", facts({ node: "lts/Jod" }), undefined)).toBe("22");
    expect(version("node", facts({ node: "lts/krypton" }), undefined)).toBe("24");
    expect(version("node", facts({ node: "lts/hydrogen" }), undefined)).toBe("18");
  });

  it("says which version it uses for a declaration it cannot read", () => {
    const stable = resolveRuntime("rust", facts({ rust: "stable" }), undefined);
    expect(stable.runtime.version).toBe(RUNTIME_DEFAULTS.rust);
    expect(stable.warnings).toEqual([
      `OpsCrew cannot read the Rust version the app declares ("stable"), so OpsCrew uses Rust ${RUNTIME_DEFAULTS.rust}. To pin a version, set app.build.runtime.version in opscrew/plan.yaml or declare an exact version in the app.`,
    ]);
    const recorded = resolveRuntime("node", facts({ node: "lts/unknown" }), {
      language: "node",
      version: "22",
    });
    expect(recorded.runtime.version).toBe("22");
    expect(recorded.warnings[0]).toMatch(
      /^OpsCrew cannot read the Node\.js version the app declares \("lts\/unknown"\), so OpsCrew uses Node\.js 22 \(recorded in opscrew\/plan\.yaml\)\./,
    );
  });

  it("says which version it uses for a range with no version inside", () => {
    const result = resolveRuntime("node", facts({ node: ">=22 <20" }), undefined);
    expect(result.runtime.version).toBe("24");
    expect(result.warnings[0]).toMatch(
      /^No Node\.js version fits the range the app declares \(">=22 <20"\), so OpsCrew uses Node\.js 24\./,
    );
  });
});

describe("resolveRuntime: rule 2, range", () => {
  it.each([
    ["node", ">=18", "24"],
    ["node", ">=22.12.0", "24"],
    ["node", "^20.0.0", "20"],
    ["node", ">= 18 < 23", "22"],
    ["node", "18 || 20", "20"],
    ["node", "20.x", "20"],
    ["python", ">=3.10", "3.14"],
    ["python", ">=3.10,<3.13", "3.12"],
    ["python", "~=3.11", "3.14"],
    ["python", "==3.12.*", "3.12"],
    ["php", "^8.2", "8.4"],
    ["php", ">=8.1 <8.4", "8.3"],
    ["php", "^8.2|^8.3", "8.4"],
    ["node", "18 - 20", "20"],
    ["node", "<=20.x", "20"],
    ["node", ">=18.x <=22", "22"],
    ["python", ">3.12.0,<3.13", "3.12"],
  ] as const)("%s %s → %s", (language, declared, expected) => {
    const result = resolveRuntime(language, facts({ [language]: declared }), undefined);
    expect(result.runtime.version).toBe(expected);
    expect(result.warnings.filter((w) => !w.includes("end of life"))).toEqual([]);
  });

  it("treats go.mod's version as a minimum inside its release line", () => {
    const go = (declared: string) =>
      version("go", facts({ go: declared }), undefined, BUILDPACKS_OFFERS.go);
    expect(go("1.25.0")).toBe("1.25");
    expect(go("1.25.3")).toBe("1.25");
    expect(go("1.26")).toBe("1.26");
    // No offer is 1.26.9 or newer in its line: the minimum stays, so it reads as not offered.
    expect(go("1.26.9")).toBe("1.26.9");
    expect(offered(go("1.26.9") ?? "", BUILDPACKS_OFFERS.go)).toBe(false);
  });

  it("prefers the newest version a builder offers inside the range", () => {
    const ruby = facts({ ruby: "~> 3.3" });
    expect(version("ruby", ruby, undefined, BUILDPACKS_OFFERS.ruby)).toBe("3.4");
    const open = facts({ ruby: ">= 3.3" });
    expect(version("ruby", open, undefined, BUILDPACKS_OFFERS.ruby)).toBe("4.0");
  });
});

describe("resolveRuntime: rules 3 and 4, evidence before the default", () => {
  it("takes the first evidence source, the newest of a CI matrix", () => {
    const evidence: Evidence = {
      node: [
        { value: "18", source: ".github/workflows/ci.yml" },
        { value: "20.x", source: ".github/workflows/ci.yml" },
        { value: "22", source: ".tool-versions" },
      ],
    };
    expect(version("node", facts({}, evidence), undefined)).toBe("20");
  });

  it("counts every CI workflow as one source", () => {
    const evidence: Evidence = {
      node: [
        { value: "20", source: ".github/workflows/ci.yml" },
        { value: "22", source: ".github/workflows/release.yml" },
        { value: "24", source: ".tool-versions" },
      ],
    };
    expect(version("node", facts({}, evidence), undefined)).toBe("22");
  });

  it("reads a framework's Python range", () => {
    const evidence: Evidence = { python: [{ value: ">=3.10,<3.13", source: "Django 5.0" }] };
    expect(version("python", facts({}, evidence), undefined)).toBe("3.12");
  });

  it("uses the default without evidence", () => {
    expect(version("node", facts(), undefined)).toBe("24");
    expect(version("python", facts(), undefined)).toBe("3.14");
    expect(version("dotnet", facts(), undefined)).toBe("10.0");
  });

  it("gives `other` no version", () => {
    expect(resolveRuntime("other", facts(), undefined)).toEqual({
      runtime: { language: "other" },
      warnings: [],
    });
  });
});

describe("resolveRuntime: rule 5, the recorded version is kept", () => {
  it("keeps plan.yaml's version over evidence and a newer default", () => {
    const evidence: Evidence = { node: [{ value: "22", source: ".nvmrc" }] };
    const result = resolveRuntime("node", facts({}, evidence), {
      language: "node",
      version: "20",
    });
    expect(result.runtime.version).toBe("20");
  });

  it("keeps it inside a declared range, and leaves a range that no longer allows it", () => {
    const recorded = { language: "python", version: "3.12" } as const;
    expect(version("python", facts({ python: ">=3.10" }), recorded)).toBe("3.12");
    const moved = resolveRuntime("python", facts({ python: ">=3.13" }), recorded);
    expect(moved.runtime.version).toBe("3.14");
    expect(moved.warnings).toEqual([
      "The app declares Python >=3.13, so OpsCrew moves it from Python 3.12 (recorded in opscrew/plan.yaml) to 3.14. A new release line can break the app's libraries: test the app on it before you deploy.",
    ]);
  });

  it("ignores a version recorded for another language", () => {
    expect(version("go", facts(), { language: "node", version: "20" })).toBe("1.26");
  });
});

describe("resolveRuntime: rules 6 and 7, majors are the user's, end of life", () => {
  it("warns when the app's declaration moves to another major", () => {
    const result = resolveRuntime("node", facts({ node: "26" }), {
      language: "node",
      version: "24",
    });
    expect(result.runtime.version).toBe("26");
    expect(result.warnings[0]).toMatch(/^The app declares Node\.js 26, so OpsCrew moves it from/);
  });

  it("warns when plan.yaml asks for a newer major than the default", () => {
    const result = resolveRuntime("node", facts(), { language: "node", version: "26" });
    expect(result.runtime.version).toBe("26");
    expect(result.warnings).toEqual([
      "opscrew/plan.yaml asks for Node.js 26, a newer release line than 24. A new release line can break the app's libraries: test the app on it before you deploy.",
    ]);
  });

  it("does not warn for a patch of the same release line", () => {
    const result = resolveRuntime("node", facts({ node: "24.3.0" }), {
      language: "node",
      version: "24",
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns for Node below the oldest maintained LTS and Python below 3.10", () => {
    expect(resolveRuntime("node", facts({ node: "20" }), undefined).warnings).toEqual([
      "Node.js 20 is past its end of life and gets no security fixes. OpsCrew keeps it because the app uses it; move the app to Node.js 22 or newer when you can.",
    ]);
    expect(resolveRuntime("python", facts({ python: "3.9" }), undefined).warnings).toHaveLength(1);
    expect(resolveRuntime("node", facts({ node: "22" }), undefined).warnings).toEqual([]);
    expect(resolveRuntime("python", facts({ python: "3.10" }), undefined).warnings).toEqual([]);
  });

  it.each([
    ["go", "1.25.4", "1.26"],
    ["ruby", "3.2.9", "3.3"],
    ["php", "8.1", "8.2"],
    ["dotnet", "7.0", "8.0"],
  ] as const)("warns for %s %s, below %s", (language, declared, oldest) => {
    const { warnings } = resolveRuntime(language, facts({ [language]: declared }), undefined);
    expect(warnings.at(-1)).toContain(`or newer when you can`);
    expect(warnings.at(-1)).toContain(` ${oldest} or newer`);
    const current = resolveRuntime(language, facts(), undefined);
    expect(current.warnings).toEqual([]);
  });
});

describe("offered", () => {
  it("matches by prefix at the declared precision", () => {
    expect(offered("3.4", BUILDPACKS_OFFERS.ruby)).toBe(true);
    expect(offered("4.0.6", BUILDPACKS_OFFERS.ruby)).toBe(true);
    expect(offered("4.0.7", BUILDPACKS_OFFERS.ruby)).toBe(false);
    expect(offered("3", ["3.40.1"])).toBe(true);
    expect(offered("3.4", ["3.40.1"])).toBe(false);
  });
});
