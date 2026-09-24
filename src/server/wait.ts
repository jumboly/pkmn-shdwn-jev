/**
 * Resolve once the server accepts a WebSocket connection.
 *
 * Why: the server prints "now listening" from the parent process while the socket workers
 * may still be starting, so the first client connection can fail right after that line.
 */
export async function waitForServer(port: number, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ok = await new Promise<boolean>(resolve => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/showdown/websocket`);
			ws.onopen = () => { ws.close(); resolve(true); };
			ws.onerror = () => resolve(false);
		});
		if (ok) return;
		if (Date.now() > deadline) throw new Error(`server on :${port} did not accept connections within ${timeoutMs}ms`);
		await new Promise(r => setTimeout(r, 200));
	}
}
