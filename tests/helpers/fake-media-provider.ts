import type {
  CharacterReference,
  CharacterReferencePage,
  CharacterReferenceRequest,
  MotionPreset,
  StylePreset,
  UploadRequest,
  UploadedAsset,
} from "../../src/domain/asset";
import type {
  GenerationResult,
  GenerationStatus,
  ProviderGenerationRequest,
} from "../../src/domain/generation";
import type { MediaProvider } from "../../src/domain/media-provider";

/** Minimal in-process MediaProvider double for application-level tests. */

export interface FakeProviderScript {
  generate?: (request: ProviderGenerationRequest, callIndex: number) => Promise<GenerationResult>;
  upload?: (request: UploadRequest) => Promise<UploadedAsset>;
  getStatus?: (requestId: string) => Promise<GenerationStatus>;
  listMotions?: () => Promise<MotionPreset[]>;
  listStyles?: () => Promise<StylePreset[]>;
  createCharacter?: (request: CharacterReferenceRequest) => Promise<CharacterReference>;
  listCharacters?: (page?: number, pageSize?: number) => Promise<CharacterReferencePage>;
}

export interface FakeProvider {
  provider: MediaProvider;
  calls: {
    generate: ProviderGenerationRequest[];
    upload: UploadRequest[];
    getStatus: string[];
    listMotions: number;
    listStyles: number;
    createCharacter: CharacterReferenceRequest[];
    listCharacters: { page?: number; pageSize?: number }[];
  };
}

const notConfigured = (method: string) => (): never => {
  throw new Error(`fake provider ${method} not configured`);
};

export function createFakeProvider(script: FakeProviderScript = {}): FakeProvider {
  const calls: FakeProvider["calls"] = {
    generate: [],
    upload: [],
    getStatus: [],
    listMotions: 0,
    listStyles: 0,
    createCharacter: [],
    listCharacters: [],
  };

  const provider: MediaProvider = {
    name: "higgsfield-v1",
    async generate(request) {
      const index = calls.generate.push(request) - 1;
      if (script.generate === undefined) throw new Error("fake generate not configured");
      return script.generate(request, index);
    },
    async upload(request) {
      calls.upload.push(request);
      if (script.upload === undefined) throw new Error("fake upload not configured");
      return script.upload(request);
    },
    async getStatus(requestId) {
      calls.getStatus.push(requestId);
      if (script.getStatus === undefined) throw new Error("fake getStatus not configured");
      return script.getStatus(requestId);
    },
    async listMotions() {
      calls.listMotions += 1;
      return (script.listMotions ?? notConfigured("listMotions"))();
    },
    async listStyles() {
      calls.listStyles += 1;
      return (script.listStyles ?? notConfigured("listStyles"))();
    },
    async createCharacter(request) {
      calls.createCharacter.push(request);
      if (script.createCharacter === undefined)
        throw new Error("fake createCharacter not configured");
      return script.createCharacter(request);
    },
    async listCharacters(page, pageSize) {
      calls.listCharacters.push({ page, pageSize });
      if (script.listCharacters === undefined)
        throw new Error("fake listCharacters not configured");
      return script.listCharacters(page, pageSize);
    },
  };

  return { provider, calls };
}
