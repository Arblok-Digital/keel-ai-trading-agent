import { getEnv } from '../../config/env.js';

interface IncidentState {
  lastSentAtMs: number;
  resolved: boolean;
}

const DEDUP_WINDOW_MS = 300_000;

export class TelegramAlerter {
  private incidents = new Map<string, IncidentState>();
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  configured(): boolean {
    const env = getEnv();
    return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  }

  async alert(incidentKey: string, message: string, nowServerMs: number): Promise<boolean> {
    const state = this.incidents.get(incidentKey);
    if (state) {
      if (!state.resolved && nowServerMs - state.lastSentAtMs < DEDUP_WINDOW_MS) return false;
      if (!state.resolved && nowServerMs - state.lastSentAtMs < DEDUP_WINDOW_MS + 1) return false;
    }
    this.incidents.set(incidentKey, { lastSentAtMs: nowServerMs, resolved: false });
    return this.send(message);
  }

  resolveIncident(incidentKey: string): void {
    const state = this.incidents.get(incidentKey);
    if (state) state.resolved = true;
  }

  private async send(message: string): Promise<boolean> {
    const env = getEnv();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
    try {
      const res = await this.fetcher(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
          signal: AbortSignal.timeout(5000),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const telegram = new TelegramAlerter();
