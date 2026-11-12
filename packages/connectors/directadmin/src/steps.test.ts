import type { HostingOperation, PanelStep } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { directAdminPanelStep } from "./steps";

const details = {
  hostname: "app.example.com",
  documentRoot: "domains/app.example.com/public_html",
  name: "alice_shop",
  user: "alice_shop",
  schedule: "* * * * *",
  command: "bash ~/opscrew/agent.sh",
  key: "7",
  file: "release.tar",
  id: "example.com/cert-3",
  path: "opscrew/shared/.env",
  mode: "0600",
  folder: "opscrew/releases/1",
  version: "8.3",
};

const expected: Record<HostingOperation, PanelStep> = {
  addHostname: {
    operation: "addHostname",
    what: "Add app.example.com with this document root (a subdomain under Sub-Domains Setup, then its Document Root Override; a domain under Domain Setup)",
    where: "Sub-Domains Setup, or Account Manager → Domain Setup",
    value: "domains/app.example.com/public_html",
  },
  removeHostname: {
    operation: "removeHostname",
    what: "Delete the subdomain app.example.com, keeping its folder",
    where: "Sub-Domains Setup",
  },
  addDatabase: {
    operation: "addDatabase",
    what: "Create the database alice_shop with the user alice_shop and every privilege on it, using the password OpsCrew shows",
    where: "MySQL Management",
  },
  removeDatabase: {
    operation: "removeDatabase",
    what: "Delete the database alice_shop and its user alice_shop",
    where: "MySQL Management",
  },
  addCron: {
    operation: "addCron",
    what: "Add this cron job (minute, hour, day of month, month, day of week, then the command)",
    where: "Cron Jobs",
    value: "* * * * * bash ~/opscrew/agent.sh",
  },
  removeCron: {
    operation: "removeCron",
    what: "Delete the cron job DirectAdmin numbers 7",
    where: "Cron Jobs",
  },
  writeFile: {
    operation: "writeFile",
    what: "Upload the file opscrew/shared/.env and set its permissions",
    where: "File Manager",
    value: "0600",
  },
  uploadTar: {
    operation: "uploadTar",
    what: "Upload release.tar into opscrew/releases/1, extract it there, then delete release.tar",
    where: "File Manager",
  },
  remove: {
    operation: "remove",
    what: "Delete opscrew/shared/.env and everything in it",
    where: "File Manager",
  },
  requestCertificate: {
    operation: "requestCertificate",
    what: "Get a free certificate covering app.example.com, keeping the names already ticked",
    where: "SSL Certificates",
  },
  removeCertificate: {
    operation: "removeCertificate",
    what: "Delete the certificate example.com/cert-3 (domain/certificate)",
    where: "SSL Certificates",
  },
  setPhpVersion: {
    operation: "setPhpVersion",
    what: "Choose PHP 8.3 for app.example.com in its PHP Version Selector (for a subdomain: Sub-Domains Setup → Document Root Override)",
    where: "Account Manager → Domain Setup, or Account Manager → PHP Settings",
    value: "8.3",
  },
};

describe("directAdminPanelStep", () => {
  for (const [operation, step] of Object.entries(expected)) {
    it(`gives the exact step for ${operation}`, () => {
      expect(directAdminPanelStep(operation as HostingOperation, details)).toEqual(step);
    });
  }

  it("leaves out the document root DirectAdmin chooses", () => {
    expect(directAdminPanelStep("addHostname", { hostname: "app.example.com" })).toEqual({
      operation: "addHostname",
      what: "Add app.example.com (a subdomain under Sub-Domains Setup; a domain under Domain Setup)",
      where: "Sub-Domains Setup, or Account Manager → Domain Setup",
    });
  });

  it("refuses a step whose value is missing", () => {
    expect(() => directAdminPanelStep("setPhpVersion", { hostname: "a.example.com" })).toThrow(
      /needs "version"/,
    );
  });
});
