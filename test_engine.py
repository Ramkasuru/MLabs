"""Self-checks for the engine. Run: python test_engine.py"""
import os
import tempfile

import numpy as np

import engine

BAR = int(16 * engine.step_seconds(120) * engine.SR)


def _one_hit_project(kind="snare"):
    """One channel on insert 1, one hit on step 1."""
    p = engine.new_project()
    p["channels"] = [engine.new_channel(kind, insert=1)]
    p["patterns"] = [engine.new_pattern(1)]
    p["patterns"][0]["steps"][0][0] = True
    return p


def test_render_lengths():
    p = engine.new_project()
    p["patterns"][0]["steps"][0][0] = True                 # kick on beat 1
    p["patterns"][0]["notes"][4].append([4, 4, 60, 1.0])   # synth C5 on beat 2
    p["patterns"].append(engine.new_pattern(5))
    p["playlist"] = [0, 1, 0]                              # old pattern-order format still renders
    audio, loop = engine.render(p)
    assert loop == 3 * BAR and audio.shape[1] == 2 and len(audio) >= loop
    assert np.abs(audio[:BAR // 4]).max() > 0.1           # kick audible
    assert np.abs(audio[BAR:2 * BAR - 2000]).max() < 1e-6  # empty pattern 2 silent (after kick tail)


def test_playlist_clips_stack_across_tracks():
    p = _one_hit_project("kick")
    p["mixer"][0]["vol"] = 0.2  # stay under the safety gain-down so stacking is linear
    p["playlist"] = [{"pattern": 0, "track": 0, "bar": 2}]
    one, loop = engine.render(p)
    p["playlist"].append({"pattern": 0, "track": 3, "bar": 2})  # same bar, another track: plays twice as loud
    two, _ = engine.render(p)
    assert loop == 3 * BAR and np.abs(one[:2 * BAR]).max() < 1e-9
    assert np.allclose(two[2 * BAR:2 * BAR + 1000], 2 * one[2 * BAR:2 * BAR + 1000])
    p["playlist"] = []
    assert engine.render(p)[1] == BAR  # empty song = one silent bar


def test_routing_group_bus_mute_and_solo():
    p = _one_hit_project("kick")
    p["mixer"][0]["vol"] = 0.2
    direct, _ = engine.render(p)
    p["mixer"][1]["route"] = 5           # insert 1 -> insert 5 (group bus) -> master
    p["mixer"][5]["vol"] = 0.5
    grouped, _ = engine.render(p)
    assert np.allclose(grouped[:2000], direct[:2000] * 0.5)
    p["mixer"][5]["route"] = 1           # loop 1 -> 5 -> 1 must not hang: falls back to master
    assert np.abs(engine.render(p)[0]).max() > 0
    p["mixer"][5]["route"] = 0
    p["mixer"][5]["mute"] = True         # muting the bus silences everything routed through it
    assert np.abs(engine.render(p)[0]).max() < 1e-9
    p["mixer"][5]["mute"] = False
    p["mixer"][7]["solo"] = True         # soloing an unrelated track silences ours
    assert np.abs(engine.render(p)[0]).max() < 1e-9
    p["mixer"][7]["solo"], p["mixer"][5]["solo"] = False, True  # soloing our bus keeps what feeds it
    assert np.abs(engine.render(p)[0]).max() > 0


def test_fx_slots_reverb_delay_extend_tail_and_filter_darkens():
    dry, _ = engine.render(_one_hit_project())
    p = _one_hit_project()
    p["mixer"][1]["fx"][0] = engine.new_slot("Delay", feedback=0.5, mix=0.5)
    p["mixer"][1]["fx"][3] = engine.new_slot("Reverb", mix=0.8)
    wet, _ = engine.render(p)
    assert len(wet) > len(dry) + engine.SR  # reverb/echo tail
    p["mixer"][1]["fx"][3]["on"] = False     # bypassed slot does nothing
    p["mixer"][1]["fx"][0] = None
    assert np.allclose(engine.render(p)[0], dry)
    p = _one_hit_project("hat")
    bright, _ = engine.render(p)
    p["mixer"][1]["fx"][0] = engine.new_slot("Low-pass", cutoff=0.4)  # ~316 Hz
    dark, _ = engine.render(p)
    hi = lambda x: np.abs(np.fft.rfft(x[:, 0]))[len(x) // 4:].sum()  # energy above ~11 kHz
    assert hi(dark) < 0.05 * hi(bright)


def test_every_effect_runs_and_stays_finite():
    p = _one_hit_project("snare")
    p["patterns"][0]["notes"] = [[]]
    for i, kind in enumerate(engine.EFFECTS):
        p["mixer"][1]["fx"] = [engine.new_slot(kind)] + [None] * 9
        audio, _ = engine.render(p)
        assert np.isfinite(audio).all() and np.abs(audio).max() > 0, kind


def test_compressor_and_limiter_tame_peaks():
    p = _one_hit_project("kick")
    p["mixer"][0]["vol"] = 0.5
    raw = np.abs(engine.render(p)[0]).max()
    p["mixer"][1]["fx"][0] = engine.new_slot("Compressor", threshold=-30, ratio=10, makeup=0)
    assert np.abs(engine.render(p)[0]).max() < raw * 0.6
    p["mixer"][1]["fx"][0] = engine.new_slot("Limiter", ceiling=-12, gain=0)
    assert np.abs(engine.render(p)[0]).max() <= 10 ** (-12 / 20) * 0.8 * 0.5 + 1e-6  # ceiling x insert vol x master


def test_insert_eq_boosts_lows():
    p = _one_hit_project("kick")
    p["mixer"][0]["vol"] = 0.1
    flat, _ = engine.render(p)
    p["mixer"][1]["eq"]["low"] = 9
    boosted, _ = engine.render(p)
    assert np.abs(boosted).max() > 1.8 * np.abs(flat).max()  # kick is mostly lows: ~+9 dB


def test_meters_follow_signal():
    p = _one_hit_project("kick")
    audio, loop, meters = engine.mix(p, song=False)
    assert len(meters) == len(p["mixer"]) and max(meters[1]) > 0.1 and max(meters[0]) > 0.1
    assert meters[2] == []                                         # silent insert: no meter data
    assert max(meters[1][-5:]) < 0.01                              # kick has died away by the bar end


def test_old_project_upgrades_to_mixer():
    old = {"bpm": 100, "master": 0.7, "playlist": [0],
           "channels": [{"name": "Kick", "kind": "kick", "vol": 0.8, "pan": 0, "wave": "saw", "sample": None,
                         "fx": {"drive": 0.3, "cutoff": 1.0, "delay": 0.0, "reverb": 0.5}}],
           "patterns": [{"steps": [[True] + [False] * 15], "notes": [[]]}]}
    p = engine.normalize_project(old)
    assert p["mixer"][0]["vol"] == 0.7 and p["channels"][0]["insert"] == 1 and "fx" not in p["channels"][0]
    assert [s["type"] for s in p["mixer"][1]["fx"] if s] == ["Drive", "Reverb"]
    assert p["playlist"] == [{"pattern": 0, "track": 0, "bar": 0}]
    assert np.abs(engine.render(p)[0]).max() > 0


def test_loop_buffer_wraps_tails():
    p = _one_hit_project("snare")
    p["mixer"][1]["fx"][0] = engine.new_slot("Reverb", mix=1.0)
    p["patterns"][0]["steps"][0] = [False] * 15 + [True]  # hit on the last step: its tail crosses the loop end
    audio, loop = engine.render(p)
    buf = engine.loop_buffer(audio, loop)
    assert len(audio) > loop and len(buf) == loop
    assert np.abs(buf[:2000]).max() > 1e-3          # tail audible at the loop start
    assert np.abs(audio[:2000]).max() < 1e-6        # ...which the raw render has silent (FFT noise only)


def test_metronome_clicks_on_beats():
    m = engine.metronome(120, BAR)
    beat = int(0.5 * engine.SR)
    assert m.shape == (BAR, 2)
    assert all(np.abs(m[b:b + 200]).max() > 0.1 for b in range(0, BAR, beat))
    assert np.abs(m[beat // 2:beat // 2 + 200]).max() == 0


def test_detect_pitch_and_notes():
    # A4 (440 Hz) for one beat, then E5 for one beat, at 120 bpm
    beat = int(0.5 * engine.SR)
    t = np.arange(beat) / engine.SR
    x = np.concatenate([np.sin(2 * np.pi * 440 * t), np.sin(2 * np.pi * engine.midi_hz(76) * t), np.zeros(beat)])
    notes = engine.audio_to_notes(x, 120)
    assert [n[2] for n in notes] == [69, 76], notes
    assert notes[0][0] == 0 and abs(notes[0][1] - 4) <= 1 and abs(notes[1][0] - 4) <= 1, notes


def test_wav_roundtrip():
    path = os.path.join(tempfile.gettempdir(), "mlabs_test.wav")
    x = np.sin(np.linspace(0, 100, engine.SR)) * 0.5
    engine.write_wav(path, x)
    y = engine.read_wav(path)
    assert len(y) == len(x) and np.abs(x - y).max() < 1e-3


def test_swing_delays_odd_steps():
    p = _one_hit_project("hat")
    p["patterns"][0]["steps"][0] = [False, True] + [False] * 14
    st = engine.step_seconds(120) * engine.SR
    first = lambda x: np.argmax(np.abs(x[:, 0]) > 1e-4)
    straight = first(engine.render(p)[0])
    p["swing"] = 1.0
    assert abs(first(engine.render(p)[0]) - straight - st * 0.5) < 2


def test_stems_sum_to_mix():
    p = engine.new_project()
    p["mixer"][0]["vol"] = 0.2  # stay under the safety gain-down so the mix is linear
    for ci in range(4):
        p["patterns"][0]["steps"][ci][ci * 4] = True
    p["patterns"][0]["notes"][4].append([2, 3, 64, 0.7])
    mix, _ = engine.render(p)
    total = np.zeros_like(mix)
    for ci in range(5):
        s = engine.render(p, only=ci)[0]
        total[:len(s)] += s
    assert np.abs(total - mix).max() < 1e-9


def test_24bit_wav_reads_and_bad_sample_plays_silent():
    import wave
    path = os.path.join(tempfile.gettempdir(), "mlabs_24.wav")
    x = np.sin(np.linspace(0, 200, 4410)) * 0.5
    i24 = (x * 8388607).astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]  # low 3 bytes of each int32
    with wave.open(path, "wb") as w:
        w.setnchannels(1), w.setsampwidth(3), w.setframerate(engine.SR), w.writeframes(i24.tobytes())
    assert np.abs(engine.read_wav(path) - x).max() < 1e-4
    p = _one_hit_project("kick")
    p["channels"].append(engine.new_channel("sample", "Gone", path + ".missing", insert=2))
    p["patterns"][0]["steps"].append([True] + [False] * 15)
    p["patterns"][0]["notes"].append([])
    engine.failed_samples.clear()
    audio, _ = engine.render(p)                   # the kick still plays...
    assert np.abs(audio).max() > 0.1
    assert engine.failed_samples == {path + ".missing"}  # ...and the bad file is reported


def test_reads_ogg_inside_wav_like_fl_packs():
    import io
    import struct

    import soundfile as sf
    x = np.sin(np.linspace(0, 2000, engine.SR // 2)) * 0.5
    ogg = io.BytesIO()
    sf.write(ogg, x, engine.SR, format="OGG", subtype="VORBIS")
    data = ogg.getvalue()
    fmt = struct.pack("<HHIIHH", 0x674F, 1, engine.SR, 0, 0, 0)  # format tag 0x674F = Ogg Vorbis in WAV
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    path = os.path.join(tempfile.gettempdir(), "mlabs_oggwav.wav")
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", len(body)) + body)
    y = engine.read_wav(path)
    assert abs(len(y) - len(x)) < 2000 and np.corrcoef(x[:len(y)][1000:-1000], y[:len(x)][1000:-1000])[0, 1] > 0.99


def test_stems_sum_to_a_loud_mix():
    p = engine.new_project()
    p["mixer"][0]["vol"] = 1.25
    for t in range(1, 6):
        p["mixer"][t]["vol"] = 1.25
    for ci in range(4):
        p["patterns"][0]["steps"][ci] = [True] * 16  # dense and loud: the mix peaks well over 1
    mix, _ = engine.render(p)
    stems = engine.render_stems(p)
    total = np.zeros_like(mix)
    for s in stems:
        total[:len(s)] += s
    assert np.abs(total - mix).max() < 1e-9


def test_ai_mix_balances_levels_and_master_hits_target():
    import ai
    p = engine.new_project()
    p["patterns"][0]["steps"][0] = [s % 4 == 0 for s in range(16)]   # kick
    p["patterns"][0]["steps"][2] = [True] * 16                       # hats, too loud by default
    p["mixer"][2]["route"] = 3                                       # a bus with something routed in
    mixed = ai.auto_mix(p, song=False)
    rms = lambda q, ci: ai._rms_db(engine.render(q, False, 0, only=ci, normalize=False)[0][:engine.render(q, False)[1]])
    want = ai.MIX_TARGETS["kick"] - ai.MIX_TARGETS["hat"]          # balance between tracks, not absolute level
    assert abs((rms(mixed, 0) - rms(mixed, 2)) - want) < 1.0, (rms(mixed, 0), rms(mixed, 2))
    assert any(s and s["type"] == "High-pass" for s in mixed["mixer"][3]["fx"])  # hat's own insert got a high-pass
    assert p["channels"][2]["vol"] == 0.8                                        # original project untouched
    q = engine.new_project()                                                     # one very quiet channel...
    q["patterns"][0]["steps"][0] = [s % 4 == 0 for s in range(16)]
    q["patterns"][0]["steps"][1] = [s % 8 == 4 for s in range(16)]
    q["patterns"][0]["steps"][2] = [True] * 16
    q["patterns"][0]["notes"][4] = [[0, 8, 60, 0.002]]
    vols = [c["vol"] for c in ai.auto_mix(q, song=False)["channels"]]
    assert min(vols[0], vols[1], vols[2]) > 0.2 and vols[4] == 1.0, vols         # ...must not crush the others
    mastered = ai.auto_master(mixed, song=False)
    out, loop = engine.render(mastered, False)
    assert [s["type"] for s in mastered["mixer"][0]["fx"][:3]] == ["EQ", "Compressor", "Limiter"]
    assert abs(ai._rms_db(out[:loop]) - ai.MASTER_TARGET_DB) < 3.0 and np.abs(out).max() <= 1.0


def test_export_every_format_and_rate():
    import soundfile as sf
    x = np.stack([np.sin(np.linspace(0, 3000, engine.SR))] * 2, axis=1) * 0.5
    want = {"wav24": "PCM_24", "wav32f": "FLOAT", "wav16": "PCM_16", "flac24": "PCM_24", "mp3": "MPEG_LAYER_III"}
    for fmt, (_, _, ext, _) in engine.EXPORT_FORMATS.items():
        for rate in engine.EXPORT_RATES:
            path = os.path.join(tempfile.gettempdir(), f"mlabs_export.{ext}")
            used = engine.write_audio(path, x, fmt, rate)
            info = sf.info(path)
            assert info.samplerate == used == (min(rate, 48000) if fmt == "mp3" else rate), (fmt, rate)
            assert info.subtype == want[fmt] and info.channels == 2, (fmt, info.subtype)
            assert abs(info.duration - 1.0) < 0.06, (fmt, rate, info.duration)


def test_live_pitch_names_the_note():
    t = np.arange(8192) / engine.SR
    assert round(engine.pitch_now(np.sin(2 * np.pi * engine.midi_hz(64) * t))) == 64  # E4
    assert engine.pitch_now(np.zeros(8192)) is None


def test_player_mixes_live_notes_and_fades_on_release():
    import app
    pl = app.Player()
    pl._ensure = lambda: None                 # no sound card in tests: drive the callback by hand
    out = np.zeros((512, 2), np.float32)
    pl._callback(out, 512, None, None)
    assert not out.any()                      # stopped, no notes: silence
    note = np.full((engine.SR, 2), 0.25, np.float32)
    pl.note_on("k", note)
    pl._callback(out, 512, None, None)
    assert np.allclose(out, 0.25)             # the live note sounds with the transport stopped
    pl.note_off("k", 0.01)                    # 10 ms release = 441 samples, inside the next 512-sample block
    blocks = []
    for _ in range(2):
        pl._callback(out, 512, None, None)
        blocks.append(out.copy())
    assert blocks[0][0, 0] > blocks[0][400, 0] > 0 == blocks[0][-1, 0]   # fades out, no click, then silent
    assert not blocks[1].any() and not pl._voices                        # and the voice is gone


def test_recorder_takes_and_tracks_level():
    import app
    rec = app.Recorder()
    sig = (np.sin(np.linspace(0, 400, 4410)) * 0.5).astype(np.float32)[:, None]
    rec._callback(sig, len(sig), None, None)           # audio while not recording: meter only
    assert rec.level > 0.4 and rec.stop_take() is None
    rec.start_take()
    for _ in range(3):
        rec._callback(sig, len(sig), None, None)
    take = rec.stop_take()
    assert take.shape == (3 * 4410, 1) and not rec.recording


def test_guitar_pluck_has_right_pitch_and_decays():
    x = engine.synth("pluck", 57, 2.0, release=0.25)              # A3 = 220 Hz
    heard = [p for p in engine.detect_pitch(x[:engine.SR]) if p is not None]
    assert heard and abs(np.median(heard) - 57) < 0.3, np.median(heard)  # the pitch you hear (not the loudest harmonic)
    early = np.abs(x[:4410]).max(); late = np.abs(x[int(1.8 * engine.SR):int(1.9 * engine.SR)]).max()
    assert late < 0.35 * early                                     # a plucked string dies away


def test_hum_rhythm_becomes_steps():
    bursts = np.zeros(int(2.0 * engine.SR))
    for t in (0.0, 0.5, 0.75, 1.5):                                # at 120 bpm: steps 0, 4, 6, 12
        i = int(t * engine.SR) + 100
        bursts[i:i + 2000] = np.random.default_rng(1).uniform(-0.6, 0.6, 2000)
    assert engine.audio_to_hits(bursts, 120) == [0, 4, 6, 12]
    assert engine.audio_to_hits(np.zeros(engine.SR), 120) == []


def test_melody_chroma_follows_the_notes():
    import ai
    sr = 32000
    tone = lambda m: np.sin(2 * np.pi * engine.midi_hz(m) * np.arange(sr) / sr)
    cls = {m: int(np.bincount(ai._chroma(tone(m), sr).argmax(axis=1)).argmax()) for m in (60, 64, 67)}
    assert (cls[64] - cls[60]) % 12 == 4 and (cls[67] - cls[60]) % 12 == 7, cls  # major third, fifth
    c = ai._chroma(tone(60), sr)
    assert c.shape[1] == 12 and np.allclose(c.sum(axis=1), 1)                      # one-hot per frame


def test_midi_export_has_tempo_tracks_and_notes():
    p = engine.new_project()
    p["bpm"] = 100
    p["patterns"][0]["steps"][0][0] = True                      # kick on step 1 -> GM note 36 on channel 10
    p["patterns"][0]["notes"][4] = [[4, 2, 64, 0.5]]             # synth E4 on step 5
    path = os.path.join(tempfile.gettempdir(), "mlabs_test.mid")
    engine.write_midi(p, path, song=False)
    b = open(path, "rb").read()
    assert b[:4] == b"MThd" and int.from_bytes(b[10:12], "big") == 1 + len(p["channels"])  # tempo track + one per channel
    assert int.from_bytes(b[b.index(b"\xff\x51\x03") + 3:b.index(b"\xff\x51\x03") + 6], "big") == 600000  # 100 bpm
    assert bytes([0x99, 36, 100]) in b and bytes([0x80 | 4, 64, 0]) in b and bytes([0x90 | 4, 64, 63]) in b


def test_sampler_settings_and_cut_itself():
    x = np.linspace(0.1, 1.0, engine.SR)                         # 1 s ramp, DC heavy
    y = engine.shape_sample(x, {"start": 0.5, "reverse": True, "normalize": True, "fade_out": 0.1})
    assert abs(len(y) - engine.SR // 2) <= 1 and y[0] == 1.0     # trimmed to the 2nd half, reversed, normalized
    assert y[-1] == 0.0 and y[-int(0.05 * engine.SR)] < 0.6     # faded out
    assert abs(engine.shape_sample(x, {"dc": True}).mean()) < 1e-9
    path = os.path.join(tempfile.gettempdir(), "mlabs_long.wav")
    engine.write_wav(path, np.sin(np.linspace(0, 4000, engine.SR)) * 0.5)  # a 1 s sample, longer than a step
    p = _one_hit_project("kick")
    p["channels"] = [engine.new_channel("sample", "S", path, insert=1)]
    p["patterns"][0]["steps"][0] = [True, False, False, False, True] + [False] * 11
    ring = engine.pattern_channel(p, 0, 0)
    p["channels"][0]["smp"] = {"cut": True}
    cut = engine.pattern_channel(p, 0, 0)
    gap = int(4 * engine.step_seconds(120) * engine.SR)
    assert np.abs(cut[gap - 400:gap - 1]).max() > 0              # first hit still plays up to the second
    assert np.abs(cut[:gap] - ring[:gap]).max() < 1e-9           # ...unchanged before it
    tail = engine.voice(p["channels"][0], 60, 0, 1.0, None)[gap:gap + 2000]
    assert np.allclose((ring - cut)[gap:gap + 2000], tail) and np.abs(tail).max() > 0.1  # exactly the first hit's tail is gone


def test_vst3_effect_slot_runs_through_plugin_host():
    import plugins
    if not plugins.available():                                  # optional add-on: nothing to test without it
        return
    from pedalboard import Gain
    plugins._cache["fake.vst3"] = Gain(gain_db=-6.0)             # stands in for a real plugin file
    p = _one_hit_project("kick")
    p["mixer"][0]["vol"] = 0.5
    dry, _ = engine.render(p)
    p["mixer"][1]["fx"][0] = {"type": "VST3", "path": "fake.vst3", "on": True}
    wet, _ = engine.render(p)
    assert abs(np.abs(wet).max() / np.abs(dry).max() - 10 ** (-6 / 20)) < 0.02
    p["mixer"][1]["fx"][0] = {"type": "VST3", "path": "missing.vst3", "on": True}
    engine.failed_plugins.clear()
    assert np.allclose(engine.render(p)[0], dry) and engine.failed_plugins == {"missing.vst3"}  # skipped, reported


def test_render_timing_is_recorded_per_track():
    p = engine.new_project()
    p["patterns"][0]["steps"][0][0] = True
    p["mixer"][1]["fx"][0] = engine.new_slot("Reverb")
    engine.mix(p, song=False)
    assert engine.last_perf["render_ms"] > 0 and "Kick" in engine.last_perf["tracks"] and "Master" in engine.last_perf["tracks"]


def test_audio_clip_plays_its_sample_at_the_bar():
    path = os.path.join(tempfile.gettempdir(), "mlabs_clip.wav")
    engine.write_wav(path, np.sin(np.linspace(0, 6000, int(2.5 * engine.SR))) * 0.5)   # 2.5 s = 1.25 bars at 120
    p = engine.new_project()
    p["mixer"][0]["vol"] = 0.5
    p["channels"].append(engine.new_channel("sample", "Vox", path, insert=6))
    for pt in p["patterns"]:
        pt["steps"].append([False] * 16); pt["notes"].append([])
    p["playlist"] = [{"type": "audio", "channel": 5, "track": 2, "bar": 1, "seconds": 2.5}]
    audio, loop = engine.render(p)
    assert loop == 3 * BAR                                          # bar 1 + 1.25 bars, rounded up to whole bars
    assert np.abs(audio[:BAR]).max() < 1e-9 and np.abs(audio[BAR:BAR + 2000]).max() > 0.05  # silent until bar 2


def test_automation_clips_ramp_volume_and_pan():
    p = _one_hit_project("hat")
    p["patterns"][0]["steps"][0] = [True] * 16                     # steady hats so the level is easy to read
    p["mixer"][0]["vol"] = 0.6
    p["playlist"] = [{"pattern": 0, "track": 0, "bar": 0}, {"pattern": 0, "track": 0, "bar": 1},
                     {"type": "auto", "key": "mx:0:vol", "track": 1, "bar": 0, "bars": 1, "points": [[0, 0], [1, 0.8]]}]
    out, loop = engine.render(p)
    q = BAR // 4
    early, late, after = (np.abs(out[i:i + q]).max() for i in (0, 3 * q, BAR))
    assert early < 0.4 * late and abs(after - late) / late < 0.35      # rises across bar 1, then holds the last value
    lo, hi = engine.auto_range("mx:0:vol")
    assert (lo, hi) == (0.0, 1.25)
    p["playlist"][2] = {"type": "auto", "key": "ch:0:pan", "track": 1, "bar": 0, "bars": 2, "points": [[0, 0], [1, 1]]}
    out, _ = engine.render(p)
    first, last = out[:q], out[2 * BAR - q:2 * BAR]
    assert np.abs(first[:, 0]).max() > 5 * np.abs(first[:, 1]).max()   # starts hard left
    assert np.abs(last[:, 1]).max() > 5 * np.abs(last[:, 0]).max()     # ends hard right


def test_synth_detune_three_osc():
    a = engine.synth("saw", 60, 0.5)
    b = engine.synth("saw", 60, 0.5, detune=15)
    assert len(a) == len(b) and not np.allclose(a, b) and np.abs(b).max() <= 0.31


def test_synth_adsr_filter_and_presets():
    n = int(0.5 * engine.SR)
    pluck = engine.synth("saw", 60, 0.5, attack=0.002, decay=0.1, sustain=0.0, release=0.1)
    assert np.abs(pluck[int(0.3 * engine.SR):n]).max() < 1e-3        # sustain 0: silent after the decay
    pad = engine.synth("saw", 60, 0.5, attack=0.4)
    assert np.abs(pad[:int(0.02 * engine.SR)]).max() < 0.1 * np.abs(pad).max()  # slow attack: 5% after 20 ms
    assert len(engine.synth("saw", 60, 0.5, release=0.8)) == n + int(0.8 * engine.SR)  # release rings past note-off
    hi = lambda x: np.abs(np.fft.rfft(x))[len(x) // 8:].sum()
    assert hi(engine.synth("saw", 60, 0.5, cutoff=0.4)) < 0.2 * hi(engine.synth("saw", 60, 0.5))
    for name in engine.SYNTH_PRESETS:                                   # every preset renders a note
        p = _one_hit_project("kick")
        p["channels"] = [engine.new_channel("synth", name, insert=1, preset=name)]
        p["patterns"][0]["steps"][0][0] = False
        p["patterns"][0]["notes"] = [[[0, 4, 60, 1.0]]]
        assert np.abs(engine.render(p)[0]).max() > 0.01, name


def _fx(kind, x, **params):
    fn, spec = engine.EFFECTS[kind]
    return fn(x, {k: v[2] for k, v in spec.items()} | params, 0.1)


def _band_energy(x, lo, hi):
    f = np.fft.rfftfreq(len(x), 1 / engine.SR)
    return (np.abs(np.fft.rfft(x[:, 0])) ** 2)[(f >= lo) & (f < hi)].sum()


def test_plugin_knobs_shape_the_sound():
    noise = np.random.default_rng(0).uniform(-0.3, 0.3, (engine.SR, 2))
    # EQ: the middle band boosts around its own frequency, not elsewhere
    boosted = _fx("EQ", noise, mid=12, mid_f=3000, mid_q=2)
    assert _band_energy(boosted, 2800, 3200) > 8 * _band_energy(noise, 2800, 3200)
    assert _band_energy(boosted, 200, 400) < 1.3 * _band_energy(noise, 200, 400)
    # filter resonance adds a peak at the cutoff
    fc = engine._cutoff_hz(0.6)
    flat, reso = _fx("Low-pass", noise), _fx("Low-pass", noise, reso=1)
    assert _band_energy(reso, fc * 0.95, fc * 1.05) > 4 * _band_energy(flat, fc * 0.95, fc * 1.05)
    # multiband with ratio 1 everywhere gives the input back
    same = _fx("Multiband Compressor", noise, low_r=1, mid_r=1, high_r=1, makeup=0)
    assert np.allclose(same, noise, atol=1e-6)
    # gate: a quiet tail after a loud burst is pushed down by the range
    burst = np.concatenate([noise, noise * 0.003])
    gated = _fx("Gate", burst, threshold=-30, range=60)
    assert np.abs(gated[-engine.SR // 2:]).max() < 0.01 * np.abs(burst[-engine.SR // 2:]).max()
    # balance invert flips the polarity, lo-fi quantizes to few levels
    assert np.allclose(_fx("Balance", noise, invert=1), -noise)
    assert len(np.unique(_fx("Lo-fi", noise, bits=3, mix=1))) <= 9


def test_new_drums_synths_and_pitch_effects():
    rng = np.random.default_rng(0)
    for kind in engine.DRUMS:
        hit = engine.drum(kind, rng)
        assert np.isfinite(hit).all() and np.abs(hit).max() > 0.05, kind
    for name in engine.SYNTH_PRESETS:
        ch = engine.new_channel("synth", name, preset=name)
        assert np.abs(engine.voice(ch, 60, 0.3, 1.0, rng)).max() > 0.02, name
    # pitch shifter: a 440 Hz tone up 12 semitones peaks at 880 Hz and keeps its length
    t = np.arange(engine.SR) / engine.SR
    tone = np.repeat(np.sin(2 * np.pi * 440 * t)[:, None], 2, axis=1) * 0.5
    up = _fx("Pitch Shifter", tone, semis=12)
    f = np.fft.rfftfreq(len(up), 1 / engine.SR)
    assert len(up) == len(tone) and abs(f[np.argmax(np.abs(np.fft.rfft(up[:, 0])))] - 880) < 10
    # vocoder: silence in gives (near) silence out; a voice-like input gives carrier sound out
    assert np.abs(_fx("Vocoder", tone * 0)).max() < 1e-3
    assert np.abs(_fx("Vocoder", tone)).max() > 0.01
    # phaser changes the spectrum but keeps the level sane
    noise = np.random.default_rng(1).uniform(-0.3, 0.3, (engine.SR, 2))
    ph = _fx("Phaser", noise)
    assert not np.allclose(ph, noise) and np.abs(ph).max() < 1.0
    # an effect this build doesn't know is skipped instead of breaking the render
    p = _one_hit_project("kick")
    p["mixer"][1]["fx"][0] = {"type": "NotAnEffect", "on": True, "params": {}}
    assert np.abs(engine.render(p)[0]).max() > 0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
