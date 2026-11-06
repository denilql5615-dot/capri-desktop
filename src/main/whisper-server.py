"""Local Whisper STT server with an OpenAI-compatible API for GENESIS.

POST /v1/audio/transcriptions  (multipart: file, model, language, prompt, response_format)
GET  /v1/models
Runs on 127.0.0.1:8765 only. Audio never leaves this computer.
"""
import glob
import logging
import os
import sys
import tempfile
import threading
import wave

import numpy as np

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEFAULT_LANG = os.environ.get("WHISPER_LANG", "ru")
PROMPT = "Капри, ALTA, Claude, Codex, Proton, Excel, Word, GENESIS, документ, таблица."
MODELS_DIR = os.environ.get("WHISPER_DIR", r"D:\Capri\whisper-models")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("whisper-server")
app = FastAPI()
_model = None
_lock = threading.Lock()


def _add_cuda_dlls():
    # CUDA libs installed via pip (nvidia-cublas-cu12, nvidia-cudnn-cu12) are not on PATH by default.
    if os.name != "nt":
        return
    for base in sys.path:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass


def get_model():
    global _model
    with _lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel
        if os.environ.get("CAPRI_WHISPER_DEVICE", "cpu") == "cpu":
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=MODELS_DIR)
            log.info("Whisper %s on CPU", MODEL_NAME)
            return _model
        _add_cuda_dlls()
        try:
            _model = WhisperModel(MODEL_NAME, device="cuda", compute_type="int8_float16", download_root=MODELS_DIR)
            log.info("Whisper %s on GPU", MODEL_NAME)
        except Exception as e:  # GPU not available -> CPU fallback
            log.warning("GPU failed (%s), using CPU", e)
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=MODELS_DIR)
        return _model


def _wav_samples(path):
    """PCM WAV -> 16 kHz mono float32, without PyAV. Capri always sends WAV; decoding it here sidesteps
    faster-whisper/PyAV version clashes (av 15+ dropped the `metadata_errors` argument -> every request 500)."""
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise ValueError("only 16-bit PCM WAV is supported")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if rate != 16000 and len(x):
        t = np.arange(0, len(x) * 16000 // rate) * (rate / 16000)
        x = np.interp(t, np.arange(len(x)), x).astype(np.float32)
    return x


@app.on_event("startup")
def warm():
    threading.Thread(target=get_model, daemon=True).start()


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "local"}]}


@app.get("/health")
def health():
    return {"ok": True, "loaded": _model is not None}


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...),
    model: str = Form(None),
    language: str = Form(None),
    prompt: str = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
):
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(file.file.read())
        path = tmp.name
    try:
        segments, info = get_model().transcribe(
            _wav_samples(path) if suffix.lower() == ".wav" else path,
            language=language or DEFAULT_LANG,
            initial_prompt=prompt or PROMPT,
            beam_size=5,
            vad_filter=True,
            temperature=temperature or 0.0,
        )
        text = "".join(s.text for s in segments).strip()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "verbose_json":
        return JSONResponse({"text": text, "language": info.language, "duration": info.duration})
    return JSONResponse({"text": text})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
