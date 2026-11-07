# SubLingo live-subtitle helper

Transcribes what your PC is playing with NVIDIA's Nemotron 3.5 ASR
(streaming, runs on the GPU) and sends the text to the SubLingo extension.
SubLingo uses it automatically on Crunchyroll dubs that have no [CC] track
in their own language.

- Listens on `ws://127.0.0.1:8765`; only browser extensions may connect.
- Captures audio (the default output's monitor) only while SubLingo asks
  for live subtitles; nothing leaves this machine.

## Setup

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python sublingo_asr.py      # first run downloads the model (~2.5 GB)
```

## Autostart (systemd user service)

```sh
systemctl --user enable --now sublingo-asr     # start now and at login
systemctl --user status sublingo-asr
journalctl --user -u sublingo-asr -f           # live log
systemctl --user disable --now sublingo-asr    # turn off
```

Options: `--lookahead 3` (default, ~0.3 s audio chunks), `6` or `13` (more
context, more delay); `--device <source>` to capture a different output.

Latency: text is sent after every decoded token (not per finished word), so a
word appears while it's being said rather than once the next word starts.
On a German test clip this put words on screen ~0.7–1.3 s earlier than the
first version.
