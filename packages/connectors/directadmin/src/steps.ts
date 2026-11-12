import type { HostingOperation, PanelStep } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/*
 * The steps a user takes in DirectAdmin's own pages (the Evolution skin). The page names come
 * from DirectAdmin's documentation: "Account Manager > Domain Setup" and "Account Manager > PHP
 * Settings" (https://docs.directadmin.com/changelog/version-1.651.html), "Sub-Domains Setup >
 * Document Root Override" with its "PHP Version Selector"
 * (https://docs.directadmin.com/webservices/php/multiple-php.html); the others are the pages'
 * titles (MySQL Management, Cron Jobs, File Manager, SSL Certificates).
 */

type Details = Readonly<Record<string, string>>;

function need(details: Details, key: string, operation: HostingOperation): string {
  const value = details[key];
  if (value === undefined || value === "") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The DirectAdmin step for ${operation} needs "${key}", which was not given.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  return value;
}

const STEPS: { [O in HostingOperation]: (details: Details) => PanelStep } = {
  addHostname: (d) => {
    const hostname = need(d, "hostname", "addHostname");
    const root = d.documentRoot;
    return {
      operation: "addHostname",
      what:
        root === undefined || root === ""
          ? `Add ${hostname} (a subdomain under Sub-Domains Setup; a domain under Domain Setup)`
          : `Add ${hostname} with this document root (a subdomain under Sub-Domains Setup, then its Document Root Override; a domain under Domain Setup)`,
      where: "Sub-Domains Setup, or Account Manager → Domain Setup",
      ...(root === undefined || root === "" ? {} : { value: root }),
    };
  },
  removeHostname: (d) => ({
    operation: "removeHostname",
    what: `Delete the subdomain ${need(d, "hostname", "removeHostname")}, keeping its folder`,
    where: "Sub-Domains Setup",
  }),
  addDatabase: (d) => ({
    operation: "addDatabase",
    what: `Create the database ${need(d, "name", "addDatabase")} with the user ${need(d, "user", "addDatabase")} and every privilege on it, using the password OpsCrew shows`,
    where: "MySQL Management",
  }),
  removeDatabase: (d) => ({
    operation: "removeDatabase",
    what: `Delete the database ${need(d, "name", "removeDatabase")} and its user ${need(d, "user", "removeDatabase")}`,
    where: "MySQL Management",
  }),
  addCron: (d) => ({
    operation: "addCron",
    what: "Add this cron job (minute, hour, day of month, month, day of week, then the command)",
    where: "Cron Jobs",
    value: `${need(d, "schedule", "addCron")} ${need(d, "command", "addCron")}`,
  }),
  removeCron: (d) => ({
    operation: "removeCron",
    what: `Delete the cron job DirectAdmin numbers ${need(d, "key", "removeCron")}`,
    where: "Cron Jobs",
  }),
  writeFile: (d) => ({
    operation: "writeFile",
    what: `Upload the file ${need(d, "path", "writeFile")} and set its permissions`,
    where: "File Manager",
    value: need(d, "mode", "writeFile"),
  }),
  uploadTar: (d) => ({
    operation: "uploadTar",
    what: `Upload ${need(d, "file", "uploadTar")} into ${need(d, "folder", "uploadTar")}, extract it there, then delete ${need(d, "file", "uploadTar")}`,
    where: "File Manager",
  }),
  remove: (d) => ({
    operation: "remove",
    what: `Delete ${need(d, "path", "remove")} and everything in it`,
    where: "File Manager",
  }),
  requestCertificate: (d) => ({
    operation: "requestCertificate",
    what: `Get a free certificate covering ${need(d, "hostname", "requestCertificate")}, keeping the names already ticked`,
    where: "SSL Certificates",
  }),
  removeCertificate: (d) => ({
    operation: "removeCertificate",
    what: `Delete the certificate ${need(d, "id", "removeCertificate")} (domain/certificate)`,
    where: "SSL Certificates",
  }),
  setPhpVersion: (d) => ({
    operation: "setPhpVersion",
    what: `Choose PHP ${need(d, "version", "setPhpVersion")} for ${need(d, "hostname", "setPhpVersion")} in its PHP Version Selector (for a subdomain: Sub-Domains Setup → Document Root Override)`,
    where: "Account Manager → Domain Setup, or Account Manager → PHP Settings",
    value: need(d, "version", "setPhpVersion"),
  }),
};

/** The step the user takes in DirectAdmin for `operation`, with the values in `details`. */
export function directAdminPanelStep(operation: HostingOperation, details: Details): PanelStep {
  return STEPS[operation](details);
}
