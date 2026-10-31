# Your devices on the private network

Each OpsCrew app has a private WireGuard network that links its servers (see
[split placement](split-placement.md)). Your laptop and your phone can join it too. With the tunnel
on, you reach each server's SSH, and the dashboards of [Beszel](beszel.md) and
[Portainer](portainer.md), on the network's private addresses: no SSH tunnel, and no dashboard on the
internet. Once this computer is on it, you can also [close public SSH](public-ssh.md).

This works for an app on one server too: the first device creates the network. It works on servers
OpsCrew created on Hetzner Cloud or DigitalOcean and on [servers you already have](own-server.md),
not on a Portainer, your computer or the server-less targets.

It costs nothing: WireGuard is free and open source, and OpsCrew needs no account and no third
party.

## Add a device

```bash
npx opscrew vpn add laptop --this-computer   # this computer
npx opscrew vpn add phone --qr               # a phone: shows a QR code to scan
```

OpsCrew:

1. makes the device's key on this computer;
2. shows the host plan for each server with a public address, which adds the device there, and
   applies it once you approve its hash;
3. writes the device's WireGuard configuration to a file only you can read:
   `~/.opscrew/projects/<project>/vpn/prod-laptop.conf` (another environment's in
   `~/.opscrew/projects/<project>/environments/<env>/vpn/<env>-<device>.conf`);
4. with `--qr`, also shows it as a QR code in the terminal.

The device's private key is only in that file (and in the QR code you asked for): never in a plan,
your repository, a log or OpsCrew's audit log. OpsCrew keeps only its public key and its address,
such as `10.200.4.100`, in `opscrew/plan.yaml`.

- **`--this-computer`** tells OpsCrew that this computer is that device, so its commands can reach
  the servers over the network, and point you to the private addresses of the dashboards.
- **A device's name** is up to 32 lower-case letters, digits or hyphens, such as `laptop` or
  `phone`.
- **The first device of an app on a server OpsCrew created:** the provider's firewall doesn't let
  the network's UDP port in yet. OpsCrew says so: run `npx opscrew provision`, which shows the
  infrastructure plan that opens it, before you turn the tunnel on.

Each app and each [environment](environments.md) has its own network, so a device on staging can't
reach prod. A device that should reach several apps is added to each, with one tunnel per app.

## Turn the tunnel on

Use the official WireGuard app, from [wireguard.com/install](https://www.wireguard.com/install/):

- **Windows and macOS:** open the app, choose **Import tunnel(s) from file**, pick the `.conf` file,
  and turn the tunnel on.
- **iPhone and Android:** add a tunnel, choose to scan a QR code, and scan the one
  `npx opscrew vpn add phone --qr` shows. Close the terminal afterwards: the code holds the phone's
  key.
- **Linux:** install `wireguard-tools`, copy the file to `/etc/wireguard/` under a short name (such
  as `opscrew.conf`), and run `sudo wg-quick up opscrew`.

Only the network's addresses go through the tunnel; the rest of your traffic doesn't change. With
the tunnel on:

```bash
ssh deploy@10.200.4.1          # the app's server; its private address is in opscrew/plan.yaml
```

Moving a configuration to another device: keep it off email and chat, since it holds the device's
key. Better, run `vpn add` for each device, with `--qr` for phones.

## The dashboards

After the first device joins, Beszel's dashboard and Portainer's web UI can answer on the app's
server's private address too, for your devices only. OpsCrew says what to run to put them there:
`npx opscrew addon enable beszel` again for Beszel, and `npx opscrew portainer enable` again for
Portainer (`npx opscrew provision` on a server you already have). From then on,
`npx opscrew addon open beszel` and `npx opscrew portainer status` give you the private address to
open instead of starting an SSH tunnel, when this computer is on the network and the app's server
is one OpsCrew created.

A device reaches the servers' SSH and these dashboards, nothing else: the app's databases and
caches answer a device only when you [grant it access](database-access.md).

## List and remove devices

```bash
npx opscrew vpn list
```

shows each device with its address and when it last connected to each server, and the network's
address range.

```bash
npx opscrew vpn remove phone
```

takes the device off every server through a host plan you approve. Its tunnel can't connect to any
server afterwards. Remove a lost or stolen device this way at once. A device that still has a
[database login](database-access.md) is refused until you revoke it.

## When a server is added

A device's configuration lists the servers the app had when it was written. After a new server
joins, `npx opscrew vpn list` says which connected devices don't reach it. Write a new configuration for such a
device:

```bash
npx opscrew vpn add laptop --again
```

It makes a new key, so import the new file (or scan the new QR code with `--qr`) and delete the old
tunnel. Running `vpn add` for a device that exists, without `--again`, writes no new configuration:
OpsCrew keeps no copy of a device's key, so it can't show an old configuration again.

## What can go wrong

- **The tunnel is on, but nothing answers:** `npx opscrew vpn list` shows when the device last
  connected to each server. No handshake usually means the network's UDP port is blocked: by the
  provider's firewall (run `npx opscrew provision` after adding the first device), by a firewall in
  front of a server you already have, or by the network you are on.
- **The address range clashes with your own network:** if your home or office network uses the
  same range, change `network.range` in `opscrew/plan.yaml` before the first provision (see
  [split placement](split-placement.md#what-can-go-wrong)).
- **The app's server has no public address** (a server of yours reached through a Cloudflare
  Tunnel): devices connect only to servers the internet reaches, so `vpn add` refuses when the app
  has no such server.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) can list the network's devices with their addresses.
Adding a device makes a private key, so it stays a command you run in your terminal: the plugin
tells you to run `npx opscrew vpn add`, and never handles the key.
