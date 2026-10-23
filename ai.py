"""AI roles, picked in the UI like a model picker:
  Composer           - text-to-music with MusicGen (Meta AudioCraft), clip lands in the Step Rack
  Mix engineer       - balances channel levels and cleans up lows, as undoable mixer edits
  Mastering engineer - builds a Master chain (EQ -> Compressor -> Limiter) to a loudness target

shortcut: Mix and Mastering are measurement + rules, not trained models; swap in the fine-tuned model
behind the same functions when it exists.
Heavy imports (torch/transformers) stay inside functions so the app runs without them."""
import copy
import threading
import time

import numpy as np

import engine

# ---------- Composer: MusicGen ----------

COMPOSER_MODELS = {  # UI label -> Hugging Face id (weights are CC-BY-NC 4.0: non-commercial use only)
    "MusicGen Small · fast": "facebook/musicgen-small",
    "MusicGen Medium · better, slower": "facebook/musicgen-medium",
}
_models = {}
_gen_lock = threading.Lock()  # one generation at a time: two at once doubled memory and fought for the GPU
status = {"stage": "idle", "since": 0.0}


def _set(stage):
    status.update(stage=stage, since=time.time())


MELODY_MODEL = "facebook/musicgen-melody"  # follows a hummed/played melody; also CC-BY-NC 4.0
HUM_STYLES = {  # what the hum should become -> text prompt for the melody model
    "melody": "a catchy lead synth melody", "guitar": "clean electric guitar melody, solo guitar",
    "bass": "deep groovy bass line", "keys": "expressive piano melody", "pad": "warm ambient synth pad chords",
    "kick": "punchy kick drum pattern", "snare": "tight snare drum groove", "hat": "crisp hi-hat groove",
    "clap": "hand clap rhythm",
}


def _load(model_id, melody=False):
    """Load a MusicGen model once (GPU in half precision when there is one)."""
    import torch
    from transformers import (AutoProcessor, AutoTokenizer, MusicgenForConditionalGeneration,
                              MusicgenMelodyForConditionalGeneration)
    if model_id not in _models:
        _set("downloading / loading model (first use only)")
        cuda = torch.cuda.is_available()
        cls = MusicgenMelodyForConditionalGeneration if melody else MusicgenForConditionalGeneration
        model = cls.from_pretrained(model_id, torch_dtype=torch.float16 if cuda else torch.float32)
        # the melody model's processor insists on torchaudio (no build for torch 2.14), so it gets only its
        # tokenizer here and the melody features come from _chroma() below
        text = AutoTokenizer.from_pretrained(model_id) if melody else AutoProcessor.from_pretrained(model_id)
        _models[model_id] = (text, model.to("cuda" if cuda else "cpu"))
    return _models[model_id]


def _chroma(x, sr=32000, n_fft=16384, hop=4096):
    """MusicGen Melody's conditioning, computed like transformers' MusicgenMelodyFeatureExtractor but in numpy:
    power spectrogram (periodic Hann, centred) -> chroma filter bank -> one-hot of the strongest pitch class per frame.
    Returns (frames, 12)."""
    from transformers.audio_utils import chroma_filter_bank
    x = np.pad(x, (0, max(0, n_fft - len(x))))
    xp = np.pad(x, n_fft // 2, mode="reflect")
    frames = 1 + (len(xp) - n_fft) // hop
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)
    spec = np.abs(np.fft.rfft(xp[np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]] * win, axis=1)) ** 2
    raw = spec @ chroma_filter_bank(sampling_rate=sr, num_frequency_bins=n_fft, tuning=0, num_chroma=12).T
    onehot = np.zeros_like(raw)
    onehot[np.arange(frames), raw.argmax(axis=1)] = 1
    return onehot.astype(np.float32)


def _run(model, inputs, seconds, out_path):
    import torch
    _set(f"generating on {'GPU' if model.device.type == 'cuda' else 'CPU (slow)'}")
    tokens = int(seconds * model.config.audio_encoder.frame_rate)  # ~50 tokens per second
    with torch.no_grad():
        audio = model.generate(**inputs, do_sample=True, max_new_tokens=tokens)[0, 0].float().cpu().numpy()
    rate = model.config.audio_encoder.sampling_rate
    audio = np.interp(np.arange(0, len(audio), rate / engine.SR), np.arange(len(audio)), audio)
    engine.write_wav(out_path, audio / max(np.max(np.abs(audio)), 1e-9) * 0.9)
    return out_path


def warm_up(which="composer"):
    """Load a model ahead of time and run a tiny generation, so the user's first click doesn't pay the
    ~20 s load + GPU warm-up. Runs in a background thread; a real generation waits on the same lock."""
    try:
        import torch
    except ImportError:
        return
    with _gen_lock:
        try:
            melody = which == "melody"
            tok, model = _load(MELODY_MODEL if melody else next(iter(COMPOSER_MODELS.values())), melody=melody)
            _set("warming up the GPU")
            inputs = dict(tok(["warm up"], padding=True, return_tensors="pt") if melody else tok(text=["warm up"], padding=True, return_tensors="pt"))
            if melody:
                inputs["input_features"] = torch.zeros(1, 8, 12)
            inputs = {k: v.to(model.device, model.dtype) if v.is_floating_point() else v.to(model.device) for k, v in inputs.items()}
            with torch.no_grad():
                model.generate(**inputs, do_sample=True, max_new_tokens=8)
        except Exception:  # warming is best-effort; the real generate reports any problem to the user
            pass
        finally:
            _set("idle")


def _need_torch():
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as e:
        raise RuntimeError("AI generation needs: pip install torch transformers") from e


def generate_audio(prompt, seconds, out_path, model_label=next(iter(COMPOSER_MODELS))):
    """Text-to-music. Writes a WAV at engine.SR and returns its path."""
    _need_torch()
    with _gen_lock:
        try:
            proc, model = _load(COMPOSER_MODELS[model_label])
            inputs = proc(text=[prompt], padding=True, return_tensors="pt").to(model.device)
            return _run(model, inputs, seconds, out_path)
        finally:
            _set("idle")


def generate_from_hum(hum_path, style, bpm, seconds, out_path):
    """The AI hears your hum and plays it back as `style` (guitar, bass, kick...): MusicGen Melody keeps the
    hum's tune and rhythm and the text prompt picks the sound. Writes a WAV at engine.SR, returns its path."""
    _need_torch()
    if style not in HUM_STYLES:
        raise ValueError(f"Unknown style {style}")
    with _gen_lock:
        try:
            import torch
            tok, model = _load(MELODY_MODEL, melody=True)
            rate = 32000  # the model listens at 32 kHz
            hum = engine.read_wav(hum_path)
            hum = np.interp(np.arange(0, len(hum), engine.SR / rate), np.arange(len(hum)), hum)
            inputs = dict(tok([f"{HUM_STYLES[style]}, {int(bpm)} bpm"], padding=True, return_tensors="pt"))
            inputs["input_features"] = torch.from_numpy(_chroma(hum, rate))[None]
            inputs = {k: v.to(model.device, model.dtype) if v.is_floating_point() else v.to(model.device)
                      for k, v in inputs.items()}  # fp16 on GPU
            return _run(model, inputs, seconds, out_path)
        finally:
            _set("idle")


# ---------- Mix engineer ----------

# target RMS level (dBFS) per instrument when soloed through its insert; kick and snare lead, hats sit back
MIX_TARGETS = {"kick": -16.0, "snare": -18.0, "clap": -20.0, "hat": -25.0, "synth": -20.0, "sample": -20.0}
HIGH_PASS = {"hat": 0.45, "snare": 0.30, "clap": 0.30}  # knob value: 0.45 ~ 450 Hz, 0.30 ~ 160 Hz
PAN = {"hat": 0.25, "clap": -0.12}


def _rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def auto_mix(project, song=True, pattern=0):
    """Return a copy of the project with balanced channel volumes, gentle panning, and a high-pass
    on hats/snares/claps that sit alone on their insert. Silent channels are left alone."""
    p = copy.deepcopy(project)
    share = {}
    for ch in p["channels"]:
        share[ch["insert"]] = share.get(ch["insert"], 0) + 1
    wanted = {}  # channel -> volume that would hit its target level
    for ci, ch in enumerate(p["channels"]):
        audio, loop = engine.render(p, song, pattern, only=ci, normalize=False)
        if np.max(np.abs(audio[:loop])) > 1e-4:
            wanted[ci] = ch["vol"] * 10 ** ((MIX_TARGETS.get(ch["kind"], -20.0) - _rms_db(audio[:loop])) / 20)
    # balance between tracks is what matters (overall loudness is mastering's job): scale so the typical
    # (median) channel sits at 0.7. A very quiet outlier, like a soft raw sample, then simply tops out at 1.0
    # instead of dragging every other channel down with it.
    fit = 0.7 / float(np.median(list(wanted.values()))) if wanted else 1.0
    for ci, ch in enumerate(p["channels"]):
        if ci not in wanted:
            continue
        ch["vol"] = float(np.clip(wanted[ci] * fit, 0.02, 1.0))
        if ch["kind"] in PAN and abs(ch["pan"]) < 0.05:
            ch["pan"] = PAN[ch["kind"]]
        slots = p["mixer"][ch["insert"]]["fx"]
        own = ch["insert"] > 0 and share[ch["insert"]] == 1  # never touch a shared bus or the master
        if own and ch["kind"] in HIGH_PASS and not any(s and s["type"] == "High-pass" for s in slots) and None in slots:
            slots[slots.index(None)] = engine.new_slot("High-pass", cutoff=HIGH_PASS[ch["kind"]])
    return p


# ---------- Mastering engineer ----------

MASTER_TARGET_DB = -12.0  # RMS dBFS; roughly a loud-but-dynamic streaming master


def auto_master(project, song=True, pattern=0):
    """Return a copy of the project whose Master track has EQ -> Compressor -> Limiter, with the
    limiter's gain set so the song's RMS lands near MASTER_TARGET_DB. Other Master slots are kept."""
    p = copy.deepcopy(project)
    master = p["mixer"][0]
    keep = [s for s in master["fx"] if s and s["type"] not in ("EQ", "Compressor", "Limiter")]
    master["fx"] = [None] * engine.FX_SLOTS
    audio, loop = engine.render(p, song, pattern, normalize=False)  # measure without any mastering
    level = _rms_db(audio[:loop])
    if level < -90:
        raise ValueError("The song is silent. Add some notes before mastering.")
    chain = [engine.new_slot("EQ", low=1.0, mid=-0.5, high=1.5),
             engine.new_slot("Compressor", threshold=round(level + 4, 1), ratio=2.0, makeup=0.0),
             engine.new_slot("Limiter", ceiling=-1.0, gain=round(float(np.clip(MASTER_TARGET_DB - level, 0, 18)), 1))]
    master["fx"] = (chain + keep + [None] * engine.FX_SLOTS)[:engine.FX_SLOTS]
    return p
