"""MLabs: a music studio with AI. HTML/CSS UI in a native window (pywebview), Python audio engine.
Run: python app.py"""
import base64
import json
import mimetypes
import os
import re
import threading
import time

import numpy as np
import sounddevice as sd
import webview

import ai
import engine

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")
SETTINGS = os.path.join(HERE, "settings.json")
WAV = ("WAV files (*.wav)",)
JSON = ("MLabs projects (*.json)",)
SETTING_KEYS = {"theme", "tips", "tips_seen", "export_format", "export_rate", "starred", "quickbar", "custom_plugins", "library_folders"}
DRUM_STYLES = ("kick", "snare", "hat", "clap")  # a hum for these becomes rhythm hits, the rest become notes
STYLE_PRESET = {"melody": "Lead", "guitar": "Guitar", "bass": "Bass", "keys": "Keys", "pad": "Pad"}
RECORDINGS = os.path.join(HERE, "recordings")
LIVE_NOTE_SECONDS = 4  # shortcut: a held MIDI note rings at most this long; stream voices for longer holds
IMAGES = ("Images (*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp)",)
MAX_WALLPAPER = 15 * 1024 * 1024  # the image travels to the page as base64; bigger files stall the UI


def _safe(name):
    return "".join(c if c.isalnum() else "_" for c in name)


class Player:
    """Streams a looping song buffer to the sound card and mixes live notes (MIDI keyboard) on top.
    Swapping the song buffer keeps the play position, so edits are heard without restarting the loop."""

    def __init__(self):
        self._buf = None  # None = transport stopped (live notes still sound)
        self._pos = 0     # samples played since start; read index is _pos % len(_buf)
        self._stream = None
        self.device = None
        self._voices = []  # live notes: {"key", "buf", "pos", "off"}
        self.load = 0.0
        self._vlock = threading.Lock()

    def _callback(self, out, frames, _time, _status):
        t0 = time.perf_counter()
        self._fill(out, frames)
        # audio-thread load: share of each block's time spent producing it (over 100% = dropouts)
        self.load = 0.9 * self.load + 0.1 * (time.perf_counter() - t0) / (frames / engine.SR)

    def panic(self):
        """Stop sound: song and every live note, now."""
        self._buf = None
        with self._vlock:
            self._voices = []

    def _fill(self, out, frames):
        buf = self._buf  # one reference read: a swap mid-callback can't tear the buffer
        if buf is None:
            out[:] = 0
        else:
            out[:] = buf[(self._pos + np.arange(frames)) % len(buf)]
            self._pos += frames
        if self._voices:
            with self._vlock:
                alive = []
                for v in self._voices:
                    seg = v["buf"][v["pos"]:v["pos"] + frames]
                    out[:len(seg)] += seg
                    v["pos"] += frames
                    if v["pos"] < len(v["buf"]):
                        alive.append(v)
                self._voices = alive
            np.clip(out, -1, 1, out=out)

    def _ensure(self):
        if self._stream is None:
            self._stream = sd.OutputStream(samplerate=engine.SR, channels=2, dtype="float32", latency="low",
                                           device=self.device, callback=self._callback)
            self._stream.start()

    def play(self, buf):
        if self._buf is None:
            self._pos = 0
        self._buf = buf.astype(np.float32)
        self._ensure()

    def stop(self):
        self._buf = None  # the stream stays open so a MIDI keyboard can still be played

    def set_device(self, index):
        self.device = index
        if self._stream is not None:
            self._stream.close()
            self._stream = None
            if self._buf is not None or self._voices:
                self._ensure()

    def position(self):
        return self._pos / engine.SR

    def note_on(self, key, stereo):
        self._ensure()
        with self._vlock:  # retriggering the same key replaces the old voice
            self._voices = [v for v in self._voices if v["key"] != key] + [
                {"key": key, "buf": stereo.astype(np.float32), "pos": 0, "off": False}]

    def note_off(self, key, release):
        with self._vlock:
            for v in self._voices:
                if v["key"] == key and not v["off"]:
                    end = min(len(v["buf"]), v["pos"] + max(1, int(release * engine.SR)))
                    tail = v["buf"][v["pos"]:end] * np.linspace(1, 0, end - v["pos"], dtype=np.float32)[:, None]
                    v["buf"], v["off"] = np.concatenate([v["buf"][:v["pos"]], tail]), True


class Recorder:
    """Listens to an input device (mic, guitar/keys through an audio interface): level meter, live pitch,
    and recording takes."""

    def __init__(self):
        self._stream = None
        self.device = None
        self._tail = np.zeros(8192, dtype=np.float32)  # most recent mono audio, for the tuner
        self._chunks = []
        self.recording = False
        self.level = 0.0

    def _callback(self, indata, frames, _time, _status):
        mono = indata.mean(axis=1)
        self.level = max(float(np.abs(mono).max()), self.level * 0.85)
        self._tail = np.concatenate([self._tail[frames:], mono])[-8192:]
        if self.recording:
            self._chunks.append(indata.copy())

    def open(self, device=None):
        self.close()
        self.device = device
        channels = min(2, sd.query_devices(device, "input")["max_input_channels"])
        self._stream = sd.InputStream(samplerate=engine.SR, channels=channels, dtype="float32", device=device,
                                      callback=self._callback)
        self._stream.start()

    def close(self):
        if self._stream is not None:
            self._stream.close()
            self._stream = None
        self.recording = False

    @property
    def is_open(self):
        return self._stream is not None

    def status(self):
        midi = engine.pitch_now(self._tail.copy()) if self.level > 0.01 else None
        seconds = sum(len(c) for c in self._chunks) / engine.SR if self.recording else 0
        return {"open": self.is_open, "level": round(self.level, 3), "midi": midi, "recording": self.recording,
                "seconds": round(seconds, 1)}

    def start_take(self):
        self._chunks, self.recording = [], True

    def stop_take(self):
        self.recording = False
        return np.concatenate(self._chunks) if self._chunks else None


class Api:
    """Every public method is callable from JS as window.pywebview.api.<name>(...) and returns a Promise."""

    def __init__(self):
        self._window = None  # underscore: pywebview must not expose/serialize the window object
        self._player = Player()
        self._gen = 0  # newest play request; slower, older renders are dropped
        self._lock = threading.Lock()
        self._meters, self._loop = [], 1
        self._settings_lock = threading.Lock()  # bridge calls run on parallel threads
        self._rec = Recorder()
        s = self._read_settings()
        self._player.device = s.get("output_device")
        self._rec.device = s.get("input_device")

    def _dialog(self, kind, **kw):
        res = self._window.create_file_dialog(kind, **kw)
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    # ---------- project ----------
    def new_project(self):
        return engine.new_project()

    def save(self, project):
        path = self._dialog(webview.FileDialog.SAVE, save_filename="song.mlabs.json", file_types=JSON)
        if path:
            engine.save_project(project, path)
        return path

    def open(self):
        path = self._dialog(webview.FileDialog.OPEN, file_types=JSON)
        if not path:
            return None
        return engine.load_project(path)  # upgrades older project formats

    # ---------- appearance (theme + wallpaper), remembered in settings.json ----------
    def _read_settings(self):
        try:
            with open(SETTINGS, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _update_settings(self, change):
        """Read, change, write settings as one step, so two quick UI clicks can't interleave writes."""
        with self._settings_lock:
            s = self._read_settings()
            change(s)
            tmp = SETTINGS + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(s, f, indent=1)
            os.replace(tmp, SETTINGS)  # never leave a half-written settings file

    @staticmethod
    def _image_url(path):
        if os.path.getsize(path) > MAX_WALLPAPER:
            raise ValueError("Wallpaper is over 15 MB. Pick a smaller image.")
        mime = mimetypes.guess_type(path)[0]
        if not mime or not mime.startswith("image/"):
            raise ValueError("That file is not an image.")
        with open(path, "rb") as f:
            return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"

    def settings(self):
        """{theme, wallpaper_url}. A wallpaper file that was moved or deleted is simply dropped."""
        s = self._read_settings()
        url = None
        if s.get("wallpaper"):
            try:
                url = self._image_url(s["wallpaper"])
            except (OSError, ValueError):
                pass
        return {"theme": s.get("theme", "misty"), "wallpaper_url": url,
                "tips": s.get("tips", False), "tips_seen": s.get("tips_seen", False),
                "export_format": s.get("export_format"), "export_rate": s.get("export_rate"),
                "starred": s.get("starred", []), "quickbar": s.get("quickbar"), "custom_plugins": s.get("custom_plugins", [])}

    def set_setting(self, key, value):
        if key not in SETTING_KEYS:
            raise ValueError(f"Unknown setting {key}")
        self._update_settings(lambda s: s.update({key: value}))

    def pick_wallpaper(self):
        path = self._dialog(webview.FileDialog.OPEN, file_types=IMAGES)
        if not path:
            return None
        url = self._image_url(path)
        self._update_settings(lambda s: s.update(wallpaper=path))
        return url

    def clear_wallpaper(self):
        self._update_settings(lambda s: s.pop("wallpaper", None))

    def effects(self):
        """Effect library for the mixer's FX slots: {name: {param: [min, max, default, label]}}."""
        return {name: spec for name, (_, spec) in engine.EFFECTS.items()}

    # ---------- transport / export ----------
    def play(self, project, song, pattern, metronome=False):
        """Start playback, or hot-swap the audio if already playing (live edits).
        Returns {loop, pos} in seconds so the UI playhead stays in sync, or None if a newer edit superseded this one."""
        with self._lock:
            self._gen += 1
            gen = self._gen
        audio, loop, meters = engine.mix(project, song=song, pattern=pattern)
        buf = engine.loop_buffer(audio, loop)
        if metronome:
            buf = np.clip(buf + engine.metronome(project["bpm"], loop), -1, 1)
        with self._lock:
            if gen != self._gen:
                return None
            self._player.play(buf)
            self._meters, self._loop = meters, loop
            missing = sorted(engine.failed_samples | engine.failed_plugins)
            engine.failed_samples.clear()
            engine.failed_plugins.clear()
            return {"loop": loop / engine.SR, "pos": self._player.position(), "missing": missing}

    def levels(self):
        """Post-fader peak (0..1) of every mixer track at the current play position, for the meters."""
        block = int(self._player.position() * engine.SR % self._loop) // engine.METER_BLOCK
        return [m[block] if block < len(m) else 0 for m in self._meters]

    def stop(self):
        with self._lock:
            self._gen += 1  # cancel renders still in flight
            self._player.stop()
            self._meters = []

    def panic(self):
        """Tools > Macros > Stop sound (Ctrl+H)."""
        with self._lock:
            self._gen += 1
            self._player.panic()
            self._meters = []
        sd.stop()  # sound previews too

    def perf(self):
        """Plugin performance monitor: CPU/RAM of MLabs, audio-thread load, and what each mixer track cost to render."""
        import psutil
        proc = self.__dict__.setdefault("_proc", psutil.Process())
        return {"cpu": proc.cpu_percent(interval=None) / psutil.cpu_count(), "ram_mb": round(proc.memory_info().rss / 2**20),
                "audio_load": round(self._player.load * 100, 1), "render_ms": engine.last_perf["render_ms"],
                "tracks": engine.last_perf["tracks"]}

    def export_midi(self, project, song, pattern):
        path = self._dialog(webview.FileDialog.SAVE, save_filename="song.mid", file_types=("MIDI files (*.mid)",))
        if path:
            engine.write_midi(project, path, song, int(pattern))
        return path

    # ---------- optional VST3 plugins (pedalboard add-on, GPL-3, installed by the user) ----------
    def plugins_status(self):
        import plugins
        ok = plugins.available()
        return {"available": ok, "found": plugins.scan() if ok else []}

    def pick_plugin(self):
        """Choose a .vst3 file; returns {path, name, is_instrument} after test-loading it."""
        import plugins
        if not plugins.available():
            raise ValueError("Plugin hosting is an optional add-on: run  pip install pedalboard  and restart MLabs.")
        path = self._dialog(webview.FileDialog.OPEN, file_types=("VST3 plugins (*.vst3)",))
        if not path:
            return None
        return {"path": path, **plugins.info(path)}

    def plugin_info(self, path):
        import plugins
        return {"path": path, **plugins.info(path)}

    def export_options(self):
        return {"formats": {k: v[3] for k, v in engine.EXPORT_FORMATS.items()}, "rates": list(engine.EXPORT_RATES)}

    @staticmethod
    def _check_export(fmt, rate):
        if fmt not in engine.EXPORT_FORMATS or rate not in engine.EXPORT_RATES:
            raise ValueError("Unknown export format or sample rate")
        return engine.EXPORT_FORMATS[fmt][2]

    def export(self, project, song, pattern, fmt="wav24", rate=44100):
        ext = self._check_export(fmt, rate)
        path = self._dialog(webview.FileDialog.SAVE, save_filename=f"song.{ext}", file_types=(f"{ext.upper()} (*.{ext})",))
        if path:
            engine.write_audio(path, engine.render(project, song=song, pattern=pattern)[0], fmt, rate)
        return path

    def render_pattern(self, project, pattern, name):
        """Patterns → Render as audio clip: bounce one pattern (through the mixer, tails folded into the bar)
        to a 24-bit WAV in renders/ and return its path, so it can become a sample channel."""
        audio, loop = engine.render(project, song=False, pattern=int(pattern))
        os.makedirs(os.path.join(HERE, "renders"), exist_ok=True)
        path = os.path.join(HERE, "renders", f"{_safe(name)[:30]}_{time.strftime('%Y%m%d-%H%M%S')}.wav")
        engine.write_audio(path, engine.loop_buffer(audio, loop), "wav24")
        return path

    def export_stems(self, project, song, pattern, fmt="wav24", rate=44100):
        ext = self._check_export(fmt, rate)
        folder = self._dialog(webview.FileDialog.FOLDER)
        if not folder:
            return None
        for ci, (ch, stem) in enumerate(zip(project["channels"], engine.render_stems(project, song, pattern))):
            engine.write_audio(os.path.join(folder, f"{ci + 1:02d}_{_safe(ch['name'])}.{ext}"), stem, fmt, rate)
        return folder

    # ---------- audio devices, live input (mic / instrument), MIDI keyboard notes ----------
    def audio_devices(self):
        apis = sd.query_hostapis()
        devs = [{"index": i, "name": d["name"], "api": apis[d["hostapi"]]["name"],
                 "in": d["max_input_channels"], "out": d["max_output_channels"]} for i, d in enumerate(sd.query_devices())]
        return {"outputs": [d for d in devs if d["out"] > 0], "inputs": [d for d in devs if d["in"] > 0],
                "output": self._player.device, "input": self._rec.device}

    def set_audio(self, kind, index):
        """kind 'output' or 'input'; index None = system default. Saved for next launch."""
        if index is not None:
            sd.query_devices(index, kind)  # raises a clear error for a bad/unplugged device
        if kind == "output":
            self._player.set_device(index)
        elif kind == "input":
            if self._rec.is_open:
                self._rec.open(index)
            self._rec.device = index
        else:
            raise ValueError("kind must be 'output' or 'input'")
        self._update_settings(lambda s: s.update({f"{kind}_device": index}))

    def input_open(self):
        if not self._rec.is_open:
            self._rec.open(self._rec.device)
        return self._rec.status()

    def input_close(self):
        self._rec.close()

    def input_status(self):
        """Level (0..1), live pitch as a MIDI float (None when quiet or unpitched), recording state."""
        return self._rec.status()

    def record_cancel(self):
        """Tools > Macros > Cancel recording: stop the take and throw it away."""
        self._rec.stop_take()

    def record_start(self):
        self.input_open()
        self._rec.start_take()

    def record_stop(self):
        """Save the take as a 24-bit WAV in recordings/ and return {path, seconds}, or None if nothing came in."""
        data = self._rec.stop_take()
        if data is None or len(data) < engine.SR // 10:
            return None
        os.makedirs(RECORDINGS, exist_ok=True)
        path = os.path.join(RECORDINGS, f"take_{time.strftime('%Y%m%d-%H%M%S')}.wav")
        import soundfile as sf
        sf.write(path, data, engine.SR, subtype="PCM_24")
        return {"path": path, "seconds": round(len(data) / engine.SR, 1)}

    def transcribe(self, path, bpm):
        """The AI 'hears' a take: monophonic pitch tracking -> piano-roll notes."""
        return engine.audio_to_notes(engine.read_wav(path), int(bpm))

    # ---------- perfect pitch: hum -> instrument ----------
    def hum_styles(self):
        return {"notes": [s for s in ai.HUM_STYLES if s not in DRUM_STYLES], "drums": list(DRUM_STYLES)}

    def hum_to(self, path, style, bpm):
        """Hum -> part. Melodic styles become notes for a matching synth preset; drum styles become hits.
        Returns {kind: 'notes'|'hits', preset?, notes?: [[step,len,midi,vel]], steps?: [int]}."""
        x = engine.read_wav(path)
        if style in DRUM_STYLES:
            return {"kind": "hits", "steps": engine.audio_to_hits(x, int(bpm))}
        if style not in STYLE_PRESET:
            raise ValueError(f"Unknown style {style}")
        return {"kind": "notes", "preset": STYLE_PRESET[style], "notes": engine.audio_to_notes(x, int(bpm))}

    def generate_hum(self, path, style, bpm, seconds):
        if seconds not in (4, 8, 15, 30):
            raise ValueError("Unknown length")
        out = os.path.join(HERE, "generated", f"hum_{style}_{time.strftime('%Y%m%d-%H%M%S')}.wav")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        return ai.generate_from_hum(path, style, bpm, seconds, out)

    def note_on(self, ch, midi, velocity, gain):
        """Play one live note on channel `ch` (sent from a MIDI keyboard via the page's Web MIDI)."""
        mono = engine.voice(ch, int(midi) + ch.get("pitch", 0), 0 if ch["kind"] == "sample" else LIVE_NOTE_SECONDS,
                            float(velocity), np.random.default_rng())
        ang = (ch.get("pan", 0) + 1) * np.pi / 4  # same equal-power pan the mixer uses
        g = float(gain) * ch.get("vol", 0.8)
        self._player.note_on(f"{ch['name']}:{midi}", np.stack([mono * np.cos(ang) * g, mono * np.sin(ang) * g], axis=1))

    def note_off(self, ch, midi):
        self._player.note_off(f"{ch['name']}:{midi}", ch.get("release", 0.05) if ch["kind"] == "synth" else 0.03)

    # ---------- browser: sound libraries ----------
    def synth_presets(self):
        return list(engine.SYNTH_PRESETS)

    def new_channel(self, kind, name, sample=None, preset=None):
        return engine.new_channel(kind, name, sample, preset=preset)

    def _libraries(self):
        """Sound libraries in the Browser: our samples folder plus any folders the user added (missing ones skipped)."""
        libs = {"MLabs samples": SAMPLES}
        for d in self._read_settings().get("library_folders", []):
            if os.path.isdir(d):
                name = os.path.basename(d.rstrip(os.sep + "/")) or d
                libs[d if name in libs else name] = d
        return libs

    def add_library(self):
        """Pick a folder of WAVs to show in the Sounds tab. Files are read in place, never copied."""
        path = self._dialog(webview.FileDialog.FOLDER)
        if not path:
            return None
        self._update_settings(lambda s: s.update(library_folders=sorted(set(s.get("library_folders", [])) | {path})))
        self.__dict__.pop("_index", None)  # re-walk the libraries on the next search
        return os.path.basename(path.rstrip(os.sep + "/")) or path

    def library(self, query="", source=None, limit=300, category=None, kind=None, starred_only=False):
        """Search WAVs across the sound libraries. Every word in `query` must appear in the file's folder/name.
        category = top folder (Drums, Loops, Instruments...); kind = 'oneshot' | 'loop'.
        Returns {sources, categories, total, items: [{path, name, folder, source, category, kind}]}."""
        if not hasattr(self, "_index"):  # walk the folders once per app run: ~5k files take well under a second
            os.makedirs(SAMPLES, exist_ok=True)
            self._index = []
            for src, root in self._libraries().items():
                for dirpath, _, files in os.walk(root):
                    for f in sorted(files):
                        if f.lower().endswith(".wav"):
                            rel = os.path.relpath(dirpath, root)
                            folder = "" if rel == "." else rel
                            parts = folder.split(os.sep)
                            # VCSL's top folder is just "VCSL", so its category is the next level down
                            cat = (parts[1] if len(parts) > 1 and parts[0] == "VCSL" else parts[0]) or src
                            # shortcut: loop vs one-shot is read from names ("loop"), not measured; measure when packs lack the word
                            loop = bool(re.search(r"(?<![a-z])loops?(?![a-z])", (folder + " " + f).lower()))  # not VCSL "nloop"
                            self._index.append({"path": os.path.join(dirpath, f), "name": f[:-4], "folder": folder,
                                                "source": src, "category": cat, "kind": "loop" if loop else "oneshot"})
        stars = set(self._read_settings().get("starred", [])) if starred_only else None
        words = query.lower().split()
        pool = [it for it in self._index if (not source or it["source"] == source)]
        hits = [it for it in pool if (not category or it["category"] == category) and (not kind or it["kind"] == kind)
                and (stars is None or it["path"] in stars)
                and all(w in (it["folder"] + "/" + it["name"]).lower() for w in words)]
        return {"sources": list(self._libraries()), "categories": sorted({it["category"] for it in pool}),
                "total": len(hits), "items": hits[:limit]}

    def sound_info(self, paths):
        """Duration, a 48-point waveform and BPM (from the file name) for the rows on screen. Cached per run."""
        cache = self.__dict__.setdefault("_info", {})
        out = {}
        for p in paths:
            if p not in cache:
                try:
                    x = engine.read_wav(p)
                    n = max(1, len(x) // 48)
                    peaks = np.abs(x[:n * 48]).reshape(48, n).max(axis=1) if len(x) >= 48 else np.zeros(48)
                    m = re.search(r"(?<!\d)(\d{2,3})\s*(?:bpm)?(?!\d)", os.path.basename(p), re.I)
                    bpm = int(m.group(1)) if m and 60 <= int(m.group(1)) <= 200 else None
                    cache[p] = {"seconds": round(len(x) / engine.SR, 2), "bpm": bpm,
                                "peaks": (peaks / max(peaks.max(), 1e-9)).round(2).tolist()}
                except (OSError, ValueError, EOFError):
                    cache[p] = {"seconds": None, "bpm": None, "peaks": []}
            out[p] = cache[p]
        return out

    def preview(self, path, gain=0.8):
        """Play up to 8 seconds of a sample once, on its own stream (doesn't touch the song player)."""
        sd.play(engine.read_wav(path)[:8 * engine.SR] * float(min(max(gain, 0), 1)), engine.SR, device=self._player.device)

    def preview_stop(self):
        sd.stop()

    def pick_sample(self):
        path = self._dialog(webview.FileDialog.OPEN, file_types=WAV)
        if path:
            engine.read_wav(path)  # reject unreadable files now, with a clear message, not later at play time
        return path

    # ---------- AI ----------
    def detect(self, bpm):
        """Transcribe a monophonic WAV into notes [start_step, len_steps, midi, velocity] (steps run past 16)."""
        path = self._dialog(webview.FileDialog.OPEN, file_types=WAV)
        if not path:
            return None
        return engine.audio_to_notes(engine.read_wav(path), int(bpm))

    def composer_models(self):
        return list(ai.COMPOSER_MODELS)

    def generate(self, prompt, model, seconds):
        if model not in ai.COMPOSER_MODELS or seconds not in (4, 8, 15, 30):
            raise ValueError("Unknown model or length")
        # timestamp: generating the same prompt twice must not overwrite the first clip
        out = os.path.join(HERE, "generated", f"{_safe(prompt)[:40]}_{time.strftime('%Y%m%d-%H%M%S')}.wav")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        return ai.generate_audio(prompt, seconds, out, model)

    def ai_warmup(self, which="composer"):
        """Start loading a model in the background (composer at launch, melody when PITCH opens)."""
        if which not in ("composer", "melody"):
            raise ValueError("which must be 'composer' or 'melody'")
        if which not in self.__dict__.setdefault("_warmed", set()):
            self._warmed.add(which)
            threading.Thread(target=ai.warm_up, args=(which,), daemon=True).start()

    def gen_status(self):
        return {"stage": ai.status["stage"], "elapsed": round(time.time() - ai.status["since"])}

    def ai_mix(self, project, song, pattern):
        return ai.auto_mix(project, song, pattern)

    def ai_master(self, project, song, pattern):
        return ai.auto_master(project, song, pattern)


    def boot_done(self):
        """Startup screen finished: leave full screen and fill the screen as a normal maximized window."""
        # own flag: pywebview's window.fullscreen only records the creation setting, it isn't updated on toggle
        if self._window is not None and self._window.fullscreen and not getattr(self, "_booted", False):
            self._booted = True
            self._window.toggle_fullscreen()
            self._window.maximize()


def main(api=None):
    api = api or Api()
    # the startup screen runs full screen at the display's native resolution; boot_done() then maximizes
    api._window = webview.create_window("MLabs", os.path.join(HERE, "ui", "index.html"), js_api=api,
                                        width=1440, height=900, min_size=(1100, 700), background_color="#0B0B0B",
                                        fullscreen=True)
    webview.start()


if __name__ == "__main__":
    main()
