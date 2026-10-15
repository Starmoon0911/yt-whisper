// This module is imported at runtime by background.ts only.
import type { ApiError, Health, JobCreated, JobRequest, JobSnapshot } from "./contracts";
import { validDocument } from "./subtitles";

export interface TokenStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export class ApiFailure extends Error implements ApiError {
  constructor(public code: string, message: string, public retryable: boolean) { super(message); }
  toJSON(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export const errorDetails = (error: unknown): ApiError => error instanceof ApiFailure
  ? error.toJSON() : { code: "EXTENSION_ERROR", message: "擴充套件無法完成操作，請重新整理影片後再試。", retryable: true };

function validSuccess(path: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (path === "/health") return data.status === "ok" && typeof data.pairingRequired === "boolean" && typeof data.ffmpegAvailable === "boolean" && typeof data.model === "string";
  if (path === "/pair") return typeof data.token === "string" && data.token.length > 0;
  if (path === "/jobs") return typeof data.jobId === "string" && data.jobId.length > 0 && typeof data.cacheHit === "boolean";
  const statuses = ["queued", "downloading", "converting", "transcribing", "completed", "failed", "canceled"];
  return typeof data.jobId === "string" && typeof data.videoId === "string" && statuses.includes(data.status as string) && statuses.includes(data.stage as string)
    && (data.progress === null || typeof data.progress === "number" && Number.isFinite(data.progress))
    && (data.error === null || !!data.error && typeof data.error === "object" && typeof (data.error as ApiError).code === "string" && typeof (data.error as ApiError).message === "string" && typeof (data.error as ApiError).retryable === "boolean")
    && (data.result === null ? data.status !== "completed" : validDocument(data.result, data.videoId as string));
}

export class LocalApiClient {
  constructor(private storage: TokenStorage, private fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  async isPaired(): Promise<boolean> { return typeof (await this.storage.get("token")).token === "string"; }
  // POST ensures browser-generated Origin even for host-permitted extension reads.
  health(): Promise<Health> { return this.request("/health", "POST", false); }
  async pair(code: string): Promise<void> {
    if (!/^[0-9]{6}$/.test(code)) throw new ApiFailure("PAIRING_FAILED", "請輸入六位數配對碼。", false);
    const data = await this.request<{ token: string }>("/pair", "POST", false, { code });
    if (typeof data.token !== "string" || !data.token) throw new ApiFailure("INVALID_RESPONSE", "本機服務傳回無效的配對資訊。", true);
    await this.storage.set({ token: data.token });
  }
  createJob(request: JobRequest): Promise<JobCreated> { return this.request("/jobs", "POST", true, request); }
  getJob(jobId: string): Promise<JobSnapshot> { return this.request(`/jobs/${encodeURIComponent(jobId)}`, "POST", true); }
  cancelJob(jobId: string): Promise<JobSnapshot> { return this.request(`/jobs/${encodeURIComponent(jobId)}`, "DELETE", true); }

  private async request<T>(path: string, method: string, protectedRoute: boolean, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (protectedRoute) {
      const { token } = await this.storage.get("token");
      if (typeof token !== "string" || !token) throw new ApiFailure("UNPAIRED", "請先使用本機服務顯示的六位數代碼配對。", false);
      headers.Authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, `http://127.0.0.1:8765/v1${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ApiFailure("SERVICE_OFFLINE", "無法連線到本機服務，請確認服務已啟動。", true);
    }
    if (response.status === 401) await this.storage.remove("token");
    let data: unknown;
    try { data = await response.json(); } catch { throw new ApiFailure("INVALID_RESPONSE", "本機服務傳回無效的回應。", true); }
    if (!response.ok) {
      const error = data as Partial<ApiError> | null;
      if (error && typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean") {
        throw new ApiFailure(error.code, error.message, error.retryable);
      }
      throw new ApiFailure("INVALID_RESPONSE", "本機服務傳回無效的錯誤資訊。", true);
    }
    if (!validSuccess(path, data)) throw new ApiFailure("INVALID_RESPONSE", "本機服務傳回不符合版本契約的資訊。", true);
    return data as T;
  }
}
