import { describe, expect, it } from "vitest";
import { appFacts, healthInput, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const FASTAPI = "from fastapi import FastAPI\n\napp = FastAPI()\n";
const EXPRESS = 'import express from "express";\nconst app = express();\n';

describe("healthRouteEdit (the registry)", () => {
  it("adds nothing to a static site or for a path that is not plain", async () => {
    const site = appFacts({
      languages: ["javascript"],
      frameworks: ["vite"],
      appKind: "static-spa",
    });
    expect(await healthRouteEdit(healthInput("static-spa", site, {}))).toEqual({
      action: "manual",
      reason: "the app is served as static files, so there is no server to add a route to.",
    });
    const api = appFacts({ languages: ["python"], frameworks: ["fastapi"] });
    for (const path of ["/", "/health?full=1", "/users/:id"]) {
      expect(
        await healthRouteEdit(healthInput("fastapi", api, { "main.py": FASTAPI }, path)),
      ).toEqual({
        action: "manual",
        reason: `the plan checks ${path}, and OpsCrew only adds a plain path such as /health itself.`,
      });
    }
  });

  it("follows the deploy stack: a FastAPI deploy with Next.js in the repository gets a FastAPI route", async () => {
    const facts = appFacts({
      languages: ["python", "typescript"],
      frameworks: ["fastapi", "next"],
    });
    const edit = await healthRouteEdit(
      healthInput("fastapi", facts, {
        "main.py": FASTAPI,
        "web/app/page.tsx": "export default function Page() {}\n",
      }),
    );
    expect(edit).toMatchObject({ action: "write", framework: "FastAPI", path: "main.py" });
    expect(written(edit, "main.py")).toContain('@app.get("/health")');
  });

  it("looks for both languages when the stack is not known, and stops when both have an app", async () => {
    const facts = appFacts({ languages: ["javascript", "python"] });
    const python = await healthRouteEdit(healthInput("generic", facts, { "main.py": FASTAPI }));
    expect(python).toMatchObject({ action: "write", framework: "FastAPI" });
    const both = await healthRouteEdit(
      healthInput("generic", facts, { "main.py": FASTAPI, "server.js": EXPRESS }),
    );
    expect(both).toEqual({
      action: "manual",
      reason:
        "OpsCrew found both a Python and a Node.js app object, so it cannot tell which one serves the app.",
    });
    const neither = await healthRouteEdit(
      healthInput("generic", appFacts({ languages: ["go"] }), { "main.go": "package main\n" }),
    );
    expect(neither).toEqual({
      action: "manual",
      reason:
        "OpsCrew adds health routes itself only for the Python and Node.js frameworks it knows.",
    });
  });

  it("leaves the route to the agent when a file cannot be read", async () => {
    const input = healthInput("fastapi", appFacts({ languages: ["python"] }), {
      "main.py": FASTAPI,
    });
    input.repo.read = async () => {
      throw new Error("EACCES: permission denied, open 'main.py'");
    };
    expect(await healthRouteEdit(input)).toEqual({
      action: "manual",
      reason:
        "OpsCrew could not read the app's code to add the route (EACCES: permission denied, open 'main.py').",
    });
  });
});
