import { describe, expect, it } from "vitest";
import { foreignFirewalls, foreignIptables, foreignNft } from "./firewall";
import {
  dockerdFlags,
  engineVersion,
  isLoopback,
  isPublicAddress,
  parseAddresses,
  parseAptPeriodic,
  parseContainers,
  parseDf,
  parseDirs,
  parseDpkg,
  parseFree,
  parseNsswitchPasswd,
  parseOsRelease,
  parseSs,
  parseSshdT,
  parseUfwAdded,
  parseUfwDefaults,
  parseUsers,
  publishesPort,
  splitSections,
  ufwRuleCovers,
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
    const [caddy, old] = parseContainers(
      "shop-caddy-1|shop|0.0.0.0:80->80/tcp, :::80->80/tcp|running\nold-db-1|old||exited",
    );
    expect(caddy).toEqual({
      name: "shop-caddy-1",
      project: "shop",
      ports: "0.0.0.0:80->80/tcp, :::80->80/tcp",
      running: true,
    });
    expect(old).toEqual({ name: "old-db-1", project: "old", ports: "", running: false });
    expect(publishesPort(caddy?.ports ?? "", 80)).toBe(true);
    expect(publishesPort("127.0.0.1:18080->80/tcp", 18080)).toBe(false);
    expect(publishesPort("127.0.0.1:18080->80/tcp", 18080, true)).toBe(true);
    expect(publishesPort("0.0.0.0:8000-8100->8000-8100/tcp", 8080)).toBe(true);
  });

  it("reads global addresses of real interfaces and tells public from private", () => {
    const addresses = parseAddresses(
      [
        "2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic eth0\\       valid_lft 86000sec",
        "2: eth0    inet6 2a01:4f8:c0c:1::1/64 scope global \\       valid_lft forever preferred_lft forever",
        "2: eth0    inet6 fd00::5/64 scope global dynamic mngtmpaddr \\       valid_lft 1sec",
        "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever",
        "4: tailscale0    inet 100.101.102.103/32 scope global tailscale0\\       valid_lft forever",
        "5: ens3@if7    inet 8.8.4.4/32 scope global ens3\\       valid_lft forever",
      ].join("\n"),
    );
    expect(addresses).toEqual([
      { interface: "eth0", family: "ipv4", address: "192.168.1.20", public: false },
      { interface: "eth0", family: "ipv6", address: "2a01:4f8:c0c:1::1", public: true },
      { interface: "eth0", family: "ipv6", address: "fd00::5", public: false },
      { interface: "ens3", family: "ipv4", address: "8.8.4.4", public: true },
    ]);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("fe80::1")).toBe(false);
  });

  it("finds directory services in nsswitch, ufw's default policies and dockerd flags", () => {
    expect(parseNsswitchPasswd("passwd:         files systemd sss [NOTFOUND=return] ldap")).toEqual(
      ["sss", "ldap"],
    );
    expect(parseNsswitchPasswd("passwd:         files systemd")).toEqual([]);
    expect(
      parseUfwDefaults(
        'DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="REJECT"',
      ),
    ).toEqual({ incoming: "deny", outgoing: "allow", routed: "reject" });
    expect(parseUfwDefaults("")).toBeNull();
    expect(
      dockerdFlags(
        "ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// --log-driver=journald --live-restore ; }",
      ),
    ).toEqual(["--log-driver", "--live-restore"]);
    expect(dockerdFlags("ExecStart={ argv[]=/usr/bin/dockerd -H fd:// }")).toEqual([]);
  });

  it("tells which ufw rules let a port in, and from where", () => {
    const covers = (rule: string, port = 22) => ufwRuleCovers(rule, port, "tcp");
    expect(covers("allow 22/tcp")).toEqual({
      covers: true,
      limitedSource: false,
      rateLimited: false,
    });
    expect(covers("allow 22")).toMatchObject({ covers: true });
    expect(covers("limit 22/tcp")).toEqual({
      covers: true,
      limitedSource: false,
      rateLimited: true,
    });
    expect(covers("allow OpenSSH")).toMatchObject({ covers: true });
    expect(covers("limit ssh")).toMatchObject({ covers: true, rateLimited: true });
    expect(covers("allow 2200:2300/tcp", 2222)).toMatchObject({ covers: true });
    expect(covers("allow 22,80/tcp")).toMatchObject({ covers: true });
    expect(covers("allow 22/udp")).toMatchObject({ covers: false });
    expect(covers("deny 22/tcp")).toMatchObject({ covers: false });
    expect(covers("allow out 22/tcp")).toMatchObject({ covers: false });
    expect(covers("allow from 10.0.0.0/8 to any port 22 proto tcp")).toEqual({
      covers: true,
      limitedSource: true,
      rateLimited: false,
    });
    expect(covers("allow proto tcp from any to any port 22")).toMatchObject({
      covers: true,
      limitedSource: false,
    });
    expect(covers("allow from 192.168.1.0/24")).toMatchObject({
      covers: true,
      limitedSource: true,
    });
    expect(covers("allow in on wg0 to any port 22")).toMatchObject({
      covers: true,
      limitedSource: true,
    });
    expect(covers("allow from 10.0.0.0/8 to any port 80")).toMatchObject({ covers: false });
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
