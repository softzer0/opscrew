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

/** A step without its operation, from `need(key)` (a detail that must be given) and the details. */
type Step = (need: (key: string) => string, details: Details) => Omit<PanelStep, "operation">;

const STEPS: { [O in HostingOperation]: Step } = {
  addHostname: (need, d) => {
    const hostname = need("hostname");
    const root = d.documentRoot;
    return {
      what:
        root === undefined || root === ""
          ? `Add ${hostname} (a subdomain under Sub-Domains Setup; a domain under Domain Setup)`
          : `Add ${hostname} with this document root (a subdomain under Sub-Domains Setup, then its Document Root Override; a domain under Domain Setup)`,
      where: "Sub-Domains Setup, or Account Manager → Domain Setup",
      ...(root === undefined || root === "" ? {} : { value: root }),
    };
  },
  removeHostname: (need) => ({
    what: `Delete the subdomain ${need("hostname")}, keeping its folder`,
    where: "Sub-Domains Setup",
  }),
  addDatabase: (need) => ({
    what: `Create the database ${need("name")} with the user ${need("user")} and every privilege on it, using the password OpsCrew shows`,
    where: "MySQL Management",
  }),
  removeDatabase: (need) => ({
    what: `Delete the database ${need("name")} and its user ${need("user")}`,
    where: "MySQL Management",
  }),
  addCron: (need) => ({
    what: "Add this cron job (minute, hour, day of month, month, day of week, then the command)",
    where: "Cron Jobs",
    value: `${need("schedule")} ${need("command")}`,
  }),
  removeCron: (need) => ({
    what: `Delete the cron job DirectAdmin numbers ${need("key")}`,
    where: "Cron Jobs",
  }),
  writeFile: (need) => ({
    what: `Upload the file ${need("path")} and set its permissions`,
    where: "File Manager",
    value: need("mode"),
  }),
  uploadTar: (need) => ({
    what: `Upload ${need("file")} into ${need("folder")}, extract it there, then delete ${need("file")}`,
    where: "File Manager",
  }),
  remove: (need) => ({
    what: `Delete ${need("path")} and everything in it`,
    where: "File Manager",
  }),
  requestCertificate: (need) => ({
    what: `Get a free certificate covering ${need("hostname")}, keeping the names already ticked`,
    where: "SSL Certificates",
  }),
  removeCertificate: (need) => ({
    what: `Delete the certificate ${need("id")} (domain/certificate)`,
    where: "SSL Certificates",
  }),
  setPhpVersion: (need) => ({
    what: `Choose PHP ${need("version")} for ${need("hostname")} in its PHP Version Selector (for a subdomain: Sub-Domains Setup → Document Root Override)`,
    where: "Account Manager → Domain Setup, or Account Manager → PHP Settings",
    value: need("version"),
  }),
};

/** The step the user takes in DirectAdmin for `operation`, with the values in `details`. */
export function directAdminPanelStep(operation: HostingOperation, details: Details): PanelStep {
  const need = (key: string): string => {
    const value = details[key];
    if (value === undefined || value === "") {
      throw new OpsCrewError(
        "INTERNAL",
        `The DirectAdmin step for ${operation} needs "${key}", which was not given.`,
      );
    }
    return value;
  };
  return { operation, ...STEPS[operation](need, details) };
}
