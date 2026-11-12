import { describe, expect, it } from "vitest";
import { pleskPanelStep } from "./steps";

describe("pleskPanelStep", () => {
  it("adds the agent's scheduled task as a cron-style command", () => {
    expect(
      pleskPanelStep("addCron", { schedule: "* * * * *", command: "bash opscrew/agent.sh" }),
    ).toEqual({
      operation: "addCron",
      what: 'Add a task: choose "Run a command", paste this command, set Run to "Cron style" with * * * * *, and click OK',
      where: "Websites & Domains → Scheduled Tasks → Add Task",
      value: "bash opscrew/agent.sh",
    });
  });

  it("removes a scheduled task by its command", () => {
    expect(pleskPanelStep("removeCron", { command: "bash opscrew/agent.sh" })).toEqual({
      operation: "removeCron",
      what: "Remove the scheduled task that runs this command",
      where: "Websites & Domains → Scheduled Tasks",
      value: "bash opscrew/agent.sh",
    });
  });

  it("uploads a file in File Manager and sets its mode", () => {
    expect(pleskPanelStep("writeFile", { path: "opscrew/app/.env", mode: "0600" })).toEqual({
      operation: "writeFile",
      what: "Upload this file (Upload File), then set its permissions to 0600 (Change Permissions)",
      where: "Websites & Domains → Files (File Manager)",
      value: "opscrew/app/.env",
    });
  });

  it("uploads, extracts and removes an archive", () => {
    expect(pleskPanelStep("uploadTar", { folder: "opscrew/app", file: "release.tar" })).toEqual({
      operation: "uploadTar",
      what: 'Upload release.tar into this folder (Upload File), select it and click Extract Files with "Replace existing files" selected, then remove release.tar',
      where: "Websites & Domains → Files (File Manager)",
      value: "opscrew/app",
    });
  });

  it("removes a file or folder", () => {
    expect(pleskPanelStep("remove", { path: "opscrew/app" })).toEqual({
      operation: "remove",
      what: "Remove this file or folder with everything in it",
      where: "Websites & Domains → Files (File Manager)",
      value: "opscrew/app",
    });
  });

  it("requests and removes a hostname's Let's Encrypt certificate with SSL It!", () => {
    expect(pleskPanelStep("requestCertificate", { hostname: "app.example.com" })).toEqual({
      operation: "requestCertificate",
      what: 'Under "More options", click Install, then Get it free (a certificate from Let\'s Encrypt)',
      where: "Websites & Domains → app.example.com → SSL/TLS Certificates",
    });
    expect(pleskPanelStep("removeCertificate", { hostname: "app.example.com" })).toEqual({
      operation: "removeCertificate",
      what: "Click Unassign Certificate, then OK",
      where: "Websites & Domains → app.example.com → SSL/TLS Certificates",
    });
  });

  it("sets a hostname's PHP version", () => {
    expect(
      pleskPanelStep("setPhpVersion", { hostname: "app.example.com", version: "8.3" }),
    ).toEqual({
      operation: "setPhpVersion",
      what: 'Select "PHP support" and this PHP version, then click OK',
      where: "Websites & Domains → app.example.com → PHP",
      value: "8.3",
    });
  });

  it("needs its details, and has no step for what the API does", () => {
    expect(() => pleskPanelStep("addCron", { command: "x" })).toThrow(
      "The Plesk step to add a scheduled task needs its schedule.",
    );
    for (const operation of [
      "addHostname",
      "removeHostname",
      "addDatabase",
      "removeDatabase",
    ] as const) {
      expect(() => pleskPanelStep(operation, {})).toThrow(/is not a step in the panel/);
    }
  });
});
