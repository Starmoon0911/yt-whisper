const MIB = 1024 * 1024;

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond < MIB ? `${Math.round(bytesPerSecond / 1024)} KB/s` : `${(bytesPerSecond / MIB).toFixed(1)} MB/s`;
}
