# User guide

## Configure the current session

`message_ingest_configure` saves a mapping for the **current persistent session ID**, under the current project. It never silently enables intake. Reconfiguration stops the previous owned listener/tunnel and discards extension-owned waiting bodies.

Listener-only example:

```json
{
  "port": 43180,
  "host": "127.0.0.1",
  "rotateToken": false
}
```

- `port`: required fixed integer from 1 to 65535. A collision fails; no automatic fallback.
- `host`: optional literal IP; defaults to loopback. LAN or wildcard binding must be a deliberate exposure decision.
- `rotateToken`: optional; false by default. A new mapping always gets a random bearer token. Existing tokens are preserved unless rotation is requested.
- `tunnel`: optional. Omit it for listener-only operation.

Configuration is **replacement**, not a partial patch. Omitting `tunnel` removes its saved configuration. The result contains the listener bearer token for you to transfer to your client. Enable separately after checking the settings.

A global extension installation or enablement flag is insufficient: without a valid saved mapping for the active session ID, neither listener nor tunnel starts. In-memory SDK sessions are not eligible.

## Read or rotate the bearer token

Ask the agent to use `message_ingest_token` to retrieve the current saved token without changing the listener, tunnel or credential.

To rotate, reconfigure with `rotateToken: true`, securely update the sender with the returned token, then enable the listener again. The previous token will no longer authenticate. Routine status and errors never include the token.

The configuration and token-retrieval tool results intentionally contain the token. They may be recorded in the session transcript and its conversation transport. There is no separate local credential-setup ceremony for the listener bearer token.

## LAN access

Configure the intended local interface IP and an appropriate firewall rule. Example:

```json
{
  "port": 43180,
  "host": "192.168.1.20"
}
```

Use the address assigned to your own machine, not this example unchanged. The listener is plain HTTP. Use HTTPS termination through a local reverse proxy or tunnel for traffic crossing an untrusted network; otherwise the bearer token and body are visible to that network.

## Optional Cloudflare Tunnel

Install `cloudflared` separately and provision a named tunnel with a stable hostname. Set its public hostname's ingress target to the listener, such as `http://127.0.0.1:43180`, with an appropriate catch-all rule.

The extension manages the connector process only. It does not install cloudflared, create a Cloudflare account/tunnel, configure DNS or modify remote ingress.

Choose **exactly one** of the following modes.

### Remotely managed tunnel: token file

Store the Cloudflare connector token in a protected local file. On Unix, use mode `0600` with a private parent directory. The extension rejects symlinks and non-private token files/directories.

```json
{
  "port": 43180,
  "tunnel": {
    "enabled": true,
    "tokenFile": "/absolute/path/to/protected/cloudflare-tunnel.token"
  }
}
```

cloudflared reads the token directly through `--token-file`. The extension does not copy token contents into tool arguments, process arguments or logs. It supplies an explicit empty local config so unrelated default cloudflared configuration is not inherited. Remotely managed ingress must already point to this listener.

Use a cloudflared version supporting `tunnel run --token-file`. The live validation used **2026.9.3**; version compatibility is not inferred from a successful local unit test.

### Locally configured tunnel: config file

Use an existing local cloudflared config containing the named tunnel, credentials reference and ingress routing:

```json
{
  "port": 43180,
  "tunnel": {
    "enabled": true,
    "configFile": "/absolute/path/to/cloudflared.yml"
  }
}
```

Treat that configuration as trusted local input. Keep its referenced credentials private. Do not pass both `configFile` and `tokenFile`.

### Ownership and readiness

The tunnel starts only when the session mapping is enabled, the tunnel is explicitly configured/enabled, and the listener is ready.

The launcher uses a fixed `cloudflared` executable, no shell, loopback metrics, explicit info logging and disabled automatic updates. Inherited `TUNNEL_*` overrides are removed. Raw connector diagnostics are consumed without being forwarded to the agent.

Tunnel state distinguishes:

- `spawned`: the child process started.
- `connection-ready`: a tunnel registration diagnostic was observed.
- `failed`: the child failed or exited unexpectedly.

A registration observation is not continuous health monitoring or proof of public reachability. Verify a public request separately.

Immediate startup failure closes the listener and reports failure. A connector failure after startup is reflected in tunnel state; explicitly enable again to restart. No uncontrolled restart loop is installed.

For an independently managed connector or reverse proxy, omit `tunnel`. The extension does not discover or stop unrelated processes.

## Delivery and failures

Send `POST /` with `Authorization: Bearer <listener-token>`. The raw body is the message; there are no routing fields or required message IDs.

| Result | Meaning |
| --- | --- |
| `202` | Entered this runtime's volatile waiting inbox. Not a processing receipt. |
| `401` | Missing or invalid bearer token. |
| `413` | Body exceeds 64 KiB. |
| `400` | Invalid UTF-8. |
| `415` | Unsupported content encoding, such as a compressed body. |
| `404` | Unsupported method or route. |
| `503` | Inactive, full or failed local admission. |

Content-Type does not choose a parser. Empty bodies and whitespace-only bodies are not trimmed or rewritten. A UTF-8 BOM is preserved as U+FEFF. Binary data is not supported. Slash-prefixed text is not expanded into commands or prompt templates.

The waiting FIFO is capped at 32 outstanding bodies and 1 MiB of waiting text. Only one body is handed to Pi at a time. Busy work and compaction are allowed to finish before the next submission; it is not injected as steering.

There is no retry, deduplication, receipt API or durable broker. Duplicate sends can cause duplicate delivery. A timed-out POST has an uncertain outcome; do not assume it failed before retrying.

Pi's extension send API has no acceptance promise. Asynchronous submission errors can arrive separately. If the host returns idle without a settlement signal, the submission gate is released with an uncertainty warning, but the body is not replayed.

The text is stored as a custom Pi message unchanged. Separate system-context notices mark it as external untrusted data. They are not part of the body and are not a security sandbox. Other installed extensions and providers can affect downstream context representation.

## Disable, reload and resume

- **Disable:** stop new intake and owned resources, discard waiting bodies, preserve configuration/token. Does not abort the agent or retract already submitted work.
- **Configure:** same intake shutdown, then save replacement settings in disabled state.
- **Reload or session switch:** dispose old owned resources before evaluating the next runtime's mapping. Waiting bodies are not transferred.
- **Resume the same ID:** start its saved enabled mapping.
- **New/forked ID:** no inherited mapping or exposure.

Only the exact connector child started by this extension is stopped. Unconfirmed termination fences replacement startup, including extension reload in the same process. This is not a guarantee about every descendant or cleanup after abrupt host death.

## Storage and troubleshooting

Configuration is saved in `.pi/message-ingest/config.json` under the project, keyed by session ID. It contains listener bearer tokens. On Unix, the storage directory is private and config mode is `0600`; an internal `.gitignore` ignores its contents. These permissions do not encrypt files, remove already tracked files or configure Windows ACLs.

Writes use an exclusive lock and atomic replacement. A crashed writer may leave `config.lock`. Subsequent writes fail closed. Remove a stale lock only after confirming there is no active writer; it is never silently stolen.

Check `message_ingest_status` first:

- **Unmapped:** configure the session you actually resumed.
- **Port occupied:** stop the conflicting service or explicitly choose another port.
- **Tunnel unavailable:** verify cloudflared installation, file permissions and the configured credential mode.
- **Tunnel registered but public requests fail:** check DNS/Cloudflare ingress and the listener target separately.
- **202 but no processing:** check busy state, waiting count, model errors and Pi lifecycle. HTTP acceptance is not completion.

Do not edit active mappings behind the extension. Use its tools, or disable before local edits and reload afterward.
