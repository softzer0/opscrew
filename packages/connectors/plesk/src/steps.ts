import type { HostingOperation, PanelStep } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/**
 * The changes Plesk's XML API documents for a customer: sites and subdomains (`site` operator)
 * and databases with their users (`database` operator). Scheduled tasks, files, certificates and
 * a site's PHP version have no customer call (the `certificate` and `php-handler` operators are
 * for the administrator and resellers, the `upload` operator for the administrator only), so
 * they are steps the user takes in the panel.
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains.66541/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases.34398/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-ssltls-certificates.34871/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-php-handlers.75313/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/uploading-files-to-server.36040/
 */
export const PLESK_OPERATIONS: ReadonlySet<HostingOperation> = new Set<HostingOperation>([
  "addHostname",
  "removeHostname",
  "addDatabase",
  "removeDatabase",
]);

/** What each operation outside the API does, for the refusal of a call to it. */
const ACTIONS: Record<HostingOperation, string> = {
  addHostname: "add a hostname",
  removeHostname: "remove a hostname",
  addDatabase: "add a database",
  removeDatabase: "remove a database",
  addCron: "add a scheduled task",
  removeCron: "remove a scheduled task",
  writeFile: "write a file",
  uploadTar: "upload and unpack an archive",
  remove: "remove a file or folder",
  requestCertificate: "request a certificate",
  removeCertificate: "remove a certificate",
  setPhpVersion: "set a hostname's PHP version",
};

/** The refusal of a change Plesk's customer API can't make. */
export function notInApi(operation: HostingOperation): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `Plesk's API for customers can't ${ACTIONS[operation]}.`,
    { hint: "OpsCrew shows it as a step to take in Plesk, with the exact values to enter." },
  );
}

/** The File Manager, where the paths below are relative to (the subscription's home folder). */
const FILES = "Websites & Domains → Files (File Manager)";

/**
 * The step the user takes in Plesk for `operation`, from the customer guide, with the detail keys
 * `PanelStep` names. Plesk's scheduled tasks have no key and its customer API no certificate ids,
 * so a task is named by its command and a certificate by its hostname. `details` holds:
 * - `addCron`: `schedule` (five cron fields) and `command`;
 * - `removeCron`: `command`;
 * - `writeFile`: `path` and `mode` (octal, `0600`);
 * - `uploadTar`: `folder` and `file` (the archive's name on the user's computer);
 * - `remove`: `path`;
 * - `requestCertificate`, `removeCertificate`: `hostname`;
 * - `setPhpVersion`: `hostname` and `version`.
 */
export function pleskPanelStep(
  operation: HostingOperation,
  details: Readonly<Record<string, string>>,
): PanelStep {
  const need = (key: string): string => {
    const value = details[key];
    if (value === undefined || value === "") {
      throw new OpsCrewError(
        "INTERNAL",
        `The Plesk step to ${ACTIONS[operation]} needs its ${key}.`,
      );
    }
    return value;
  };
  return { operation, ...stepOf(operation, need) };
}

/** {@link pleskPanelStep} without its operation. */
function stepOf(
  operation: HostingOperation,
  need: (key: string) => string,
): Omit<PanelStep, "operation"> {
  switch (operation) {
    // https://docs.plesk.com/en-US/obsidian/customer-guide/scheduling-tasks.65207/
    case "addCron":
      return {
        what: `Add a task: choose "Run a command", paste this command, set Run to "Cron style" with ${need("schedule")}, and click OK`,
        where: "Websites & Domains → Scheduled Tasks → Add Task",
        value: need("command"),
      };
    case "removeCron":
      return {
        what: "Remove the scheduled task that runs this command",
        where: "Websites & Domains → Scheduled Tasks",
        value: need("command"),
      };
    // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/website-content/uploading-content-with-file-manager.74105/
    // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/website-content/changing-file-and-directory-access-permissions-in-file-manager.70738/
    case "writeFile":
      return {
        what: `Upload this file (Upload File), then set its permissions to ${need("mode")} (Change Permissions)`,
        where: FILES,
        value: need("path"),
      };
    case "uploadTar":
      return {
        what: `Upload ${need("file")} into this folder (Upload File), select it and click Extract Files with "Replace existing files" selected, then remove ${need("file")}`,
        where: FILES,
        value: need("folder"),
      };
    case "remove":
      return {
        what: "Remove this file or folder with everything in it",
        where: FILES,
        value: need("path"),
      };
    // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it%21-extension.65160/
    case "requestCertificate":
      return {
        what: 'Under "More options", click Install, then Get it free (a certificate from Let\'s Encrypt)',
        where: `Websites & Domains → ${need("hostname")} → SSL/TLS Certificates`,
      };
    case "removeCertificate":
      return {
        what: "Click Unassign Certificate, then OK",
        where: `Websites & Domains → ${need("hostname")} → SSL/TLS Certificates`,
      };
    // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/hosting-settings/web-scripting-settings/php-settings.70742/
    case "setPhpVersion":
      return {
        what: 'Select "PHP support" and this PHP version, then click OK',
        where: `Websites & Domains → ${need("hostname")} → PHP`,
        value: need("version"),
      };
    case "addHostname":
    case "removeHostname":
    case "addDatabase":
    case "removeDatabase":
      throw new OpsCrewError(
        "INTERNAL",
        `Plesk's API can ${ACTIONS[operation]}; it is not a step in the panel.`,
      );
  }
}
