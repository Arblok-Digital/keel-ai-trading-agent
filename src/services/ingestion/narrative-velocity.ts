import { timeService } from './time-sync.js';

export interface VelocityWindow {
  volumeUsdWindow: number;
  previousVolumeUsdWindow: number;
  windowSeconds: number;
}

export function narrativeVelocity(input: VelocityWindow): number {
  if (input.windowSeconds <= 0) return 0;
  if (input.previousVolumeUsdWindow <= 0) return 0;
  const base = input.previousVolumeUsdWindow;
  const delta = input.volumeUsdWindow - input.previousVolumeUsdWindow;
  const growthPerSecond = delta / base / input.windowSeconds;
  const ratePerMinute = growthPerSecond * 60;
  return Math.max(-30, Math.min(30, ratePerMinute * 10));
}

export interface VelocitySample {
  volumeUsd: number;
  atServerMs: number;
}

export class VolumeVelocityTracker {
  private samples: VelocitySample[] = [];

  observe(volumeUsdWindow: number, atServerMs = timeService.now()): number {
    const prev = this.samples.length > 0 ? (this.samples[this.samples.length - 1] as VelocitySample) : null;
    this.samples.push({ volumeUsd: volumeUsdWindow, atServerMs });
    if (this.samples.length > 12) this.samples.shift();

    if (!prev) {
      return narrativeVelocity({
        volumeUsdWindow,
        previousVolumeUsdWindow: volumeUsdWindow,
        windowSeconds: 60,
      });
    }

    const dtSeconds = Math.max(1, (atServerMs - prev.atServerMs) / 1000);
    return narrativeVelocity({
      volumeUsdWindow,
      previousVolumeUsdWindow: prev.volumeUsd,
      windowSeconds: dtSeconds,
    });
  }

  history(): readonly VelocitySample[] {
    return this.samples;
  }
}
