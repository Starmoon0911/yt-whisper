import { describe, expect, it } from "vitest";
import { formatSpeed } from "../src/speed";

describe("formatSpeed", () => {
  it("formats below 1 MiB/s as rounded KB/s", () => {
    expect(formatSpeed(0)).toBe("0 KB/s");
    expect(formatSpeed(511)).toBe("0 KB/s");
    expect(formatSpeed(512)).toBe("1 KB/s");
    expect(formatSpeed(100 * 1024)).toBe("100 KB/s");
    expect(formatSpeed(1024 * 1024 - 1)).toBe("1024 KB/s");
  });

  it("formats 1 MiB/s and above as one-decimal MB/s", () => {
    expect(formatSpeed(1024 * 1024)).toBe("1.0 MB/s");
    expect(formatSpeed(2516582)).toBe("2.4 MB/s");
    expect(formatSpeed(10 * 1024 * 1024)).toBe("10.0 MB/s");
  });
});
