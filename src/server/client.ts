import { join } from 'node:path';
import type { BudgetGuard } from '../budget.ts';
import type { DecisionProvider } from '../decision/types.ts';
import { JsonlLog, writeText } from '../logging.ts';
import { replayHtml } from '../replay.ts';
import { BattleRoomObserver, parseFrame, toID, type PendingDecision } from './room.ts';
import { decideWithDeadline } from './deadline.ts';

export interface AutonomousClientOptions {
	/** e.g. ws://localhost:8000/showdown/websocket (local / self-hosted server only). */
	url: string;
	username: string;
	provider: DecisionProvider;
	formats: string[];
	logDir: string;
	/** Accept challenges from these users only (empty = anyone). */
	acceptFrom?: string[];
	/** Queue on the ladder instead of waiting for challenges. */
	search?: boolean;
	/** Stop after this many battles (0 = unlimited). */
	maxBattles?: number;
	budget?: BudgetGuard | null;
	/** Worst-case expected JEV usage per battle for the "can we accept another battle" check. */
	expectedBattle?: { requests: number, costUsd: number };
	/** Optional challenge to send after login (for tests / automation): `user, format`. */
	challenge?: { user: string, format: string };
	/** Re-send `challenge` after each finished battle until maxBattles (for bot-vs-bot spectating). */
	rechallenge?: boolean;
	quiet?: boolean;
	/** Reconnect after an unexpected disconnect. Defaults: 10 attempts, 1s..15s backoff. */
	reconnect?: { maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number } | false;
	/**
	 * Used, explicitly flagged, when the battle timer would expire before the provider answers.
	 * Null keeps the old behaviour (wait for the provider however long it takes).
	 */
	timerFallback?: DecisionProvider | null;
	/** Seconds to keep in reserve for the fallback and the network. */
	timerMarginSeconds?: number;
	/** Turn the battle timer on in each battle (so a stalled opponent cannot hang the bot). */
	enableTimer?: boolean;
	onBattleStart?: (roomid: string) => void;
	/** Chat rooms to join after login (e.g. lobby, so humans can see the bot in the user list). */
	joinRooms?: string[];
}

/**
 * Autonomous Mode: JEV as an ordinary player on a Showdown server. Uses the same tracker,
 * legal-choice builder and DecisionProvider as the simulator runner; only transport differs.
 */
export class AutonomousClient {
	private ws!: WebSocket;
	private rooms = new Map<string, { observer: BattleRoomObserver, log: JsonlLog, spectator: string[], closed?: boolean }>();
	private opts: AutonomousClientOptions;
	/** Per connection: reset on every reconnect. */
	private loggedIn = false;
	private everLoggedIn = false;
	private closing = false;
	private reconnectAttempts = 0;
	/** Room-independent events (connection lifecycle). */
	private clientLog: JsonlLog;
	private battlesStarted = 0;
	private battlesFinished = 0;
	private done!: () => void;
	readonly finished: Promise<void>;
	results: { roomid: string, winner: string | null, won: boolean | null, turns: number }[] = [];

	constructor(opts: AutonomousClientOptions) {
		this.opts = opts;
		this.finished = new Promise(r => { this.done = r; });
		this.clientLog = new JsonlLog(join(opts.logDir, `client-${toID(opts.username)}.jsonl`));
	}

	private say(msg: string) {
		if (!this.opts.quiet) console.log(`[${this.opts.username}] ${msg}`);
	}

	/** Returns false when the socket is not open (the message is dropped, not queued). */
	private send(text: string) {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(text);
		return true;
	}

	/** Resolves on the first login; later reconnects happen in the background. */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => this.open(resolve, reject));
	}

	private open(onReady: () => void, onFail: (err: Error) => void) {
		this.loggedIn = false;
		const ws = new WebSocket(this.opts.url);
		this.ws = ws;
		ws.onerror = e => {
			const err = new Error(`websocket error: ${(e as any).message ?? e.type}`);
			if (!this.everLoggedIn && this.reconnectAttempts === 0) onFail(err);
		};
		ws.onclose = () => {
			if (ws !== this.ws) return;
			this.say('disconnected');
			if (this.closing) { this.done(); return; }
			// Why: before the first login the failure is reported by connect() rejecting, and the
			// caller may retry connect(); resolving `finished` here would end the run early.
			if (!this.everLoggedIn) return;
			this.scheduleReconnect();
		};
		ws.onmessage = e => {
			try { this.onFrame(String(e.data), onReady); } catch (err) { this.say(`error handling frame: ${err}`); }
		};
	}

	private scheduleReconnect() {
		const cfg = this.opts.reconnect === false ? null : { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 15_000, ...this.opts.reconnect };
		if (!cfg || this.reconnectAttempts >= cfg.maxAttempts) {
			this.clientLog.write('reconnect-gave-up', { attempts: this.reconnectAttempts });
			this.say('giving up on reconnecting');
			this.done();
			return;
		}
		const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** this.reconnectAttempts);
		this.reconnectAttempts++;
		this.clientLog.write('reconnect-scheduled', { attempt: this.reconnectAttempts, delayMs: delay, openBattles: this.openBattles() });
		this.say(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
		setTimeout(() => { if (!this.closing) this.open(() => {}, () => {}); }, delay);
	}

	private joinChatRooms() {
		for (const r of this.opts.joinRooms ?? []) this.send(`|/join ${r}`);
	}

	private openBattles() {
		return [...this.rooms].filter(([, r]) => !r.closed).map(([id]) => id);
	}

	close() {
		this.closing = true;
		this.ws?.close();
	}

	/** Simulate a network drop (tests): closes the socket without marking the close as intended. */
	dropConnection() {
		this.ws?.close();
	}

	private budgetRefusal(): string | null {
		if (!this.opts.budget || !this.opts.expectedBattle) return null;
		return this.opts.budget.checkNewBattle(this.opts.expectedBattle);
	}

	private onFrame(data: string, onReady: () => void) {
		const { roomid, lines } = parseFrame(data);
		if (roomid.startsWith('battle-')) return this.onBattleLines(roomid, lines);
		for (const line of lines) {
			if (line.startsWith('|challstr|')) {
				// Local dev servers started with --no-security accept `/trn NAME` without a token.
				this.send(`|/trn ${this.opts.username}`);
			} else if (line.startsWith('|updateuser|')) {
				const name = line.split('|')[2].trim();
				if (toID(name) !== toID(this.opts.username) || this.loggedIn) continue;
				this.loggedIn = true;
				if (this.everLoggedIn) {
					// The server re-sends each battle we are in (|init| + full log + request).
					this.clientLog.write('reconnected', { attempts: this.reconnectAttempts, openBattles: this.openBattles() });
					this.say(`reconnected as ${name}`);
					this.reconnectAttempts = 0;
					this.send('|/utm null');
					this.joinChatRooms();
					continue;
				}
				this.everLoggedIn = true;
				this.say(`logged in as ${name}`);
				this.send('|/utm null');
				this.joinChatRooms();
				if (this.opts.search) for (const f of this.opts.formats) this.send(`|/search ${f}`);
				if (this.opts.challenge) this.send(`|/challenge ${this.opts.challenge.user}, ${this.opts.challenge.format}`);
				onReady();
			} else if (line.startsWith('|pm|')) {
				// `|pm| FROM| TO|/challenge FORMAT|...` (current server challenge notification)
				const [, , from, to, msg] = line.split('|');
				const m = /^\/challenge (\S+)/.exec(msg ?? '');
				const clean = (u: string) => u.trim().replace(/^[^a-zA-Z0-9]/, '');
				// Why: the server echoes our own outgoing challenge back to us as a pm; only
				// challenges addressed to us from someone else are ours to accept.
				if (m && toID(clean(to ?? '')) === toID(this.opts.username) && toID(clean(from)) !== toID(this.opts.username)) this.onChallenge(clean(from), m[1]);
			} else if (line.startsWith('|popup|')) {
				this.say(`popup: ${line.slice(7)}`);
			}
		}
	}

	private onChallenge(from: string, format: string) {
		const allowed = !this.opts.acceptFrom?.length || this.opts.acceptFrom.map(toID).includes(toID(from));
		const refusal = this.budgetRefusal();
		if (!allowed || !this.opts.formats.includes(format) || refusal || (this.opts.maxBattles && this.battlesStarted >= this.opts.maxBattles)) {
			this.say(`rejecting ${format} challenge from ${from}${refusal ? ` (budget: ${refusal})` : ''}`);
			this.send(`|/reject ${from}`);
			return;
		}
		this.say(`accepting ${format} challenge from ${from}`);
		this.send('|/utm null');
		this.send(`|/accept ${from}`);
	}

	private newObserver(roomid: string) {
		const observer: BattleRoomObserver = new BattleRoomObserver(roomid, this.opts.username, d => void this.decide(d, observer));
		return observer;
	}

	private onBattleLines(roomid: string, lines: string[]) {
		let room = this.rooms.get(roomid);
		if (room && !room.closed && lines.includes('|init|battle')) {
			// Why: a rejoin replays the whole log; feeding it into the old tracker would double
			// every event, so rebuild the player's view from scratch.
			room.observer = this.newObserver(roomid);
			room.spectator = [];
			room.log.write('rejoined', { roomid });
		}
		if (!room) {
			const log = new JsonlLog(join(this.opts.logDir, `${roomid}.jsonl`));
			room = { observer: this.newObserver(roomid), log, spectator: [] };
			this.rooms.set(roomid, room);
			this.battlesStarted++;
			log.write('battle-start', { transport: 'server', roomid, url: this.opts.url, username: this.opts.username, provider: this.opts.provider.name });
			this.say(`joined ${roomid}`);
			if (this.opts.enableTimer) this.send(`${roomid}|/timer on`);
			this.opts.onBattleStart?.(roomid);
		}
		for (const line of lines) {
			if (line.startsWith('|error|')) {
				room.log.write('server-error', { roomid, message: line });
				this.say(line);
				// `[Unavailable choice]` comes with an updated request; `[Invalid choice]` means we must re-decide.
				if (line.startsWith('|error|[Invalid choice]') && !room.observer.retry()) {
					room.log.write('retry-cap', { roomid, message: line });
				}
			}
			// Keep a player-channel log for the replay (the player's own view, no `|split|`).
			if (!line.startsWith('|request|') && line !== '') room.spectator.push(line);
		}
		room.observer.feed(lines);
		if (room.observer.ended && !room.closed) {
			room.closed = true;
			const won = room.observer.winner === null ? null : toID(room.observer.winner) === toID(this.opts.username);
			room.log.write('battle-end', { roomid, winner: room.observer.winner, won, turns: room.observer.turn });
			writeText(join(this.opts.logDir, `${roomid}.player.log`), room.spectator.join('\n'));
			writeText(join(this.opts.logDir, `${roomid}.replay.html`), replayHtml({ log: room.spectator.join('\n'), title: `${roomid} (${this.opts.username}'s view)`, replayId: roomid }));
			this.results.push({ roomid, winner: room.observer.winner, won, turns: room.observer.turn });
			this.say(`${roomid} ended: winner ${room.observer.winner}`);
			this.send(`|/leave ${roomid}`);
			this.battlesFinished++;
			if (this.opts.maxBattles && this.battlesFinished >= this.opts.maxBattles) this.close();
			else if (this.opts.search) {
				// Why: a finished search is not re-queued by the server; keep the bot findable
				// from the "Battle!" button between games.
				setTimeout(() => { for (const f of this.opts.formats) this.send(`|/search ${f}`); }, 1000);
			} else if (this.opts.rechallenge && this.opts.challenge) {
				const { user, format } = this.opts.challenge;
				setTimeout(() => this.send(`|/challenge ${user}, ${format}`), 1000);
			}
		}
	}

	private timeBudgetMs(observer: BattleRoomObserver): number | null {
		const left = observer.secondsLeft();
		if (left === null || !this.opts.timerFallback) return null;
		return (left - (this.opts.timerMarginSeconds ?? 8)) * 1000;
	}

	private async decide(d: PendingDecision, observer: BattleRoomObserver) {
		const room = this.rooms.get(d.roomid)!;
		try {
			const ctx = { battleId: d.roomid, side: d.side, state: d.state, choices: d.choices };
			const budgetMs = this.timeBudgetMs(observer);
			const r = await decideWithDeadline(this.opts.provider, ctx, budgetMs, this.opts.timerFallback ?? null);
			if (r.timedOut) {
				this.say(`timer: using fallback in ${d.roomid} turn ${d.state.turn}`);
				void r.primary.then(late => room.log.write('late-decision', { roomid: d.roomid, turn: d.state.turn, rqid: d.request.rqid, late }));
			}
			const { decision } = r;
			const choice = d.choices.find(c => c.id === decision.choiceId);
			if (!choice) throw new Error(`provider returned unknown choice ${decision.choiceId}`);
			// Why: a reconnect replaces the observer and re-requests; an answer computed for the
			// old view must not be sent (the fresh request gets its own decision).
			if (room.observer !== observer || room.closed) {
				room.log.write('decision-stale', { roomid: d.roomid, turn: d.state.turn, rqid: d.request.rqid, choiceId: decision.choiceId });
				return;
			}
			const cmd = `${d.roomid}|/choose ${choice.command}${d.request.rqid !== undefined ? `|${d.request.rqid}` : ''}`;
			room.log.write('decision', { roomid: d.roomid, side: d.side, turn: d.state.turn, request: d.request, state: d.state, choices: d.choices, decision, command: choice.command, timeBudgetMs: budgetMs, timedOut: r.timedOut });
			if (!this.send(cmd)) {
				// The server re-sends this request after we reconnect, and we decide again then.
				room.log.write('send-dropped', { roomid: d.roomid, turn: d.state.turn, rqid: d.request.rqid });
			}
		} catch (err: any) {
			room.log.write('decision-error', { roomid: d.roomid, turn: d.state.turn, error: String(err?.message ?? err), code: err?.code });
			this.say(`decision failed in ${d.roomid}: ${err?.message ?? err}; forfeiting`);
			// Why: never silently substitute a random move; forfeit makes the failure explicit.
			this.send(`${d.roomid}|/forfeit`);
		}
	}
}
