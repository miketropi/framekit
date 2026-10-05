/**
 * Provider-private V1 route knowledge (§7/§8). Nothing outside
 * `providers/higgsfield-v1` may import this module.
 *
 * Typed model endpoints live in the logical registry; this module covers the
 * route the registry does not model: raw job-set status.
 */

/** Matches the official SDK's `JobSet.pollingUrl`. */
export function jobSetRoute(requestId: string): string {
  return `/v1/job-sets/${encodeURIComponent(requestId)}`;
}

/** Generic-endpoint allow-list (§5.5): only V1 routes are addressable. */
export const ALLOWED_GENERIC_ENDPOINT_PREFIX = "/v1/";
