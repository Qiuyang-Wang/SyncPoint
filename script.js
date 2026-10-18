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
    a: { frequency: 110, duration: 0.42 },
    s: { frequency: 174.61, duration: 0.38 },
    d: { frequency: 261.63, duration: 0.34 },
    f: { frequency: 392, duration: 0.3 },
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

  let audioContext;
  let filterNode;
  let pannerNode;
  let roughGain;
  let noiseGain;
  let noiseBuffer;
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

    roughGain.connect(filterNode);
    noiseGain.connect(pannerNode);
    filterNode.connect(pannerNode);
    pannerNode.connect(masterGain);
    masterGain.gain.value = 1.2;
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
    roughGain.gain.setTargetAtTime(roughness * 0.65, now, 0.035);
    noiseGain.gain.setTargetAtTime(roughness * 0.5, now, 0.035);
  }
  async function playSound(key) {
    const settings = keySettings[key];
    if (!settings || !createAudioGraph()) return;

    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
        audioMessage.textContent = '';
      } catch (error) {
        audioMessage.textContent = 'Click a sound button to enable audio.';
        return;
      }
    }

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const voiceGain = audioContext.createGain();
    const roughOscillator = audioContext.createOscillator();
    const roughEnvelope = audioContext.createGain();
    const noise = audioContext.createBufferSource();
    const noiseEnvelope = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(settings.frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(55, settings.frequency * 0.72),
        now + settings.duration,
    );

    [voiceGain, roughEnvelope, noiseEnvelope].forEach(function (envelope) {
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(0.4, now + 0.018);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + settings.duration);
    });
    roughOscillator.type = 'sawtooth';
    roughOscillator.frequency.setValueAtTime(settings.frequency * 1.41, now);
    noise.buffer = noiseBuffer;
    noise.loop = true;

    oscillator.connect(voiceGain);
    voiceGain.connect(filterNode);
    roughOscillator.connect(roughEnvelope);
    roughEnvelope.connect(roughGain);
    noise.connect(noiseEnvelope);
    noiseEnvelope.connect(noiseGain);
    [oscillator, roughOscillator, noise].forEach(function (source) {
      source.start(now);
      source.stop(now + settings.duration + 0.02);
    });
    oscillator.onended = function () {
      [oscillator, roughOscillator, noise, voiceGain, roughEnvelope, noiseEnvelope].forEach(function (node) {
        node.disconnect();
      });
    };
  }

  function setButtonState(key, isActive) {
    const button = buttons.find((item) => item.dataset.key === key);
    if (button) button.classList.toggle('is-active', isActive);
  }

  function triggerKey(key) {
    if (!keySettings[key]) return;
    setButtonState(key, true);
    playSound(key);
  }

  function releaseKey(key) {
    if (!keySettings[key]) return;
    setButtonState(key, false);
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
    if (!event.repeat) triggerKey(key);
  });

  document.addEventListener('keyup', function (event) {
    releaseKey(event.key.toLowerCase());
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
  window.requestAnimationFrame(animateTarget);
})();
