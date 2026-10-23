# MLabs features and roadmap

Status: ✅ done · 🟡 basic version. Effort for roadmap items: S = hours, M = a day or two, L = a week or more.

## Workflow

| Feature | Status |
|---|---|
| Menu bar (File, Edit, Add, Patterns, View, Options, Tools, Help) with dropdowns and submenus | ✅ |
| Step Rack: 16-step sequencer, per-channel pan/vol, mixer track number, right-click channel menu | ✅ |
| Patterns: multiple, rename, color, clone, delete, move, transpose, split by channel, render as audio clip | ✅ |
| Piano roll: draw, delete, length, velocity, right-drag erase, C0–B8 with scrolling | ✅ |
| Playlist: 12 tracks × 32 bars, paint and erase by drag, pattern clips, audio clips, automation clips | ✅ |
| Automation: right-click a volume/pan knob or fader → automation clip with a point editor | ✅ volume and pan |
| Live editing during playback (re-renders in the background and swaps in) | ✅ |
| Recording: audio input (24-bit), MIDI keyboard, typing keyboard to piano, precount, tempo tapper | ✅ |
| Undo (50 steps), save/open project (JSON) | ✅ |
| Export: song or stems as WAV 16/24/32-bit float, FLAC 24-bit, MP3 320 kbps at 44.1/48/96 kHz; MIDI export | ✅ |
| Audio device selection, MIDI Out channels for external gear | ✅ |
| Plugin performance monitor (CPU, RAM, audio thread, render time per track) | ✅ |
| Customizable quick buttons, collapsible panels, smooth transitions, reduced-motion support | ✅ |

## Sounds

| Feature | Status |
|---|---|
| Sounds tab: `samples/` plus any folders you add ("+ Add folder…"), read in place | ✅ |
| Filters by category, library, one-shot/loop, stars; waveform, duration, BPM; preview player | ✅ |
| Drag a sound onto the playlist as an audio clip | ✅ |

## Instruments (plugin picker, F8)

| Group | Instruments |
|---|---|
| Drums (synthesized) | Kick, Snare, Hat, Clap, 808, Tom, Rim, Open Hat, Crash, Cowbell, Shaker |
| Synths | Synth, Pluck, Pad, Lead, Guitar, Harp, Strings, Brass, Supersaw, Soft Pad, Chip Lead |
| Bass | Bass, Sub Bass, Reese Bass |
| Keys | Keys, E-Piano (FM), Organ (drawbars), Bell (FM), Marimba (FM) |
| Samplers | Sampler (import WAV), Reverse, Chop (cut itself), Ambient (fades); start/end, fades, reverse, normalize, DC removal |
| External | MIDI Out; custom VST3 instruments (optional add-on) |

## Mixer and effects

16 inserts plus Master, 10 effect slots each (drag to reorder), 3-band EQ per track, routing to group buses, mute/solo, meters. Every effect opens its own plugin window with knobs grouped in sections.

| Group | Effects |
|---|---|
| Distortion | Drive, Soft Clipper, Lo-fi |
| Filter / EQ | Low-pass, High-pass (resonance, 12/24 dB), EQ (low shelf, sweepable mid with Q, high shelf) |
| Dynamics | Compressor (attack, release, knee, mix), Multiband Compressor, Limiter, Gate, Transient |
| Delay / reverb | Delay (tone, ping-pong), Reverb (pre-delay, damping, width) |
| Modulation | Chorus, Flanger, Phaser |
| Pitch | Pitch Shifter (keeps length), Vocoder (built-in carrier) |
| Stereo / gain | Stereo, Auto Pan, Balance |
| Custom | VST3 effects (optional add-on) |

## AI

| Feature | Status |
|---|---|
| Composer: text to music (MusicGen Small/Medium) on the GPU | ✅ |
| Perfect pitch: hum or play into the mic → notes for any instrument, or MusicGen Melody performs it | ✅ monophonic |
| Mix engineer and Mastering engineer roles | 🟡 rule-based |

## Roadmap, in order of value

1. **Time signatures and variable pattern length** (patterns are fixed at one 4/4 bar). M
2. **Time-stretch / BPM sync** in the Sounds preview and sampler. M
3. **VST3 editor windows** and saving plugin settings in the project. L
4. **Automating effect knobs**, not only volume and pan. M
5. **Recording:** loop record, start on input, punch in/out. S each
6. **Piano roll tools:** select/move/copy, velocity lane, scale highlighting, chords. M
7. **Playlist tools:** track names and colors, mute, slice, zoom, markers, loop region. M
8. **Welcome screen** with templates and demo projects, plus MIDI import. M
9. **More effects:** convolution reverb with your own impulses, frequency shifter, spectrum analyzer, EQ with a drawn response curve and log-scaled frequency knobs. S–M each
10. **Sends and sidechain** in the mixer. M
11. **Chord detection** for Perfect pitch so it hears more than one note at a time. M
12. A fine-tuned Mix/Master model to replace the rule-based roles. L
