# Development and validation

## Structure

```text
src/
  index.ts       Pi tool registration and session lifecycle
  config.ts      Session mappings, token generation and protected storage
  transport.ts   Bounded authenticated raw-body HTTP listener
  delivery.ts    Volatile FIFO and model-context trust notices
  runtime.ts     Listener/tunnel ownership and lifecycle guards
  tunnel.ts      Owned cloudflared launcher and readiness observation
  ownership.ts   Cleanup fence retained across extension reload
scripts/         Explicit maintainer utilities; never automatic startup
tests/           Loopback, synthetic transport and real Pi SDK tests
```

The transport/runtime separation follows Pi Intercom's approach. Session ownership, stale-work checks and explicit cleanup follow patterns used in Pi Telegram. Neither sibling project is a runtime dependency.

## Local validation

```sh
npm ci
npm run validate
npm run pack:check
```

The normal suite uses temporary directories, loopback sockets, fake connector processes and local deterministic model streams. It never opens a public tunnel or sends a hosted-model request.

Coverage includes:

- Unmapped and disabled no-op; persistent-session requirement.
- Authentication, raw UTF-8/BOM preservation and 64 KiB limits.
- Occupied fixed ports and exact-session mismatches.
- Credential rotation/retrieval and ordinary status redaction.
- Bounded waiting, idle/busy behavior and asynchronous submission uncertainty.
- Disable/discard, reload, new session, resume and fork using real Pi SDK runtimes.
- Late listener/tunnel startup, uncertain cleanup and reload fencing.
- Both connector credential modes and secret-file argument boundaries.
- Pi's actual file loader and distributable package contents.

The initial implementation passed 25 tests on Linux with Node 22 and Pi 1.4.0. CI checks supported development Node versions; a successful mocked connector test is not a live Cloudflare guarantee.

## Optional live local + tunnel test

This utility deliberately starts a local listener and a real Cloudflare connector. Run it **only against a hostname, tunnel and port you own and are authorized to expose**. Normal `npm test` and CI never run it.

Prerequisites:

1. Install cloudflared with `--token-file` support.
2. Provision a remotely managed named tunnel and public hostname.
3. Route that hostname to `http://127.0.0.1:43180` (or your explicitly selected port), with a suitable catch-all rule.
4. Store its connector token in a private local file, never an environment value containing the token itself.
5. Ensure the selected port is free.

```sh
export INGEST_TEST_HOSTNAME=ingest.example.com
export INGEST_TEST_PORT=43180
export INGEST_TEST_TOKEN_FILE=/absolute/path/to/protected/connector.token
npx tsx scripts/public-tunnel-smoke.ts --run-public-test
```

These variables hold only a hostname, port and **file path**. The utility creates an isolated persistent Pi SDK session with a synthetic local model and an independently generated listener bearer token. It does not use your normal conversation or a hosted model.

The test checks listener-only mode, both access paths while the tunnel is active, missing/wrong credentials, oversized and malformed bodies, exact message receipt, waiting behind busy work, FIFO ordering, repeated enable, disable/discard and re-enable with the same token. Authorized POSTs are not automatically replayed after uncertain delivery.

It stops its owned listener/connector afterward and writes a nonsecret report to `.pi/local-tunnel-test-result.json`. Test sessions and disabled mappings remain under ignored `.pi/` for local inspection. The remote Cloudflare route is not deleted.

A live authorized test of this sequence passed using cloudflared 2026.9.3: seven bodies reached the mapped session unchanged; missing/wrong tokens returned 401, oversized bodies 413 and invalid UTF-8 400. Busy messages waited in order, disable stopped intake, and re-enable restored both access paths. No extension errors occurred. Private endpoint names, session IDs, credentials and local reports are deliberately excluded from the repository.

## Credential handoff utility

`scripts/import-tunnel-token.mjs` is an opt-in local maintainer utility for transferring a connector-token file into protected storage. It verifies file identity, permissions and byte equality, synchronizes the copy, and **deletes the source only after successful verification**. It never prints secret bytes or hashes.

Use it only when explicitly authorized to import **and delete** that handoff file. Arguments are paths, never credential values. Synthetic regression tests cover successful import and refusal of unsafe or mismatched files.

## Limits and dependencies

- Tested host baseline: Pi 1.4.0. Wildcard host peer dependencies are Pi packaging conventions, not universal compatibility promises.
- Linux is validated; native Windows credential ACLs and lifecycle behavior are not verified.
- Direct LAN HTTPS deployment and abrupt-process-death recovery remain unverified.
- Trust notices guide the model; they do not create a sandbox.
- The development dependency tree currently reports a moderate minimatch advisory through the Pi host package. `npm audit --omit=dev` is clear. This extension does not bundle production runtime dependencies; Pi supplies the host packages.
- No npm release has been published. Git installation is the supported distribution path for this initial repository.
