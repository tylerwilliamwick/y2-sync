use crate::library_tools::{normalized_match_key, write_imported_playlist};
use crate::providers::local::{LocalFolderProvider, LocalPlaylistTrack};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const LISTENBRAINZ_BASE: &str = "https://api.listenbrainz.org/1/";
const USER_AGENT: &str = concat!(
    "Y2-Sync/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/tylerwilliamwick/y2-sync)"
);
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_CREATED_FOR_PAGES: usize = 20;
const MAX_RECOMMENDATIONS: usize = 1_000;
const MAX_WRITTEN_TRACKS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListenBrainzMixKind {
    WeeklyExploration,
    WeeklyJams,
    DailyJams,
}

impl ListenBrainzMixKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "weekly-exploration" => Some(Self::WeeklyExploration),
            "weekly-jams" => Some(Self::WeeklyJams),
            "daily-jams" => Some(Self::DailyJams),
            _ => None,
        }
    }

    fn source_patch(self) -> &'static str {
        match self {
            Self::WeeklyExploration => "weekly-exploration",
            Self::WeeklyJams => "weekly-jams",
            Self::DailyJams => "daily-jams",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::WeeklyExploration => "ListenBrainz Weekly Exploration",
            Self::WeeklyJams => "ListenBrainz Weekly Jams",
            Self::DailyJams => "ListenBrainz Daily Jams",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecommendationTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub recording_mbid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MatchedRecommendation {
    pub recommendation: RecommendationTrack,
    pub song_id: String,
    pub relative_path: String,
    pub match_method: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListenBrainzImportResult {
    pub title: String,
    pub source_kind: String,
    pub source_playlist_id: String,
    pub source_date: String,
    pub recommendation_count: usize,
    pub matched_count: usize,
    pub unavailable_count: usize,
    pub ambiguous_count: usize,
    pub duplicate_count: usize,
    pub playlist_relative_path: Option<String>,
    pub backup_relative_path: Option<String>,
    pub matched: Vec<MatchedRecommendation>,
    pub unavailable: Vec<RecommendationTrack>,
    pub ambiguous: Vec<RecommendationTrack>,
}

#[derive(Debug, Deserialize)]
struct CreatedForResponse {
    #[serde(default)]
    count: usize,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    playlist_count: usize,
    #[serde(default)]
    playlists: Vec<CreatedForItem>,
}

#[derive(Debug, Deserialize)]
struct CreatedForItem {
    playlist: CreatedForPlaylist,
}

#[derive(Debug, Deserialize)]
struct CreatedForPlaylist {
    #[serde(default)]
    date: String,
    identifier: String,
    #[serde(default)]
    extension: JspfPlaylistExtension,
}

#[derive(Debug, Default, Deserialize)]
struct JspfPlaylistExtension {
    #[serde(rename = "https://musicbrainz.org/doc/jspf#playlist", default)]
    jspf: JspfPlaylistMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct JspfPlaylistMetadata {
    #[serde(default)]
    additional_metadata: JspfAdditionalMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct JspfAdditionalMetadata {
    #[serde(default)]
    algorithm_metadata: JspfAlgorithmMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct JspfAlgorithmMetadata {
    #[serde(default)]
    source_patch: String,
}

#[derive(Debug, Deserialize)]
struct PlaylistResponse {
    playlist: JspfPlaylist,
}

#[derive(Debug, Deserialize)]
struct JspfPlaylist {
    #[serde(default)]
    title: String,
    #[serde(default)]
    track: Vec<JspfTrack>,
}

#[derive(Debug, Deserialize)]
struct JspfTrack {
    #[serde(default)]
    title: String,
    #[serde(default)]
    creator: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    identifier: Vec<String>,
}

#[derive(Debug)]
struct FetchedPlaylist {
    id: String,
    date: String,
    recommendations: Vec<RecommendationTrack>,
}

pub(crate) async fn import_listenbrainz(
    library_url: String,
    username: String,
    kind: ListenBrainzMixKind,
    write: bool,
) -> Result<ListenBrainzImportResult> {
    validate_username(&username)?;
    let fetched = fetch_playlist_at(&username, kind, LISTENBRAINZ_BASE).await?;
    tokio::task::spawn_blocking(move || {
        match_and_optionally_write(&library_url, kind, fetched, write)
    })
    .await
    .context("ListenBrainz import task failed")?
}

async fn fetch_playlist_at(
    username: &str,
    kind: ListenBrainzMixKind,
    base_url: &str,
) -> Result<FetchedPlaylist> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("Failed to initialize the ListenBrainz client")?;
    let base = reqwest::Url::parse(base_url).context("ListenBrainz endpoint is invalid")?;
    let mut best: Option<(String, String)> = None;
    let mut offset = 0usize;
    for _ in 0..MAX_CREATED_FOR_PAGES {
        let mut endpoint = base.clone();
        endpoint
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("ListenBrainz endpoint cannot contain path segments"))?
            .pop_if_empty()
            .extend(["user", username, "playlists", "createdfor"]);
        endpoint
            .query_pairs_mut()
            .append_pair("offset", &offset.to_string())
            .append_pair("count", "100");
        let response = client
            .get(endpoint)
            .send()
            .await
            .context("ListenBrainz playlist discovery failed")?;
        ensure_success(&response, "playlist discovery")?;
        let page: CreatedForResponse = bounded_json(response).await?;
        for item in page.playlists {
            if item
                .playlist
                .extension
                .jspf
                .additional_metadata
                .algorithm_metadata
                .source_patch
                != kind.source_patch()
            {
                continue;
            }
            let id = playlist_id(&item.playlist.identifier)?;
            let candidate = (item.playlist.date, id);
            if best.as_ref().is_none_or(|current| candidate.0 > current.0) {
                best = Some(candidate);
            }
        }
        let consumed = page.count.max(1);
        if page.count == 0 || page.offset.saturating_add(page.count) >= page.playlist_count {
            break;
        }
        offset = page.offset.saturating_add(consumed);
    }
    let (date, id) = best.with_context(|| {
        format!(
            "ListenBrainz has not generated a {} playlist for this user",
            kind.source_patch()
        )
    })?;
    let mut endpoint = base;
    endpoint
        .path_segments_mut()
        .map_err(|_| anyhow::anyhow!("ListenBrainz endpoint cannot contain path segments"))?
        .pop_if_empty()
        .extend(["playlist", &id]);
    let response = client
        .get(endpoint)
        .send()
        .await
        .context("ListenBrainz playlist fetch failed")?;
    ensure_success(&response, "playlist fetch")?;
    let playlist: PlaylistResponse = bounded_json(response).await?;
    let recommendations = playlist
        .playlist
        .track
        .into_iter()
        .take(MAX_RECOMMENDATIONS)
        .map(|track| RecommendationTrack {
            title: single_line(&track.title, 300),
            artist: single_line(&track.creator, 300),
            album: single_line(&track.album, 300),
            recording_mbid: track
                .identifier
                .iter()
                .find_map(|identifier| recording_mbid(identifier)),
        })
        .filter(|track| !track.title.is_empty() && !track.artist.is_empty())
        .collect::<Vec<_>>();
    if recommendations.is_empty() {
        bail!("The selected ListenBrainz playlist contains no usable tracks");
    }
    let _ = playlist.playlist.title;
    Ok(FetchedPlaylist {
        id,
        date,
        recommendations,
    })
}

fn match_and_optionally_write(
    library_url: &str,
    kind: ListenBrainzMixKind,
    fetched: FetchedPlaylist,
    write: bool,
) -> Result<ListenBrainzImportResult> {
    let provider = LocalFolderProvider::from_file_url(library_url)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let local_tracks = provider.playlist_tracks();
    let mut by_mbid: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_text: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, track) in local_tracks.iter().enumerate() {
        if let Some(mbid) = track.recording_mbid.as_deref() {
            by_mbid
                .entry(mbid.to_ascii_lowercase())
                .or_default()
                .push(index);
        }
        by_text
            .entry(text_key(&track.artist, &track.title))
            .or_default()
            .push(index);
    }
    let recommendation_count = fetched.recommendations.len();
    let mut matched = Vec::new();
    let mut selected = Vec::<LocalPlaylistTrack>::new();
    let mut unavailable = Vec::new();
    let mut ambiguous = Vec::new();
    let mut selected_ids = HashSet::new();
    let mut duplicate_count = 0usize;
    for recommendation in fetched.recommendations {
        let mbid_match = recommendation
            .recording_mbid
            .as_deref()
            .and_then(|mbid| by_mbid.get(&mbid.to_ascii_lowercase()));
        let (matches, method) = match mbid_match {
            Some(matches) if !matches.is_empty() => (Some(matches), "musicBrainzId"),
            _ => (
                by_text.get(&text_key(&recommendation.artist, &recommendation.title)),
                "artistTitle",
            ),
        };
        let Some(matches) = matches else {
            unavailable.push(recommendation);
            continue;
        };
        if matches.len() != 1 {
            ambiguous.push(recommendation);
            continue;
        }
        let local = &local_tracks[matches[0]];
        if !selected_ids.insert(local.song_id.clone()) {
            duplicate_count = duplicate_count.saturating_add(1);
            continue;
        }
        if selected.len() >= MAX_WRITTEN_TRACKS {
            unavailable.push(recommendation);
            continue;
        }
        matched.push(MatchedRecommendation {
            recommendation,
            song_id: local.song_id.clone(),
            relative_path: local.relative_path.replace('\\', "/"),
            match_method: method,
        });
        selected.push(local.clone());
    }
    let (playlist_relative_path, backup_relative_path) = if write {
        let seed = format!("listenbrainz:{}", fetched.id);
        let paths = write_imported_playlist(&provider, kind.title(), &seed, &selected)?;
        (Some(paths.0), paths.1)
    } else {
        (None, None)
    };
    Ok(ListenBrainzImportResult {
        title: kind.title().to_string(),
        source_kind: kind.source_patch().to_string(),
        source_playlist_id: fetched.id,
        source_date: fetched.date,
        recommendation_count,
        matched_count: matched.len(),
        unavailable_count: unavailable.len(),
        ambiguous_count: ambiguous.len(),
        duplicate_count,
        playlist_relative_path,
        backup_relative_path,
        matched,
        unavailable,
        ambiguous,
    })
}

fn ensure_success(response: &reqwest::Response, context: &str) -> Result<()> {
    if response.status().is_success() {
        Ok(())
    } else {
        bail!(
            "ListenBrainz {context} returned HTTP {}",
            response.status().as_u16()
        )
    }
}

async fn bounded_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BYTES as u64)
    {
        bail!("ListenBrainz response exceeded the configured size limit");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Failed to read ListenBrainz response")?
    {
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
            bail!("ListenBrainz response exceeded the configured size limit");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("ListenBrainz returned invalid JSON")
}

fn validate_username(username: &str) -> Result<()> {
    if username.is_empty()
        || username.len() > 64
        || !username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_- .".contains(character))
    {
        bail!("ListenBrainz username is invalid");
    }
    Ok(())
}

fn playlist_id(identifier: &str) -> Result<String> {
    let id = identifier
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .context("ListenBrainz playlist identifier is missing")?;
    uuid::Uuid::parse_str(id).context("ListenBrainz returned an invalid playlist identifier")?;
    Ok(id.to_ascii_lowercase())
}

fn recording_mbid(identifier: &str) -> Option<String> {
    let value = identifier.trim_end_matches('/').rsplit('/').next()?;
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string().to_ascii_lowercase())
}

fn text_key(artist: &str, title: &str) -> String {
    format!(
        "{}\0{}",
        normalized_match_key(artist),
        normalized_match_key(title)
    )
}

fn single_line(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(max)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_fixture() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Björk").join("Homogenic");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Jóga.flac"), b"fixture").unwrap();
        let url = reqwest::Url::from_directory_path(root.path())
            .unwrap()
            .to_string();
        (root, url)
    }

    #[tokio::test]
    async fn fetches_selected_algorithm_and_matches_owned_track() {
        let mut server = mockito::Server::new_async().await;
        let playlist_id = "5d63d4d5-56e7-4f76-9894-f8d2b4b331bc";
        let created = serde_json::json!({
            "count": 1,
            "offset": 0,
            "playlist_count": 1,
            "playlists": [{"playlist": {
                "date": "2026-09-20T00:00:00Z",
                "identifier": format!("https://listenbrainz.org/playlist/{playlist_id}"),
                "extension": {"https://musicbrainz.org/doc/jspf#playlist": {
                    "additional_metadata": {"algorithm_metadata": {"source_patch": "weekly-exploration"}}
                }}
            }}]
        });
        let playlist = serde_json::json!({"playlist": {
            "title": "Weekly Exploration",
            "track": [{
                "title": "Jóga",
                "creator": "Björk",
                "album": "Homogenic",
                "identifier": ["https://musicbrainz.org/recording/0f47fe74-0417-4f14-8f8e-8d7d2dfe8f1c"]
            }]
        }});
        let created_mock = server
            .mock("GET", "/1/user/tester/playlists/createdfor")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_body(created.to_string())
            .create_async()
            .await;
        let playlist_mock = server
            .mock("GET", format!("/1/playlist/{playlist_id}").as_str())
            .with_status(200)
            .with_body(playlist.to_string())
            .create_async()
            .await;
        let fetched = fetch_playlist_at(
            "tester",
            ListenBrainzMixKind::WeeklyExploration,
            &format!("{}/1/", server.url()),
        )
        .await
        .unwrap();
        let (_root, url) = provider_fixture();
        let result = match_and_optionally_write(
            &url,
            ListenBrainzMixKind::WeeklyExploration,
            fetched,
            false,
        )
        .unwrap();
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.matched[0].match_method, "artistTitle");
        created_mock.assert_async().await;
        playlist_mock.assert_async().await;
    }

    #[test]
    fn malformed_identifiers_are_rejected() {
        assert!(playlist_id("https://listenbrainz.org/playlist/not-a-uuid").is_err());
        assert!(recording_mbid("https://musicbrainz.org/recording/nope").is_none());
    }
}
