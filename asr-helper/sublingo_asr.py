#!/usr/bin/env python3
"""SubLingo live-subtitle helper.

Listens to what your PC is playing (the PipeWire/PulseAudio "monitor" of the
default output), transcribes speech in real time with NVIDIA's
Nemotron 3.5 ASR streaming model on the GPU, and sends the text to the
SubLingo browser extension over a local WebSocket (ws://127.0.0.1:8765).

Used for Crunchyroll dubs that have no subtitle track in their own language:
DRM-protected video can't be read by the extension, but the sound coming out
of the speakers can.

Privacy: audio is only captured while the extension has asked for live
subtitles, nothing leaves this machine, and only browser extensions (not web
pages) may connect.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import queue
import re
import subprocess
import threading
import time

import numpy as np

MODEL_ID = "nvidia/nemotron-3.5-asr-streaming-0.6b"
SAMPLE_RATE = 16000

# Locales the model transcribes out of the box. Crunchyroll audio locales
# that aren't listed map to the closest one, else "auto" (language ID).
SUPPORTED = {
    "en-US", "en-GB", "es-US", "es-ES", "fr-FR", "fr-CA", "it-IT", "pt-BR",
    "pt-PT", "nl-NL", "de-DE", "tr-TR", "ru-RU", "ar-AR", "hi-IN", "ja-JP",
    "ko-KR", "vi-VN", "uk-UA", "pl-PL", "sv-SE", "cs-CZ", "zh-CN",
}
ALIASES = {"es-419": "es-US", "ar-SA": "ar-AR", "ar-ME": "ar-AR", "en-IN": "en-GB"}

# Line breaking for subtitle display.
GAP_NEW_LINE_S = 2.0  # silence (no new words) that starts a new line
MAX_LINE_CHARS = 84
# Restart the stream during a pause to keep generate()'s state bounded.
RESTART_AFTER_S = 180
RESTART_GAP_S = 1.5

log = logging.getLogger("sublingo-asr")


def normalize_lang(lang: str | None) -> str:
    if not lang:
        return "auto"
    lang = ALIASES.get(lang, lang)
    return lang if lang in SUPPORTED else "auto"


class AudioCapture:
    """Reads mono float32 audio from the default output's monitor via parec."""

    def __init__(self, device: str):
        self.device = device
        self.proc: subprocess.Popen | None = None
        self.q: "queue.Queue[np.ndarray | None]" = queue.Queue()
        self.thread: threading.Thread | None = None

    def start(self):
        if self.proc:
            return
        self.q = queue.Queue()
        self.proc = subprocess.Popen(
            [
                "parec", f"--device={self.device}", "--format=float32le",
                f"--rate={SAMPLE_RATE}", "--channels=1", "--latency-msec=30",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.thread = threading.Thread(target=self._read, args=(self.proc, self.q), daemon=True)
        self.thread.start()
        log.info("audio capture started (%s)", self.device)

    @staticmethod
    def _read(proc: subprocess.Popen, q: "queue.Queue"):
        block = SAMPLE_RATE // 50 * 4  # 20 ms of float32
        while True:
            data = proc.stdout.read(block)
            if not data:
                break
            q.put(np.frombuffer(data, dtype=np.float32).copy())
        q.put(None)

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
            log.info("audio capture stopped")


class TokenStreamer:
    """generate() streamer that reports the full decoded text after every
    token. (transformers' TextIteratorStreamer only releases a word once the
    next word starts, which delays the end of every sentence.)"""

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.ids: list[int] = []
        self.q: "queue.Queue[str | None]" = queue.Queue()

    def put(self, value):
        if hasattr(value, "shape") and len(value.shape) > 1:
            value = value[0]
        ids = value.tolist() if hasattr(value, "tolist") else list(value)
        if isinstance(ids, int):
            ids = [ids]
        if not ids:
            return
        self.ids.extend(ids)
        self.q.put(self.tokenizer.decode(self.ids, skip_special_tokens=True))

    def end(self):
        self.q.put(None)

    def __iter__(self):
        while (text := self.q.get()) is not None:
            yield text


class Transcriber:
    """Runs the streaming model on live audio and emits subtitle lines."""

    def __init__(self, on_line, device: str, chunk_lookahead: int):
        from transformers import AutoModelForRNNT, AutoProcessor

        log.info("loading %s …", MODEL_ID)
        self.processor = AutoProcessor.from_pretrained(MODEL_ID)
        self.model = AutoModelForRNNT.from_pretrained(MODEL_ID).to("cuda")
        self.model.eval()
        self.processor.set_num_lookahead_tokens(chunk_lookahead)
        log.info("model ready (streaming latency %s ms)", self.processor.streaming_latency_ms)

        self.on_line = on_line  # callback(text: str, final: bool)
        self.capture = AudioCapture(device)
        self.lang = "de-DE"
        self.active = threading.Event()
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    # --- control (called from the asyncio thread) ---------------------
    def start(self, lang: str):
        self.lang = normalize_lang(lang)
        if not self.active.is_set():
            log.info("live subtitles ON (language %s)", self.lang)
            self.capture.start()
            self.active.set()

    def stop(self):
        if self.active.is_set():
            log.info("live subtitles OFF")
            self.active.clear()
            self.capture.stop()

    # --- streaming loop ------------------------------------------------
    def _pull(self, n: int, buf: list) -> np.ndarray | None:
        """Block until n samples are buffered; None when capture stops."""
        have = sum(len(b) for b in buf)
        while have < n:
            if not self.active.is_set():
                return None
            try:
                block = self.capture.q.get(timeout=0.2)
            except queue.Empty:
                continue
            if block is None:
                return None
            buf.append(block)
            have += len(block)
        return np.concatenate(buf) if len(buf) > 1 else buf[0]

    def _run(self):
        import torch
        p = self.processor
        hop = p.feature_extractor.hop_length
        n_fft = p.feature_extractor.n_fft
        while True:
            self.active.wait()
            # One generate() session; ends on stop or on a long-run pause.
            audio_buf: list = []
            first = self._pull(p.num_samples_first_audio_chunk, audio_buf)
            if first is None:
                continue
            audio = first  # all audio of this session (bounded by restarts)
            lang = self.lang
            state = {"last_token": time.monotonic(), "started": time.monotonic()}

            first_inputs = p(
                audio[: p.num_samples_first_audio_chunk], sampling_rate=SAMPLE_RATE,
                is_streaming=True, is_first_audio_chunk=True, language=lang, return_tensors="pt",
            ).to(self.model.device, dtype=self.model.dtype)

            def features(first_inputs=first_inputs, lang=lang):
                # `audio` holds samples from absolute index `base` onward;
                # windows are addressed in absolute sample positions.
                nonlocal audio
                base = 0
                yield first_inputs.input_features[:, : p.num_mel_frames_first_audio_chunk, :]
                mel_idx = p.num_mel_frames_first_audio_chunk
                while True:
                    start = mel_idx * hop - n_fft // 2
                    end = start + p.num_samples_per_audio_chunk
                    if base + audio.shape[0] < end:
                        more = self._pull(end - (base + audio.shape[0]), [])
                        if more is None:
                            return
                        audio = np.concatenate([audio, more])
                    now = time.monotonic()
                    if (now - state["started"] > RESTART_AFTER_S
                            and now - state["last_token"] > RESTART_GAP_S):
                        return  # restart at a pause to keep state bounded
                    inputs = p(
                        audio[start - base:end - base], sampling_rate=SAMPLE_RATE, is_streaming=True,
                        is_first_audio_chunk=False, language=lang, return_tensors="pt",
                    ).to(self.model.device, dtype=self.model.dtype)
                    yield inputs.input_features
                    mel_idx += p.num_mel_frames_per_audio_chunk
                    # Forget audio before the next window's start.
                    next_start = mel_idx * hop - n_fft // 2
                    if next_start - base > SAMPLE_RATE * 10:
                        audio = audio[next_start - base:]
                        base = next_start

            streamer = TokenStreamer(p.tokenizer)
            kwargs = {**first_inputs, "input_features": features(), "streamer": streamer}

            def generate():
                try:
                    with torch.inference_mode():
                        self.model.generate(**kwargs)
                except Exception:
                    log.exception("generate failed")
                    streamer.end()

            gen = threading.Thread(target=generate, daemon=True)
            gen.start()

            # `full` is everything decoded this session; the current subtitle
            # line is full[line_start:]. Lines only break at word boundaries.
            line_start = 0
            shown = ""  # raw text of the current line as last sent
            for full in streamer:
                full = re.sub(r"\s*<[a-z]{2}-[A-Z]{2}>", "", full)
                now = time.monotonic()
                gap = now - state["last_token"]
                state["last_token"] = now

                if shown.strip() and (gap > GAP_NEW_LINE_S or re.search(r"[.!?…]\s*$", shown)):
                    boundary = line_start + len(shown)
                    if boundary == len(full) or (boundary < len(full) and full[boundary].isspace()):
                        self.on_line(shown.strip(), True)
                        line_start = boundary
                cur = full[line_start:]
                if len(cur.strip()) > MAX_LINE_CHARS:
                    cut = cur.rfind(" ", 0, MAX_LINE_CHARS)
                    if cut > 0:
                        self.on_line(cur[:cut].strip(), True)
                        line_start += cut
                        cur = full[line_start:]
                shown = cur
                if cur.strip():
                    self.on_line(cur.strip(), False)
            if shown.strip():
                self.on_line(shown.strip(), True)
            gen.join()


class Server:
    def __init__(self, args):
        self.args = args
        self.clients: dict = {}  # connection -> {"live": bool, "lang": str}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.transcriber: Transcriber | None = None

    def emit_line(self, text: str, final: bool):
        if self.loop:
            self.loop.call_soon_threadsafe(self._broadcast, {"type": "line", "text": text, "final": final})

    def _broadcast(self, msg: dict):
        data = json.dumps(msg, ensure_ascii=False)
        for ws, st in list(self.clients.items()):
            if st["live"]:
                asyncio.ensure_future(self._safe_send(ws, data))

    @staticmethod
    async def _safe_send(ws, data):
        try:
            await ws.send(data)
        except Exception:
            pass

    def _update_capture(self):
        live = [st for st in self.clients.values() if st["live"]]
        if live:
            self.transcriber.start(live[-1]["lang"])
        else:
            self.transcriber.stop()

    async def handler(self, ws):
        self.clients[ws] = {"live": False, "lang": "de-DE"}
        try:
            await ws.send(json.dumps({"type": "hello", "model": MODEL_ID}))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if msg.get("type") == "start":
                    self.clients[ws] = {"live": True, "lang": msg.get("lang") or "de-DE"}
                elif msg.get("type") == "stop":
                    self.clients[ws]["live"] = False
                self._update_capture()
        finally:
            self.clients.pop(ws, None)
            self._update_capture()

    @staticmethod
    def check_origin(connection, request):
        # Only browser extensions may connect — never ordinary web pages,
        # which could otherwise listen in on whatever the PC is playing.
        origin = request.headers.get("Origin", "")
        if origin.startswith(("moz-extension://", "chrome-extension://")):
            return None
        return connection.respond(403, "forbidden origin\n")

    async def main(self):
        from websockets.asyncio.server import serve

        self.loop = asyncio.get_running_loop()
        self.transcriber = Transcriber(self.emit_line, self.args.device, self.args.lookahead)
        async with serve(self.handler, "127.0.0.1", self.args.port, process_request=self.check_origin):
            log.info("listening on ws://127.0.0.1:%d", self.args.port)
            await asyncio.Future()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="@DEFAULT_MONITOR@",
                    help="PulseAudio/PipeWire source to capture (default: monitor of default output)")
    ap.add_argument("--lookahead", type=int, default=3, choices=[0, 3, 6, 13],
                    help="lookahead tokens: 3 = ~0.3 s chunks (default), 6/13 = more context, more delay")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(Server(args).main())


if __name__ == "__main__":
    main()
