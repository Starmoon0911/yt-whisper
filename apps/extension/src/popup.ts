import { isActiveJob, type ApiError, type BackgroundRequest, type BackgroundResponse, type JobStatus, type PopupState } from "./contracts";

const stages: Record<JobStatus, string> = { queued: "等待處理", downloading: "下載音訊中", converting: "轉換音訊中", transcribing: "Whisper 辨識中", completed: "字幕已載入", failed: "處理失敗", canceled: "已取消處理" };
type Messenger = (message: BackgroundRequest) => Promise<BackgroundResponse>;

export function mountPopup(root: Document, send: Messenger, refreshMs = 1000): () => void {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  let state: PopupState | null = null;
  let busy = false;
  let actionError: ApiError | null = null;
  let disposed = false;
  const events = new AbortController();
  function render() {
    const online = state?.health !== null && state?.health !== undefined;
    const active = isActiveJob(state?.job ?? null);
    const usable = !!state?.page && state.page.durationMs > 0 && Number.isSafeInteger(state.page.durationMs);
    get("service-status").textContent = !state ? "正在連線到本機服務…" : !online ? "本機服務離線" : state.paired ? "本機服務已連線 · 已配對" : "本機服務已連線 · 尚未配對";
    get("pair-form").hidden = !online || state?.paired === true;
    get<HTMLInputElement>("pair-code").disabled = busy;
    get<HTMLButtonElement>("pair").disabled = busy;
    get("video-title").textContent = state?.page?.title || "請開啟一般公開的 YouTube 影片";
    get("video-detail").textContent = state?.page ? `${Math.round(state.page.durationMs / 1000)} 秒 · ${state.page.videoId}` : "載入擴充套件後，請重新整理影片頁面。";
    get("job-status").textContent = state?.job ? state.cacheHit && state.job.status === "completed" ? "已從本機快取載入字幕" : stages[state.job.status] : "";
    const progress = get<HTMLProgressElement>("progress");
    progress.hidden = !active;
    if (typeof state?.job?.progress === "number") progress.value = Math.min(1, Math.max(0, state.job.progress));
    else progress.removeAttribute("value");
    const canStart = online && state?.paired && state.health?.ffmpegAvailable && usable && !active && !busy;
    get<HTMLButtonElement>("start").disabled = !canStart;
    get<HTMLButtonElement>("regenerate").disabled = !canStart;
    get<HTMLButtonElement>("cancel").hidden = !active;
    get<HTMLButtonElement>("cancel").disabled = busy;
    get<HTMLButtonElement>("refresh").disabled = busy;
    get<HTMLInputElement>("subtitles").disabled = busy || !state?.page?.hasSubtitles;
    get<HTMLInputElement>("subtitles").checked = state?.page?.subtitlesEnabled ?? true;
    const error = actionError ?? state?.error;
    get("error").hidden = !error && !(online && !state?.health?.ffmpegAvailable);
    get("error").textContent = error ? `${error.message}${error.retryable ? "（可重試）" : ""}` : online && !state?.health?.ffmpegAvailable ? "找不到 ffmpeg，請安裝後重新啟動本機服務。" : "";
  }
  async function run(message: BackgroundRequest) {
    if (busy || disposed) return;
    busy = true; render();
    try {
      const response = await send(message);
      if (disposed) return;
      if (response.ok) {
        state = response.state;
        if (message.type !== "GET_PAGE_STATE") actionError = null;
        if (message.type === "PAIR") get<HTMLInputElement>("pair-code").value = "";
      } else actionError = response.error;
    } catch {
      actionError = { code: "EXTENSION_ERROR", message: "無法取得擴充套件狀態，請重新開啟此視窗。", retryable: true };
    } finally { busy = false; if (!disposed) render(); }
  }
  function action(type: "START_JOB" | "CANCEL_JOB", force = false) {
    if (state?.tabId === null || state?.tabId === undefined) return;
    void run(type === "START_JOB" ? { type, tabId: state.tabId, force } : { type, tabId: state.tabId });
  }
  const options = { signal: events.signal };
  get("refresh").addEventListener("click", () => void run({ type: "GET_PAGE_STATE", ...(state?.tabId == null ? {} : { tabId: state.tabId }) }), options);
  get("pair-form").addEventListener("submit", event => { event.preventDefault(); void run({ type: "PAIR", code: get<HTMLInputElement>("pair-code").value.trim() }); }, options);
  get("start").addEventListener("click", () => action("START_JOB"), options);
  get("regenerate").addEventListener("click", () => action("START_JOB", true), options);
  get("cancel").addEventListener("click", () => action("CANCEL_JOB"), options);
  get("subtitles").addEventListener("change", () => { if (state?.tabId != null) void run({ type: "SET_SUBTITLES", tabId: state.tabId, enabled: get<HTMLInputElement>("subtitles").checked }); }, options);
  void run({ type: "GET_PAGE_STATE" });
  const timer = refreshMs > 0 ? setInterval(() => void run({ type: "GET_PAGE_STATE", ...(state?.tabId == null ? {} : { tabId: state.tabId }) }), refreshMs) : undefined;
  return () => { disposed = true; events.abort(); if (timer !== undefined) clearInterval(timer); };
}
if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof document !== "undefined") {
  const dispose = mountPopup(document, message => chrome.runtime.sendMessage(message));
  window.addEventListener("pagehide", dispose, { once: true });
}
