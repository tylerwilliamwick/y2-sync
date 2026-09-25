use crate::providers::ProviderError;
use crate::providers::local::{LocalFolderProvider, LocalPlaylistTrack};
use anyhow::{Context, Result};
use chrono::{Datelike, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Component, Path};
use std::sync::{Mutex, OnceLock};

const MAX_PLAYLIST_TRACKS: usize = 500;
const DEFAULT_DISCOVERY_TRACKS: usize = 50;
const DEFAULT_WEEKLY_TRACKS: usize = 50;
const DEFAULT_DAILY_TRACKS: usize = 25;
static PLAYLIST_WRITE_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalMixKind {
    Discovery,
    Weekly,
    Daily,
}

impl LocalMixKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "discovery" => Some(Self::Discovery),
            "weekly" => Some(Self::Weekly),
            "daily" => Some(Self::Daily),
            _ => None,
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::Weekly => "weekly",
            Self::Daily => "daily",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Discovery => "Y2 Discovery",
            Self::Weekly => "Y2 Weekly Mix",
            Self::Daily => "Y2 Daily Mix",
        }
    }

    fn default_limit(self) -> usize {
        match self {
            Self::Discovery => DEFAULT_DISCOVERY_TRACKS,
            Self::Weekly => DEFAULT_WEEKLY_TRACKS,
            Self::Daily => DEFAULT_DAILY_TRACKS,
        }
    }

    fn period_seed(self) -> String {
        let now = Utc::now().date_naive();
        match self {
            Self::Daily => format!("{}:{now}", self.slug()),
            Self::Discovery | Self::Weekly => {
                let week = now.iso_week();
                format!("{}:{}-W{:02}", self.slug(), week.year(), week.week())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistPreviewTrack {
    pub song_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistBuildResult {
    pub title: String,
    pub seed: String,
    pub track_count: usize,
    pub playlist_relative_path: Option<String>,
    pub backup_relative_path: Option<String>,
    pub skipped_unsafe_paths: usize,
    pub tracks: Vec<PlaylistPreviewTrack>,
}

pub(crate) fn build_local_mix(
    provider: &LocalFolderProvider,
    kind: LocalMixKind,
    requested_limit: Option<usize>,
    write: bool,
) -> Result<PlaylistBuildResult> {
    let limit = requested_limit
        .unwrap_or_else(|| kind.default_limit())
        .clamp(1, MAX_PLAYLIST_TRACKS);
    let seed = kind.period_seed();
    let (selected, skipped_unsafe_paths) =
        select_local_mix(provider.playlist_tracks(), kind, &seed, limit);
    if selected.is_empty() {
        return Err(anyhow::anyhow!(
            "No safe local tracks are available for this mix"
        ));
    }
    let tracks = selected
        .iter()
        .map(|track| PlaylistPreviewTrack {
            song_id: track.song_id.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            relative_path: portable_relative_path(&track.relative_path).unwrap_or_default(),
        })
        .collect();
    let (playlist_relative_path, backup_relative_path) = if write {
        let written = write_relative_m3u(provider.root_path(), kind.title(), &seed, &selected)?;
        (Some(written.0), written.1)
    } else {
        (None, None)
    };
    Ok(PlaylistBuildResult {
        title: kind.title().to_string(),
        seed,
        track_count: selected.len(),
        playlist_relative_path,
        backup_relative_path,
        skipped_unsafe_paths,
        tracks,
    })
}

pub(crate) fn write_imported_playlist(
    provider: &LocalFolderProvider,
    title: &str,
    seed: &str,
    tracks: &[LocalPlaylistTrack],
) -> Result<(String, Option<String>)> {
    if tracks.is_empty() {
        return Err(anyhow::anyhow!(
            "No locally owned recommendations are available for this playlist"
        ));
    }
    if tracks.len() > MAX_PLAYLIST_TRACKS {
        return Err(anyhow::anyhow!("Imported playlist exceeds the track limit"));
    }
    write_relative_m3u(provider.root_path(), title, seed, tracks)
}

fn select_local_mix(
    tracks: Vec<LocalPlaylistTrack>,
    kind: LocalMixKind,
    seed: &str,
    limit: usize,
) -> (Vec<LocalPlaylistTrack>, usize) {
    let mut skipped_unsafe_paths = 0usize;
    let mut safe_tracks: Vec<_> = tracks
        .into_iter()
        .filter(|track| {
            let safe = portable_relative_path(&track.relative_path).is_some();
            if !safe {
                skipped_unsafe_paths = skipped_unsafe_paths.saturating_add(1);
            }
            safe
        })
        .collect();
    let artist_counts = frequency(&safe_tracks, |track| normalized_match_key(&track.artist));
    let genre_counts = frequency(&safe_tracks, |track| {
        normalized_match_key(track.genre.as_deref().unwrap_or(""))
    });
    safe_tracks.sort_by(|left, right| {
        let hash_order = seeded_rank(seed, &left.song_id).cmp(&seeded_rank(seed, &right.song_id));
        if kind != LocalMixKind::Discovery {
            return hash_order.then_with(|| left.song_id.cmp(&right.song_id));
        }
        let left_artist = artist_counts
            .get(&normalized_match_key(&left.artist))
            .copied()
            .unwrap_or(usize::MAX);
        let right_artist = artist_counts
            .get(&normalized_match_key(&right.artist))
            .copied()
            .unwrap_or(usize::MAX);
        let left_genre = genre_counts
            .get(&normalized_match_key(left.genre.as_deref().unwrap_or("")))
            .copied()
            .unwrap_or(usize::MAX);
        let right_genre = genre_counts
            .get(&normalized_match_key(right.genre.as_deref().unwrap_or("")))
            .copied()
            .unwrap_or(usize::MAX);
        (left_genre, left_artist)
            .cmp(&(right_genre, right_artist))
            .then(hash_order)
            .then_with(|| left.song_id.cmp(&right.song_id))
    });

    let per_artist_cap = match kind {
        LocalMixKind::Discovery => 2,
        LocalMixKind::Weekly => 3,
        LocalMixKind::Daily => 2,
    };
    let mut selected = Vec::with_capacity(limit.min(safe_tracks.len()));
    let mut selected_ids = HashSet::new();
    let mut artist_selected = HashMap::<String, usize>::new();
    for track in &safe_tracks {
        if selected.len() >= limit {
            break;
        }
        let artist_key = normalized_match_key(&track.artist);
        let count = artist_selected.get(&artist_key).copied().unwrap_or(0);
        if count >= per_artist_cap {
            continue;
        }
        artist_selected.insert(artist_key, count + 1);
        selected_ids.insert(track.song_id.clone());
        selected.push(track.clone());
    }
    // A small or single-artist library should still produce the requested size.
    for track in safe_tracks {
        if selected.len() >= limit {
            break;
        }
        if selected_ids.insert(track.song_id.clone()) {
            selected.push(track);
        }
    }
    (selected, skipped_unsafe_paths)
}

fn frequency<F>(tracks: &[LocalPlaylistTrack], key: F) -> HashMap<String, usize>
where
    F: Fn(&LocalPlaylistTrack) -> String,
{
    let mut counts = HashMap::new();
    for track in tracks {
        *counts.entry(key(track)).or_insert(0) += 1;
    }
    counts
}

fn seeded_rank(seed: &str, id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update([0]);
    hasher.update(id.as_bytes());
    hasher.finalize().into()
}

pub(crate) fn normalized_match_key(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn portable_relative_path(relative: &str) -> Option<String> {
    if relative.contains(['\r', '\n', '\0']) {
        return None;
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return None;
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => components.push(value.to_str()?.to_string()),
            _ => return None,
        }
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn playlist_text(title: &str, seed: &str, tracks: &[LocalPlaylistTrack]) -> Result<String> {
    let mut output = String::from("#EXTM3U\n");
    writeln!(output, "#PLAYLIST:{}", single_line(title))?;
    writeln!(output, "#Y2SYNC-SEED:{}", single_line(seed))?;
    for track in tracks {
        let relative = portable_relative_path(&track.relative_path)
            .context("A selected track has an unsafe relative path")?;
        writeln!(
            output,
            "#EXTINF:{},{} - {}",
            track.duration_seconds,
            single_line(&track.artist),
            single_line(&track.title)
        )?;
        writeln!(output, "../{relative}")?;
    }
    Ok(output)
}

fn single_line(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character == '\r' || character == '\n' || character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn write_relative_m3u(
    root: &Path,
    title: &str,
    seed: &str,
    tracks: &[LocalPlaylistTrack],
) -> Result<(String, Option<String>)> {
    let _write_guard = PLAYLIST_WRITE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow::anyhow!("Playlist write lock is unavailable"))?;
    let playlist_dir = root.join("Playlists");
    ensure_safe_directory(root, &playlist_dir)?;
    let filename = format!("{title}.m3u8");
    let target = playlist_dir.join(&filename);
    let temp_name = format!(".{filename}.y2sync-tmp-{}", uuid::Uuid::new_v4());
    let temp = playlist_dir.join(temp_name);
    let content = playlist_text(title, seed, tracks)?;
    let mut temp_file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .context("Failed to create a temporary playlist")?;
    if let Err(error) = (|| -> Result<()> {
        temp_file
            .write_all(content.as_bytes())
            .context("Failed to write the temporary playlist")?;
        temp_file
            .sync_all()
            .context("Failed to flush the temporary playlist")?;
        Ok(())
    })() {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    drop(temp_file);

    let backup = if target.exists() {
        let metadata = std::fs::symlink_metadata(&target)
            .context("Failed to inspect the existing playlist")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            let _ = std::fs::remove_file(&temp);
            return Err(anyhow::anyhow!("Existing playlist is not a regular file"));
        }
        let name = format!(".{filename}.y2sync-backup-{}", uuid::Uuid::new_v4());
        let backup = playlist_dir.join(name);
        std::fs::rename(&target, &backup).context("Failed to back up the existing playlist")?;
        Some(backup)
    } else {
        None
    };

    if let Err(error) = std::fs::rename(&temp, &target) {
        if let Some(backup) = &backup {
            let _ = std::fs::rename(backup, &target);
        }
        let _ = std::fs::remove_file(&temp);
        return Err(error).context("Failed to publish the generated playlist");
    }
    sync_parent_directory(&playlist_dir)?;
    let verified = std::fs::read_to_string(&target).context("Failed to verify the playlist")?;
    if verified != content {
        let failed = playlist_dir.join(format!(
            ".{filename}.y2sync-failed-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::rename(&target, failed);
        if let Some(backup) = &backup {
            let _ = std::fs::rename(backup, &target);
        }
        return Err(anyhow::anyhow!("Generated playlist verification failed"));
    }

    let relative = format!("Playlists/{filename}");
    let backup_relative = backup
        .as_deref()
        .and_then(|path| path.strip_prefix(root).ok())
        .and_then(Path::to_str)
        .map(|path| path.replace('\\', "/"));
    Ok((relative, backup_relative))
}

fn ensure_safe_directory(root: &Path, directory: &Path) -> Result<()> {
    if directory.exists() {
        let metadata = std::fs::symlink_metadata(directory)
            .context("Failed to inspect the playlist folder")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(anyhow::anyhow!(
                "Playlist destination is not a safe directory"
            ));
        }
    } else {
        std::fs::create_dir(directory).context("Failed to create the playlist folder")?;
    }
    let canonical =
        std::fs::canonicalize(directory).context("Failed to validate the playlist folder")?;
    if canonical.parent() != Some(root) {
        return Err(anyhow::anyhow!(
            "Playlist destination escaped the local library"
        ));
    }
    Ok(())
}

fn sync_parent_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .context("Failed to flush the playlist directory")?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

pub(crate) fn local_provider_from_url(url: &str) -> Result<LocalFolderProvider, ProviderError> {
    LocalFolderProvider::from_file_url(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (artist, album, names) in [
            ("Rare Artist", "First", ["One.mp3", "Two.mp3"]),
            ("Common Artist", "Second", ["Three.mp3", "Four.mp3"]),
        ] {
            let folder = root.path().join(artist).join(album);
            std::fs::create_dir_all(&folder).unwrap();
            for name in names {
                std::fs::write(folder.join(name), b"not-real-audio").unwrap();
            }
        }
        root
    }

    #[test]
    fn local_mix_is_deterministic_and_writes_relative_paths() {
        let root = fixture();
        let provider = LocalFolderProvider::from_root(root.path()).unwrap();
        let first = build_local_mix(&provider, LocalMixKind::Weekly, Some(4), false).unwrap();
        let second = build_local_mix(&provider, LocalMixKind::Weekly, Some(4), false).unwrap();
        assert_eq!(
            first
                .tracks
                .iter()
                .map(|track| &track.song_id)
                .collect::<Vec<_>>(),
            second
                .tracks
                .iter()
                .map(|track| &track.song_id)
                .collect::<Vec<_>>()
        );

        let written = build_local_mix(&provider, LocalMixKind::Weekly, Some(4), true).unwrap();
        assert_eq!(
            written.playlist_relative_path.as_deref(),
            Some("Playlists/Y2 Weekly Mix.m3u8")
        );
        let body =
            std::fs::read_to_string(root.path().join("Playlists/Y2 Weekly Mix.m3u8")).unwrap();
        assert!(body.lines().any(|line| line.starts_with("../")));
        assert!(!body.contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn match_key_ignores_case_spaces_and_punctuation() {
        assert_eq!(
            normalized_match_key("Björk - Jóga"),
            normalized_match_key("björk jóga")
        );
    }

    #[cfg(unix)]
    #[test]
    fn playlist_writer_rejects_symlink_destination() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("Playlists")).unwrap();
        let provider = LocalFolderProvider::from_root(root.path()).unwrap();
        let error = build_local_mix(&provider, LocalMixKind::Daily, Some(2), true).unwrap_err();
        assert!(error.to_string().contains("safe directory"));
    }
}
