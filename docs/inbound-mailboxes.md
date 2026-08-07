# Inbound mailboxes

Orkestr can receive isolated, inbound-only email addresses without changing the
primary domain's existing mail provider. Use a dedicated subdomain such as
`in.orkestr.de` and point only that subdomain's MX record at the Orkestr host.

## Architecture

- Postfix accepts SMTP for the dedicated mailbox subdomain.
- A loopback-only Postfix socket map checks recipients against the live Orkestr
  mailbox registry. Unknown, suspended, rotated, and deleted addresses are
  rejected before delivery.
- Accepted RFC822 messages are piped into the Orkestr MIME parser and existing
  scoped mailbox routing path.
- Main-instance messages enter the connector inbox. VM-targeted messages retain
  the exact VM target and use the relay/dead-letter lifecycle.
- The root domain MX is not changed.

## DNS

For `in.orkestr.de` on a host at `192.0.2.10`, create:

```text
A   mx.in   192.0.2.10
MX  in      10 mx.in.orkestr.de.
```

Do not replace the `orkestr.de` MX record.

## Installation

Deploy a release containing the adapter, then run:

```bash
sudo bash /opt/orkestr/current/scripts/install-postfix-mailbox.sh \
  --domain in.orkestr.de \
  --hostname mx.in.orkestr.de
```

The installer configures Postfix as an inbound-only destination, opens TCP 25
when UFW is present, installs `orkestr-mailbox-postfix.service`, and records the
production readiness variables in `/etc/orkestr/orkestr.env`.

The release train restarts and probes the socket-map service after future
release activations. It fails the deployment if an installed, active mailbox
service cannot restart or answer its protocol probe.

## Verification

```bash
orkestr mailboxes status --json
systemctl status postfix orkestr-mailbox-postfix --no-pager
node /opt/orkestr/current/scripts/orkestr-mailbox-postfix.mjs probe
```

Create a mailbox, send an external message, and confirm exactly one connector
inbox event while mailbox policy is off, exact listener delivery or durable
unrouted quarantine while it is enabled, or a VM relay event for VM targets.
Then rotate and delete the mailbox and verify that SMTP
rejects the old recipient.

## Rollback

Removing the subdomain MX immediately stops new Internet delivery. To disable
the local receiver while retaining state:

```bash
sudo systemctl disable --now postfix orkestr-mailbox-postfix
sudo ufw delete allow 25/tcp
```

Mailbox records and relay/dead-letter audit state remain under `ORKESTR_HOME`.
