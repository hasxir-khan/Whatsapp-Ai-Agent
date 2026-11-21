# Synthetic media fixtures

All speech scripts, drawings, labels and scenarios here are original test material, dedicated to the public domain under **CC0-1.0**. No customer uploads, photographed people, cloned voices, stock footage, commercial music, provider recordings or scraped media. The signs, lamp, parcel and shop entrance are simple Pillow drawings. eSpeak NG synthesizes the spoken strings; ffmpeg encodes the audio and video. The noisy case adds seeded pink noise. The corrupt case is deliberately only a truncated container header.

- [`manifest.json`](manifest.json): one entry per original clip, source segments or scene, tags, seeded conversation/script and expected language, gist and handling. Urdu does not have a separate “Roman” spoken language: that case uses Urdu speech and a Roman Urdu text preference. The Punjabi-influenced and code-switched clips are **synthesized**, not recordings of human accents.
- [`recordings.json`](recordings.json): **authored** Whisper/vision/chat/Urdu-script adapter responses and measured fixture durations for repeatable replay. `tts/` contains generated reply audio. These are not traces of real API accuracy. `wrong-detector` deliberately replaces only the detector code, including after actual STT in live mode.
- With ffmpeg, recorded evaluation downloads the fixture through a fake transport and exercises the real private handler, extraction, provider adapters, reply channel and Opus conversion. Without ffmpeg it explicitly labels the probe/frame/audio extraction as **replayed** and uses text fallback. This replay is never used to interpret customer media or in `--live` mode.
- Quality is the production transcript heuristic, not WER. Gist tests the manifest's concept groups against the transcript/observation and, where specified, the delivered answer. For unusable media the requested clarification/resend is scored instead; the JSON report identifies the basis. Latency is local elapsed wall time for that run. No claim here about pronunciation or human comprehension.

## Regenerate

Use a modern ffmpeg with `libopus`, `libmp3lame`, `libx264` and the `select`/`volumedetect` filters. Run from the repository root, in a disposable Python environment:

```sh
python -m pip install 'espeakng-loader==0.2.4' 'Pillow==13.0.0'
python test/fixtures/media/generate.py    # ffmpeg on PATH, or set FFMPEG_PATH
npm run eval -- --media
```

The generator works in a temporary directory and writes only the fixture media, reference image, reply audio and duration fields. Binary encodings may differ across codec builds. Updating words or scenes also requires reviewing the authored recordings and expected gist; don't regenerate expectations from a model's answer. For real-provider or device checks use only these fixtures or **consented, rights-clear** recordings; do not commit private conversations or provider credentials.
