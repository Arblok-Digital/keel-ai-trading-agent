import { EventEmitter } from 'node:events';
import { timeService } from './ingestion/time-sync.js';

export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
  atServerMs: number;
}

class AgentEventBus extends EventEmitter {
  publish(type: string, payload: Record<string, unknown>): void {
    const event: AgentEvent = { type, payload, atServerMs: timeService.now() };
    this.emit('event', event);
    this.emit(type, event);
  }
}

export const agentEvents = new AgentEventBus();
