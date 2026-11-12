// Feature 027 (T2714): the SFTP connector's batch files, against the fake host.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { parseListing, quote } from "./batch";
import { batchWords, FakeSftpHost } from "./fake";
import { SftpFiles } from "./files";
import { readTar } from "./tar";

const LOGIN = {
  host: "sftp.example.com",
  port: 2222,
  user: "web",
  keyFile: "/keys/id_ed25519",
  knownHostsFile: "/state/known hosts",
};

/** The fake host and the connector on it, with predictable temporary names. */
function setup() {
  const host = new FakeSftpHost();
  let next = 0;
  const files = new SftpFiles(LOGIN, {
    runner: host,
    randomName: () => `r${++next}`,
  });
  return { host, files };
}

/** A ustar archive of `entries`, as OpsCrew's `tarStream` writes one. */
function tar(
  entries: { name: string; type: "0" | "2" | "5"; mode?: number; text?: string; target?: string }[],
): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(entry.type, 156);
    if (entry.target !== undefined) header.write(entry.target, 157, 100);
    header.write("ustar\u000000", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

describe("batch lines", () => {
  it("quotes every path so sftp reads it back whole, its patterns literal", () => {
    for (const path of ['a b/x*y "q".txt', "back\\slash\\", "[ab]?", "#not a comment", "it's"]) {
      expect(batchWords(`rm ${quote(path)}`)).toEqual(["rm", path]);
    }
    expect(quote('a "b"\\c')).toBe('"a \\"b\\"\\\\c"');
  });

  it("refuses a path with a line break or a NUL", () => {
    for (const path of ["a\nrm b", "a\rb", "a\0b"]) {
      expect(() => quote(path)).toThrow(/line break/);
    }
  });

  it("reads OpenSSH's long listing, a name with spaces and a year included", () => {
    const listing = [
      "drwxr-xr-x    ? 1000     1000         4096 Nov 13 10:00 opscrew/app/.",
      "lrwxrwxrwx    ? 1000     1000           12 Nov 13 10:00 opscrew/app/current",
      "-rw-r--r--    ? 1000     1000          100 Feb  2  2025 opscrew/app/a b.txt",
      "drwx--x--x    ? 0        0            4096 Nov 13 10:00 opscrew/app/releases",
      "sftp> ls -lan opscrew/app",
    ].join("\n");
    expect(parseListing(listing)).toEqual([
      { type: "dir", path: "opscrew/app/.", name: "." },
      { type: "link", path: "opscrew/app/current", name: "current" },
      { type: "file", path: "opscrew/app/a b.txt", name: "a b.txt" },
      { type: "dir", path: "opscrew/app/releases", name: "releases" },
    ]);
  });
});

describe("SftpFiles", () => {
  it("runs sftp in batch mode with the key and the pinned host key only", async () => {
    const { host, files } = setup();
    await files.list(".");
    expect(host.runs[0]?.args.slice(2)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      'UserKnownHostsFile="/state/known hosts"',
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      "/keys/id_ed25519",
      "-P",
      "2222",
      "web@sftp.example.com",
    ]);
  });

  it("writes a file under a temporary name with its mode, then renames it over the old one", async () => {
    const { host, files } = setup();
    host.write("app/shared/.env", "OLD=1\n");
    await files.writeFile("app/shared/.env", new TextEncoder().encode("NEW=2\n"), 0o600);
    expect(host.text("app/shared/.env")).toBe("NEW=2\n");
    expect(host.modeOf("app/shared/.env")).toBe(0o600);
    expect(host.paths("app/shared")).toEqual(["app/shared", "app/shared/.env"]);
    expect(host.runs[0]?.lines).toEqual([
      expect.stringMatching(/^@put ".*upload" "app\/shared\/\.opscrew-r1\.tmp"$/),
      '@chmod 600 "app/shared/.opscrew-r1.tmp"',
      '@rename "app/shared/.opscrew-r1.tmp" "app/shared/.env"',
    ]);
  });

  it("removes the temporary file when the rename fails, and says what failed", async () => {
    const { host, files } = setup();
    host.mkdir("app/shared/.env");
    host.write("app/shared/.env/inside", "x");
    const error = await files
      .writeFile("app/shared/.env", new TextEncoder().encode("A=1\n"), 0o600)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      'The SFTP host at sftp.example.com (port 2222) refused to write app/shared/.env: remote rename "/home/web/app/shared/.opscrew-r1.tmp" to "/home/web/app/shared/.env": Failure.',
    );
    expect(host.paths("app/shared")).toEqual([
      "app/shared",
      "app/shared/.env",
      "app/shared/.env/inside",
    ]);
  });

  it("refuses a path with a line break or .. before anything is sent", async () => {
    const { host, files } = setup();
    for (const path of ["app/x\nrm -r app", "app/../etc/passwd", "app//x", ""]) {
      await expect(files.writeFile(path, new Uint8Array(), 0o600)).rejects.toThrow(OpsCrewError);
      await expect(files.readFile(path)).rejects.toThrow(OpsCrewError);
      await expect(files.remove(path)).rejects.toThrow(OpsCrewError);
    }
    expect(host.runs).toEqual([]);
  });

  it("reads a small file, and nothing for one that isn't there", async () => {
    const { host, files } = setup();
    host.write("app/state/status", "running=812-1\n");
    expect(await files.readFile("app/state/status")).toBe("running=812-1\n");
    expect(await files.readFile("app/state/missing")).toBeUndefined();
    expect(await files.readFile("nowhere/status")).toBeUndefined();
  });

  it("lists a folder's names, hidden ones included, and nothing for one that isn't there", async () => {
    const { host, files } = setup();
    host.write("app/releases/812-1/index.php", "<?php");
    host.write("app/releases/.hidden", "");
    expect(await files.list("app/releases")).toEqual([".hidden", "812-1"]);
    expect(await files.list("app/none")).toBeUndefined();
  });

  it("unpacks an archive: folders made with their modes, files and links renamed into place", async () => {
    const { host, files } = setup();
    host.mkdir("existing");
    await files.uploadTar(
      "opscrew/notes-prod",
      tar([
        { name: "releases/", type: "5", mode: 0o711 },
        { name: "releases/0-0/", type: "5", mode: 0o711 },
        { name: "state/", type: "5", mode: 0o700 },
        { name: "settings.sh", type: "0", mode: 0o600, text: "APP='notes'\n" },
        { name: "current", type: "2", target: "releases/0-0" },
      ]),
    );
    expect(host.modeOf("opscrew/notes-prod/releases")).toBe(0o711);
    expect(host.modeOf("opscrew/notes-prod/state")).toBe(0o700);
    expect(host.text("opscrew/notes-prod/settings.sh")).toBe("APP='notes'\n");
    expect(host.modeOf("opscrew/notes-prod/settings.sh")).toBe(0o600);
    expect(host.readlink("opscrew/notes-prod/current")).toBe("releases/0-0");
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0]?.lines.slice(0, 2)).toEqual([
      '-@mkdir "opscrew"',
      '-@mkdir "opscrew/notes-prod"',
    ]);
  });

  it("refuses an archive entry that leaves its folder", () => {
    expect(() => readTar(tar([{ name: "../x", type: "0" }]))).toThrow(/leaves its folder/);
    expect(() => readTar(tar([{ name: "/etc/x", type: "0" }]))).toThrow(/leaves its folder/);
  });

  it("switches a link in one rename, from a new link beside it", async () => {
    const { host, files } = setup();
    host.mkdir("app/releases/1-1");
    host.mkdir("app/releases/2-1");
    await files.link("app/current", "releases/1-1");
    await files.link("app/current", "releases/2-1");
    expect(host.readlink("app/current")).toBe("releases/2-1");
    expect(host.runs[1]?.lines).toEqual([
      '@ln -s "releases/2-1" "app/.opscrew-r2.link"',
      '@rename "app/.opscrew-r2.link" "app/current"',
    ]);
    expect(host.paths("app").filter((path) => path.includes(".opscrew"))).toEqual([]);
  });

  it("removes a folder with everything in it, a level at a time, without following a link", async () => {
    const { host, files } = setup();
    host.write("keep/precious.txt", "mine");
    host.write("app/releases/1-1/public/index.php", "<?php");
    host.write("app/releases/1-1/a b/x*y.txt", "odd");
    host.write("app/shared/.env", "A=1\n");
    host.nodes.set("app/current", { type: "link", target: "releases/1-1" });
    host.nodes.set("app/escape", { type: "link", target: "../keep" });
    await files.remove("app");
    expect(host.paths()).toEqual(["keep", "keep/precious.txt"]);
    // The parent's listing, then one listing per level, then one batch of removals.
    expect(host.runs.map((run) => run.lines[0]?.split(" ")[0])).toEqual([
      "@ls",
      "@ls",
      "@ls",
      "@ls",
      "@ls",
      "@rm",
    ]);
  });

  it("removes a link itself, and counts a path that isn't there as removed", async () => {
    const { host, files } = setup();
    host.write("keep/precious.txt", "mine");
    host.nodes.set("current", { type: "link", target: "keep" });
    await files.remove("current");
    await files.remove("never/was");
    expect(host.paths()).toEqual(["keep", "keep/precious.txt"]);
  });

  it("says when the host presents another key, refuses the key, or can't be reached", async () => {
    const { host, files } = setup();
    const said = async (stderr: string, exitCode = 255) => {
      host.connectionFailure = { exitCode, stderr };
      return files.list(".").catch((error: OpsCrewError) => [error.code, error.message]);
    };
    expect(
      await said(
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\nConnection closed",
      ),
    ).toEqual([
      "PHASE_PRECONDITION",
      "The SFTP host at sftp.example.com (port 2222) didn't present the host key you confirmed, so OpsCrew sent nothing.",
    ]);
    expect(
      await said("web@sftp.example.com: Permission denied (publickey).\nConnection closed"),
    ).toEqual([
      "CREDENTIALS_INVALID",
      "The SFTP host at sftp.example.com (port 2222) refused the key /keys/id_ed25519 for web.",
    ]);
    expect(
      await said(
        "ssh: connect to host sftp.example.com port 2222: Connection refused\nConnection closed",
      ),
    ).toEqual([
      "PROVIDER_ERROR",
      "OpsCrew couldn't list . over SFTP at sftp.example.com (port 2222): ssh: connect to host sftp.example.com port 2222: Connection refused.",
    ]);
  });

  it("refuses a login that sftp would read as an option", () => {
    for (const login of [
      { ...LOGIN, host: "-oProxyCommand=x" },
      { ...LOGIN, user: "-oProxyCommand=x" },
      { ...LOGIN, host: "a b" },
      { ...LOGIN, port: 0 },
    ]) {
      expect(() => new SftpFiles(login, { runner: new FakeSftpHost() })).toThrow(OpsCrewError);
    }
  });

  it("writes this computer's side of a run into the given folder, and removes it after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-sftp-test-"));
    const host = new FakeSftpHost();
    const files = new SftpFiles(LOGIN, { runner: host, tempDir: dir });
    await writeFile(join(dir, "mine"), "");
    await files.writeFile("x", new TextEncoder().encode("1"), 0o644);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["mine"]);
  });
});
