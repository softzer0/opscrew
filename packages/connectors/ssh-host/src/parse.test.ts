import { describe, expect, it } from "vitest";
import { foreignFirewalls, foreignIptables, foreignNft } from "./firewall";
import {
  engineVersion,
  isLoopback,
  parseAptPeriodic,
  parseContainers,
  parseDf,
  parseDirs,
  parseDpkg,
  parseFree,
  parseOsRelease,
  parseSs,
  parseSshdT,
  parseUfwAdded,
  parseUsers,
  publishesPort,
  splitSections,
} from "./parse";

describe("splitSections", () => {
  it("splits the inspection output into sections with exit codes", () => {
    const out =
      "\n@@opscrew-section a\none\ntwo\n\n@@opscrew-exit 0\n\n@@opscrew-section b\n\n@@opscrew-exit 127\n";
    const sections = splitSections(out);
    expect(sections.get("a")).toEqual({ text: "one\ntwo", exit: 0 });
    expect(sections.get("b")).toEqual({ text: "", exit: 127 });
  });
});

describe("parsers", () => {
  it("reads os-release, preferring UBUNTU_CODENAME", () => {
    const os = parseOsRelease(
      'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble',
    );
    expect(os).toEqual({
      id: "ubuntu",
      idLike: "debian",
      versionId: "24.04",
      codename: "noble",
      prettyName: "Ubuntu 24.04.3 LTS",
    });
    expect(parseOsRelease('ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie').codename).toBe(
      "trixie",
    );
  });

  it("reads memory and disk", () => {
    expect(
      parseFree(
        "               total        used        free      shared  buff/cache   available\nMem:      4000000000  1  2  3  4  3000000000\nSwap: 0 0 0",
      ),
    ).toEqual({ total: 4_000_000_000, available: 3_000_000_000 });
    expect(
      parseDf(
        "Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 80000 20000 60000 25% /",
      ),
    ).toEqual({ size: 80000, available: 60000 });
  });

  it("reads sshd -T and normalises without-password", () => {
    const sshd = parseSshdT(
      "port 22\nport 2222\npermitrootlogin without-password\npasswordauthentication no\nkbdinteractiveauthentication no\nauthenticationmethods any\nallowusers alice\nallowusers bob@10.0.0.*\nauthorizedkeyscommand none",
    );
    expect(sshd).toMatchObject({
      ports: [22, 2222],
      permitRootLogin: "prohibit-password",
      passwordAuthentication: false,
      kbdInteractiveAuthentication: false,
      allowUsers: ["alice", "bob@10.0.0.*"],
      authorizedKeysCommand: false,
    });
    expect(parseSshdT("")).toBeNull();
  });

  it("reads listeners from ss", () => {
    const listeners = parseSs(
      [
        'tcp   LISTEN 0      4096       0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1,fd=3))',
        'tcp   LISTEN 0      511          [::]:80            [::]:*    users:(("nginx",pid=2,fd=6),("nginx",pid=3,fd=6))',
        'udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=4,fd=13))',
      ].join("\n"),
    );
    expect(listeners).toEqual([
      { proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
      { proto: "tcp", address: "[::]", port: 80, process: "nginx" },
      { proto: "udp", address: "127.0.0.53%lo", port: 53, process: "systemd-resolve" },
    ]);
    expect(isLoopback("127.0.0.53%lo")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("[::]")).toBe(false);
  });

  it("reads ufw rules with comments", () => {
    expect(
      parseUfwAdded(
        "Added user rules (see 'ufw status' for running firewall):\nufw allow 22/tcp comment 'opscrew-ssh'\nufw allow 8080\n(None)",
      ),
    ).toEqual([
      { rule: "allow 22/tcp", comment: "opscrew-ssh" },
      { rule: "allow 8080", comment: null },
    ]);
  });

  it("reads installed packages and Docker versions", () => {
    const packages = parseDpkg(
      "docker-ce|install ok installed|5:28.5.1-1~ubuntu.24.04~noble\nufw|deinstall ok config-files|0.36\ncurl|hold ok installed|8.5.0",
    );
    expect([...packages.keys()]).toEqual(["docker-ce", "curl"]);
    expect(engineVersion("5:28.5.1-1~ubuntu.24.04~noble")).toBe("28.5.1");
    expect(engineVersion("27.3.1-1")).toBe("27.3.1");
  });

  it("reads containers and their published ports", () => {
    const [caddy] = parseContainers("shop-caddy-1|shop|0.0.0.0:80->80/tcp, :::80->80/tcp");
    expect(caddy).toEqual({
      name: "shop-caddy-1",
      project: "shop",
      ports: "0.0.0.0:80->80/tcp, :::80->80/tcp",
    });
    expect(publishesPort(caddy?.ports ?? "", 80)).toBe(true);
    expect(publishesPort("127.0.0.1:18080->80/tcp", 18080)).toBe(false);
    expect(publishesPort("127.0.0.1:18080->80/tcp", 18080, true)).toBe(true);
    expect(publishesPort("0.0.0.0:8000-8100->8000-8100/tcp", 8080)).toBe(true);
  });

  it("reads users, dirs and apt settings", () => {
    expect(parseUsers("root:0:pw:keys\nalice:1000:pw:nokeys")).toEqual([
      { name: "root", uid: 0, password: true, keys: true },
      { name: "alice", uid: 1000, password: true, keys: false },
    ]);
    expect(
      parseDirs("/srv/app dir deploy deploy 750 3\n/srv/data absent", ["/srv/app", "/srv/data"]),
    ).toEqual([
      { path: "/srv/app", kind: "dir", owner: "deploy", group: "deploy", mode: "750", entries: 3 },
      { path: "/srv/data", kind: "absent" },
    ]);
    expect(
      parseAptPeriodic(
        'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";',
      ),
    ).toBe(true);
    expect(
      parseAptPeriodic(
        'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::Unattended-Upgrade "0";',
      ),
    ).toBe(false);
  });
});

describe("other firewalls", () => {
  const ufwActive = `*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
:ufw-before-input - [0:0]
:DOCKER-USER - [0:0]
-A INPUT -j ufw-before-logging-input
-A INPUT -j ufw-before-input
-A INPUT -j f2b-sshd
-A INPUT -m set --match-set crowdsec-blacklists src -j DROP
-A FORWARD -j DOCKER-USER
COMMIT`;

  it("does not count ufw, Docker, fail2ban or CrowdSec rules", () => {
    expect(foreignIptables(ufwActive, true, "iptables")).toEqual([]);
  });

  it("finds INPUT rules ufw does not manage (an Oracle Cloud style image)", () => {
    const oracle = `*filter
:INPUT ACCEPT [0:0]
-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
COMMIT`;
    expect(foreignIptables(oracle, false, "iptables")).toEqual([
      "iptables has 3 rules in the INPUT chain that ufw does not manage",
    ]);
  });

  it("finds a DROP policy while ufw is off", () => {
    expect(foreignIptables("*filter\n:INPUT DROP [0:0]\nCOMMIT", false, "ip6tables")).toEqual([
      "ip6tables drops incoming traffic by default (INPUT policy DROP)",
    ]);
  });

  it("finds native nftables input filtering but not an empty default table", () => {
    const debianDefault = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
	}
	chain forward {
		type filter hook forward priority filter; policy accept;
	}
}`;
    expect(foreignNft(debianDefault)).toEqual([]);
    const strict = `table inet filter {
	set allowed {
		type ipv4_addr
		elements = { 10.0.0.1 }
	}
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		tcp dport 22 accept
	}
}
table ip docker-bridges {
	chain filter-forward {
		type filter hook forward priority filter; policy accept;
		drop
	}
}`;
    expect(foreignNft(strict)).toEqual(["nftables table inet filter filters incoming traffic"]);
  });

  it("names firewalld and the nftables service", () => {
    const units = new Map([
      ["firewalld", "active"],
      ["nftables", "active"],
    ]);
    expect(
      foreignFirewalls({ units, ufwActive: false, iptables: "", ip6tables: "", nft: "" }),
    ).toEqual([
      "firewalld is running",
      "the nftables service is active (it loads /etc/nftables.conf)",
    ]);
  });
});
