"""Persistent local speech-to-text worker for the JARVIS desktop app."""

from __future__ import annotations

import json
import math
import os
import re
import sys

from faster_whisper import WhisperModel


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def main() -> None:
    model_name = os.environ.get("JARVIS_WHISPER_MODEL") or os.environ.get("JERVIS_WHISPER_MODEL", "base.en")
    device = os.environ.get("JARVIS_WHISPER_DEVICE") or os.environ.get("JERVIS_WHISPER_DEVICE", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    min_confidence = float(os.environ.get("JARVIS_WHISPER_MIN_CONFIDENCE") or os.environ.get("JERVIS_WHISPER_MIN_CONFIDENCE", "0.3"))
    no_speech_threshold = float(os.environ.get("JARVIS_WHISPER_NO_SPEECH_THRESHOLD") or os.environ.get("JERVIS_WHISPER_NO_SPEECH_THRESHOLD", "0.5"))
    emit({"type": "ready", "model": model_name, "device": device})

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            audio_path = str(request["path"])
            segments, info = model.transcribe(
                audio_path,
                language="en",
                beam_size=3,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400},
                condition_on_previous_text=False,
                hotwords="Jarvis JARVIS",
            )
            segments = list(segments)
            accepted = [
                segment for segment in segments
                if math.exp(segment.avg_logprob) >= min_confidence
                and segment.no_speech_prob < no_speech_threshold
            ]
            if not accepted:
                raw_text = " ".join(segment.text.strip() for segment in segments).strip()
                isolated_wake = re.fullmatch(
                    r"(?:wake\s+up\s+)?(?:jarvis|jarves|jarviss|service|travis)[.!?,\s]*",
                    raw_text,
                    flags=re.IGNORECASE,
                )
                if isolated_wake:
                    accepted = [
                        segment for segment in segments
                        if math.exp(segment.avg_logprob) >= 0.05 and segment.no_speech_prob < 0.9
                    ]
            text = " ".join(segment.text.strip() for segment in accepted).strip()
            confidence = sum(math.exp(segment.avg_logprob) for segment in accepted) / len(accepted) if accepted else 0.0
            emit({
                "type": "result",
                "id": request_id,
                "text": text,
                "language": info.language,
                "confidence": confidence,
            })
        except Exception as error:
            emit({
                "type": "error",
                "id": str(locals().get("request_id", "")),
                "error": str(error),
            })


if __name__ == "__main__":
    main()
