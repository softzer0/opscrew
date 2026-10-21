import type { CheckResult } from "@opscrew/contracts";
import type { DeepTool } from "./types";

const NIST =
  "A NIST curve: ssh-audit distrusts these on principle, no practical attack is known, and current clients choose the post-quantum or curve25519 exchange first.";
const NON_ETM =
  "A MAC without encrypt-then-MAC: OpenSSH clients choose the ETM variants the server also offers first.";

/**
 * Known noise per tool (research R1 and the spike on Ubuntu 24.04): result ids with the reason
 * they are set apart. Such a result keeps its data, gets `noise`, and is not counted.
 */
export const DEEP_NOISE: Readonly<Record<DeepTool, Readonly<Record<string, string>>>> = {
  lynis: {
    LYNIS: "OpsCrew pins Lynis's version and updates it with its pins.",
    "FILE-6310":
      "Separate partitions for /home, /var or /tmp: a cloud server has one disk, and repartitioning it means rebuilding the server.",
    "BOOT-5122":
      "A GRUB password guards the boot menu at the console, which on a cloud server sits behind the provider's login.",
    "FINT-4350":
      "A file integrity tool such as AIDE: the server is set up by cloud-init and the app runs in containers from pinned images.",
    "HRDN-7230":
      "A malware scanner: the server runs only containers from pinned images, which OpsCrew's image scan checks.",
    "USB-1000": "USB storage drivers: nobody can plug a device into a cloud server.",
    "STRG-1846": "Firewire drivers: nobody can plug a device into a cloud server.",
    "HRDN-7222":
      "Restricting compilers to root: the app runs in containers, and nothing is compiled on the server itself.",
    "PKGS-7388":
      "Lynis 3.1.7 does not read Ubuntu 24.04's deb822 sources (`ubuntu.sources`), so it misses the security repository that is there.",
  },
  "ssh-audit": {
    "kex:ecdh-sha2-nistp256": NIST,
    "kex:ecdh-sha2-nistp384": NIST,
    "kex:ecdh-sha2-nistp521": NIST,
    "key:ecdsa-sha2-nistp256": NIST,
    "mac:hmac-sha2-256": NON_ETM,
    "mac:hmac-sha2-512": NON_ETM,
    "mac:umac-64@openssh.com": NON_ETM,
    "mac:umac-128@openssh.com": NON_ETM,
    "kex:diffie-hellman-group14-sha256":
      "The 2048-bit group14 exchange is OpenSSH 9.6's fallback for old clients; current clients never choose it.",
  },
  testssl: {
    OCSP_stapling:
      "OCSP stapling: Let's Encrypt ended its OCSP service in 2025, so there is nothing to staple.",
    certificate_transparency:
      "Certificate Transparency: every publicly trusted certificate is logged; testssl.sh only reports how.",
    DNS_CAArecord: "CAA records: OpsCrew manages and checks the app's CAA records itself.",
    HSTS_preload:
      "HSTS preload: joining the browsers' preload list is a separate decision, hard to undo, that OpsCrew leaves to you.",
  },
};

/** A result's id as the noise list names it: testssl.sh's ` <#1>` certificate suffix dropped. */
function noiseKey(id: string): string {
  return id.replace(/ <#\d+>$/, "");
}

/** `results` with each known-noise result of `tool` given its reason in `noise`. */
export function markNoise(results: CheckResult[], tool: DeepTool): CheckResult[] {
  const reasons = DEEP_NOISE[tool];
  return results.map((result) => {
    const reason = reasons[noiseKey(result.id)];
    return reason === undefined ? result : { ...result, noise: reason };
  });
}
