import type { GenerationOutcome } from "../application/generate";
import { scrubUrlForStorage } from "../domain/redact";
import type { SuccessEnvelope } from "./output";

/** §6 success envelope for generation commands. */
export function generationEnvelope(outcome: GenerationOutcome): SuccessEnvelope {
  return {
    ok: true,
    operation: outcome.operation,
    provider: outcome.provider,
    status: outcome.status,
    ...(outcome.requestId === undefined ? {} : { requestId: outcome.requestId }),
    fingerprint: outcome.fingerprint,
    logicalModel: outcome.logicalModel,
    outputDirectory: outcome.outputDirectory,
    ...(outcome.manifest === undefined ? {} : { manifest: outcome.manifest }),
    assets: outcome.assets.map((asset) => ({
      ...asset,
      // Remote URLs are informational: signed query parameters are not surfaced.
      ...(asset.remoteUrl === undefined ? {} : { remoteUrl: scrubUrlForStorage(asset.remoteUrl) }),
    })),
    inputs: outcome.inputs,
    resolvedRequest: outcome.resolvedRequest,
    reused: outcome.reused,
    dryRun: outcome.dryRun,
  };
}
