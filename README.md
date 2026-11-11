# ScreenConnect MCP Server

An open-source TypeScript MCP server for ConnectWise ScreenConnect's **RESTful API Manager** extension (ConnectWise Labs). Part of the WYRE AI fleet. Runs over stdio or stateless Streamable HTTP with per-tenant credentials.

Unofficial community project; not affiliated with or endorsed by ConnectWise.

## Setup

1. In your ScreenConnect administration console, install and enable the **RESTful API Manager** extension from ConnectWise Labs.
2. Configure its `RESTfulAuthenticationSecret` with a strong secret. Set `SCREENCONNECT_API_SECRET` to the same value. This API uses `CTRLAuthHeader`, not Basic auth or cookies.
3. If the extension's `RESTfulAllowedOrigin` is set, set `SCREENCONNECT_ORIGIN` to that exact HTTPS origin.
4. Set `SCREENCONNECT_BASE_URL` to your instance's HTTPS URL. The default extension GUID is `2d558935-686a-4bd0-9991-07539f5fe749`; override it if your installation differs.
5. Start with the default `read` tier. Enable `write` and `admin` explicitly only when needed.

```bash
npm install
npm run build
# Export SCREENCONNECT_BASE_URL and SCREENCONNECT_API_SECRET locally first.
npm start
```

For MCP clients, use `node /path/to/screenconnect-mcp/dist/index.js` and pass these environment variables in the client's server configuration.

Each upstream call is `POST {baseUrl}/App_Extensions/{extensionId}/Service.ashx/{Method}` with a positional JSON array body. HTTP 401/403 means the secret was rejected; 404 usually means the extension is missing, disabled, or has a different ID.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCREENCONNECT_BASE_URL` | required locally | Instance HTTPS URL, including an optional context path. Placeholder hosts are rejected. |
| `SCREENCONNECT_API_SECRET` | required locally | Extension's `RESTfulAuthenticationSecret`; never logged. |
| `SCREENCONNECT_ORIGIN` | unset | Optional exact HTTPS origin for `RESTfulAllowedOrigin`. |
| `SCREENCONNECT_EXTENSION_ID` | GUID above | Must be a GUID. |
| `SCREENCONNECT_TOOL_TIERS` | `read` | Comma-separated `read,write,admin`. Unknown names stop startup. |
| `SCREENCONNECT_REQUEST_TIMEOUT_MS` | `30000` | Per-call timeout and retry budget; maximum 120000 ms. |
| `SCREENCONNECT_MAX_RESPONSE_CHARS` | `60000` | MCP output cap after redaction; maximum 1000000. |
| `SCREENCONNECT_MAX_UPSTREAM_BYTES` | `16777216` | Streaming body cap before JSON parsing; maximum 128 MiB. Oversize fails closed. |
| `SCREENCONNECT_ALLOW_PRIVATE_BASE_URL` | unset | `1` permits private HTTPS hosts locally. Ignored in gateway mode. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `AUTH_MODE` | `env` | `env` reads local credentials; `gateway` uses only request headers. |
| `CONDUIT_S2S_SECRET` | required for HTTP | At least 32 characters; placeholder and repeated values rejected. |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `8080` | HTTP bind address. Image uses `0.0.0.0`. |
| `MCP_ALLOWED_HOSTS` | unset | Optional comma-separated Host allowlist for `/mcp`. |
| `MCP_ALLOW_INSECURE_DEV` | unset | `1` permits missing S2S secret for local development, bound only to loopback. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; logs go to stderr. |

See [`.env.example`](.env.example). Positive integer settings fall back for invalid/nonpositive values and clamp at their ceiling.

## Tools

Every tool supplies `readOnlyHint`, `destructiveHint`, and `idempotentHint`. Tools outside enabled tiers are both hidden and uncallable. All admin tools require `confirm: true` and carry `⚠ HIGH-IMPACT` warnings. The flag prevents accidental invocation; it is not proof of human approval.

| Tool | Tier | Purpose |
| --- | --- | --- |
| `screenconnect_sessions_search` | read | Structured search, or exclusive advanced raw `filter`. |
| `screenconnect_sessions_list_online` | read | Connected guests; defaults to Access sessions. |
| `screenconnect_sessions_get_by_name` | read | Exact session-name lookup. |
| `screenconnect_session_get` | read | Session by GUID; empty upstream result becomes not found. |
| `screenconnect_session_get_details` | read | Connections, integer `eventTypes` filter, newest-first events. |
| `screenconnect_session_get_guest_info` | read | Guest inventory, online state, derived uptime. |
| `screenconnect_session_add_note` | write | Append note. |
| `screenconnect_session_send_message` | write | Message guest, with `byHost` defaulting to MCP. |
| `screenconnect_session_update_name` | write | Rename session. |
| `screenconnect_session_update_custom_properties` | write | Merge partial slots 1..8 with existing properties. |
| `screenconnect_session_send_command` | admin | Execute cmd/PowerShell command; optionally poll for output. |
| `screenconnect_session_send_toolbox_item` | admin | Execute named toolbox item. |
| `screenconnect_session_create` | admin | Create Support, Meeting or Access session. |

Search fields: `sessionType`, `name`, `machineName`, `serialNumber`, `loggedOnUser`, `operatingSystem`, `customProperties` (map with keys `1` through `8`), and `onlineOnly`. Structured string values use single-quoted literals with doubled quotes. Advanced `filter` (max 4000 chars) cannot be combined with any structured field. Lists apply `limit` (default 50, max 500) and `offset` client-side and return `totalCount`; the upstream API still returns the entire matching list. Narrow filters to stay within the upstream byte cap. Read tools accept `includeRaw`; raw results are still redacted and capped.

Custom property updates are **read-modify-write**: fetch current values, merge supplied slots, then replace all eight. Empty strings clear slots. There is no compare-and-swap, so concurrent edits can be lost.

Commands accept at most 8000 characters. `shell: powershell` prepends `#!ps`; optional `timeoutSeconds` (1..3600) adds `#timeout=<milliseconds>`. `waitForOutputSeconds` (0..60, default 0) polls details for a new EventType 70 event after the send timestamp and returns its Data. Timestamp correlation is best effort: another operator's command may produce the event, clock skew can prevent matching, and a polling timeout does not mean the command failed. Command submission is fire-and-forget and **never retried**. Do not resend automatically after an ambiguous result. Event timestamps in ISO or .NET `/Date(...) /` form are accepted. Missing inventory fields are tolerated; unavailable uptime is null.

## HTTP / gateway

The image and Compose default to `AUTH_MODE=gateway` and read-only tools. Set `CONDUIT_S2S_SECRET` in your environment, then run `docker compose up --build`. Local HTTP: set `MCP_TRANSPORT=http` and run `node dist/http.js`.

`POST /mcp` requires a valid `X-Gateway-S2S` signed proof. Gateway credentials are request-scoped and never fall back to environment credentials.

| Header | Value |
| --- | --- |
| `X-ScreenConnect-Base-Url` | Instance HTTPS URL (required). |
| `X-ScreenConnect-Api-Secret` | API secret (required). |
| `X-ScreenConnect-Origin` | Optional allowed origin. |
| `X-ScreenConnect-Extension-Id` | Optional extension GUID. |
| `X-Conduit-Tool-Tiers` | Optional intersection with configured tiers; can only narrow. An empty header exposes no tools. |

`GET /health` is unauthenticated liveness only and reads no credentials. The transport is stateless, uses JSON responses, and caps inbound bodies at 1 MiB.

## Not supported

Session group listing, audit log, ending a session, and file transfer are not exposed by this extension API. Those require the Basic-auth web services and are outside v1's scope.

## Security model

- HTTPS only, no embedded credentials, query strings, fragments, placeholder hosts, or unsafe context paths. Redirects are never followed.
- Outbound requests use DNS-pinned sockets. Each connection resolves and checks the entire answer for private, loopback, link-local, metadata, and reserved addresses before connecting to a checked address. Gateway mode ignores the local private-host override.
- Gateway credentials live in AsyncLocalStorage for one request. No environment mutation, cookie authentication, credential persistence, or shared token cache.
- Read calls alone retry 429/5xx, at most twice, honoring Retry-After with a 2-second delay cap and a 10-second retry window within the request timeout. Writes are never retried.
- GUIDs, lengths, booleans, enums, and paging bounds are checked before upstream calls. Admin actions require explicit confirmation. Only declared arguments reach handlers.
- Streaming upstream bodies fail closed on oversize before JSON parsing. Output is redacted before truncation, including exact known secrets, secret-named fields, bearer tokens and JWTs. Logs contain tool names and result status, never arguments or upstream error bodies. Upstream cancellation follows the MCP request signal.
- HTTP startup fails closed without a strong S2S secret; insecure development is loopback-only. Use `MCP_ALLOWED_HOSTS` where appropriate.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm test
npm run smoke
```

Vitest uses generic fixtures and mocked outbound transport. The stdio smoke exercises the built server's tool listing, invalid GUID rejection, and default admin exclusion without network access. `evals/*.yaml` contains mcp-assert checks. CI and release workflows follow fleet conventions and publish `ghcr.io/wyre-ai/screenconnect-mcp`.

## Acknowledgements

API references: [christaylorcodes/ConnectWiseControlAPI](https://github.com/christaylorcodes/ConnectWiseControlAPI) (MIT), [MSPbotsAIFramework/connectwise-screenconnect-mcp](https://github.com/MSPbotsAIFramework/connectwise-screenconnect-mcp) (Apache-2.0), and [matt-taylor-tech/sc-remote-endpoint-ops-toolkit](https://github.com/matt-taylor-tech/sc-remote-endpoint-ops-toolkit) (MIT). This is an independent TypeScript implementation; their code and branding were not copied.

## License

[Apache-2.0](LICENSE).
