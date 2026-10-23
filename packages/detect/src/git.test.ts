import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGitRemote, readGitInfo } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "git");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** Generated at runtime so no credential-shaped literal is ever committed. */
const fakeToken = () => `tok${randomBytes(12).toString("hex")}`;

describe("parseGitRemote", () => {
  it.each([
    [
      "https://github.com/acme/shop.git",
      {
        remoteUrl: "https://github.com/acme/shop.git",
        host: "github.com",
        owner: "acme",
        repo: "shop",
      },
    ],
    [
      "https://github.com/acme/shop",
      {
        remoteUrl: "https://github.com/acme/shop",
        host: "github.com",
        owner: "acme",
        repo: "shop",
      },
    ],
    [
      "git@github.com:acme/shop.git",
      {
        remoteUrl: "git@github.com:acme/shop.git",
        host: "github.com",
        owner: "acme",
        repo: "shop",
      },
    ],
    [
      "github.com:acme/shop",
      { remoteUrl: "github.com:acme/shop", host: "github.com", owner: "acme", repo: "shop" },
    ],
    [
      "ssh://git@GitHub.com:22/acme/shop.git/",
      {
        remoteUrl: "ssh://GitHub.com:22/acme/shop.git/",
        host: "github.com",
        owner: "acme",
        repo: "shop",
      },
    ],
    [
      "https://gitlab.com/group/sub/app.git",
      {
        remoteUrl: "https://gitlab.com/group/sub/app.git",
        host: "gitlab.com",
        owner: "group/sub",
        repo: "app",
      },
    ],
    [
      "git://example.org/solo.git",
      { remoteUrl: "git://example.org/solo.git", host: "example.org", repo: "solo" },
    ],
    ["file:///srv/repos/app.git", { remoteUrl: "file:///srv/repos/app.git" }],
    ["../other-repo", { remoteUrl: "../other-repo" }],
    ["C:\\repos\\app", { remoteUrl: "C:\\repos\\app" }],
  ])("parses %s", (url, expected) => {
    expect(parseGitRemote(url)).toEqual(expected);
  });

  it("strips user names, passwords and tokens in every form", () => {
    const token = fakeToken();
    const forms = [
      `https://x-access-token:${token}@github.com/acme/shop.git`,
      `https://${token}@github.com/acme/shop.git`,
      `https://user:${token}@github.com/acme/shop.git`,
      `https://user:p@ss${token}@github.com/acme/shop.git`,
      `https://github.com/acme/shop.git?access_token=${token}`,
      `https://github.com/acme/shop.git#${token}`,
    ];
    for (const url of forms) {
      const remote = parseGitRemote(url);
      expect(remote).toEqual({
        remoteUrl: "https://github.com/acme/shop.git",
        host: "github.com",
        owner: "acme",
        repo: "shop",
      });
      expect(JSON.stringify(remote)).not.toContain(token);
    }
    const scp = parseGitRemote(`${token}@github.com:acme/shop.git`);
    expect(scp.remoteUrl).toBe("github.com:acme/shop.git");
    expect(JSON.stringify(scp)).not.toContain(token);
  });
});

describe("readGitInfo", () => {
  it("returns {} when the directory is not a git checkout", async () => {
    expect(await readGitInfo(await tree({ "a.txt": "" }))).toEqual({});
  });

  it("reads origin, default branch and current branch from .git (CRLF, quotes, comments)", async () => {
    const root = await tree({
      ".git/config": [
        "[core]",
        "\trepositoryformatversion = 0",
        '[remote "upstream"]',
        "\turl = https://github.com/upstream/shop.git",
        '[remote "origin"]',
        '\turl = "git@github.com:acme/shop.git" ; primary',
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        "",
      ].join("\r\n"),
      ".git/HEAD": "ref: refs/heads/feature/login\r\n",
      ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
    });
    expect(await readGitInfo(root)).toEqual({
      remoteUrl: "git@github.com:acme/shop.git",
      owner: "acme",
      repo: "shop",
      defaultBranch: "main",
      currentBranch: "feature/login",
    });
  });

  it("falls back to the first remote and omits a detached HEAD", async () => {
    const root = await tree({
      ".git/config": '[remote "upstream"]\n  url = https://github.com/upstream/shop.git\n',
      ".git/HEAD": "0123456789abcdef0123456789abcdef01234567\n",
    });
    expect(await readGitInfo(root)).toEqual({
      remoteUrl: "https://github.com/upstream/shop.git",
      owner: "upstream",
      repo: "shop",
    });
  });

  it("never returns a token from the remote URL", async () => {
    const token = fakeToken();
    const root = await tree({
      ".git/config": `[remote "origin"]\n\turl = https://x-access-token:${token}@github.com/acme/shop.git\n`,
      ".git/HEAD": "ref: refs/heads/main\n",
    });
    const git = await readGitInfo(root);
    expect(git.remoteUrl).toBe("https://github.com/acme/shop.git");
    expect(JSON.stringify(git)).not.toContain(token);
  });

  it("follows a linked worktree .git file (absolute gitdir + commondir)", async () => {
    const main = await tree({
      ".git/config": '[remote "origin"]\n\turl = https://github.com/acme/shop.git\n',
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n",
      ".git/worktrees/wt1/HEAD": "ref: refs/heads/wt-branch\n",
      ".git/worktrees/wt1/commondir": "../..\n",
    });
    const worktree = await tree({
      ".git": `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`,
    });
    expect(await readGitInfo(worktree)).toEqual({
      remoteUrl: "https://github.com/acme/shop.git",
      owner: "acme",
      repo: "shop",
      defaultBranch: "trunk",
      currentBranch: "wt-branch",
    });
  });

  describe("without origin/HEAD (a repository pushed rather than cloned)", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const base = {
      ".git/config": '[remote "origin"]\n\turl = https://github.com/acme/shop.git\n',
      ".git/HEAD": "ref: refs/heads/opscrew/deploy-setup\n",
    };
    const defaultBranch = async (files: Record<string, string>) =>
      (await readGitInfo(await tree({ ...base, ...files }))).defaultBranch;

    it("takes main from a loose remote-tracking ref", async () => {
      expect(
        await defaultBranch({
          ".git/refs/remotes/origin/main": `${sha}\n`,
          ".git/refs/remotes/origin/master": `${sha}\n`,
        }),
      ).toBe("main");
    });

    it("takes main from packed-refs, skipping the header and peeled lines", async () => {
      expect(
        await defaultBranch({
          ".git/packed-refs": [
            "# pack-refs with: peeled fully-peeled sorted ",
            `${sha} refs/remotes/origin/feature/x`,
            `${sha} refs/remotes/origin/main`,
            `^${sha}`,
            `${sha} refs/remotes/upstream/master`,
            "",
          ].join("\n"),
        }),
      ).toBe("main");
    });

    it("takes master when origin has master but no main", async () => {
      expect(await defaultBranch({ ".git/refs/remotes/origin/master": `${sha}\n` })).toBe("master");
      expect(
        await defaultBranch({ ".git/packed-refs": `${sha} refs/remotes/origin/master\r\n` }),
      ).toBe("master");
    });

    it("leaves it unset when origin has neither main nor master", async () => {
      expect(
        await defaultBranch({
          ".git/refs/remotes/origin/develop": `${sha}\n`,
          ".git/packed-refs": `${sha} refs/remotes/upstream/main\n${sha} refs/heads/main\n`,
        }),
      ).toBeUndefined();
    });

    it("still prefers origin/HEAD when it is a symbolic ref", async () => {
      expect(
        await defaultBranch({
          ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n",
          ".git/refs/remotes/origin/main": `${sha}\n`,
        }),
      ).toBe("trunk");
      expect(
        await defaultBranch({
          ".git/refs/remotes/origin/HEAD": `${sha}\n`,
          ".git/refs/remotes/origin/master": `${sha}\n`,
        }),
      ).toBe("master");
    });
  });

  it("follows a relative gitdir without commondir (submodule layout)", async () => {
    const root = await tree({
      ".git/modules/lib/config": '[remote "origin"]\n\turl = https://github.com/acme/lib\n',
      ".git/modules/lib/HEAD": "ref: refs/heads/dev\n",
      "lib/.git": "gitdir: ../.git/modules/lib\n",
    });
    expect(await readGitInfo(join(root, "lib"))).toEqual({
      remoteUrl: "https://github.com/acme/lib",
      owner: "acme",
      repo: "lib",
      currentBranch: "dev",
    });
  });
});
