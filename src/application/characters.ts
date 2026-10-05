import type { CharacterReference, CharacterReferencePage } from "../domain/asset";
import { ToolError } from "../domain/errors";
import type { ResolvedInputRef } from "../domain/generation";
import type { MediaProvider } from "../domain/media-provider";
import { parseInputReference, type InputInspector } from "../storage/input-inspection";
import { stripQueryString } from "../storage/paths";
import type { LocalUploader } from "./upload-media";

/**
 * Character reference workflow (§5.4). Local reference images are uploaded
 * first; URL references pass through. Bytes never appear in manifests or logs.
 */

export interface CharacterServiceOptions {
  provider: MediaProvider;
  inspector: InputInspector;
  uploadLocal: LocalUploader;
}

export class CharacterService {
  private readonly provider: MediaProvider;
  private readonly inspector: InputInspector;
  private readonly uploadLocal: LocalUploader;

  constructor(options: CharacterServiceOptions) {
    this.provider = options.provider;
    this.inspector = options.inspector;
    this.uploadLocal = options.uploadLocal;
  }

  async create(name: string, references: string[]): Promise<CharacterReference> {
    if (name.trim().length === 0) {
      throw new ToolError({ code: "VALIDATION_FAILED", message: "A character name is required." });
    }
    if (references.length === 0) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "At least one --reference image is required.",
      });
    }

    const images: ResolvedInputRef[] = [];
    for (const reference of references) {
      const parsed = parseInputReference(reference);
      if (parsed.type === "url") {
        images.push({ kind: "image", url: stripQueryString(parsed.url) });
        continue;
      }
      const inspected = await this.inspector.inspectImage(reference);
      const uploaded = await this.uploadLocal(inspected);
      images.push({ kind: "image", url: uploaded.url, sha256: inspected.sha256 });
    }

    return this.provider.createCharacter({ name, images });
  }

  async list(page?: number, pageSize?: number): Promise<CharacterReferencePage> {
    return page === undefined && pageSize === undefined
      ? this.provider.listCharacters()
      : this.provider.listCharacters(page, pageSize);
  }
}
