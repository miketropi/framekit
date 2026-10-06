/**
 * Authoritative V1 parameter value sets, measured against the live API.
 *
 * The published SDK (`@higgsfield/client@0.2.6`) ships enum constants that have drifted:
 * its `DoPModel.STANDARD = "dop-standard"` is rejected by `/v1/image2video/dop` (which
 * accepts `dop-lite`, `dop-preview`, `dop-turbo`), and its `SoulSize` is missing three
 * resolutions the API accepts. These sets come from the API's own validation responses
 * (422 bodies list the accepted values), so the adapter validates against reality rather
 * than against a stale constant.
 *
 * Harvested 2026-10-06. Re-harvest with a type-invalid request to the relevant endpoint;
 * such a request can never be accepted, so it cannot create a billable job.
 */

export const V1_DOP_MODELS = ["dop-lite", "dop-preview", "dop-turbo"] as const;

export const V1_SOUL_QUALITIES = ["720p", "1080p"] as const;

export const V1_SOUL_BATCHES = [1, 4] as const;

export const V1_SOUL_SIZES = [
  "1152x2048",
  "2048x1152",
  "2048x1536",
  "1536x2048",
  "1344x2016",
  "2016x1344",
  "960x1696",
  "1536x1536",
  "1536x1152",
  "1696x960",
  "1152x1536",
  "1088x1632",
  "1632x1088",
  "1120x1680",
  "1680x1120",
  "2048x2048",
] as const;

export const V1_SPEAK_QUALITIES = ["high", "mid"] as const;

export const V1_SPEAK_DURATIONS = [5, 10, 15] as const;

/** Motion identifiers are UUIDs; the API rejects anything else. */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
