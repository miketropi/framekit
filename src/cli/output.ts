import type { GeneratedAsset, ManifestInput } from "../domain/asset";
import { type SerializedToolError, type ToolError } from "../domain/errors";
import { redactString } from "../domain/redact";

/**
 * Output contract (§6): `--json` writes exactly one compact JSON document plus a
 * newline to stdout. All progress and diagnostics go to stderr, so stdout stays
 * parseable by agents.
 */

export interface WritableLike {
  write(chunk: string): unknown;
}

export interface SuccessEnvelope {
  ok: true;
  operation: string;
  provider: string;
  status: string;
  requestId?: string;
  fingerprint?: string;
  logicalModel?: string;
  outputDirectory?: string;
  manifest?: string;
  assets?: GeneratedAsset[];
  inputs?: ManifestInput[];
  resolvedRequest?: Record<string, unknown>;
  reused?: boolean;
  dryRun?: boolean;
  details?: unknown;
}

export interface FailureEnvelope {
  ok: false;
  error: SerializedToolError;
}

export interface CommandResult {
  envelope: SuccessEnvelope;
  /** Human-mode lines. Falls back to a generic renderer when omitted. */
  human?: string[];
}

export interface CliOutputOptions {
  stdout: WritableLike;
  stderr: WritableLike;
  json: boolean;
  debug: boolean;
}

function assetLine(asset: GeneratedAsset): string {
  const size = `${asset.bytes} bytes`;
  return `  ${asset.path} (${asset.type}, ${asset.mimeType}, ${size})`;
}

export function renderEnvelopeHuman(envelope: SuccessEnvelope): string[] {
  const lines: string[] = [`${envelope.operation}: ${envelope.status}`];
  if (envelope.requestId !== undefined) lines.push(`  requestId: ${envelope.requestId}`);
  if (envelope.logicalModel !== undefined) lines.push(`  model: ${envelope.logicalModel}`);
  if (envelope.fingerprint !== undefined) lines.push(`  fingerprint: ${envelope.fingerprint}`);
  if (envelope.reused === true) lines.push("  reused: true (existing completed manifest)");
  if (envelope.dryRun === true) lines.push("  dry-run: no upload, generation, or write performed");
  if (envelope.outputDirectory !== undefined) lines.push(`  output: ${envelope.outputDirectory}`);
  if (envelope.manifest !== undefined) lines.push(`  manifest: ${envelope.manifest}`);
  if (envelope.inputs !== undefined && envelope.inputs.length > 0) {
    lines.push("  inputs:");
    for (const input of envelope.inputs) {
      const source = input.localPath ?? input.url ?? "(unknown)";
      lines.push(
        `    ${input.kind}: ${source}${input.sha256 === undefined ? "" : ` sha256:${input.sha256.slice(0, 12)}`}`,
      );
    }
  }
  if (envelope.assets !== undefined && envelope.assets.length > 0) {
    lines.push("  assets:");
    for (const asset of envelope.assets) lines.push(assetLine(asset));
  }
  if (envelope.details !== undefined) {
    lines.push(`  details: ${JSON.stringify(envelope.details)}`);
  }
  return lines;
}

export class CliOutput {
  private readonly stdout: WritableLike;
  private readonly stderr: WritableLike;
  readonly json: boolean;
  private readonly debug: boolean;

  constructor(options: CliOutputOptions) {
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.json = options.json;
    this.debug = options.debug;
  }

  result(result: CommandResult): void {
    if (this.json) {
      this.stdout.write(`${JSON.stringify(result.envelope)}\n`);
      return;
    }
    const lines = result.human ?? renderEnvelopeHuman(result.envelope);
    this.stdout.write(`${lines.join("\n")}\n`);
  }

  failure(error: ToolError, exitCode: number): void {
    const serialized = error.toJSON();
    if (this.json) {
      const envelope: FailureEnvelope = { ok: false, error: serialized };
      this.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      const details =
        this.debug && serialized.details !== undefined
          ? `\n  details: ${JSON.stringify(serialized.details, null, 2)}`
          : "";
      this.stderr.write(`[error] ${serialized.code}: ${serialized.message}${details}\n`);
      if (this.debug && error.stack !== undefined) {
        this.stderr.write(`${redactString(error.stack)}\n`);
      }
    }
    this.stderr.write(`[error] exit ${exitCode}\n`);
  }

  progress(message: string): void {
    this.stderr.write(`[info] ${message}\n`);
  }

  warn(message: string): void {
    this.stderr.write(`[warn] ${message}\n`);
  }
}
