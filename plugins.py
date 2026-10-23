"""Optional VST3 plugin hosting through Spotify's pedalboard.

pedalboard is GPL-3 licensed, so MLabs does not depend on it: everything here switches on only when the user
has installed it themselves (`pip install pedalboard`). Without it, MLabs runs exactly the same, minus plugins.
"""
import glob
import os
import threading

import numpy as np

SEARCH = [r"C:\Program Files\Common Files\VST3", r"C:\Program Files\VSTPlugins", r"C:\Program Files\Steinberg\VSTPlugins",
          os.path.expanduser(r"~\Documents\VST3")]
_cache = {}  # path -> loaded plugin
_lock = threading.Lock()  # a loaded plugin isn't safe to run from two renders at once


def available():
    try:
        import pedalboard  # noqa: F401
        return True
    except ImportError:
        return False


def scan():
    """Installed .vst3 plugins in the usual folders: [{path, name}]."""
    found = []
    for root in SEARCH:
        for p in glob.glob(os.path.join(root, "**", "*.vst3"), recursive=True):
            if os.path.isdir(p) and p.lower().endswith(".vst3") and not any(p.startswith(f["path"] + os.sep) for f in found):
                found.append({"path": p, "name": os.path.basename(p)[:-5]})
            elif os.path.isfile(p):
                found.append({"path": p, "name": os.path.basename(p)[:-5]})
    return sorted(found, key=lambda f: f["name"].lower())


def _load(path):
    if path not in _cache:
        from pedalboard import load_plugin
        _cache[path] = load_plugin(path)
    return _cache[path]


def info(path):
    """Load once to check it works; returns {name, is_instrument}."""
    with _lock:
        p = _load(path)
    return {"name": os.path.basename(path).rsplit(".", 1)[0], "is_instrument": bool(getattr(p, "is_instrument", False))}


def process(plugin, x, sr):
    """Run a stereo buffer (n, 2) through an effect plugin; returns (n, 2). `plugin` is a path or a loaded plugin."""
    with _lock:
        p = _load(plugin) if isinstance(plugin, str) else plugin
        y = p(np.ascontiguousarray(x.T, dtype=np.float32), sr, reset=True)
    y = np.asarray(y, dtype=np.float64).T
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    out = np.zeros_like(x)
    n = min(len(out), len(y))
    out[:n] = y[:n, :2]
    return out


def render_note(path, midi, seconds, velocity, sr, tail=1.0):
    """One note from an instrument plugin as mono audio (note held `seconds`, plus `tail` for its release)."""
    vel = max(1, min(127, int(velocity * 127)))
    events = [(bytes([0x90, int(midi), vel]), 0.0), (bytes([0x80, int(midi), 0]), float(seconds))]  # raw MIDI + time
    with _lock:
        y = _load(path)(events, duration=float(seconds) + tail, sample_rate=sr, reset=True)
    return np.asarray(y, dtype=np.float64).mean(axis=0)
