export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleDocument {
  schemaVersion: 1;
  videoId: string;
  language: string;
  durationMs: number;
  model: string;
  generatedAt: string;
  cues: SubtitleCue[];
}

export function extractVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    return null;
  }
  let videoId: string | null = null;
  if (parsed.hostname === "youtu.be") {
    videoId = parsed.pathname.slice(1);
  } else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname) &&
    parsed.pathname === "/watch"
  ) {
    const ids = parsed.searchParams.getAll("v");
    videoId = ids.length === 1 ? ids[0] : null;
  }
  return videoId !== null && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
}

// Cues are ordered and non-overlapping, as validated by the document cache.
export function cueAtTime(cues: SubtitleCue[], timeMs: number): SubtitleCue | null {
  if (!Number.isFinite(timeMs)) return null;
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (timeMs < cue.startMs) high = middle - 1;
    else if (timeMs >= cue.endMs) low = middle + 1;
    else return cue;
  }
  return null;
}
