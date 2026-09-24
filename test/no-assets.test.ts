import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Why: Pokémon sprites/sounds are third-party IP not covered by Showdown's MIT/AGPL
// licenses (docs/licensing.md); they must never be committed to this repo.
const MEDIA = /\.(png|jpe?g|gif|webp|svg|ico|bmp|mp3|ogg|wav|m4a|mp4|webm|ani)$/i;
const SOURCE_DIRS = ['src', 'test', 'scripts', 'docs'];

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

test('no image/audio/video assets in tracked source directories', () => {
	const offenders = SOURCE_DIRS.flatMap(walk).filter(p => MEDIA.test(p));
	assert.deepEqual(offenders, []);
});
