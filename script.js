'use strict';
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
function mapPan(x) {
  return clamp(x, 0, 1) * 2 - 1;
}
function mapFilterFrequency(y) {
  const topFrequency = 12000;
  const bottomFrequency = 500;
  return topFrequency * Math.pow(bottomFrequency / topFrequency, clamp(y, 0, 1));
}
function mapStability(x, y, targetX = 0.5, targetY = 0.5, width = 1, height = 1) {
  const distanceX = (clamp(x, 0, 1) - targetX) * width;
  const distanceY = (clamp(y, 0, 1) - targetY) * height;
  const distance = Math.hypot(distanceX, distanceY);

  const noisyDistance = Math.min(width, height) * 0.7;
  return clamp(1 - distance / noisyDistance, 0, 1);
}
function getSpatialValues(clientX, clientY, rect, targetX = 0.5, targetY = 0.5) {
  const x = clamp((clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((clientY - rect.top) / rect.height, 0, 1);

  return {
    x,
    y,
    pan: mapPan(x),
    filterFrequency: mapFilterFrequency(y),
    stability: mapStability(x, y, targetX, targetY, rect.width, rect.height),
  };
}

const SpatialMapping = { clamp, mapPan, mapFilterFrequency, mapStability, getSpatialValues };

if (typeof window !== 'undefined') window.SpatialMapping = SpatialMapping;
if (typeof module !== 'undefined') module.exports = SpatialMapping;

(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  const keySettings = {
    a: { file: 'assets/audio/c-major.wav' },
    s: { file: 'assets/audio/d-major.wav' },
    d: { file: 'assets/audio/f-major.wav' },
    f: { file: 'assets/audio/g-major.wav' },
  };

  const buttons = Array.from(document.querySelectorAll('.sound-key'));
  const spatialField = document.querySelector('.spatial-field');
  const inputMode = spatialField.dataset.inputMode || 'hover';
  const idleLabels = {
    hover: 'Move to control',
    click: 'Click to control',
    drag: 'Hold and drag',
  };
  let isDragging = false;
  const spatialStatus = document.querySelector('.spatial-status');
  const cursorDot = document.querySelector('.cursor-dot');
  const waveform = document.querySelector('.waveform');
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let wavePhase = 0;
  let lastFrameTime = performance.now();
  const syncStatus = document.querySelector('.sync-status');
  const audioMessage = document.querySelector('.audio-message');
  const targetDot = document.querySelector('.target');
  const target = { x: 0.5, y: 0.5 };
  const pointer = { clientX: 0, clientY: 0, inside: false };
  let journeyStart = { ...target };
  let destination = randomDestination();
  let journeyStartedAt = performance.now();
  let journeyDuration = 2800;
  const rhythmLines = Array.from(document.querySelectorAll('.rhythm-line'));
  const rhythmStatus = document.querySelector('.rhythm-status');
  const cooperationRing = document.querySelector('.cooperation-ring');
  const holdMessage = document.querySelector('.hold-message');
  const resultOverlay = document.querySelector('.result-overlay');
  const resultText = document.querySelector('.result-text');
  const pressedKeys = new Set();
  const buttonTimers = {};
  let rhythmHistory = [];
  let playerARhythmStable = false;
  let playerBStable = false;
  let ringProgress = 0;
  let stableStartTime = null;
  let isFinalHold = false;
  let finalHoldStartedAt = null;
  let finalHoldFailed = false;
  let resultActive = false;
  let resultStartedAt = null;

  let audioContext;
  let filterNode;
  let pannerNode;
  let roughGain;
  let noiseGain;
  let noiseBuffer;
  let distortionNode;
  const chordBuffers = {};
  const activeVoices = [];
  let currentSpatialValues = {
    pan: 0,
    filterFrequency: 12000,
    stability: 0,
  };
  function createAudioGraph() {
    if (audioContext) return true;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      audioMessage.textContent = 'Audio is not supported in this browser.';
      return false;
    }

    audioContext = new AudioContextClass();
    filterNode = audioContext.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.Q.value = 0.7;

    pannerNode = audioContext.createStereoPanner();
    const masterGain = audioContext.createGain();
    roughGain = audioContext.createGain();
    noiseGain = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    distortionNode = audioContext.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = Math.tanh(x * 5);
    }
    distortionNode.curve = curve;
    distortionNode.connect(roughGain);
    roughGain.connect(filterNode);
    noiseGain.connect(pannerNode);
    filterNode.connect(pannerNode);
    pannerNode.connect(masterGain);
    masterGain.gain.value = 0.65;
    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);

    noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.random() * 2 - 1;
    }
    applyAudioState();

    return true;
  }
  function applyAudioState() {
    if (!audioContext) return;

    const now = audioContext.currentTime;
    pannerNode.pan.setTargetAtTime(currentSpatialValues.pan, now, 0.025);
    filterNode.frequency.setTargetAtTime(currentSpatialValues.filterFrequency, now, 0.025);
    const roughness = Math.pow(1 - currentSpatialValues.stability, 1.4);
    roughGain.gain.setTargetAtTime(roughness * 0.35, now, 0.035);
    noiseGain.gain.setTargetAtTime(roughness * 0.16, now, 0.035);
  }
  async function loadChords() {
    if (!createAudioGraph()) return;
    audioMessage.textContent = 'Loading chords…';
    try {
      await Promise.all(Object.keys(keySettings).map(async function (key) {
        const encoded = window.chordAudioData[keySettings[key].file];
        if (!encoded) throw new Error('Missing chord');
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        chordBuffers[key] = await audioContext.decodeAudioData(bytes.buffer);
      }));
      audioMessage.textContent = '';
    } catch (error) {
      audioMessage.textContent = 'Could not load chords. Check assets/audio/chords.js.';
    }
  }

  async function playSound(key) {
    if (!audioContext || !chordBuffers[key]) return;
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch (error) {
        audioMessage.textContent = 'Click a chord to enable audio.';
        return;
      }
    }

    const now = audioContext.currentTime;
    const duration = Math.min(2.6, chordBuffers[key].duration);
    const source = audioContext.createBufferSource();
    const voiceGain = audioContext.createGain();
    const noise = audioContext.createBufferSource();
    const noiseEnvelope = audioContext.createGain();
    source.buffer = chordBuffers[key];
    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(0.5, now + 0.005);
    voiceGain.gain.setValueAtTime(0.5, now + Math.max(0.005, duration - 0.15));
    voiceGain.gain.linearRampToValueAtTime(0, now + duration);
    source.connect(voiceGain);
    voiceGain.connect(filterNode);
    voiceGain.connect(distortionNode);

    noise.buffer = noiseBuffer;
    noise.loop = true;
    noiseEnvelope.gain.setValueAtTime(0, now);
    noiseEnvelope.gain.linearRampToValueAtTime(0.08, now + 0.018);
    noiseEnvelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    noise.connect(noiseEnvelope);
    noiseEnvelope.connect(noiseGain);

    if (activeVoices.length >= 12) {
      const oldest = activeVoices.shift();
      oldest.gain.cancelScheduledValues(now);
      oldest.gain.setTargetAtTime(0, now, 0.01);
      oldest.source.stop(now + 0.05);
    }
    const voice = { source, gain: voiceGain.gain };
    activeVoices.push(voice);
    source.start(now);
    source.stop(now + duration);
    noise.start(now);
    noise.stop(now + 0.36);
    noise.onended = function () {
      noise.disconnect();
      noiseEnvelope.disconnect();
    };
    source.onended = function () {
      const index = activeVoices.indexOf(voice);
      if (index !== -1) activeVoices.splice(index, 1);
      source.disconnect();
      voiceGain.disconnect();
    };
  }

  function setButtonState(key, isActive) {
    const button = buttons.find((item) => item.dataset.key === key);
    if (button) button.classList.toggle('is-active', isActive);
  }

  function triggerKey(key) {
    if (!keySettings[key]) return;
    setButtonState(key, true);
    window.clearTimeout(buttonTimers[key]);
    buttonTimers[key] = window.setTimeout(function () { setButtonState(key, false); }, 140);
    playSound(key);

    const lane = document.querySelector(`.rhythm-lane[data-key="${key}"] .lane-beams`);
    const beam = document.createElement('span');
    beam.className = 'lane-beam';
    lane.appendChild(beam);
    window.setTimeout(function () { beam.remove(); }, 420);

    const time = performance.now();
    rhythmHistory.push({ key, time });
    rhythmHistory = rhythmHistory.slice(-6);
    drawRhythmHistory();
    updateCooperation(time);
  }

  function releaseKey(key) {
    if (!keySettings[key]) return;
    pressedKeys.delete(key);
    setButtonState(key, false);
  }

  function drawRhythmHistory() {
    rhythmLines.forEach(function (line) { line.replaceChildren(); });
    const first = rhythmHistory[0].time;
    const span = rhythmHistory[rhythmHistory.length - 1].time - first;
    rhythmHistory.forEach(function (press) {
      const dot = document.createElement('span');
      dot.className = 'rhythm-dot';
      dot.style.left = `${span > 0 ? (press.time - first) / span * 100 : 50}%`;
      dot.setAttribute('aria-hidden', 'true');
      rhythmLines.find(line => line.dataset.key === press.key).appendChild(dot);
    });
  }

  function checkRhythm(time) {
    if (rhythmHistory.length < 6) return false;
    const intervals = [];
    for (let i = 1; i < rhythmHistory.length; i++) {
      intervals.push(rhythmHistory[i].time - rhythmHistory[i - 1].time);
    }
    const average = intervals.reduce((total, gap) => total + gap, 0) / intervals.length;
    if (average < 180 || average > 1600 || intervals.some(gap => gap > 2200)) return false;
    const difference = intervals.reduce((total, gap) => total + Math.abs(gap - average), 0) / intervals.length;
    const pauseLimit = clamp(average * 1.8, 650, 2200);
    return difference / average <= 0.28 && time - rhythmHistory[5].time <= pauseLimit;
  }

  function resetCooperation() {
    ringProgress = 0;
    stableStartTime = null;
    isFinalHold = false;
    finalHoldStartedAt = null;
    finalHoldFailed = false;
    resultActive = false;
    resultStartedAt = null;
    resultOverlay.hidden = true;
    resultOverlay.classList.remove('is-perfect');
    holdMessage.textContent = '';
    cooperationRing.classList.remove('is-flashing');
    cooperationRing.style.setProperty('--progress', '0turn');
  }

  function updateCooperation(time) {
    playerARhythmStable = checkRhythm(time);
    const label = playerARhythmStable ? 'Rhythm stable' : 'Keep a steady rhythm';
    if (rhythmStatus.textContent !== label) rhythmStatus.textContent = label;
    playerBStable = pointer.inside && currentSpatialValues.stability >= 0.7;
    const bothStable = playerARhythmStable && playerBStable && !document.hidden;

    if (resultActive) {
      if (time - resultStartedAt >= 2000) resetCooperation();
      return;
    }

    if (isFinalHold) {
      if (!bothStable) finalHoldFailed = true;
      if (time - finalHoldStartedAt >= 2000) {
        resultActive = true;
        resultStartedAt = time;
        resultText.textContent = finalHoldFailed ? 'Try Again' : 'Perfect';
        resultOverlay.classList.toggle('is-perfect', !finalHoldFailed);
        resultOverlay.hidden = false;
      }
      return;
    }

    if (bothStable) {
      if (stableStartTime === null) stableStartTime = time;
      ringProgress = Math.min((time - stableStartTime) / 8000, 1);
      if (ringProgress >= 1) {
        isFinalHold = true;
        finalHoldStartedAt = time;
        finalHoldFailed = false;
        holdMessage.textContent = 'Maintain Stability!!';
        cooperationRing.classList.add('is-flashing');
      }
    } else {
      stableStartTime = null;
      ringProgress = 0;
    }
    cooperationRing.style.setProperty('--progress', `${ringProgress}turn`);
  }

  function getStabilityLabel(stability) {
    if (stability >= 0.8) return 'Calm';
    if (stability >= 0.4) return 'Rough';
    return 'Noisy';
  }
  function updateSpatialInput(event) {
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.inside = true;
    updateSharedState();
  }
  function updateSharedState() {
    const rect = spatialField.getBoundingClientRect();
    const values = window.SpatialMapping.getSpatialValues(
        pointer.clientX, pointer.clientY, rect, target.x, target.y,
    );
    if (!pointer.inside) {
      values.pan = currentSpatialValues.pan;
      values.filterFrequency = currentSpatialValues.filterFrequency;
      values.stability = 0;
    }
    currentSpatialValues = values;

    spatialField.classList.toggle('is-active', pointer.inside);
    cursorDot.style.left = `${values.x * 100}%`;
    cursorDot.style.top = `${values.y * 100}%`;

    const stabilityLabel = getStabilityLabel(values.stability);
    if (syncStatus.textContent !== stabilityLabel) syncStatus.textContent = stabilityLabel;
    const inputLabel = pointer.inside ? 'Input active' : idleLabels[inputMode];
    if (spatialStatus.textContent !== inputLabel) spatialStatus.textContent = inputLabel;

    updateFeedback(values.stability);

    applyAudioState();
    updateCooperation(performance.now());
  }
  function updateFeedback(stability) {
    const roughness = 1 - stability;
    const amplitude = 4 + 14 * roughness;
    const phase = reducedMotion.matches ? 0 : wavePhase;
    let path = '';
    for (let x = 16; x <= 104; x += 2) {
      const position = (x - 16) / 88 * Math.PI * 2;
      const y = 60 + amplitude * Math.sin(position - phase)
          + 5 * roughness * Math.sin(3 * position + 2 * phase);
      path += `${x === 16 ? 'M' : 'L'} ${x} ${y.toFixed(2)} `;
    }
    waveform.setAttribute('d', path.trim());
  }

  function randomDestination() {
    return { x: 0.12 + Math.random() * 0.76, y: 0.12 + Math.random() * 0.76 };
  }
  function animateTarget(time) {
    const elapsed = Math.min(0.05, Math.max(0, (time - lastFrameTime) / 1000));
    lastFrameTime = time;
    if (!reducedMotion.matches) {
      const speed = 1.2 + 3 * (1 - currentSpatialValues.stability);
      wavePhase = (wavePhase + elapsed * speed) % (Math.PI * 2);
    }
    const progress = Math.min(1, (time - journeyStartedAt) / journeyDuration);
    const eased = progress * progress * (3 - 2 * progress);
    target.x = journeyStart.x + (destination.x - journeyStart.x) * eased;
    target.y = journeyStart.y + (destination.y - journeyStart.y) * eased;
    targetDot.style.left = `${target.x * 100}%`;
    targetDot.style.top = `${target.y * 100}%`;

    if (progress >= 1) {
      journeyStart = { ...target };
      destination = randomDestination();
      journeyStartedAt = time;
      journeyDuration = 2000 + Math.random() * 1800;
    }
    updateSharedState();
    window.requestAnimationFrame(animateTarget);
  }

  document.addEventListener('keydown', function (event) {
    const key = event.key.toLowerCase();
    if (!keySettings[key]) return;

    event.preventDefault();
    if (event.repeat || pressedKeys.has(key)) return;
    pressedKeys.add(key);
    triggerKey(key);
  });

  document.addEventListener('keyup', function (event) {
    releaseKey(event.key.toLowerCase());
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      pointer.inside = false;
      if (isFinalHold) finalHoldFailed = true;
      else stableStartTime = null;
      updateSharedState();
    }
  });

  window.addEventListener('blur', function () {
    Object.keys(keySettings).forEach(releaseKey);
    isDragging = false;
    pointer.inside = false;
    updateSharedState();
  });
  buttons.forEach(function (button) {
    const key = button.dataset.key;

    button.addEventListener('mousedown', function (event) {
      if (event.button > 0) return;
      event.preventDefault();
      triggerKey(key);
    });
    button.addEventListener('mouseup', function () {
      releaseKey(key);
    });
    button.addEventListener('mouseleave', function () {
      releaseKey(key);
    });
    button.addEventListener('click', function (event) {
      if (event.detail === 0) {
        triggerKey(key);
        window.setTimeout(function () {
          releaseKey(key);
        }, 120);
      }
    });
  });
  spatialField.addEventListener('mousemove', function (event) {
    if (inputMode === 'hover') updateSpatialInput(event);
  });
  window.addEventListener('mousemove', function (event) {
    if (inputMode !== 'drag' || !isDragging) return;
    if (event.buttons === 0) {
      stopDragging();
      return;
    }
    updateSpatialInput(event);
  });
  spatialField.addEventListener('mouseenter', function (event) {
    if (inputMode === 'hover') updateSpatialInput(event);
  });
  spatialField.addEventListener('mouseleave', function () {
    if (inputMode === 'hover') {
      pointer.inside = false;
      updateSharedState();
    }
  });
  spatialField.addEventListener('click', function (event) {
    if (inputMode === 'click' && event.button === 0) updateSpatialInput(event);
  });
  spatialField.addEventListener('mousedown', function (event) {
    if (inputMode !== 'drag' || event.button !== 0 || isDragging) return;
    event.preventDefault();
    isDragging = true;
    updateSpatialInput(event);
  });
  function stopDragging() {
    if (!isDragging) return;
    isDragging = false;
    pointer.inside = false;
    updateSharedState();
  }
  window.addEventListener('mouseup', function (event) {
    if (event.button !== 0) return;
    stopDragging();
    Object.keys(keySettings).forEach(releaseKey);
  });
  loadChords();
  window.requestAnimationFrame(animateTarget);
})();
