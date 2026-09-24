import { legalChoices, type LegalChoice } from '../showdown/choices.ts';
import type { SideID } from '../showdown/protocol.ts';
import { VisibleStateTracker, type VisibleState } from '../showdown/state.ts';
import type { ChoiceRequest } from '../showdown/types.ts';

export const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export interface PendingDecision {
	roomid: string;
	side: SideID;
	request: ChoiceRequest & { rqid?: number };
	state: VisibleState;
	choices: LegalChoice[];
}

/**
 * Tracks one battle room as seen by ONE user's connection (i.e. that player's channel), and
 * emits a decision point once a request is pending and the room has gone quiet.
 *
 * Why debounce: the server sends `|request|` separately from the room log and nothing in the
 * protocol guarantees their relative order, so we wait until the turn's log has settled
 * before snapshotting the state.
 */
export class BattleRoomObserver {
	readonly roomid: string;
	private readonly userid: string;
	private tracker: VisibleStateTracker | null = null;
	private buffer: string[] = [];
	private pending: (ChoiceRequest & { rqid?: number }) | null = null;
	private debounce: NodeJS.Timeout | null = null;
	private lastRqid: number | undefined;
	private lastRequest: (ChoiceRequest & { rqid?: number }) | null = null;
	private onDecision: (d: PendingDecision) => void;
	private debounceMs: number;
	ended = false;
	winner: string | null = null;
	/** Latest battle-timer reading for this player (only present when the timer is on). */
	timer: { turnSeconds: number, totalSeconds: number, at: number } | null = null;
	private retries = 0;
	private readonly now: () => number;

	constructor(roomid: string, username: string, onDecision: (d: PendingDecision) => void, debounceMs = 150, now: () => number = Date.now) {
		this.roomid = roomid;
		this.now = now;
		this.userid = toID(username);
		this.onDecision = onDecision;
		this.debounceMs = debounceMs;
	}

	get side(): SideID | null {
		return this.tracker?.perspective ?? null;
	}

	get turn() {
		return this.tracker?.turn ?? 0;
	}

	feed(lines: string[]) {
		for (const line of lines) {
			if (!this.tracker) {
				const m = /^\|player\|(p[12])\|([^|]*)/.exec(line);
				const req = line.startsWith('|request|') ? JSON.parse(line.slice(9)) : null;
				const side = (m && toID(m[2]) === this.userid ? m[1] : req?.side?.id) as SideID | undefined;
				this.buffer.push(line);
				if (side) {
					this.tracker = new VisibleStateTracker(side);
					this.tracker.feed(this.buffer.join('\n'));
					for (const l of this.buffer) { this.captureRequest(l); this.captureTimer(l); }
					this.buffer = [];
				}
				continue;
			}
			this.tracker.feed(line);
			this.captureRequest(line);
			this.captureTimer(line);
			if (line.startsWith('|win|') || line === '|tie') {
				this.ended = true;
				this.winner = line.startsWith('|win|') ? line.slice(5) : null;
				this.pending = null;
			}
		}
		this.schedule();
	}

	/** Seconds until this player's timer runs out, or null when no timer is running. */
	secondsLeft(): number | null {
		if (!this.timer) return null;
		return Math.min(this.timer.turnSeconds, this.timer.totalSeconds) - (this.now() - this.timer.at) / 1000;
	}

	private captureTimer(line: string) {
		// Sent only to this player's channel each turn while the battle timer is on.
		const m = /^\|inactive\|Time left: (\d+) sec this turn \| (\d+) sec total/.exec(line);
		if (m) this.timer = { turnSeconds: Number(m[1]), totalSeconds: Number(m[2]), at: this.now() };
		if (line.startsWith('|inactiveoff|')) this.timer = null;
	}

	private captureRequest(line: string) {
		if (line.startsWith('|sentchoice|')) {
			// Why: after a reconnect the server re-sends the request; `sentchoice` means our
			// earlier /choose already reached it, so answering again would only produce errors.
			this.lastRqid = this.pending?.rqid ?? this.lastRqid;
			this.pending = null;
			return;
		}
		if (!line.startsWith('|request|')) return;
		const body = line.slice(9);
		if (!body) return;
		const req = JSON.parse(body);
		// Why: an updated request (after `[Unavailable choice]`) reuses the rqid but must be answered.
		if (req.update) this.lastRqid = undefined;
		this.pending = req.wait ? null : req;
	}

	private schedule() {
		if (this.debounce) clearTimeout(this.debounce);
		if (!this.pending || !this.tracker || this.ended) return;
		this.debounce = setTimeout(() => this.flush(), this.debounceMs);
	}

	private flush() {
		const request = this.pending;
		if (!request || !this.tracker || this.ended) return;
		// Why: the same request can be re-sent (reconnect, /join); decide once per rqid.
		if (request.rqid !== undefined && request.rqid === this.lastRqid) return;
		if (request.rqid !== this.lastRequest?.rqid) this.retries = 0;
		this.lastRqid = request.rqid;
		this.lastRequest = request;
		this.pending = null;
		this.tracker.request = request;
		const choices = legalChoices(request, this.tracker.gen);
		const state = this.tracker.snapshot();
		this.onDecision({ roomid: this.roomid, side: this.tracker.perspective, request, state, choices });
	}

	/**
	 * Force a fresh decision for the current request (after `[Invalid choice]`).
	 * Returns false once the per-request retry cap is hit.
	 */
	retry(maxRetries = 3) {
		// Why: some invalid-choice errors (e.g. "nothing to choose" after a reconnect) repeat
		// forever; without a cap each repeat would cost another JEV request.
		if (++this.retries > maxRetries) return false;
		this.lastRqid = undefined;
		if (!this.pending) this.pending = this.lastRequest;
		this.schedule();
		return true;
	}
}

/** Split a server frame `>roomid\nline\nline` into its room and lines. */
export function parseFrame(data: string): { roomid: string, lines: string[] } {
	let roomid = '';
	let lines = data.split('\n');
	if (lines[0].startsWith('>')) {
		roomid = lines[0].slice(1);
		lines = lines.slice(1);
	}
	return { roomid, lines };
}
