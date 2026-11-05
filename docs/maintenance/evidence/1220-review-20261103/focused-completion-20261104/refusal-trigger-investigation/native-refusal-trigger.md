# Native refusal trigger — selected Claude Code 2.1.296

## Conclusion

The exact immediate trigger is **Messages API refusal metadata**, not a local keyword/category heuristic: `stop_reason === "refusal"` and `stop_details.category === "cyber"`. Native code constructs the user-facing “Opus 5.5's safeguards flagged this session” message from those fields. Thus `<synthetic>` identifies the **display/error wrapper**, not evidence that native invented the `cyber` classification.

The parent's supported-SDK follow-up now also preserves the failed row's exact `stop_details` in `supported-native-stop-details.json`: `type:"refusal"`, `category:"cyber"`, and the generic policy explanation quoted below. That corroborates the branch independently of the rendered `[cyber]` text.

This establishes the native decision boundary. It does **not** identify why Anthropic classified the request as cyber, prove which input span caused it, or establish the original HTTP status. No Meridian input defect or safe provider-side fix is demonstrated by this investigation. Do not change prompts, models, retries, or guard settings on this evidence.

## Inputs and limits

- Binary: `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- SHA256: `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` (verified by read-only mmap/hash); size 240,664,432 bytes.
- Existing supported-history artifact: `../sse-owned-supported-history.json`, final assistant UUID `d9784a56-f5b1-4d07-90df-a93c1cbef5ac`, model `<synthetic>`, stop reason `refusal`, literal `Details: \`[cyber]\``.
- Correlation IDs: request `req_011CgiEbrKMNczsLEAvajW27`; message `msg_011CgiEbraDzwxFScjJPjgAJ`.
- Parent's supported-SDK follow-up: `supported-native-stop-details.json`, same assistant UUID and synthetic refusal row. Exact structured explanation:
  > This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.
  This is a generic policy explanation; it names no offending span or technical classifier rule.
- Analysis used bounded source-string slices of the selected binary and installed public SDK files. No processes, network/model calls, credentials, private SDK transcripts, helper changes, or project source changes. Exact Q1/Q2 reconstruction was not repeated.
- Offsets below are **zero-based byte offsets in this exact binary**, not virtual addresses or upstream source line numbers. Function names are minified and scope-specific.

## Exact branch and provenance

1. **Upstream stream is consumed, not reclassified.** At byte `198076680`, native calls `Ol.beta.messages.create({...am, stream:!0}, ...).withResponse()`, records `Tf.request_id`/response headers, and returns `Tf.data`. At `198094615`, `case "message_delta"` reads that event. At `198095888`, the decisive assignment is:
   ```js
   let Mc=typeof ms.delta.stop_reason==="string"?ms.delta.stop_reason:null;
   ```
   At byte `198098977`, it calls:
   ```js
   Lwt(Mc,ms.delta.stop_details,Ra,
       Vw?Xa?.servedFallbackModel??Ep?.model??X.model:X.model,Ep?.id)
   ```
   **Concrete upstream-response fact from the native branch:** the category argument is directly `ms.delta.stop_details`, and the stop reason is directly `ms.delta.stop_reason`; it is not extracted from generated text or an HTTP error string. The alternative nonstreaming call at `198069082` is likewise `Lwt($o.stop_reason,$o.stop_details,Ra,As??X.model,$o.id)`.

2. **Only an explicit refusal enters the formatter.** `Lwt` starts at byte `196155147`; exact call-name occurrence `196155156`:
   ```js
   function Lwt(e,n,r,s,h){if(e!=="refusal")return; ... }
   ```
   It reads `n?.category` and `n?.explanation`. It does not infer cyber from prompt text. Its error wrapper is created with `Is({content:w+M+X,error:"invalid_request"})` and then explicitly receives `he.message.stop_reason="refusal"; he.message.stop_details=n??null` at bytes `196156945` onward. This accounts for the history's synthetic assistant/error row. `Is` at `199612221` creates an API-error assistant; `qDn` at `199611072` assigns its synthetic model.

3. **“This session” is selected UI copy, not an independent sticky-session finding.** `zb=new Set(["claude-opus-5-5"])` and the `Ic.cyber` explanatory text are near `191070000`. `zc` selects the known model/category explanation. `lfo` at `191071135` returns:
   ```js
   `${e}'s safeguards flagged ${Wb}${s}. ${h(e)}`
   ```
   where `Wb="this session"`. `Lwt` calls it with `n?.category` and the AUP link. This yields the exact Opus 5.5 wording in the artifact. The accompanying advice is native copy too; it is not an upstream explanation or a recommended investigation action.

4. **Literal `[cyber]` origin.** `h3e` at `191069332` accepts the category string, sanitizes display punctuation with `drop:/[\`\[\]]/g`, and formats `Details: [category]` with Markdown backticks. `Lwt` invokes `h3e(n?.category)`. `cyber` therefore comes from **structured refusal category metadata**, not a classifier in that formatter. The original history artifact proves the rendered category value. The parent's later `supported-native-stop-details.json` separately preserves `type:"refusal"`, `category:"cyber"`, and the generic policy explanation on that same failed row. Neither artifact preserves the raw wire body.

5. **HTTP status/body distinction.** The “API Error:” prefix and `error:"invalid_request"` are native display choices here, not proof of HTTP 400/403. Native's SDK transport separately handles non-OK HTTP responses by reading their body and throwing `makeStatusError` around `191015986`; ordinary response-body/stream processing is separate. No permitted existing artifact read in this task supplies the actual HTTP status or raw refusal event. The retained request/message IDs are the appropriate correlation keys for provider investigation.

## Category parsing, local classifiers, retries, persistence

- Native's category helpers `vFn` (`191062128`) and `kde` map already-present category strings for copy/telemetry; they do not classify content. Separately, the auto-mode classifier code near `196332384` returns `shouldBlock`, `reason`, `category`, and failure details for tool permission decisions. That is not a call path into this exact `Lwt` diagnostic. The observed formatter path uses API `stop_details`.
- A stream's separate `safeguard_results` field is handled before stop metadata at `198094831`, through `qnt` (`198031328`) / server-classifier ingestion. `Mc` and the formatter still read `ms.delta.stop_reason`/`stop_details` directly. No evidence shows a local auto-mode result being substituted into those fields.
- Native can route an explicit refusal to a configured fallback **before** rendering (`198098775`/`198068733`). It can also withhold a refusal for its separately guarded same-model retry (`203786943`, `203839308`, `203876188`). Both start from an already received refusal. Existing final history does not establish whether an earlier retry ran. No retry/fallback change is proposed.
- Session model-selection state (`186783121`) has separate fallback-occurred/header/model-latch fields. Cyber header arming is explicit **after a session fallback** (`203856748`, `203862548`), and resume may re-arm it from stored `model_refusal_fallback` banners marked cyber (`203958228`). The outbound fetch wrapper at `191115434` adds `x-is-refusal-fallback: true` when this state is armed. Session transitions clear that state (`186829560`, `186830415`). These are fallback-routing persistence mechanisms, not a local content classifier or proof that a prior native latch caused this refusal. The final supported-history rows alone do not prove any such latch/header was present. Provider-side persistence cannot be inferred from the canned “this session” wording.

## Independent public SDK corroboration

Installed public `@anthropic-ai/sdk` is `0.129.0` (not asserted to be the embedded native SDK's exact version):

- `resources/messages/messages.d.ts:2230`: `RefusalStopDetails.category` is documented as “The policy category that triggered the refusal”; includes `cyber`. `explanation` is optional-in-meaning human prose, not stable for parsing. `StopReason` includes `refusal` at line 2337.
- `resources/beta/messages/messages.d.ts:3237`: same structured category contract for `BetaRefusalStopDetails`.
- `core/streaming.mjs:53–100`: `message_delta` SSE data is yielded from `JSON.parse(sse.data)`; an SSE `error` event is a separate `APIError` branch at 111–114.
- `lib/MessageStream.mjs:453–457`: `snapshot.stop_reason=event.delta.stop_reason` and `snapshot.stop_details=event.delta.stop_details`. Embedded native accumulators do the same at `190946577` and `190999403`.

## Engineering disposition

**No production fix to the refusal trigger is justified by this evidence.** The proven boundary is explicit received refusal metadata followed by native display synthesis. Keep the failed affected-flow gate open. Provider escalation using the retained request/message IDs, exact generic policy explanation, and existing harmless owned-file reproduction is the demonstrated next action—not a code guess. Parent reports a new personal-usage 429 and will not run another live attempt; that is a separate execution blocker, not the cause of the earlier cyber refusal. Any later response-boundary observation must preserve only sanitized status/stop reason/category/correlation IDs, not private content or tokens. Fixing Meridian's error propagation is a separate question for the parent investigation and would not prove this provider refusal fixed.
