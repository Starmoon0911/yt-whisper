import type { SubtitleDocument } from "../src/subtitles";

export const documentFixture = (): SubtitleDocument => ({
  schemaVersion: 1, videoId: "dQw4w9WgXcQ", language: "en", durationMs: 10000,
  model: "mlx-community/whisper-large-v3-turbo", generatedAt: "2026-10-15T00:00:00Z",
  cues: [{ startMs: 0, endMs: 900, text: "Hello" }],
});
export const invalidDocuments = [
  { name: "null completion", value: null },
  { name: "array", value: [] },
  { name: "arbitrary object", value: {} },
  { name: "wrong video", value: { ...documentFixture(), videoId: "abcdefghijk" } },
  { name: "wrong schema", value: { ...documentFixture(), schemaVersion: 2 } },
  { name: "wrong model", value: { ...documentFixture(), model: "other" } },
  { name: "empty language", value: { ...documentFixture(), language: " " } },
  { name: "empty generation time", value: { ...documentFixture(), generatedAt: "" } },
  { name: "zero duration", value: { ...documentFixture(), durationMs: 0, cues: [] } },
  { name: "unsafe duration", value: { ...documentFixture(), durationMs: 2 ** 53 } },
  { name: "cue beyond duration", value: { ...documentFixture(), cues: [{ startMs: 0, endMs: 10001, text: "Late" }] } },
  { name: "zero cue duration", value: { ...documentFixture(), cues: [{ startMs: 0, endMs: 0, text: "Instant" }] } },
  { name: "negative cue start", value: { ...documentFixture(), cues: [{ startMs: -1, endMs: 5, text: "Early" }] } },
  { name: "empty cue text", value: { ...documentFixture(), cues: [{ startMs: 0, endMs: 900, text: " " }] } },
  { name: "overlap", value: { ...documentFixture(), cues: [{ startMs: 0, endMs: 900, text: "First" }, { startMs: 800, endMs: 1000, text: "Second" }] } },
];
