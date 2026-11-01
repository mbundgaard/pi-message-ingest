# Security

## Reporting a vulnerability

Please do not post credentials, private request bodies or exploitable deployment details in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/mbundgaard/pi-message-ingest/security/advisories/new) when available. For non-sensitive bugs and questions, use the repository's issue tracker. Include the extension commit/version, Pi/Node/cloudflared versions and a synthetic reproduction rather than a real token or customer message.

## Authentication boundaries

Every intake request requires the listener's bearer token, including loopback and tunnel-forwarded requests. Tokens are randomly generated per saved session mapping. Public session names or IDs are not credentials, and request bodies cannot choose a destination.

Two different credentials may exist:

- **Listener bearer token:** given to message-sending clients. Configuration and explicit token retrieval intentionally return it to the owner through the agent. Protect the resulting transcript, conversation transport and client storage.
- **Cloudflare connector token:** needed only by cloudflared. In token-file mode, cloudflared reads it from protected local storage. It is not passed as an inline process argument or exposed by the extension's tools.

Do not reuse the connector token as the listener bearer token. A sender does not need authority to run a tunnel connector.

Routine status, diagnostics and errors omit token values and request bodies. Raw cloudflared output is not forwarded. Explicit token retrieval is an intentional exception for the listener token, not a reason to include secrets in bug reports or commits.

## Network exposure

Loopback is the default. LAN and wildcard binding must be deliberate; apply firewall restrictions appropriate to your deployment. Fixed-port collisions fail rather than silently selecting a replacement.

The listener is HTTP, not native TLS. Use an HTTPS tunnel or reverse proxy when the connection crosses an untrusted network. Bearer authentication alone does not encrypt traffic.

Managed tunnels start only for an explicitly configured/enabled persistent-session mapping and only after its listener is ready. The extension does not provision Cloudflare accounts, DNS or ingress rules.

## External content is untrusted

Request authentication proves knowledge of a credential, not that the body contains owner-approved instructions. The extension preserves the body and adds separate model-context provenance notices. Those notices are **not a sandbox or a prompt-injection guarantee**.

Restrict the receiving agent's tools and credentials, and separately authorize its processing task. Do not connect arbitrary external content to a broadly privileged agent and assume this extension makes it safe. Pi extensions themselves execute with the host process's operating-system permissions.

## Storage and lifecycle

Session mappings and listener tokens are stored in project-local `.pi/message-ingest/config.json`. Unix permissions, no-symlink checks and an internal ignore file provide basic local protection. They are not encryption, Windows ACL configuration, protection against another process with your identity, or removal of already Git-tracked files.

Do not commit `.pi/`, token files, local logs, session transcripts or live-test reports. Repository and package file allowlists are designed to exclude them.

Waiting bodies are volatile. Disable/reload/switch discards extension-owned waiting work but cannot retract work already handed to Pi. Child cleanup applies only to the connector the extension owns. Abrupt process death and all-descendant termination are not guaranteed.
