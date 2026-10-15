export const videoId = "dQw4w9WgXcQ";
export const otherVideoId = "abcdefghijk";

// jsdom has no media decoder. This double preserves the media state/event
// behavior consumed by the real player, overlay and content controllers.
export function mediaFixture(paused = false, duration = 10) {
  const container = document.createElement("div");
  container.className = "html5-video-player";
  const video = document.createElement("video");
  container.append(video);
  let isPaused = paused;
  Object.defineProperties(video, {
    duration: { configurable: true, get: () => duration },
    paused: { configurable: true, get: () => isPaused },
    pause: { value() { isPaused = true; video.dispatchEvent(new Event("pause")); } },
    play: { configurable: true, value() { isPaused = false; video.dispatchEvent(new Event("play")); return Promise.resolve(); } },
  });
  video.currentTime = 4.25;
  video.playbackRate = 1.5;
  document.body.append(container);
  return { container, video };
}

export function resetPage() {
  document.body.replaceChildren();
  document.title = "Example video - YouTube";
  history.replaceState(null, "", `/watch?v=${videoId}`);
}
