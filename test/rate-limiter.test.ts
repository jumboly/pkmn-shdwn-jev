import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveRateLimiter } from '../src/decision/rate-limiter.ts';

function fakeClock() {
	let t = 0;
	const waits: number[] = [];
	return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits, advance: (ms: number) => { t += ms; } };
}

test('no pacing until a 429 is seen', async () => {
	const c = fakeClock();
	const l = new AdaptiveRateLimiter(c);
	for (let i = 0; i < 5; i++) await l.acquire();
	assert.deepEqual(c.waits, []);
});

test('a 429 pauses all senders for retry-after, then paces requests', async () => {
	const c = fakeClock();
	const l = new AdaptiveRateLimiter(c);
	l.onRateLimited(3000);
	// Two concurrent senders both wait out the shared cooldown instead of each hitting 429.
	await Promise.all([l.acquire(), l.acquire()]);
	assert.equal(c.waits[0], 3000);
	assert.ok(l.intervalMs >= 500);
	assert.equal(l.stats.rateLimited, 1);
});

test('interval grows on repeated 429 and decays back to zero on success', () => {
	const l = new AdaptiveRateLimiter(fakeClock());
	l.onRateLimited(null); l.onRateLimited(null); l.onRateLimited(null);
	assert.equal(l.intervalMs, 2000);
	for (let i = 0; i < 100; i++) l.onSuccess();
	assert.equal(l.intervalMs, 0);
});
