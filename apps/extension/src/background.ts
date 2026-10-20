import { ApiFailure, errorDetails, LocalApiClient } from "./api";
import { isActiveJob, type ApiError, type BackgroundRequest, type BackgroundResponse, type ContentRequest, type ContentResponse, type Health, type JobSnapshot, type PageState, type PopupState } from "./contracts";
import { extractVideoId } from "./subtitles";

interface JobRef { tabId: number; videoId: string; jobId: string; cacheHit: boolean }
interface TrackedJob extends JobRef { snapshot: JobSnapshot | null; stop?: () => void; version: number; error?: ApiError; pendingDelivery?: boolean }
interface BackgroundHost {
  activeTab(): Promise<number | null>;
  sendToTab(tabId: number, message: ContentRequest): Promise<ContentResponse>;
  loadJobs(): Promise<unknown[]>;
  saveJobs(jobs: JobRef[]): Promise<void>;
  schedule(callback: () => Promise<void>): () => void;
}
type Api = Pick<LocalApiClient, "health" | "isPaired" | "pair" | "createJob" | "getJob" | "cancelJob">;

export class BackgroundController {
  private jobs = new Map<number, TrackedJob>();
  private starting = new Set<number>();
  private ready: Promise<void>;
  constructor(private api: Api, private host: BackgroundHost) { this.ready = this.restore(); }

  async handle(message: BackgroundRequest): Promise<BackgroundResponse> {
    try {
      await this.ready;
      if (message.type === "PAIR") { await this.api.pair(message.code); return { ok: true, state: await this.state() }; }
      const tabId = message.tabId ?? await this.host.activeTab();
      if (message.type === "START_JOB") await this.start(message.tabId, !!message.force);
      if (message.type === "CANCEL_JOB") {
        const job = this.jobs.get(message.tabId);
        if (job && isActiveJob(job.snapshot)) {
          job.stop?.();
          job.version++;
          try {
            const snapshot = await this.api.cancelJob(job.jobId);
            if (this.jobs.get(job.tabId) === job) await this.deliver(job, snapshot);
          } catch (error) {
            if (this.jobs.get(job.tabId) === job) this.schedule(job);
            throw error;
          }
        }
      }
      if (message.type === "SET_SUBTITLES") {
        const page = await this.page(message.tabId);
        if (!page) throw new ApiFailure("NO_VIDEO", "請開啟一般公開的 YouTube 影片。", false);
        await this.send(message.tabId, { type: "SET_SUBTITLES", videoId: page.videoId, enabled: message.enabled });
      }
      return { ok: true, state: await this.state(tabId) };
    } catch (error) { return { ok: false, error: errorDetails(error) }; }
  }

  async pageChanged(tabId: number, videoId: string | null): Promise<void> {
    const job = this.jobs.get(tabId);
    if (job && job.videoId !== videoId) { job.stop?.(); this.jobs.delete(tabId); await this.persist(); }
  }

  private async page(tabId: number | null): Promise<PageState | null> {
    if (tabId === null) return null;
    try {
      const response = await this.host.sendToTab(tabId, { type: "GET_PAGE_STATE" });
      return response?.ok ? response.page : null;
    } catch { return null; }
  }
  private async send(tabId: number, message: ContentRequest): Promise<void> {
    const response = await this.host.sendToTab(tabId, message);
    if (!response?.ok) throw new ApiFailure(response?.error.code ?? "PAGE_UNAVAILABLE", response?.error.message ?? "影片頁面無法回應，請重新整理後再試。", true);
  }
  private async state(tabId?: number | null): Promise<PopupState> {
    const selectedTab = tabId === undefined ? await this.host.activeTab() : tabId;
    const page = await this.page(selectedTab);
    // Null means metadata or the content script is unavailable, not navigation.
    // PAGE_CHANGED and tab removal carry confirmed identity changes separately.
    if (selectedTab !== null && page) await this.pageChanged(selectedTab, page.videoId);
    let health: Health | null = null;
    let error = null;
    try { health = await this.api.health(); } catch (failure) { error = errorDetails(failure); }
    const job = selectedTab === null ? undefined : this.jobs.get(selectedTab);
    return {
      tabId: selectedTab, page, health, paired: await this.api.isPaired() && health?.pairingRequired !== true,
      job: job?.snapshot ?? null, cacheHit: job?.cacheHit ?? false, error: error ?? job?.error ?? job?.snapshot?.error ?? null,
    };
  }
  private async start(tabId: number, force: boolean): Promise<void> {
    if (this.starting.has(tabId)) throw new ApiFailure("JOB_BUSY", "字幕工作正在啟動。", true);
    this.starting.add(tabId);
    let pausedPage: PageState | null = null;
    try {
      const page = await this.page(tabId);
      if (!page || extractVideoId(page.url) !== page.videoId || !Number.isSafeInteger(page.durationMs) || page.durationMs <= 0) {
        throw new ApiFailure("NO_VIDEO", "請開啟已載入的一般公開 YouTube 影片；不支援直播。", false);
      }
      await this.pageChanged(tabId, page.videoId);
      if (isActiveJob(this.jobs.get(tabId)?.snapshot ?? null)) return;
      if (!await this.api.isPaired()) throw new ApiFailure("UNPAIRED", "請先配對本機服務。", false);
      await this.send(tabId, { type: "START_JOB", videoId: page.videoId });
      pausedPage = page;
      const created = await this.api.createJob({ url: page.url, videoId: page.videoId, durationMs: page.durationMs, force });
      const job: TrackedJob = { tabId, videoId: page.videoId, ...created, snapshot: null, version: 0 };
      this.jobs.set(tabId, job);
      await this.persist();
      await this.poll(job);
    } catch (error) {
      if (pausedPage) {
        const failed: JobSnapshot = { jobId: "", videoId: pausedPage.videoId, status: "failed", stage: "failed", progress: null, speed: null, error: errorDetails(error), result: null };
        await this.send(tabId, { type: "SET_PROGRESS", videoId: pausedPage.videoId, snapshot: failed }).catch(() => {});
      }
      throw error;
    } finally { this.starting.delete(tabId); }
  }
  private async poll(job: TrackedJob): Promise<void> {
    if (this.jobs.get(job.tabId) !== job) return;
    const version = job.version;
    try {
      const snapshot = job.pendingDelivery && job.snapshot && !isActiveJob(job.snapshot)
        ? job.snapshot : await this.api.getJob(job.jobId);
      if (this.jobs.get(job.tabId) !== job || job.version !== version) return;
      job.error = undefined;
      await this.deliver(job, snapshot);
    } catch (error) {
      if (this.jobs.get(job.tabId) !== job || job.version !== version) return;
      if (error instanceof ApiFailure && error.code === "INVALID_RESPONSE") {
        job.error = errorDetails(error);
        job.snapshot ??= { jobId: job.jobId, videoId: job.videoId, status: "queued", stage: "queued", progress: null, speed: null, error: null, result: null };
        this.schedule(job);
        return;
      }
      await this.deliver(job, { jobId: job.jobId, videoId: job.videoId, status: "failed", stage: "failed", progress: null, speed: null, error: errorDetails(error), result: null });
    }
  }
  private async deliver(job: TrackedJob, snapshot: JobSnapshot): Promise<void> {
    if (snapshot.videoId !== job.videoId || snapshot.jobId !== job.jobId) throw new ApiFailure("INVALID_RESPONSE", "本機服務回傳不相符的工作。", false);
    const version = job.version;
    const current = () => this.jobs.get(job.tabId) === job && job.version === version;
    job.snapshot = snapshot;
    job.pendingDelivery = true;
    try {
      await this.send(job.tabId, { type: "SET_PROGRESS", videoId: job.videoId, snapshot });
      if (!current()) return;
      if (snapshot.status === "completed" && snapshot.result) {
        await this.send(job.tabId, { type: "SET_SUBTITLES", videoId: job.videoId, enabled: true, document: snapshot.result });
      }
      if (!current()) return;
      job.pendingDelivery = false;
      job.error = undefined;
    } catch (error) {
      if (!current()) return;
      job.error = errorDetails(error);
      if (job.error.code === "VIDEO_CHANGED") {
        await this.pageChanged(job.tabId, null);
        return;
      }
      // Content has accepted the document in this case; another send would seek
      // to zero again instead of letting the user start playback manually.
      if (job.error.code === "PLAYBACK_BLOCKED") job.pendingDelivery = false;
      // Delivery failures leave the backend snapshot intact for a later retry.
    }
    job.stop?.();
    await this.persist();
    if (current() && (isActiveJob(snapshot) || job.pendingDelivery)) this.schedule(job);
  }
  private schedule(job: TrackedJob): void {
    job.stop?.();
    job.stop = this.host.schedule(() => this.poll(job));
  }
  private persist(): Promise<void> {
    return this.host.saveJobs([...this.jobs.values()].filter(job => job.snapshot === null || isActiveJob(job.snapshot) || job.pendingDelivery).map(({ tabId, videoId, jobId, cacheHit }) => ({ tabId, videoId, jobId, cacheHit })));
  }
  private async restore(): Promise<void> {
    for (const value of await this.host.loadJobs()) {
      const ref = value as Partial<JobRef> | null;
      if (!ref || !Number.isInteger(ref.tabId) || typeof ref.videoId !== "string" || typeof ref.jobId !== "string" || typeof ref.cacheHit !== "boolean") continue;
      const job = { ...ref, snapshot: null, version: 0 } as TrackedJob;
      const page = await this.page(job.tabId);
      if (page && page.videoId !== job.videoId) continue;
      this.jobs.set(job.tabId, job);
      await this.poll(job);
    }
    await this.persist();
  }
}

export function installBackground(browser: typeof chrome): BackgroundController {
  // Content scripts cannot read the bearer token through the storage API.
  const storageReady = browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const controller = new BackgroundController(new LocalApiClient(browser.storage.local), {
    async activeTab() { return (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null; },
    sendToTab: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    async loadJobs() { await storageReady; const { jobs } = await browser.storage.session.get("jobs"); return Array.isArray(jobs) ? jobs : []; },
    async saveJobs(jobs) { await browser.storage.session.set({ jobs }); },
    schedule(callback) { const timer = setTimeout(() => void callback(), 1000); return () => clearTimeout(timer); },
  });
  browser.runtime.onMessage.addListener((message: BackgroundRequest | { type: "PAGE_CHANGED"; videoId: string | null }, sender, respond) => {
    if (message?.type === "PAGE_CHANGED" && sender.tab?.id !== undefined) {
      void controller.pageChanged(sender.tab.id, message.videoId); return false;
    }
    if (sender.url !== browser.runtime.getURL("popup.html")) return false;
    const types = ["GET_PAGE_STATE", "PAIR", "START_JOB", "CANCEL_JOB", "SET_SUBTITLES"];
    if (!types.includes(message?.type) || message.type === "PAGE_CHANGED") return false;
    void controller.handle(message).then(respond);
    return true;
  });
  browser.tabs.onRemoved.addListener(tabId => { void controller.pageChanged(tabId, null); });
  return controller;
}
if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof document === "undefined") installBackground(chrome);
