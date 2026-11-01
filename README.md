# Pi Message Ingest

**Push text into the right Pi session. Nothing more.**

[![CI](https://github.com/mbundgaard/pi-message-ingest/actions/workflows/ci.yml/badge.svg)](https://github.com/mbundgaard/pi-message-ingest/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg)](package.json)

A small [Pi](https://pi.dev/) extension for receiving externally pushed text. Connect an email processor, webhook adapter or automation script to **one explicitly mapped, persistent Pi session**—over localhost, your LAN or an optional Cloudflare Tunnel.

```text
Your sender ── bearer-authenticated POST ──▶ Listener ──▶ Mapped Pi session
                                                ▲
                                    optional Cloudflare Tunnel
```

The request body **is** the message. No JSON envelope, required IDs, rewriting or application-specific processing.

## What it does

- **Delivers text unchanged.** Preserves whitespace, line endings, Unicode and UTF-8 BOMs. JSON-looking content stays text.
- **Targets an exact session.** A saved session-ID mapping is required. Unmapped sessions start nothing; new and forked sessions do not inherit exposure.
- **Waits instead of interrupting.** Incoming messages wait while the agent is busy, then run in order without steering unrelated work.
- **Keeps authentication simple.** Generates a bearer token for your client. Ask the agent to retrieve or rotate it when needed.
- **Makes the tunnel optional.** Run just the listener, manage an existing Cloudflare connector, or use your own reverse proxy.
- **Owns its cleanup.** Disable, reload or switch sessions to stop the resources the extension started—not unrelated processes.

This is an **input channel**, not a hosted agent, reply transport or durable message broker. Your Pi process must remain running. Decide what the receiving agent is authorized to do with external content independently.

## Get started

Requires **Node.js 22.19+** and Pi. Tested against **Pi 1.4.0 on Linux**; other versions and platforms are not a blanket compatibility guarantee.

### 1. Install

```sh
pi install git:github.com/mbundgaard/pi-message-ingest
```

Start Pi in your project, or run `/reload` in an existing session after installing. Use a normal persistent session, not an in-memory SDK session.

> Git installation is available. This repository has **not been published to npm**; `private: true` prevents accidental npm publication.

### 2. Configure and enable

Ask your agent:

> Configure message-ingest for this session on localhost port 43180. Return the bearer token so I can configure my sender, then enable the listener. Do not configure a tunnel.

The agent saves the current session ID and configuration, generates a token, and enables intake explicitly. Configuration alone never starts the listener.

Save the token securely in your sending client. You can ask:

> Show me this session's message-ingest token again without changing anything.

### 3. Send a message

With `INGEST_TOKEN` set securely in your sending environment:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $INGEST_TOKEN" \
  --data-binary @message.txt \
  http://127.0.0.1:43180/
```

The contents of `message.txt` are delivered as a single message. Maximum body: **64 KiB of valid UTF-8**. Slash-prefixed text is not dispatched as a Pi command.

A `202 Accepted` response means the body entered the extension's **volatile waiting inbox**—not that the agent processed it or replied.

## Return to the same session

```sh
pi -r
```

Resume the mapped session in the same project and its saved enabled listener/tunnel starts again. `pi -c` continues the project's most recent session. A new or forked session needs its own configuration.

Ask the agent to disable message-ingest to stop intake while retaining configuration and credentials. Repeated enable of a healthy running mapping is a no-op.

## Controls

| Tool | Purpose |
| --- | --- |
| `message_ingest_status` | Read mapping, listener/tunnel state and waiting count. No token. |
| `message_ingest_configure` | Save the current session's listener and optional tunnel; leave disabled. Return its bearer token. |
| `message_ingest_token` | Explicitly retrieve the current token without rotation or restart. |
| `message_ingest_enable` | Start the existing enabled mapping; never create one implicitly. |
| `message_ingest_disable` | Stop owned resources and discard waiting bodies; preserve configuration/token. |

See the [user guide](docs/user-guide.md) for configuration examples, token rotation, LAN access and both Cloudflare credential modes.

## Local or public—you choose

The default listener binds to `127.0.0.1`. Configure an explicit interface address for LAN access, or connect an existing named Cloudflare Tunnel for HTTPS access from elsewhere.

The listener itself is HTTP, **not native TLS**. Use HTTPS termination whenever traffic crosses an untrusted network. Authentication remains required on loopback and through a tunnel.

A **Cloudflare connector token** connects cloudflared to Cloudflare. The **listener bearer token** authorizes senders to push messages. They are separate credentials; senders do not need the connector token.

## Clear boundaries

- No automatic retries, deduplication or durable inbox. Accepted waiting messages can be lost on disable, reload, session replacement or process failure.
- Already submitted Pi work cannot be retracted by closing the listener. Disable does not abort the agent.
- External content remains untrusted. Separate model-context notices identify its source without modifying the received body; those notices are not a security sandbox.
- Token retrieval intentionally exposes the listener token to the agent and its conversation. Routine status and logs omit it. Protect your transcripts and sending client.
- Configure and enable only in projects you trust. Pi extensions run with the host process's permissions.

Read [security and credential handling](SECURITY.md) and [delivery details](docs/user-guide.md#delivery-and-failures) before exposing an agent.

## Development

```sh
git clone https://github.com/mbundgaard/pi-message-ingest.git
cd pi-message-ingest
npm ci
npm run validate
npm run pack:check
```

The automated suite uses loopback sockets, synthetic data, fake tunnels and real Pi SDK lifecycle tests with a local deterministic model. It does not contact a live tunnel or a hosted model.

A separate, explicitly authorized live test verified both loopback and public Cloudflare delivery, authentication, unchanged content, busy-session waiting and disable/re-enable behavior. See [development and validation](docs/development.md) for reproducible commands and remaining limitations.

## Related Pi extensions

- [Pi Telegram](https://github.com/comput-sh/pi-telegram) — a private Telegram frontend for a running Pi session.
- [Pi Intercom](https://github.com/comput-sh/pi-intercom) — coordinator-led communication between Pi sessions.

Message Ingest follows their explicit session ownership and lifecycle approach while keeping ingress small.

[User guide](docs/user-guide.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
