---
name: higgsfield-media-workflow
description: Run the end-to-end AI media pipeline for a film or campaign — brief, storyboard, shot list, asset inventory, keyframe generation, approval, animation, local asset storage, shot metadata, and Remotion composition.
---

# Higgsfield media workflow

Use this skill to orchestrate a whole piece of content, not a single asset. It defines the
pipeline, the rules that keep spend under control, and the boundary between generated
content and deterministic editing.

## Prerequisites and scope

- Credentials come from the environment or a `.env` in the working directory
  (`HF_CREDENTIALS="<key_id>:<key_secret>"`, or `HF_API_KEY` + `HF_API_SECRET`); never
  print, log, or commit them. `hf doctor --json` reports the setup (add `--check-upload`
  for a non-billable probe of the upload path), and `hf --help` lists every command.
- Scope: `hf` covers the provider's **V1** capabilities (`soul-image`, `dop-video`,
  `speak-video`). Other provider models (for example `bytedance/seedance-*`, `kling-*`)
  are reachable only through the provider's v2 endpoints — if you need one, say so
  explicitly; it is **not** an `hf` command, and anything it produces is not an adapter
  asset (see "Provenance" below).

## Pipeline

```
brief -> storyboard -> shots.json -> inventory existing assets
      -> generate missing keyframes (hf image)
      -> review / approve keyframes
      -> animate required shots (hf video)
      -> local media + generation.json
      -> update shot metadata
      -> compose in Remotion
```

### 1. Brief and storyboard

Turn the request into shot-sized beats. Each beat must be answerable by one still image or
one animatable image. Capture intent, not pixels: subject, framing, mood, and movement.

### 2. Shot list

Write shots as data (see `examples/shots.json`). Each entry carries `id`, `duration`,
`source`, `creative`, and `status`. Allowed statuses:

```
planned | needs_asset | generating | generated | approved | rejected
```

Only `approved` assets enter final compositions by default. Update the status as the shot
moves; the file is the project's record of what was paid for.

### 3. Inventory before generating

Search for existing assets and read their manifests (`projects/**/assets/*/generation.json`).
An asset that already exists and is approved must be reused. Only shots with no usable
asset become `needs_asset`.

### 4. Generate keyframes

For each `needs_asset` shot, follow `higgsfield-image-generation`. Prefer one variant; go
to `--batch 4` only when a selection step is genuinely required. Use `--dry-run --json`
whenever the resolved preset, style, or reference is uncertain. Keep prompts text-free:
titles, captions, and links are composited later, never generated.

### 5. Approve before animating

Review stills first, then freeze the approved keyframes. Animating an unapproved keyframe
duplicates the cost of a rejected concept.

### 6. Animate required shots

For each shot that needs motion, follow `higgsfield-video-generation`, feeding the approved
keyframe. Keep the prompt about action and camera only, and expect 1280×720 output whatever
the keyframe's resolution.

### 7. Store and verify locally

Every generation writes media plus `generation.json` inside the shot's output directory.
Verify `ok: true`, a completed status, a non-empty local file, and a matching SHA-256
before treating an asset as real.

If a local file is missing or corrupt, do **not** re-run the generation:
`hf status <requestId> --json` returns the provider's result URLs in `details.resultUrls`,
which recovers the media for free. Re-generate only when the provider no longer serves the
asset, and note that in the shot's history.

### 8. Compose in Remotion

Scenes consume local files only (`staticFile`), never remote URLs and never the Higgsfield
SDK. See `examples/remotion-consumption.tsx`. Typography, timing, speed, and colour belong
here — the generator cannot render legible text.

## Provenance

- Assets produced by `hf` carry `generation.json`: fingerprint, resolved request, provider
  request id, and output SHA-256. Cite that file.
- Assets produced by anything else (a provider v2 model endpoint, a web app, an MCP tool)
  are **not** `hf` outputs. Never hand-write a `generation.json` for them; record them in a
  separate file next to the media (for example `provenance.json`: model, request id,
  status, input parameters, remote URL, local SHA-256) and label them as such in docs,
  shot lists, or READMEs. Do not present them as adapter output.

## Cost discipline

- **Content problem** (wrong subject, wrong identity, wrong framing) → regenerate with
  Higgsfield.
- **Editing problem** (timing, speed, cut, text, color grade) → fix deterministically in
  Remotion.

That distinction is the single biggest cost control in this pipeline. Regenerating to
change edit timing is always a mistake. Confirm the per-job cost posture before using any
model whose price is not documented, and never bypass a configured spend cap silently.

## Agent execution rules

MUST:

1. Read the relevant skill before acting.
2. Inspect existing assets and manifests.
3. Avoid duplicate generation (identical requests reuse the manifest fingerprint).
4. Use `--dry-run` when uncertain about resolved parameters.
5. Generate the minimum number of variants.
6. Use `--json` for programmatic calls and parse stdout only.
7. Read the returned manifest after every successful generation.
8. Verify the local output exists and matches its recorded hash.
9. Reference local assets from Remotion.
10. Recover a paid result by `requestId` (`hf status … --json`) before considering a re-run.

MUST NOT:

- Import a provider SDK into scene code or Skill examples.
- Modify provider implementation to make one generation work.
- Print, log, or commit credentials (`HF_CREDENTIALS`, `HF_API_KEY`, `HF_SECRET`).
- Repeatedly retry paid generations without understanding the failure.
- Use Higgsfield to solve an editing problem Remotion can solve deterministically.
- Resubmit a `TIMEOUT` or `MODERATION_REJECTED` result unchanged.
- Present non-`hf` media as adapter output, or invent a manifest for it.

## Failure routing

| Code                                            | Owner                         | Action                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`, `INVALID_INPUT`            | the agent                     | fix arguments or inputs, then retry                                                                                                                                                                                                            |
| `AUTHENTICATION_FAILED`, `INSUFFICIENT_CREDITS` | the operator                  | stop, report, wait for account fix                                                                                                                                                                                                             |
| `MODERATION_REJECTED`                           | creative                      | change the concept, not the wording alone                                                                                                                                                                                                      |
| `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`          | platform                      | retry with backoff                                                                                                                                                                                                                             |
| `TIMEOUT`                                       | unknown                       | inspect `requestId` with `hf status` before any resubmission                                                                                                                                                                                   |
| `GENERATION_FAILED`, `CANCELED`                 | creative                      | adjust the request; only then resubmit                                                                                                                                                                                                         |
| `UPLOAD_FAILED`                                 | upstream storage, not credits | if `error.details.stage` is `signed-url-put` the provider rejected its own signed URL: confirm with `hf doctor --check-upload --json`, then pass an HTTPS `--input <url>` (skips uploads) or wait, and report the `providerCode`/`storageHost` |
| `DOWNLOAD_FAILED`, `LOCAL_IO_ERROR`             | environment                   | fix the output path/permissions, then recover the media by `requestId` via `hf status` (`details.resultUrls`) instead of paying again                                                                                                          |
