import type { SubtitleDocument } from "./subtitles";

export interface ApiError { code: string; message: string; retryable: boolean }
export interface Health { status: "ok"; pairingRequired: boolean; ffmpegAvailable: boolean; model: string }
export type JobStatus = "queued" | "downloading" | "converting" | "transcribing" | "completed" | "failed" | "canceled";
export interface JobRequest { url: string; videoId: string; durationMs: number; force?: boolean }
export interface JobCreated { jobId: string; cacheHit: boolean }
export interface JobSnapshot {
  jobId: string; videoId: string; status: JobStatus; stage: JobStatus;
  progress: number | null; error: ApiError | null; result: SubtitleDocument | null;
}
export interface PageState {
  url: string; videoId: string; title: string; durationMs: number;
  subtitlesEnabled: boolean; hasSubtitles: boolean;
}
export interface PopupState {
  tabId: number | null; page: PageState | null; health: Health | null;
  paired: boolean; job: JobSnapshot | null; cacheHit: boolean; error: ApiError | null;
}
// Popup -> service worker only. tabId pins actions to the page shown in the popup.
export type BackgroundRequest =
  | { type: "GET_PAGE_STATE"; tabId?: number }
  | { type: "PAIR"; code: string }
  | { type: "START_JOB"; tabId: number; force?: boolean }
  | { type: "CANCEL_JOB"; tabId: number }
  | { type: "SET_SUBTITLES"; tabId: number; enabled: boolean };
export type BackgroundResponse = { ok: true; state: PopupState } | { ok: false; error: ApiError };
// Service worker -> content via tabs.sendMessage only; never runtime.sendMessage.
// START_JOB acknowledges only after pausing the matching video. Reject a stale videoId.
// SET_PROGRESS terminals restore/clear processing UI; completed SET_SUBTITLES loads and plays from 0.
// Same-video progress/results may be acknowledged before metadata is ready;
// content retains them and applies playback on recovery. A null page is not navigation.
export type ContentRequest =
  | { type: "GET_PAGE_STATE" }
  | { type: "START_JOB"; videoId: string }
  | { type: "SET_PROGRESS"; videoId: string; snapshot: JobSnapshot }
  | { type: "SET_SUBTITLES"; videoId: string; enabled: boolean; document?: SubtitleDocument };
export type ContentResponse = { ok: true; page: PageState | null } | { ok: false; error: ApiError };
// Content -> worker: SPA navigation stops delivery/polling for the previous video.
export interface PageChanged { type: "PAGE_CHANGED"; videoId: string | null }
export const isActiveJob = (job: JobSnapshot | null): boolean =>
  job !== null && !["completed", "failed", "canceled"].includes(job.status);
