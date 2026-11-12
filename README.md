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
| `SCREENCONNECT_HUNT_BUDGET_MS` | `120000` | Total hunt wall clock budget; clamps to 5000..600000 ms. |
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
| `screenconnect_hunt_campaign` | read | Hunt the Nov 2026 campaign using session inventory, events and connections. |
| `screenconnect_session_get_guest_info` | read | Guest inventory, online state, derived uptime. |
| `screenconnect_session_add_note` | write | Append note. |
| `screenconnect_session_send_message` | write | Message guest, with `byHost` defaulting to MCP. |
| `screenconnect_session_update_name` | write | Rename session. |
| `screenconnect_session_update_custom_properties` | write | Merge partial slots 1..8 with existing properties. |
| `screenconnect_session_send_command` | admin | Execute cmd/PowerShell command; optionally poll for output. |
| `screenconnect_session_send_toolbox_item` | admin | Execute named toolbox item. |
| `screenconnect_session_create` | admin | Create Support, Meeting or Access session. |

Search fields: `sessionType`, `name`, `machineName`, `serialNumber`, `loggedOnUser`, `operatingSystem`, `customProperties` (map with keys `1` through `8`), and `onlineOnly`. Structured string values use single-quoted literals with doubled quotes. Advanced `filter` (max 4000 chars) cannot be combined with any structured field. Lists apply `limit` (default 50, max 500) and `offset` client-side and return `totalCount`; the upstream API still returns the entire matching list. Narrow filters to stay within the upstream byte cap. Session inventory read tools accept `includeRaw`; raw results are still redacted and capped.

Custom property updates are **read-modify-write**: fetch current values, merge supplied slots, then replace all eight. Empty strings clear slots. There is no compare-and-swap, so concurrent edits can be lost.

Commands accept at most 8000 characters. `shell: powershell` prepends `#!ps`; optional `timeoutSeconds` (1..3600) adds `#timeout=<milliseconds>`. `waitForOutputSeconds` (0..60, default 0) polls details for a new EventType 70 event after the send timestamp and returns its Data. Timestamp correlation is best effort: another operator's command may produce the event, clock skew can prevent matching, and a polling timeout does not mean the command failed. Command submission is fire-and-forget and **never retried**. Do not resend automatically after an ambiguous result. Event timestamps in ISO or .NET `/Date(...) /` form are accepted. Missing inventory fields are tolerated; unavailable uptime is null.

## Hunting the Nov 2026 campaign

`screenconnect_hunt_campaign` is read-only, enabled in the default `read` tier, and requires no confirmation. It makes one `GetSessionsByFilter` call, scans the first `maxSessions` list records, and fetches `GetSessionDetailsBySessionID` with concurrency four. It checks inventory, client IDs, campaign infrastructure, dropped files, persistence markers, operators, host connections and commands/toolbox activity. It never opens a remote session or performs remediation.

Example MCP call:

```json
{
  "name": "screenconnect_hunt_campaign",
  "arguments": {
    "since": "2026-11-11T17:47:00Z",
    "sessionType": "Access",
    "maxSessions": 500,
    "knownOperators": ["jsmith"],
    "massThreshold": 5,
    "massWindowMinutes": 15
  }
}
```

| Input | Default | Bounds / meaning |
| --- | --- | --- |
| `since` | `2026-11-11T17:47:00Z` | ISO-8601 timestamp with timezone; inclusive. |
| `until` | Hunt start time | ISO timestamp strictly after `since`; inclusive. |
| `sessionType` | `Access` | `Support`, `Meeting`, `Access`. |
| `sessionFilter` | unset | Raw filter, at most 4000 characters; used as-is, overriding `sessionType`. |
| `maxSessions` | 500 | Integer 1..5000; list pagination is client-side. |
| `extraIocs` | unset | Up to 200 strings, each 3..500 characters; medium severity substring matches. |
| `knownOperators` | unset | Up to 500 names, each at most 255 characters; case-insensitive allowlist. Omit to skip unknown-operator checks. `Addmin` is always checked. |
| `massThreshold` | 5 | Integer 2..1000 distinct sessions. |
| `massWindowMinutes` | 15 | Integer 1..1440; sliding window for identical normalized commands or toolbox names. |
| `maxFindings` | 500 | Integer 1..5000; limits returned findings, with omitted count reported. |
| `includeClean` | false | Accepted for compatibility; no clean-session list is returned. |

IOC matching undoes common defanging, requires digit boundaries for IPs, and matches `Addmin` as a whole word in text or an exact actor name. Bare `screen` only matches an exact connection hostname/participant. `sqlite3.exe` alone is low confidence. Every command/toolbox event in the time window produces an informational finding. Mass execution strips PowerShell/timeout/maxlength directives and collapses whitespace before comparing text across distinct sessions. Clusters report maximal qualifying sliding windows; overlapping windows may share sessions. One mass-execution finding is added per involved session. Mass execution alone is medium severity; clusters with IOC hits are high severity.

The summary reports full finding counts before truncation, flagged sessions (excluding info-only activity), earliest timestamped hit, detail-read errors, skipped sessions and partial coverage. Inventory hits have no event timestamp and are checked regardless of the event window; `earliestHit` is null when no timestamped hit exists. Connections count when their known start and optional end overlap the window; connections missing a start timestamp cannot establish coverage. Nested connection events use their own timestamps. Per-session errors preserve available results and include only generic sample messages. A failed initial search fails the tool. `SCREENCONNECT_HUNT_BUDGET_MS` bounds the entire hunt (default 120 seconds); budget expiry or caller cancellation stops launching detail reads and returns partial results after a successful initial search. Narrow the filter or adjust limits to follow up on partial results. The shared `SCREENCONNECT_MAX_RESPONSE_CHARS` output cap still applies; reduce `maxFindings` or increase that cap for large reports.

Coverage gaps:

- Panel login history and the ScreenConnect audit log are NOT available through the RESTful API Manager extension; check Administration > Audit in the SC web UI and the ConnectWise advisory.
- Event/connection field names (`Host`, `ParticipantName`, `NetworkAddress`, `ProcessType`, event `Data` for toolbox items) are inferred from public prior art and unverified against a live instance. The parser tolerates actor aliases and integer or string event types; missing/invalid event times are skipped.
- Endpoints with a rogue second ScreenConnect client that never connected to THIS instance will not appear; search client IDs and file IOCs with EDR/RMM.

Response next steps (guidance only; the tool takes none of these actions):

- Do NOT open GUI/backstage sessions on flagged machines: the campaign reverse-pivots onto tech workstations. Use EDR live response or WinRM instead.
- Terminate all active web/host sessions and force sign-out of all users.
- Rotate ScreenConnect credentials and the RESTful API Manager secret; verify MFA on every account and remove unknown users such as `Addmin`.
- Remove rogue ScreenConnect client services (IDs `2588ef5c15954b10`, `ed630cc2c873b091`, or unknown instances), the `TrapWatch` task, `C:\ProgramData\RelayTrap\`, `%TEMP%\sckit-*` folders, HKCU/HKLM Run value `RelayTrapLiteAlert`, and dropped `sqlite3.exe`. Block IOC IPs/domains at the firewall/DNS filter.
- Review the [ConnectWise security advisory resources](https://www.connectwise.com/company/trust/security-bulletins) and preserve logs before cleanup.

IOC source attribution: public r/msp thread **“Active malware campaign abusing ScreenConnect” (Nov 11 2026)**, with corroborating public Blackpoint SOC reporting. Publisher discovery links: [r/msp thread title search](https://www.reddit.com/r/msp/search/?q=Active%20malware%20campaign%20abusing%20ScreenConnect&restrict_sr=1), [Blackpoint reporting](https://blackpointcyber.com/blog/). The supplied IOC set was implemented offline; these links are not independently verified article permalinks. To update the data, edit the grouped `{ value, kind, severity, note }` constants in [src/hunt/iocs.ts](src/hunt/iocs.ts), update `IOC_SET_VERSION`, and add matching/non-matching test fixtures. Keep customer names out of the IOC file and fixtures.

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
