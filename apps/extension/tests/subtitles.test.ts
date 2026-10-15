import { describe, expect, test } from "vitest";

import { cueAtTime, extractVideoId, type SubtitleCue } from "../src/subtitles";

describe("extractVideoId", () => {
  test("extracts IDs from supported YouTube watch and short-link URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=20")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=20")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBeNull();
  });

  test("rejects malformed IDs, ambiguous queries and untrusted URL authorities", () => {
    // Catches parsing that accepts hostile hosts, URL credentials or invalid IDs.
    for (const url of [
      "not a URL", "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=anotherId00",
      "https://www.youtube.com/watch?v=short", "https://youtu.be/aaaaaaaaaa!",
      "https://youtu.be/dQw4w9WgXcQ/extra", "https://www.youtube.com/watch",
    ]) expect(extractVideoId(url)).toBeNull();
  });
});

describe("cueAtTime", () => {
  const cues: SubtitleCue[] = [
    { startMs: 0, endMs: 900, text: "First" },
    { startMs: 1200, endMs: 2200, text: "Second" },
    { startMs: 3000, endMs: 4000, text: "Third" },
  ];

  test("finds boundary cues with binary-search semantics", () => {
    expect(cueAtTime(cues, 0)?.text).toBe("First");
    expect(cueAtTime(cues, 2199)?.text).toBe("Second");
    expect(cueAtTime(cues, 2200)).toBeNull();
    expect(cueAtTime(cues, 3500)?.text).toBe("Third");
  });

  test("returns no cue in gaps, outside the timeline or at exclusive ends", () => {
    // Catches a search that carries the previous cue into a gap or includes its end.
    for (const time of [-1, 900, 1100, 2200, 4000, 5000, NaN, Infinity]) {
      expect(cueAtTime(cues, time)).toBeNull();
    }
    expect(cueAtTime([], 0)).toBeNull();
    expect(cueAtTime(cues, 1200)?.text).toBe("Second");
    expect(cueAtTime([
      { startMs: 0, endMs: 1000, text: "Before" },
      { startMs: 1000, endMs: 2000, text: "After" },
    ], 1000)?.text).toBe("After");
  });
});
