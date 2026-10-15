import re
from urllib.parse import parse_qs, urlparse


class UnsupportedVideoUrl(ValueError):
    pass


def normalize_watch_url(url: str, expected_video_id: str) -> str:
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as error:
        raise UnsupportedVideoUrl("Malformed YouTube URL") from error
    hostname = (parsed.hostname or "").lower()

    if parsed.scheme != "https":
        raise UnsupportedVideoUrl("Only HTTPS YouTube URLs are supported")
    if parsed.username is not None or parsed.password is not None or port not in (None, 443):
        raise UnsupportedVideoUrl("URL credentials and non-HTTPS ports are not supported")

    if hostname == "youtu.be":
        video_id = parsed.path.removeprefix("/")
    elif hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"} and parsed.path == "/watch":
        video_ids = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
        video_id = video_ids[0] if len(video_ids) == 1 else ""
    else:
        raise UnsupportedVideoUrl("Only public YouTube watch URLs are supported")

    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) or video_id != expected_video_id:
        raise UnsupportedVideoUrl("URL video ID does not match the active video")

    return f"https://www.youtube.com/watch?v={video_id}"

