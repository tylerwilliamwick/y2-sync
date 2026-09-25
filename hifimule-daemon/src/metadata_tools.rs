use crate::providers::local::{LocalFolderProvider, LocalMetadataAuditTrack};
use anyhow::{Context, Result, bail};
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{Picture, PictureType};
use lofty::tag::{Accessor, ItemKey, Tag, TagExt};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fs::{File, OpenOptions};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

const MUSICBRAINZ_BASE: &str = "https://musicbrainz.org/ws/2/";
const COVER_ART_BASE: &str = "https://coverartarchive.org/";
const USER_AGENT: &str = concat!(
    "Y2-Sync/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/tylerwilliamwick/y2-sync)"
);
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARTWORK_BYTES: usize = 8 * 1024 * 1024;
const MAX_CANDIDATES: usize = 5;

static MUSICBRAINZ_LAST_REQUEST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
static METADATA_WRITE_GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataCandidate {
    pub candidate_id: String,
    pub score: u32,
    pub recording_mbid: String,
    pub title: String,
    pub artist: String,
    pub artist_mbid: Option<String>,
    pub album: String,
    pub release_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub genre: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover_art_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataLookupResult {
    pub track: LocalMetadataAuditTrack,
    pub candidates: Vec<MetadataCandidate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MetadataPatch {
    pub title: String,
    pub artist: String,
    pub album: String,
    // The UI sends these keys explicitly. `null` (or an empty MBID) means
    // clear the corresponding tag; this prevents stale optional values from
    // surviving a reviewed replacement.
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub recording_mbid: String,
    pub artist_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
    #[serde(default)]
    pub include_artwork: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataWriteResult {
    pub track: LocalMetadataAuditTrack,
    pub backup_relative_path: String,
    pub artwork_written: bool,
}

#[derive(Debug, Deserialize)]
struct MbSearchResponse {
    #[serde(default)]
    recordings: Vec<MbRecording>,
}

#[derive(Debug, Deserialize)]
struct MbRecording {
    id: String,
    #[serde(default)]
    score: u32,
    title: String,
    length: Option<u64>,
    #[serde(rename = "first-release-date")]
    first_release_date: Option<String>,
    #[serde(rename = "artist-credit", default)]
    artist_credit: Vec<MbArtistCredit>,
    #[serde(default)]
    releases: Vec<MbRelease>,
    #[serde(default)]
    genres: Vec<MbGenre>,
    #[serde(default)]
    tags: Vec<MbGenre>,
}

#[derive(Debug, Deserialize)]
struct MbArtistCredit {
    name: String,
    #[serde(default)]
    joinphrase: String,
    artist: MbArtist,
}

#[derive(Debug, Deserialize)]
struct MbArtist {
    id: String,
}

#[derive(Debug, Deserialize)]
struct MbGenre {
    name: String,
    #[serde(default)]
    count: i32,
}

#[derive(Debug, Deserialize)]
struct MbRelease {
    id: String,
    title: String,
    status: Option<String>,
    date: Option<String>,
    #[serde(rename = "release-group")]
    release_group: Option<MbReleaseGroup>,
    #[serde(default)]
    media: Vec<MbMedium>,
}

#[derive(Debug, Deserialize)]
struct MbReleaseGroup {
    id: String,
}

#[derive(Debug, Deserialize)]
struct MbMedium {
    position: Option<u32>,
    #[serde(default)]
    tracks: Vec<MbTrack>,
}

#[derive(Debug, Deserialize)]
struct MbTrack {
    position: Option<u32>,
    number: Option<String>,
    recording: Option<MbTrackRecording>,
}

#[derive(Debug, Deserialize)]
struct MbTrackRecording {
    id: String,
}

pub(crate) async fn lookup_musicbrainz(
    track: LocalMetadataAuditTrack,
) -> Result<MetadataLookupResult> {
    lookup_musicbrainz_at(track, MUSICBRAINZ_BASE, true).await
}

async fn lookup_musicbrainz_at(
    track: LocalMetadataAuditTrack,
    base_url: &str,
    rate_limit: bool,
) -> Result<MetadataLookupResult> {
    if rate_limit {
        wait_for_musicbrainz_slot().await;
    }
    let client = metadata_http_client()?;
    let mut query = format!(
        "recording:\"{}\" AND artist:\"{}\"",
        mb_query_value(&track.title),
        mb_query_value(&track.artist)
    );
    if !track.album.trim().is_empty() && track.album != "Unknown Album" {
        query.push_str(&format!(
            " AND release:\"{}\"",
            mb_query_value(&track.album)
        ));
    }
    let endpoint = reqwest::Url::parse(base_url)
        .context("MusicBrainz endpoint is invalid")?
        .join("recording/")
        .context("MusicBrainz endpoint is invalid")?;
    let response = client
        .get(endpoint)
        .query(&[
            ("query", query),
            ("fmt", "json".to_string()),
            ("limit", "10".to_string()),
        ])
        .send()
        .await
        .context("MusicBrainz lookup failed")?;
    let status = response.status();
    if !status.is_success() {
        bail!("MusicBrainz lookup returned HTTP {}", status.as_u16());
    }
    let response: MbSearchResponse = bounded_json(response, MAX_JSON_BYTES).await?;
    let candidates = response
        .recordings
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|recording| candidate_from_recording(recording, &track.album))
        .collect();
    Ok(MetadataLookupResult { track, candidates })
}

fn candidate_from_recording(recording: MbRecording, current_album: &str) -> MetadataCandidate {
    let release_index = recording
        .releases
        .iter()
        .enumerate()
        .max_by_key(|(_, release)| {
            (
                crate::library_tools::normalized_match_key(&release.title)
                    == crate::library_tools::normalized_match_key(current_album),
                release.status.as_deref() == Some("Official"),
                release.date.is_some(),
            )
        })
        .map(|(index, _)| index);
    let release = release_index.and_then(|index| recording.releases.get(index));
    let (track_number, disc_number) = release
        .and_then(|release| {
            release.media.iter().find_map(|medium| {
                medium
                    .tracks
                    .iter()
                    .find(|track| {
                        track
                            .recording
                            .as_ref()
                            .is_some_and(|item| item.id == recording.id)
                    })
                    .map(|track| {
                        (
                            track
                                .position
                                .or_else(|| track.number.as_deref().and_then(parse_leading_number)),
                            medium.position,
                        )
                    })
            })
        })
        .unwrap_or((None, None));
    let artist = recording
        .artist_credit
        .iter()
        .map(|credit| format!("{}{}", credit.name, credit.joinphrase))
        .collect::<String>()
        .trim()
        .to_string();
    let artist_mbid = recording
        .artist_credit
        .first()
        .map(|credit| credit.artist.id.clone());
    let year = release
        .and_then(|release| release.date.as_deref())
        .or(recording.first_release_date.as_deref())
        .and_then(parse_year);
    let mut genres = recording.genres;
    genres.extend(recording.tags);
    genres.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    let genre = genres
        .into_iter()
        .map(|genre| genre.name)
        .find(|genre| !genre.trim().is_empty());
    let release_mbid = release.map(|release| release.id.clone());
    let release_group_mbid =
        release.and_then(|release| release.release_group.as_ref().map(|group| group.id.clone()));
    MetadataCandidate {
        candidate_id: format!(
            "{}:{}",
            recording.id,
            release_mbid.as_deref().unwrap_or("recording")
        ),
        score: recording.score,
        recording_mbid: recording.id,
        title: recording.title,
        artist,
        artist_mbid,
        album: release.map_or_else(
            || current_album.to_string(),
            |release| release.title.clone(),
        ),
        release_mbid: release_mbid.clone(),
        release_group_mbid,
        year,
        track_number,
        disc_number,
        genre,
        duration_ms: recording.length,
        cover_art_url: release_mbid
            .map(|id| format!("https://coverartarchive.org/release/{id}/front-500")),
    }
}

pub(crate) async fn apply_metadata(
    library_url: String,
    song_id: String,
    expected_version: String,
    patch: MetadataPatch,
) -> Result<MetadataWriteResult> {
    validate_patch(&patch)?;
    let artwork = if patch.include_artwork {
        let release = patch
            .release_mbid
            .as_deref()
            .context("A MusicBrainz release is required for artwork")?;
        Some(fetch_cover_art(release).await?)
    } else {
        None
    };
    let gate = METADATA_WRITE_GATE.get_or_init(|| tokio::sync::Mutex::new(()));
    let _write_guard = gate.lock().await;
    tokio::task::spawn_blocking(move || {
        apply_metadata_blocking(&library_url, &song_id, &expected_version, &patch, artwork)
    })
    .await
    .context("Metadata write task failed")?
}

fn apply_metadata_blocking(
    library_url: &str,
    song_id: &str,
    expected_version: &str,
    patch: &MetadataPatch,
    artwork: Option<Vec<u8>>,
) -> Result<MetadataWriteResult> {
    let provider = LocalFolderProvider::from_file_url(library_url)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let target = provider
        .tag_target(song_id, expected_version)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let parent = target.path.parent().context("Track has no parent folder")?;
    let temp = sibling_work_path(&target.path, "tmp")?;
    let backup = sibling_work_path(&target.path, "backup")?;
    let failed = sibling_work_path(&target.path, "failed")?;
    let mut source = open_source_no_follow(&target.path)?;
    let before = source
        .metadata()
        .context("Failed to inspect the source track")?;
    if !before.is_file() {
        bail!("The reviewed track is no longer a regular file");
    }
    #[cfg(unix)]
    if std::os::unix::fs::MetadataExt::nlink(&before) != 1 {
        bail!("Metadata writes are disabled for hard-linked tracks");
    }
    let mut destination = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .context("Failed to create the temporary track")?;
    let result = (|| -> Result<()> {
        std::io::copy(&mut source, &mut destination)
            .context("Failed to copy the track for safe editing")?;
        destination
            .sync_all()
            .context("Failed to flush the temporary track")?;
        let after = source
            .metadata()
            .context("Failed to recheck the source track")?;
        if !same_file_snapshot(&before, &after) {
            bail!("The track changed while it was being prepared; review it again");
        }
        apply_patch_to_file(&temp, patch, artwork.as_deref())?;
        verify_patch(&temp, patch, artwork.is_some())?;
        Ok(())
    })();
    drop(destination);
    drop(source);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }

    // Re-scan immediately before publishing so stale reviews cannot overwrite a
    // track changed between the initial audit and the safe-copy phase.
    let fresh = LocalFolderProvider::from_file_url(library_url)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if fresh.tag_target(song_id, expected_version).is_err() {
        let _ = std::fs::remove_file(&temp);
        bail!("The track changed after review; no tags were written");
    }
    std::fs::rename(&target.path, &backup).context("Failed to create the metadata backup")?;
    if let Err(error) = std::fs::rename(&temp, &target.path) {
        let _ = std::fs::rename(&backup, &target.path);
        let _ = std::fs::remove_file(&temp);
        return Err(error).context("Failed to publish the tagged track");
    }
    if let Err(error) =
        sync_directory(parent).and_then(|_| verify_patch(&target.path, patch, artwork.is_some()))
    {
        let _ = std::fs::rename(&target.path, &failed);
        let _ = std::fs::rename(&backup, &target.path);
        let _ = sync_directory(parent);
        return Err(error).context("Published tag verification failed; the original was restored");
    }
    let refreshed = LocalFolderProvider::from_file_url(library_url)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let track = refreshed
        .metadata_audit(0, 500, false)
        .tracks
        .into_iter()
        .find(|track| track.song_id == song_id)
        .context("Tagged track was not found after refresh")?;
    let backup_relative_path = backup
        .strip_prefix(refreshed.root_path())
        .ok()
        .and_then(Path::to_str)
        .context("Backup path is outside the local library")?
        .replace('\\', "/");
    Ok(MetadataWriteResult {
        track,
        backup_relative_path,
        artwork_written: artwork.is_some(),
    })
}

fn apply_patch_to_file(path: &Path, patch: &MetadataPatch, artwork: Option<&[u8]>) -> Result<()> {
    let mut tagged = lofty::read_from_path(path).context("This audio format cannot be tagged")?;
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tagged.primary_tag_type()));
    }
    let tag = tagged
        .primary_tag_mut()
        .context("This audio format has no writable primary tag")?;
    apply_patch_to_tag(tag, patch);
    if let Some(bytes) = artwork {
        let mut picture = Picture::from_reader(&mut Cursor::new(bytes))
            .context("Downloaded artwork is not a supported image")?;
        picture.set_pic_type(PictureType::CoverFront);
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(picture);
    }
    tag.save_to_path(path, WriteOptions::default())
        .context("Failed to save tags to the temporary track")?;
    File::open(path)
        .and_then(|file| file.sync_all())
        .context("Failed to flush the tagged track")?;
    Ok(())
}

fn apply_patch_to_tag(tag: &mut Tag, patch: &MetadataPatch) {
    tag.set_title(patch.title.clone());
    tag.set_artist(patch.artist.clone());
    tag.set_album(patch.album.clone());
    match non_empty(patch.genre.as_ref()) {
        Some(value) => tag.set_genre(value.to_string()),
        None => tag.remove_genre(),
    }
    match patch.track_number {
        Some(value) => tag.set_track(value),
        None => tag.remove_track(),
    }
    match patch.disc_number {
        Some(value) => tag.set_disk(value),
        None => tag.remove_disk(),
    }
    match patch.year {
        Some(value) => {
            tag.insert_text(ItemKey::RecordingDate, value.to_string());
        }
        None => tag.remove_date(),
    }
    replace_optional_text(
        tag,
        ItemKey::MusicBrainzRecordingId,
        non_empty(Some(&patch.recording_mbid)),
    );
    replace_optional_text(
        tag,
        ItemKey::MusicBrainzArtistId,
        non_empty(patch.artist_mbid.as_ref()),
    );
    replace_optional_text(
        tag,
        ItemKey::MusicBrainzReleaseId,
        non_empty(patch.release_mbid.as_ref()),
    );
    replace_optional_text(
        tag,
        ItemKey::MusicBrainzReleaseGroupId,
        non_empty(patch.release_group_mbid.as_ref()),
    );
}

fn non_empty(value: Option<&String>) -> Option<&str> {
    value
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn replace_optional_text(tag: &mut Tag, key: ItemKey, value: Option<&str>) {
    match value {
        Some(value) => {
            tag.insert_text(key, value.to_string());
        }
        None => tag.remove_key(key),
    };
}

fn verify_patch(path: &Path, patch: &MetadataPatch, artwork: bool) -> Result<()> {
    let tagged = lofty::read_from_path(path).context("Failed to re-read written tags")?;
    let tag = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        .context("Written tag is missing")?;
    verify_tag(tag, patch)?;
    if artwork
        && !tag
            .pictures()
            .iter()
            .any(|picture| picture.pic_type() == PictureType::CoverFront)
    {
        bail!("Written cover artwork could not be verified");
    }
    Ok(())
}

fn verify_tag(tag: &Tag, patch: &MetadataPatch) -> Result<()> {
    let recording_mbid = non_empty(Some(&patch.recording_mbid));
    if tag.title().as_deref() != Some(patch.title.as_str())
        || tag.artist().as_deref() != Some(patch.artist.as_str())
        || tag.album().as_deref() != Some(patch.album.as_str())
        || !optional_tag_matches(tag, ItemKey::MusicBrainzRecordingId, recording_mbid)
    {
        bail!("Written tags did not match the reviewed values");
    }
    let year = tag.date().map(|date| u32::from(date.year));
    if tag.genre().as_deref() != non_empty(patch.genre.as_ref())
        || tag.track() != patch.track_number
        || tag.disk() != patch.disc_number
        || year != patch.year
        || !optional_tag_matches(
            tag,
            ItemKey::MusicBrainzArtistId,
            non_empty(patch.artist_mbid.as_ref()),
        )
        || !optional_tag_matches(
            tag,
            ItemKey::MusicBrainzReleaseId,
            non_empty(patch.release_mbid.as_ref()),
        )
        || !optional_tag_matches(
            tag,
            ItemKey::MusicBrainzReleaseGroupId,
            non_empty(patch.release_group_mbid.as_ref()),
        )
    {
        bail!("Written extended tags did not match the reviewed values");
    }
    Ok(())
}

fn optional_tag_matches(tag: &Tag, key: ItemKey, expected: Option<&str>) -> bool {
    tag.get_string(key).as_deref() == expected
}

async fn fetch_cover_art(release_mbid: &str) -> Result<Vec<u8>> {
    validate_uuid("releaseMbid", release_mbid)?;
    let base = reqwest::Url::parse(COVER_ART_BASE)?;
    let endpoint = base.join(&format!("release/{release_mbid}/front-500"))?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 {
                return attempt.stop();
            }
            let allowed = attempt.url().host_str().is_some_and(is_cover_art_host);
            if allowed {
                attempt.follow()
            } else {
                attempt.error("cover art redirect left the approved hosts")
            }
        }))
        .build()?;
    let response = client
        .get(endpoint)
        .send()
        .await
        .context("Cover artwork lookup failed")?;
    if !response.status().is_success() {
        bail!(
            "Cover Art Archive returned HTTP {}",
            response.status().as_u16()
        );
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("image/") {
        bail!("Cover Art Archive returned a non-image response");
    }
    bounded_bytes(response, MAX_ARTWORK_BYTES).await
}

fn is_cover_art_host(host: &str) -> bool {
    host == "coverartarchive.org"
        || host.ends_with(".coverartarchive.org")
        || host == "archive.org"
        || host.ends_with(".archive.org")
}

fn metadata_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("Failed to initialize the metadata client")
}

async fn wait_for_musicbrainz_slot() {
    let gate = MUSICBRAINZ_LAST_REQUEST.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut last = gate.lock().await;
    if let Some(previous) = *last {
        let elapsed = previous.elapsed();
        if elapsed < Duration::from_secs(1) {
            tokio::time::sleep(Duration::from_secs(1) - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

async fn bounded_json<T: DeserializeOwned>(response: reqwest::Response, limit: usize) -> Result<T> {
    let body = bounded_bytes(response, limit).await?;
    serde_json::from_slice(&body).context("Metadata service returned invalid JSON")
}

async fn bounded_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        bail!("Remote response exceeded the configured size limit");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Failed to read remote response")?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            bail!("Remote response exceeded the configured size limit");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_patch(patch: &MetadataPatch) -> Result<()> {
    validate_text("title", &patch.title, 300)?;
    validate_text("artist", &patch.artist, 300)?;
    validate_text("album", &patch.album, 300)?;
    if let Some(value) = non_empty(patch.genre.as_ref()) {
        validate_text("genre", value, 150)?;
    }
    if patch
        .year
        .is_some_and(|year| !(1000..=3000).contains(&year))
    {
        bail!("year must be between 1000 and 3000");
    }
    if patch
        .track_number
        .is_some_and(|value| value == 0 || value > 10_000)
        || patch
            .disc_number
            .is_some_and(|value| value == 0 || value > 1_000)
    {
        bail!("track and disc numbers must be positive and bounded");
    }
    if let Some(value) = non_empty(Some(&patch.recording_mbid)) {
        validate_uuid("recordingMbid", value)?;
    }
    for (name, value) in [
        ("artistMbid", patch.artist_mbid.as_deref()),
        ("releaseMbid", patch.release_mbid.as_deref()),
        ("releaseGroupMbid", patch.release_group_mbid.as_deref()),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            validate_uuid(name, value)?;
        }
    }
    Ok(())
}

fn validate_text(name: &str, value: &str, max_chars: usize) -> Result<()> {
    let length = value.chars().count();
    if value.trim().is_empty() || length > max_chars || value.chars().any(char::is_control) {
        bail!("{name} is empty, too long, or contains control characters");
    }
    Ok(())
}

fn validate_uuid(name: &str, value: &str) -> Result<()> {
    uuid::Uuid::parse_str(value)
        .with_context(|| format!("{name} is not a valid MusicBrainz identifier"))?;
    Ok(())
}

fn mb_query_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .flat_map(|character| match character {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            other => vec![other],
        })
        .take(300)
        .collect()
}

fn parse_year(value: &str) -> Option<u32> {
    value.get(..4)?.parse().ok()
}

fn parse_leading_number(value: &str) -> Option<u32> {
    let number: String = value.chars().take_while(char::is_ascii_digit).collect();
    (!number.is_empty()).then(|| number.parse().ok()).flatten()
}

fn sibling_work_path(path: &Path, purpose: &str) -> Result<PathBuf> {
    let parent = path.parent().context("Track has no parent folder")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("Track filename is not valid UTF-8")?;
    Ok(parent.join(format!(".y2sync-{purpose}-{}-{name}", uuid::Uuid::new_v4())))
}

fn open_source_no_follow(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .context("Failed to safely open the reviewed track")
}

fn same_file_snapshot(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    if before.len() != after.len() || modified(before) != modified(after) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev() && before.ino() == after.ino()
    }
    #[cfg(not(unix))]
    true
}

fn modified(metadata: &std::fs::Metadata) -> Option<SystemTime> {
    metadata.modified().ok()
}

fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .context("Failed to flush the track directory")?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::TagType;

    fn audit_fixture(root: &Path) -> LocalMetadataAuditTrack {
        let provider = LocalFolderProvider::from_root(root).unwrap();
        provider.metadata_audit(0, 10, false).tracks.remove(0)
    }

    fn copy_flac_fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let artist = root.path().join("Artist").join("Album");
        std::fs::create_dir_all(&artist).unwrap();
        std::fs::copy(
            "tests/fixtures/generated-seek-flac.flac",
            artist.join("Track.flac"),
        )
        .unwrap();
        root
    }

    fn patch() -> MetadataPatch {
        MetadataPatch {
            title: "Reviewed Title".into(),
            artist: "Reviewed Artist".into(),
            album: "Reviewed Album".into(),
            genre: Some("Electronic".into()),
            year: Some(2024),
            track_number: Some(2),
            disc_number: Some(1),
            recording_mbid: "0f47fe74-0417-4f14-8f8e-8d7d2dfe8f1c".into(),
            artist_mbid: Some("87fa1f95-35b1-486f-8327-1439c3e90e1a".into()),
            release_mbid: Some("5d63d4d5-56e7-4f76-9894-f8d2b4b331bc".into()),
            release_group_mbid: Some("9f32b6e4-f29d-43c7-9734-3a835a25fa36".into()),
            include_artwork: false,
        }
    }

    #[test]
    fn metadata_patch_clears_stale_optional_tags_and_verifies_them() {
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title("Updated title".to_string());
        tag.set_artist("Updated artist".to_string());
        tag.set_album("Updated album".to_string());
        tag.set_genre("Old genre".to_string());
        tag.set_track(7);
        tag.set_disk(2);
        tag.insert_text(ItemKey::RecordingDate, "2001".to_string());
        tag.insert_text(
            ItemKey::MusicBrainzRecordingId,
            "00000000-0000-0000-0000-000000000001".to_string(),
        );
        tag.insert_text(
            ItemKey::MusicBrainzArtistId,
            "00000000-0000-0000-0000-000000000002".to_string(),
        );
        tag.insert_text(
            ItemKey::MusicBrainzReleaseId,
            "00000000-0000-0000-0000-000000000003".to_string(),
        );
        tag.insert_text(
            ItemKey::MusicBrainzReleaseGroupId,
            "00000000-0000-0000-0000-000000000004".to_string(),
        );

        let patch = MetadataPatch {
            title: "Updated title".to_string(),
            artist: "Updated artist".to_string(),
            album: "Updated album".to_string(),
            genre: None,
            year: None,
            track_number: None,
            disc_number: None,
            recording_mbid: String::new(),
            artist_mbid: None,
            release_mbid: None,
            release_group_mbid: None,
            include_artwork: false,
        };

        apply_patch_to_tag(&mut tag, &patch);

        verify_tag(&tag, &patch).unwrap();
        assert!(tag.genre().is_none());
        assert!(tag.track().is_none());
        assert!(tag.disk().is_none());
        assert!(tag.date().is_none());
        assert!(tag.get_string(ItemKey::MusicBrainzRecordingId).is_none());
        assert!(tag.get_string(ItemKey::MusicBrainzArtistId).is_none());
        assert!(tag.get_string(ItemKey::MusicBrainzReleaseId).is_none());
        assert!(tag.get_string(ItemKey::MusicBrainzReleaseGroupId).is_none());
    }

    #[test]
    fn metadata_write_is_reviewed_verified_and_backed_up() {
        let root = copy_flac_fixture();
        let track = audit_fixture(root.path());
        let url = reqwest::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let result =
            apply_metadata_blocking(&url, &track.song_id, &track.version, &patch(), None).unwrap();
        assert_eq!(result.track.title, "Reviewed Title");
        assert!(root.path().join(result.backup_relative_path).is_file());
        assert_eq!(
            LocalFolderProvider::from_root(root.path())
                .unwrap()
                .song_count(),
            1
        );
    }

    #[test]
    fn metadata_write_rejects_a_stale_review() {
        let root = copy_flac_fixture();
        let track = audit_fixture(root.path());
        let url = reqwest::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let error =
            apply_metadata_blocking(&url, &track.song_id, "stale", &patch(), None).unwrap_err();
        assert!(error.to_string().contains("changed"));
    }

    #[cfg(unix)]
    #[test]
    fn metadata_write_rejects_hard_links() {
        let root = copy_flac_fixture();
        let track = audit_fixture(root.path());
        let source = root.path().join(&track.relative_path);
        std::fs::hard_link(&source, root.path().join("linked.flac")).unwrap();
        let url = reqwest::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        let error = apply_metadata_blocking(&url, &track.song_id, &track.version, &patch(), None)
            .unwrap_err();
        assert!(error.to_string().contains("hard-linked"));
    }

    #[tokio::test]
    async fn lookup_maps_musicbrainz_candidates() {
        let mut server = mockito::Server::new_async().await;
        let body = serde_json::json!({
            "recordings": [{
                "id": "0f47fe74-0417-4f14-8f8e-8d7d2dfe8f1c",
                "score": 99,
                "title": "Jóga",
                "length": 312000,
                "artist-credit": [{"name": "Björk", "artist": {"id": "87fa1f95-35b1-486f-8327-1439c3e90e1a"}}],
                "releases": [{"id": "5d63d4d5-56e7-4f76-9894-f8d2b4b331bc", "title": "Homogenic", "status": "Official", "date": "1997-09-22", "release-group": {"id": "9f32b6e4-f29d-43c7-9734-3a835a25fa36"}}]
            }]
        });
        let request = server
            .mock("GET", "/recording/")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_body(body.to_string())
            .create_async()
            .await;
        let track = LocalMetadataAuditTrack {
            song_id: "song".into(),
            relative_path: "Artist/Homogenic/Jóga.flac".into(),
            version: "version".into(),
            title: "Jóga".into(),
            artist: "Björk".into(),
            album: "Homogenic".into(),
            genre: None,
            year: None,
            track_number: None,
            disc_number: None,
            duration_seconds: 312,
            recording_mbid: None,
            has_embedded_artwork: false,
            issues: vec![],
        };
        let result = lookup_musicbrainz_at(track, &format!("{}/", server.url()), false)
            .await
            .unwrap();
        assert_eq!(result.candidates[0].album, "Homogenic");
        assert_eq!(result.candidates[0].year, Some(1997));
        request.assert_async().await;
    }
}
