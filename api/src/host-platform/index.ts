import { createDarwinPlatform } from './darwin.js';
import { createLinuxPlatform } from './linux.js';
import type { HostPlatform } from './types.js';
import { createUnsupportedPlatform } from './unsupported.js';

export type * from './types.js';
export { createDarwinPlatform, createLinuxPlatform, createUnsupportedPlatform };

// The one place that knows which operating system this is. WSL reports
// 'linux' and is Linux in every way that matters here.
const PLATFORMS: Partial<Record<NodeJS.Platform, () => HostPlatform>> = {
  linux: () => createLinuxPlatform(),
  darwin: () => createDarwinPlatform(),
};

export function createHostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  return (PLATFORMS[platform] ?? (() => createUnsupportedPlatform()))();
}

let current: HostPlatform | null = null;

/** This machine's platform implementation, made once. */
export function hostPlatform(): HostPlatform {
  return current ??= createHostPlatform();
}

/** Tests: pin an implementation (e.g. Linux's, with fixtures), or null to go back to this machine's. */
export function useHostPlatform(platform: HostPlatform | null): void {
  current = platform;
}
