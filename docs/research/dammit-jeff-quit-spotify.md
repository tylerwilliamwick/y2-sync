# Video research: “How to ACTUALLY Quit Spotify.”

- Source: https://www.youtube.com/watch?v=3d2cATPt8Nk
- Creator: Dammit Jeff
- Published: 2026-04-21
- Duration: 36:13
- Transcript source: YouTube automatic English captions, retrieved 2026-09-24. Automatic captions can contain recognition errors; timestamps and linked primary documentation were used to verify product names and behavior.

## Relevant transcript findings

### Metadata cleanup (17:52–20:00)

The video describes incomplete or inconsistent title, artist, album, track number, genre, release date, and artwork tags as the cause of a messy portable-player library. It demonstrates MusicBrainz Picard’s scan/match/review/save workflow and its optional artist/album folder organization. The important product behavior is not blind rewriting: unmatched files remain reviewable, and users can manually choose a better candidate before saving.

### Personal discovery algorithm (30:42–36:13)

The proposed stack uses ListenBrainz listening history and recommendation playlists, then Explo to import Weekly Exploration, Weekly Jams, or Daily Jams into a self-hosted library. Explo avoids duplicate downloads by checking the existing library and can run on a schedule. Its downloader is a separate component.

## Y2 Sync requirements derived from the video

1. Audit local tags and artwork without changing files; clearly distinguish embedded tags from filename/folder fallbacks.
2. Search MusicBrainz with a compliant User-Agent, show scored candidates, and require review before any tag write.
3. Make tag writes stale-safe and recoverable with a same-volume temporary file plus backup; never follow symlinks.
4. Generate relative UTF-8 M3U playlists from owned tracks, with deterministic local mixes and optional ListenBrainz Weekly Exploration, Weekly Jams, and Daily Jams imports.
5. Match and deduplicate by MusicBrainz recording ID first, then normalized artist/title; report unavailable recommendations instead of downloading music.

## Explicit boundary

Y2 Sync does not incorporate Explo’s download integrations. It only organizes files the user already owns and imports recommendation metadata or locally available tracks.

## Primary references

- [Video and automatic transcript](https://www.youtube.com/watch?v=3d2cATPt8Nk)
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) and [Picard documentation](https://picard.musicbrainz.org/docs/)
- [ListenBrainz API](https://listenbrainz.readthedocs.io/en/latest/users/api/)
- [Explo implementation](https://github.com/LumePart/Explo) and [ListenBrainz playlist support PR](https://github.com/LumePart/Explo/pull/116)
