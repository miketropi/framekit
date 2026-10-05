# Higgsfield Local Generation Adapter — Production Specification (V1)

**Status:** Production design  
**Runtime:** Node.js + TypeScript  
**Integration:** Local CLI/tool adapter for AI coding agents  
**Higgsfield client:** `@higgsfield/client` V1 API surface  
**Primary consumers:** OMP / Pi / OpenCode / Codex-style agents, Remotion projects  
**Non-goals:** MCP server, SaaS backend, UI application, autonomous Higgsfield Agent API

> Compatibility note: Higgsfield currently publishes a V2 client and marks V1 deprecated. This specification intentionally targets the still-functional V1 client, while enforcing a provider boundary so migration to V2 does not change the CLI or Agent Skills contract.

---

## 1. Product Goal

Build a small, deterministic local tool layer that lets an AI coding agent generate and manage Higgsfield image/video assets without knowing Higgsfield API implementation details.

The system must separate:

- **Skills** — teach the agent when, why, and how to generate media.
- **Tool contract** — stable commands the agent can invoke.
- **Provider** — Higgsfield-specific SDK/API implementation.
- **Asset store** — predictable local files and metadata.
- **Remotion** — consumes generated assets; never calls Higgsfield directly.

Target architecture:

```text
Agent (OMP / Pi / OpenCode)
        |
        +---- reads ----> Agent Skills
        |
        +---- executes --> hf CLI
                           |
                           v
                    Tool/Application Layer
                           |
                           v
                    MediaProvider interface
                           |
                           v
                  HiggsfieldV1Provider
                           |
                           v
                 @higgsfield/client V1
                           |
                           v
                    Higgsfield API
                           |
                           v
                 Local asset + metadata
                           |
                           v
                        Remotion
```

---

## 2. Design Principles

1. **Thin adapter, not a platform.**
2. **Agent-neutral.** No Claude-specific assumptions.
3. **Stable CLI contract.** Skills depend on the CLI, never directly on SDK methods.
4. **Provider isolation.** All V1 code lives behind `MediaProvider`.
5. **Local-first.** Completed remote media is downloaded into the project.
6. **Machine-readable output.** Every command supports JSON output.
7. **Idempotent where practical.** A deterministic request fingerprint prevents accidental duplicate generation.
8. **Explicit cost boundary.** Never silently generate multiple expensive variants.
9. **No credentials in prompts, logs, manifests, or generated source code.**
10. **Generation and composition are separate.** Higgsfield creates source media; Remotion edits/composes it.

---

## 3. Scope

### 3.1 Required V1 capabilities

Initial production release MUST support:

- Text-to-image
- Image-to-video
- Local image upload
- Generic V1 endpoint execution for future supported endpoints
- Generation polling
- Job inspection
- Local result download
- Generation metadata/manifests
- Retry/backoff
- Structured errors
- Motion discovery/cache
- Soul style discovery/cache
- Optional Soul/custom character references
- Optional speech-to-video adapter
- Dry-run request validation
- Agent-friendly JSON output

### 3.2 Out of scope for v1.0

Do NOT build:

- MCP server
- HTTP application server
- database
- Redis/queue
- web dashboard
- user accounts
- billing system
- distributed workers
- automatic prompt rewriting with an LLM
- autonomous Higgsfield Agent API
- Remotion rendering logic inside the Higgsfield adapter

---

## 4. Repository Layout

Recommended standalone layout:

```text
higgsfield-tools/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
│
├── bin/
│   └── hf.ts
│
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── image.ts
│   │   │   ├── video.ts
│   │   │   ├── upload.ts
│   │   │   ├── generate.ts
│   │   │   ├── status.ts
│   │   │   ├── motions.ts
│   │   │   ├── styles.ts
│   │   │   └── doctor.ts
│   │   ├── output.ts
│   │   └── exit-codes.ts
│   │
│   ├── application/
│   │   ├── generate-image.ts
│   │   ├── generate-video.ts
│   │   ├── upload-media.ts
│   │   ├── download-result.ts
│   │   ├── inspect-job.ts
│   │   └── fingerprint.ts
│   │
│   ├── domain/
│   │   ├── media-provider.ts
│   │   ├── generation.ts
│   │   ├── asset.ts
│   │   ├── errors.ts
│   │   └── model-registry.ts
│   │
│   ├── providers/
│   │   └── higgsfield-v1/
│   │       ├── client.ts
│   │       ├── provider.ts
│   │       ├── mapper.ts
│   │       ├── endpoints.ts
│   │       ├── upload.ts
│   │       └── errors.ts
│   │
│   ├── storage/
│   │   ├── asset-store.ts
│   │   ├── manifest-store.ts
│   │   └── cache-store.ts
│   │
│   ├── config/
│   │   ├── env.ts
│   │   └── defaults.ts
│   │
│   └── index.ts
│
├── skills/
│   ├── higgsfield-image-generation/
│   │   └── SKILL.md
│   ├── higgsfield-video-generation/
│   │   └── SKILL.md
│   └── higgsfield-media-workflow/
│       └── SKILL.md
│
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

When embedded in a Remotion project, `tools/higgsfield/` may contain the same package as a workspace package.

---

## 5. Public Contract: CLI

Expose one executable:

```bash
hf
```

Agents MUST use this interface instead of importing `@higgsfield/client` directly.

### 5.1 Doctor

```bash
hf doctor --json
```

Checks:

- Node runtime
- credentials present
- API connectivity/authentication where safely testable
- writable output directory
- supported provider
- package version

No generation must occur.

### 5.2 Text-to-image

```bash
hf image \
  --prompt "Editorial portrait..." \
  --preset portrait-hd \
  --output ./projects/demo/assets/shot-001 \
  --json
```

Optional flags:

```text
--style <name|id>
--seed <number>
--batch <1..N>
--reference <path|url>
--reference-strength <0..1>
--force
--dry-run
```

The preset resolves V1-specific size/quality parameters.

### 5.3 Image-to-video

```bash
hf video \
  --input ./projects/demo/assets/keyframe-003.png \
  --prompt "Slow cinematic dolly-in..." \
  --preset cinematic \
  --motion "Zoom In" \
  --output ./projects/demo/assets/shot-003 \
  --json
```

Optional:

```text
--model <logical-model>
--motion-strength <0..1>
--force
--dry-run
```

### 5.4 Upload

```bash
hf upload ./reference.png --json
```

Returns a remote URL suitable for Higgsfield input.

### 5.5 Generic endpoint escape hatch

```bash
hf generate \
  --endpoint /v1/... \
  --input ./request.json \
  --output ./assets/custom-001 \
  --json
```

This exists for supported V1 capabilities not yet promoted to first-class commands.

Skills SHOULD prefer typed first-class commands.

### 5.6 Discovery

```bash
hf motions --refresh --json
hf styles --refresh --json
```

Discovery results are cached locally with timestamp/version metadata.

---

## 6. JSON Output Contract

Stdout in `--json` mode MUST contain JSON only.

Success:

```json
{
  "ok": true,
  "operation": "image-to-video",
  "provider": "higgsfield-v1",
  "requestId": "remote-job-id",
  "status": "completed",
  "fingerprint": "sha256:...",
  "assets": [
    {
      "type": "video",
      "path": "projects/demo/assets/shot-003/video.mp4",
      "remoteUrl": "https://...",
      "mimeType": "video/mp4"
    }
  ],
  "manifest": "projects/demo/assets/shot-003/generation.json"
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Higgsfield account does not have enough API credits.",
    "retryable": false
  }
}
```

Human-readable diagnostics go to stderr.

---

## 7. Provider Boundary

Define a provider-neutral interface.

```ts
export interface MediaProvider {
  generate(request: GenerationRequest): Promise<GenerationResult>;
  upload(input: UploadRequest): Promise<UploadedAsset>;
  getStatus(requestId: string): Promise<GenerationStatus>;
  listMotions?(): Promise<MotionPreset[]>;
  listStyles?(): Promise<StylePreset[]>;
}
```

Application code MUST NOT expose:

- `JobSet`
- `SoulId`
- Higgsfield helper enums
- Higgsfield endpoint paths
- Higgsfield error classes

outside `providers/higgsfield-v1`.

This is the migration seam.

Future migration:

```text
MediaProvider
   |
   +-- HiggsfieldV1Provider   <- now
   |
   +-- HiggsfieldV2Provider   <- later
```

Skills and CLI remain unchanged.

---

## 8. V1 Provider

Use:

```ts
import { HiggsfieldClient } from "@higgsfield/client";
```

Configuration:

```ts
const client = new HiggsfieldClient({
  apiKey: process.env.HF_API_KEY,
  apiSecret: process.env.HF_SECRET,
  timeout: 120_000,
  maxRetries: 3,
  retryBackoff: 1_000,
  retryMaxBackoff: 30_000,
  pollInterval: 2_000,
  maxPollTime: 10 * 60_000,
});
```

Environment:

```dotenv
HF_API_KEY=
HF_SECRET=
```

Never commit `.env`.

### V1 generation

The provider may use:

```ts
client.generate(endpoint, params, {
  withPolling: true,
});
```

but MUST normalize the returned V1 `JobSet` into the provider-neutral result.

---

## 9. Model / Endpoint Registry

Do not let Skills hard-code raw endpoint paths.

Create a logical registry:

```ts
type Capability = "text-to-image" | "image-to-video" | "speech-to-video" | "character-reference";

interface ModelDefinition {
  id: string;
  provider: "higgsfield-v1";
  capability: Capability;
  endpoint: string;
  enabled: boolean;
  defaults: Record<string, unknown>;
}
```

Example:

```ts
{
  id: "soul-image",
  provider: "higgsfield-v1",
  capability: "text-to-image",
  endpoint: "/v1/text2image/soul",
  enabled: true,
  defaults: {
    quality: "hd",
    batch: 1
  }
}
```

and:

```ts
{
  id: "dop-video",
  provider: "higgsfield-v1",
  capability: "image-to-video",
  endpoint: "/v1/image2video/dop",
  enabled: true
}
```

Endpoint-specific mapping stays inside V1.

---

## 10. Presets

Agents reason better with semantic presets than provider parameters.

Example:

```yaml
image:
  square-hd:
    aspect: "1:1"
    quality: "hd"

  portrait-hd:
    aspect: "3:4"
    quality: "hd"

video:
  cinematic:
    model: "dop-video"
    motionStrength: 0.8
```

The V1 mapper converts these to SDK enums/helpers.

Do not make the agent memorize `SoulSize`, `SoulQuality`, `DoPModel`, etc.

---

## 11. Input Asset Handling

Input may be:

- HTTP/HTTPS URL
- local image
- local audio where supported

For local media:

```text
local path
   |
validate type/size
   |
hash file
   |
upload through V1 SDK
   |
remote CDN URL
   |
use in generation request
```

Use V1:

```ts
client.uploadImage(buffer, format);
```

or generic:

```ts
client.upload(data, contentType);
```

Never embed local file bytes in an agent prompt.

Uploaded URL cache:

```text
.cache/higgsfield/uploads.json
```

Key by SHA-256 of file content to avoid unnecessary repeated uploads during the same project lifecycle.

---

## 12. Generation Lifecycle

Canonical synchronous local workflow:

```text
validate
  |
resolve preset/model
  |
resolve/upload references
  |
calculate fingerprint
  |
check existing completed manifest
  |
submit V1 generation
  |
SDK polling
  |
normalize JobSet
  |
download media
  |
verify downloaded file
  |
write manifest atomically
  |
return JSON
```

Terminal statuses:

```text
completed
failed
nsfw
canceled
timeout
```

Never treat a polling timeout as a confirmed generation failure. Return `TIMEOUT` with the remote request/job ID when available.

---

## 13. Polling and Long Jobs

For the local-agent use case, polling is the default.

Recommended defaults:

```text
pollInterval:       2 seconds
maxPollTime image:  5 minutes
maxPollTime video:  15 minutes
```

These are adapter defaults, not API guarantees.

CLI should eventually support:

```bash
hf status <request-id> --json
```

If the SDK exposes insufficient resumability for a specific V1 job type, record that limitation explicitly rather than pretending the request can be resumed.

Webhooks are not required for the local v1.0 architecture.

---

## 14. Retry Policy

Retry only transient operations:

- network reset
- timeout before server acceptance is known
- HTTP 429
- eligible 5xx

Do NOT automatically retry:

- authentication errors
- validation errors
- insufficient credits
- moderation/NSFW
- known bad input

Use exponential backoff + jitter.

Generation retry is especially conservative because duplicate submission can incur cost.

Rule:

> Never automatically resubmit a generation when it is ambiguous whether Higgsfield accepted the previous request.

---

## 15. Idempotency / Duplicate Protection

Before submission compute:

```text
SHA256(
  provider +
  logical model +
  normalized parameters +
  prompt +
  hashes of input assets
)
```

Store as `fingerprint`.

If a completed manifest with the same fingerprint exists:

```text
return existing result
```

unless:

```bash
--force
```

This is local duplicate protection; do not claim it is remote API idempotency.

---

## 16. Asset Store

Default:

```text
projects/<project>/assets/<asset-id>/
├── image-01.png
├── video.mp4
├── thumbnail.jpg
└── generation.json
```

Example manifest:

```json
{
  "schemaVersion": 1,
  "assetId": "shot-003",
  "provider": "higgsfield-v1",
  "capability": "image-to-video",
  "logicalModel": "dop-video",
  "fingerprint": "sha256:...",
  "createdAt": "ISO-8601",
  "prompt": "Slow cinematic dolly-in...",
  "inputs": [
    {
      "kind": "image",
      "localPath": "../keyframes/shot-003.png",
      "sha256": "..."
    }
  ],
  "request": {
    "preset": "cinematic",
    "motion": "Zoom In"
  },
  "remote": {
    "requestId": "...",
    "status": "completed"
  },
  "outputs": [
    {
      "type": "video",
      "path": "video.mp4",
      "mimeType": "video/mp4",
      "sha256": "..."
    }
  ]
}
```

Do not store secrets.

---

## 17. Download Policy

Remote result URLs are not the project's source of truth.

On completion:

1. Download output.
2. Write to `.partial`.
3. Validate non-zero size.
4. Validate expected media content type where possible.
5. Rename atomically to final filename.
6. Compute SHA-256.
7. Save manifest.

Remotion consumes local files only.

---

## 18. Error Taxonomy

Normalize SDK errors:

```text
AUTHENTICATION_FAILED
INSUFFICIENT_CREDITS
INVALID_INPUT
VALIDATION_FAILED
RATE_LIMITED
PROVIDER_UNAVAILABLE
GENERATION_FAILED
MODERATION_REJECTED
CANCELED
TIMEOUT
UPLOAD_FAILED
DOWNLOAD_FAILED
LOCAL_IO_ERROR
UNKNOWN_PROVIDER_ERROR
```

Each error:

```ts
interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  details?: unknown;
}
```

Sanitize `details`.

---

## 19. Logging

Default logs:

```text
[info] preparing image-to-video
[info] uploading reference image
[info] submitted generation <short-id>
[info] waiting for completion
[info] downloading result
[info] saved assets/shot-003/video.mp4
```

Never log:

- API key
- API secret
- authorization headers
- signed upload credentials
- entire environment
- sensitive binary payloads

`--json` keeps stdout machine-readable; logs use stderr.

---

## 20. Security

Required:

```gitignore
.env
.env.*
!.env.example
.cache/higgsfield/
```

Credentials MUST come from environment variables.

The adapter MUST run on the trusted local/server side.

Agents must never be instructed to:

- print credentials
- put credentials in `AGENTS.md`
- commit `.env`
- insert credentials into Remotion/browser code

---

## 21. Agent Skills

Skills are procedural knowledge, not API clients.

### 21.1 `higgsfield-image-generation`

Teach:

- when an image should be generated
- when an existing project asset should be reused
- text-to-image vs character/reference workflow
- aspect ratio selection
- prompt construction
- variant policy
- calling `hf image`
- inspecting the resulting manifest

Important rule:

> Reuse an existing approved asset unless the task explicitly requires a new visual.

### 21.2 `higgsfield-video-generation`

Teach:

- prefer image-to-video when visual identity/character/product consistency matters
- select a source keyframe first
- describe subject action separately from camera movement
- use motion presets where appropriate
- call `hf video`
- never regenerate an approved shot merely to change edit timing; change timing in Remotion

### 21.3 `higgsfield-media-workflow`

Teach the full pipeline:

```text
brief
  -> storyboard
  -> shot list
  -> inventory existing assets
  -> generate missing keyframes
  -> approve/reuse keyframes
  -> animate required shots
  -> save local media
  -> update shot metadata
  -> compose in Remotion
```

---

## 22. Agent Execution Rules

The agent MUST:

1. Read relevant Skill.
2. Inspect existing assets.
3. Avoid duplicate generation.
4. Use `--dry-run` when uncertain about resolved parameters.
5. Generate the minimum number of variants required.
6. Use `--json` for programmatic calls.
7. Read returned manifest.
8. Verify local output exists.
9. Reference the local asset from Remotion.

The agent MUST NOT:

- import Higgsfield SDK directly in arbitrary scene code
- modify V1 provider implementation just to make one generation work
- expose credentials
- repeatedly retry paid generations without understanding failure
- use Higgsfield to solve editing problems Remotion can solve deterministically

---

## 23. Remotion Integration

Correct:

```text
Higgsfield -> assets/shot-003/video.mp4
                         |
                         v
                    Remotion scene
```

Incorrect:

```text
Remotion render
     |
     +--> calls Higgsfield API
```

A Remotion render MUST be deterministic and network-independent with respect to generation.

Generated assets should already exist before rendering.

---

## 24. Example Agent Workflow

User:

```text
Create a 30-second cinematic launch film.
Use Higgsfield for missing AI footage and Remotion for composition.
```

Agent:

```text
1. Read media + Remotion skills.
2. Build storyboard.
3. Build shots.json.
4. Scan project assets.
5. Determine missing source media.
6. Generate keyframes with:
      hf image ... --json
7. Generate motion shots with:
      hf video ... --json
8. Store/verify local assets.
9. Build Remotion scenes.
10. Preview representative frames.
11. Adjust editing/motion/text in Remotion.
12. Only regenerate AI footage when the source media itself is wrong.
13. Render final film.
```

This distinction controls cost:

```text
content problem   -> regenerate with Higgsfield
editing problem   -> fix with Remotion
```

---

## 25. `shots.json` Integration

Recommended:

```json
{
  "id": "shot-003",
  "duration": 5,
  "source": {
    "type": "generated-video",
    "asset": "./assets/shot-003/video.mp4",
    "manifest": "./assets/shot-003/generation.json"
  },
  "creative": {
    "subjectAction": "Volunteer turns toward the school entrance",
    "camera": "slow dolly-in"
  },
  "status": "approved"
}
```

Statuses:

```text
planned
needs_asset
generating
generated
approved
rejected
```

Only `approved` assets should enter final compositions by default.

---

## 26. Testing Strategy

### Unit tests

Test without network:

- preset resolution
- endpoint mapping
- request normalization
- fingerprint stability
- V1 JobSet mapping
- error normalization
- manifest writing
- duplicate detection

### Integration tests

Use mocked HTTP/SDK boundaries for CI.

Test:

```text
queued -> completed
queued -> failed
queued -> nsfw
429 -> retry
500 -> retry
401 -> no retry
402 -> no retry
poll timeout
download failure
duplicate fingerprint
```

### Live smoke tests

Opt-in only:

```bash
HF_LIVE_TEST=1 npm run test:live
```

Never run paid live generation in normal CI.

---

## 27. Exit Codes

Suggested:

```text
0   success
2   invalid CLI usage
10  authentication
11  insufficient credits
12  validation/input
20  provider/network
21  rate limit
22  timeout
30  generation failed
31  moderation rejected
40  upload/download
50  local filesystem
70  unexpected
```

Agents should primarily consume JSON `error.code`; exit code is secondary.

---

## 28. Production Readiness Checklist

Before v1.0:

- [ ] Credentials loaded only from environment
- [ ] `hf doctor`
- [ ] text-to-image command
- [ ] image-to-video command
- [ ] upload command
- [ ] generic endpoint command
- [ ] JSON-only stdout mode
- [ ] V1 provider isolation
- [ ] request fingerprinting
- [ ] duplicate-generation protection
- [ ] atomic downloads
- [ ] manifests
- [ ] error normalization
- [ ] conservative retries
- [ ] motion/style cache
- [ ] unit tests
- [ ] mocked integration tests
- [ ] live tests opt-in
- [ ] Skills contain no credentials/endpoints
- [ ] Remotion uses local assets only
- [ ] README migration note for V2

---

## 29. Migration to Higgsfield V2

V1 deprecation is accepted as a short-term implementation choice.

Migration MUST require only:

```text
src/providers/higgsfield-v1/
            |
            v
src/providers/higgsfield-v2/
```

Do not change:

```text
hf image
hf video
hf upload
hf generate
JSON output schema
asset manifests
Skills
Remotion integration
```

V2 provider adapts its native response into the same domain types.

A feature flag may select provider:

```dotenv
HF_PROVIDER=higgsfield-v1
```

Future:

```dotenv
HF_PROVIDER=higgsfield-v2
```

---

## 30. Recommended Implementation Order

### Phase 1 — Foundation

- project scaffold
- domain types
- provider interface
- configuration
- V1 client
- JSON output
- `doctor`

### Phase 2 — Core Generation

- upload
- text-to-image
- image-to-video
- polling/result normalization
- local download
- manifests

### Phase 3 — Safety / Reliability

- fingerprints
- duplicate protection
- retries
- error normalization
- atomic IO
- tests

### Phase 4 — Agent UX

- semantic presets
- motions/styles discovery
- Skills
- `--dry-run`
- example `AGENTS.md`

### Phase 5 — Film Workflow

- `shots.json`
- Remotion example
- approved/rejected asset lifecycle
- end-to-end sample project

---

## 31. Definition of Done

The adapter is production-ready for the intended local agent workflow when this command can be executed by any shell-capable coding agent:

```bash
hf video \
  --input ./projects/demo/keyframes/shot-01.png \
  --prompt "Subtle natural movement, slow cinematic push-in" \
  --preset cinematic \
  --output ./projects/demo/assets/shot-01 \
  --json
```

and the agent receives a stable response pointing to:

```text
projects/demo/assets/shot-01/video.mp4
projects/demo/assets/shot-01/generation.json
```

without needing to know:

- Higgsfield authentication headers
- V1 endpoint structure
- SDK helper enums
- JobSet internals
- polling mechanics
- upload mechanics
- download mechanics

The resulting local asset can then be consumed directly by Remotion.

---

## 32. Final Architecture

```text
                         USER
                           |
                           v
                    OMP / Pi / OpenCode
                           |
                  +--------+---------+
                  |                  |
                  v                  v
              Agent Skills        AGENTS.md
                  |
                  v
              hf CLI contract
                  |
                  v
             Application layer
                  |
                  v
             MediaProvider
                  |
                  v
         HiggsfieldV1Provider
                  |
                  v
          @higgsfield/client
                  |
                  v
            Higgsfield API
                  |
                  v
        local generated assets
                  |
           +------+------+
           |             |
           v             v
       shots.json     Remotion
                         |
                         v
                    final video
```

The central rule is:

> **Skills decide. The CLI executes. The provider translates. Higgsfield generates. Remotion composes.**
