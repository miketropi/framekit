import { ToolError } from "../domain/errors";
import type { GenerationStatus } from "../domain/generation";
import type { MediaProvider } from "../domain/media-provider";

/**
 * Job inspection (§5.6). This only reads remote state: a V1 status response
 * carries no local output destination, so nothing on disk is touched and no
 * manifest is mutated.
 */

export interface StatusReport {
  requestId: string;
  status: GenerationStatus;
}

export class StatusService {
  private readonly provider: MediaProvider;

  constructor(options: { provider: MediaProvider }) {
    this.provider = options.provider;
  }

  async inspect(requestId: string): Promise<StatusReport> {
    if (requestId.trim().length === 0) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "A request id is required.",
      });
    }
    return { requestId, status: await this.provider.getStatus(requestId) };
  }
}
