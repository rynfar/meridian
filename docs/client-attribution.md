# Client attribution

If your app calls Meridian, you can label its requests so the operator can tell your traffic apart from other apps and from unattributed traffic. Send these optional headers on `POST /v1/messages`, `/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`, or `/v1/images/edits`, where the selected backend supports that route.

| Header | Value | Example |
| --- | --- | --- |
| `x-meridian-client` | `<name>[/<version>]`. The name must match `^[a-z][a-z0-9-]{0,31}$`; the optional version must match `^[A-Za-z0-9._+-]{1,64}$`. Without a valid client, the request is unattributed and installation and device are ignored. | `voice-ai/0.9.3` |
| `x-meridian-installation` | Random ID generated and stored once per installation, matching `^[A-Za-z0-9._:-]{1,64}$`. An invalid ID is ignored. | `20261124T0612Z-x7f9qp` |
| `x-meridian-device` | Optional human-readable label. Meridian removes characters outside printable ASCII, trims it, keeps at most 64 characters, and omits it if empty. | `Kitchen tablet` |
| `x-meridian-purpose` | `chat`, `title`, `compaction`, `summary`, `subagent`, `review`, `helper`, or `test`. Other non-empty values are recorded as `other`; empty or missing values are omitted. Purpose can be recorded without a client. | `chat` |
| `x-meridian-session` | Optional app conversation or thread ID, matching `^[A-Za-z0-9._:-]{1,128}$`. Reserved for telemetry; this build does not use it as a conversation fallback. | `thread-27` |

The receiving Meridian instance records the metadata on its existing request history. `GET /telemetry/requests` includes `client: {name, version?, installation?, device?}` when attributed and `purpose` when supplied. For Antigravity in a combined service, read `/antigravity/telemetry/requests`. Older records and requests without attribution fields omit those fields.

- These are self-reported labels, not credentials. They do not select the adapter, provider, profile, or account, and cannot change routing, quota, permissions, or session continuity. Do not put secrets or personal information in the labels.
- No `x-meridian-*` request header goes to a model provider. A request relayed to another Meridian instance can still carry the headers; that instance is another receiver.
- Work Meridian originates itself is recorded as `client.name: "meridian"` with purpose `keepalive` or, on builds with account warming, `warm`. Internal retries and protocol translation of a client's request keep that client's attribution. The existing `x-meridian-source` behavior is independent of purpose.
