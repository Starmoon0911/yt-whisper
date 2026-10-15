import unicodedata
from typing import Any, Iterable, TypedDict


class SubtitleCue(TypedDict):
    startMs: int
    endMs: int
    text: str


_SENTENCE_ENDINGS = frozenset(".!?。！？")


def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1 for char in text)


def _bounded_words(
    words: Iterable[dict[str, Any]], max_duration_s: float, max_display_width: int,
) -> Iterable[dict[str, Any]]:
    """Split wide tokens by character count and clamp each piece's duration.

    Each character receives an equal share of the original time interval. Clamping
    may leave a gap, but never repeats text to fill an unusually long word interval.
    """
    for word in words:
        text = str(word.get("word", ""))
        if not text.strip():
            continue
        boundaries = [0]
        width = 0
        for index, char in enumerate(text):
            char_width = _display_width(char)
            if width + char_width > max_display_width and index > boundaries[-1]:
                boundaries.append(index)
                width = 0
            width += char_width
        boundaries.append(len(text))
        start, end = float(word["start"]), float(word["end"])
        for first, last in zip(boundaries, boundaries[1:]):
            piece_start = start + (end - start) * first / len(text)
            piece_end = start + (end - start) * last / len(text)
            yield {
                "word": text[first:last],
                "start": piece_start,
                "end": min(piece_end, piece_start + max_duration_s),
            }


def make_cues(
    words: Iterable[dict[str, Any]],
    *,
    max_duration_s: float = 6,
    max_display_width: int = 84,
) -> list[SubtitleCue]:
    cues: list[SubtitleCue] = []
    group: list[dict[str, Any]] = []

    def flush() -> None:
        text = "".join(str(word["word"]) for word in group).strip()
        if text:
            cues.append(
                {
                    "startMs": round(float(group[0]["start"]) * 1000),
                    "endMs": round(float(group[-1]["end"]) * 1000),
                    "text": text,
                }
            )
        group.clear()

    for word in _bounded_words(words, max_duration_s, max_display_width):
        text = str(word.get("word", ""))
        if not text.strip():
            continue

        combined = "".join(str(item["word"]) for item in (*group, word)).strip()
        too_wide = bool(group) and _display_width(combined) > max_display_width
        too_long = bool(group) and float(word["end"]) - float(group[0]["start"]) > max_duration_s
        if too_wide or too_long:
            flush()

        group.append(word)
        if text.rstrip().endswith(tuple(_SENTENCE_ENDINGS)):
            flush()

    flush()
    return cues
