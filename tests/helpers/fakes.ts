import type { V1HttpClient } from "../../src/providers/higgsfield-v1/client";
import type { HiggsfieldSdk } from "../../src/providers/higgsfield-v1/client";
export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeSdkScript {
  generate?: (endpoint: string, params: Record<string, unknown>) => Promise<unknown>;
  upload?: (data: Buffer | Uint8Array, contentType: string) => Promise<string>;
  uploadImage?: (data: Buffer, format: "jpeg" | "png" | "webp") => Promise<string>;
  motions?: () => Promise<unknown>;
  styles?: () => Promise<unknown>;
  createSoulId?: (data: unknown, withPolling?: boolean) => Promise<unknown>;
  listSoulIds?: (page?: number, pageSize?: number) => Promise<unknown>;
  httpGet?: (path: string, auth: "v1" | "v2") => Promise<{ status: number; body: unknown }>;
}

export interface FakeClients {
  sdk: HiggsfieldSdk;
  http: V1HttpClient;
  calls: FakeCall[];
}

export function createFakeClients(script: FakeSdkScript = {}): FakeClients {
  const calls: FakeCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  const sdk: HiggsfieldSdk = {
    async generate(endpoint, params) {
      record("generate", endpoint, params);
      if (script.generate === undefined) throw new Error("fake generate not configured");
      return (await script.generate(endpoint, params)) as never;
    },
    async upload(data, contentType) {
      record("upload", contentType, data.byteLength);
      if (script.upload === undefined) throw new Error("fake upload not configured");
      return script.upload(data, contentType);
    },
    async uploadImage(data, format) {
      record("uploadImage", format, data.byteLength);
      if (script.uploadImage === undefined) {
        if (script.upload === undefined) throw new Error("fake uploadImage not configured");
        return script.upload(data, `image/${format ?? "jpeg"}`);
      }
      return script.uploadImage(data, format ?? "jpeg");
    },
    async getMotions() {
      record("getMotions");
      if (script.motions === undefined) throw new Error("fake getMotions not configured");
      return script.motions();
    },
    async getSoulStyles() {
      record("getSoulStyles");
      if (script.styles === undefined) throw new Error("fake getSoulStyles not configured");
      return script.styles();
    },
    async createSoulId(data, withPolling) {
      record("createSoulId", data, withPolling);
      if (script.createSoulId === undefined) throw new Error("fake createSoulId not configured");
      return (await script.createSoulId(data, withPolling)) as never;
    },
    async listSoulIds(page, pageSize) {
      record("listSoulIds", page, pageSize);
      if (script.listSoulIds === undefined) throw new Error("fake listSoulIds not configured");
      return script.listSoulIds(page, pageSize);
    },
  };

  const http: V1HttpClient = {
    async get(path, options) {
      const auth = options?.auth ?? "v1";
      record("httpGet", path, auth);
      if (script.httpGet === undefined) throw new Error("fake httpGet not configured");
      return script.httpGet(path, auth);
    },
  };

  return { sdk, http, calls };
}

export function callsOf(calls: FakeCall[], method: string): FakeCall[] {
  return calls.filter((call) => call.method === method);
}
