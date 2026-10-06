---
name: higgsfield-image-generation
description: Decide when to generate a Higgsfield image, reuse an approved local asset, or use a reference/character workflow; drive `hf image`, verify the resulting manifest, and recover a paid result by request id instead of regenerating it.
---

# Higgsfield image generation

Use this skill when a task needs a **new still image** (keyframe, hero shot, product
frame, portrait) and the project does not already own an approved asset for it.

## Prerequisites and scope

- Credentials come from the environment or a `.env` in the working directory
  (`HF_CREDENTIALS="<key_id>:<key_secret>"`, or `HF_API_KEY` + `HF_API_SECRET`). Never
  print, log, or commit them.
- When setup is in doubt, run `hf doctor --json` first: it reports credentials presence,
  provider support, output writability, and discovery reachability, and it generates
  nothing. Add `--check-upload` to probe the upload path (non-billable).
- Scope: `hf` speaks the provider's **V1** surface — `soul-image` (text-to-image),
  `dop-video` (image-to-video), `speak-video` (speech-to-video). Other provider models
  (for example `bytedance/seedance-*` or `kling-*`) are **not** reachable through `hf`;
  they live on the provider's v2 endpoints and are outside this tool's contract.

## Decision order

1. **Inventory first.** Look for an existing asset: `projects/**/assets/*/generation.json`
   and the shot list. Run `hf motions --json` / `hf styles --json` when you need provider
   ids, not to discover assets.
2. **Reuse an approved asset** unless the task explicitly requires a new visual. Approved
   assets are recorded in the shot list (`status: "approved"`). Regenerating an approved
   image because composition changed is wasted money — composition is a Remotion problem.
3. **Generate** only for a genuinely new visual, or when the existing source media is
   wrong (wrong subject, wrong identity, wrong framing).

## Choose the workflow

| Situation                                                                | Workflow                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| No identity constraint, one-off still                                    | text-to-image with a preset                                                          |
| Visual identity must match existing footage (person, product, character) | text-to-image with `--character <id>` (custom reference) and/or `--reference <path>` |
| Style must match a house look                                            | `--style <name>` or an exact id from `hf styles --json`                              |
| Reproducing a previously approved frame                                  | same preset + `--seed` + same prompt and reference                                   |

Custom references are optional and cost-adjacent: create them once with
`hf characters create --name ... --reference ...`, then reuse the returned id. List them
with `hf characters list --json`.

## Presets decide geometry

Do not guess pixel sizes. Pick intent:

| Intent                           | Preset         | Result    |
| -------------------------------- | -------------- | --------- |
| Feed for image-to-video at 16:9  | `landscape-hd` | 2048x1152 |
| Portrait / mobile / talking head | `portrait-hd`  | 1536x2048 |
| Feed for square social crops     | `square-hd`    | 1536x1536 |

`--batch` accepts `1` or `4` and overrides the preset. `--batch 4` costs four images:
use it only when the task explicitly needs variants for a selection step.

## Prompt construction

- State subject, framing, lens/focal feel, lighting, and mood in one or two sentences.
- Describe the _image_, not the edit: no "then", no timing, no transitions.
- Keep identity descriptors stable across a shot sequence so consecutive frames match.
- **The model cannot render legible text or URLs.** Ask for "no text, no logos" and put
  titles, captions, and links in the composition step instead; typed glyphs come out
  garbled and cannot be trusted.
- Do not paste credentials, file contents, or base64 payloads into prompts.

## Running the command

```bash
hf image \
  --prompt "Editorial portrait, natural window light, 85mm, shallow depth of field" \
  --preset portrait-hd \
  --output projects/demo/assets/shot-001 \
  --json
```

Rules:

- Always pass `--json` for programmatic use; parse stdout, ignore stderr.
- Use `--dry-run --json` first whenever preset resolution or an input reference is
  uncertain. It validates, resolves the preset, and prints the fingerprint **without**
  uploading or generating.
- Add `--seed <n>` when you intend to reproduce or revisit the frame later.
- Pass `--reference <path|url>` and `--reference-strength <0..1>` when an existing image
  must steer the result; `--reference-strength` requires `--reference`.
- Do not pass `--force` unless you have decided to pay for a replacement. Without it, an
  identical request is served from the existing manifest, and a conflicting completed
  generation fails with `VALIDATION_FAILED`.

## Verify the result

1. `ok: true` and `status: "completed"`, with `assets[].path` pointing inside the output
   directory.
2. The local file exists and is non-empty; recompute its SHA-256 if you must prove it
   (`assets[].sha256`).
3. Read `generation.json` next to the media: `fingerprint`, `resolvedRequest`, `inputs`,
   and `outputs` are what you cite when explaining the shot later.
4. Record the asset in the shot list with `status: "generated"` (or `"approved"` after
   review) and the manifest path — never a remote URL.
5. **Lost the file?** Do not re-run: `hf status <requestId> --json` returns the provider's
   result URLs in `details.resultUrls` (and `details.source`, naming which route answered).
   Only regenerate when the provider no longer serves the asset.

If the command fails, act on `error.code`, not on exit code alone:

| Code                                                | What to do                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`                                 | fix the arguments (preset, bounded flags, conflicting output directory); do not retry as-is                                                                                                                                                                                                                   |
| `INVALID_INPUT`                                     | the local file is missing, empty, unsupported, or oversized                                                                                                                                                                                                                                                   |
| `UPLOAD_FAILED`                                     | a local input could not be uploaded. With `error.details.stage == "signed-url-put"` the provider's own storage rejected its signed URL — **not** a credits problem. Confirm with `hf doctor --check-upload --json`, then pass an HTTPS `--reference <url>` (URLs skip uploading) or wait for the upstream fix |
| `AUTHENTICATION_FAILED` / `INSUFFICIENT_CREDITS`    | an account state, not a storage state: stop and report; an operator must fix it                                                                                                                                                                                                                               |
| `RATE_LIMITED` / `PROVIDER_UNAVAILABLE` / `TIMEOUT` | retryable; a `TIMEOUT` on polling includes `requestId` — inspect with `hf status` before resubmitting                                                                                                                                                                                                         |
| `MODERATION_REJECTED`                               | rewrite the prompt or concept; do not resubmit unchanged                                                                                                                                                                                                                                                      |
| `DOWNLOAD_FAILED` / `LOCAL_IO_ERROR`                | fix the filesystem/output path before spending again, then recover the URL via `hf status`                                                                                                                                                                                                                    |
