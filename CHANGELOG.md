# Changelog

## 0.1.0 — Initial implementation

- Authenticated raw UTF-8 HTTP ingress with unchanged message delivery.
- Explicit persistent-session mappings, fixed ports and configurable listener addresses.
- Listener-only operation and optional managed Cloudflare connectors using a local config or protected token file.
- Agent tools for status, configure, token retrieval, enable and disable.
- Bounded volatile waiting FIFO with non-steering busy-session delivery.
- Lifecycle generation guards, owned-resource cleanup and reload-resistant uncertainty fencing.
- Separate model-context trust notices without changing the received body.
- Core, credential-handling, package-loader and real Pi SDK integration tests.
- Optional authorized live local/public smoke-test utility.

Initial distribution is through GitHub. No npm release has been published.
