import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Why: secrets must never reach disk even if some object accidentally carries them. */
const SECRET_KEYS = /^(authorization|api[-_]?key|ai_gateway_api_key|token)$/i;

export function redact(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (k, v) => {
		if (SECRET_KEYS.test(k)) return '[REDACTED]';
		const key = process.env.AI_GATEWAY_API_KEY;
		if (typeof v === 'string' && key && v.includes(key)) return v.split(key).join('[REDACTED]');
		return v;
	}));
}

/** Append-only JSONL event log. `path = null` keeps events in memory (tests). */
export class JsonlLog {
	readonly events: Record<string, unknown>[] = [];
	readonly path: string | null;

	constructor(path: string | null) {
		this.path = path;
		if (path) mkdirSync(dirname(path), { recursive: true });
	}

	write(type: string, data: Record<string, unknown> = {}) {
		const event = redact({ ts: new Date().toISOString(), type, ...data }) as Record<string, unknown>;
		this.events.push(event);
		if (this.path) appendFileSync(this.path, JSON.stringify(event) + '\n');
	}
}

export function writeText(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
