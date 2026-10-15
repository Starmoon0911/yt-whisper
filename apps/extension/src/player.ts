import { extractVideoId } from "./subtitles";

export interface PlayerSnapshot {
  url: string;
  videoId: string;
  title: string;
  durationMs: number;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
}

export class PlayerController {
  private saved: { video: HTMLVideoElement; state: PlayerSnapshot } | null = null;
  constructor(private document: Document) {}

  get video(): HTMLVideoElement | null {
    return this.document.querySelector<HTMLVideoElement>(".html5-video-player video");
  }
  get container(): HTMLElement | null {
    return this.video?.closest<HTMLElement>(".html5-video-player") ?? null;
  }

  snapshot(): PlayerSnapshot | null {
    const url = this.document.location.href;
    const videoId = extractVideoId(url);
    const video = this.video;
    if (!videoId || !video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return null;
    return {
      url, videoId, durationMs,
      title: this.document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string")?.textContent?.trim()
        || this.document.title.replace(/\s*-\s*YouTube$/, "").trim(),
      currentTime: video.currentTime, paused: video.paused, playbackRate: video.playbackRate,
    };
  }

  pauseForProcessing(): PlayerSnapshot | null {
    const state = this.snapshot();
    const video = this.video;
    if (!state || !video) return null;
    if (this.saved?.video !== video || this.saved.state.videoId !== state.videoId) this.saved = { video, state };
    video.pause();
    return this.saved.state;
  }

  async restoreAfterProcessing(): Promise<void> {
    const saved = this.saved;
    if (saved && saved.video === this.video && saved.state.videoId === extractVideoId(this.document.location.href) && !this.snapshot()) return;
    this.saved = null;
    if (saved && saved.video === this.video && saved.state.videoId === this.snapshot()?.videoId && !saved.state.paused) {
      await saved.video.play();
    }
  }

  async playFromStart(): Promise<void> {
    const video = this.video;
    if (!video || !this.snapshot()) return;
    this.saved = null;
    video.currentTime = 0;
    await video.play();
  }

  forgetProcessing(): void { this.saved = null; }
}
