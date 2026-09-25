use super::{
    BrowseCapabilities, BrowseMode, Capabilities, MediaProvider, ProviderChangeContext,
    ProviderChangeMetadata, ProviderError, ScrobbleRequest, ServerType, TrackListFilter,
    TrackListPage, TranscodeProfile, TransferSource,
};
use crate::domain::models::{
    Album, AlbumWithTracks, Artist, ArtistWithAlbums, ChangeEvent, ChangeType, Genre, ItemRef,
    ItemType, Library, Playlist, PlaylistWithTracks, SearchResult, Song,
};
use async_trait::async_trait;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

const LIBRARY_ID: &str = "local-library";
const MAX_LOCAL_FILES: usize = 1_000_000;
const MAX_SCAN_DEPTH: usize = 32;

#[derive(Clone)]
struct LocalSong {
    song: Song,
    path: PathBuf,
    relative_path: String,
    version: String,
    genre: Option<String>,
    year: Option<u32>,
    recording_mbid: Option<String>,
    tag_readable: bool,
    has_embedded_tag: bool,
    embedded_title: bool,
    embedded_artist: bool,
    embedded_album: bool,
    embedded_genre: bool,
    artwork_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMetadataAuditTrack {
    pub song_id: String,
    pub relative_path: String,
    pub version: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub duration_seconds: u32,
    pub recording_mbid: Option<String>,
    pub has_embedded_artwork: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMetadataAuditPage {
    pub total_tracks: usize,
    pub tracks_with_issues: usize,
    pub issue_counts: BTreeMap<String, usize>,
    pub offset: usize,
    pub limit: usize,
    pub tracks: Vec<LocalMetadataAuditTrack>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPlaylistTrack {
    pub song_id: String,
    pub relative_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub duration_seconds: u32,
    pub recording_mbid: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalTagTarget {
    pub path: PathBuf,
    pub relative_path: String,
    pub version: String,
}

#[derive(Clone)]
struct LocalPlaylist {
    playlist: Playlist,
    track_ids: Vec<String>,
}

#[derive(Default)]
struct LocalIndex {
    songs: Vec<LocalSong>,
    songs_by_id: HashMap<String, usize>,
    artists: Vec<Artist>,
    albums: Vec<Album>,
    playlists: Vec<LocalPlaylist>,
    genres: Vec<Genre>,
}

/// Read-only provider for a user-selected local music folder.
///
/// The index never follows symlinks. Every path is canonicalized during the
/// scan and again before transfer, so replacing an indexed file with a symlink
/// cannot turn a sync into an arbitrary-file read.
pub struct LocalFolderProvider {
    root: PathBuf,
    root_url: String,
    name: String,
    source_prefix: String,
    index: LocalIndex,
}

impl LocalFolderProvider {
    pub fn from_root(root: impl AsRef<Path>) -> Result<Self, ProviderError> {
        let root = std::fs::canonicalize(root.as_ref()).map_err(|error| {
            ProviderError::StaleConfiguration(format!("local music folder is unavailable: {error}"))
        })?;
        let metadata = std::fs::metadata(&root).map_err(|error| {
            ProviderError::StaleConfiguration(format!(
                "local music folder cannot be inspected: {error}"
            ))
        })?;
        if !metadata.is_dir() {
            return Err(ProviderError::StaleConfiguration(
                "local music source must be a folder".into(),
            ));
        }
        let root_url = reqwest::Url::from_directory_path(&root)
            .map_err(|_| {
                ProviderError::StaleConfiguration(
                    "local music folder cannot be represented safely".into(),
                )
            })?
            .to_string();
        let root_hash = stable_hash(&root_url);
        let source_prefix = format!("local:{}:", &root_hash[..16]);
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Local Music")
            .to_string();
        let index = build_index(&root, &source_prefix)?;
        Ok(Self {
            root,
            root_url,
            name,
            source_prefix,
            index,
        })
    }

    pub fn from_file_url(url: &str) -> Result<Self, ProviderError> {
        let url = reqwest::Url::parse(url).map_err(|_| {
            ProviderError::StaleConfiguration("local music folder URL is invalid".into())
        })?;
        if url.scheme() != "file" {
            return Err(ProviderError::StaleConfiguration(
                "local music source must use a file URL".into(),
            ));
        }
        let path = url.to_file_path().map_err(|_| {
            ProviderError::StaleConfiguration("local music folder URL is invalid".into())
        })?;
        Self::from_root(path)
    }

    pub fn root_url(&self) -> &str {
        &self.root_url
    }

    pub fn display_name(&self) -> &str {
        &self.name
    }

    pub fn song_count(&self) -> usize {
        self.index.songs.len()
    }

    /// Rebuild the in-memory index after files change outside the app. The
    /// server manager replaces the provider after a successful RPC rescan, but
    /// keeping the operation here makes the scan semantics explicit and
    /// testable without filesystem watchers.
    pub fn rescan(&mut self) -> Result<usize, ProviderError> {
        self.index = build_index(&self.root, &self.source_prefix)?;
        Ok(self.index.songs.len())
    }

    pub(crate) fn root_path(&self) -> &Path {
        &self.root
    }

    pub fn metadata_audit(
        &self,
        offset: usize,
        limit: usize,
        issues_only: bool,
    ) -> LocalMetadataAuditPage {
        let limit = limit.clamp(1, 500);
        let mut issue_counts = BTreeMap::new();
        let mut tracks_with_issues = 0usize;
        let mut matching = Vec::new();
        for entry in &self.index.songs {
            let issues = metadata_issues(entry);
            if !issues.is_empty() {
                tracks_with_issues = tracks_with_issues.saturating_add(1);
                for issue in &issues {
                    *issue_counts.entry(issue.clone()).or_insert(0) += 1;
                }
            }
            if !issues_only || !issues.is_empty() {
                matching.push(metadata_audit_track(entry, issues));
            }
        }
        let start = offset.min(matching.len());
        let end = start.saturating_add(limit).min(matching.len());
        LocalMetadataAuditPage {
            total_tracks: self.index.songs.len(),
            tracks_with_issues,
            issue_counts,
            offset: start,
            limit,
            tracks: matching[start..end].to_vec(),
        }
    }

    pub(crate) fn metadata_track(
        &self,
        song_id: &str,
        expected_version: &str,
    ) -> Result<LocalMetadataAuditTrack, ProviderError> {
        let entry = self.song_entry(song_id)?;
        if entry.version != expected_version {
            return Err(ProviderError::StaleConfiguration(
                "local track changed after metadata review".into(),
            ));
        }
        Ok(metadata_audit_track(entry, metadata_issues(entry)))
    }

    pub(crate) fn playlist_tracks(&self) -> Vec<LocalPlaylistTrack> {
        self.index
            .songs
            .iter()
            .map(|entry| LocalPlaylistTrack {
                song_id: entry.song.id.clone(),
                relative_path: entry.relative_path.clone(),
                title: entry.song.title.clone(),
                artist: entry.song.artist_name.clone().unwrap_or_default(),
                album: entry.song.album_title.clone().unwrap_or_default(),
                genre: entry.genre.clone(),
                year: entry.year,
                duration_seconds: entry.song.duration_seconds,
                recording_mbid: entry.recording_mbid.clone(),
            })
            .collect()
    }

    pub(crate) fn tag_target(
        &self,
        song_id: &str,
        expected_version: &str,
    ) -> Result<LocalTagTarget, ProviderError> {
        let entry = self.song_entry(song_id)?;
        if entry.version != expected_version {
            return Err(ProviderError::StaleConfiguration(
                "local track changed after metadata review".into(),
            ));
        }
        Ok(LocalTagTarget {
            path: self.checked_transfer_path(song_id)?,
            relative_path: entry.relative_path.clone(),
            version: entry.version.clone(),
        })
    }

    fn song_entry(&self, id: &str) -> Result<&LocalSong, ProviderError> {
        self.index
            .songs_by_id
            .get(id)
            .and_then(|index| self.index.songs.get(*index))
            .ok_or_else(|| ProviderError::NotFound {
                item_type: "song".into(),
                id: id.to_string(),
            })
    }

    fn checked_transfer_path(&self, id: &str) -> Result<PathBuf, ProviderError> {
        let indexed = &self.song_entry(id)?.path;
        let metadata = std::fs::symlink_metadata(indexed).map_err(|_| ProviderError::NotFound {
            item_type: "song".into(),
            id: id.to_string(),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ProviderError::Forbidden);
        }
        let canonical = std::fs::canonicalize(indexed).map_err(|_| ProviderError::Forbidden)?;
        if canonical != *indexed || !canonical.starts_with(&self.root) {
            return Err(ProviderError::Forbidden);
        }
        Ok(canonical)
    }
}

fn metadata_audit_track(entry: &LocalSong, issues: Vec<String>) -> LocalMetadataAuditTrack {
    LocalMetadataAuditTrack {
        song_id: entry.song.id.clone(),
        relative_path: entry.relative_path.clone(),
        version: entry.version.clone(),
        title: entry.song.title.clone(),
        artist: entry.song.artist_name.clone().unwrap_or_default(),
        album: entry.song.album_title.clone().unwrap_or_default(),
        genre: entry.genre.clone(),
        year: entry.year,
        track_number: entry.song.track_number,
        disc_number: entry.song.disc_number,
        duration_seconds: entry.song.duration_seconds,
        recording_mbid: entry.recording_mbid.clone(),
        has_embedded_artwork: entry.artwork_count > 0,
        issues,
    }
}

fn metadata_issues(entry: &LocalSong) -> Vec<String> {
    let mut issues = Vec::new();
    if !entry.tag_readable {
        issues.push("unreadableTags".to_string());
    } else if !entry.has_embedded_tag {
        issues.push("missingTag".to_string());
    }
    if !entry.embedded_title {
        issues.push("missingTitle".to_string());
    } else if is_placeholder(&entry.song.title) {
        issues.push("placeholderTitle".to_string());
    }
    let artist = entry.song.artist_name.as_deref().unwrap_or_default();
    if !entry.embedded_artist {
        issues.push("missingArtist".to_string());
    } else if is_placeholder(artist) {
        issues.push("placeholderArtist".to_string());
    }
    let album = entry.song.album_title.as_deref().unwrap_or_default();
    if !entry.embedded_album {
        issues.push("missingAlbum".to_string());
    } else if is_placeholder(album) {
        issues.push("placeholderAlbum".to_string());
    }
    if !entry.embedded_genre {
        issues.push("missingGenre".to_string());
    }
    if entry.year.is_none() {
        issues.push("missingYear".to_string());
    }
    if entry.song.track_number.is_none() {
        issues.push("missingTrackNumber".to_string());
    }
    if entry.artwork_count == 0 {
        issues.push("missingArtwork".to_string());
    }
    if entry.recording_mbid.is_none() {
        issues.push("missingMusicBrainzId".to_string());
    }
    issues
}

fn is_placeholder(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "unknown" | "unknown artist" | "unknown album" | "unknown track" | "track"
    )
}

#[async_trait]
impl MediaProvider for LocalFolderProvider {
    async fn list_libraries(&self) -> Result<Vec<Library>, ProviderError> {
        Ok(vec![Library {
            id: LIBRARY_ID.into(),
            name: self.name.clone(),
            item_type: ItemType::Library,
            cover_art_id: None,
        }])
    }

    async fn list_artists(
        &self,
        library_id: Option<&str>,
        letter: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Artist>, u32), ProviderError> {
        require_library(library_id)?;
        let artists: Vec<_> = self
            .index
            .artists
            .iter()
            .filter(|artist| starts_with_letter(&artist.name, letter))
            .cloned()
            .collect();
        Ok(page(&artists, offset, limit))
    }

    async fn get_artist(&self, artist_id: &str) -> Result<ArtistWithAlbums, ProviderError> {
        let artist = self
            .index
            .artists
            .iter()
            .find(|artist| artist.id == artist_id)
            .cloned()
            .ok_or_else(|| ProviderError::NotFound {
                item_type: "artist".into(),
                id: artist_id.to_string(),
            })?;
        let albums = self
            .index
            .albums
            .iter()
            .filter(|album| album.artist_id.as_deref() == Some(artist_id))
            .cloned()
            .collect();
        Ok(ArtistWithAlbums { artist, albums })
    }

    async fn list_albums(
        &self,
        library_id: Option<&str>,
        letter: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Album>, u32), ProviderError> {
        require_library(library_id)?;
        let albums: Vec<_> = self
            .index
            .albums
            .iter()
            .filter(|album| starts_with_letter(&album.title, letter))
            .cloned()
            .collect();
        Ok(page(&albums, offset, limit))
    }

    async fn get_album(&self, album_id: &str) -> Result<AlbumWithTracks, ProviderError> {
        let album = self
            .index
            .albums
            .iter()
            .find(|album| album.id == album_id)
            .cloned()
            .ok_or_else(|| ProviderError::NotFound {
                item_type: "album".into(),
                id: album_id.to_string(),
            })?;
        let tracks = self
            .index
            .songs
            .iter()
            .filter(|entry| entry.song.album_id.as_deref() == Some(album_id))
            .map(|entry| entry.song.clone())
            .collect();
        Ok(AlbumWithTracks {
            album,
            tracks,
            provider_metadata: Default::default(),
        })
    }

    async fn get_song(&self, song_id: &str) -> Result<Song, ProviderError> {
        Ok(self.song_entry(song_id)?.song.clone())
    }

    async fn list_playlists(&self) -> Result<Vec<Playlist>, ProviderError> {
        Ok(self
            .index
            .playlists
            .iter()
            .map(|entry| entry.playlist.clone())
            .collect())
    }

    async fn get_playlist(&self, playlist_id: &str) -> Result<PlaylistWithTracks, ProviderError> {
        let playlist = self
            .index
            .playlists
            .iter()
            .find(|entry| entry.playlist.id == playlist_id)
            .ok_or_else(|| ProviderError::NotFound {
                item_type: "playlist".into(),
                id: playlist_id.to_string(),
            })?;
        let tracks = playlist
            .track_ids
            .iter()
            .filter_map(|id| self.song_entry(id).ok().map(|entry| entry.song.clone()))
            .collect();
        Ok(PlaylistWithTracks {
            playlist: playlist.playlist.clone(),
            tracks,
        })
    }

    async fn search(&self, query: &str) -> Result<SearchResult, ProviderError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(SearchResult::default());
        }
        Ok(SearchResult {
            artists: self
                .index
                .artists
                .iter()
                .filter(|artist| artist.name.to_lowercase().contains(&query))
                .cloned()
                .collect(),
            albums: self
                .index
                .albums
                .iter()
                .filter(|album| album.title.to_lowercase().contains(&query))
                .cloned()
                .collect(),
            songs: self
                .index
                .songs
                .iter()
                .filter(|entry| {
                    entry.song.title.to_lowercase().contains(&query)
                        || entry
                            .song
                            .artist_name
                            .as_deref()
                            .is_some_and(|artist| artist.to_lowercase().contains(&query))
                        || entry
                            .song
                            .album_title
                            .as_deref()
                            .is_some_and(|album| album.to_lowercase().contains(&query))
                })
                .map(|entry| entry.song.clone())
                .collect(),
            playlists: self
                .index
                .playlists
                .iter()
                .filter(|entry| entry.playlist.name.to_lowercase().contains(&query))
                .map(|entry| entry.playlist.clone())
                .collect(),
            possibly_truncated: false,
        })
    }

    async fn download_url(
        &self,
        _song_id: &str,
        _profile: Option<&TranscodeProfile>,
    ) -> Result<String, ProviderError> {
        Err(ProviderError::UnsupportedCapability(
            "local files are transferred without a URL".into(),
        ))
    }

    async fn transfer_source(
        &self,
        song_id: &str,
        profile: Option<&TranscodeProfile>,
    ) -> Result<TransferSource, ProviderError> {
        if profile.is_some() {
            return Err(ProviderError::UnsupportedCapability(
                "local transcoding is not available for this format yet".into(),
            ));
        }
        Ok(TransferSource::LocalFile(
            self.checked_transfer_path(song_id)?,
        ))
    }

    async fn cover_art_url(&self, _cover_art_id: &str) -> Result<String, ProviderError> {
        Err(ProviderError::UnsupportedCapability(
            "local artwork proxy is not available".into(),
        ))
    }

    async fn changes_since_with_context(
        &self,
        _token: Option<&str>,
        context: &ProviderChangeContext,
    ) -> Result<Vec<ChangeEvent>, ProviderError> {
        let expected: HashMap<&str, Option<&str>> = context
            .synced_songs
            .iter()
            .filter(|song| song.song_id.starts_with(&self.source_prefix))
            .map(|song| (song.song_id.as_str(), song.version.as_deref()))
            .collect();
        let current: HashSet<&str> = self
            .index
            .songs
            .iter()
            .map(|entry| entry.song.id.as_str())
            .collect();
        let mut changes = Vec::new();
        for entry in &self.index.songs {
            let change_type = match expected.get(entry.song.id.as_str()) {
                None => ChangeType::Created,
                Some(Some(version)) if *version == entry.version => continue,
                Some(_) => ChangeType::Updated,
            };
            changes.push(ChangeEvent {
                item: ItemRef {
                    id: entry.song.id.clone(),
                    item_type: ItemType::Song,
                },
                change_type,
                version: Some(entry.version.clone()),
            });
        }
        for id in expected.keys().filter(|id| !current.contains(**id)) {
            changes.push(ChangeEvent {
                item: ItemRef {
                    id: (*id).to_string(),
                    item_type: ItemType::Song,
                },
                change_type: ChangeType::Deleted,
                version: None,
            });
        }
        changes.sort_by(|left, right| left.item.id.cmp(&right.item.id));
        Ok(changes)
    }

    async fn scrobble(&self, _request: ScrobbleRequest) -> Result<(), ProviderError> {
        Err(ProviderError::UnsupportedCapability(
            "local play history is not writable".into(),
        ))
    }

    async fn list_genres(
        &self,
        library_id: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Genre>, u64), ProviderError> {
        require_library(library_id)?;
        let total = self.index.genres.len() as u64;
        let (genres, _) = page(&self.index.genres, offset, limit);
        Ok((genres, total))
    }

    async fn get_genre_tracks(
        &self,
        genre_id_or_name: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Song>, u32), ProviderError> {
        let Some(selected_genre) = self.index.genres.iter().find(|genre| {
            genre.id == genre_id_or_name || genre.name.eq_ignore_ascii_case(genre_id_or_name)
        }) else {
            return Ok((Vec::new(), 0));
        };
        let tracks: Vec<_> = self
            .index
            .songs
            .iter()
            .filter(|entry| {
                entry
                    .genre
                    .as_deref()
                    .is_some_and(|genre| genre.eq_ignore_ascii_case(&selected_genre.name))
            })
            .map(|entry| entry.song.clone())
            .collect();
        Ok(page(&tracks, offset, limit))
    }

    async fn list_recently_added(
        &self,
        library_id: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Album>, u32), ProviderError> {
        require_library(library_id)?;
        Ok(page(&self.index.albums, offset, limit))
    }

    async fn list_tracks(&self, filter: TrackListFilter) -> Result<TrackListPage, ProviderError> {
        require_library(filter.library_id.as_deref())?;
        let tracks: Vec<_> = self
            .index
            .songs
            .iter()
            .filter(|entry| {
                filter
                    .artist_id
                    .as_deref()
                    .is_none_or(|id| entry.song.artist_id.as_deref() == Some(id))
                    && filter
                        .album_id
                        .as_deref()
                        .is_none_or(|id| entry.song.album_id.as_deref() == Some(id))
                    && starts_with_letter(&entry.song.title, filter.letter.as_deref())
            })
            .map(|entry| entry.song.clone())
            .collect();
        let total = tracks.len().min(u32::MAX as usize) as u32;
        let (tracks, _) = page(&tracks, filter.start_index, filter.limit);
        Ok(TrackListPage {
            tracks,
            total,
            start_index: filter.start_index,
            limit: filter.limit,
        })
    }

    async fn list_all_songs_page(
        &self,
        library_id: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Song>, u32), ProviderError> {
        require_library(library_id)?;
        let tracks: Vec<_> = self
            .index
            .songs
            .iter()
            .map(|entry| entry.song.clone())
            .collect();
        Ok(page(&tracks, offset, limit))
    }

    fn change_metadata(&self, event: &ChangeEvent) -> Option<ProviderChangeMetadata> {
        let entry = self.song_entry(&event.item.id).ok()?;
        Some(ProviderChangeMetadata {
            album_id: entry.song.album_id.clone(),
            size: entry.song.size_bytes,
            content_type: entry.song.content_type.clone(),
            suffix: entry.song.suffix.clone(),
        })
    }

    fn server_type(&self) -> ServerType {
        ServerType::LocalFolder
    }

    fn server_version(&self) -> Option<&str> {
        Some("local-v1")
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            open_subsonic: false,
            supports_changes_since: true,
            supports_server_transcoding: false,
            supports_playlist_write: false,
            browse: BrowseCapabilities {
                list_modes: vec![
                    BrowseMode::Artists,
                    BrowseMode::Albums,
                    BrowseMode::Playlists,
                    BrowseMode::Tracks,
                    BrowseMode::Genres,
                    BrowseMode::RecentlyAdded,
                ],
            },
        }
    }
}

fn build_index(root: &Path, source_prefix: &str) -> Result<LocalIndex, ProviderError> {
    let mut audio_paths = Vec::new();
    let mut playlist_paths = Vec::new();
    collect_paths(root, root, 0, &mut audio_paths, &mut playlist_paths)?;
    audio_paths.sort();
    playlist_paths.sort();

    let mut songs = Vec::with_capacity(audio_paths.len());
    for path in audio_paths {
        if let Some(song) = read_song(root, &path, source_prefix) {
            songs.push(song);
        }
    }
    songs.sort_by(|left, right| {
        sort_text(left.song.artist_name.as_deref())
            .cmp(&sort_text(right.song.artist_name.as_deref()))
            .then_with(|| {
                sort_text(left.song.album_title.as_deref())
                    .cmp(&sort_text(right.song.album_title.as_deref()))
            })
            .then_with(|| left.song.disc_number.cmp(&right.song.disc_number))
            .then_with(|| left.song.track_number.cmp(&right.song.track_number))
            .then_with(|| {
                left.song
                    .title
                    .to_lowercase()
                    .cmp(&right.song.title.to_lowercase())
            })
    });
    let songs_by_id: HashMap<_, _> = songs
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.song.id.clone(), index))
        .collect();
    let canonical_to_id: HashMap<_, _> = songs
        .iter()
        .map(|entry| (entry.path.clone(), entry.song.id.clone()))
        .collect();

    let artists = build_artists(&songs);
    let albums = build_albums(&songs);
    let genres = build_genres(&songs, source_prefix);
    let playlists = build_playlists(root, &playlist_paths, &canonical_to_id, source_prefix);

    Ok(LocalIndex {
        songs,
        songs_by_id,
        artists,
        albums,
        playlists,
        genres,
    })
}

fn collect_paths(
    root: &Path,
    directory: &Path,
    depth: usize,
    audio_paths: &mut Vec<PathBuf>,
    playlist_paths: &mut Vec<PathBuf>,
) -> Result<(), ProviderError> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(directory).map_err(|error| {
        ProviderError::StaleConfiguration(format!("local music folder cannot be read: {error}"))
    })?;
    for entry in entries.flatten() {
        if audio_paths.len().saturating_add(playlist_paths.len()) >= MAX_LOCAL_FILES {
            return Err(ProviderError::UnsupportedCapability(format!(
                "local music folder exceeds the {MAX_LOCAL_FILES} file safety limit"
            )));
        }
        let path = entry.path();
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with(".y2sync-"))
        {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let Ok(canonical) = std::fs::canonicalize(&path) else {
                continue;
            };
            if canonical.starts_with(root) {
                collect_paths(root, &canonical, depth + 1, audio_paths, playlist_paths)?;
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let Some(extension) = normalized_extension(&path) else {
            continue;
        };
        if is_audio_extension(&extension) {
            let Ok(canonical) = std::fs::canonicalize(&path) else {
                continue;
            };
            if canonical.starts_with(root) {
                audio_paths.push(canonical);
            }
        } else if matches!(extension.as_str(), "m3u" | "m3u8") {
            playlist_paths.push(path);
        }
    }
    Ok(())
}

fn read_song(root: &Path, path: &Path, source_prefix: &str) -> Option<LocalSong> {
    let relative = path.strip_prefix(root).ok()?;
    let relative_text = relative.to_str()?;
    let extension = normalized_extension(path)?;
    let metadata = std::fs::metadata(path).ok()?;
    let size = metadata.len();
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let date_added = metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());

    let tagged = lofty::read_from_path(path).ok();
    let tag = tagged
        .as_ref()
        .and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
    let fallback = fallback_names(relative);
    let embedded_title = clean_tag(tag.and_then(Accessor::title));
    let embedded_artist = clean_tag(tag.and_then(Accessor::artist));
    let embedded_album = clean_tag(tag.and_then(Accessor::album));
    let genre = clean_tag(tag.and_then(Accessor::genre));
    let title = embedded_title.clone().unwrap_or(fallback.2);
    let artist_name = embedded_artist.clone().unwrap_or(fallback.0);
    let album_title = embedded_album.clone().unwrap_or(fallback.1);
    let track_number = tag.and_then(Accessor::track);
    let disc_number = tag.and_then(Accessor::disk);
    let year = tag
        .and_then(Accessor::date)
        .map(|date| u32::from(date.year))
        .filter(|year| *year > 0);
    let recording_mbid = tag
        .and_then(|tag| tag.get_string(ItemKey::MusicBrainzRecordingId))
        .and_then(clean_text);
    let artwork_count = tag.map_or(0, |tag| tag.pictures().len());
    let properties = tagged.as_ref().map(AudioFile::properties);
    let duration_seconds = properties
        .map(|properties| properties.duration().as_secs().min(u64::from(u32::MAX)) as u32)
        .unwrap_or(0);
    let bitrate_kbps = properties.and_then(|properties| {
        properties
            .audio_bitrate()
            .or_else(|| properties.overall_bitrate())
    });

    let artist_id = stable_local_id(source_prefix, "artist", &artist_name);
    let album_key = format!("{artist_name}\0{album_title}");
    let album_id = stable_local_id(source_prefix, "album", &album_key);
    let song_id = stable_local_id(source_prefix, "song", relative_text);
    let content_type = content_type_for_extension(&extension).map(str::to_string);
    let tag_signature = stable_hash(&format!(
        "{title}\0{artist_name}\0{album_title}\0{}\0{track_number:?}\0{disc_number:?}\0{year:?}\0{}\0{artwork_count}",
        genre.as_deref().unwrap_or(""),
        recording_mbid.as_deref().unwrap_or("")
    ));
    let version = format!(
        "local:v1|{album_id}|{size}|{}|{extension}|{modified_nanos}|tag:{}",
        content_type.as_deref().unwrap_or(""),
        &tag_signature[..16]
    );
    Some(LocalSong {
        song: Song {
            id: song_id,
            title,
            artist_id: Some(artist_id),
            artist_name: Some(artist_name),
            album_id: Some(album_id),
            album_title: Some(album_title),
            duration_seconds,
            bitrate_kbps,
            track_number,
            disc_number,
            cover_art_id: None,
            date_added,
            last_played_at: None,
            play_count: None,
            is_favorite: None,
            content_type,
            suffix: Some(extension),
            size_bytes: Some(size),
            album_loudness: Default::default(),
            provider_metadata: Default::default(),
        },
        path: path.to_path_buf(),
        relative_path: relative_text.to_string(),
        version: year.map_or_else(|| version.clone(), |year| format!("{version}|year:{year}")),
        year,
        recording_mbid,
        tag_readable: tagged.is_some(),
        has_embedded_tag: tag.is_some(),
        embedded_title: embedded_title.is_some(),
        embedded_artist: embedded_artist.is_some(),
        embedded_album: embedded_album.is_some(),
        embedded_genre: genre.is_some(),
        artwork_count,
        genre,
    })
}

fn fallback_names(relative: &Path) -> (String, String, String) {
    let title = relative
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown Track")
        .to_string();
    let components: Vec<_> = relative
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .filter_map(|component| component.as_os_str().to_str())
        .collect();
    let album = components
        .last()
        .copied()
        .unwrap_or("Unknown Album")
        .to_string();
    let artist = components
        .len()
        .checked_sub(2)
        .and_then(|index| components.get(index))
        .copied()
        .unwrap_or("Unknown Artist")
        .to_string();
    (artist, album, title)
}

fn build_artists(songs: &[LocalSong]) -> Vec<Artist> {
    let mut artists: BTreeMap<String, (String, HashSet<String>, u32)> = BTreeMap::new();
    for entry in songs {
        let Some(id) = entry.song.artist_id.as_ref() else {
            continue;
        };
        let item = artists.entry(id.clone()).or_insert_with(|| {
            (
                entry.song.artist_name.clone().unwrap_or_default(),
                HashSet::new(),
                0,
            )
        });
        if let Some(album_id) = &entry.song.album_id {
            item.1.insert(album_id.clone());
        }
        item.2 = item.2.saturating_add(1);
    }
    let mut values: Vec<_> = artists
        .into_iter()
        .map(|(id, (name, albums, songs))| Artist {
            id,
            name,
            album_count: Some(albums.len().min(u32::MAX as usize) as u32),
            song_count: Some(songs),
            cover_art_id: None,
        })
        .collect();
    values.sort_by_key(|artist| artist.name.to_lowercase());
    values
}

fn build_albums(songs: &[LocalSong]) -> Vec<Album> {
    let mut albums: BTreeMap<String, Album> = BTreeMap::new();
    for entry in songs {
        let Some(id) = entry.song.album_id.as_ref() else {
            continue;
        };
        let album = albums.entry(id.clone()).or_insert_with(|| Album {
            id: id.clone(),
            title: entry.song.album_title.clone().unwrap_or_default(),
            artist_id: entry.song.artist_id.clone(),
            artist_name: entry.song.artist_name.clone(),
            year: parse_version_year(&entry.version),
            song_count: Some(0),
            duration_seconds: Some(0),
            cover_art_id: None,
            provider_metadata: Default::default(),
        });
        album.song_count = Some(album.song_count.unwrap_or(0).saturating_add(1));
        album.duration_seconds = Some(
            album
                .duration_seconds
                .unwrap_or(0)
                .saturating_add(entry.song.duration_seconds),
        );
        album.year = album.year.or_else(|| parse_version_year(&entry.version));
    }
    let mut values: Vec<_> = albums.into_values().collect();
    values.sort_by(|left, right| {
        sort_text(left.artist_name.as_deref())
            .cmp(&sort_text(right.artist_name.as_deref()))
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });
    values
}

fn build_genres(songs: &[LocalSong], source_prefix: &str) -> Vec<Genre> {
    let mut counts: BTreeMap<String, (String, u32)> = BTreeMap::new();
    for genre in songs.iter().filter_map(|entry| entry.genre.as_deref()) {
        let key = genre.to_lowercase();
        let item = counts.entry(key).or_insert_with(|| (genre.to_string(), 0));
        item.1 = item.1.saturating_add(1);
    }
    counts
        .into_values()
        .map(|(name, count)| Genre {
            id: stable_local_id(source_prefix, "genre", &name),
            name,
            song_count: Some(count),
            cover_art_id: None,
        })
        .collect()
}

fn build_playlists(
    root: &Path,
    paths: &[PathBuf],
    canonical_to_id: &HashMap<PathBuf, String>,
    source_prefix: &str,
) -> Vec<LocalPlaylist> {
    let mut playlists = Vec::new();
    for path in paths {
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut track_ids = Vec::new();
        let mut seen = HashSet::new();
        for line in contents.lines() {
            let line = line.trim_start_matches('\u{feff}').trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let normalized = line.replace('\\', "/");
            let candidate = Path::new(&normalized);
            let joined = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                path.parent().unwrap_or(root).join(candidate)
            };
            let Ok(canonical) = std::fs::canonicalize(joined) else {
                continue;
            };
            if !canonical.starts_with(root) {
                continue;
            }
            if let Some(id) = canonical_to_id.get(&canonical)
                && seen.insert(id.clone())
            {
                track_ids.push(id.clone());
            }
        }
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Playlist")
            .to_string();
        let relative = path
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .unwrap_or(&name);
        playlists.push(LocalPlaylist {
            playlist: Playlist {
                id: stable_local_id(source_prefix, "playlist", relative),
                name,
                song_count: Some(track_ids.len().min(u32::MAX as usize) as u32),
                duration_seconds: None,
                cover_art_id: None,
            },
            track_ids,
        });
    }
    playlists.sort_by_key(|entry| entry.playlist.name.to_lowercase());
    playlists
}

fn require_library(library_id: Option<&str>) -> Result<(), ProviderError> {
    if library_id.is_none_or(|id| id == LIBRARY_ID) {
        Ok(())
    } else {
        Err(ProviderError::NotFound {
            item_type: "library".into(),
            id: library_id.unwrap_or_default().to_string(),
        })
    }
}

fn page<T: Clone>(items: &[T], offset: u32, limit: u32) -> (Vec<T>, u32) {
    let total = items.len().min(u32::MAX as usize) as u32;
    let start = (offset as usize).min(items.len());
    let end = start.saturating_add(limit as usize).min(items.len());
    (items[start..end].to_vec(), total)
}

fn starts_with_letter(value: &str, letter: Option<&str>) -> bool {
    letter
        .map(str::trim)
        .filter(|letter| !letter.is_empty())
        .is_none_or(|letter| value.to_lowercase().starts_with(&letter.to_lowercase()))
}

fn stable_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stable_local_id(prefix: &str, kind: &str, value: &str) -> String {
    format!("{prefix}{kind}:{}", stable_hash(value))
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
}

fn is_audio_extension(extension: &str) -> bool {
    matches!(
        extension,
        "aac"
            | "aif"
            | "aiff"
            | "ape"
            | "flac"
            | "m4a"
            | "m4b"
            | "m4r"
            | "mp3"
            | "mp4"
            | "oga"
            | "ogg"
            | "opus"
            | "wav"
            | "wma"
            | "wv"
    )
}

fn content_type_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "aac" => Some("audio/aac"),
        "aif" | "aiff" => Some("audio/aiff"),
        "ape" => Some("audio/ape"),
        "flac" => Some("audio/flac"),
        "m4a" | "m4b" | "m4r" | "mp4" => Some("audio/mp4"),
        "mp3" => Some("audio/mpeg"),
        "oga" | "ogg" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "wav" => Some("audio/wav"),
        "wma" => Some("audio/x-ms-wma"),
        "wv" => Some("audio/wavpack"),
        _ => None,
    }
}

fn clean_tag(value: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn sort_text(value: Option<&str>) -> String {
    value.unwrap_or_default().to_lowercase()
}

fn parse_version_year(version: &str) -> Option<u32> {
    version
        .rsplit_once("|year:")
        .and_then(|(_, year)| year.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("Artist/Album")).unwrap();
        fs::write(root.path().join("Artist/Album/01 - First.mp3"), b"one").unwrap();
        fs::write(root.path().join("Artist/Album/02 - Second.flac"), b"two").unwrap();
        fs::write(
            root.path().join("Favorites.m3u8"),
            "#EXTM3U\nArtist/Album/02 - Second.flac\nArtist/Album/01 - First.mp3\n",
        )
        .unwrap();
        root
    }

    #[tokio::test]
    async fn indexes_folder_metadata_and_relative_playlists() {
        let root = fixture();
        let provider = LocalFolderProvider::from_root(root.path()).unwrap();

        assert_eq!(provider.song_count(), 2);
        let (artists, total) = provider.list_artists(None, None, 0, 50).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(artists[0].name, "Artist");
        let playlists = provider.list_playlists().await.unwrap();
        assert_eq!(playlists[0].name, "Favorites");
        let playlist = provider.get_playlist(&playlists[0].id).await.unwrap();
        assert_eq!(playlist.tracks.len(), 2);
        assert_eq!(playlist.tracks[0].title, "02 - Second");
    }

    #[test]
    fn rescan_refreshes_external_changes() {
        let root = fixture();
        let mut provider = LocalFolderProvider::from_root(root.path()).unwrap();
        fs::write(root.path().join("Artist/Album/03 - Third.flac"), b"three").unwrap();
        assert_eq!(provider.song_count(), 2);

        assert_eq!(provider.rescan().unwrap(), 3);
        assert_eq!(provider.song_count(), 3);
    }

    #[tokio::test]
    async fn transfer_source_is_canonical_and_rejects_transcoding() {
        let root = fixture();
        let provider = LocalFolderProvider::from_root(root.path()).unwrap();
        let (tracks, _) = provider.list_all_songs_page(None, 0, 10).await.unwrap();
        let source = provider.transfer_source(&tracks[0].id, None).await.unwrap();
        let TransferSource::LocalFile(path) = source else {
            panic!("expected a local transfer source");
        };
        assert!(path.is_absolute());
        assert!(path.starts_with(std::fs::canonicalize(root.path()).unwrap()));

        let error = provider
            .transfer_source(
                &tracks[0].id,
                Some(&TranscodeProfile {
                    container: Some("mp3".into()),
                    audio_codec: Some("mp3".into()),
                    max_bitrate_kbps: Some(192),
                }),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::UnsupportedCapability(_)));
    }

    #[tokio::test]
    async fn change_detection_is_scoped_to_this_local_root() {
        let root = fixture();
        let provider = LocalFolderProvider::from_root(root.path()).unwrap();
        let changes = provider
            .changes_since_with_context(
                None,
                &ProviderChangeContext {
                    synced_songs: vec![super::super::ProviderSyncedSong {
                        song_id: "remote-provider-song".into(),
                        album_id: None,
                        size: None,
                        content_type: None,
                        suffix: None,
                        version: None,
                    }],
                    synced_album_ids: vec![],
                },
            )
            .await
            .unwrap();
        assert_eq!(changes.len(), 2);
        assert!(
            changes
                .iter()
                .all(|change| change.change_type == ChangeType::Created)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scan_does_not_follow_symlinks_outside_the_root() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.mp3"), b"secret").unwrap();
        symlink(
            outside.path().join("secret.mp3"),
            root.path().join("Artist/Album/secret.mp3"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();

        let provider = LocalFolderProvider::from_root(root.path()).unwrap();
        assert_eq!(provider.song_count(), 2);
    }
}
