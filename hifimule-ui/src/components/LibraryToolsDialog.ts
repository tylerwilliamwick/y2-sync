import { t } from '../i18n';
import {
    ListenBrainzImportResult,
    LocalMetadataAudit,
    LocalMetadataTrack,
    MetadataCandidate,
    PlaylistToolResult,
    localListenBrainzImport,
    localMetadataApply,
    localMetadataAudit,
    localMetadataLookup,
    localPlaylistGenerate,
} from '../rpc';

type LocalMixKind = 'discovery' | 'weekly' | 'daily';
type ListenBrainzKind = 'weekly-exploration' | 'weekly-jams' | 'daily-jams';

export class LibraryToolsDialog {
    private dialog: any = null;
    private audit: LocalMetadataAudit | null = null;
    private lookupTrack: LocalMetadataTrack | null = null;
    private candidates: MetadataCandidate[] = [];
    private selectedCandidate: MetadataCandidate | null = null;

    public async open(): Promise<void> {
        if (!this.dialog) this.mount();
        await customElements.whenDefined('sl-dialog');
        await this.dialog.updateComplete;
        this.dialog.show();
        if (!this.audit) void this.scanMetadata();
    }

    private mount(): void {
        const dialog = document.createElement('sl-dialog') as any;
        dialog.id = 'library-tools-dialog';
        dialog.className = 'library-tools-dialog';
        dialog.label = t('libraryTools.title');
        dialog.innerHTML = `
            <p class="library-tools-intro">${t('libraryTools.intro')}</p>
            <sl-alert id="library-tools-status" variant="primary" open></sl-alert>
            <sl-tab-group>
                <sl-tab slot="nav" panel="metadata">${t('libraryTools.metadata.tab')}</sl-tab>
                <sl-tab slot="nav" panel="mixes">${t('libraryTools.mixes.tab')}</sl-tab>
                <sl-tab slot="nav" panel="listenbrainz">${t('libraryTools.listenbrainz.tab')}</sl-tab>

                <sl-tab-panel name="metadata">
                    <div class="library-tools-actions">
                        <sl-button id="metadata-scan" variant="default">
                            <sl-icon slot="prefix" name="search"></sl-icon>${t('libraryTools.metadata.scan')}
                        </sl-button>
                    </div>
                    <div id="metadata-results" class="library-tools-results" aria-live="polite"></div>
                </sl-tab-panel>

                <sl-tab-panel name="mixes">
                    <p>${t('libraryTools.mixes.help')}</p>
                    <div class="library-tools-form-row">
                        <sl-select id="mix-kind" label="${t('libraryTools.mixes.kind')}" value="discovery">
                            <sl-option value="discovery">${t('libraryTools.mixes.discovery')}</sl-option>
                            <sl-option value="weekly">${t('libraryTools.mixes.weekly')}</sl-option>
                            <sl-option value="daily">${t('libraryTools.mixes.daily')}</sl-option>
                        </sl-select>
                        <sl-input id="mix-limit" type="number" min="1" max="500" value="50" label="${t('libraryTools.maxTracks')}"></sl-input>
                    </div>
                    <div class="library-tools-actions">
                        <sl-button id="mix-preview">${t('libraryTools.preview')}</sl-button>
                        <sl-button id="mix-write" variant="primary" disabled>${t('libraryTools.createPlaylist')}</sl-button>
                    </div>
                    <div id="mix-results" class="library-tools-results" aria-live="polite"></div>
                </sl-tab-panel>

                <sl-tab-panel name="listenbrainz">
                    <p>${t('libraryTools.listenbrainz.help')}</p>
                    <div class="library-tools-form-row">
                        <sl-input id="listenbrainz-user" maxlength="64" label="${t('libraryTools.listenbrainz.username')}" required></sl-input>
                        <sl-select id="listenbrainz-kind" label="${t('libraryTools.listenbrainz.kind')}" value="weekly-exploration">
                            <sl-option value="weekly-exploration">${t('libraryTools.listenbrainz.exploration')}</sl-option>
                            <sl-option value="weekly-jams">${t('libraryTools.listenbrainz.weekly')}</sl-option>
                            <sl-option value="daily-jams">${t('libraryTools.listenbrainz.daily')}</sl-option>
                        </sl-select>
                    </div>
                    <div class="library-tools-actions">
                        <sl-button id="listenbrainz-preview">${t('libraryTools.preview')}</sl-button>
                        <sl-button id="listenbrainz-write" variant="primary" disabled>${t('libraryTools.createPlaylist')}</sl-button>
                    </div>
                    <div id="listenbrainz-results" class="library-tools-results" aria-live="polite"></div>
                </sl-tab-panel>
            </sl-tab-group>
            <sl-button slot="footer" id="library-tools-close">${t('libraryTools.close')}</sl-button>
        `;
        document.body.appendChild(dialog);
        dialog.querySelector('#library-tools-close')?.addEventListener('click', () => dialog.hide());
        dialog.querySelector('#metadata-scan')?.addEventListener('click', () => void this.scanMetadata());
        dialog.querySelector('#mix-preview')?.addEventListener('click', () => void this.runMix(false));
        dialog.querySelector('#mix-write')?.addEventListener('click', () => void this.runMix(true));
        dialog.querySelector('#listenbrainz-preview')?.addEventListener('click', () => void this.runListenBrainz(false));
        dialog.querySelector('#listenbrainz-write')?.addEventListener('click', () => void this.runListenBrainz(true));
        dialog.querySelector('#mix-kind')?.addEventListener('sl-change', () => this.invalidateMixPreview());
        dialog.querySelector('#mix-limit')?.addEventListener('sl-input', () => this.invalidateMixPreview());
        dialog.querySelector('#listenbrainz-user')?.addEventListener('sl-input', () => this.invalidateListenBrainzPreview());
        dialog.querySelector('#listenbrainz-kind')?.addEventListener('sl-change', () => this.invalidateListenBrainzPreview());
        dialog.addEventListener('sl-after-hide', (event: Event) => {
            if (event.target === dialog) {
                dialog.remove();
                this.dialog = null;
            }
        });
        this.dialog = dialog;
        this.setStatus(t('libraryTools.ready'), 'primary');
    }

    private async scanMetadata(): Promise<void> {
        const button = this.dialog?.querySelector('#metadata-scan') as any;
        try {
            if (button) button.loading = true;
            this.setStatus(t('libraryTools.metadata.scanning'), 'primary');
            this.audit = await localMetadataAudit();
            this.lookupTrack = null;
            this.candidates = [];
            this.selectedCandidate = null;
            this.renderAudit();
            this.setStatus(
                t('libraryTools.metadata.summary', {
                    issues: this.audit.tracksWithIssues,
                    total: this.audit.totalTracks,
                }),
                this.audit.tracksWithIssues ? 'warning' : 'success',
            );
        } catch (error) {
            this.showError(error);
        } finally {
            if (button) button.loading = false;
        }
    }

    private renderAudit(): void {
        const target = this.dialog?.querySelector('#metadata-results') as HTMLElement | null;
        if (!target || !this.audit) return;
        const issueSummary = Object.entries(this.audit.issueCounts)
            .sort((left, right) => right[1] - left[1])
            .map(([issue, count]) => `<sl-badge variant="neutral">${this.escape(this.issueLabel(issue))}: ${count}</sl-badge>`)
            .join('');
        const visible = this.audit.tracks.slice(0, 100);
        target.innerHTML = `
            <div class="library-tools-badges">${issueSummary || `<sl-badge variant="success">${t('libraryTools.metadata.clean')}</sl-badge>`}</div>
            ${visible.map(track => `
                <article class="library-tools-track">
                    <div>
                        <strong>${this.escape(track.title)}</strong>
                        <span>${this.escape(track.artist)} · ${this.escape(track.album)}</span>
                        <small title="${this.escape(track.relativePath)}">${this.escape(track.relativePath)}</small>
                        <div class="library-tools-badges">${track.issues.map(issue => `<sl-badge variant="warning">${this.escape(this.issueLabel(issue))}</sl-badge>`).join('')}</div>
                    </div>
                    <sl-button size="small" class="metadata-lookup" data-song="${this.escape(track.songId)}">${t('libraryTools.metadata.findMatch')}</sl-button>
                </article>
            `).join('') || `<p>${t('libraryTools.metadata.none')}</p>`}
            ${this.audit.tracks.length > visible.length ? `<p><small>${t('libraryTools.metadata.firstHundred')}</small></p>` : ''}
        `;
        target.querySelectorAll('.metadata-lookup').forEach(button => {
            button.addEventListener('click', () => {
                const songId = (button as HTMLElement).dataset.song;
                const track = this.audit?.tracks.find(item => item.songId === songId);
                if (track) void this.lookupMetadata(track, button as any);
            });
        });
    }

    private async lookupMetadata(track: LocalMetadataTrack, button: any): Promise<void> {
        try {
            button.loading = true;
            this.setStatus(t('libraryTools.metadata.searching'), 'primary');
            const result = await localMetadataLookup(track);
            this.lookupTrack = result.track;
            this.candidates = result.candidates;
            this.selectedCandidate = null;
            this.renderCandidates();
            this.setStatus(
                result.candidates.length
                    ? t('libraryTools.metadata.reviewPrompt')
                    : t('libraryTools.metadata.noMatches'),
                result.candidates.length ? 'primary' : 'warning',
            );
        } catch (error) {
            this.showError(error);
        } finally {
            button.loading = false;
        }
    }

    private renderCandidates(): void {
        const target = this.dialog?.querySelector('#metadata-results') as HTMLElement | null;
        if (!target || !this.lookupTrack) return;
        target.innerHTML = `
            <div class="library-tools-actions"><sl-button id="metadata-back" size="small">${t('libraryTools.back')}</sl-button></div>
            <h3>${this.escape(this.lookupTrack.title)} — ${this.escape(this.lookupTrack.artist)}</h3>
            <sl-radio-group id="metadata-candidates" label="${t('libraryTools.metadata.candidates')}">
                ${this.candidates.map(candidate => `
                    <sl-radio value="${this.escape(candidate.candidateId)}">
                        <span class="metadata-candidate">
                            <strong>${this.escape(candidate.title)} — ${this.escape(candidate.artist)}</strong>
                            <span>${this.escape(candidate.album)}${candidate.year ? ` · ${candidate.year}` : ''} · ${candidate.score}%</span>
                            <small>${candidate.trackNumber ? `${t('libraryTools.metadata.track')} ${candidate.trackNumber}` : ''}${candidate.discNumber ? ` · ${t('libraryTools.metadata.disc')} ${candidate.discNumber}` : ''}${candidate.genre ? ` · ${this.escape(candidate.genre)}` : ''}</small>
                        </span>
                    </sl-radio>
                `).join('')}
            </sl-radio-group>
            ${this.candidates.length ? `
                <div class="metadata-review-box">
                    <sl-checkbox id="metadata-artwork">${t('libraryTools.metadata.artwork')}</sl-checkbox>
                    <sl-checkbox id="metadata-confirm">${t('libraryTools.metadata.confirm')}</sl-checkbox>
                    <sl-button id="metadata-apply" variant="primary" disabled>${t('libraryTools.metadata.write')}</sl-button>
                    <p><small>${t('libraryTools.metadata.backup')}</small></p>
                </div>
            ` : `<p>${t('libraryTools.metadata.noMatches')}</p>`}
        `;
        target.querySelector('#metadata-back')?.addEventListener('click', () => this.renderAudit());
        const group = target.querySelector('#metadata-candidates') as any;
        const confirm = target.querySelector('#metadata-confirm') as any;
        const apply = target.querySelector('#metadata-apply') as any;
        const artwork = target.querySelector('#metadata-artwork') as any;
        const update = () => {
            this.selectedCandidate = this.candidates.find(candidate => candidate.candidateId === group?.value) ?? null;
            if (apply) apply.disabled = !(this.selectedCandidate && confirm?.checked);
            if (artwork) {
                artwork.disabled = !this.selectedCandidate?.releaseMbid;
                if (artwork.disabled) artwork.checked = false;
            }
        };
        group?.addEventListener('sl-change', update);
        confirm?.addEventListener('sl-change', update);
        apply?.addEventListener('click', () => void this.applyCandidate(apply));
    }

    private async applyCandidate(button: any): Promise<void> {
        if (!this.lookupTrack || !this.selectedCandidate) return;
        const candidate = this.selectedCandidate;
        const artwork = this.dialog.querySelector('#metadata-artwork') as any;
        try {
            button.loading = true;
            button.disabled = true;
            this.setStatus(t('libraryTools.metadata.writing'), 'warning');
            const result = await localMetadataApply(this.lookupTrack, {
                title: candidate.title,
                artist: candidate.artist,
                album: candidate.album,
                genre: candidate.genre,
                year: candidate.year,
                trackNumber: candidate.trackNumber,
                discNumber: candidate.discNumber,
                recordingMbid: candidate.recordingMbid,
                artistMbid: candidate.artistMbid,
                releaseMbid: candidate.releaseMbid,
                releaseGroupMbid: candidate.releaseGroupMbid,
                includeArtwork: Boolean(artwork?.checked && candidate.releaseMbid),
            });
            this.audit = null;
            await this.scanMetadata();
            this.setStatus(
                t('libraryTools.metadata.written', { backup: result.backupRelativePath }),
                'success',
            );
        } catch (error) {
            this.showError(error);
            button.disabled = false;
        } finally {
            button.loading = false;
        }
    }

    private invalidateMixPreview(): void {
        const write = this.dialog?.querySelector('#mix-write') as any;
        if (write) write.disabled = true;
    }

    private async runMix(write: boolean): Promise<void> {
        const kind = (this.dialog.querySelector('#mix-kind') as any)?.value as LocalMixKind;
        const rawLimit = Number((this.dialog.querySelector('#mix-limit') as any)?.value ?? 50);
        const maxTracks = Math.max(1, Math.min(500, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));
        const button = this.dialog.querySelector(write ? '#mix-write' : '#mix-preview') as any;
        try {
            button.loading = true;
            this.setStatus(t(write ? 'libraryTools.creating' : 'libraryTools.previewing'), 'primary');
            const result = await localPlaylistGenerate({ kind, maxTracks, write });
            const writeButton = this.dialog.querySelector('#mix-write') as any;
            if (writeButton) writeButton.disabled = write;
            this.renderPlaylistResult('#mix-results', result);
            this.setStatus(
                write
                    ? t('libraryTools.created', { path: result.playlistRelativePath ?? '' })
                    : t('libraryTools.previewReady', { count: result.trackCount }),
                'success',
            );
        } catch (error) {
            this.showError(error);
        } finally {
            button.loading = false;
        }
    }

    private invalidateListenBrainzPreview(): void {
        const write = this.dialog?.querySelector('#listenbrainz-write') as any;
        if (write) write.disabled = true;
    }

    private async runListenBrainz(write: boolean): Promise<void> {
        const username = String((this.dialog.querySelector('#listenbrainz-user') as any)?.value ?? '').trim();
        const kind = (this.dialog.querySelector('#listenbrainz-kind') as any)?.value as ListenBrainzKind;
        if (!username) {
            this.setStatus(t('libraryTools.listenbrainz.usernameRequired'), 'danger');
            return;
        }
        const button = this.dialog.querySelector(write ? '#listenbrainz-write' : '#listenbrainz-preview') as any;
        try {
            button.loading = true;
            this.setStatus(t(write ? 'libraryTools.creating' : 'libraryTools.previewing'), 'primary');
            const result = await localListenBrainzImport({ username, kind, write });
            const writeButton = this.dialog.querySelector('#listenbrainz-write') as any;
            if (writeButton) writeButton.disabled = write || result.matchedCount === 0;
            this.renderListenBrainzResult(result);
            this.setStatus(
                write
                    ? t('libraryTools.created', { path: result.playlistRelativePath ?? '' })
                    : t('libraryTools.listenbrainz.previewReady', {
                        matched: result.matchedCount,
                        total: result.recommendationCount,
                    }),
                result.matchedCount ? 'success' : 'warning',
            );
        } catch (error) {
            this.showError(error);
        } finally {
            button.loading = false;
        }
    }

    private renderPlaylistResult(selector: string, result: PlaylistToolResult): void {
        const target = this.dialog?.querySelector(selector) as HTMLElement | null;
        if (!target) return;
        target.innerHTML = `
            <h3>${this.escape(result.title)} · ${result.trackCount}</h3>
            <ol>${result.tracks.slice(0, 100).map(track => `<li><strong>${this.escape(track.title)}</strong> — ${this.escape(track.artist)}</li>`).join('')}</ol>
        `;
    }

    private renderListenBrainzResult(result: ListenBrainzImportResult): void {
        const target = this.dialog?.querySelector('#listenbrainz-results') as HTMLElement | null;
        if (!target) return;
        target.innerHTML = `
            <div class="library-tools-badges">
                <sl-badge variant="success">${t('libraryTools.listenbrainz.matched')}: ${result.matchedCount}</sl-badge>
                <sl-badge variant="neutral">${t('libraryTools.listenbrainz.unavailable')}: ${result.unavailableCount}</sl-badge>
                <sl-badge variant="warning">${t('libraryTools.listenbrainz.ambiguous')}: ${result.ambiguousCount}</sl-badge>
                <sl-badge variant="neutral">${t('libraryTools.listenbrainz.duplicates')}: ${result.duplicateCount}</sl-badge>
            </div>
            <ol>${result.matched.slice(0, 100).map(item => `<li><strong>${this.escape(item.recommendation.title)}</strong> — ${this.escape(item.recommendation.artist)} <small>(${this.escape(item.matchMethod)})</small></li>`).join('')}</ol>
            ${result.unavailable.length ? `<details><summary>${t('libraryTools.listenbrainz.unavailableDetails')}</summary><ul>${result.unavailable.slice(0, 100).map(item => `<li>${this.escape(item.title)} — ${this.escape(item.artist)}</li>`).join('')}</ul></details>` : ''}
        `;
    }

    private setStatus(message: string, variant: 'primary' | 'success' | 'warning' | 'danger'): void {
        const status = this.dialog?.querySelector('#library-tools-status') as any;
        if (!status) return;
        status.variant = variant;
        status.textContent = message;
        status.open = true;
    }

    private showError(error: unknown): void {
        this.setStatus(
            t('libraryTools.error', { message: error instanceof Error ? error.message : String(error) }),
            'danger',
        );
    }

    private issueLabel(issue: string): string {
        return issue.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase());
    }

    private escape(value: unknown): string {
        const element = document.createElement('span');
        element.textContent = String(value ?? '');
        return element.innerHTML;
    }
}
