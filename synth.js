// ===== SYNTHY - Sound Engine (Tone.js) =====

(function () {
  'use strict';

  // ===== STATE =====
  const state = {
    powered: false,
    octave: 4,
    activeNotes: new Map(), // note -> synth voice
    waveform: 'sine',
    adsr: { attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.5 },
    filter: { type: 'lowpass', frequency: 2000, Q: 1 },
    lfo: { rate: 2, depth: 0, target: 'filter' },
    osc2: { enabled: false, waveform: 'square', detune: 0, octave: 0 },
    effects: { reverbWet: 0, delayWet: 0, delayTime: 0.25, chorusWet: 0 },
    masterVolume: -6,
    portamento: 0,
    voices: [],
    maxVoices: 8,
  };

  // ===== TONE.JS NODES =====
  let masterVol, masterGain, filter, reverb, delay, chorus, lfo, lfoGain;
  let analyser;

  function initAudio() {
    if (state.powered) return;

    Tone.start().then(() => {
      // Master chain
      masterVol = new Tone.Volume(state.masterVolume);
      masterGain = new Tone.Gain(1);
      analyser = new Tone.Analyser('waveform', 256);

      // Filter
      filter = new Tone.Filter(state.filter.frequency, state.filter.type);
      filter.Q.value = state.filter.Q;

      // Effects
      reverb = new Tone.Reverb({ decay: 2.5, wet: state.effects.reverbWet });
      delay = new Tone.FeedbackDelay({
        delayTime: state.effects.delayTime,
        feedback: 0.35,
        wet: state.effects.delayWet,
      });
      chorus = new Tone.Chorus({ frequency: 2, delayTime: 3.5, depth: 0.5, wet: state.effects.chorusWet }).start();

      // LFO
      lfo = new Tone.LFO(state.lfo.rate, -1, 1).start();
      lfoGain = new Tone.Gain(0);
      lfo.connect(lfoGain);

      // Signal chain: voices → filter → chorus → delay → reverb → masterVol → analyser → destination
      filter.connect(chorus);
      chorus.connect(delay);
      delay.connect(reverb);
      reverb.connect(masterVol);
      masterVol.connect(analyser);
      analyser.connect(Tone.Destination);

      applyLfoTarget();

      state.powered = true;
      updatePowerUI(true);
      startVisualizer();
    });
  }

  function applyLfoTarget() {
    if (!lfoGain) return;
    lfoGain.disconnect();
    lfoGain.gain.value = state.lfo.depth * 2000;
    if (state.lfo.target === 'filter') {
      lfoGain.connect(filter.frequency);
    } else if (state.lfo.target === 'pitch') {
      // pitch modulation applied per-note via shared lfoGain → osc detune
    } else if (state.lfo.target === 'volume') {
      lfoGain.connect(masterVol.volume);
    }
  }

  // ===== VOICE MANAGEMENT =====
  function createVoice(freq) {
    const osc1 = new Tone.OmniOscillator({
      type: state.waveform,
      frequency: freq,
      detune: 0,
    });

    const osc2Node = state.osc2.enabled
      ? new Tone.OmniOscillator({
          type: state.osc2.waveform,
          frequency: freq * Math.pow(2, state.osc2.octave) * Math.pow(2, state.osc2.detune / 1200),
          detune: state.osc2.detune,
        })
      : null;

    const env = new Tone.AmplitudeEnvelope({
      attack: state.adsr.attack,
      decay: state.adsr.decay,
      sustain: state.adsr.sustain,
      release: state.adsr.release,
    });

    const voiceGain = new Tone.Gain(state.osc2.enabled ? 0.5 : 1);

    osc1.connect(env);
    if (osc2Node) {
      osc2Node.connect(env);
      osc2Node.start();
    }
    env.connect(voiceGain);
    voiceGain.connect(filter);

    if (state.lfo.target === 'pitch' && lfoGain) {
      lfoGain.connect(osc1.detune);
      if (osc2Node) lfoGain.connect(osc2Node.detune);
    }

    osc1.start();
    env.triggerAttack();

    return { osc1, osc2: osc2Node, env, voiceGain, freq };
  }

  function noteOn(note) {
    if (!state.powered) return;
    if (state.activeNotes.has(note)) return;

    // Release oldest voice if at max polyphony
    if (state.activeNotes.size >= state.maxVoices) {
      const oldest = state.activeNotes.keys().next().value;
      noteOff(oldest);
    }

    const freq = Tone.Frequency(note).toFrequency();
    const voice = createVoice(freq);
    state.activeNotes.set(note, voice);
    updateVoiceLEDs();
  }

  function noteOff(note) {
    if (!state.activeNotes.has(note)) return;
    const voice = state.activeNotes.get(note);

    voice.env.triggerRelease();
    const releaseTime = state.adsr.release + 0.1;

    setTimeout(() => {
      try {
        voice.env.disconnect();
        voice.osc1.stop();
        voice.osc1.disconnect();
        if (voice.osc2) {
          voice.osc2.stop();
          voice.osc2.disconnect();
        }
        voice.voiceGain.disconnect();
      } catch (e) { /* already disposed */ }
    }, releaseTime * 1000);

    state.activeNotes.delete(note);
    updateVoiceLEDs();
  }

  function allNotesOff() {
    for (const note of state.activeNotes.keys()) {
      noteOff(note);
    }
  }

  // ===== KEYBOARD MAPPING =====
  const keyboardMap = {
    'a': 'C', 'w': 'C#', 's': 'D', 'e': 'D#', 'd': 'E',
    'f': 'F', 't': 'F#', 'g': 'G', 'y': 'G#', 'h': 'A',
    'u': 'A#', 'j': 'B', 'k': 'C+1', 'o': 'C#+1', 'l': 'D+1',
    'p': 'D#+1', ';': 'E+1',
  };

  const pressedKeys = new Set();

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;

    const key = e.key.toLowerCase();

    if (key === 'z') { state.octave = Math.max(1, state.octave - 1); updateOctaveDisplay(); return; }
    if (key === 'x') { state.octave = Math.min(7, state.octave + 1); updateOctaveDisplay(); return; }

    if (keyboardMap[key] && !pressedKeys.has(key)) {
      pressedKeys.add(key);
      const noteStr = keyboardMap[key];
      const [noteName, octOffset] = noteStr.includes('+')
        ? [noteStr.split('+')[0], parseInt(noteStr.split('+')[1])]
        : [noteStr, 0];
      const note = `${noteName}${state.octave + octOffset}`;
      noteOn(note);
      highlightPianoKey(note, true);
    }
  });

  document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (keyboardMap[key]) {
      pressedKeys.delete(key);
      const noteStr = keyboardMap[key];
      const [noteName, octOffset] = noteStr.includes('+')
        ? [noteStr.split('+')[0], parseInt(noteStr.split('+')[1])]
        : [noteStr, 0];
      const note = `${noteName}${state.octave + octOffset}`;
      noteOff(note);
      highlightPianoKey(note, false);
    }
  });

  // ===== UI UPDATE FUNCTIONS =====
  function updatePowerUI(on) {
    const btn = document.getElementById('power-btn');
    const led = document.getElementById('power-led');
    if (btn) btn.classList.toggle('on', on);
    if (led) led.classList.toggle('active', on);
  }

  function updateOctaveDisplay() {
    const el = document.getElementById('octave-display');
    if (el) el.textContent = state.octave;
  }

  function updateVoiceLEDs() {
    const leds = document.querySelectorAll('.voice-led');
    leds.forEach((led, i) => {
      led.classList.toggle('active', i < state.activeNotes.size);
    });
  }

  function highlightPianoKey(note, active) {
    const key = document.querySelector(`[data-note="${note}"]`);
    if (key) key.classList.toggle('active', active);
  }

  // ===== KNOB IMPLEMENTATION =====
  class Knob {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.min = options.min ?? 0;
      this.max = options.max ?? 1;
      this.value = options.value ?? 0.5;
      this.step = options.step ?? 0;
      this.onChange = options.onChange ?? (() => {});
      this.color = options.color ?? '#e94560';
      this.size = canvas.width;

      this._dragging = false;
      this._startY = 0;
      this._startValue = this.value;

      this.draw();
      this.attachEvents();
    }

    get normalizedValue() {
      return (this.value - this.min) / (this.max - this.min);
    }

    setNormalized(n) {
      n = Math.max(0, Math.min(1, n));
      let v = this.min + n * (this.max - this.min);
      if (this.step > 0) v = Math.round(v / this.step) * this.step;
      this.value = Math.max(this.min, Math.min(this.max, v));
    }

    draw() {
      const ctx = this.ctx;
      const size = this.size;
      const cx = size / 2;
      const cy = size / 2;
      const r = size / 2 - 4;

      ctx.clearRect(0, 0, size, size);

      // Background ring
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
      ctx.strokeStyle = '#1a1a3a';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Value arc
      const startAngle = 0.75 * Math.PI;
      const endAngle = startAngle + this.normalizedValue * 1.5 * Math.PI;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Knob face
      const grad = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, r - 6);
      grad.addColorStop(0, '#4a4a6a');
      grad.addColorStop(1, '#2a2a4a');
      ctx.beginPath();
      ctx.arc(cx, cy, r - 6, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#1a1a3a';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Indicator dot
      const angle = startAngle + this.normalizedValue * 1.5 * Math.PI;
      const ix = cx + (r - 10) * Math.cos(angle);
      const iy = cy + (r - 10) * Math.sin(angle);
      ctx.beginPath();
      ctx.arc(ix, iy, 3, 0, 2 * Math.PI);
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    attachEvents() {
      this.canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._dragging = true;
        this._startY = e.clientY;
        this._startValue = this.value;
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
      });

      this.canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this._dragging = true;
        this._startY = e.touches[0].clientY;
        this._startValue = this.value;
        document.addEventListener('touchmove', this._onTouchMove, { passive: false });
        document.addEventListener('touchend', this._onTouchEnd);
      }, { passive: false });

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = -e.deltaY / 500;
        this.setNormalized(this.normalizedValue + delta);
        this.draw();
        this.onChange(this.value);
        this.updateValueDisplay();
      }, { passive: false });

      this.canvas.addEventListener('dblclick', () => {
        // reset to default (midpoint)
        this.setNormalized(0.5);
        this.draw();
        this.onChange(this.value);
        this.updateValueDisplay();
      });
    }

    _onMouseMove = (e) => {
      if (!this._dragging) return;
      const dy = this._startY - e.clientY;
      const range = this.max - this.min;
      const delta = (dy / 150) * range;
      this.value = Math.max(this.min, Math.min(this.max, this._startValue + delta));
      if (this.step > 0) this.value = Math.round(this.value / this.step) * this.step;
      this.draw();
      this.onChange(this.value);
      this.updateValueDisplay();
    };

    _onMouseUp = () => {
      this._dragging = false;
      document.removeEventListener('mousemove', this._onMouseMove);
      document.removeEventListener('mouseup', this._onMouseUp);
    };

    _onTouchMove = (e) => {
      e.preventDefault();
      if (!this._dragging) return;
      const dy = this._startY - e.touches[0].clientY;
      const range = this.max - this.min;
      const delta = (dy / 150) * range;
      this.value = Math.max(this.min, Math.min(this.max, this._startValue + delta));
      if (this.step > 0) this.value = Math.round(this.value / this.step) * this.step;
      this.draw();
      this.onChange(this.value);
      this.updateValueDisplay();
    };

    _onTouchEnd = () => {
      this._dragging = false;
      document.removeEventListener('touchmove', this._onTouchMove);
      document.removeEventListener('touchend', this._onTouchEnd);
    };

    updateValueDisplay() {
      const display = this.canvas.closest('.knob-group')?.querySelector('.knob-value');
      if (display) {
        const v = this.value;
        display.textContent = Math.abs(v) < 10 ? v.toFixed(2) : Math.round(v);
      }
    }
  }

  // ===== INIT KNOBS =====
  function makeKnob(id, options) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    canvas.width = 52;
    canvas.height = 52;
    return new Knob(canvas, options);
  }

  // ===== DRAW ADSR CURVE =====
  function drawADSR() {
    const canvas = document.getElementById('adsr-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const { attack, decay, sustain, release } = state.adsr;
    const total = attack + decay + 0.3 + release;
    const scaleX = w / total;
    const pad = 4;

    const ax = attack * scaleX;
    const dx = ax + decay * scaleX;
    const sx = dx + 0.3 * scaleX;
    const rx = sx + release * scaleX;

    const sustainY = h - pad - sustain * (h - pad * 2);

    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(ax, pad);
    ctx.lineTo(dx, sustainY);
    ctx.lineTo(sx, sustainY);
    ctx.lineTo(rx, h - pad);

    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Fill
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(233,69,96,0.3)');
    grad.addColorStop(1, 'rgba(233,69,96,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ===== SEQUENCER =====

  const seqState = {
    running: false,
    bpm: 120,
    steps: 16,
    currentStep: -1,
    pattern: Array.from({ length: 16 }, () => ({ active: false, note: 'C4' })),
  };

  const SEQ_BPM_MIN = 40;
  const SEQ_BPM_MAX = 240;
  const SEQ_BPM_STEP = 5;
  const SEQ_NOTE_CLEANUP_BUFFER = 0.3; // extra seconds before disposing Tone.js nodes

  let seqLoop = null;

  // Note list spanning C2–B5 for the step note selectors
  const SEQ_NOTES = [];
  for (let oct = 2; oct <= 5; oct++) {
    for (const name of ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']) {
      SEQ_NOTES.push(`${name}${oct}`);
    }
  }

  function buildSequencerGrid() {
    const grid = document.getElementById('seq-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 0; i < seqState.steps; i++) {
      const step = seqState.pattern[i];

      const cell = document.createElement('div');
      cell.className = 'seq-step';
      cell.dataset.step = i;

      const pad = document.createElement('button');
      pad.className = 'seq-step-pad';
      pad.dataset.step = i;
      pad.textContent = i + 1;
      pad.addEventListener('click', () => toggleSeqStep(i));

      const select = document.createElement('select');
      select.className = 'seq-note-select';
      select.dataset.step = i;
      SEQ_NOTES.forEach(note => {
        const opt = document.createElement('option');
        opt.value = note;
        opt.textContent = note;
        opt.selected = note === step.note;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        seqState.pattern[i].note = select.value;
      });

      cell.appendChild(pad);
      cell.appendChild(select);
      grid.appendChild(cell);
    }
  }

  function toggleSeqStep(i) {
    seqState.pattern[i].active = !seqState.pattern[i].active;
    const pad = document.querySelector(`.seq-step-pad[data-step="${i}"]`);
    const cell = document.querySelector(`.seq-step[data-step="${i}"]`);
    if (pad) pad.classList.toggle('active', seqState.pattern[i].active);
    if (cell) cell.classList.toggle('seq-step--active', seqState.pattern[i].active);
  }

  function updateSeqStepDisplay(stepIdx) {
    document.querySelectorAll('.seq-step-pad').forEach((pad, i) => {
      pad.classList.toggle('playing', i === stepIdx);
    });
  }

  // Trigger a single sequencer note using AudioContext-scheduled time
  function seqTriggerNote(note, time) {
    if (!filter) return;

    const freq = Tone.Frequency(note).toFrequency();
    const noteDur = Tone.Time('16n').toSeconds() * 0.8;

    const osc1 = new Tone.OmniOscillator({ type: state.waveform, frequency: freq, detune: 0 });

    const osc2Node = state.osc2.enabled
      ? new Tone.OmniOscillator({
          type: state.osc2.waveform,
          frequency: freq * Math.pow(2, state.osc2.octave) * Math.pow(2, state.osc2.detune / 1200),
          detune: state.osc2.detune,
        })
      : null;

    const env = new Tone.AmplitudeEnvelope({
      attack: state.adsr.attack,
      decay: state.adsr.decay,
      sustain: state.adsr.sustain,
      release: state.adsr.release,
    });

    const voiceGain = new Tone.Gain(osc2Node ? 0.5 : 1);

    osc1.connect(env);
    if (osc2Node) { osc2Node.connect(env); osc2Node.start(time); }
    env.connect(voiceGain);
    voiceGain.connect(filter);

    if (state.lfo.target === 'pitch' && lfoGain) {
      lfoGain.connect(osc1.detune);
      if (osc2Node) lfoGain.connect(osc2Node.detune);
    }

    osc1.start(time);
    env.triggerAttackRelease(noteDur, time);

    // Clean up nodes after the note finishes
    const cleanupMs = Math.max((time - Tone.now() + noteDur + state.adsr.release + SEQ_NOTE_CLEANUP_BUFFER) * 1000, 200);
    setTimeout(() => {
      try { osc1.stop(); osc1.disconnect(); } catch (e) { /* already disposed */ }
      try { if (osc2Node) { osc2Node.stop(); osc2Node.disconnect(); } } catch (e) { /* already disposed */ }
      try { env.disconnect(); } catch (e) { /* already disposed */ }
      try { voiceGain.disconnect(); } catch (e) { /* already disposed */ }
    }, cleanupMs);
  }

  function startSequencer() {
    if (!state.powered || seqState.running) return;

    Tone.Transport.bpm.value = seqState.bpm;

    const indices = Array.from({ length: seqState.steps }, (_, i) => i);
    seqLoop = new Tone.Sequence((time, stepIdx) => {
      // Store current step for UI polling
      seqState.currentStep = stepIdx;

      const step = seqState.pattern[stepIdx];
      if (step.active) {
        seqTriggerNote(step.note, time);
      }
    }, indices, '16n');

    seqLoop.start(0);
    Tone.Transport.start();
    seqState.running = true;

    // Poll current step for UI updates on each animation frame
    requestAnimationFrame(seqUILoop);

    const btn = document.getElementById('seq-play-btn');
    if (btn) { btn.textContent = '■ Stop'; btn.classList.add('active'); }
  }

  function stopSequencer() {
    if (seqLoop) {
      seqLoop.stop();
      seqLoop.dispose();
      seqLoop = null;
    }
    Tone.Transport.stop();
    Tone.Transport.cancel();

    seqState.running = false;
    seqState.currentStep = -1;
    updateSeqStepDisplay(-1);

    const btn = document.getElementById('seq-play-btn');
    if (btn) { btn.textContent = '▶ Play'; btn.classList.remove('active'); }
  }

  function seqUILoop() {
    if (!seqState.running) return;
    updateSeqStepDisplay(seqState.currentStep);
    requestAnimationFrame(seqUILoop);
  }

  // ===== VISUALIZER =====
  let animFrame;
  function startVisualizer() {
    const canvas = document.getElementById('visualizer');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function draw() {
      animFrame = requestAnimationFrame(draw);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (!analyser || !state.powered) {
        // draw flat line
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.strokeStyle = 'rgba(233,69,96,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        return;
      }

      const values = analyser.getValue();
      const sliceWidth = w / values.length;

      ctx.beginPath();
      for (let i = 0; i < values.length; i++) {
        const x = i * sliceWidth;
        const y = (values[i] + 1) / 2 * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#e94560');
      grad.addColorStop(0.5, '#f5a623');
      grad.addColorStop(1, '#e94560');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Glow
      ctx.shadowColor = '#e94560';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    draw();
  }

  // ===== PIANO KEYBOARD BUILDER =====
  const NOTES_IN_OCTAVE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK_NOTES = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);

  function buildPiano(octaves = [3, 4, 5]) {
    const container = document.getElementById('piano-keys');
    if (!container) return;
    container.innerHTML = '';

    for (const oct of octaves) {
      for (const noteName of NOTES_IN_OCTAVE) {
        const note = `${noteName}${oct}`;
        const isBlack = BLACK_NOTES.has(noteName);

        const key = document.createElement('div');
        key.className = `key ${isBlack ? 'black' : 'white'}`;
        key.dataset.note = note;

        if (!isBlack) {
          const label = document.createElement('span');
          label.className = 'key-note-label';
          label.textContent = noteName;
          key.appendChild(label);
        }

        key.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (!state.powered) { Tone.start(); initAudio(); return; }
          noteOn(note);
          key.classList.add('active');
        });

        key.addEventListener('mouseenter', (e) => {
          if (e.buttons === 1) {
            if (!state.powered) return;
            noteOn(note);
            key.classList.add('active');
          }
        });

        key.addEventListener('mouseup', () => {
          noteOff(note);
          key.classList.remove('active');
        });

        key.addEventListener('mouseleave', () => {
          noteOff(note);
          key.classList.remove('active');
        });

        key.addEventListener('touchstart', (e) => {
          e.preventDefault();
          if (!state.powered) { initAudio(); return; }
          noteOn(note);
          key.classList.add('active');
        }, { passive: false });

        key.addEventListener('touchend', (e) => {
          e.preventDefault();
          noteOff(note);
          key.classList.remove('active');
        });

        container.appendChild(key);
      }
    }
  }

  // ===== DOM READY =====
  document.addEventListener('DOMContentLoaded', () => {
    buildPiano([3, 4, 5]);

    // ===== POWER =====
    const powerBtn = document.getElementById('power-btn');
    powerBtn?.addEventListener('click', () => {
      if (!state.powered) {
        initAudio();
      } else {
        allNotesOff();
        stopSequencer();
        state.powered = false;
        updatePowerUI(false);
      }
    });

    // ===== WAVEFORM OSC1 =====
    document.querySelectorAll('.wave-btn[data-osc="1"]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.waveform = btn.dataset.wave;
        document.querySelectorAll('.wave-btn[data-osc="1"]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // ===== WAVEFORM OSC2 =====
    document.querySelectorAll('.wave-btn[data-osc="2"]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.osc2.waveform = btn.dataset.wave;
        document.querySelectorAll('.wave-btn[data-osc="2"]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // ===== OSC2 TOGGLE =====
    document.getElementById('osc2-toggle')?.addEventListener('click', function() {
      state.osc2.enabled = !state.osc2.enabled;
      this.classList.toggle('active', state.osc2.enabled);
      this.textContent = state.osc2.enabled ? 'ON' : 'OFF';
    });

    // ===== ADSR KNOBS =====
    const attackKnob = makeKnob('knob-attack', {
      min: 0.001, max: 4, value: state.adsr.attack, color: '#e94560',
      onChange: (v) => { state.adsr.attack = v; drawADSR(); }
    });
    const decayKnob = makeKnob('knob-decay', {
      min: 0.001, max: 4, value: state.adsr.decay, color: '#f5a623',
      onChange: (v) => { state.adsr.decay = v; drawADSR(); }
    });
    const sustainKnob = makeKnob('knob-sustain', {
      min: 0, max: 1, value: state.adsr.sustain, color: '#7ed321',
      onChange: (v) => { state.adsr.sustain = v; drawADSR(); }
    });
    const releaseKnob = makeKnob('knob-release', {
      min: 0.001, max: 8, value: state.adsr.release, color: '#4a90d9',
      onChange: (v) => { state.adsr.release = v; drawADSR(); }
    });

    // ===== FILTER KNOBS =====
    makeKnob('knob-filter-freq', {
      min: 20, max: 20000, value: state.filter.frequency, color: '#f5a623',
      onChange: (v) => {
        state.filter.frequency = v;
        if (filter) filter.frequency.rampTo(v, 0.05);
      }
    });

    makeKnob('knob-filter-q', {
      min: 0.1, max: 20, value: state.filter.Q, color: '#f5a623',
      onChange: (v) => {
        state.filter.Q = v;
        if (filter) filter.Q.value = v;
      }
    });

    // Filter type
    document.getElementById('filter-type')?.addEventListener('change', function() {
      state.filter.type = this.value;
      if (filter) filter.type = this.value;
    });

    // ===== LFO KNOBS =====
    makeKnob('knob-lfo-rate', {
      min: 0.01, max: 20, value: state.lfo.rate, color: '#bd10e0',
      onChange: (v) => {
        state.lfo.rate = v;
        if (lfo) lfo.frequency.value = v;
      }
    });

    makeKnob('knob-lfo-depth', {
      min: 0, max: 1, value: state.lfo.depth, color: '#bd10e0',
      onChange: (v) => {
        state.lfo.depth = v;
        if (lfoGain) lfoGain.gain.value = v * 2000;
      }
    });

    // LFO Target
    document.getElementById('lfo-target')?.addEventListener('change', function() {
      state.lfo.target = this.value;
      applyLfoTarget();
    });

    // ===== OSC2 KNOBS =====
    makeKnob('knob-osc2-detune', {
      min: -100, max: 100, value: 0, color: '#4a90d9',
      onChange: (v) => { state.osc2.detune = v; }
    });

    // ===== EFFECTS KNOBS =====
    makeKnob('knob-reverb', {
      min: 0, max: 1, value: 0, color: '#4a90d9',
      onChange: (v) => {
        state.effects.reverbWet = v;
        if (reverb) reverb.wet.value = v;
      }
    });

    makeKnob('knob-delay', {
      min: 0, max: 1, value: 0, color: '#4a90d9',
      onChange: (v) => {
        state.effects.delayWet = v;
        if (delay) delay.wet.value = v;
      }
    });

    makeKnob('knob-delay-time', {
      min: 0.01, max: 1, value: 0.25, color: '#f5a623',
      onChange: (v) => {
        state.effects.delayTime = v;
        if (delay) delay.delayTime.value = v;
      }
    });

    makeKnob('knob-chorus', {
      min: 0, max: 1, value: 0, color: '#7ed321',
      onChange: (v) => {
        state.effects.chorusWet = v;
        if (chorus) chorus.wet.value = v;
      }
    });

    // ===== MASTER VOLUME =====
    makeKnob('knob-volume', {
      min: -40, max: 0, value: state.masterVolume, color: '#e94560',
      onChange: (v) => {
        state.masterVolume = v;
        if (masterVol) masterVol.volume.value = v;
      }
    });

    // ===== OCTAVE CONTROLS =====
    document.getElementById('octave-down')?.addEventListener('click', () => {
      state.octave = Math.max(1, state.octave - 1);
      updateOctaveDisplay();
    });
    document.getElementById('octave-up')?.addEventListener('click', () => {
      state.octave = Math.min(7, state.octave + 1);
      updateOctaveDisplay();
    });

    // ===== PORTAMENTO =====
    makeKnob('knob-portamento', {
      min: 0, max: 1, value: 0, color: '#e94560',
      onChange: (v) => { state.portamento = v; }
    });

    // Initial draws
    drawADSR();
    startVisualizer();

    // ===== SEQUENCER SETUP =====
    buildSequencerGrid();

    document.getElementById('seq-play-btn')?.addEventListener('click', () => {
      if (!state.powered) {
        // Start audio then sequencer
        initAudio();
        return;
      }
      if (seqState.running) {
        stopSequencer();
      } else {
        startSequencer();
      }
    });

    document.getElementById('seq-bpm-down')?.addEventListener('click', () => {
      seqState.bpm = Math.max(SEQ_BPM_MIN, seqState.bpm - SEQ_BPM_STEP);
      document.getElementById('seq-bpm-display').textContent = seqState.bpm;
      if (seqState.running) Tone.Transport.bpm.value = seqState.bpm;
    });

    document.getElementById('seq-bpm-up')?.addEventListener('click', () => {
      seqState.bpm = Math.min(SEQ_BPM_MAX, seqState.bpm + SEQ_BPM_STEP);
      document.getElementById('seq-bpm-display').textContent = seqState.bpm;
      if (seqState.running) Tone.Transport.bpm.value = seqState.bpm;
    });

    document.getElementById('seq-clear-btn')?.addEventListener('click', () => {
      seqState.pattern.forEach((step, i) => {
        step.active = false;
        const pad = document.querySelector(`.seq-step-pad[data-step="${i}"]`);
        const cell = document.querySelector(`.seq-step[data-step="${i}"]`);
        if (pad) pad.classList.remove('active');
        if (cell) cell.classList.remove('seq-step--active');
      });
    });

    // Initialize knob value displays
    document.querySelectorAll('.knob-group').forEach(group => {
      const display = group.querySelector('.knob-value');
      const canvas = group.querySelector('canvas');
      if (display && canvas) {
        // values will be updated on first drag
      }
    });
  });

})();
