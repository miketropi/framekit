---
name: higgsfield-video-generation
description: Animate an approved keyframe with Higgsfield image-to-video, keep identity consistent, separate subject action from camera movement, and recover a paid result by request id instead of re-rendering it.
---

# Higgsfield video generation

Use this skill when a shot needs **motion** and the project already owns (or should own) a
keyframe. Source media comes from Higgsfield; timing, cuts, speed, and text stay in
Remotion.

## Prerequisites and scope

- Credentials come from the environment or a `.env` in the working directory
  (`HF_CREDENTIALS="<key_id>:<key_secret>"`, or `HF_API_KEY` + `HF_API_SECRET`). Never
  print, log, or commit them.
- When setup is in doubt, run `hf doctor --json` first (add `--check-upload` to probe the
  upload path, non-billable). It generates nothing.
- Scope: `hf video` drives the provider's **V1** image-to-video model (`dop-video`).
  Other provider video models (for example `bytedance/seedance-*`, `kling-*`) are **not**
  reachable through `hf` — they live on the provider's v2 endpoints, outside this tool.
- This model returns **1280×720**, whatever the input keyframe's resolution, so plan the
  edit at 720p or upscale deliberately rather than expecting a 2048-wide master.

## Before you animate

1. **Select the source keyframe deliberately.** Prefer an approved image whose identity
   must carry through the shot. Feed the same keyframe to every variant you compare, so
   differences come from the prompt rather than the input.
2. **Reuse before regenerating.** An approved shot with a completed manifest is already
   paid for. If only the edit timing is wrong, change it in Remotion — never regenerate the
   footage.
3. **Describe action and camera separately.** The prompt is about motion: what the subject
   does, then how the camera behaves. Keep them as two clauses.

```
"Volunteer turns toward the school entrance, then walks out of frame; slow cinematic
dolly-in, shallow depth of field, natural light"
```

Do not describe cuts, durations, or music — those belong to the composition step. The
model also cannot render legible text, URLs, or captions: keep prompts text-free and
composite copy later.

## Motion presets

Provider motions are optional and named. Inspect them once and cache the ids:

```bash
hf motions --json
```

`--motion` accepts an exact id first, then an exact name (case-insensitive). Ambiguous or
unknown names fail with `VALIDATION_FAILED` and candidate ids. `--motion-strength <0..1>`
requires `--motion`; when the `cinematic` preset is used the preset supplies `0.8` unless
you override it.

## Running the command

```bash
hf video \
  --input projects/demo/keyframes/shot-03.png \
  --prompt "Subtle natural movement; slow cinematic push-in" \
  --preset cinematic \
  --output projects/demo/assets/shot-003 \
  --json
```

Rules:

- `--input` accepts a local image or an https URL. Local files are validated by content,
  hashed, and uploaded once per content hash; the URL is cached, so repeated commands do
  not re-upload. A URL input skips uploading entirely.
- Use `--dry-run --json` to confirm the resolved preset, model, motion, and input hash
  before paying.
- `--model` overrides the preset's logical model. The provider model values it resolves to
  are `dop-lite`, `dop-preview` and `dop-turbo` (the published SDK's `dop-standard` is no
  longer accepted by the API, and the `cinematic` preset defaults to `dop-turbo`).
- Never pass `--force` to "try again": without it, an identical request returns the local
  asset immediately and a conflicting completed directory fails instead of overwriting.
- Long jobs poll; a `TIMEOUT` result is not a failure. It carries `requestId` and
  `resumeWith` — check `hf status <request-id> --json` before deciding to resubmit.

## Verify the result

1. `status: "completed"`, `manifest` present, and `assets[0].path` pointing at
   `<output>/video.mp4`.
2. The file exists, is non-empty, and its SHA-256 matches `assets[0].sha256`.
3. `generation.json` records the capability `image-to-video`, the input image path and
   hash, and the resolved request — cite this when the shot is questioned later.
4. Mark the shot `generated`, then `approved` after review, and reference only the local
   path from Remotion.
5. **Lost the file?** Do not re-render: `hf status <requestId> --json` returns the
   provider's result URLs in `details.resultUrls` (`details.source` names the route that
   answered: `job-set` or `request`).

## Failure handling

| Code                                    | What to do                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GENERATION_FAILED`                     | inspect `requestId` with `hf status`; change the prompt/input before resubmitting                                                                                                                                                                                                          |
| `MODERATION_REJECTED`                   | change the concept; resubmitting unchanged will fail again                                                                                                                                                                                                                                 |
| `CANCELED`                              | decide whether the shot is still needed before paying again                                                                                                                                                                                                                                |
| `VALIDATION_FAILED`                     | fix flags, motion name ambiguity, model value, or output-directory conflict                                                                                                                                                                                                                |
| `INVALID_INPUT`                         | the keyframe is missing, empty, not a supported image, or too large                                                                                                                                                                                                                        |
| `UPLOAD_FAILED`                         | a local input could not be uploaded. With `error.details.stage == "signed-url-put"` the provider's own storage rejected its signed URL — **not** a credits problem. Confirm with `hf doctor --check-upload --json`, then pass an HTTPS `--input <url>` (skips uploads) or wait. Never loop |
| `TIMEOUT`                               | not a failure: inspect status, then resume or resubmit deliberately                                                                                                                                                                                                                        |
| `RATE_LIMITED` / `PROVIDER_UNAVAILABLE` | genuinely retryable with backoff                                                                                                                                                                                                                                                           |
| `DOWNLOAD_FAILED` / `LOCAL_IO_ERROR`    | fix the output path/permissions, then recover the media for free with `hf status <requestId> --json` (`details.resultUrls`) instead of paying again                                                                                                                                        |
