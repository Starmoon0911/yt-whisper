// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
import { beforeEach, describe, expect, it } from "vitest";
import { PlayerController } from "../src/player";
import { mediaFixture, otherVideoId, resetPage, videoId } from "./media";

beforeEach(resetPage);

describe("YouTube player state", () => {
  it("detects only an eligible watch video inside the YouTube player", () => {
    const player = new PlayerController(document);
    expect(player.snapshot()).toBeNull();
    const { video, container } = mediaFixture();
    expect(player.video).toBe(video);
    expect(player.container).toBe(container);
    expect(player.snapshot()).toEqual({ url: `https://www.youtube.com/watch?v=${videoId}`, videoId, title: "Example video", durationMs: 10000, currentTime: 4.25, paused: false, playbackRate: 1.5 });
    history.replaceState(null, "", "/shorts/dQw4w9WgXcQ");
    expect(player.snapshot()).toBeNull();
  });

  it("rejects unknown or live durations and videos outside the player", () => {
    const player = new PlayerController(document);
    const { video } = mediaFixture(false, Infinity);
    expect(player.snapshot()).toBeNull();
    Object.defineProperty(video, "duration", { value: NaN });
    expect(player.snapshot()).toBeNull();
    document.body.replaceChildren(video);
    expect(player.snapshot()).toBeNull();
  });

  it("saves playing state once and restores playback without moving the playhead", async () => {
    const { video } = mediaFixture();
    const player = new PlayerController(document);
    expect(player.pauseForProcessing()?.paused).toBe(false);
    expect(video.paused).toBe(true);
    player.pauseForProcessing();
    await player.restoreAfterProcessing();
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(4.25);
    expect(video.playbackRate).toBe(1.5);
  });

  it("keeps an originally paused video paused after processing fails", async () => {
    const { video } = mediaFixture(true);
    const player = new PlayerController(document);
    player.pauseForProcessing();
    await player.restoreAfterProcessing();
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(4.25);
  });

  it("plays completed subtitles from zero while keeping the playback rate", async () => {
    const { video } = mediaFixture(true);
    const player = new PlayerController(document);
    player.pauseForProcessing();
    await player.playFromStart();
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    expect(video.playbackRate).toBe(1.5);
  });

  it("does not restore old state onto a new video or replacement media element", async () => {
    const { video, container } = mediaFixture();
    const player = new PlayerController(document);
    player.pauseForProcessing();
    history.replaceState(null, "", `/watch?v=${otherVideoId}`);
    await player.restoreAfterProcessing();
    expect(video.paused).toBe(true);
    history.replaceState(null, "", `/watch?v=${videoId}`);
    container.remove();
    const replacement = mediaFixture(true).video;
    await player.restoreAfterProcessing();
    expect(replacement.paused).toBe(true);
    expect(replacement.currentTime).toBe(4.25);
  });
});
