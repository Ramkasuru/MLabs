// MLabs UI. Project state lives here; Python (window.pywebview.api) renders, plays, saves and runs AI.
const STEPS = 16, LOW = 12, HIGH = 120, BARS = 32, TRACKS = 12;  // piano roll spans C0..B8; scroll for the rest
const BW = 60, TH = 38, CW = 30, RH = 14; // playlist bar/track and piano-roll cell sizes (px)
const COLORS = ["#9DC0B6", "#D2B1AE", "#DDC9A8", "#A4BCD0", "#BBAED0", "#AFC8A2", "#CDBB96", "#A6C8C8"];
const KINDS = [["kick", "Kick", "Pitched sine thump"], ["snare", "Snare", "Noise + body tone"],
  ["hat", "Hat", "Bright noise tick"], ["clap", "Clap", "Triple noise burst"], ["808", "808", "Long sub kick with drop"],
  ["tom", "Tom", "Tuned drum with a pitch fall"], ["rim", "Rim", "Short woody click"], ["openhat", "Open Hat", "Ringing noise hat"],
  ["crash", "Crash", "Long cymbal wash"], ["cowbell", "Cowbell", "Two detuned square tones"], ["shaker", "Shaker", "Soft noise swell"]];
const PRESET_DESC = { Pluck: "Short, bright, decays fast", Pad: "Slow swell, wide and soft", Bass: "Octave down, round and tight",
  Lead: "Bright, sustained melody", Keys: "Electric-piano-like hits", Guitar: "Plucked string (physical model)",
  "E-Piano": "FM electric piano, mellows as it rings", Organ: "Drawbar organ, steady tone", Bell: "Metallic FM bell",
  Marimba: "Wooden FM mallet", Harp: "Long plucked string", Strings: "Slow detuned saw ensemble", Brass: "Saw with a filter swell",
  Supersaw: "Wide detuned saw lead", "Soft Pad": "Gentle triangle pad", "Sub Bass": "Pure sine, octave down",
  "Reese Bass": "Detuned saw bass", "Chip Lead": "8-bit square" };
const KEYS = new Set(["Keys", "E-Piano", "Organ", "Bell", "Marimba"]);
const BASSES = new Set(["Bass", "Sub Bass", "Reese Bass"]);
const presetCat = pr => (KEYS.has(pr) ? "Keys" : BASSES.has(pr) ? "Bass" : "Synth");
const SAMPLERS = [["Reverse Sampler", "Plays a WAV backwards", { reverse: true }],
  ["Chop Sampler", "Each hit cuts the last", { cut: true, fade_out: 0.03 }],
  ["Ambient Sampler", "Normalized, slow fades", { normalize: true, fade_in: 0.4, fade_out: 0.6 }]];
async function addSampler(name, smp) {
  const path = await call("pick_sample");
  if (path) addSound("sample", name, path, null, () => { P.channels.at(-1).smp = { ...smp }; });
}
let PRESETS = [];
const NS = "http://www.w3.org/2000/svg";
const FXDESC = { "Drive": "Warm saturation", "Low-pass": "Darken, with resonance", "High-pass": "Thin out the lows",
  "EQ": "Low shelf, sweepable mid, high shelf", "Compressor": "Even out dynamics", "Limiter": "Loud with no clipping",
  "Delay": "Tempo-synced ping-pong echoes", "Reverb": "Room and hall space", "Chorus": "Thicken and widen",
  "Stereo": "Stereo width and pan", "Soft Clipper": "Catch peaks warmly", "Lo-fi": "Bitcrush and downsample",
  "Multiband Compressor": "Three-band dynamics", "Gate": "Cut the quiet parts", "Transient": "Punch up or soften hits",
  "Flanger": "Jet-plane sweep", "Phaser": "Swirling allpass sweep", "Pitch Shifter": "Change pitch, keep length",
  "Vocoder": "Robot voice from a built-in carrier", "Auto Pan": "LFO pan and tremolo", "Balance": "Volume, pan, phase" };

let P, cur = 0, target = 4, song = false, playing = false, metro = false, hist = [];
let EFX = {}, selTrack = 1, selSlot = 0, meterTimer = 0;
let loop = 0, t0 = 0, raf = 0, lastStep = -1, replayTimer = 0, tab = "samp", openSettings = -1;

const $ = s => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k === "value") e.value = v;
    else if (k === "draggable") e.draggable = !!v;  // the attribute needs "true", not ""
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
function icon(d) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`;
  return s;
}
const SLIDERS = "M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 3v3M5.5 10v3";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const color = pi => P?.patterns[pi]?.color || COLORS[pi % COLORS.length];
const base = p => p.split(/[\\/]/).pop().replace(/\.wav$/i, "");

// work-in-progress notice: shown once per launch, closes itself after 5 s (or on click)
function showNotice() {
  const n = $("#notice");
  n.hidden = false;
  n.onclick = () => { n.hidden = true; };
  setTimeout(() => { n.hidden = true; }, 5000);
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 3200);
}
async function call(name, ...args) {
  try { return await window.pywebview.api[name](...args); }
  catch (e) { toast(e.message || String(e)); return undefined; }
}

// ---------- model ----------
function emptyPattern(name) {
  return { name, steps: P.channels.map(() => Array(STEPS).fill(false)), notes: P.channels.map(() => []) };
}
function normalize(p) {  // Python already upgraded the format; this only fills UI-only fields
  p.patterns.forEach((pt, i) => { pt.name ??= `Pattern ${i + 1}`; });
  return p;
}
function addChannel(ch) {
  // auto-link to a truly free insert: no channel on it, nothing routed
  // into it, still default-named. Otherwise a group bus like "Drum Bus" would get taken over.
  const used = new Set(P.channels.map(c => c.insert));
  const ins = P.mixer.findIndex((tr, t) => t > 0 && !used.has(t) && /^Insert \d+$/.test(tr.name)
    && !P.mixer.some(o => o.route === t));
  if (ins > 0) P.mixer[ins].name = ch.name;
  ch.insert = Math.max(ins, 0);
  P.channels.push(ch);
  P.patterns.forEach(pt => { pt.steps.push(Array(STEPS).fill(false)); pt.notes.push([]); });
  target = P.channels.length - 1;
}
// the engine builds the channel (its defaults/presets live in Python), then it joins the rack as one undo step
async function addSound(kind, name, sample = null, preset = null, after = null) {
  const ch = await call("new_channel", kind, name, sample, preset);
  if (!ch) return;
  edit(() => { addChannel(ch); if (after) after(); });
  toast(`Added "${name}" to the Step Rack`);
}
function newSlot(type) {
  return { type, on: true, params: Object.fromEntries(Object.entries(EFX[type]).map(([k, v]) => [k, v[2]])) };
}
function removeChannel(ci) {
  remapChannels(i => (i === ci ? -1 : i > ci ? i - 1 : i));
  P.channels.splice(ci, 1);
  P.patterns.forEach(pt => { pt.steps.splice(ci, 1); pt.notes.splice(ci, 1); });
  target = clamp(target, 0, P.channels.length - 1);
  openSettings = -1;
}

// edits: snapshot for undo, re-render, and re-trigger playback so changes are heard
function snap() { hist.push(JSON.stringify(P)); if (hist.length > 50) hist.shift(); }
function edit(fn) { snap(); fn(); render(); replay(); }
// while playing, edits hot-swap the audio in Python; the loop keeps its position
function replay() { if (playing) { clearTimeout(replayTimer); replayTimer = setTimeout(play, 120); } }
function undo() {
  if (!hist.length) return toast("Nothing to undo");
  P = JSON.parse(hist.pop());
  cur = clamp(cur, 0, P.patterns.length - 1);
  target = clamp(target, 0, P.channels.length - 1);
  render(); replay();
}

// ---------- render ----------
function render() { renderTop(); renderBrowser(); renderPlaylist(); renderRack(); renderRoll(); renderMixer(); }

function renderTop() {
  $("#bpm").value = P.bpm;
  $("#swing").value = Math.round(P.swing * 100);
  $("#patSel").replaceChildren(...P.patterns.map((pt, i) => h("option", { value: i, selected: i === cur }, pt.name)));
  $("#modePat").classList.toggle("on", !song);
  $("#modeSong").classList.toggle("on", song);
  $("#metro").classList.toggle("on", metro);
}

function item(dot, title, sub, onclick) {
  return h("button", { class: "item", onclick }, h("span", { class: "dot" }, dot), h("span", {}, title, h("small", {}, sub)));
}
function renderBrowser() {
  document.querySelectorAll(".tabs button[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const list = $("#browserList");
  if (tab === "inst") {
    list.replaceChildren(h("div", { class: "label section" }, "Drums"),
      ...KINDS.map(([k, name, sub]) => item(name[0], name, sub, () => addSound(k, name))),
      h("div", { class: "label section" }, "Synths"),
      item("S", "Synth", "Plain 3-osc · shape it in its settings", () => addSound("synth", "Synth")),
      ...PRESETS.map(pr => item(pr[0], pr, PRESET_DESC[pr] || "Synth preset", () => addSound("synth", pr, null, pr))));
  } else if (tab === "fx") {
    list.replaceChildren(h("div", { class: "label section" }, `Adds to the selected mixer track (${P.mixer[selTrack].name})`),
      ...Object.keys(EFX).map(name => item(name.slice(0, 2), name, FXDESC[name] || "", () => addEffect(name))));
  } else if (tab === "samp") {
    soundsPanel(list);
  } else if (tab === "pitch") {
    pitchPanel(list);
  } else {
    list.replaceChildren(...aiPanel());
  }
}

// ---------- Sounds tab: filters, rows with waveform/duration/BPM/star/add, preview player ----------
const LIB = { q: "", source: "", category: "", kind: "", starred: false, limit: 100, timer: 0, items: [], total: 0, sel: -1,
  vol: 0.8, stars: new Set(), info: {} };
const fmtDur = s => (s == null ? "–" : s < 10 ? `${s.toFixed(2)}s` : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`);
function waveSvg(peaks, cls) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 48 10"); s.setAttribute("preserveAspectRatio", "none"); s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = (peaks || []).map((p, i) => `<rect x="${i + .15}" y="${5 - Math.max(.4, p * 5)}" width=".7" height="${Math.max(.8, p * 10)}"/>`).join("");
  return s;
}
function soundsPanel(list) {
  const results = h("div", { class: "results" }), count = h("span", { class: "label" }, "Searching…");
  const player = h("div", { class: "splayer" });
  const seg = (vals, key) => h("div", { class: "seg wide", role: "group" }, ...vals.map(([v, label]) =>
    h("button", { class: LIB[key] === v ? "on" : "", "aria-pressed": LIB[key] === v,
      onclick: () => { LIB[key] = v; LIB.limit = 100; soundsPanel(list); } }, label)));
  const catSel = h("select", { "aria-label": "Category", onchange: e => { LIB.category = e.target.value; LIB.limit = 100; search(); } },
    h("option", { value: "" }, "All categories"));
  const srcSel = h("select", { "aria-label": "Library", onchange: e => { LIB.source = e.target.value; LIB.category = ""; LIB.limit = 100; search(); } },
    h("option", { value: "" }, "All libraries"));
  const q = h("input", { type: "search", placeholder: "Search sounds", value: LIB.q, "aria-label": "Search sounds",
    oninput: e => { LIB.q = e.target.value; LIB.limit = 100; clearTimeout(LIB.timer); LIB.timer = setTimeout(search, 200); } });
  const paintInfo = () => results.querySelectorAll(".srow").forEach(row => {
    const inf = LIB.info[row.dataset.path];
    if (!inf || row.dataset.painted) return;
    row.dataset.painted = "1";
    row.querySelector(".sdur").textContent = fmtDur(inf.seconds);
    row.querySelector(".sbpm").textContent = inf.bpm || "–";
    row.querySelector(".swave").replaceWith(waveSvg(inf.peaks, "swave"));
  });
  const fill = () => {  // durations, waveforms and BPM arrive after the rows, in small batches
    const need = LIB.items.map(it => it.path).filter(p => !LIB.info[p]);
    const batch = async i => {
      if (i >= need.length || tab !== "samp") return;
      Object.assign(LIB.info, (await call("sound_info", need.slice(i, i + 30))) || {});
      paintInfo(); renderPlayer(); batch(i + 30);
    };
    paintInfo(); batch(0);
  };
  const select = (i, play) => {
    LIB.sel = i;
    results.querySelectorAll(".srow").forEach((r, j) => r.classList.toggle("sel", j === i));
    renderPlayer();
    if (play && LIB.items[i]) call("preview", LIB.items[i].path, LIB.vol);
  };
  const toggleStar = it => {
    LIB.stars.has(it.path) ? LIB.stars.delete(it.path) : LIB.stars.add(it.path);
    call("set_setting", "starred", [...LIB.stars]);
  };
  const add = it => addSound("sample", it.name.slice(0, 14), it.path);
  const renderPlayer = () => {
    const it = LIB.items[LIB.sel];
    if (!it) { player.replaceChildren(h("div", { class: "label" }, "Select a sound to preview")); return; }
    const inf = LIB.info[it.path] || {};
    player.replaceChildren(
      h("div", { class: "sp-head" },
        h("button", { class: "star" + (LIB.stars.has(it.path) ? " on" : ""), "aria-label": "Star",
          onclick: () => { toggleStar(it); soundsPanel(list); } }, "★"),
        h("span", { class: "sp-name", title: `${it.source} / ${it.folder}` }, it.name),
        h("button", { class: "chip", title: "Add to the Step Rack", "aria-label": `Add ${it.name}`, onclick: () => add(it) }, "+")),
      waveSvg(inf.peaks, "sp-wave"),
      h("div", { class: "sp-ctrl" },
        h("button", { class: "chip", "aria-label": "Previous sound", onclick: () => select(Math.max(0, LIB.sel - 1), true) }, "⏮"),
        h("button", { class: "chip", "aria-label": "Play preview", onclick: () => select(LIB.sel, true) }, "▶"),
        h("button", { class: "chip", "aria-label": "Stop preview", onclick: () => call("preview_stop") }, "■"),
        h("button", { class: "chip", "aria-label": "Next sound", onclick: () => select(Math.min(LIB.items.length - 1, LIB.sel + 1), true) }, "⏭"),
        h("input", { type: "range", min: 0, max: 100, value: Math.round(LIB.vol * 100), "aria-label": "Preview volume",
          oninput: e => { LIB.vol = +e.target.value / 100; } })),
      h("div", { class: "fxin" }, `${fmtDur(inf.seconds)} · ${inf.bpm ? inf.bpm + " BPM" : it.kind === "loop" ? "loop" : "one-shot"} · ${it.category}`));
  };
  const search = async () => {
    const r = await call("library", LIB.q, LIB.source || null, LIB.limit, LIB.category || null, LIB.kind || null, LIB.starred);
    if (!r || tab !== "samp") return;  // the user may have switched tabs while this was loading
    LIB.items = r.items; LIB.total = r.total;
    if (LIB.sel >= LIB.items.length) LIB.sel = -1;
    srcSel.replaceChildren(h("option", { value: "" }, "All libraries"), ...r.sources.map(x => h("option", { value: x, selected: x === LIB.source }, x)));
    catSel.replaceChildren(h("option", { value: "" }, "All categories"), ...r.categories.map(x => h("option", { value: x, selected: x === LIB.category }, x)));
    count.textContent = `${r.total} sound${r.total === 1 ? "" : "s"}`;
    results.replaceChildren(...r.items.map((it, i) => h("div", { class: "srow" + (i === LIB.sel ? " sel" : ""), "data-path": it.path,
        draggable: true, title: "Drag onto the playlist for an audio clip",
        ondragstart: e => { e.dataTransfer.setData("text/mlabs-sound", it.path); e.dataTransfer.effectAllowed = "copy"; },
        onclick: () => select(i), ondblclick: () => add(it) },
      h("button", { class: "sp", "aria-label": `Preview ${it.name}`, onclick: e => { e.stopPropagation(); select(i, true); } }, "▶"),
      h("span", { class: "sdur" }, "…"),
      h("div", { class: "smain" }, h("div", { class: "sname", title: `${it.source} / ${it.folder}` }, it.name), h("div", { class: "swave" })),
      h("span", { class: "sbpm", title: "BPM (from the file name)" }, ""),
      h("button", { class: "star" + (LIB.stars.has(it.path) ? " on" : ""), "aria-label": `Star ${it.name}`, "aria-pressed": LIB.stars.has(it.path),
        onclick: e => { e.stopPropagation(); toggleStar(it); e.currentTarget.classList.toggle("on"); } }, "★"),
      h("button", { class: "sadd", title: "Add to the Step Rack", "aria-label": `Add ${it.name}`,
        onclick: e => { e.stopPropagation(); add(it); } }, "+"))),
      r.total > r.items.length ? h("button", { class: "more", onclick: () => { LIB.limit += 100; search(); } },
        `Show more (${r.total - r.items.length} left)`) : null);
    fill(); renderPlayer();
  };
  list.replaceChildren(q, h("div", { class: "frow" }, catSel, srcSel),
    h("div", { class: "frow" }, seg([["", "All"], ["oneshot", "One-shot"], ["loop", "Loop"]], "kind"),
      h("button", { class: "starbtn" + (LIB.starred ? " on" : ""), "aria-pressed": LIB.starred, title: "Starred sounds only",
        onclick: () => { LIB.starred = !LIB.starred; LIB.limit = 100; soundsPanel(list); } }, "★ Starred")),
    h("div", { class: "frow between" }, count, h("span", {},
      h("button", { class: "linkbtn", title: "Show a folder of WAVs here (read in place, never copied)",
        onclick: async () => { const name = await call("add_library"); if (name) { LIB.source = ""; toast(`Added library: ${name}`); soundsPanel(list); } } }, "+ Add folder…"),
      h("button", { class: "linkbtn", onclick: importWav }, "+ Import WAV…"))),
    results, player);
  search();
}

// ---------- PITCH tab: the AI hears your hum or instrument and turns it into the part you choose ----------
const HUM = { style: "melody", take: null, heard: "", seconds: 8, busy: false, timer: 0, recording: false,
  styles: { notes: ["melody", "guitar", "bass", "keys", "pad"], drums: ["kick", "snare", "hat", "clap"] } };
const cap = s => s[0].toUpperCase() + s.slice(1);
const note = text => h("small", { style: "color:var(--ink-3)" }, text);
function pitchPanel(list) {
  call("ai_warmup", "melody");  // first visit: start loading MusicGen Melody in the background
  const isDrum = HUM.styles.drums.includes(HUM.style);
  const chip = s => h("button", { class: "stylechip" + (HUM.style === s ? " on" : ""), "aria-pressed": HUM.style === s,
    onclick: () => { HUM.style = s; pitchPanel(list); } }, cap(s));
  list.replaceChildren(
    h("div", { class: "label section" }, "Listening"),
    h("div", { class: "listen" }, h("div", { class: "inmeter", "aria-hidden": "true" }, h("i", { id: "pLevel" })),
      h("div", { class: "tuner" }, h("span", { id: "pNote" }, "–"), h("small", { id: "pCents" }, "hum or play a note"))),
    h("button", { class: "bigrec" + (HUM.recording ? " on" : ""), onclick: humRecord },
      HUM.recording ? "■ Stop" : HUM.take ? "● Record again" : "● Record from mic"),
    h("div", { class: "fxin", id: "pTake" }, HUM.recording ? "Recording… hum, sing, whistle or play"
      : HUM.take ? `Take: ${HUM.take.seconds}s${HUM.heard ? " · heard " + HUM.heard : ""}` : "Your take stays on this PC."),
    h("button", { class: "linkbtn", onclick: async () => {
      const path = await call("pick_sample");
      if (path) { HUM.take = { path, seconds: "?" }; await humHear(); pitchPanel(list); } } }, "…or use a WAV file"),
    h("div", { class: "label section" }, "Make it a"),
    h("div", { class: "chips" }, ...HUM.styles.notes.map(chip)),
    h("div", { class: "chips" }, ...HUM.styles.drums.map(chip)),
    h("div", { class: "frow" },
      h("button", { class: "on", disabled: !HUM.take || HUM.busy, onclick: humCreate,
        title: isDrum ? "Each sound you made becomes a hit" : "Your notes go into the piano roll, fully editable" },
        isDrum ? "Create rhythm" : "Create notes"),
      h("button", { disabled: !HUM.take || HUM.busy, onclick: humGenerate,
        title: "MusicGen Melody plays your hum back as this instrument (large one-time download)" },
        HUM.busy ? "Generating…" : "✦ AI generate"),
      h("select", { "aria-label": "AI clip length", onchange: e => { HUM.seconds = +e.target.value; } },
        ...[4, 8, 15, 30].map(s => h("option", { value: s, selected: s === HUM.seconds }, `${s}s`)))),
    h("div", { class: "fxin", id: "humStatus", "aria-live": "polite" }, ""),
    note("Create keeps your exact notes. AI generate makes a new performance that follows your tune in that sound."));
  pitchListen();
}
function pitchListen() {
  clearInterval(HUM.timer);
  call("input_open");
  HUM.timer = setInterval(async () => {
    if (tab !== "pitch" && !HUM.recording) {
      clearInterval(HUM.timer);
      if ($("#ioPanel").hidden && !IO.recording) call("input_close");
      return;
    }
    let s; try { s = await window.pywebview.api.input_status(); } catch { return; }
    const lv = $("#pLevel"); if (!lv) return;
    lv.style.width = `${Math.min(100, s.level * 140)}%`;
    if (s.midi != null) {
      const m = Math.round(s.midi), c = Math.round((s.midi - m) * 100);
      $("#pNote").textContent = noteName(m); $("#pCents").textContent = `${c > 0 ? "+" : ""}${c} cents`;
    } else { $("#pNote").textContent = "–"; $("#pCents").textContent = s.level > 0.01 ? "no clear pitch" : "hum or play a note"; }
    if (HUM.recording) $("#pTake").textContent = `Recording… ${s.seconds}s`;
  }, 100);
}
async function humRecord() {
  if (!HUM.recording) {
    if (await call("record_start") === undefined) return;
    HUM.recording = true;
  } else {
    HUM.recording = false;
    const take = await call("record_stop");
    if (!take) { toast("Nothing came in. Check your input in Audio & MIDI (F10)."); renderBrowser(); return; }
    HUM.take = take;
    await humHear();
  }
  renderBrowser();
}
async function humHear() {  // show what the AI heard straight away
  const notes = (await call("transcribe", HUM.take.path, P.bpm)) || [];
  HUM.heard = notes.length ? notes.slice(0, 8).map(n => noteName(n[2])).join(" ") + (notes.length > 8 ? " …" : "") : "";
}
function spill(put) {  // patterns are one bar; longer phrases continue in the next patterns
  return st => {
    const pi = cur + Math.floor(st / STEPS);
    while (pi >= P.patterns.length) P.patterns.push(emptyPattern(`Pattern ${P.patterns.length + 1}`));
    put(P.patterns[pi], st % STEPS);
  };
}
async function humCreate() {
  const res = await call("hum_to", HUM.take.path, HUM.style, P.bpm);
  if (!res) return;
  const label = cap(HUM.style);
  if (res.kind === "hits") {
    if (!res.steps.length) return toast("No clear hits in that take. Try short, separate sounds.");
    await addSound(HUM.style, label, null, null, () => {
      const ci = P.channels.length - 1;
      res.steps.forEach(spill((pt, s) => { pt.steps[ci][s] = true; }));
    });
  } else {
    if (!res.notes.length) return toast("No clear notes in that take. Single notes work best.");
    await addSound("synth", label, null, res.preset, () => {
      const ci = P.channels.length - 1;
      res.notes.forEach(([st, len, m, vel]) => spill((pt, s) => pt.notes[ci].push([s, Math.min(len, STEPS - s), m, vel]))(st));
    });
    show("rollPanel"); render();
  }
}
async function humGenerate() {
  HUM.busy = true; renderBrowser();
  const t = setInterval(async () => {
    const s = await window.pywebview.api.gen_status().catch(() => null), el = $("#humStatus");
    if (s && el && s.stage !== "idle") el.textContent = `${s.stage} · ${s.elapsed}s`;
  }, 700);
  const path = await call("generate_hum", HUM.take.path, HUM.style, P.bpm, HUM.seconds);
  clearInterval(t);
  HUM.busy = false; renderBrowser();
  if (path) addSound("sample", `AI ${cap(HUM.style)}`, path, null, () => { P.patterns[cur].steps[P.channels.length - 1][0] = true; });
}

// ---------- AI tab: a role picker styled like a model picker ----------
const AI = { role: "composer", models: [], model: null, seconds: 8, prompt: "", busy: false, timer: 0 };
const ROLE_INFO = {
  composer: { name: "Composer", sub: "Describe it, get a clip", key: "1" },
  mix: { name: "Mix engineer", sub: "Balance every channel", key: "2" },
  master: { name: "Mastering engineer", sub: "Loud, clean, release-ready", key: "3" },
  pitch: { name: "Perfect pitch", sub: "Hum it, hear it as any instrument", key: "4" },
};
const shortModel = () => (AI.model || "").split(" ·")[0].replace("MusicGen ", "");
function aiPanel() {
  const r = ROLE_INFO[AI.role];
  const body = AI.role === "composer"
    ? [h("textarea", { class: "aiprompt", placeholder: "Describe the music… e.g. dreamy lofi drums with vinyl crackle, 85 bpm",
        "aria-label": "Music prompt", value: AI.prompt, oninput: e => { AI.prompt = e.target.value; },
        onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(); } })]
    : [note(AI.role === "mix"
      ? "Balances every channel against the others, pans hats and claps slightly, and high-passes hats, snares and claps on their own insert. It works on what PAT/SONG plays. Ctrl+Z undoes it."
      : "Puts EQ → Compressor → Limiter on Master and sets a streaming-ready loudness. Other Master effects are kept. Ctrl+Z undoes it.")];
  const action = AI.role === "composer"
    ? h("button", { class: "on", disabled: AI.busy, onclick: generate, title: "Ctrl+Enter" }, AI.busy ? "Generating…" : "Generate")
    : h("button", { class: "on", onclick: () => assist(AI.role === "mix" ? "ai_mix" : "ai_master", AI.role === "mix" ? "Mixed" : "Mastered") },
        AI.role === "mix" ? "Mix my song" : "Master my song");
  const gpu = h("p", { class: "gpunote" }, h("strong", {}, "GPU: an NVIDIA card with 4 GB+ VRAM (8 GB for Perfect pitch AI) and CUDA PyTorch."),
    " Without one it runs on the CPU, roughly 10× slower. Models download on first use (about 2–4 GB).");
  return [h("div", { class: "aicard" + (AI.role === "composer" ? " composer" : "") },
      h("div", { class: "aihead" }, h("div", { class: "aititle" }, r.name), note(r.sub)),
      ...body,
      h("div", { class: "aibar" },
        h("button", { class: "pill", id: "aiPill", "aria-haspopup": "menu", "aria-expanded": "false", onclick: e => openPick(e.currentTarget) },
          h("span", {}, r.name), AI.role === "composer" ? h("span", { class: "pdetail" }, `${shortModel()} · ${AI.seconds}s`) : null,
          h("span", { "aria-hidden": "true" }, "⌄")),
        action),
      h("div", { id: "genStatus", class: "fxin", "aria-live": "polite" }, AI.busy ? "starting…" : "")),
    AI.role === "composer" ? gpu : null].filter(Boolean);
}
let pickBox = null;
function openPick(anchor, view = "main") {
  if (!pickBox) { pickBox = h("div", { class: "menu glass pick", role: "menu" }); document.body.append(pickBox); }
  const row = (label, right, onclick, opts = {}) => h("button", { class: "mitem pi" + (opts.on ? " cur" : ""), role: "menuitem", onclick },
    h("span", { class: "mlabel" }, label, opts.sub ? h("small", {}, opts.sub) : null),
    opts.badge ? h("span", { class: "badge" }, opts.badge) : null, h("span", { class: "mkey" }, right));
  const pick = role => { closePick(); if (role === "pitch") { openTab("pitch"); return; } AI.role = role; renderBrowser(); };
  let items;
  if (view === "model") {
    items = [row("‹ Model", "", () => openPick(anchor, "main")), h("div", { class: "msep" }),
      ...AI.models.map(m => row(m.split(" ·")[0], m === AI.model ? "✓" : "", () => { AI.model = m; closePick(); renderBrowser(); },
        { badge: /Medium/.test(m) ? "Slower, richer" : "Fast", on: m === AI.model }))];
  } else if (view === "length") {
    items = [row("‹ Length", "", () => openPick(anchor, "main")), h("div", { class: "msep" }),
      ...[4, 8, 15, 30].map(s => row(`${s} seconds`, s === AI.seconds ? "✓" : "", () => { AI.seconds = s; closePick(); renderBrowser(); }, { on: s === AI.seconds }))];
  } else {
    items = [...Object.entries(ROLE_INFO).map(([k, v]) => row(v.name, k === AI.role ? "✓" : v.key, () => pick(k), { sub: v.sub, on: k === AI.role })),
      h("div", { class: "msep" }),
      ...(AI.role === "composer" ? [row("Model", `${shortModel()}  ›`, () => openPick(anchor, "model")),
        row("Length", `${AI.seconds}s  ›`, () => openPick(anchor, "length")), h("div", { class: "msep" })] : []),
      h("div", { class: "pfoot" }, "Runs on this PC · each model downloads on first use")];
  }
  pickBox.replaceChildren(...items);
  pickBox.hidden = false;
  const a = anchor.getBoundingClientRect();
  pickBox.style.left = `${Math.max(8, a.left)}px`;
  pickBox.style.top = `${Math.max(8, a.top - pickBox.offsetHeight - 8)}px`;  // opens upward, like the reference
  anchor.setAttribute("aria-expanded", "true");
  pickBox.querySelector(".pi")?.focus();
  pickBox.onkeydown = e => {
    const role = Object.keys(ROLE_INFO).find(k => ROLE_INFO[k].key === e.key);
    const its = [...pickBox.querySelectorAll(".pi")], at = its.indexOf(document.activeElement);
    if (view === "main" && role) { e.preventDefault(); pick(role); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); its[(at + (e.key === "ArrowDown" ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === "Escape") { closePick(); anchor.focus(); }
  };
}
function closePick() { if (pickBox) pickBox.hidden = true; $("#aiPill")?.setAttribute("aria-expanded", "false"); }
document.addEventListener("pointerdown", e => { if (pickBox && !pickBox.hidden && !e.target.closest(".pick, #aiPill")) closePick(); });

async function generate() {
  if (!AI.prompt.trim()) return toast("Describe the music first");
  AI.busy = true; renderBrowser();
  AI.timer = setInterval(async () => {  // the call blocks for a while: show what Python is doing
    const s = await window.pywebview.api.gen_status().catch(() => null), el = $("#genStatus");
    if (s && el && s.stage !== "idle") el.textContent = `${s.stage} · ${s.elapsed}s`;
  }, 700);
  const path = await call("generate", AI.prompt.trim(), AI.model, AI.seconds);
  clearInterval(AI.timer);
  AI.busy = false; renderBrowser();
  if (path) addSound("sample", "AI clip", path, null, () => { P.patterns[cur].steps[P.channels.length - 1][0] = true; });
}

async function assist(name, verb) {
  toast(`${verb.replace(/ed$/, "ing")}…`);
  const res = await call(name, P, song, cur);
  if (!res) return;
  edit(() => { P = normalize(res); });
  $("#mixer").hidden = false; renderTop();
  toast(`${verb}. Ctrl+Z undoes it.`);
}

function preview(pt) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 16 12");
  s.setAttribute("preserveAspectRatio", "none");
  const n = Math.max(pt.steps.length, 1);
  let body = "";
  pt.steps.forEach((row, ci) => row.forEach((on, st) => {
    if (on) body += `<rect x="${st + .1}" y="${ci * 12 / n}" width=".7" height="${12 / n * .8}"/>`;
  }));
  pt.notes.forEach(ns => ns.forEach(([st, len, m]) => {
    body += `<rect x="${st}" y="${(HIGH - 1 - clamp(m, LOW, HIGH - 1)) / (HIGH - LOW) * 12}" width="${len - .1}" height=".7"/>`;
  }));
  s.innerHTML = `<g fill="#13202A">${body}</g>`;
  return s;
}

function renderPlaylist() {
  const grid = h("div", { class: "grid", id: "grid",
    style: `width:${BARS * BW}px;height:${TRACKS * TH}px;background-size:${BW}px ${TH}px` });
  // left-drag on empty grid paints the current pattern into every cell it crosses (any rows);
  // right-drag erases every clip it crosses. Changes are previewed live and committed as one undo step on release.
  const cellOf = e => {
    const r = grid.getBoundingClientRect();
    return [clamp(Math.floor((e.clientY - r.top) / TH), 0, TRACKS - 1), clamp(Math.floor((e.clientX - r.left) / BW), 0, BARS - 1)];
  };
  grid.addEventListener("pointerdown", e => {
    if (e.button === 2) {
      grid.setPointerCapture(e.pointerId);
      const gone = new Set();
      const erase = m => {
        const [t, b] = cellOf(m);
        for (const el of grid.querySelectorAll(".clip")) {
          if (el._clip.track === t && el._clip.bar === b && !gone.has(el._clip)) { gone.add(el._clip); el.style.display = "none"; }
        }
      };
      erase(e);
      grid.onpointermove = erase;
      grid.onpointerup = () => {
        grid.onpointermove = grid.onpointerup = null;
        if (gone.size) edit(() => { P.playlist = P.playlist.filter(c => !gone.has(c)); });
      };
      return;
    }
    if (e.button !== 0 || e.target !== grid) return;
    grid.setPointerCapture(e.pointerId);
    const added = [], taken = new Set(P.playlist.filter(c => c.pattern === cur).map(c => `${c.track}:${c.bar}`));
    const paint = m => {
      const [track, bar] = cellOf(m), key = `${track}:${bar}`;
      if (taken.has(key)) return;
      taken.add(key);
      added.push({ pattern: cur, track, bar });
      grid.append(h("div", { class: "clip ghost", style: `left:${bar * BW + 2}px;top:${track * TH + 3}px;width:${BW - 4}px;height:${TH - 6}px;background:${color(cur)}` },
        P.patterns[cur].name));
    };
    paint(e);
    grid.onpointermove = paint;
    grid.onpointerup = () => {
      grid.onpointermove = grid.onpointerup = null;
      if (added.length) edit(() => P.playlist.push(...added));
    };
  });
  for (const c of P.playlist) {
    const el = clipEl(c);
    el._clip = c;  // right-drag erase (on the grid) finds clips through this
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY;
      let bar = c.bar, track = c.track;
      el.onpointermove = m => {
        bar = clamp(c.bar + Math.round((m.clientX - x0) / BW), 0, BARS - 1);
        track = clamp(c.track + Math.round((m.clientY - y0) / TH), 0, TRACKS - 1);
        el.style.left = `${bar * BW + 2}px`; el.style.top = `${track * TH + 3}px`;
        el.classList.add("drag");
      };
      el.onpointerup = () => {
        el.onpointermove = el.onpointerup = null;
        if (bar !== c.bar || track !== c.track) edit(() => { c.bar = bar; c.track = track; });
        else if (c.type === "auto") openAuto(c);
        else if (c.type === "audio") { target = c.channel; render(); }
        else { cur = c.pattern; render(); }
      };
    });
    grid.append(el);
  }
  grid.append(h("div", { class: "playhead", id: "playhead" }));
  // drop a sound from the Sounds browser onto the playlist: it becomes a sample channel + an audio clip there
  grid.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/mlabs-sound")) { e.preventDefault(); grid.classList.add("dropping"); } });
  grid.addEventListener("dragleave", () => grid.classList.remove("dropping"));
  grid.addEventListener("drop", e => {
    const path = e.dataTransfer.getData("text/mlabs-sound");
    grid.classList.remove("dropping");
    if (!path) return;
    e.preventDefault();
    const [track, bar] = cellOf(e);
    addAudioClip(path, base(path).slice(0, 14), track, bar);
  });
  $("#arr").replaceChildren(
    h("div", { class: "corner" }),
    h("div", { class: "ruler", style: `width:${BARS * BW}px` }, ...Array.from({ length: BARS }, (_, b) => h("span", { style: `width:${BW}px` }, b + 1))),
    h("div", { class: "theads" }, ...Array.from({ length: TRACKS }, (_, t) => h("div", { class: "thead", style: `height:${TH}px` }, `Track ${t + 1}`))),
    grid);
}

function renderRack() {
  const pt = P.patterns[cur];
  $("#patName").value = pt.name;
  const rows = [];
  P.channels.forEach((ch, ci) => {
    const groups = [0, 1, 2, 3].map(g => h("div", { class: "grp" }, ...[0, 1, 2, 3].map(k => {
      const s = g * 4 + k;
      return h("button", { class: "step" + (pt.steps[ci][s] ? " on" : ""), "data-s": s, "aria-label": `${ch.name} step ${s + 1}`,
        "aria-pressed": pt.steps[ci][s], onclick: () => edit(() => { pt.steps[ci][s] = !pt.steps[ci][s]; }) });
    })));
    rows.push(h("div", { class: "row" },
      knob({ label: "Pan", min: -1, max: 1, def: 0, small: true, get: () => ch.pan, set: v => { ch.pan = v; }, fmt: panFmt,
        auto: { key: `ch:${ci}:pan`, label: `${ch.name} · pan` } }),
      knob({ label: "Vol", min: 0, max: 1, def: 0.8, small: true, get: () => ch.vol, set: v => { ch.vol = v; }, fmt: v => `${Math.round(v * 100)}`,
        auto: { key: `ch:${ci}:vol`, label: `${ch.name} · volume` } }),
      h("button", { class: "name" + (ci === target ? " target" : ""), title: "Click: piano roll · Right-click: channel options",
        style: `border-left:3px solid ${ch.color || (ch.kind === "synth" || ch.kind === "sample" ? "var(--ice)" : "var(--line)")}`,
        onclick: () => { target = ci; show("rollPanel"); render(); },
        oncontextmenu: e => { e.preventDefault(); channelMenu(ci, e.clientX, e.clientY); } }, ch.name),
      h("div", { class: "steps" }, ...groups),
      h("input", { class: "ins", type: "number", min: 0, max: P.mixer.length - 1, value: ch.insert,
        title: "Mixer track this channel plays through (0 = Master)", "aria-label": `${ch.name} mixer track`,
        onchange: e => edit(() => { ch.insert = clamp(Math.round(+e.target.value) || 0, 0, P.mixer.length - 1); selTrack = ch.insert; }) }),
      h("button", { class: "gear chip", title: "Channel settings", "aria-label": `${ch.name} settings`,
        onclick: () => { openSettings = openSettings === ci ? -1 : ci; renderRack(); } }, icon(SLIDERS))));
    if (openSettings === ci) rows.push(settings(ch, ci));
  });
  $("#rack").replaceChildren(...rows);
}
function settings(ch, ci) {
  const num = (label, key, lo, hi) => h("label", {}, label, h("input", { type: "number", min: lo, max: hi, value: ch[key], style: "width:58px",
    onchange: e => edit(() => { ch[key] = clamp(+e.target.value || 0, lo, hi); }) }));
  const kids = [num("Pitch", "pitch", -24, 24)];
  if (ch.kind === "synth") {
    const k = (label, key, min, max, def, fmt) => knob({ label, min, max, def, get: () => ch[key], set: v => { ch[key] = v; }, fmt });
    const sec = v => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`);
    kids.push(h("label", {}, "Wave", h("select", { onchange: e => edit(() => { ch.wave = e.target.value; }) },
      ...["saw", "square", "sine", "pluck"].map(w => h("option", { value: w, selected: ch.wave === w }, w === "pluck" ? "pluck (guitar)" : w)))),
      h("div", { class: "knobs" },
        k("Octave", "octave", -2, 2, 0, v => `${v > 0 ? "+" : ""}${Math.round(v)}`),
        k("Detune", "detune", 0, 50, 0, v => `${Math.round(v)}¢`),
        k("Attack", "attack", 0.001, 2, 0.005, sec), k("Decay", "decay", 0.01, 2, 0.1, sec),
        k("Sustain", "sustain", 0, 1, 1, v => `${Math.round(v * 100)}%`), k("Release", "release", 0.01, 3, 0.05, sec),
        k("Cutoff", "cutoff", 0, 1, 1, v => `${Math.round(20 * 1000 ** v)}Hz`), k("Env", "env", 0, 1, 0, v => `${Math.round(v * 100)}%`)));
  }
  if (ch.kind === "sample") {
    ch.smp ??= {};
    const o = ch.smp, kv = (label, key, min, max, def, fmt) => knob({ label, min, max, def, get: () => o[key] ?? def, set: v => { o[key] = v; }, fmt });
    const tog = (label, key) => h("label", { class: "tog" }, h("input", { type: "checkbox", checked: !!o[key],
      onchange: e => edit(() => { o[key] = e.target.checked; }) }), label);
    const pct = v => `${Math.round(v * 100)}%`, ms = v => `${Math.round(v * 1000)}ms`;
    kids.push(h("div", { class: "knobs" }, kv("Start", "start", 0, 1, 0, pct), kv("End", "end", 0, 1, 1, pct),
      kv("Fade in", "fade_in", 0, 0.5, 0, ms), kv("Fade out", "fade_out", 0, 1, 0, ms)),
      h("div", { class: "togs" }, tog("Reverse", "reverse"), tog("Normalize", "normalize"), tog("Remove DC offset", "dc"), tog("Cut itself", "cut")),
      h("button", { onclick: async () => { const p = await call("pick_sample"); if (p) edit(() => { ch.sample = p; }); } }, "Load sample…"));
  }
  if (ch.kind === "midiout") {
    const outs = IO.access ? [...IO.access.outputs.values()].map(o => o.name) : [];
    kids.push(h("label", {}, "MIDI port", h("select", { onchange: e => edit(() => { ch.port = e.target.value; }) },
      ...(outs.length ? outs : ["(no MIDI outputs found)"]).map(n => h("option", { value: n, selected: ch.port === n }, n)))),
      num("MIDI ch", "midich", 1, 16));
  }
  kids.push(h("label", {}, "Name", h("input", { value: ch.name, style: "width:110px", onchange: e => edit(() => { ch.name = e.target.value || ch.name; }) })),
    h("button", { onclick: () => edit(() => removeChannel(ci)) }, "Remove channel"));
  return h("div", { class: "settings" }, ...kids);
}

function renderRoll() {
  const ch = P.channels[target];
  $("#rollTitle").textContent = ch ? `Piano roll · ${ch.name}` : "Piano roll";
  const keys = [], rows = [];
  for (let m = HIGH - 1; m >= LOW; m--) {
    const b = [1, 3, 6, 8, 10].includes(m % 12) ? "b" : "w";
    keys.push(h("div", { class: b }, m % 12 === 0 ? `C${m / 12 - 1}` : ""));
    rows.push(h("div", { class: "r " + b }));
  }
  $("#keys").replaceChildren(...keys);
  const notes = $("#notes");
  notes.style.width = `${STEPS * CW}px`;
  notes.replaceChildren(...rows, ...Array.from({ length: STEPS + 1 }, (_, s) =>
    h("div", { class: "vl" + (s % 4 ? "" : " beat"), style: `left:${s * CW}px` })));
  const roll = $(".roll");
  if (!roll.dataset.scrolled && roll.clientHeight) {  // first time it's visible: centre on the notes (or around C4-C5)
    const ms = ch ? P.patterns[cur].notes[target].map(n => n[2]) : [];
    const mid = ms.length ? (Math.min(...ms) + Math.max(...ms)) / 2 : 66;
    roll.scrollTop = (HIGH - 1 - mid) * RH - roll.clientHeight / 2;
    roll.dataset.scrolled = "1";
  }
  if (!ch) return;
  const list = P.patterns[cur].notes[target];
  list.forEach(n => {
    const [st, len, m, vel] = n;
    const el = h("div", { class: "note", title: `velocity ${Math.round(vel * 100)}%`,
      style: `left:${st * CW + 1}px;top:${(HIGH - 1 - m) * RH}px;width:${len * CW - 2}px;opacity:${.35 + .65 * vel}` });
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;  // right button falls through to the grid's drag-to-erase
      e.stopPropagation(); edit(() => list.splice(list.indexOf(n), 1));
    });
    el.addEventListener("wheel", e => {
      e.preventDefault();
      n[3] = Math.round(clamp(n[3] + (e.deltaY < 0 ? .1 : -.1), .1, 1) * 10) / 10;
      toast(`Velocity ${Math.round(n[3] * 100)}%`);
      renderRoll(); replay();
    });
    notes.append(el);
  });
}
function rollCell(e) {
  const r = $("#notes").getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) / CW), HIGH - 1 - Math.floor((e.clientY - r.top) / RH)];
}

// ---------- knob: drag up/down, wheel, double-click = default, arrow keys ----------
const RING = 2 * Math.PI * 13;
function knob({ label, min, max, get, set, def = min, fmt = v => v.toFixed(2), small = false, auto = null }) {
  const range = max - min, step = range / 100;
  const el = h("div", { class: "knob" + (small ? " small" : ""), role: "slider", tabindex: 0, "aria-label": label,
    "aria-valuemin": min, "aria-valuemax": max, title: `${label} · drag, wheel or arrows · double-click resets` });
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 34 34");
  svg.innerHTML = `<g transform="rotate(135 17 17)" fill="none" stroke-width="3" stroke-linecap="round">
    <circle cx="17" cy="17" r="13" stroke="rgba(232,243,248,.14)" stroke-dasharray="${.75 * RING} ${RING}"/>
    <circle class="arc" cx="17" cy="17" r="13" stroke="var(--ice)"/></g><circle class="cap" cx="17" cy="17" r="8"/>`;
  const val = h("span", { class: "kv" }), arc = svg.querySelector(".arc");
  const draw = () => {
    const v = get();
    arc.setAttribute("stroke-dasharray", `${.75 * RING * (v - min) / range} ${RING}`);
    el.setAttribute("aria-valuenow", v);
    val.textContent = fmt(v);
  };
  const put = v => { set(min + Math.round((clamp(v, min, max) - min) / step) * step); draw(); };  // steps count from min
  el.addEventListener("pointerdown", e => {
    e.stopPropagation(); snap();
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = get();
    el.onpointermove = m => put(v0 + (y0 - m.clientY) / 160 * range);
    el.onpointerup = () => { el.onpointermove = el.onpointerup = null; replay(); };
  });
  el.addEventListener("wheel", e => { e.preventDefault(); put(get() + (e.deltaY < 0 ? step : -step) * 2); replay(); });
  el.addEventListener("dblclick", e => { e.stopPropagation(); snap(); put(def); replay(); });
  el.addEventListener("contextmenu", e => {
    e.preventDefault(); e.stopPropagation();
    showContext(e.clientX, e.clientY, [{ head: auto ? auto.label : label },
      ...(auto ? [["Create automation clip", "", () => createAuto(auto.key, auto.label)]] : []),
      ["Reset to default", "", () => { snap(); put(def); replay(); }]]);
  });
  el.addEventListener("keydown", e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); snap(); put(get() + d * step * 2); replay(); }
  });
  el.append(svg, val, h("span", { class: "kl" }, label));
  draw();
  return el;
}
const db = v => (v <= 0.0001 ? "-inf" : (20 * Math.log10(v)).toFixed(1));
const panFmt = v => (Math.abs(v) < .01 ? "C" : `${Math.round(Math.abs(v) * 100)}${v < 0 ? "L" : "R"}`);

// ---------- mixer: insert strips + FX panel for the selected track ----------
function renderMixer() {
  if (FXW && !$("#fxWin").hidden) renderFxWin();
  const strips = P.mixer.map((tr, t) => {
    const fader = h("input", { type: "range", class: "fader", min: 0, max: 125, value: Math.round(tr.vol * 100),
      oncontextmenu: e => { e.preventDefault(); e.stopPropagation(); showContext(e.clientX, e.clientY, [{ head: `${tr.name} · volume` },
        ["Create automation clip", "", () => createAuto(`mx:${t}:vol`, `${tr.name} · volume`)]]); },
      "aria-label": `${tr.name} volume`,
      onpointerdown: snap, oninput: e => { tr.vol = +e.target.value / 100; dbEl.textContent = db(tr.vol); }, onchange: replay });
    const dbEl = h("div", { class: "mdb" }, db(tr.vol));
    const route = t === 0 ? h("div", { class: "mroute" }, "OUT")
      : h("select", { class: "mroute", "aria-label": `${tr.name} output`, title: "Send this track to",
          onchange: e => edit(() => { tr.route = +e.target.value; }) },
          ...P.mixer.map((o, i) => i === t ? null : h("option", { value: i, selected: (tr.route ?? 0) === i }, i === 0 ? "→ Master" : `→ ${i}`)));
    return h("div", { class: "mstrip" + (t === selTrack ? " sel" : "") + (t === 0 ? " master" : ""),
      onclick: () => { if (selTrack !== t) { selTrack = t; selSlot = tr.fx.findIndex(s => s); selSlot = Math.max(selSlot, 0); renderMixer(); if (tab === "fx") renderBrowser(); } } },
      h("div", { class: "mnum" }, t === 0 ? "M" : t),
      h("div", { class: "mname", title: tr.name }, tr.name),
      h("div", { class: "mslots", title: "Effect slots in use" }, ...tr.fx.map(s => h("i", { class: s ? (s.on ? "on" : "off") : "" }))),
      knob({ label: "Pan", min: -1, max: 1, def: 0, small: true, get: () => tr.pan, set: v => { tr.pan = v; }, fmt: panFmt,
        auto: { key: `mx:${t}:pan`, label: `${tr.name} · pan` } }),
      h("div", { class: "mfader" }, h("div", { class: "meter" }, h("i", { "data-meter": t })), fader),
      dbEl,
      h("div", { class: "mbtns" },
        h("button", { class: "led" + (tr.mute ? "" : " on"), title: tr.mute ? "Unmute" : "Mute", "aria-pressed": !tr.mute,
          onclick: e => { e.stopPropagation(); edit(() => { tr.mute = !tr.mute; }); } }),
        t === 0 ? null : h("button", { class: "solo" + (tr.solo ? " on" : ""), title: "Solo", "aria-pressed": !!tr.solo,
          onclick: e => { e.stopPropagation(); edit(() => { tr.solo = !tr.solo; }); } }, "S")),
      route);
  });
  $("#mixer").replaceChildren(h("div", { class: "mstrips" }, ...strips), fxPanel());
}

function fxPanel() {
  const tr = P.mixer[selTrack];
  const inputs = P.channels.filter(c => c.insert === selTrack).map(c => c.name);
  const feeds = P.mixer.map((o, i) => (i && i !== selTrack && (o.route ?? 0) === selTrack ? o.name : null)).filter(Boolean);
  // effects run top to bottom, so order matters: drag a slot onto another to move it (or focus the grip and use ↑/↓)
  const move = (from, to) => {
    if (to < 0 || to >= tr.fx.length || from === to) return;
    edit(() => { const [m] = tr.fx.splice(from, 1); tr.fx.splice(to, 0, m); selSlot = to; });
    requestAnimationFrame(() => document.querySelectorAll(".slot .grip")[to]?.focus());
  };
  const slots = tr.fx.map((s, i) => h("div", { class: "slot" + (i === selSlot ? " sel" : ""), draggable: !!s,
      onclick: () => { selSlot = i; renderMixer(); },
      ondblclick: () => { if (s && s.type !== "VST3") openFxWin(selTrack, i); },
      ondragstart: e => { e.dataTransfer.setData("text/plain", String(i)); e.currentTarget.classList.add("dragging"); },
      ondragend: e => e.currentTarget.classList.remove("dragging"),
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add("drop"); },
      ondragleave: e => e.currentTarget.classList.remove("drop"),
      ondrop: e => { e.preventDefault(); move(+e.dataTransfer.getData("text/plain"), i); } },
    h("button", { class: "grip", disabled: !s, title: "Drag to reorder (or ↑/↓)", "aria-label": `Move slot ${i + 1}`,
      onclick: e => e.stopPropagation(),
      onkeydown: e => { const d = { ArrowUp: -1, ArrowDown: 1 }[e.key]; if (d) { e.preventDefault(); move(i, i + d); } } }, "⋮⋮"),
    h("button", { class: "led" + (s && s.on ? " on" : ""), disabled: !s, "aria-label": `Slot ${i + 1} on/off`,
      onclick: e => { e.stopPropagation(); edit(() => { s.on = !s.on; }); } }),
    h("select", { "aria-label": `Slot ${i + 1} effect`, onclick: e => e.stopPropagation(),
      onchange: e => edit(() => { tr.fx[i] = e.target.value ? newSlot(e.target.value) : null; selSlot = i; }) },
      h("option", { value: "" }, `Slot ${i + 1}`), ...Object.keys(EFX).map(n => h("option", { value: n, selected: s?.type === n }, n)),
      s?.type === "VST3" ? h("option", { value: "VST3", selected: true }, `VST3 · ${s.name || base(s.path)}`) : null),
    s ? h("button", { class: "del", title: "Remove effect", "aria-label": `Remove ${s.type} from slot ${i + 1}`,
      onclick: e => { e.stopPropagation(); edit(() => { tr.fx[i] = null; }); } }, "×") : h("span", { class: "del-gap" })));
  const s = tr.fx[selSlot];
  const params = s?.type === "VST3" ? [h("span", { class: "fxin" }, `${s.name || base(s.path)} (VST3). Its own window isn't shown; it runs with its default settings.`)]
    : s ? Object.entries(EFX[s.type]).map(([k, [min, max, def, label]]) =>
    knob({ label, min, max, def, get: () => s.params[k] ?? def, set: v => { s.params[k] = v; },
      fmt: v => (Math.abs(max - min) > 4 ? v.toFixed(1) : v.toFixed(2)) })) : [h("span", { class: "label" }, "Pick an effect in a slot")];
  const eq = ["low", "mid", "high"].map(b => knob({ label: b[0].toUpperCase() + b.slice(1), min: -12, max: 12, def: 0,
    get: () => tr.eq[b], set: v => { tr.eq[b] = v; }, fmt: v => `${v > 0 ? "+" : ""}${v.toFixed(1)}` }));
  return h("div", { class: "fxpanel" },
    h("div", { class: "fxhead" }, h("span", { class: "label" }, selTrack === 0 ? "Master" : `Insert ${selTrack}`),
      h("input", { value: tr.name, "aria-label": "Track name", onchange: e => edit(() => { tr.name = e.target.value || tr.name; }) })),
    h("div", { class: "fxin" }, inputs.length || feeds.length ? `In: ${[...inputs, ...feeds].join(", ")}` : "No inputs routed here"),
    h("div", { class: "slots" }, ...slots),
    h("div", { class: "params" }, h("div", { class: "label" }, s ? s.type : "Effect",
      s && s.type !== "VST3" ? h("button", { class: "openwin", title: "Open the plugin window (or double-click the slot)",
        onclick: () => openFxWin(selTrack, selSlot) }, "Open ⤢") : null), h("div", { class: "knobs" }, ...params)),
    h("div", { class: "params" }, h("div", { class: "label" }, "Equalizer (dB)"), h("div", { class: "knobs" }, ...eq)));
}

function pollMeters() {
  clearInterval(meterTimer);
  meterTimer = setInterval(async () => {
    if (!playing) return;
    let lv;
    try { lv = await window.pywebview.api.levels(); } catch { return; }
    document.querySelectorAll("[data-meter]").forEach(el => {
      const v = Math.min(1, lv[+el.dataset.meter] || 0), shown = Math.max(v, (+el.dataset.v || 0) * 0.82);
      el.dataset.v = shown;
      el.style.height = `${shown * 100}%`;
    });
  }, 60);
}

// ---------- panels ----------
function show(id) {
  const el = $("#" + id), opening = el.hidden;
  el.hidden = false;
  if (opening && el.classList.contains("io")) {  // dialogs (Export, Audio & MIDI) open in the centre of the window
    el.style.left = `${Math.max(0, (innerWidth - el.offsetWidth) / 2)}px`;
    el.style.top = `${Math.max(0, (innerHeight - el.offsetHeight) / 2)}px`;
  }
  renderTop();
}
function toggle(id) { $("#" + id).hidden = !$("#" + id).hidden; renderTop(); }
document.querySelectorAll(".panel header").forEach(hd => hd.addEventListener("pointerdown", e => {
  if (e.target.closest("input,button")) return;
  const panel = hd.parentElement, x0 = e.clientX - panel.offsetLeft, y0 = e.clientY - panel.offsetTop;
  hd.setPointerCapture(e.pointerId);
  hd.onpointermove = m => {
    panel.style.left = `${clamp(m.clientX - x0, 0, innerWidth - 120)}px`;
    panel.style.top = `${clamp(m.clientY - y0, 0, innerHeight - 60)}px`;
  };
  hd.onpointerup = () => { hd.onpointermove = hd.onpointerup = null; };
}));
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => toggle(b.dataset.close)));

// ---------- transport ----------
async function play() {
  const r = await call("play", P, song, cur, metro);
  if (!r) return;  // superseded by a newer edit, or stopped meanwhile
  if (r.missing.length) toast(`Can't play ${r.missing.length} sample(s), so they're silent: ${r.missing.map(base).join(", ")}`);
  loop = r.loop;
  t0 = performance.now() - r.pos * 1000;  // sync the playhead to the stream's real position
  if (playing) return;
  playing = true; lastStep = -1;
  $("#play").classList.add("on");
  tick();
  pollMeters();
}
async function stop() {
  playing = false;
  clearTimeout(replayTimer);
  cancelAnimationFrame(raf);
  await call("stop");
  $("#play").classList.remove("on");
  $("#time").textContent = "1:01:00";
  $("#playhead").style.display = "none";
  document.querySelectorAll(".step.now").forEach(s => s.classList.remove("now"));
  clearInterval(meterTimer);
  document.querySelectorAll("[data-meter]").forEach(el => { el.dataset.v = 0; el.style.height = "0%"; });
}
function tick() {
  const stepSec = 60 / P.bpm / 4, t = ((performance.now() - t0) / 1000) % loop, step = Math.floor(t / stepSec);
  if (step !== lastStep && IO.access) midiOutStep(step, stepSec);
  if (step !== lastStep) {
    lastStep = step;
    $("#time").textContent = `${Math.floor(step / 16) + 1}:${String(Math.floor(step % 16 / 4) + 1).padStart(2, "0")}:${String(step % 4).padStart(2, "0")}`;
    document.querySelectorAll(".step.now").forEach(s => s.classList.remove("now"));
    if (!song) document.querySelectorAll(`.step[data-s="${step % 16}"]`).forEach(s => s.classList.add("now"));
  }
  const ph = $("#playhead");
  ph.style.display = song ? "block" : "none";
  if (song) {
    const x = t / (stepSec * 16) * BW;
    ph.style.left = `${x}px`;
    const sc = $("#plScroll");
    if (OPT.autoscroll && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 140)) sc.scrollLeft = Math.max(0, x - 140);
  }
  raf = requestAnimationFrame(tick);
}

async function detect() {
  if (!P.channels[target]) return toast("Add a synth or sample channel first");
  const notes = await call("detect", P.bpm);
  if (!notes) return;
  if (!notes.length) return toast("No clear pitch found. Try a cleaner, single-note recording.");
  edit(() => {
    for (const [st, len, m, vel] of notes) {
      const pi = cur + Math.floor(st / STEPS);  // patterns are one bar; longer phrases spill into new ones
      while (pi >= P.patterns.length) P.patterns.push(emptyPattern(`Pattern ${P.patterns.length + 1}`));
      P.patterns[pi].notes[target].push([st % STEPS, Math.min(len, STEPS - st % STEPS), m, vel]);
    }
  });
  show("rollPanel");
  toast(`Detected ${notes.length} notes for ${P.channels[target].name}`);
}

// ---------- wiring ----------
$("#play").onclick = () => (playing ? stop() : play());
$("#stop").onclick = stop;
$("#modePat").onclick = () => { song = false; renderTop(); replay(); };
$("#modeSong").onclick = () => { song = true; renderTop(); replay(); };
$("#metro").onclick = () => { metro = !metro; renderTop(); replay(); };
$("#bpm").onchange = e => edit(() => { P.bpm = clamp(Math.round(+e.target.value) || 120, 40, 240); });
$("#swing").oninput = e => { P.swing = +e.target.value / 100; };
$("#swing").onchange = replay;
$("#patSel").onchange = e => { cur = +e.target.value; render(); replay(); };
$("#patName").oninput = e => { P.patterns[cur].name = e.target.value; renderTop(); renderPlaylist(); };
const newPattern = () => edit(() => { P.patterns.push(emptyPattern(`Pattern ${P.patterns.length + 1}`)); cur = P.patterns.length - 1; });
$("#newPat").onclick = newPattern;
document.querySelectorAll(".tabs button[data-tab]").forEach(b => b.onclick = () => openTab(b.dataset.tab));
function openTab(t) { tab = t; renderBrowser(); }
function openAI(role) { AI.role = role; openTab("ai"); }

// ---------- file actions (used by the File menu and shortcuts) ----------
async function newProject() {
  if (hist.length && !confirm("Start a new project? Unsaved changes will be lost.")) return;
  const p = await call("new_project");
  if (p) { if (playing) await stop(); P = normalize(p); hist = []; cur = 0; target = 4; render(); }
}
async function openProject() {
  const p = await call("open");
  if (p) { P = normalize(p); hist = []; cur = 0; target = 0; render(); toast("Project opened"); }
}
async function saveProject() { const p = await call("save", P); if (p) toast(`Saved ${p}`); }
function addEffect(name) {  // into the first free slot of the selected mixer track
  const tr = P.mixer[selTrack], i = tr.fx.findIndex(s => !s);
  if (i < 0) return toast("All 10 slots on this track are full");
  edit(() => { tr.fx[i] = newSlot(name); selSlot = i; });
  $("#mixer").hidden = false; renderTop();
  openFxWin(selTrack, i);
  toast(`${name} added to ${tr.name}`);
}

// everything you can add, by category: feeds the ADD menu and the F8 plugin picker
function catalog() {
  return [
    ["Drum", KINDS.map(([k, n, sub]) => ({ name: n, sub, run: () => addSound(k, n) }))],
    ["Synth", [{ name: "Synth", sub: "Plain 3-osc", run: () => addSound("synth", "Synth") },
      ...PRESETS.filter(pr => presetCat(pr) !== "Keys").map(pr => ({ name: pr, sub: PRESET_DESC[pr] || "Synth preset", run: () => addSound("synth", pr, null, pr) }))]],
    ["Keys", PRESETS.filter(pr => presetCat(pr) === "Keys").map(pr => ({ name: pr, sub: PRESET_DESC[pr], run: () => addSound("synth", pr, null, pr) }))],
    ["Sampler", [{ name: "Sound from the library…", sub: "Your sound libraries", run: () => openTab("samp") },
      { name: "Import WAV…", sub: "Any WAV from your PC", run: importWav },
      ...SAMPLERS.map(([n, sub, smp]) => ({ name: `${n}…`, sub, run: () => addSampler(n, smp) })),
      { name: "Record a take", sub: "Mic or instrument", run: toggleRecord }]],
    ["AI", [{ name: "AI Composer clip", sub: "Describe it, get a clip", run: () => openAI("composer") },
      { name: "Hum to instrument", sub: "Perfect pitch", run: () => openTab("pitch") }]],
    ["Effect", Object.keys(EFX).map(n => ({ name: n, sub: FXDESC[n] || "", run: () => addEffect(n) }))],
  ];
}

async function importWav() { const path = await call("pick_sample"); if (path) addSound("sample", base(path).slice(0, 14), path); }

// ---------- menu bar: FILE EDIT ADD PATTERNS VIEW OPTIONS TOOLS HELP ----------
// an item is [label, shortcut, action, checked?]; "-" is a separator; checked undefined = no checkmark column
const MENUS = [
  ["FILE", () => [["New project", "", newProject], ["Open…", "Ctrl+O", openProject], ["Save…", "Ctrl+S", saveProject], "-",
    ["Export audio…", "Ctrl+E", openExport], ["Export MIDI…", "", exportMidi]]],
  ["EDIT", () => [["Undo", "Ctrl+Z", undo]]],
  ["ADD", () => {
    const cat = Object.fromEntries(catalog()), rows = list => list.map(it => [it.name, "", it.run]);
    return [{ head: "Drum" }, ...rows(cat.Drum), "|", { head: "Sampler" }, ...rows(cat.Sampler), { head: "Keys" }, ...rows(cat.Keys), "|",
      { head: "Synth" }, ...rows(cat.Synth), { head: "AI" }, ...rows(cat.AI), "|",
      { head: "Other" }, ["Effect", "", null, undefined, () => [...rows(cat.Effect), "-", ["VST3 effect…", "", () => addVst("effect")]]],
      ["Plugin picker", "F8", openPicker], { head: "External" }, ["MIDI Out channel", "", addMidiOut], ["VST3 instrument…", "", () => addVst("instrument")],
      ["Browse sounds", "", () => openTab("samp")], "-", ["Pattern", "", newPattern]];
  }],
  ["PATTERNS", () => [
    { head: "Patterns" }, ...P.patterns.map((pt, i) => [pt.name, "", () => { cur = i; render(); replay(); }, i === cur]), "|",
    { head: P.patterns[cur].name }, ["Find next empty", "F4", newPattern], "-",
    ["Rename…", "F2", renamePattern], ["Change color", "", () => recolorPattern(false)], ["Random color", "", () => recolorPattern(true)],
    ["Transpose…", "", transposePattern], "-",
    ["Clone", "Shift+Ctrl+C", clonePattern], ["Delete", "Shift+Ctrl+Del", deletePattern], "-",
    ["Move up", "Shift+Ctrl+Up", () => movePattern(-1)], ["Move down", "Shift+Ctrl+Down", () => movePattern(1)], "-",
    ["Split by channel", "", splitPattern], ["Render as audio clip", "", renderPatternClip]]],
  ["VIEW", () => [{ head: "Windows" }, ["Playlist", "F5", () => toggleArea("no-playlist"), !document.body.classList.contains("no-playlist")],
    ["Piano roll", "F7", () => toggle("rollPanel"), !$("#rollPanel").hidden], ["Step Rack", "F6", () => toggle("rackPanel"), !$("#rackPanel").hidden],
    ["Mixer", "F9", () => toggle("mixer"), !$("#mixer").hidden], ["Browser", "Alt+F8", () => toggleArea("no-browser"), !document.body.classList.contains("no-browser")],
    ["Plugin picker", "F8", openPicker], ["Tempo tapper", "", openTapper], "-",
    ["Close all windows", "F12", closeAllWindows], { head: "Look" },
    ["Theme: Misty", "", () => setTheme("misty"), THEME !== "dark"], ["Theme: Dark", "", () => setTheme("dark"), THEME === "dark"], "-",
    ["Wallpaper…", "", pickWallpaper], document.body.classList.contains("has-wall") ? ["Remove wallpaper", "", clearWallpaper] : null]],
  ["OPTIONS", () => [{ head: "System" }, ["Audio & MIDI settings…", "F10", openIO], ["Export settings…", "Ctrl+E", openExport],
    { head: "Project" }, ["Project info…", "F11", openInfo],
    { head: "Switches" }, ["Typing keyboard to piano", "Ctrl+T", () => { OPT.typing = !OPT.typing; toast(`Typing keyboard to piano ${OPT.typing ? "on" : "off"}`); }, OPT.typing],
    ["Metronome", "Ctrl+M", () => $("#metro").click(), metro],
    ["Recording precount", "Ctrl+P", () => { OPT.precount = !OPT.precount; }, OPT.precount],
    ["Auto scrolling", "", () => { OPT.autoscroll = !OPT.autoscroll; }, OPT.autoscroll],
    ["Show tips bar", "", () => setTips(!TIPS.on), TIPS.on]]],
  ["TOOLS", () => [
    { head: "Tools" }, ["Browser find…", "Ctrl+F", browserFind],
    ["One-click audio recording", "", null, undefined, () => [["Into a new channel", "", toggleRecord], ["Into notes (hum → piano roll)", "", () => openTab("pitch")]]],
    ["Macros", "", null, undefined, () => [{ head: "Panic" }, ["Stop sound", "Ctrl+H", panic], ["Cancel recording", "", cancelRecording],
      { head: "Misc" }, ["Prepare for performance mode", "", performanceMode], ["Prepare for MIDI export", "", exportMidi],
      ["Remove unused channels", "", () => removeUnused(false)], ["Purge unused audio clips", "", () => removeUnused(true)]]],
    ["Riff generator", "", riffMachine],
    ["Play history", "", null, undefined, () => [["Turn what I played into notes", "", dumpScore], ["Clear log", "", () => { SCORE.length = 0; toast("Play history cleared"); }]]],
    { head: "Monitor" }, ["Plugin performance monitor", "", openPerf], ["Audio & MIDI…", "F10", openIO], ["Detect notes from WAV…", "", detect],
    "|",
    { head: "AI" }, ["AI Composer", "", () => openAI("composer")], ["AI Mix engineer", "", () => openAI("mix")],
    ["AI Mastering engineer", "", () => openAI("master")], ["Perfect pitch (hum to instrument)", "", () => openTab("pitch")],
    { head: "Cloud" }, ["Sounds", "", () => openTab("samp")], ["Mastering", "", () => openAI("master")],
    { head: "Toolbar" }, ["Customize quick buttons…", "", openQuickCustom]]],
  ["HELP", () => [["Show a tip", "", () => showTip(1)], ["Keyboard shortcuts", "", () => toast(SHORTCUTS)], ["About MLabs", "", () => toast(ABOUT)]]],
];
const SHORTCUTS = "Space play/stop · Ctrl+Z undo · Ctrl+S save · Ctrl+O open · Ctrl+E export · Ctrl+T typing keyboard · Ctrl+M metronome · F2 rename pattern · F4 new pattern · F5 playlist · F6 rack · F7 piano roll · F8 plugin picker · F9 mixer · F10 audio & MIDI · F11 project info · F12 close windows";
const ABOUT = "MLabs · your next masterpiece · fonts Montserrat + Inter (SIL OFL) · free drums from VCSL (CC0)";
let openMenu = -1;
const menuBox = h("div", { class: "menu glass", role: "menu", hidden: true });
document.body.append(menuBox);
const tops = MENUS.map(([label], i) => h("button", { class: "mtop", role: "menuitem", "aria-haspopup": "true", "aria-expanded": "false",
  onclick: () => (openMenu === i ? closeMenu() : showMenu(i)),
  onmouseenter: () => { if (openMenu >= 0 && openMenu !== i) showMenu(i); } }, label));
$("#menubar").replaceChildren(...tops);
function showMenu(i) {
  openMenu = i;
  tops.forEach((b, j) => b.setAttribute("aria-expanded", String(j === i)));
  const items = MENUS[i][1]().filter(Boolean);
  const cols = [[]];
  items.forEach(it => (it === "|" ? cols.push([]) : cols[cols.length - 1].push(it)));
  menuBox.classList.toggle("multi", cols.length > 1);
  menuBox.replaceChildren(...cols.map(col => h("div", { class: "mcol" }, ...menuRows(col))));
  closeSub();
  const r = tops[i].getBoundingClientRect();
  menuBox.style.left = `${r.left}px`;
  menuBox.style.top = `${r.bottom + 6}px`;
  menuBox.hidden = false;
  menuBox.querySelector(".mitem")?.focus();
}
function menuRows(items, inSub = false) {
  const checks = items.some(it => Array.isArray(it) && it[3] !== undefined);
  return items.map(it => {
    if (it === "-") return h("div", { class: "msep", role: "separator" });
    if (it.head) return h("div", { class: "mhead", role: "presentation" }, it.head);
    const sub = it[4];
    const el = h("button", { class: "mitem" + (sub ? " hassub" : ""), role: it[3] === undefined ? "menuitem" : "menuitemcheckbox",
        "aria-checked": it[3] === undefined ? null : String(!!it[3]), "aria-haspopup": sub ? "menu" : null,
        onclick: () => { if (sub) return openSub(el, sub()); closeMenu(); it[2](); },
        onmouseenter: () => { if (sub) openSub(el, sub()); else if (!inSub) closeSub(); } },
      checks ? h("span", { class: "mcheck", "aria-hidden": "true" }, it[3] ? "✓" : "") : null,
      h("span", { class: "mlabel" }, it[0]), h("span", { class: "mkey" }, sub ? "›" : it[1]));
    return el;
  });
}
const subBox = h("div", { class: "menu glass", role: "menu", hidden: true });
document.body.append(subBox);
function openSub(anchor, items) {
  subBox.replaceChildren(...menuRows(items, true));
  subBox.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = r.right + 4 + subBox.offsetWidth > innerWidth ? r.left - subBox.offsetWidth - 4 : r.right + 4;
  subBox.style.left = `${left}px`;
  subBox.style.top = `${Math.min(r.top - 6, innerHeight - subBox.offsetHeight - 8)}px`;
  subBox.querySelector(".mitem")?.focus();
  subBox.onkeydown = e => {
    const its = [...subBox.querySelectorAll(".mitem")], at = its.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); its[(at + (e.key === "ArrowDown" ? 1 : its.length - 1)) % its.length].focus(); }
    else if (e.key === "ArrowLeft" || e.key === "Escape") { e.preventDefault(); closeSub(); anchor.focus(); }
  };
}
function closeSub() { subBox.hidden = true; }
function showContext(x, y, items) {  // right-click menus reuse the menu bar's renderer
  closeMenu();
  openMenu = -2;
  const cols = [[]];
  items.forEach(it => (it === "|" ? cols.push([]) : cols[cols.length - 1].push(it)));
  menuBox.classList.toggle("multi", cols.length > 1);
  menuBox.replaceChildren(...cols.map(col => h("div", { class: "mcol" }, ...menuRows(col))));
  menuBox.hidden = false;
  menuBox.style.left = `${Math.min(x, innerWidth - menuBox.offsetWidth - 8)}px`;
  menuBox.style.top = `${Math.min(y, innerHeight - menuBox.offsetHeight - 8)}px`;
  menuBox.querySelector(".mitem")?.focus();
}
function closeMenu() {
  closeSub();
  if (openMenu >= 0 && tops[openMenu]) tops[openMenu].setAttribute("aria-expanded", "false");
  openMenu = -1;
  menuBox.hidden = true;
}
document.addEventListener("pointerdown", e => { if (openMenu !== -1 && !e.target.closest(".menu, .mtop")) closeMenu(); });
menuBox.addEventListener("keydown", e => {
  const its = [...menuBox.querySelectorAll(".mitem")], at = its.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); its[(at + (e.key === "ArrowDown" ? 1 : its.length - 1)) % its.length].focus(); }
  else if (e.key === "ArrowRight" && document.activeElement?.classList.contains("hassub")) { e.preventDefault(); document.activeElement.click(); }
  else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && openMenu >= 0) { e.preventDefault(); showMenu((openMenu + (e.key === "ArrowRight" ? 1 : MENUS.length - 1)) % MENUS.length); }
  else if (e.key === "Escape") { const t = tops[openMenu]; closeMenu(); t?.focus(); }
});

// ---------- Patterns menu: rename/color, clone, delete, move, transpose, split, render ----------
function remapClips(map) {  // map(old pattern index) -> new index, or -1 to drop the clip (pattern clips only)
  P.playlist = P.playlist.map(c => (c.type ? c : { ...c, pattern: map(c.pattern) })).filter(c => c.type || c.pattern >= 0);
}
function remapChannels(map) {  // channels moved: keep audio clips and channel automation pointing at the right one
  P.playlist = P.playlist.map(c => {
    if (c.type === "audio") return { ...c, channel: map(c.channel) };
    if (c.type === "auto" && c.key.startsWith("ch:")) { const [, i, prm] = c.key.split(":"); const j = map(+i); return { ...c, key: `ch:${j}:${prm}`, dead: j < 0 }; }
    return c;
  }).filter(c => !(c.type === "audio" && c.channel < 0) && !c.dead);
}
function renamePattern() {
  const name = prompt("Pattern name", P.patterns[cur].name);
  if (name && name.trim()) edit(() => { P.patterns[cur].name = name.trim(); });
}
function recolorPattern(random) {
  const now = color(cur), i = COLORS.indexOf(now);
  edit(() => { P.patterns[cur].color = random ? `hsl(${Math.floor(Math.random() * 360)} 45% 72%)` : COLORS[(i + 1) % COLORS.length]; });
}
function transposePattern() {
  const n = parseInt(prompt("Transpose every note in this pattern by how many semitones? (-24 to 24)", "12"), 10);
  if (!n || Math.abs(n) > 24) return;
  edit(() => P.patterns[cur].notes.forEach(list => list.forEach(note => { note[2] = clamp(note[2] + n, LOW, HIGH - 1); })));
  toast(`Transposed ${P.patterns[cur].name} by ${n > 0 ? "+" : ""}${n}`);
}
function clonePattern() {
  edit(() => {
    const copy = JSON.parse(JSON.stringify(P.patterns[cur]));
    copy.name = `${copy.name} #2`;
    P.patterns.splice(cur + 1, 0, copy);
    remapClips(p => (p > cur ? p + 1 : p));
    cur += 1;
  });
}
function deletePattern() {
  if (P.patterns.length === 1) return toast("A project needs at least one pattern");
  const gone = cur, used = P.playlist.filter(c => c.pattern === gone).length;
  if (used && !confirm(`Delete "${P.patterns[gone].name}" and its ${used} clip(s) in the playlist?`)) return;
  edit(() => {
    P.patterns.splice(gone, 1);
    remapClips(p => (p === gone ? -1 : p > gone ? p - 1 : p));
    cur = Math.min(gone, P.patterns.length - 1);
  });
}
function movePattern(d) {
  const j = cur + d;
  if (j < 0 || j >= P.patterns.length) return;
  edit(() => {
    [P.patterns[cur], P.patterns[j]] = [P.patterns[j], P.patterns[cur]];
    remapClips(p => (p === cur ? j : p === j ? cur : p));
    cur = j;
  });
}
function splitPattern() {  // one new pattern per channel that has something in this one
  const src = P.patterns[cur], made = [];
  edit(() => P.channels.forEach((ch, ci) => {
    if (!src.steps[ci].some(Boolean) && !src.notes[ci].length) return;
    const pt = emptyPattern(`${src.name} · ${ch.name}`);
    pt.steps[ci] = [...src.steps[ci]];
    pt.notes[ci] = src.notes[ci].map(n => [...n]);
    P.patterns.push(pt); made.push(pt.name);
  }));
  toast(made.length ? `Split into ${made.length} patterns` : "This pattern is empty");
}
async function renderPatternClip() {
  toast(`Rendering ${P.patterns[cur].name}…`);
  const path = await call("render_pattern", P, cur, P.patterns[cur].name);
  if (path) addAudioClip(path, `${P.patterns[cur].name} (audio)`.slice(0, 18), freeTrack(0), 0);
}

// ---------- View: window toggles, close all, tempo tapper ----------
function toggleArea(cls) { document.body.classList.toggle(cls); }
function closeAllWindows() {
  ["rackPanel", "rollPanel", "ioPanel", "exportPanel", "pickerPanel", "tapPanel", "infoPanel", "perfPanel", "quickPanel", "autoPanel", "fxWin"].forEach(id => { $("#" + id).hidden = true; });
  $("#mixer").hidden = true; renderTop();
}
const TAP = { times: [] };
function openTapper() { TAP.times = []; $("#tapBpm").textContent = "–"; show("tapPanel"); $("#tapBtn").focus(); }
function tap() {
  const now = performance.now();
  TAP.times = TAP.times.filter(t => now - t < 2500).concat(now).slice(-8);  // a pause over 2.5 s starts a new count
  if (TAP.times.length < 2) { $("#tapBpm").textContent = "…"; return; }
  const gaps = TAP.times.slice(1).map((t, i) => t - TAP.times[i]);
  TAP.bpm = Math.round(60000 / (gaps.reduce((a, b) => a + b) / gaps.length));
  $("#tapBpm").textContent = TAP.bpm;
}

// ---------- Options → Project info (F11) ----------
function openInfo() {
  P.info ??= { title: "", author: "", genre: "", comments: "" };
  for (const k of ["title", "author", "genre", "comments"]) $("#info_" + k).value = P.info[k] || "";
  show("infoPanel");
}

// ---------- Tools: find, panic, cancel recording, performance mode, cleanup, riff generator, play history ----------
const SCORE = [];  // every live note: {note, vel, t, end}
function browserFind() { openTab("samp"); setTimeout(() => document.querySelector('.browser input[type=search]')?.focus(), 50); }
async function panic() {
  playing = false; clearTimeout(replayTimer); cancelAnimationFrame(raf);
  await call("panic");
  IO.midiOn.clear(); midiAllOff();
  $("#play").classList.remove("on"); $("#time").textContent = "1:01:00";
  toast("Sound stopped");
}
async function cancelRecording() {
  if (!IO.recording && !HUM.recording) return toast("Not recording");
  await call("record_cancel");
  IO.recording = HUM.recording = false;
  $("#rec").classList.remove("on"); $("#ioRec").textContent = "● Record take";
  renderBrowser(); toast("Recording cancelled, nothing was saved");
}
function performanceMode() {  // a clean stage to play live
  closeAllWindows();
  song = true; OPT.autoscroll = true; OPT.typing = true;
  $("#mixer").classList.add("collapsed");
  renderTop(); replay();
  toast("Performance mode: song playback, auto scroll, keyboard to piano on. Space to start.");
}
async function exportMidi() { const p = await call("export_midi", P, song, cur); if (p) toast(`MIDI saved to ${p}`); }
function used(ci) { return P.patterns.some(pt => pt.steps[ci].some(Boolean) || pt.notes[ci].length); }
function removeUnused(samplesOnly) {
  const gone = P.channels.map((ch, ci) => ci).filter(ci => !used(ci) && (!samplesOnly || P.channels[ci].kind === "sample"));
  if (!gone.length) return toast(samplesOnly ? "No unused audio clips" : "Every channel is used");
  if (!confirm(`Remove ${gone.length} unused ${samplesOnly ? "audio clip channel" : "channel"}(s): ${gone.map(ci => P.channels[ci].name).join(", ")}?`)) return;
  edit(() => gone.reverse().forEach(ci => removeChannel(ci)));
}
function riffMachine() {  // a random riff in C minor pentatonic for the selected instrument
  const ch = P.channels[target];
  if (!ch || (ch.kind !== "synth" && ch.kind !== "vst" && ch.kind !== "midiout")) return toast("Select a synth channel first (click its name)");
  const scale = [0, 3, 5, 7, 10], root = 60;  // C; the synth's own octave knob still applies
  const notes = [];
  for (let s = 0; s < STEPS;) {
    const len = [1, 1, 2, 2, 3, 4][Math.floor(Math.random() * 6)];
    if (Math.random() < 0.78) notes.push([s, Math.min(len, STEPS - s), root + scale[Math.floor(Math.random() * 5)] + (Math.random() < 0.2 ? 12 : 0), +(0.6 + Math.random() * 0.4).toFixed(2)]);
    s += len;
  }
  edit(() => { P.patterns[cur].notes[target] = notes; });
  show("rollPanel"); render();
  toast(`Riff generator wrote ${notes.length} notes for ${ch.name}. Run it again for another idea; Ctrl+Z goes back.`);
}
function dumpScore() {  // turn what you just played (last phrase, up to 4 bars) into notes
  const done = SCORE.filter(ev => ev.end != null);
  if (!done.length) return toast("Nothing played yet. Play your MIDI or computer keyboard, then dump.");
  let start = done.length - 1;
  while (start > 0 && done[start].t - done[start - 1].t < 4000) start--;  // a 4 s silence separates phrases
  const phrase = done.slice(start), t0s = phrase[0].t, step = 60000 / P.bpm / 4;
  const ch = P.channels[target];
  if (!ch) return toast("Select a channel first");
  edit(() => phrase.forEach(ev => {
    const st = Math.round((ev.t - t0s) / step);
    if (st >= 4 * STEPS) return;
    spill((pt, s) => pt.notes[target].push([s, Math.max(1, Math.min(Math.round((ev.end - ev.t) / step), STEPS - s)), ev.note, +ev.vel.toFixed(2)]))(st);
  }));
  show("rollPanel"); render();
  toast(`Dumped ${phrase.length} logged notes into ${P.patterns[cur].name} for ${ch.name}`);
}

// ---------- external MIDI out + optional VST3 plugins ----------
function midiPort(ch) { return IO.access && [...IO.access.outputs.values()].find(o => o.name === ch.port); }
function midiOutStep(step, stepSec) {  // called by the playhead on every new step
  if (!playing) return;
  const pats = song ? P.playlist.filter(c => !c.type && c.bar === Math.floor(step / STEPS)).map(c => c.pattern) : [cur];
  P.channels.forEach((ch, ci) => {
    if (ch.kind !== "midiout") return;
    const out = midiPort(ch), chn = ((ch.midich || 1) - 1) & 15, s = step % STEPS;
    if (!out) return;
    for (const pi of pats) {
      const pt = P.patterns[pi];
      if (pt.steps[ci][s]) { out.send([0x90 | chn, 60 + (ch.pitch || 0), 100]); out.send([0x80 | chn, 60 + (ch.pitch || 0), 0], performance.now() + stepSec * 900); }
      for (const [st, len, m, v] of pt.notes[ci]) if (st === s) {
        out.send([0x90 | chn, m, Math.max(1, Math.round(v * 127))]);
        out.send([0x80 | chn, m, 0], performance.now() + len * stepSec * 1000 - 5);
      }
    }
  });
}
function midiAllOff() { if (IO.access) for (const o of IO.access.outputs.values()) for (let c = 0; c < 16; c++) o.send([0xB0 | c, 123, 0]); }
function addMidiOut() {
  const outs = IO.access ? [...IO.access.outputs.values()] : [];
  addSound("midiout", "MIDI Out", null, null, () => {
    const ch = P.channels.at(-1);
    ch.port = outs[0]?.name || ""; ch.midich = 1;
    openSettings = P.channels.length - 1;
  });
  if (!outs.length) toast("No MIDI output found yet. Connect a device or loopMIDI, then pick it in the channel's settings.");
}
async function addVst(kind) {
  const st = await call("plugins_status");
  if (!st) return;
  if (!st.available) return toast("VST3 plugins are an optional add-on: run  pip install pedalboard  and restart MLabs.");
  const pl = await call("pick_plugin");
  if (!pl) return;
  if (kind === "instrument" || pl.is_instrument) {
    if (!pl.is_instrument) return toast(`${pl.name} is an effect, not an instrument. Use Add → Effect → VST3 effect.`);
    await addSound("vst", pl.name.slice(0, 14), null, null, () => { P.channels.at(-1).plugin = pl.path; });
  } else {
    const tr = P.mixer[selTrack], i = tr.fx.findIndex(s => !s);
    if (i < 0) return toast("All 10 slots on this track are full");
    edit(() => { tr.fx[i] = { type: "VST3", path: pl.path, name: pl.name, on: true }; selSlot = i; });
    $("#mixer").hidden = false; renderTop();
  }
}

// ---------- channel right-click menu: rename/colour, load sample, cut itself, clone, steps tools ----------
const STEPCLIP = { steps: null };
function channelMenu(ci, x, y) {
  const ch = P.channels[ci], pt = P.patterns[cur], steps = pt.steps[ci];
  const fill = n => () => edit(() => { pt.steps[ci] = steps.map((_, s) => s % n === 0); });
  const rot = d => () => edit(() => { pt.steps[ci] = steps.map((_, s) => steps[(s - d + STEPS) % STEPS]); });
  const kinds = [...KINDS.map(([k, n]) => [n, "", () => insertChannelAt(ci + 1, k, n)]), ["Synth", "", () => insertChannelAt(ci + 1, "synth", "Synth")]];
  showContext(x, y, [
    { head: ch.name }, ["Piano roll", "F7", () => { target = ci; show("rollPanel"); render(); }],
    ["Rename…", "", () => { const n = prompt("Channel name", ch.name); if (n && n.trim()) edit(() => { ch.name = n.trim(); }); }],
    ["Change color", "", () => edit(() => { ch.color = COLORS[(COLORS.indexOf(ch.color) + 1) % COLORS.length]; })],
    ["Random color", "", () => edit(() => { ch.color = `hsl(${Math.floor(Math.random() * 360)} 50% 70%)`; })], "-",
    ...(ch.kind === "sample" ? [["Load sample…", "", async () => { const p = await call("pick_sample"); if (p) edit(() => { ch.sample = p; }); }],
      ["Cut itself", "", () => edit(() => { ch.smp = { ...(ch.smp || {}), cut: !ch.smp?.cut }; }), !!ch.smp?.cut]] : []),
    ...(ch.kind === "sample" && ch.sample ? [["Send to playlist as audio clip", "", () => placeAudioClip(ci, freeTrack(0), 0)]] : []),
    ["Settings…", "", () => { openSettings = ci; renderRack(); }],
    ["Insert", "", null, undefined, () => kinds],
    ["Clone", "", () => edit(() => {
      const copy = JSON.parse(JSON.stringify(ch)); copy.name = `${ch.name} #2`;
      remapChannels(i => (i > ci ? i + 1 : i));
      P.channels.splice(ci + 1, 0, copy);
      P.patterns.forEach(p => { p.steps.splice(ci + 1, 0, [...p.steps[ci]]); p.notes.splice(ci + 1, 0, p.notes[ci].map(n => [...n])); });
    })],
    ["Delete…", "", () => { if (confirm(`Delete ${ch.name}?`)) edit(() => removeChannel(ci)); }], "|",
    { head: "Steps" }, ["Cut", "", () => { STEPCLIP.steps = [...steps]; edit(() => { pt.steps[ci] = steps.map(() => false); }); }],
    ["Copy", "", () => { STEPCLIP.steps = [...steps]; toast("Steps copied"); }],
    ["Paste", "", () => { if (STEPCLIP.steps) edit(() => { pt.steps[ci] = [...STEPCLIP.steps]; }); }], "-",
    ["Fill each 2 steps", "", fill(2)], ["Fill each 4 steps", "", fill(4)], ["Fill each 8 steps", "", fill(8)],
    ["Clear", "", () => edit(() => { pt.steps[ci] = steps.map(() => false); })], "-",
    ["Rotate left", "Shift+Ctrl+Left", rot(-1)], ["Rotate right", "Shift+Ctrl+Right", rot(1)],
  ]);
}
async function insertChannelAt(pos, kind, name) {
  const ch = await call("new_channel", kind, name, null, null);
  if (!ch) return;
  edit(() => {
    addChannel(ch);  // appended (and auto-linked to a free insert), then moved into place
    const last = P.channels.length - 1;
    const move = arr => arr.splice(pos, 0, arr.splice(last, 1)[0]);
    remapChannels(i => (i >= pos ? i + 1 : i));
    move(P.channels); P.patterns.forEach(p => { move(p.steps); move(p.notes); });
    target = pos;
  });
}

// ---------- quick toolbar beside "+": small buttons, fully customizable (Tools → Customize quick buttons) ----------
const QUICK = {
  picker: ["Plugin picker (F8)", "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z", () => openPicker()],
  rack: ["Step Rack (F6)", "M2 4h12M2 8h12M2 12h12", () => toggle("rackPanel")],
  roll: ["Piano roll (F7)", "M3 2v12M6 4h5M6 8h7M6 12h4", () => toggle("rollPanel")],
  mixer: ["Mixer (F9)", "M4 2v12M8 2v12M12 2v12M2 10h4M6 5h4M10 8h4", () => toggle("mixer")],
  ai: ["AI Composer", "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z", () => openAI("composer")],
  pitch: ["Perfect pitch", "M2 9c2-5 3 5 5 0s3 5 5 0", () => openTab("pitch")],
  tap: ["Tempo tapper", "M8 2v6M5 9h6l-1 5H6z", () => openTapper()],
  export: ["Export audio (Ctrl+E)", "M8 2v8M5 7l3 3 3-3M3 13h10", () => openExport()],
  midi: ["Export MIDI", "M2 5h12v6H2zM5 5v3M8 5v3M11 5v3", () => exportMidi()],
  perf: ["Plugin performance monitor", "M2 13h12M4 13V8M7 13V4M10 13V9M13 13V6", () => openPerf()],
  perform: ["Prepare for performance mode", "M2 12l4-4 3 3 5-6", () => performanceMode()],
  panic: ["Stop sound (Ctrl+H)", "M5 2h6l3 3v6l-3 3H5l-3-3V5zM6 6l4 4M10 6l-4 4", () => panic()],
  score: ["Turn what I played into notes", "M3 3h10v10H3zM5 6h6M5 9h4", () => dumpScore()],
  riff: ["Riff generator", "M2 11c3 0 3-6 6-6s3 6 6 6", () => riffMachine()],
  find: ["Browser find (Ctrl+F)", "M7 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM10 10l4 4", () => browserFind()],
  audio: ["Audio & MIDI (F10)", "M3 6v4M6 4v8M9 2v12M12 5v6", () => openIO()],
};
let QUICK_ON = ["picker", "rack", "roll", "mixer", "ai", "pitch", "export", "perf", "panic"];
function renderQuick() {
  $("#quick").replaceChildren(...QUICK_ON.filter(id => QUICK[id]).map(id => h("button", { class: "qbtn", title: QUICK[id][0],
      "aria-label": QUICK[id][0], onclick: QUICK[id][2] }, icon(QUICK[id][1]))),
    h("button", { class: "qbtn qmore", title: "Customize quick buttons", "aria-label": "Customize quick buttons", onclick: openQuickCustom }, "⋯"));
}
function openQuickCustom() {
  const draw = () => $("#quickList").replaceChildren(...[...QUICK_ON, ...Object.keys(QUICK).filter(id => !QUICK_ON.includes(id))].map(id => {
    const on = QUICK_ON.includes(id), i = QUICK_ON.indexOf(id);
    const save = () => { call("set_setting", "quickbar", QUICK_ON); renderQuick(); draw(); };
    return h("div", { class: "qrow" + (on ? "" : " off") },
      h("label", { class: "tog" }, h("input", { type: "checkbox", checked: on, onchange: e => {
        if (e.target.checked) QUICK_ON.push(id); else QUICK_ON.splice(QUICK_ON.indexOf(id), 1); save(); } }),
        icon(QUICK[id][1]), QUICK[id][0]),
      on ? h("span", { class: "qord" },
        h("button", { class: "chip", "aria-label": `Move ${QUICK[id][0]} left`, disabled: i === 0, onclick: () => { QUICK_ON.splice(i - 1, 0, QUICK_ON.splice(i, 1)[0]); save(); } }, "↑"),
        h("button", { class: "chip", "aria-label": `Move ${QUICK[id][0]} right`, disabled: i === QUICK_ON.length - 1, onclick: () => { QUICK_ON.splice(i + 1, 0, QUICK_ON.splice(i, 1)[0]); save(); } }, "↓")) : null);
  }));
  draw(); show("quickPanel");
}

// ---------- plugin performance monitor ----------
let perfTimer = 0;
function openPerf() {
  show("perfPanel");
  clearInterval(perfTimer);
  const tickPerf = async () => {
    if ($("#perfPanel").hidden) return clearInterval(perfTimer);
    const p = await window.pywebview.api.perf().catch(() => null);
    if (!p) return;
    const max = Math.max(1, ...Object.values(p.tracks));
    $("#perfStats").replaceChildren(...[["CPU", `${p.cpu.toFixed(1)}%`], ["RAM", `${p.ram_mb} MB`], ["Audio thread", `${p.audio_load}%`],
      ["Last render", `${p.render_ms} ms`]].map(([k, v]) => h("div", { class: "pstat" }, h("span", { class: "label" }, k), h("b", {}, v))));
    $("#perfTracks").replaceChildren(...(Object.keys(p.tracks).length ? Object.entries(p.tracks).sort((a, b) => b[1] - a[1]).map(([n, ms]) =>
      h("div", { class: "ptrack" }, h("span", {}, n), h("i", { style: `width:${Math.max(2, ms / max * 100)}%` }), h("small", {}, `${ms} ms`)))
      : [note("Press play once to measure each mixer track.")]));
  };
  tickPerf(); perfTimer = setInterval(tickPerf, 1000);
}

// ---------- collapsible panels ----------
function makeCollapsible() {
  document.querySelectorAll(".panel header").forEach(hd => {
    if (hd.querySelector(".fold")) return;
    const b = h("button", { class: "fold chip", "aria-label": "Collapse", "aria-expanded": "true", onclick: () => {
      const c = hd.parentElement.classList.toggle("collapsed"); b.setAttribute("aria-expanded", String(!c)); b.textContent = c ? "▸" : "▾"; } }, "▾");
    hd.insertBefore(b, hd.querySelector(".x"));
  });
}

// ---------- plugin window: every effect's knobs, grouped in sections ----------
const SWITCHES = new Set(["pingpong", "slope", "invert"]);
let FXW = null;  // {t, i}: the mixer track and slot shown in the plugin window
function openFxWin(t, i) {
  FXW = { t, i };
  renderFxWin();
  show("fxWin");
}
function renderFxWin() {
  const tr = P.mixer[FXW.t], s = tr?.fx[FXW.i];
  if (!s || s.type === "VST3" || !EFX[s.type]) { $("#fxWin").hidden = true; FXW = null; return; }
  const fmt = (min, max, label) => v => label.includes("Hz") ? (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v))
    : label.includes("dB") ? `${v > 0 ? "+" : ""}${v.toFixed(1)}` : Math.abs(max - min) > 4 ? v.toFixed(1) : v.toFixed(2);
  const sections = new Map();
  for (const [k, [min, max, def, label, sec = "Main"]] of Object.entries(EFX[s.type])) {
    const ctl = SWITCHES.has(k)
      ? h("button", { class: "fxswitch" + ((s.params[k] ?? def) >= 0.5 ? " on" : ""), "aria-pressed": String((s.params[k] ?? def) >= 0.5),
          onclick: () => { edit(() => { s.params[k] = (s.params[k] ?? def) >= 0.5 ? 0 : 1; }); } }, h("span", { class: "sled" }), label)
      : knob({ label, min, max, def, get: () => s.params[k] ?? def, set: v => { s.params[k] = v; }, fmt: fmt(min, max, label) });
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(ctl);
  }
  $("#fxWinTitle").replaceChildren(s.type, h("small", {}, ` (${FXW.t === 0 ? "Master" : tr.name}, slot ${FXW.i + 1})`));
  $("#fxWinDesc").textContent = FXDESC[s.type] || "";
  $("#fxWinOn").classList.toggle("on", s.on);
  $("#fxWinOn").setAttribute("aria-pressed", String(s.on));
  $("#fxWinOn").onclick = () => edit(() => { s.on = !s.on; });
  $("#fxWinReset").onclick = () => edit(() => { s.params = Object.fromEntries(Object.entries(EFX[s.type]).map(([k, v]) => [k, v[2]])); });
  $("#fxWinBody").replaceChildren(...[...sections].map(([name, ctls], n) =>
    h("div", { class: "fxsec", style: `--sec:${["#E8C9A6", "#A4BCD0", "#AFC8A2", "#BBAED0", "#D2B1AE"][n % 5]}` },
      h("div", { class: "fxsech" }, name), h("div", { class: "fxseck" }, ...ctls))));
}

// ---------- playlist clips: pattern, audio, automation ----------
const AUTO_RANGE = { vol: [0, 1], pan: [-1, 1], mvol: [0, 1.25] };
const autoRange = key => { const [kind, , prm] = key.split(":"); return AUTO_RANGE[kind === "mx" && prm === "vol" ? "mvol" : prm]; };
const barSec = () => 16 * 60 / P.bpm / 4;
function clipEl(c) {
  const box = (w, bg, cls = "") => ({ class: `clip ${cls}`, style: `left:${c.bar * BW + 2}px;top:${c.track * TH + 3}px;width:${w}px;height:${TH - 6}px;background:${bg}` });
  if (c.type === "audio") {
    const ch = P.channels[c.channel] || {}, w = Math.max(BW / 4, (c.seconds || barSec()) / barSec() * BW) - 4;
    return h("div", { ...box(w, ch.color || "#C9B6E4", "aclip" + (c.channel === target ? " sel" : "")), title: `${ch.name || "Audio"} (audio clip)` },
      h("span", { class: "ctag" }, "♪ "), ch.name || "Audio", waveSvg(c.peaks || [], "cwave"));
  }
  if (c.type === "auto") {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 100 20"); s.setAttribute("preserveAspectRatio", "none"); s.setAttribute("class", "cauto");
    s.innerHTML = `<polyline points="${[...c.points].sort((a, b) => a[0] - b[0]).map(([x, y]) => `${x * 100},${20 - y * 18 - 1}`).join(" ")}"/>`;
    return h("div", { ...box(Math.max(1, c.bars) * BW - 4, "rgba(232,201,166,.28)", "autoclip"), title: `${c.label}: click to edit` },
      h("span", { class: "ctag" }, "⌇ "), c.label, s);
  }
  return h("div", { ...box(BW - 4, color(c.pattern), c.pattern === cur ? "sel" : ""), title: P.patterns[c.pattern].name },
    P.patterns[c.pattern].name, preview(P.patterns[c.pattern]));
}
function freeTrack(bar) {  // first playlist track with nothing starting at this bar
  for (let t = 0; t < TRACKS; t++) if (!P.playlist.some(c => c.track === t && c.bar === bar)) return t;
  return TRACKS - 1;
}
async function placeAudioClip(ci, track, bar) {
  const path = P.channels[ci].sample, info = ((await call("sound_info", [path])) || {})[path] || {};
  edit(() => P.playlist.push({ type: "audio", channel: ci, track, bar, seconds: info.seconds || barSec(), peaks: info.peaks || [] }));
  song = true; renderTop();
  toast(`${P.channels[ci].name} placed on track ${track + 1}, bar ${bar + 1} (SONG mode)`);
}
async function addAudioClip(path, name, track, bar) {
  await addSound("sample", name, path);
  await placeAudioClip(P.channels.length - 1, track, bar);
}
function createAuto(key, label) {
  const [lo, hi] = autoRange(key), [kind, idx, prm] = key.split(":");
  const now = kind === "ch" ? P.channels[+idx][prm] : P.mixer[+idx][prm];
  const y = (now - lo) / (hi - lo), bars = Math.max(4, ...P.playlist.filter(c => !c.type).map(c => c.bar + 1));
  const clip = { type: "auto", key, label, track: freeTrack(0), bar: 0, bars, points: [[0, +y.toFixed(3)], [1, +y.toFixed(3)]] };
  edit(() => P.playlist.push(clip));
  song = true; renderTop();
  openAuto(clip);
}
let AUTO = null;  // the automation clip being edited
function openAuto(c) {
  AUTO = c;
  $("#autoTitle").textContent = `Automation · ${c.label}`;
  $("#autoBars").value = c.bars;
  drawAuto();
  show("autoPanel");
}
function drawAuto() {
  const c = AUTO, W = 640, H = 180, svg = $("#autoSvg"), [lo, hi] = autoRange(c.key);
  const pts = [...c.points].sort((a, b) => a[0] - b[0]);
  const px = ([x, y]) => [x * W, H - y * H];
  const grid = Array.from({ length: c.bars * 4 + 1 }, (_, i) => `<line x1="${i * W / (c.bars * 4)}" y1="0" x2="${i * W / (c.bars * 4)}" y2="${H}" class="${i % 4 ? "g" : "gb"}"/>`).join("");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `${grid}<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="g"/>
    <polygon class="area" points="0,${H} ${pts.map(p => px(p).join(",")).join(" ")} ${W},${H}"/>
    <polyline class="line" points="${pts.map(p => px(p).join(",")).join(" ")}"/>
    ${pts.map((p, i) => `<circle class="pt" data-i="${c.points.indexOf(p)}" cx="${px(p)[0]}" cy="${px(p)[1]}" r="6"/>`).join("")}`;
  const fmt = y => { const v = lo + y * (hi - lo); return c.key.endsWith(":pan") ? panFmt(v) : `${Math.round(v * 100)}%`; };
  $("#autoInfo").textContent = `${pts.length} points · start ${fmt(pts[0][1])} → end ${fmt(pts.at(-1)[1])} · click to add, drag to move, right-click to delete`;
}
function autoPoint(e) {
  const r = $("#autoSvg").getBoundingClientRect();
  return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)].map(v => +v.toFixed(3));
}
function wireAuto() {
  const svg = $("#autoSvg");
  svg.addEventListener("pointerdown", e => {
    if (!AUTO) return;
    const hit = e.target.closest(".pt");
    if (e.button === 2) {
      e.preventDefault();
      if (hit && AUTO.points.length > 2) { edit(() => AUTO.points.splice(+hit.dataset.i, 1)); drawAuto(); }
      return;
    }
    snap();
    let i = hit ? +hit.dataset.i : AUTO.points.push(autoPoint(e)) - 1;
    svg.setPointerCapture(e.pointerId);
    svg.onpointermove = m => { AUTO.points[i] = autoPoint(m); drawAuto(); };
    svg.onpointerup = () => { svg.onpointermove = svg.onpointerup = null; drawAuto(); renderPlaylist(); replay(); };
    drawAuto();
  });
  svg.addEventListener("contextmenu", e => e.preventDefault());
  const preset = pts => () => { edit(() => { AUTO.points = pts; }); drawAuto(); };
  $("#autoUp").onclick = preset([[0, 0], [1, 1]]);
  $("#autoDown").onclick = preset([[0, 1], [1, 0]]);
  $("#autoFlat").onclick = () => { const y = AUTO.points[0][1]; preset([[0, y], [1, y]])(); };
  $("#autoBars").onchange = e => { edit(() => { AUTO.bars = clamp(Math.round(+e.target.value) || 1, 1, BARS); }); drawAuto(); };
  $("#autoDelete").onclick = () => { edit(() => { P.playlist = P.playlist.filter(c => c !== AUTO); }); $("#autoPanel").hidden = true; };
}

// ---------- plugin picker (F8): wall of Generators | Effects with category bar and custom plugins ----------
const THUMB_TINT = { Drum: "#E8C9A6", Synth: "#A4BCD0", Sampler: "#AFC8A2", AI: "#BBAED0", External: "#9DC0B6", Custom: "#D2B1AE",
  Dynamics: "#E8C9A6", Filter: "#A4BCD0", EQ: "#9DC0B6", "Delay reverb": "#BBAED0", Distortion: "#D2B1AE", Modulation: "#AFC8A2", Stereo: "#DDC9A8", Gain: "#C9D3A4", Keys: "#E2C2D6", Bass: "#9FB4E0", Pitch: "#B7D7DA" };
function thumb(kind, tint) {  // a tiny drawn preview of each plugin
  const k = (x, y) => `<circle cx="${x}" cy="${y}" r="5" class="tk"/><line x1="${x}" y1="${y}" x2="${x + 3}" y2="${y - 4}" class="tl"/>`;
  const keys = Array.from({ length: 10 }, (_, i) => `<rect x="${6 + i * 8.8}" y="34" width="8" height="12" class="tw"/>`).join("") +
    [0, 1, 3, 4, 5, 7, 8].map(i => `<rect x="${11.5 + i * 8.8}" y="34" width="5" height="7" class="tb"/>`).join("");
  const body = {
    synth: k(16, 16) + k(34, 16) + k(52, 16) + `<rect x="66" y="9" width="28" height="14" rx="2" class="ts"/><path d="M68 19 l5-7 5 7 5-7 5 7 4-5" class="tp"/>` + keys,
    drum: Array.from({ length: 8 }, (_, i) => `<rect x="${8 + (i % 4) * 22}" y="${8 + Math.floor(i / 4) * 19}" width="18" height="15" rx="3" class="${i % 3 ? "tpad" : "tpad on"}"/>`).join(""),
    sampler: `<rect x="6" y="8" width="88" height="34" rx="3" class="ts"/>` + Array.from({ length: 40 }, (_, i) => { const a = 3 + 12 * Math.abs(Math.sin(i * .7)) * Math.exp(-i / 18); return `<line x1="${9 + i * 2.1}" y1="${25 - a}" x2="${9 + i * 2.1}" y2="${25 + a}" class="tp"/>`; }).join(""),
    ai: `<rect x="6" y="8" width="88" height="34" rx="6" class="ts"/><path d="M50 12l3.5 9.5L63 25l-9.5 3.5L50 38l-3.5-9.5L37 25l9.5-3.5z" class="tf"/>`,
    midi: `<circle cx="50" cy="25" r="16" class="ts"/>` + [0, 1, 2, 3, 4].map(i => { const a = Math.PI * (0.15 + i * 0.175); return `<circle cx="${50 - 10 * Math.cos(a)}" cy="${25 - 10 * Math.sin(a) + 4}" r="2" class="tf"/>`; }).join(""),
    vst: `<rect x="6" y="8" width="88" height="34" rx="3" class="ts"/>` + k(22, 25) + k(42, 25) + k(62, 25) + `<rect x="74" y="14" width="14" height="22" class="tpad on"/><text x="12" y="17" class="tt">VST3</text>`,
    filter: `<rect x="6" y="8" width="88" height="34" rx="3" class="ts"/><path d="M8 18 H52 Q64 18 70 32 T92 40" class="tp"/>`,
    eq: `<rect x="6" y="8" width="88" height="34" rx="3" class="ts"/><path d="M8 28 Q20 14 30 28 T50 26 Q62 38 72 26 T92 22" class="tp"/>` + k(22, 46).replace(/cy="46"/, 'cy="46"'),
    dyn: Array.from({ length: 9 }, (_, i) => `<rect x="${10 + i * 9}" y="${40 - (i < 6 ? 6 + i * 4 : 30)}" width="6" height="${i < 6 ? 6 + i * 4 : 30}" class="${i > 5 ? "tpad on" : "tpad"}"/>`).join("") + `<line x1="8" y1="14" x2="92" y2="14" class="tl"/>`,
    delay: Array.from({ length: 6 }, (_, i) => `<rect x="${10 + i * 14}" y="${10 + i * 5}" width="6" height="${30 - i * 5}" class="tpad"/>`).join(""),
    reverb: `<path d="M8 40 L14 10 L20 40" class="tp"/>` + Array.from({ length: 30 }, (_, i) => `<line x1="${22 + i * 2.4}" y1="${40 - 24 * Math.exp(-i / 9)}" x2="${22 + i * 2.4}" y2="40" class="tl"/>`).join(""),
    drive: `<rect x="6" y="8" width="88" height="34" rx="3" class="ts"/><path d="M10 25 L20 14 H32 L44 36 H56 L66 14 H78 L88 25" class="tp"/>`,
    chorus: `<path d="M8 25 C20 8 30 42 42 25 S64 8 76 25 92 30" class="tp"/><path d="M8 28 C20 14 30 44 42 28 S64 12 76 28 92 34" class="tl"/>`,
    stereo: `<circle cx="50" cy="25" r="5" class="tf"/><path d="M42 25 H14 M20 19 L14 25 20 31 M58 25 H86 M80 19 L86 25 80 31" class="tp"/>`,
  }[kind] || "";
  return `<svg viewBox="0 0 100 50" style="--tint:${tint}" aria-hidden="true">${body}</svg>`;
}
const FX_CAT = { Drive: ["Distortion", "drive"], "Low-pass": ["Filter", "filter"], "High-pass": ["Filter", "filter"], EQ: ["EQ", "eq"],
  Compressor: ["Dynamics", "dyn"], Limiter: ["Dynamics", "dyn"], Delay: ["Delay reverb", "delay"], Reverb: ["Delay reverb", "reverb"],
  Chorus: ["Modulation", "chorus"], Stereo: ["Stereo", "stereo"], "Soft Clipper": ["Distortion", "drive"], "Lo-fi": ["Distortion", "drive"],
  "Multiband Compressor": ["Dynamics", "dyn"], Gate: ["Dynamics", "dyn"], Transient: ["Dynamics", "dyn"], Flanger: ["Modulation", "chorus"],
  Phaser: ["Modulation", "chorus"], "Pitch Shifter": ["Pitch", "eq"], Vocoder: ["Pitch", "synth"],
  "Auto Pan": ["Stereo", "stereo"], Balance: ["Gain", "stereo"] };
let CUSTOM = [];  // custom VST3 plugins the user added: {path, name, is_instrument}
function pickerItems() {
  const gen = [
    ...KINDS.map(([k, n, sub]) => ({ name: n, sub, cat: "Drum", kind: "drum", run: () => addSound(k, n) })),
    { name: "Synth", sub: "Plain 3-osc", cat: "Synth", kind: "synth", run: () => addSound("synth", "Synth") },
    ...PRESETS.map(pr => ({ name: pr, sub: PRESET_DESC[pr] || "Synth preset", cat: presetCat(pr), kind: "synth", run: () => addSound("synth", pr, null, pr) })),
    { name: "Sampler", sub: "Import a WAV", cat: "Sampler", kind: "sampler", run: importWav },
    { name: "Sound library", sub: "Your sound libraries", cat: "Sampler", kind: "sampler", run: () => openTab("samp") },
    ...SAMPLERS.map(([n, sub, smp]) => ({ name: n, sub, cat: "Sampler", kind: "sampler", run: () => addSampler(n, smp) })),
    { name: "Record a take", sub: "Mic or instrument", cat: "Sampler", kind: "sampler", run: toggleRecord },
    { name: "AI Composer", sub: "Describe it, get a clip", cat: "AI", kind: "ai", run: () => openAI("composer") },
    { name: "Perfect pitch", sub: "Hum to instrument", cat: "AI", kind: "ai", run: () => openTab("pitch") },
    { name: "MIDI Out", sub: "External gear", cat: "External", kind: "midi", run: addMidiOut },
    ...CUSTOM.filter(c => c.is_instrument).map(c => ({ name: c.name, sub: "VST3 instrument", cat: "Custom", kind: "vst", custom: c,
      run: () => addSound("vst", c.name.slice(0, 14), null, null, () => { P.channels.at(-1).plugin = c.path; }) })),
  ].map(it => ({ ...it, group: "gen" }));
  const fx = [
    ...Object.keys(EFX).map(n => ({ name: n, sub: FXDESC[n] || "", cat: FX_CAT[n]?.[0] || "Misc", kind: FX_CAT[n]?.[1] || "vst", run: () => addEffect(n) })),
    ...CUSTOM.filter(c => !c.is_instrument).map(c => ({ name: c.name, sub: "VST3 effect", cat: "Custom", kind: "vst", custom: c, run: () => {
      const tr = P.mixer[selTrack], i = tr.fx.findIndex(s => !s);
      if (i < 0) return toast("All 10 slots on this track are full");
      edit(() => { tr.fx[i] = { type: "VST3", path: c.path, name: c.name, on: true }; selSlot = i; });
      $("#mixer").hidden = false; renderTop(); } })),
  ].map(it => ({ ...it, group: "fx" }));
  return [...gen, ...fx];
}
const PICK = { cat: "All" };
async function addCustomPlugin() {
  const st = await call("plugins_status");
  if (!st) return;
  if (!st.available) return toast("Custom VST3 plugins are an optional add-on: run  pip install pedalboard  and restart MLabs.");
  const pl = await call("pick_plugin");
  if (!pl) return;
  CUSTOM = CUSTOM.filter(c => c.path !== pl.path).concat({ path: pl.path, name: pl.name, is_instrument: pl.is_instrument });
  call("set_setting", "custom_plugins", CUSTOM);
  toast(`${pl.name} added to the plugin picker as a ${pl.is_instrument ? "generator" : "effect"}`);
  openPicker();
}

// ---------- plugin picker (F8): everything you can add, as a searchable grid ----------
function openPicker() {
  const q = $("#pickQuery");
  const tile = it => h("button", { class: "ptile", title: `${it.name}: ${it.sub}`,
      onclick: () => { $("#pickerPanel").hidden = true; it.run(); },
      oncontextmenu: it.custom ? e => { e.preventDefault(); showContext(e.clientX, e.clientY, [{ head: it.name },
        ["Remove from picker", "", () => { CUSTOM = CUSTOM.filter(c => c !== it.custom); call("set_setting", "custom_plugins", CUSTOM); openPicker(); }]]); } : null },
    h("span", { class: "pthumb" }), h("span", { class: "pname" }, it.name), h("small", {}, it.sub));
  const draw = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean), items = pickerItems();
    const show_ = it => (PICK.cat === "All" || it.cat === PICK.cat) && words.every(w => `${it.cat} ${it.name} ${it.sub}`.toLowerCase().includes(w));
    const side = (group, title) => {
      const list = items.filter(it => it.group === group && show_(it)), els = list.map(it => { const t = tile(it); t.querySelector(".pthumb").innerHTML = thumb(it.kind, THUMB_TINT[it.cat] || "#A4BCD0"); return t; });
      const addBtn = h("button", { class: "ptile padd", onclick: addCustomPlugin, title: "Add a VST3 plugin from your PC" },
        h("span", { class: "pthumb" }, "+"), h("span", { class: "pname" }, "Add custom plugin…"), h("small", {}, "VST3 · optional add-on"));
      return h("div", { class: "pside" }, h("h3", {}, title), h("div", { class: "pwall" }, ...els, (PICK.cat === "All" || PICK.cat === "Custom") && !words.length ? addBtn : null));
    };
    $("#pickGrid").replaceChildren(side("gen", "Generators"), side("fx", "Effects"));
    const cats = ["All", ...new Set(items.filter(i => i.group === "gen").map(i => i.cat)), "|", ...new Set(items.filter(i => i.group === "fx").map(i => i.cat))];
    if (!cats.includes("Custom")) cats.push("Custom");
    $("#pickCats").replaceChildren(...cats.map(c => c === "|" ? h("span", { class: "psep" }) :
      h("button", { class: "pcatb" + (PICK.cat === c ? " on" : ""), onclick: () => { PICK.cat = c; draw(); } }, c)));
  };
  q.value = ""; q.oninput = draw;
  q.onkeydown = e => { if (e.key === "Enter") $("#pickGrid .ptile:not(.padd)")?.click(); };
  draw();
  show("pickerPanel");
  q.focus();
}

// ---------- tips bar: on if enabled in Options; otherwise shown once, on the very first launch ----------
const TIP_LIST = [
  "Playlist: click or drag across empty cells (any rows) to paint the current pattern, drag a clip to move it, right-click and drag to erase clips.",
  "Piano roll: drag to draw a note, click a note to delete it, right-click and drag to erase many, scroll over a note for velocity.",
  "Knobs: drag up or down, use the mouse wheel or arrow keys, double-click to reset.",
  "Mixer: drag an effect slot onto another to reorder the chain, × removes it. Effects run top to bottom.",
  "Space plays and stops. Edits are heard live without restarting the loop.",
  "F6 Step Rack · F7 Piano roll · F9 Mixer. All of these are also in the View menu.",
  "Tools → AI Mix engineer balances your levels, AI Mastering engineer makes the song loud and clean. Ctrl+Z undoes either.",
  "Sounds tab: filter by category, One-shot or Loop, star favourites, ▶ previews, + or double-click adds to the rack.",
  "PITCH tab: hum or play into your mic, pick Guitar, Bass, Kick… then Create notes, or ✦ AI generate a new take of your tune.",
  "Synth presets (Pluck, Pad, Bass, Lead, Keys) are under Add. Open a synth's settings for its envelope and filter knobs.",
];
const TIPS = { on: false, i: 0 };
function showTip(step = 0) {
  TIPS.i = (TIPS.i + step) % TIP_LIST.length;
  $("#tipText").textContent = TIP_LIST[TIPS.i];
  $("#tipCount").textContent = `Tip ${TIPS.i + 1} of ${TIP_LIST.length}`;
  $("#tips").hidden = false;
  $("#tipNext").focus();
}
function setTips(on) {
  TIPS.on = on;
  call("set_setting", "tips", on);
  if (on) showTip(); else $("#tips").hidden = true;
}
$("#tipNext").onclick = () => showTip(1);
$("#tapBtn").onclick = tap;
$("#tapApply").onclick = () => { if (TAP.bpm) edit(() => { P.bpm = clamp(TAP.bpm, 40, 240); }); $("#tapPanel").hidden = true; };
$("#infoSave").onclick = () => {
  edit(() => { P.info = Object.fromEntries(["title", "author", "genre", "comments"].map(k => [k, $("#info_" + k).value.trim()])); });
  document.title = P.info.title ? `MLabs · ${P.info.title}` : "MLabs";
  $("#infoPanel").hidden = true;
};
$("#tipClose").onclick = $("#tipDone").onclick = () => { $("#tips").hidden = true; };
$("#tipSkip").onclick = () => { setTips(false); call("set_setting", "tips_seen", true); toast("Tips are off. Options → Show tips brings them back."); };

const notesEl = $("#notes");
notesEl.addEventListener("pointerdown", e => {
  if (!P.channels[target]) return;
  if (e.button === 2) {  // right-click + drag: erase every note the pointer passes over, as one undo step
    snap();
    notesEl.setPointerCapture(e.pointerId);
    const list = P.patterns[cur].notes[target];
    let erased = 0;
    const erase = m => {
      const [s, k] = rollCell(m);
      for (const n of list.filter(n => n[2] === k && n[0] <= s && s < n[0] + n[1])) { list.splice(list.indexOf(n), 1); erased++; }
      renderRoll();
    };
    erase(e);
    notesEl.onpointermove = erase;
    notesEl.onpointerup = () => {
      notesEl.onpointermove = notesEl.onpointerup = null;
      if (erased) { renderPlaylist(); replay(); } else hist.pop();  // nothing erased: drop the empty undo step
    };
    return;
  }
  if (e.button !== 0) return;
  notesEl.setPointerCapture(e.pointerId);
  const [s0, m] = rollCell(e);
  notesEl.onpointerup = u => {
    notesEl.onpointerup = null;
    const [s1] = rollCell(u);
    if (s0 < 0 || s0 >= STEPS || m < LOW || m >= HIGH) return;
    edit(() => P.patterns[cur].notes[target].push([s0, Math.max(1, Math.min(s1, STEPS - 1) - s0 + 1), m, 0.8]));
  };
});

document.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("keydown", e => {
  const typing = e.target.closest?.("input,textarea,select");
  if (e.key === " " && !typing) { e.preventDefault(); playing ? stop() : play(); }
  else if (e.key === "z" && e.ctrlKey && !typing) { e.preventDefault(); undo(); }
  else if (e.key === "s" && e.ctrlKey) { e.preventDefault(); saveProject(); }
  else if (e.key === "o" && e.ctrlKey) { e.preventDefault(); openProject(); }
  else if (e.key === "e" && e.ctrlKey) { e.preventDefault(); openExport(); }
  else if (e.key === "F10") { e.preventDefault(); openIO(); }
  else if (e.key === "F2") { e.preventDefault(); renamePattern(); }
  else if (e.key === "F4") { e.preventDefault(); newPattern(); }
  else if (e.key === "F5") { e.preventDefault(); toggleArea("no-playlist"); }
  else if (e.key === "F8" && e.altKey) { e.preventDefault(); toggleArea("no-browser"); }
  else if (e.key === "F11") { e.preventDefault(); openInfo(); }
  else if (e.ctrlKey && !e.shiftKey && e.key === "h") { e.preventDefault(); panic(); }
  else if (e.ctrlKey && !e.shiftKey && e.key === "f") { e.preventDefault(); browserFind(); }
  else if (e.key === "F12") { e.preventDefault(); closeAllWindows(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "C") { e.preventDefault(); clonePattern(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "Delete") { e.preventDefault(); deletePattern(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "ArrowUp") { e.preventDefault(); movePattern(-1); }
  else if (e.ctrlKey && e.shiftKey && e.key === "ArrowDown") { e.preventDefault(); movePattern(1); }
  else if (e.ctrlKey && !e.shiftKey && e.key === "t") { e.preventDefault(); OPT.typing = !OPT.typing; toast(`Typing keyboard to piano ${OPT.typing ? "on" : "off"}`); }
  else if (e.ctrlKey && !e.shiftKey && e.key === "m") { e.preventDefault(); $("#metro").click(); }
  else if (e.ctrlKey && !e.shiftKey && e.key === "p") { e.preventDefault(); OPT.precount = !OPT.precount; toast(`Recording precount ${OPT.precount ? "on" : "off"}`); }
  else if (OPT.typing && !typing && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && KEYMAP[e.key.toLowerCase()] != null) {
    e.preventDefault(); liveNote(true, KEYMAP[e.key.toLowerCase()] + 12 * OPT.octave, 0.8);
  }
  else if (e.key === "F8") { e.preventDefault(); openPicker(); }
  else if (e.key === "Escape" && !$("#pickerPanel").hidden) $("#pickerPanel").hidden = true;
  else if (e.key === "Escape" && openMenu !== -1) closeMenu();
  else if (e.key === "Escape" && !$("#tips").hidden) $("#tips").hidden = true;
  else if (e.key === "F5") e.preventDefault(); // WebView would reload and lose the project
  else if (e.key === "F6") { e.preventDefault(); toggle("rackPanel"); }
  else if (e.key === "F7") { e.preventDefault(); toggle("rollPanel"); }
  else if (e.key === "F9") { e.preventDefault(); toggle("mixer"); }
});

// ---------- appearance (View menu) ----------
let THEME = "misty";
function applyTheme(t) { THEME = t; document.documentElement.dataset.theme = t; }
function setTheme(t) { applyTheme(t); call("set_setting", "theme", t); }
async function pickWallpaper() { const url = await call("pick_wallpaper"); if (url) applyWallpaper(url); }
async function clearWallpaper() { await call("clear_wallpaper"); applyWallpaper(null); }
function applyWallpaper(dataUrl) {
  // Chromium ignores CSS URLs over 2 MB, which most photos exceed as base64, so hand CSS a short blob: URL instead
  if (applyWallpaper.blob) URL.revokeObjectURL(applyWallpaper.blob);
  applyWallpaper.blob = null;
  if (dataUrl) {
    const [head, b64] = dataUrl.split(",");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    applyWallpaper.blob = URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }));
  }
  document.body.style.setProperty("--wall", applyWallpaper.blob ? `url("${applyWallpaper.blob}")` : "none");
  document.body.classList.toggle("has-wall", !!dataUrl);
}

// ---------- export: format + sample rate, remembered between sessions ----------
const EXP = { fmt: "wav24", rate: 44100 };
async function openExport() {
  const o = await call("export_options");
  if (!o) return;
  $("#expFmt").replaceChildren(...Object.entries(o.formats).map(([k, label]) => h("option", { value: k, selected: k === EXP.fmt }, label)));
  $("#expRate").replaceChildren(...o.rates.map(r => h("option", { value: r, selected: r === EXP.rate }, `${r / 1000} kHz`)));
  expNote();
  show("exportPanel");
}
function expNote() {
  $("#expNote").textContent = EXP.fmt === "mp3" ? "MP3 is lossy and capped at 48 kHz. Pick WAV or FLAC for masters."
    : EXP.rate > 44100 ? "MLabs renders at 44.1 kHz; higher rates are a clean conversion for video or labels that require them."
    : "24-bit WAV at 44.1 kHz is the usual choice for streaming services and mastering.";
}
$("#expFmt").onchange = e => { EXP.fmt = e.target.value; expNote(); call("set_setting", "export_format", EXP.fmt); };
$("#expRate").onchange = e => { EXP.rate = +e.target.value; expNote(); call("set_setting", "export_rate", EXP.rate); };
$("#expSong").onclick = async () => { const p = await call("export", P, song, cur, EXP.fmt, EXP.rate); if (p) toast(`Exported ${p}`); };
$("#expStems").onclick = async () => { const p = await call("export_stems", P, song, cur, EXP.fmt, EXP.rate); if (p) toast(`Stems saved to ${p}`); };

// ---------- audio & MIDI: devices, live listening (the AI hears your instrument), takes, MIDI keyboard ----------
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = m => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const IO = { timer: 0, lastTake: null, recording: false, midiOn: new Map() };
async function openIO() {
  const d = await call("audio_devices");
  if (!d) return;
  const opts = (list, curDev) => [h("option", { value: "", selected: curDev == null }, "System default"),
    ...list.map(x => h("option", { value: x.index, selected: x.index === curDev }, `${x.name} · ${x.api}`))];
  $("#outDev").replaceChildren(...opts(d.outputs, d.output));
  $("#inDev").replaceChildren(...opts(d.inputs, d.input));
  show("ioPanel");
  const st = await call("input_open");
  if (st) listen();
}
function listen() {  // poll level + pitch while the panel is open
  clearInterval(IO.timer);
  IO.timer = setInterval(async () => {
    if ($("#ioPanel").hidden && !IO.recording) { clearInterval(IO.timer); call("input_close"); return; }
    let s; try { s = await window.pywebview.api.input_status(); } catch { return; }
    $("#inLevel").style.width = `${Math.min(100, s.level * 140)}%`;
    if (s.midi != null) {
      const m = Math.round(s.midi), cents = Math.round((s.midi - m) * 100);
      $("#tuneNote").textContent = noteName(m);
      $("#tuneCents").textContent = `${cents > 0 ? "+" : ""}${cents} cents · ${(440 * 2 ** ((s.midi - 69) / 12)).toFixed(1)} Hz`;
    } else { $("#tuneNote").textContent = "–"; $("#tuneCents").textContent = s.level > 0.01 ? "no clear pitch" : "play a note"; }
    $("#recTime").textContent = s.recording ? `recording ${s.seconds}s` : "";
  }, 100);
}
$("#outDev").onchange = e => call("set_audio", "output", e.target.value === "" ? null : +e.target.value);
$("#inDev").onchange = async e => { await call("set_audio", "input", e.target.value === "" ? null : +e.target.value); listen(); };

async function toggleRecord() {
  if (!IO.recording && OPT.precount) {
    const hadMetro = metro, beat = 60 / P.bpm;
    metro = true; renderTop();
    if (!playing) await play(); else replay();
    for (let b = 4; b >= 1; b--) { toast(`Recording in ${b}…`); await new Promise(r => setTimeout(r, beat * 1000)); }
    if (!hadMetro) { metro = false; renderTop(); replay(); }
  }
  if (!IO.recording) {
    if (await call("record_start") === undefined) return;  // error already shown (no input device?)
    IO.recording = true; listen();
    toast("Recording your input. Press ● again to stop. MIDI notes are written while the song plays.");
  } else {
    IO.recording = false;
    const take = await call("record_stop");
    if (!take) return toast("Nothing was recorded. Check the input device in Audio & MIDI (F10).");
    IO.lastTake = take;
    const name = `Take ${P.channels.filter(c => c.name.startsWith("Take")).length + 1}`;
    await addSound("sample", name, take.path);
    $("#takeName").textContent = `${name} · ${take.seconds}s`;
    $("#takeRow").hidden = false;
  }
  $("#rec").classList.toggle("on", IO.recording); $("#rec").setAttribute("aria-pressed", String(IO.recording));
  $("#ioRec").textContent = IO.recording ? "■ Stop take" : "● Record take";
}
$("#rec").onclick = toggleRecord;
$("#ioRec").onclick = toggleRecord;
$("#takeNotes").onclick = async () => {
  if (!IO.lastTake) return;
  const synth = P.channels.findIndex(c => c.kind === "synth");
  if (P.channels[target]?.kind !== "synth" && synth >= 0) target = synth;  // notes belong on an instrument
  const notes = await call("transcribe", IO.lastTake.path, P.bpm);
  if (!notes || !notes.length) return toast("No clear notes in that take. Single notes work best.");
  edit(() => {
    for (const [st, len, m, vel] of notes) {
      const pi = cur + Math.floor(st / STEPS);
      while (pi >= P.patterns.length) P.patterns.push(emptyPattern(`Pattern ${P.patterns.length + 1}`));
      P.patterns[pi].notes[target].push([st % STEPS, Math.min(len, STEPS - st % STEPS), m, vel]);
    }
  });
  show("rollPanel");
  toast(`The AI heard ${notes.length} notes and wrote them for ${P.channels[target].name}`);
};

// MIDI keyboard through the WebView's built-in Web MIDI (no extra install): plays the selected channel live,
// and while recording + playing, writes the notes into the current pattern's piano roll
function stepNow() { return Math.floor((((performance.now() - t0) / 1000) % loop) / (60 / P.bpm / 4)) % STEPS; }
function midiMessage(e) {
  const [st, note, vel] = e.data, cmd = st & 0xf0;
  if (cmd === 0x90 && vel > 0) liveNote(true, note, vel / 127);
  else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) liveNote(false, note);
}
// typing keyboard to piano: Z-row = C3 octave, Q-row = C4 octave (shift with OPT.octave)
const KEYMAP = Object.fromEntries([..."zsxdcvgbhnjm"].map((k, i) => [k, 48 + i]).concat([..."q2w3er5t6y7u"].map((k, i) => [k, 60 + i]),
  [["i", 72], ["9", 73], ["o", 74], ["0", 75], ["p", 76]]));
const OPT = { typing: true, precount: false, autoscroll: true, octave: 0 };
function liveNote(on, note, vel = 0.8) {  // a key went down/up on a MIDI keyboard or the computer keyboard
  const ch = P && P.channels[target];
  if (!ch) return;
  const gain = (P.mixer[ch.insert]?.vol ?? 1) * P.mixer[0].vol;
  if (on) {
    if (IO.midiOn.has(note)) return;
    window.pywebview.api.note_on(ch, note, vel, gain);
    IO.midiOn.set(note, { step: playing ? stepNow() : null, vel });
    SCORE.push({ note, vel, t: performance.now(), end: null });  // play history: nothing you play is lost
    if (SCORE.length > 4000) SCORE.splice(0, SCORE.length - 4000);
  } else {
    if (!IO.midiOn.has(note)) return;
    window.pywebview.api.note_off(ch, note);
    const open = SCORE.findLast(ev => ev.note === note && ev.end == null);
    if (open) open.end = performance.now();
    const on = IO.midiOn.get(note);
    IO.midiOn.delete(note);
    if (IO.recording && playing && !song && on && on.step != null) {
      const len = Math.max(1, ((stepNow() - on.step + STEPS) % STEPS) || 1);
      edit(() => P.patterns[cur].notes[target].push([on.step, Math.min(len, STEPS - on.step), note, +on.vel.toFixed(2)]));
    }
  }
}
document.addEventListener("keyup", e => {
  const k = KEYMAP[e.key.toLowerCase()];
  if (k != null && OPT.typing) liveNote(false, k + 12 * OPT.octave);
});

async function initMidi() {
  if (!navigator.requestMIDIAccess) { $("#midiStatus").textContent = "Web MIDI isn't available in this window."; return; }
  try {
    const access = await navigator.requestMIDIAccess();
    const wire = () => {
      const ins = [...access.inputs.values()];
      ins.forEach(i => { i.onmidimessage = midiMessage; });
      $("#midiStatus").textContent = ins.length ? `Connected: ${ins.map(i => i.name).join(", ")}. Plays the selected channel.`
        : "No MIDI keyboard found. Plug one in; it's picked up automatically.";
    };
    IO.access = access;
    access.onstatechange = wire;
    wire();
  } catch (err) { $("#midiStatus").textContent = `MIDI access was blocked (${err.name}).`; }
}

// ---------- boot animation: trace the treble clef stroke by stroke, then pop the dot ----------
const traced = new Promise(resolve => {
  const clef = $("#splashClef"), dot = $("#splashDot");
  if (!clef) return resolve();
  const len = clef.getTotalLength();
  clef.style.strokeDasharray = `${len}`;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    clef.style.strokeDashoffset = "0"; dot.classList.add("pop"); return resolve();
  }
  clef.style.strokeDashoffset = `${len}`;
  const start = performance.now() + 350, dur = 1900;  // let the letters rise first
  const ease = k => (k < .5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);  // slow in, slow out, like a pen
  const frame = now => {
    const k = Math.min(1, Math.max(0, (now - start) / dur));
    clef.style.strokeDashoffset = `${len * (1 - ease(k))}`;
    if (k < 1) return requestAnimationFrame(frame);
    dot.classList.add("pop");
    setTimeout(resolve, 550);  // a beat to admire it before the studio opens
  };
  requestAnimationFrame(frame);
});

// ---------- boot: splash stays until the engine has answered (at least ~1.2 s so it doesn't flash) ----------
window.addEventListener("pywebviewready", async () => {
  const msg = t => { $("#splashMsg").textContent = t; };
  msg("Reading your settings…");
  const look = await call("settings");
  if (look) {
    applyTheme(look.theme); applyWallpaper(look.wallpaper_url); TIPS.on = look.tips;
    EXP.fmt = look.export_format || EXP.fmt; EXP.rate = look.export_rate || EXP.rate;
    LIB.stars = new Set(look.starred || []);
    if (Array.isArray(look.quickbar)) QUICK_ON = look.quickbar.filter(id => QUICK[id]);
    CUSTOM = Array.isArray(look.custom_plugins) ? look.custom_plugins : [];
  }
  initMidi();
  renderQuick();
  wireAuto();
  makeCollapsible();
  msg("Loading instruments and effects…");
  AI.models = (await call("composer_models")) || [];
  AI.model = AI.models[0];
  PRESETS = (await call("synth_presets")) || [];
  EFX = await call("effects");
  msg("Setting up the studio…");
  P = normalize(await call("new_project"));
  render();
  if (look && (look.tips || !look.tips_seen)) { showTip(); if (!look.tips_seen) call("set_setting", "tips_seen", true); }
  msg("Ready");
  await traced;  // the studio opens once the clef is fully drawn (and the engine is ready)
  $("#splash").classList.add("gone");
  call("boot_done");  // leave full-screen startup for a maximized window at native resolution
  if ($("#tips").hidden) setTimeout(showNotice, 600);  // after the tips if they're up, else right after the splash
  else new MutationObserver((_, obs) => { if ($("#tips").hidden) { obs.disconnect(); setTimeout(showNotice, 300); } })
    .observe($("#tips"), { attributes: true, attributeFilter: ["hidden"] });
  setTimeout(() => call("ai_warmup", "composer"), 1500);  // load the AI in the background so the first Generate is quick
  setTimeout(() => $("#splash").remove(), 700);
});
