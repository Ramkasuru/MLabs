"""MLabs audio engine: project model, synthesis, rendering, WAV I/O, pitch detection.

Project layout:
  channels  - the Step Rack: one instrument per row, shared by every pattern
  patterns  - per-channel step sequences + piano-roll notes, one bar of 16 steps
  playlist  - pattern clips placed on tracks/bars to form the song
  mixer     - insert tracks (0 = Master). Channels feed an insert; inserts run 10 FX slots + EQ,
              then route to Master or another insert (group bus)
"""
import json
import time
import wave

import numpy as np

SR = 44100
STEPS = 16
DRUMS = ('kick', 'snare', 'hat', 'clap', '808', 'tom', 'rim', 'openhat', 'crash', 'cowbell', 'shaker')
INSTRUMENTS = DRUMS + ("synth", "sample")


N_INSERTS = 16
FX_SLOTS = 10


def new_channel(kind, name=None, sample_path=None, insert=0, preset=None):
    ch = {"name": name or kind.title(), "kind": kind, "vol": 0.8, "pan": 0.0,
          "sample": sample_path, "pitch": 0, "insert": insert}
    return ch | SYNTH_DEFAULTS | (SYNTH_PRESETS.get(preset) or {}) if kind == "synth" else ch


def new_insert(name, route=0):
    return {"name": name, "vol": 0.8, "pan": 0.0, "mute": False, "solo": False, "route": route,
            "fx": [None] * FX_SLOTS, "eq": {"low": 0.0, "mid": 0.0, "high": 0.0}}


def new_pattern(n_channels):
    return {"steps": [[False] * STEPS for _ in range(n_channels)],
            "notes": [[] for _ in range(n_channels)]}  # note = [start_step, len_steps, midi, velocity]


def new_project():
    kinds = ("kick", "snare", "hat", "clap", "synth")
    chans = [new_channel(k, insert=i + 1) for i, k in enumerate(kinds)]  # each channel on its own insert
    mixer = [new_insert("Master", None)] + [new_insert(f"Insert {i}") for i in range(1, N_INSERTS + 1)]
    mixer[0]["vol"] = 0.9
    for ch in chans:
        mixer[ch["insert"]]["name"] = ch["name"]
    return {"bpm": 120, "swing": 0.0, "channels": chans, "mixer": mixer,
            "patterns": [new_pattern(len(chans))], "playlist": [{"pattern": 0, "track": 0, "bar": 0}]}


def normalize_project(p):
    """Upgrade projects saved by older MLabs versions in place: pattern-order playlists become clips,
    per-channel fx dicts become effect slots on that channel's own insert track."""
    p["playlist"] = clips(p)
    p.setdefault("swing", 0.0)
    if "mixer" not in p:
        p["mixer"] = [new_insert("Master", None)] + [new_insert(f"Insert {i}") for i in range(1, N_INSERTS + 1)]
        p["mixer"][0]["vol"] = p.pop("master", 0.9)
        for ci, ch in enumerate(p["channels"]):
            if ci + 1 > N_INSERTS:
                break
            tr, fx = p["mixer"][ci + 1], ch.get("fx", {})
            tr["name"], ch["insert"] = ch["name"], ci + 1
            old = [("Drive", fx.get("drive", 0) > 0, {"amount": fx.get("drive", 0)}),
                   ("Low-pass", fx.get("cutoff", 1) < 1, {"cutoff": fx.get("cutoff", 1)}),
                   ("Delay", fx.get("delay", 0) > 0, {"feedback": 0.6 * fx.get("delay", 0), "mix": 0.5}),
                   ("Reverb", fx.get("reverb", 0) > 0, {"mix": fx.get("reverb", 0) * 0.5})]
            tr["fx"] = ([new_slot(k, **kw) for k, used, kw in old if used] + [None] * FX_SLOTS)[:FX_SLOTS]
    for ch in p["channels"]:
        ch.pop("fx", None)
        ch.setdefault("insert", 0)
        ch.setdefault("pitch", 0)
        if ch["kind"] == "synth":
            for k, v in SYNTH_DEFAULTS.items():
                ch.setdefault(k, v)
    return p


def clips(project):
    """Playlist clips [{pattern, track, bar}]. Older projects stored a plain pattern order like [0, 1, 0]."""
    pl = project["playlist"]
    if pl and isinstance(pl[0], int):
        return [{"pattern": p, "track": 0, "bar": i} for i, p in enumerate(pl)]
    return pl


def add_channel(project, ch):
    project["channels"].append(ch)
    for p in project["patterns"]:
        p["steps"].append([False] * STEPS)
        p["notes"].append([])


def step_seconds(bpm):
    return 60.0 / bpm / 4  # a step is a 16th note


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------- synthesis ----------

def _env(n, decay):
    return np.exp(-np.arange(n) / SR * decay)


def drum(kind, rng):
    if kind == "kick":
        n = int(0.45 * SR)
        t = np.arange(n) / SR
        freq = 50 + 100 * np.exp(-t * 30)  # pitch sweep 150 -> 50 Hz
        return np.sin(2 * np.pi * np.cumsum(freq) / SR) * _env(n, 7)
    if kind == "snare":
        n = int(0.25 * SR)
        t = np.arange(n) / SR
        return 0.6 * rng.uniform(-1, 1, n) * _env(n, 18) + 0.5 * np.sin(2 * np.pi * 185 * t) * _env(n, 25)
    if kind == "hat":
        n = int(0.06 * SR)
        return np.diff(rng.uniform(-1, 1, n + 1)) * 0.4 * _env(n, 60)  # diff = crude high-pass
    if kind == "clap":
        n = int(0.2 * SR)
        out = rng.uniform(-1, 1, n) * _env(n, 22) * 0.7
        for d in (0.0, 0.012, 0.024):  # three quick bursts
            i = int(d * SR)
            out[i:i + 300] *= 2.0
        return out
    if kind == "808":  # long sub kick: sine with a short pitch drop and a little saturation
        n = int(1.2 * SR)
        t = np.arange(n) / SR
        freq = 48 + 70 * np.exp(-t * 40)
        return np.tanh(1.6 * np.sin(2 * np.pi * np.cumsum(freq) / SR)) * _env(n, 2.2) * 0.8
    if kind == "tom":
        n = int(0.5 * SR)
        t = np.arange(n) / SR
        freq = 110 + 60 * np.exp(-t * 18)
        return np.sin(2 * np.pi * np.cumsum(freq) / SR) * _env(n, 7) * 0.9 + rng.uniform(-1, 1, n) * _env(n, 60) * 0.1
    if kind == "rim":
        n = int(0.06 * SR)
        t = np.arange(n) / SR
        return (np.sin(2 * np.pi * 1700 * t) + 0.6 * np.sin(2 * np.pi * 820 * t)) * _env(n, 90) * 0.6
    if kind in ("openhat", "crash"):
        n = int((0.45 if kind == "openhat" else 1.6) * SR)
        return np.diff(rng.uniform(-1, 1, n + 1)) * 0.35 * _env(n, 9 if kind == "openhat" else 2.5)
    if kind == "cowbell":  # the classic two detuned square tones
        n = int(0.35 * SR)
        t = np.arange(n) / SR
        sq = lambda f: np.where((t * f) % 1 < 0.5, 1.0, -1.0)
        return (sq(540) + sq(800)) * 0.22 * _env(n, 12)
    if kind == "shaker":
        n = int(0.12 * SR)
        swell = np.minimum(np.arange(n) / (0.03 * SR), 1) * _env(n, 30)
        return np.diff(rng.uniform(-1, 1, n + 1)) * 0.4 * swell
    raise ValueError(kind)


SYNTH_DEFAULTS = {"wave": "saw", "detune": 0, "octave": 0, "attack": 0.005, "decay": 0.1, "sustain": 1.0,
                  "release": 0.05, "cutoff": 1.0, "env": 0.0}
SYNTH_PRESETS = {  # name -> synth settings; shown in the Browser's Instruments tab
    "Pluck": {"wave": "saw", "detune": 8, "attack": 0.002, "decay": 0.18, "sustain": 0.0, "release": 0.12, "cutoff": 0.45, "env": 0.9},
    "Pad": {"wave": "saw", "detune": 18, "attack": 0.35, "decay": 0.5, "sustain": 0.8, "release": 0.8, "cutoff": 0.55, "env": 0.3},
    "Bass": {"wave": "square", "octave": -1, "attack": 0.003, "decay": 0.15, "sustain": 0.7, "release": 0.06, "cutoff": 0.35, "env": 0.5},
    "Lead": {"wave": "saw", "detune": 10, "attack": 0.01, "decay": 0.2, "sustain": 0.75, "release": 0.15, "cutoff": 0.7, "env": 0.4},
    "Keys": {"wave": "square", "detune": 4, "attack": 0.004, "decay": 0.4, "sustain": 0.35, "release": 0.3, "cutoff": 0.5, "env": 0.6},
    "Guitar": {"wave": "pluck", "attack": 0.001, "decay": 0.1, "sustain": 1.0, "release": 0.25, "cutoff": 0.78, "env": 0.0},
    "E-Piano": {"wave": "epiano", "attack": 0.002, "decay": 1.2, "sustain": 0.25, "release": 0.35},
    "Organ": {"wave": "organ", "attack": 0.01, "decay": 0.1, "sustain": 1.0, "release": 0.08},
    "Bell": {"wave": "bell", "attack": 0.001, "decay": 2.0, "sustain": 0.0, "release": 0.8},
    "Marimba": {"wave": "marimba", "attack": 0.001, "decay": 0.45, "sustain": 0.0, "release": 0.2},
    "Harp": {"wave": "pluck", "attack": 0.001, "decay": 0.1, "sustain": 1.0, "release": 0.6, "cutoff": 0.6, "env": 0.0},
    "Strings": {"wave": "saw", "detune": 14, "attack": 0.45, "decay": 0.3, "sustain": 0.9, "release": 0.6, "cutoff": 0.5, "env": 0.2},
    "Brass": {"wave": "saw", "detune": 6, "attack": 0.06, "decay": 0.3, "sustain": 0.8, "release": 0.12, "cutoff": 0.4, "env": 0.8},
    "Supersaw": {"wave": "saw", "detune": 28, "attack": 0.005, "decay": 0.3, "sustain": 0.85, "release": 0.3, "cutoff": 0.8, "env": 0.2},
    "Soft Pad": {"wave": "tri", "detune": 10, "attack": 0.6, "decay": 0.5, "sustain": 0.85, "release": 1.0},
    "Sub Bass": {"wave": "sine", "octave": -1, "attack": 0.004, "decay": 0.1, "sustain": 1.0, "release": 0.06},
    "Reese Bass": {"wave": "saw", "octave": -1, "detune": 24, "attack": 0.005, "decay": 0.2, "sustain": 0.9, "release": 0.1, "cutoff": 0.4, "env": 0.1},
    "Chip Lead": {"wave": "square", "attack": 0.001, "decay": 0.05, "sustain": 0.8, "release": 0.04},
}
FM_WAVES = {"epiano": (1.0, 1.8, 3.0), "bell": (3.5, 3.0, 1.2), "marimba": (4.0, 1.4, 14.0)}  # ratio, index, index decay /s
ORGAN_DRAWBARS = ((1, 1.0), (2, 0.6), (3, 0.35), (4, 0.25), (8, 0.15))  # harmonic, level


def synth(wave_shape, midi, seconds, velocity=1.0, detune=0.0, attack=0.005, decay=0.1, sustain=1.0,
          release=0.05, cutoff=1.0, env=0.0):
    """Up to three oscillators (center, -detune, +detune cents) (or FM / organ / plucked-string models), an ADSR volume envelope,
    and a low-pass whose brightness opens with the envelope (env = how much)."""
    n = int(seconds * SR)
    rel = max(1, int(release * SR))
    t = np.arange(n + rel) / SR
    x = np.zeros(n + rel)
    cents = () if wave_shape == "pluck" else (0.0, -detune, detune) if detune else (0.0,)
    if wave_shape == "pluck":  # Karplus-Strong plucked string: a noise burst through a decaying delay line
        period = max(2, round(SR / midi_hz(midi)))
        loss = 10 ** (-2 / (3.0 * midi_hz(midi)))  # about -40 dB after 3 s, like a guitar string
        x[:period] = np.random.default_rng(int(midi)).uniform(-1, 1, period)[:len(x)] * 0.6
        for s in range(period, len(x), period):  # one period per step keeps it vectorized
            prev = x[s - period:s]
            x[s:s + period] = (0.5 * (prev + np.roll(prev, -1)) * loss)[:len(x) - s]
        cents = ()
    for c in cents:
        phase = (t * midi_hz(midi) * 2 ** (c / 1200)) % 1.0
        if wave_shape == "sine":
            x += np.sin(2 * np.pi * phase)
        elif wave_shape == "tri":
            x += (1 - 4 * np.abs(phase - 0.5)) * 0.8
        elif wave_shape == "organ":
            x += sum(lvl * np.sin(2 * np.pi * phase * k) for k, lvl in ORGAN_DRAWBARS) * 0.45
        elif wave_shape in FM_WAVES:  # 2-operator FM: the modulator's index fades, so the tone mellows like a struck key
            ratio, index, fade = FM_WAVES[wave_shape]
            mod = np.sin(2 * np.pi * t * midi_hz(midi) * 2 ** (c / 1200) * ratio) * index * np.exp(-t * fade)
            x += np.sin(2 * np.pi * phase + mod) * 0.8
        elif wave_shape == "square":
            x += np.where(phase < 0.5, 0.6, -0.6)
        else:
            x += (2 * phase - 1) * 0.6
    x /= max(1, len(cents))
    adsr = np.empty(n + rel)
    a = min(int(attack * SR), n)
    d = min(int(decay * SR), n - a)
    adsr[:a] = np.linspace(0, 1, a)
    adsr[a:a + d] = np.linspace(1, sustain, d)
    adsr[a + d:n] = sustain
    adsr[n:] = np.linspace(adsr[n - 1] if n else 0, 0, rel)  # release from wherever the note was
    if cutoff < 1:
        f = np.fft.rfftfreq(len(x), 1 / SR)
        dark = np.fft.irfft(np.fft.rfft(x) / np.sqrt(1 + (f / (20 * 1000 ** cutoff)) ** 4), len(x))
        x = dark + (x - dark) * np.clip(env * adsr, 0, 1)  # shortcut: crossfade, not a true moving filter
    return x * adsr * velocity * 0.5


def sampler(data, midi, seconds):
    """Play a sample, pitched relative to C5 (midi 60) by resampling; cut at note end."""
    ratio = 2 ** ((midi - 60) / 12)
    idx = np.arange(0, len(data) - 1, ratio)
    out = np.interp(idx, np.arange(len(data)), data)
    return out[:int(seconds * SR)] if seconds else out


_sample_cache = {}
SAMPLER_DEFAULTS = {"start": 0.0, "end": 1.0, "reverse": False, "normalize": False, "dc": False,
                    "fade_in": 0.0, "fade_out": 0.0, "cut": False}  # per-channel sampler settings


def shape_sample(data, smp):
    """Apply a sample channel's settings: trim start/end (0..1 of the file), remove DC offset, reverse,
    normalize, fade in/out (seconds)."""
    if not smp:
        return data
    o = SAMPLER_DEFAULTS | smp
    n = len(data)
    a, b = int(n * min(o["start"], o["end"])), int(n * max(o["start"], o["end"]))
    x = data[a:max(b, a + 1)].copy()
    if o["dc"]:
        x -= x.mean()
    if o["reverse"]:
        x = x[::-1]
    if o["normalize"]:
        x /= max(np.abs(x).max(), 1e-9)
    for secs, ramp, sl in ((o["fade_in"], np.linspace(0, 1, max(1, int(o["fade_in"] * SR))), slice(0, None)),
                           (o["fade_out"], np.linspace(1, 0, max(1, int(o["fade_out"] * SR))), slice(None, None))):
        k = min(len(x), int(secs * SR))
        if k:
            if sl.start == 0:
                x[:k] *= ramp[:k]
            else:
                x[-k:] *= ramp[-k:]
    return x
failed_samples = set()  # sample paths that could not be loaded; the app reports and clears these
failed_plugins = set()  # VST3 paths that failed to load or run (optional pedalboard add-on)
last_perf = {"render_ms": 0.0, "tracks": {}}  # filled by mix(): what each mixer track cost to render


def load_sample(path):
    if path not in _sample_cache:
        _sample_cache[path] = read_wav(path)
    return _sample_cache[path]


def voice(ch, midi, seconds, velocity, rng):
    if ch["kind"] == "synth":
        s = SYNTH_DEFAULTS | {k: ch[k] for k in SYNTH_DEFAULTS if k in ch}
        return synth(s["wave"], midi + 12 * round(s["octave"]), seconds, velocity, s["detune"], s["attack"], s["decay"],
                     s["sustain"], s["release"], s["cutoff"], s["env"])
    if ch["kind"] == "sample":
        if not ch.get("sample"):
            return np.zeros(1)
        try:
            data = load_sample(ch["sample"])
        except (OSError, ValueError, EOFError, wave.Error):
            failed_samples.add(ch["sample"])  # one moved/unsupported file must not silence the whole song
            return np.zeros(1)
        # step hits play the whole sample, piano-roll notes are cut to note length
        return sampler(shape_sample(data, ch.get("smp")), midi, seconds) * velocity
    if ch["kind"] == "midiout":  # notes go to an external MIDI device from the UI, not into the mix
        return np.zeros(1)
    if ch["kind"] == "vst":
        try:
            import plugins
            return plugins.render_note(ch["plugin"], midi, seconds or 0.25, velocity, SR)
        except Exception:  # optional add-on: a missing pedalboard or broken plugin plays silence and is reported
            failed_plugins.add(ch.get("plugin", "?"))
            return np.zeros(1)
    return drum(ch["kind"], rng) * velocity


# ---------- insert effects ----------

def _fft_convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:n]


_IRS = {}


def _reverb_ir(size):
    """Stereo noise impulse response decaying 60 dB over `size` seconds (L/R decorrelated for width)."""
    key = round(size, 1)
    if key not in _IRS:
        n = int(key * SR)
        decay = np.exp(-np.arange(n) / SR * 6.9 / key)
        ir = np.random.default_rng(1).uniform(-1, 1, (n, 2)) * decay[:, None]
        _IRS[key] = ir / np.sqrt(np.sum(ir ** 2, axis=0))
    return _IRS[key]


def _spectral(x, gain):
    """Apply a zero-phase magnitude response gain(f) to a stereo buffer (offline, so FFT is fine)."""
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x, axis=0) * gain(np.maximum(f, 1e-3))[:, None], len(x), axis=0)


def _cutoff_hz(knob):
    return 20 * 1000 ** knob  # knob 0..1 -> 20 Hz..20 kHz, log


def _smooth(v, n):
    """Centered moving average over n samples. Centered = look-ahead, which offline rendering allows,
    so compressors catch the transient instead of reacting after it."""
    c = np.cumsum(np.concatenate([np.zeros(n), v]))
    causal = (c[n:] - c[:-n]) / n
    return np.concatenate([causal[n // 2:], np.full(n // 2, causal[-1])])


def _compress(x, threshold, ratio, makeup, window, release=None, knee=0.0):
    """Feed-forward compressor. window = attack (detector) in samples, release = gain smoothing in samples."""
    level = np.sqrt(_smooth(np.max(x ** 2, axis=1), max(1, window))) + 1e-9
    over = 20 * np.log10(level) - threshold
    if knee > 0:  # soft knee: ease into compression over `knee` dB around the threshold
        over = np.where(over < -knee / 2, 0, np.where(over > knee / 2, over, (over + knee / 2) ** 2 / (2 * knee)))
    else:
        over = np.maximum(over, 0)
    gain_db = _smooth(-over * (1 - 1 / ratio), max(1, release or window * 3)) + makeup
    return x * 10 ** (gain_db / 20)[:, None]


def _eq(x, low, mid, high):
    if not (low or mid or high):
        return x
    def gain(f):
        lo = 1 / (1 + (f / 250) ** 2)        # low shelf below ~250 Hz
        hi = 1 / (1 + (2500 / f) ** 2)       # high shelf above ~2.5 kHz
        md = np.clip(1 - lo - hi, 0, 1)      # what's left: the mids
        return 10 ** ((low * lo + mid * md + high * hi) / 20)
    return _spectral(x, gain)


def _bell(f, fc, q):  # 1 at fc, falling off over about 1/q octaves either side
    return np.exp(-2.8 * (np.log2(f / fc) * q) ** 2)


def _ms(v):
    return max(1, int(v / 1000 * SR))


def _wet_tone(x, tone):  # tone 1 = untouched, lower = darker
    if tone >= 0.999:
        return x
    fc = _cutoff_hz(0.35 + 0.65 * tone)
    return _spectral(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** 4))


def _fx_eq(x, p, st):
    def gain(f):
        db = (p["low"] / (1 + (f / p["low_f"]) ** 2) + p["mid"] * _bell(f, p["mid_f"], p["mid_q"])
              + p["high"] / (1 + (p["high_f"] / f) ** 2) + p["out"])
        return 10 ** (db / 20)
    return _spectral(x, gain)


def _fx_filter(high):
    def run(x, p, st):
        q, order = 0.7071 + p["reso"] * 8, 2 if p["slope"] >= 0.5 else 1
        def gain(f):  # 2-pole magnitude response; reso raises Q for a peak at the cutoff
            r = f / _cutoff_hz(p["cutoff"])
            core = 1 / np.sqrt((1 - r ** 2) ** 2 + (r / q) ** 2)
            return (core * r ** 2 if high else core) ** order
        return _spectral(x, gain)
    return run


def _fx_compressor(x, p, st):
    y = _compress(x, p["threshold"], p["ratio"], p["makeup"], _ms(p["attack"]), _ms(p["release"]), p["knee"])
    return x * (1 - p["mix"]) + y * p["mix"]


def _fx_drive(x, p, st):
    g = 1 + p["amount"] * 20
    wet = _wet_tone(np.tanh(x * g) / np.tanh(g), p["tone"]) * 10 ** (p["out"] / 20)
    return x * (1 - p["mix"]) + wet * p["mix"]


def _fx_delay(x, p, st):
    d, fb, wet = max(1, int(p["time"] * st * SR)), p["feedback"], np.zeros_like(x)
    k, g = 1, 1.0
    while g > 0.01 and k * d < len(x):
        echo = x[:len(x) - k * d] * g
        wet[k * d:] += echo[:, ::-1] if k % 2 and p["pingpong"] >= 0.5 else echo  # ping-pong: odd echoes swap sides
        k, g = k + 1, g * fb
    return x + _wet_tone(wet, p["tone"]) * p["mix"]


def _fx_reverb(x, p, st):
    ir = _reverb_ir(p["size"])
    wet = np.stack([_fft_convolve(x[:, c], ir[:, c])[:len(x)] for c in (0, 1)], axis=1)
    pre = int(p["predelay"] / 1000 * SR)
    if pre:
        wet = np.concatenate([np.zeros((pre, 2)), wet[:len(wet) - pre]])
    wet = _fx_stereo(_wet_tone(wet, 1 - p["damp"]), {"width": p["width"], "pan": 0}, st)
    return x * (1 - 0.5 * p["mix"]) + wet * p["mix"]


def _mod_delay(x, base_ms, depth_ms, rate, mix):
    """Stereo modulated delay (chorus/flanger core): L and R LFOs 90 degrees apart."""
    t, idx = np.arange(len(x)) / SR, np.arange(len(x))
    out = np.empty_like(x)
    for c, phase in ((0, 0), (1, np.pi / 2)):
        d = (base_ms + depth_ms * np.sin(2 * np.pi * rate * t + phase)) / 1000 * SR
        out[:, c] = np.interp(idx - d, idx, x[:, c], left=0)
    return x * (1 - mix / 2) + out * mix / 2


def _fx_chorus(x, p, st):
    return _mod_delay(x, p["delay"], p["depth"] * 8, p["rate"], p["mix"])


def _fx_flanger(x, p, st):
    return _mod_delay(x, p["delay"], p["depth"] * p["delay"] * 0.9, p["rate"], p["mix"])


def _fx_stereo(x, p, st):
    mid, side = (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2 * p["width"]
    y = np.stack([mid + side, mid - side], axis=1)
    return _balance(y, p["pan"]) if p["pan"] else y


def _fx_limiter(x, p, st):
    ceil = 10 ** (p["ceiling"] / 20)
    x = _compress(x * 10 ** (p["gain"] / 20), p["ceiling"], 50, 0, int(0.002 * SR), _ms(p["release"]))
    return np.clip(x, -ceil, ceil)


def _fx_clipper(x, p, st):
    t = 10 ** (p["threshold"] / 20)
    soft = np.sign(x) * (t + (1 - t) * np.tanh((np.abs(x) - t) / max(1 - t, 1e-3)))
    y = np.where(np.abs(x) > t, soft, x) * 10 ** (p["out"] / 20)
    return x * (1 - p["mix"]) + y * p["mix"]


def _fx_lofi(x, p, st):
    hold = max(1, int(p["rate"]))
    y = np.repeat(x[::hold], hold, axis=0)[:len(x)]  # sample-and-hold = lower sample rate
    q = 2 ** (p["bits"] - 1)
    y = np.round(y * q) / q
    return x * (1 - p["mix"]) + y * p["mix"]


def _fx_gate(x, p, st):
    level = 20 * np.log10(np.sqrt(_smooth(np.max(x ** 2, axis=1), _ms(p["attack"]))) + 1e-9)
    closed = (level < p["threshold"]).astype(float)
    gain_db = -p["range"] * np.clip(_smooth(closed, _ms(p["release"])), 0, 1)
    return x * 10 ** (gain_db / 20)[:, None]


def _fx_transient(x, p, st):
    e = np.max(x ** 2, axis=1)
    fast, slow = np.sqrt(_smooth(e, _ms(1))) + 1e-9, np.sqrt(_smooth(e, _ms(25))) + 1e-9
    rise = np.clip(np.log2(fast / slow), 0, 2) / 2  # 1 on a hit's attack, 0 elsewhere
    fall = np.clip(np.log2(slow / fast), 0, 2) / 2  # 1 in the ringing tail
    gain_db = _smooth(12 * (p["attack"] * rise + p["sustain"] * fall), _ms(2)) + p["out"]
    return x * 10 ** (gain_db / 20)[:, None]


def _fx_multiband(x, p, st):
    lo_x, hi_x = p["low_x"], max(p["high_x"], p["low_x"] * 1.5)
    lo = _spectral(x, lambda f: 1 / (1 + (f / lo_x) ** 4))
    hi = _spectral(x, lambda f: 1 / (1 + (hi_x / f) ** 4))
    mid = x - lo - hi  # bands sum back to the input when nothing compresses
    w = _ms(10)
    return (_compress(lo, p["low_t"], p["low_r"], 0, w) + _compress(mid, p["mid_t"], p["mid_r"], 0, w)
            + _compress(hi, p["high_t"], p["high_r"], 0, w)) * 10 ** (p["makeup"] / 20)


def _fx_balance(x, p, st):
    x = x * 10 ** (p["volume"] / 20) * (-1 if p["invert"] >= 0.5 else 1)
    return _balance(x, p["pan"]) if p["pan"] else x


def _fx_phaser(x, p, st):
    """Allpass stages swept by an LFO, mixed with the dry signal for moving notches. The sweep updates
    every 256 samples (the LFO is far slower than that), so the filters run block-wise in scipy."""
    from scipy.signal import lfilter
    blk, stages = 256, int(round(p["stages"]))
    starts = np.arange(0, len(x), blk)
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * p["rate"] * starts / SR)
    fc = 200 * (1 + p["depth"] * 30) ** lfo  # 200 Hz up to ~6 kHz at full depth
    k = np.tan(np.pi * np.minimum(fc, SR * 0.45) / SR)
    coef = (k - 1) / (k + 1)
    y = x.copy()
    for _ in range(stages):
        zi = np.zeros((1, 2))
        for i, a0 in zip(starts, coef):
            y[i:i + blk], zi = lfilter([a0, 1], [1, a0], y[i:i + blk], axis=0, zi=zi)
    return x * (1 - p["mix"] / 2) + y * p["mix"] / 2


def _fx_pitch(x, p, st):
    """Dual-tap delay-line pitch shifter: two read heads sweep through a short window at the new speed and
    crossfade, so the pitch changes but the length does not."""
    ratio = 2 ** ((round(p["semis"]) + p["cents"] / 100) / 12)
    w, n = _ms(p["window"]), np.arange(len(x))
    d1 = ((1 - ratio) * n) % w
    d2 = (d1 + w / 2) % w
    g1, g2 = np.sin(np.pi * d1 / w), np.sin(np.pi * d2 / w)  # power-complementary: g1^2 + g2^2 = 1
    out = np.stack([np.interp(n - d1, n, x[:, c], left=0) * g1 + np.interp(n - d2, n, x[:, c], left=0) * g2
                    for c in (0, 1)], axis=1)
    return x * (1 - p["mix"]) + out * p["mix"]


def _fx_vocoder(x, p, st):
    """Channel vocoder: the input's spectral envelope (per band) is imposed on a built-in carrier
    (a saw chord plus noise at the carrier note), giving the robot-voice sound."""
    size, hop = 1024, 256
    mono = x.mean(axis=1)
    t = np.arange(len(mono)) / SR
    f0 = midi_hz(round(p["note"]))
    carrier = sum((2 * ((t * f0 * m) % 1) - 1) for m in (1, 1.5, 2)) / 3
    carrier = carrier + np.random.default_rng(3).uniform(-1, 1, len(mono)) * p["noise"]
    pad = lambda v: np.concatenate([np.zeros(size), v, np.zeros(size)])
    mod, car = pad(mono), pad(carrier)
    idx = np.arange(0, len(mod) - size, hop)[:, None] + np.arange(size)
    win = np.hanning(size)
    X, C = np.fft.rfft(mod[idx] * win), np.fft.rfft(car[idx] * win)
    f = np.fft.rfftfreq(size, 1 / SR)
    bands = int(round(p["bands"]))
    band = np.digitize(f, np.geomspace(80, 12000, bands + 1)) - 1
    onehot = ((band[:, None] == np.arange(bands)) & (band[:, None] >= 0)).astype(float)  # bins x bands
    per = np.maximum(onehot.sum(axis=0), 1)
    env = lambda S: np.sqrt((np.abs(S) ** 2) @ onehot / per)
    Y = C * ((env(X) / (env(C) + 1e-9)) @ onehot.T)
    frames = np.fft.irfft(Y, size) * win
    out = np.zeros(len(mod))
    for i, start in enumerate(idx[:, 0]):
        out[start:start + size] += frames[i]
    wet = (out / 1.5)[size:size + len(mono)]  # Hann x Hann at 75 % overlap sums to 1.5
    return x * (1 - p["mix"]) + wet[:, None] * p["mix"]


def _fx_autopan(x, p, st):
    lfo = np.sin(2 * np.pi * p["rate"] * np.arange(len(x)) / SR)
    x = x * (1 - p["trem"] * (0.5 + 0.5 * lfo))[:, None]
    return _balance_env(x, lfo * p["depth"])


# name -> (process, {param: [min, max, default, label, section]}).
# The plugin window groups knobs by section; switches are 0/1 knobs (>= 0.5 = on).
EFFECTS = {
    "Drive": (_fx_drive, {"amount": [0, 1, 0.4, "Amount", "Drive"], "tone": [0, 1, 1, "Tone", "Drive"],
                          "out": [-12, 12, 0, "Out dB", "Output"], "mix": [0, 1, 1, "Mix", "Output"]}),
    "Soft Clipper": (_fx_clipper, {"threshold": [-24, 0, -6, "Thresh dB", "Clip"],
                                   "out": [-12, 12, 0, "Out dB", "Output"], "mix": [0, 1, 1, "Mix", "Output"]}),
    "Lo-fi": (_fx_lofi, {"bits": [2, 16, 8, "Bits", "Crush"], "rate": [1, 32, 4, "Downsample", "Crush"],
                         "mix": [0, 1, 1, "Mix", "Output"]}),
    "Low-pass": (_fx_filter(False), {"cutoff": [0, 1, 0.6, "Cutoff", "Filter"], "reso": [0, 1, 0, "Reso", "Filter"],
                                     "slope": [0, 1, 0, "24 dB", "Filter"]}),
    "High-pass": (_fx_filter(True), {"cutoff": [0, 1, 0.3, "Cutoff", "Filter"], "reso": [0, 1, 0, "Reso", "Filter"],
                                     "slope": [0, 1, 0, "24 dB", "Filter"]}),
    "EQ": (_fx_eq, {"low": [-12, 12, 0, "Gain dB", "Low"], "low_f": [30, 500, 250, "Freq Hz", "Low"],
                    "mid": [-12, 12, 0, "Gain dB", "Middle"], "mid_f": [200, 8000, 1000, "Freq Hz", "Middle"],
                    "mid_q": [0.3, 4, 0.7, "Width Q", "Middle"],
                    "high": [-12, 12, 0, "Gain dB", "High"], "high_f": [1500, 16000, 2500, "Freq Hz", "High"],
                    "out": [-12, 12, 0, "Out dB", "Output"]}),
    "Compressor": (_fx_compressor, {"threshold": [-40, 0, -18, "Thresh dB", "Detector"], "ratio": [1, 20, 4, "Ratio", "Detector"],
                                    "knee": [0, 12, 0, "Knee dB", "Detector"], "attack": [0.1, 100, 10, "Attack ms", "Timing"],
                                    "release": [5, 500, 30, "Release ms", "Timing"], "makeup": [0, 24, 4, "Gain dB", "Output"],
                                    "mix": [0, 1, 1, "Mix", "Output"]}),
    "Multiband Compressor": (_fx_multiband, {
        "low_x": [40, 1000, 200, "Low/mid Hz", "Crossover"], "high_x": [1000, 12000, 3000, "Mid/high Hz", "Crossover"],
        "low_t": [-40, 0, -18, "Thresh dB", "Low"], "low_r": [1, 20, 3, "Ratio", "Low"],
        "mid_t": [-40, 0, -18, "Thresh dB", "Middle"], "mid_r": [1, 20, 2, "Ratio", "Middle"],
        "high_t": [-40, 0, -18, "Thresh dB", "High"], "high_r": [1, 20, 2, "Ratio", "High"],
        "makeup": [0, 24, 2, "Gain dB", "Output"]}),
    "Limiter": (_fx_limiter, {"ceiling": [-12, 0, -0.3, "Ceiling dB", "Limit"], "gain": [0, 18, 0, "Gain dB", "Limit"],
                              "release": [1, 200, 6, "Release ms", "Limit"]}),
    "Gate": (_fx_gate, {"threshold": [-80, 0, -40, "Thresh dB", "Gate"], "range": [0, 80, 60, "Range dB", "Gate"],
                        "attack": [0.1, 50, 1, "Attack ms", "Timing"], "release": [5, 500, 60, "Release ms", "Timing"]}),
    "Transient": (_fx_transient, {"attack": [-1, 1, 0.5, "Attack", "Shape"], "sustain": [-1, 1, 0, "Sustain", "Shape"],
                                  "out": [-12, 12, 0, "Out dB", "Output"]}),
    "Delay": (_fx_delay, {"time": [1, 8, 3, "Steps", "Time"], "feedback": [0, 0.9, 0.4, "Feedback", "Time"],
                          "pingpong": [0, 1, 1, "Ping-pong", "Time"], "tone": [0, 1, 1, "Tone", "Output"],
                          "mix": [0, 1, 0.35, "Mix", "Output"]}),
    "Reverb": (_fx_reverb, {"size": [0.3, 5, 1.8, "Decay s", "Room"], "predelay": [0, 200, 0, "Pre-delay ms", "Room"],
                            "damp": [0, 1, 0, "Damping", "Tone"], "width": [0, 2, 1, "Width", "Tone"],
                            "mix": [0, 1, 0.3, "Mix", "Output"]}),
    "Chorus": (_fx_chorus, {"delay": [5, 40, 15, "Delay ms", "Voices"], "depth": [0, 1, 0.5, "Depth", "Modulation"],
                            "rate": [0.1, 5, 0.8, "Rate Hz", "Modulation"], "mix": [0, 1, 0.5, "Mix", "Output"]}),
    "Flanger": (_fx_flanger, {"delay": [0.5, 10, 2.5, "Delay ms", "Sweep"], "depth": [0, 1, 0.7, "Depth", "Sweep"],
                              "rate": [0.05, 5, 0.3, "Rate Hz", "Sweep"], "mix": [0, 1, 0.6, "Mix", "Output"]}),
    "Stereo": (_fx_stereo, {"width": [0, 2, 1.4, "Width", "Image"], "pan": [-1, 1, 0, "Pan", "Image"]}),
    "Phaser": (_fx_phaser, {"rate": [0.05, 5, 0.4, "Rate Hz", "Sweep"], "depth": [0, 1, 0.7, "Depth", "Sweep"],
                            "stages": [2, 12, 6, "Stages", "Sweep"], "mix": [0, 1, 0.7, "Mix", "Output"]}),
    "Pitch Shifter": (_fx_pitch, {"semis": [-12, 12, 0, "Semitones", "Pitch"], "cents": [-100, 100, 0, "Cents", "Pitch"],
                                  "window": [20, 120, 60, "Grain ms", "Quality"], "mix": [0, 1, 1, "Mix", "Output"]}),
    "Vocoder": (_fx_vocoder, {"note": [36, 72, 48, "Note", "Carrier"], "noise": [0, 1, 0.1, "Noise", "Carrier"],
                              "bands": [8, 32, 16, "Bands", "Bands"], "mix": [0, 1, 1, "Mix", "Output"]}),
    "Auto Pan": (_fx_autopan, {"rate": [0.1, 10, 2, "Rate Hz", "LFO"], "depth": [0, 1, 0.6, "Pan depth", "LFO"],
                                  "trem": [0, 1, 0, "Volume depth", "LFO"]}),
    "Balance": (_fx_balance, {"volume": [-24, 12, 0, "Volume dB", "Gain"], "pan": [-1, 1, 0, "Pan", "Gain"],
                              "invert": [0, 1, 0, "Invert", "Gain"]}),
}


def new_slot(kind, **params):
    return {"type": kind, "on": True, "params": {k: v[2] for k, v in EFFECTS[kind][1].items()} | params}


def apply_chain(x, slots, st):
    for s in slots:
        if not s or not s.get("on", True):
            continue
        if s["type"] == "VST3":  # optional pedalboard add-on; a failing plugin is skipped, not fatal
            try:
                import plugins
                x = plugins.process(s["path"], x, SR)
            except Exception:
                failed_plugins.add(s.get("path", "?"))
            continue
        if s["type"] not in EFFECTS:  # e.g. a project from a newer version: skip what this build can't run
            continue
        fn, spec = EFFECTS[s["type"]]
        x = fn(x, {k: v[2] for k, v in spec.items()} | s.get("params", {}), st)
    return x


# ---------- rendering ----------

def pattern_channel(project, pi, ci):
    """Dry mono audio of one channel in one pattern (starts at the pattern's first step, includes note tails)."""
    st = step_seconds(project["bpm"])
    swing = project.get("swing", 0.0)
    ch, pat = project["channels"][ci], project["patterns"][pi]

    def at(step):  # swing pushes every odd 16th later, up to half a step
        return int((step + (swing * 0.5 if step % 2 else 0)) * st * SR)

    rng = np.random.default_rng(ci)  # per-channel noise so a solo/stem render matches the full mix
    pitch = ch.get("pitch", 0)
    hits = [(at(s), voice(ch, 60 + pitch, 0 if ch["kind"] == "sample" else st, 1.0, rng))
            for s, on in enumerate(pat["steps"][ci]) if on]
    hits += [(at(start), voice(ch, midi + pitch, length * st, vel, rng))
             for start, length, midi, vel in pat["notes"][ci]]
    if not hits:
        return None
    if ch["kind"] == "sample" and (ch.get("smp") or {}).get("cut"):  # "cut itself": a new hit stops the last one
        hits.sort(key=lambda h: h[0])
        hits = [(s, m[:max(1, hits[i + 1][0] - s)] if i + 1 < len(hits) else m) for i, (s, m) in enumerate(hits)]
    mono = np.zeros(max(s + len(m) for s, m in hits))
    for s, m in hits:
        mono[s:s + len(m)] += m
    return mono


def _routes(mixer):
    """Effective route per insert. Any track that sits on a routing loop goes to master instead,
    so the graph is acyclic and every track is processed exactly once."""
    def nxt(t):
        r = mixer[t].get("route", 0)
        return r if isinstance(r, int) and 0 <= r < len(mixer) and r != t else 0

    eff = {0: None}
    for t in range(1, len(mixer)):
        seen, x = {t}, nxt(t)
        while x != 0 and x not in seen:
            seen.add(x)
            x = nxt(x)
        eff[t] = 0 if x == t else nxt(t)
    return eff


def _route_paths(mixer):
    """Track -> [track, its route, ..., 0 (master)]."""
    eff, paths = _routes(mixer), {}
    for t in range(len(mixer)):
        path = [t]
        while path[-1] != 0:
            path.append(eff[path[-1]])
        paths[t] = path
    return paths


def _balance(x, pan):
    if pan < 0:
        x[:, 1] *= 1 + pan
    elif pan > 0:
        x[:, 0] *= 1 - pan
    return x


TAIL = 6.0  # seconds of headroom after the song for delay/reverb tails
METER_BLOCK = 1024


AUTO_RANGES = {"vol": (0.0, 1.0), "pan": (-1.0, 1.0), "mvol": (0.0, 1.25)}  # automation value range per parameter


def auto_range(key):
    """Automation keys look like 'ch:3:vol', 'ch:3:pan', 'mx:2:vol', 'mx:0:pan' (mixer track 0 = Master)."""
    kind, _, param = key.split(":")
    return AUTO_RANGES["mvol" if kind == "mx" and param == "vol" else param]


def _envelope(autos, key, base, total, bar):
    """Per-sample value of an automated parameter, or None if nothing automates it. Inside a clip the value
    follows its points (x, y in 0..1, linear between them); after a clip ends it holds the last value."""
    mine = sorted((c for c in autos if c.get("key") == key and c.get("points")), key=lambda c: c["bar"])
    if not mine:
        return None
    lo, hi = auto_range(key)
    env = np.full(total, float(base))
    for c in mine:
        s, e = c["bar"] * bar, min(total, (c["bar"] + max(1, c.get("bars", 4))) * bar)
        if s >= total:
            continue
        pts = sorted(c["points"])
        xs = [s + x * (e - s) for x, _ in pts]
        vals = [lo + min(max(y, 0), 1) * (hi - lo) for _, y in pts]
        env[s:e] = np.interp(np.arange(s, e), xs, vals)
        env[e:] = vals[-1]
    return env


def _pan_gains(pan, vol):
    """Equal-power (circular) pan law as left/right gains; pan and vol may be arrays."""
    ang = (np.asarray(pan) + 1) * np.pi / 4
    return np.cos(ang) * vol, np.sin(ang) * vol


def _balance_env(x, pan):
    """Balance a stereo buffer with a per-sample pan (-1..1)."""
    x[:, 0] *= np.where(pan > 0, 1 - pan, 1.0)
    x[:, 1] *= np.where(pan < 0, 1 + pan, 1.0)
    return x


def mix(project, song=True, pattern=0, only=None, normalize=True):
    """Full render through the mixer: channels -> insert tracks -> routing -> master.
    The playlist holds pattern clips, audio clips (a sample channel at a bar) and automation clips (vol/pan over time).
    normalize=False skips the safety gain-down (stem export applies the full mix's gain instead).
    Returns (stereo audio incl. tails, loop length in samples, meters[track][block] post-fader peaks)."""
    started = time.perf_counter()
    cost = {}  # mixer track -> seconds spent rendering what plays through it
    all_clips = clips(project) if song else []
    placed = [(c["bar"], c["pattern"]) for c in all_clips if c.get("type", "pattern") == "pattern"] if song else [(0, pattern)]
    audio_clips = [c for c in all_clips if c.get("type") == "audio"]
    autos = [c for c in all_clips if c.get("type") == "auto"]
    st = step_seconds(project["bpm"])
    bar = int(STEPS * st * SR)
    ends = [b + 1 for b, _ in placed] + [c["bar"] + max(1, c.get("bars", 4)) for c in autos] + [1]
    for c in audio_clips:
        ends.append(c["bar"] + max(1, int(np.ceil(c.get("seconds", st * STEPS) * SR / bar - 1e-6))))
    loop = max(ends) * bar
    total = loop + int(TAIL * SR)
    mixer = project["mixer"]
    buses = {}  # track index -> stereo buffer, only for tracks that carry signal

    def bus(t):
        if t not in buses:
            buses[t] = np.zeros((total, 2))
        return buses[t]

    def insert_of(ch):
        return ch.get("insert", 0) if 0 <= ch.get("insert", 0) < len(mixer) else 0

    def add(ci, ch, mono, s):  # a channel's mono audio into its insert at sample s, with (automated) vol/pan
        n = min(len(mono), total - s)
        if n <= 0:
            return
        ve, pe = _envelope(autos, f"ch:{ci}:vol", ch["vol"], total, bar), _envelope(autos, f"ch:{ci}:pan", ch["pan"], total, bar)
        vol = ve[s:s + n] if ve is not None else ch["vol"]
        pan = pe[s:s + n] if pe is not None else ch["pan"]
        left, right = _pan_gains(pan, vol)
        b = bus(insert_of(ch))
        b[s:s + n, 0] += mono[:n] * left
        b[s:s + n, 1] += mono[:n] * right

    for ci, ch in enumerate(project["channels"]):
        if only is not None and ci != only:
            continue
        t_ch = time.perf_counter()
        cache = {}
        for b, p in placed:
            if p not in cache:
                cache[p] = pattern_channel(project, p, ci)
            if cache[p] is not None:
                add(ci, ch, cache[p], b * bar)
        for c in audio_clips:  # audio clips: the clip plays its sample channel's (shaped) sample
            if c.get("channel") == ci and ch.get("sample"):
                try:
                    data = shape_sample(load_sample(ch["sample"]), ch.get("smp")) * c.get("gain", 1.0)
                except (OSError, ValueError, EOFError, wave.Error):
                    failed_samples.add(ch["sample"])
                    continue
                add(ci, ch, data, c["bar"] * bar)
        cost[insert_of(ch)] = cost.get(insert_of(ch), 0) + time.perf_counter() - t_ch

    solos = {t for t, tr in enumerate(mixer) if tr.get("solo")}
    paths = _route_paths(mixer)

    def audible(t):  # solo: the soloed track, what feeds it, and where it goes stay on
        return not solos or any(x in solos for x in paths[t]) or any(t in paths[s] for s in solos)

    def fader(x, t):  # a mixer track's EQ, (automated) volume and (automated) pan
        tr = mixer[t]
        x = _eq(x, **tr.get("eq", {}))
        ve = _envelope(autos, f"mx:{t}:vol", tr["vol"], total, bar)
        x = x * (ve[:, None] if ve is not None else tr["vol"])
        pe = _envelope(autos, f"mx:{t}:pan", tr["pan"], total, bar)
        return _balance_env(x, pe) if pe is not None else _balance(x, tr["pan"])

    meters = [[] for _ in mixer]
    for t in sorted(range(1, len(mixer)), key=lambda t: -len(paths[t])):  # deepest first: children before parents
        if t not in buses:
            continue
        tr = mixer[t]
        t_fx = time.perf_counter()
        x = apply_chain(buses.pop(t), tr.get("fx", []), st)
        cost[t] = cost.get(t, 0) + time.perf_counter() - t_fx
        x = fader(x, t)
        if tr.get("mute") or not audible(t):
            continue
        meters[t] = _peaks(x[:loop])
        bus(paths[t][1])[:] += x
    m = mixer[0]
    t_fx = time.perf_counter()
    out = fader(apply_chain(bus(0), m.get("fx", []), st), 0)
    cost[0] = cost.get(0, 0) + time.perf_counter() - t_fx
    if only is None:
        last_perf.update(render_ms=round((time.perf_counter() - started) * 1000, 1),
                         tracks={mixer[t]["name"]: round(v * 1000, 1) for t, v in sorted(cost.items())})
    peak = np.max(np.abs(out))
    if normalize and peak > 1:  # safety: whole-mix gain-down so nothing clips (put a Limiter on Master for real limiting)
        out /= peak
    meters[0] = _peaks(out[:loop])
    loud = np.nonzero(np.max(np.abs(out[loop:]), axis=1) > 1e-5)[0]
    return out[:loop + (loud[-1] + 1 if len(loud) else 0)], loop, meters


def _peaks(x):
    n = len(x) // METER_BLOCK * METER_BLOCK
    return np.abs(x[:n]).max(axis=1).reshape(-1, METER_BLOCK).max(axis=1).round(3).tolist()


def render(project, song=True, pattern=0, only=None, normalize=True):
    """(stereo audio incl. tails, loop length in samples). only = render a single channel (stems)."""
    return mix(project, song, pattern, only, normalize)[:2]


def render_stems(project, song=True, pattern=0):
    """One stereo buffer per channel, scaled by the same gain the full mix gets, so stems sum to the export."""
    full = render(project, song, pattern, normalize=False)[0]
    gain = 1 / max(1.0, float(np.max(np.abs(full))))
    return [render(project, song, pattern, only=ci, normalize=False)[0] * gain for ci in range(len(project["channels"]))]


def loop_buffer(audio, loop):
    """Fold everything past the loop end (reverb/delay tails) back onto the start, so a looping
    playback sounds continuous instead of cutting tails at the loop point."""
    buf = audio[:loop].copy()
    for start in range(loop, len(audio), loop):
        chunk = audio[start:start + loop]
        buf[:len(chunk)] += chunk
    return np.clip(buf, -1, 1)


def metronome(bpm, n):
    """Stereo click track of n samples: high click on each bar, low click on other beats."""
    out = np.zeros((n, 2))
    beat = int(60 / bpm * SR)
    m = int(0.03 * SR)
    t = np.arange(m) / SR
    for i, s in enumerate(range(0, n, beat)):
        click = np.sin(2 * np.pi * (1600 if i % 4 == 0 else 1000) * t) * _env(m, 120) * 0.35
        k = min(m, n - s)
        out[s:s + k] += click[:k, None]
    return out


# ---------- I/O ----------

def write_wav(path, stereo):
    data = (np.asarray(stereo) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2 if data.ndim == 2 else 1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def _read_ogg_in_wav(path):
    """Some commercial sample packs store Ogg Vorbis inside .wav files (format 0x674F): the data chunk is a whole
    Ogg stream, so decode it with soundfile. Returns (mono float, sample rate)."""
    import io

    import soundfile as sf
    b = open(path, "rb").read()
    i = 12
    while i + 8 <= len(b):
        cid, size = b[i:i + 4], int.from_bytes(b[i + 4:i + 8], "little")
        if cid == b"data":
            data = b[i + 8:i + 8 + size]
            if data[:4] != b"OggS":
                break
            x, rate = sf.read(io.BytesIO(data), dtype="float64", always_2d=True)
            return x.mean(axis=1), rate
        i += 8 + size + (size & 1)
    raise ValueError(f"{path}: this compressed WAV variant isn't supported")


def read_wav(path):
    """Read a WAV as mono float at SR: 16/24/32-bit integer PCM, or Ogg-in-WAV (some commercial packs).
    shortcut: no float WAVs and linear resampling; read via soundfile for float WAV / flac / mp3 when needed."""
    try:
        with wave.open(str(path), "rb") as w:
            ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
    except wave.Error as e:
        if "unknown format" not in str(e):
            raise
        x, rate = _read_ogg_in_wav(path)
        return np.interp(np.arange(0, len(x), rate / SR), np.arange(len(x)), x) if rate != SR else x
    if width == 2:
        x = np.frombuffer(raw, "<i2") / 32768.0
    elif width == 3:  # pad each 3-byte sample with a low zero byte -> little-endian int32
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        x = np.frombuffer(np.pad(b, ((0, 0), (1, 0))).tobytes(), "<i4") / 2147483648.0
    elif width == 4:
        x = np.frombuffer(raw, "<i4") / 2147483648.0
    else:
        raise ValueError(f"{path}: {8 * width}-bit WAV not supported, convert to 16-bit")
    x = x.reshape(-1, ch).mean(axis=1)
    if rate != SR:
        x = np.interp(np.arange(0, len(x), rate / SR), np.arange(len(x)), x)
    return x


EXPORT_FORMATS = {  # key -> (soundfile format, subtype, file extension, label)
    "wav24": ("WAV", "PCM_24", "wav", "WAV · 24-bit (studio standard)"),
    "wav32f": ("WAV", "FLOAT", "wav", "WAV · 32-bit float (lossless master)"),
    "wav16": ("WAV", "PCM_16", "wav", "WAV · 16-bit (CD)"),
    "flac24": ("FLAC", "PCM_24", "flac", "FLAC · 24-bit (lossless, smaller)"),
    "mp3": ("MP3", "MPEG_LAYER_III", "mp3", "MP3 · 320 kbps (sharing)"),
}
EXPORT_RATES = (44100, 48000, 96000)


def write_audio(path, stereo, fmt="wav24", rate=SR):
    """High-quality export. Resamples with a polyphase filter when rate != SR.
    shortcut: the engine renders at 44.1 kHz, so 48/96 kHz exports are clean conversions, not extra detail;
    render natively at the higher rate if that ever matters."""
    import math

    import soundfile as sf
    from scipy.signal import resample_poly
    major, subtype = EXPORT_FORMATS[fmt][:2]
    if major == "MP3":
        rate = min(rate, 48000)  # MP3 tops out at 48 kHz
    x = np.asarray(stereo, dtype=np.float64)
    if rate != SR:
        g = math.gcd(rate, SR)
        x = resample_poly(x, rate // g, SR // g, axis=0)
    kw = {"compression_level": 0.0, "bitrate_mode": "CONSTANT"} if major == "MP3" else {}  # level 0 = 320 kbps
    sf.write(path, np.clip(x, -1, 1), rate, format=major, subtype=subtype, **kw)
    return rate


GM_DRUMS = {"kick": 36, "snare": 38, "hat": 42, "clap": 39, "808": 35, "tom": 45, "rim": 37, "openhat": 46,
            "crash": 49, "cowbell": 56, "shaker": 70}  # General MIDI drum notes for step hits


def _vlq(n):
    out = [n & 0x7F]
    while n > 0x7F:
        n >>= 7
        out.insert(0, (n & 0x7F) | 0x80)
    return bytes(out)


def write_midi(project, path, song=True, pattern=0, ppq=96):
    """Export notes and step hits as a type-1 MIDI file: a tempo track plus one track per channel.
    Drum steps use General MIDI drum notes on channel 10; everything else uses its piano-roll notes."""
    tick = ppq // 4  # one step = a 16th note
    placed = [(c["bar"], c["pattern"]) for c in clips(project) if c.get("type", "pattern") == "pattern"] if song else [(0, pattern)]
    tempo = int(60_000_000 / project["bpm"])
    tracks = [b"\x00\xff\x51\x03" + tempo.to_bytes(3, "big") + b"\x00\xff\x2f\x00"]
    for ci, ch in enumerate(project["channels"]):
        events = []  # (tick, order, bytes): note-offs sort before note-ons at the same tick
        chan = 9 if ch["kind"] in GM_DRUMS else min(ci, 15) if ci < 9 else min(ci + 1, 15)
        for b, pi in placed:
            pat = project["patterns"][pi]
            base = b * STEPS
            for st, on in enumerate(pat["steps"][ci]):
                if on:
                    note = GM_DRUMS.get(ch["kind"], 60 + ch.get("pitch", 0))
                    events += [((base + st) * tick, 1, bytes([0x90 | chan, note, 100])), ((base + st + 1) * tick, 0, bytes([0x80 | chan, note, 0]))]
            for st, length, midi, vel in pat["notes"][ci]:
                note = max(0, min(127, int(midi) + ch.get("pitch", 0)))
                events += [((base + st) * tick, 1, bytes([0x90 | chan, note, max(1, min(127, int(vel * 127)))])),
                           ((base + st + length) * tick, 0, bytes([0x80 | chan, note, 0]))]
        name = ch["name"].encode("utf-8")[:120]
        data, last = b"\x00\xff\x03" + _vlq(len(name)) + name, 0
        for t, _, ev in sorted(events, key=lambda e: (e[0], e[1])):
            data += _vlq(t - last) + ev
            last = t
        tracks.append(data + b"\x00\xff\x2f\x00")
    with open(path, "wb") as f:
        f.write(b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big") + len(tracks).to_bytes(2, "big") + ppq.to_bytes(2, "big"))
        for tr in tracks:
            f.write(b"MTrk" + len(tr).to_bytes(4, "big") + tr)
    return path


def save_project(project, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(project, f, indent=1)


def load_project(path):
    with open(path, encoding="utf-8") as f:
        return normalize_project(json.load(f))


# ---------- pitch detection ("perfect pitch") ----------

def detect_pitch(x, frame=2048, hop=512, fmin=50.0, fmax=1500.0, threshold=0.15):
    """YIN pitch tracker. Returns one MIDI float per hop, or None for silence/unvoiced.
    shortcut: monophonic only (one note at a time); use Basic Pitch for chords/polyphony."""
    tmin, tmax = int(SR / fmax), int(SR / fmin)
    gate = 0.02 * max(np.max(np.abs(x)), 1e-9)
    out = []
    for i in range(0, len(x) - frame - tmax, hop):
        f = x[i:i + frame + tmax]
        if np.sqrt(np.mean(f[:frame] ** 2)) < gate:
            out.append(None)
            continue
        # difference function d(tau) = sum (x[j] - x[j+tau])^2, via cumulative energy + FFT correlation
        w = f[:frame]
        size = 1 << (len(f) + frame).bit_length()
        corr = np.fft.irfft(np.fft.rfft(f, size) * np.conj(np.fft.rfft(w, size)), size)[:tmax + 1]
        e = np.cumsum(np.concatenate([[0], f ** 2]))
        energy_shift = e[frame:frame + tmax + 1] - e[:tmax + 1]
        d = np.sum(w ** 2) + energy_shift - 2 * corr
        d[0] = 0
        cmnd = d[1:] * np.arange(1, tmax + 1) / np.maximum(np.cumsum(d[1:]), 1e-12)
        cand = np.where(cmnd[tmin - 1:] < threshold)[0]
        if not len(cand):
            out.append(None)
            continue
        tau = cand[0] + tmin
        while tau < tmax and cmnd[tau] < cmnd[tau - 1]:  # walk down to the local minimum
            tau += 1
        out.append(69 + 12 * np.log2(SR / tau / 440.0))
    return out


def pitch_now(x):
    """MIDI pitch (float) of the most recent audio in x, or None if silent/unpitched. For the live tuner."""
    frame, tmax = 2048, int(SR / 50.0)
    if len(x) < frame + tmax + 1:
        return None
    ps = [p for p in detect_pitch(x[-(frame + tmax + 512 + 1):]) if p is not None]
    return ps[-1] if ps else None


def audio_to_hits(x, bpm, hop=256, gap=0.08):
    """Rhythm from a hum or beatbox: the 16th-note steps where a new sound starts (energy jumps), for drums."""
    st = step_seconds(bpm)
    n = len(x) // hop
    if n < 2:
        return []
    rms = np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1))
    gate = 0.08 * rms.max()
    steps, last = [], -1e9
    for i in range(n):
        before = rms[max(0, i - 4):i].mean() if i else 0.0  # silence before the take, so a hit on beat 1 counts
        t = i * hop / SR
        if rms[i] > gate and rms[i] > 1.8 * before + 1e-6 and t - last >= gap:
            last = t
            s = round(t / st)
            if not steps or steps[-1] != s:
                steps.append(s)
    return steps


def audio_to_notes(x, bpm, hop=512, min_steps=1):
    """Turn audio into piano-roll notes [start_step, len_steps, midi, velocity], quantized to 16ths."""
    st = step_seconds(bpm)
    pitches = detect_pitch(x, hop=hop)
    notes, cur, start = [], None, 0
    for i, p in enumerate(pitches + [None]):
        m = None if p is None else int(round(p))
        if m != cur:
            if cur is not None:
                s0 = round(start * hop / SR / st)
                s1 = round(i * hop / SR / st)
                if s1 - s0 >= min_steps:
                    notes.append([s0, s1 - s0, cur, 1.0])
            cur, start = m, i
    return notes
