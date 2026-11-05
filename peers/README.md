# Authenticated peer connections

This folder owns the separate mutual-TLS listener, explicit certificate trust,
bounded status probes and protected local enrollment. It hosts the scoped artifact
exchange from ../exchange and explicit whole-request delegation from ../delegation.
It does not discover LAN machines or expose Ollama.

`identity.js` provisions logical node credentials; `configuration.js` validates
local trust; `server.js` authorizes inbound requests; `client.js` verifies outbound
connections; `runtime.js` handles startup/reload/probing; `cli.js` manages enrollment;
`files.js` protects and atomically writes node-owned local files.
`routes.js` owns fixed status/artifact/delegation paths, methods and required scopes;
`public_status.js` serializes aggregate status, including exchange counts.
Network locations stay in local configuration. Public health reports only
allowlisted aggregate peer counts, never certificates, endpoints or identifiers.

## Startup and deployment

Startup automatically creates `identity.json` (private key/certificate), public
`enrollment.json` and empty `trust.json`. Identity is a random logical installation
UUID, never an account, computer name or hardware identifier. P-256 certificates
carry only that logical UUID in subject/SAN, with no names, emails, DNS names or
IP addresses. Pinned `@peculiar/x509` and Node WebCrypto need no external CA,
OpenSSL executable or Windows certificate-store installation.

TLS 1.3 and client certificates are mandatory. Each self-signed leaf is an explicit
trust anchor; both ends also check the exact certificate fingerprint, generated
node identity and validity. The client replaces DNS identity checking with these
pin/subject/SAN checks while retaining chain/signature/expiry verification. Public
system CAs, shared fleet secrets, browser sessions and local inference tokens
grant no access. Every inbound request rechecks current trust and scopes.

Native listener defaults to loopback TCP 3447. Compose uses 3447 production and
3547 development, published on host loopback. `FRACTO_AI_PEER_LISTEN_HOST` selects
a local IP literal; `FRACTO_AI_PEER_PORT` selects a dedicated port, excluding the
AI HTTP ports and Ollama 11434. `FRACTO_AI_PEERS_ENABLED=false` disables peers.
`FRACTO_AI_PEER_DATA_DIR` selects dedicated private storage; default is
`<FRACTO_AI_DATA_DIR>/peers` when set, otherwise `runtime/peers`. Compose persists
it in the existing separate AI volumes. Never share a credential directory among
simultaneous installations or native/container/production/development instances.
Containers require an explicit data directory (provided by both Compose profiles).
They never fall back to the source tree: Windows-backed mounts can report private
POSIX modes while Windows ACLs still allow other readers. An older running
container without the new environment reports peer unavailable until recreated
through the normal build/start pipeline. Ordinary Fracto remains ready.

No discovery, trust-on-first-use, firewall opening or remote enrollment occurs.
An empty allowlist accepts no peer operation. To connect lab machines, select the
intended interface and restrict its firewall to approved peers. Compose host
publication uses `FRACTO_AI_PEER_BIND_ADDRESS` (production) or
`FRACTO_AI_DEV_PEER_BIND_ADDRESS` (development). Rebuild/recreate to apply ports
and dependencies. Both nginx examples block `/api/ai/peer/*`; connect directly
to the separate peer TLS port. Ollama stays private.

## Initial enrollment

Use the same process environment/data directory as the running service. Commands
do not load dotenv implicitly; use `node --env-file=.env peers/cli.js ...` if needed.
In Compose run `docker compose exec -T fracto node
servers/fracto-ai-server/peers/cli.js status` (or `fracto-dev` with both Compose files).

1. `node peers/cli.js status` displays the generated logical node ID, SHA-256
   certificate fingerprint, expiry and local trust counts. No secret or endpoint
   is printed. Startup writes the public `enrollment.json` next to private files.
2. Transfer only the public bundle through an approved administrative channel.
   Independently verify its fingerprint with the originating installation. A
   reachable endpoint or unverified file does not establish trust.
3. On each receiving installation run:

   ```text
   node peers/cli.js enroll <local-bundle.json> https://<approved-peer>:3447 <verified-SHA256-fingerprint>
   ```

   The fingerprint is mandatory. Default grant is `status:read` in both directions.
   To control directions append `<inbound-scopes> <outbound-scopes>` as comma-separated
   lists; use `-` for none. Each installation independently controls its grants.
   Enroll both sides to permit mutual connection checks.

4. Identity/trust reload every five seconds; connection checks then run automatically
   through subsequent startups without operator commands. Ordinary HTTP
   `/peers/status` exposes only aggregate state/counts and an expiring-cert flag.

Scopes are `status:read`, `artifacts:exchange`, `inference:delegate`,
`knowledge:exchange` and `skills:exchange`. The last two grant independent,
candidate-only distribution; see ../distribution/README.md for explicit
publication review, resumable pulls and local adoption. Upgrade both peers before
granting these new scopes. Existing grants are unchanged and do not share
knowledge or skill definitions. Status and
bounded artifact/metadata GET routes are implemented; see ../exchange/README.md.
Existing status-only grants share no artifacts or delegate work. The separate
`inference:delegate` grant enables fixed whole-request submission/status/cancel
routes in ../delegation/README.md. Arbitrary file, engine and unrestricted local
inference routes remain absent. There is no automatic peer/model selection.
Initial enrollment and deliberate trust changes are administrative operations;
normal startup/probing does not ask for approval or invent trust.

Version-1 `trust.json` has at most 16 entries, each containing exactly `node_id`,
`certificate`, `endpoint`, `inbound_scopes`, `outbound_scopes`, `revoked`. Endpoints
must be HTTPS origins with an explicit dedicated port, no credentials, paths,
queries or fragments. API requests cannot choose them. Unknown fields, duplicate
or self IDs, malformed/unexpected certificates and invalid scopes fail closed.

## Contract, bounds and failure isolation

`GET /peer/v1/status` requires `status:read`. Response fields are
version, service, random logical node ID, ready state and capabilities
(`status:true`, with artifact/delegation protocol availability flags). The client independently
validates the exact fields and expected identity before retaining local reachability.
The status route exchanges no inference content, raw logs, model metadata or
personal information. Artifact routes require the separate exchange scope and
validate their own bounded contracts; imported evidence never authorizes actions.
`public_status.js` serializes aggregate counts only. Network locations remain in
local configuration: requests use fixed Host `fracto-peer.invalid`, no SNI, body,
cookies, bearer credentials or identifying browser/device headers.

Limits: 32 TCP connections; TLS handshake three seconds; connection lifetime five
seconds; headers 4 KiB/16 fields; one request per socket. Per-peer HTTP bucket:
burst ten, refill one/second. Global TCP bucket: burst 32, refill eight/second.
Bounds reset on restart; no IP tracking or arbitrary-client maps are used. Unapproved bodies,
queries, browser credentials and unknown operations fail without echoing content.
Only the explicit delegation submission POST accepts a bounded 4096-byte JSON body;
its cancellation POST is bodyless. Other routes remain GET/bodyless.

One status/exchange background task runs at a time, choosing the oldest due work.
A separate bounded delegation worker submits or reconciles explicit requests;
at most two peer tasks can overlap. See ../delegation/README.md for its limits.
Status probes use a fixed route, 4096-byte response maximum, five seconds
including DNS/TLS/body. Redirects, compression, unexpected fields and certificate
or identity mismatch are rejected. No HTTP proxy environment or public CA fallback
is used. Polling runs every five seconds; success is eligible again after 30 seconds,
failures back off to at most five minutes. Serial scheduling can increase intervals
with many peers. `reachable_peers` means last probe success, not an open socket or
current availability guarantee.

Invalid trust/identity clears authorization, disconnects sockets, aborts probes and
reports unavailable rather than retaining old grants. Corrected files retry
automatically. Listener/configuration/peer failures never alter HTTP readiness or
local inference. Peer status requires no model, inference database, MySQL or peer.

## Revocation, rotation and recovery

`node peers/cli.js revoke <logical-node-UUID>` durably revokes that peer. Within
five seconds reload removes its TLS trust and closes sockets/probes. `forget
<logical-node-UUID>` removes the entry and withdraws trust. Re-enroll deliberately
with a verified new fingerprint. No remote administration API exists.

Certificates last 365 days; public `certificate_expiring` becomes true within
30 days of local expiry. `node peers/cli.js rotate` atomically replaces the key/cert,
preserves the logical ID and updates the public bundle, including recovery of an
expired local identity. Re-enroll the new bundle/pin on opposite installations;
old pins stop working. Rotation interrupts connections until enrollment agrees.
Overlapping pins and automatic trust migration are not implemented. Renewal is an
explicit trust change, not silent replacement of another node's allowlist. An
expired active trust entry makes configuration unavailable; revoke/forget or
re-enroll it to recover. Revoked expired entries remain non-authorizing records.

Writes use file fsync and atomic publication. Windows root ACLs allow only the
local service identity, SYSTEM and Administrators; POSIX directories/files use
0700/0600. Node cannot fsync a directory on Windows; durability remains subject to
filesystem guarantees, and malformed files fail closed. CLI mutations serialize
using `admin.lock`. After an administration command crashes, verify no such command
is running before removing that specific lock. Never reset private identity on error.

Back up the whole peer directory while stopped, preserving secret protection and
permissions. Restore only to the same logical installation with its old instance
stopped; never run clones of a private identity. Older backups may restore revoked
trust: reconcile revocations before reopening. Keep public enrollment separate
from private backups, and live credentials out of Git/image layers.

`../peers.test.js` checks real two-way TLS on Windows/Linux, unattended provisioning,
scopes, unknown/revoked/rotated/expired credentials, automatic reload/probes,
response bounds/deadlines, rate limits and privacy. Two local test nodes are verified;
the actual 48/64 GB lab installations still need approved endpoints and enrollment.
Scoped artifact exchange is implemented in ../exchange and explicit one-hop
whole-request delegation in ../delegation. The actual lab nodes still require
deployment, explicit grants, approved models and real-model measurements.

The HTTP bind-failure regression starts the real service asynchronously. It allows
up to 60 seconds for cold parallel initialization, then requires exit within
15 seconds after the bind-error marker. It still requires exit code 1, verifies
the expected listener failure and checks that the peer port is reusable. All
inference, peer, knowledge and skill stores are isolated under its temporary
directory; it never disables the peer runtime to avoid the cleanup check.
