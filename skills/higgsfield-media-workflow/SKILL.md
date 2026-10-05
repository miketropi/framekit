---
name: higgsfield-media-workflow
description: Run the end-to-end AI media pipeline for a film or campaign — brief, storyboard, shot list, asset inventory, keyframe generation, approval, animation, local asset storage, shot metadata, and Remotion composition.
---

# Higgsfield media workflow

Use this skill to orchestrate a whole piece of content, not a single asset. It defines the
pipeline, the rules that keep spend under control, and the boundary between generated
content and deterministic editing.

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
whenever the resolved preset, style, or reference is uncertain.

### 5. Approve before animating

Review stills first, then freeze the approved keyframes. Animating an unapproved keyframe
duplicates the cost of a rejected concept.

### 6. Animate required shots

For each shot that needs motion, follow `higgsfield-video-generation`, feeding the approved
keyframe. Keep the prompt about action and camera only.

### 7. Store and verify locally

Every generation writes media plus `generation.json` inside the shot's output directory.
Verify `ok: true`, a completed status, a non-empty local file, and a matching SHA-256
before treating an asset as real.

### 8. Compose in Remotion

Scenes consume local files only (`staticFile`), never remote URLs and never the Higgsfield
SDK. See `examples/remotion-consumption.tsx`.

## Cost discipline

- **Content problem** (wrong subject, wrong identity, wrong framing) → regenerate with
  Higgsfield.
- **Editing problem** (timing, speed, cut, text, color grade) → fix deterministically in
  Remotion.

That distinction is the single biggest cost control in this pipeline. Regenerating to
change edit timing is always a mistake.

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

MUST NOT:

- Import a provider SDK into scene code or Skill examples.
- Modify provider implementation to make one generation work.
- Print, log, or commit credentials (`HF_API_KEY`, `HF_SECRET`).
- Repeatedly retry paid generations without understanding the failure.
- Use Higgsfield to solve an editing problem Remotion can solve deterministically.
- Resubmit a `TIMEOUT` or `MODERATION_REJECTED` result unchanged.

## Failure routing

| Code                                                 | Owner        | Action                                                                |
| ---------------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `VALIDATION_FAILED`, `INVALID_INPUT`                 | the agent    | fix arguments or inputs, then retry                                   |
| `AUTHENTICATION_FAILED`, `INSUFFICIENT_CREDITS`      | the operator | stop, report, wait for account fix                                    |
| `MODERATION_REJECTED`                                | creative     | change the concept, not the wording alone                             |
| `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`               | platform     | retry with backoff                                                    |
| `TIMEOUT`                                            | unknown      | inspect `requestId` with `hf status` before any resubmission          |
| `GENERATION_FAILED`, `CANCELED`                      | creative     | adjust the request; only then resubmit                                |
| `UPLOAD_FAILED`, `DOWNLOAD_FAILED`, `LOCAL_IO_ERROR` | environment  | fix the file/path/permission; the remote job may still be inspectable |
