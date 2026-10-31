# Close public SSH

SSH is how OpsCrew, the deploy workflow and you reach your servers. By default it answers on each
server's public address, limited only by the allow-list in `opscrew/plan.yaml`
(`security.sshAllowedCidrs`, which most people leave open to everyone). It is the largest remaining
way in that an attacker can try.

Once your deploys and your computer reach the servers from inside the app's
[private network](private-network.md), public SSH can close: SSH then answers only on the network,
and nothing on the internet sees port 22.

## The two conditions

OpsCrew closes public SSH only when both hold, so that neither the deploys nor you are locked out:

1. **The deploys run inside the network:** the environment's deploy job runs on the
   [server's own runner](runners.md) (or on this computer's, when this computer is a device on the
   network), not on GitHub's machines or a runner machine elsewhere. Move it to the server with:

   ```bash
   npx opscrew env set prod --runner server
   npx opscrew provision
   ```

2. **This computer is a device on the network,** with its tunnel on:

   ```bash
   npx opscrew vpn add laptop --this-computer
   ```

   then import the configuration into the WireGuard app and turn the tunnel on. OpsCrew checks that
   the tunnel had a handshake with every server in the last 3 minutes.

When one is missing, OpsCrew refuses, says which one and how to meet it, and changes nothing.

## Close it

```bash
npx opscrew secure --close-public-ssh
```

1. OpsCrew first logs in to each server over the private network, to prove it can still reach them
   once public SSH is closed.
2. It keeps the allow-list you had (in `network.publicSshAllowedCidrs`) and empties
   `security.sshAllowedCidrs`.
3. `provision` runs: the infrastructure plan that removes SSH from the cloud firewalls of the servers
   OpsCrew created, and the deploy workflow and [scheduled check](alerts.md) for the private
   network, in a pull request.
4. Each server's host plan removes the public SSH rules from its firewall and keeps SSH open on the
   private network. It runs under the same safeguard as every SSH change OpsCrew makes: if the
   connection is lost, the server puts the previous SSH settings back by itself after 3 minutes.

Each plan is approved by its hash. In scripts, each stops with its hash and
`npx opscrew secure --close-public-ssh --approve <hash>` continues; running it again after a stop
continues where it stopped.

## Afterwards

- **Every OpsCrew command** that reaches a server (`status`, `logs`, `drift`, `secure`, `provision`,
  `destroy` …) connects over the private network. When this computer's tunnel is down, it says so
  plainly: turn the tunnel on and run the command again.
- **Pushes still deploy:** the server's own runner deploys from inside.
- **You log in** with `ssh deploy@<the server's private address>` (the addresses are in
  `opscrew/plan.yaml` under `network.members`), with the tunnel on.
- **`npx opscrew status`** says that public SSH is closed.

## Open it again

```bash
npx opscrew secure --open-public-ssh
```

Each server's host plan, then the cloud firewalls, open SSH again to the allow-list the plan held
before it closed. Each plan is approved by its hash, as when closing.

## Getting back in when this computer's configuration is lost

With public SSH closed, this computer reaches the servers only through its tunnel. If its WireGuard
configuration is gone (a new computer, a reinstalled system), there are two ways back.

### From another device on the network

Use another computer that is a device on the app's network and has this project's OpsCrew files
(its own, or restored from the [recovery copy](secrets-recovery.md#restoring-on-a-new-computer)).
With its tunnel on, run there:

```bash
npx opscrew secure --open-public-ssh
```

Then, on this computer (with this project's OpsCrew files, restored from the recovery copy if they
are gone too), add it again and close public SSH again:

```bash
npx opscrew vpn add laptop --again --this-computer
npx opscrew secure --close-public-ssh
```

Keep a second device on the network (a phone is enough to hold a configuration, but it can't run
OpsCrew) before you close public SSH, so this way stays open to you.

### From the provider's console

Every provider lets you log in on a server's own screen from its website, without SSH:

- **Hetzner Cloud:** open the server in the Hetzner Console, reset the root password under
  **Rescue**, then open the **Console** and log in as `root`.
- **DigitalOcean:** open the Droplet, reset the root password under **Access**, then launch the
  **Recovery Console** and log in as `root`.
- **A server you already have:** your provider's console, or a keyboard and screen.

On each server of the app, allow SSH again in its firewall:

```bash
ufw allow 22/tcp
```

(on a server you already have, the SSH port your login uses, from your own address). On a server
OpsCrew created, also add an inbound rule for TCP port 22 to its firewall in the provider's website
(Hetzner: **Firewalls**; DigitalOcean: **Networking**, **Firewalls**).

Then, on this computer:

```bash
npx opscrew secure --open-public-ssh                 # opens public SSH again everywhere
npx opscrew vpn add laptop --again --this-computer   # a new configuration for this computer
npx opscrew secure --close-public-ssh                # close it again, if you want, with the tunnel on
```

With this computer's tunnel down and port 22 answering on a server's public address,
`--open-public-ssh` connects there instead of over the private network. It puts back the
allow-list the plan held before public SSH closed, on every server and in the cloud firewalls, so
the rules you added by hand are replaced by OpsCrew's own.

Reset the root password again afterwards if you don't want one set.

## What can go wrong

- **"OpsCrew can't close public SSH yet":** a condition above is missing; the message says which.
- **OpsCrew can't log in over the private network:** the tunnel is off, or the servers don't let SSH
  in on the network yet. Turn the tunnel on and check it with `npx opscrew vpn list`; if it shows a
  recent handshake, run `npx opscrew provision` first, which opens SSH on the network's interface.
- **Removing this computer's device** (`vpn remove`), or giving it a new key (`vpn add --again`),
  while public SSH is closed would cut this computer off: OpsCrew refuses. Open public SSH first, or
  run it from another device on the network.
