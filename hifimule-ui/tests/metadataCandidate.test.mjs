import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Execute the dialog's actual submit handler without requiring a browser.
const source = readFileSync(new URL('../src/components/LibraryToolsDialog.ts', import.meta.url), 'utf8');
const method = source.slice(
    source.indexOf('    private async applyCandidate('),
    source.indexOf('    private invalidateMixPreview('),
);
const handlerClass = stripTypeScriptTypes(`class Dialog { ${method} }`);

async function submit(existing, candidate) {
    let submitted;
    const Dialog = new Function('localMetadataApply', 't', `${handlerClass}; return Dialog;`)(
        async (track, patch) => {
            submitted = { track, patch };
            return { backupRelativePath: 'backup.flac' };
        },
        key => key,
    );
    const dialog = new Dialog();
    Object.assign(dialog, {
        lookupTrack: { songId: 'track', version: 'reviewed-version', ...existing },
        selectedCandidate: {
            title: 'Reviewed title', artist: 'Reviewed artist', album: 'Reviewed album',
            recordingMbid: 'recording', genre: null, year: null,
            trackNumber: null, discNumber: null, ...candidate,
        },
        dialog: { querySelector: () => ({ checked: false }) },
        setStatus() {},
        async scanMetadata() {},
        showError(error) { throw error; },
    });
    await dialog.applyCandidate({});
    assert.equal(submitted.track, dialog.lookupTrack);
    assert.equal(submitted.patch.title, 'Reviewed title');
    return submitted.patch;
}

const existing = { genre: 'Jazz', year: 2001, trackNumber: 7, discNumber: 2 };

test('sparse lookup candidates preserve every existing optional metadata value', async () => {
    for (const missing of [null, undefined]) {
        const candidate = Object.fromEntries(Object.keys(existing).map(key => [key, missing]));
        const patch = await submit(existing, candidate);
        for (const [key, value] of Object.entries(existing)) assert.equal(patch[key], value, key);
    }
});

test('available lookup values replace only the corresponding reviewed fields', async () => {
    const replacements = { genre: 'Electronic', year: 2024, trackNumber: 3, discNumber: 1 };
    for (const [key, value] of Object.entries(replacements)) {
        const patch = await submit(existing, { [key]: value });
        for (const [field, original] of Object.entries(existing)) {
            assert.equal(patch[field], field === key ? value : original, field);
        }
    }
});

test('missing candidate and existing values remain absent', async () => {
    const absent = Object.fromEntries(Object.keys(existing).map(key => [key, null]));
    const patch = await submit(absent, {});
    for (const key of Object.keys(existing)) assert.equal(patch[key], null, key);
});
