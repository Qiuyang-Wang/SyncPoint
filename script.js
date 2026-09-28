'use strict';

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

// By mapping the left and right positions to the left and right channels, the spatial direction of the mouse cursor can be aligned with the direction of the sound heard.
// The centre position corresponds to a stereo image of 0, ensuring that the centre is not biased towards either side.
function mapPan(x) {
  return clamp(x, 0, 1) * 2 - 1;
}

// Here, a frequency mapping that varies proportionally is used, allowing sufficient headroom for adjustments at lower frequencies.
// By preserving more high frequencies at the top and attenuating them at the bottom, vertical movement results in a change in timbre.
function mapFilterFrequency(y) {
  const topFrequency = 12000;
  const bottomFrequency = 500;
  return topFrequency * Math.pow(bottomFrequency / topFrequency, clamp(y, 0, 1));
}

// Here, ‘stability’ indicates how close the current position is to the target.
// First, convert the horizontal and vertical distances back to pixels, then calculate the actual distance, to prevent the same distance of movement within a rectangular area from being scored inconsistently.
// When the distance reaches 70 per cent of the shorter side, the stability drops to 0; this ensures that players can hear a noticeable difference without having to move to the furthest corner.
function mapStability(x, y, targetX = 0.5, targetY = 0.5, width = 1, height = 1) {
  const distanceX = (clamp(x, 0, 1) - targetX) * width;
  const distanceY = (clamp(y, 0, 1) - targetY) * height;
  const distance = Math.hypot(distanceX, distanceY);

  const noisyDistance = Math.min(width, height) * 0.7;
  return clamp(1 - distance / noisyDistance, 0, 1);
}

// Both the mouse coordinates and the region boundaries are relative to the browser viewport; the position within the region is obtained by subtracting the viewport coordinates from the mouse coordinates.
// These values are then divided by the width and height to convert the X and Y values to a range of 0 to 1, allowing the same sound mapping to be used across different window sizes.
// Restricting the numerical range prevents invalid sound imaging or filter parameters from being generated when the mouse is dragged outside the boundaries.
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
  const syncPoint = document.querySelector('.sync-point');
  const feedbackType = document.querySelector('.sync-display').dataset.feedback;
  const progressFill = document.querySelector('.progress-fill');
  const progressHand = document.querySelector('.progress-hand');
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

  // The four short notes share the same filter and panning nodes, allowing a single position adjustment by Player B to affect different keys played by Player A.
  // Pure tones, dissonant notes and noise are connected separately, making it easier to control the level of roughness using stability; the compressor is used to limit peaks when multiple sounds are layered.
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

  // The same set of spatial data influences both sound and visuals, creating a correlation between the level of detail the player sees and the sense of roughness they hear.
  // Here, parameters are updated using very short, smooth transitions to minimise sudden auditory jumps when the mouse is moved rapidly.
  // The lower the stability, the more dissonance and noise are introduced; roughness is enhanced through mixing.
  function applyAudioState() {
    if (!audioContext) return;

    const now = audioContext.currentTime;
    pannerNode.pan.setTargetAtTime(currentSpatialValues.pan, now, 0.025);
    filterNode.frequency.setTargetAtTime(currentSpatialValues.filterFrequency, now, 0.025);
    const roughness = Math.pow(1 - currentSpatialValues.stability, 1.4);
    roughGain.gain.setTargetAtTime(roughness * 0.65, now, 0.035);
    noiseGain.gain.setTargetAtTime(roughness * 0.5, now, 0.035);
  }

  // Sound is triggered actively by pressing a key or clicking, restoring an audio environment that can be paused by the browser.
  // Each trigger uses a brief attack and decay, allowing Player A to set the rhythm.
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

  // Pass the coordinates immediately after every valid movement, so that mouse input affects the shared state in real time.
  // The coordinates are not only used for the red dot to follow; subsequent updates will also pass them to the sound mapping.
  function updateSpatialInput(event) {
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.inside = true;
    updateSharedState();
  }

  // Here, I first calculate a stability value, then apply the result to the shared graphic, status text and sound, to avoid the three types of feedback using different criteria.
  // When the mouse leaves the area, the stability value is set to 0, whilst retaining the audio position and filter position, to prevent the left and right directions from suddenly jumping back to the centre upon exiting the area.
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

  // 2C retains a subtle waveform when stable, whilst increasing the amplitude and superimposing finer fluctuations when unstable, echoing the rough texture of the sound.
  // Three graphic variants are retained here; select one of them from the ‘Feedback Types’ section on this page.
  function updateFeedback(stability) {
    if (feedbackType === 'size') {
      const diameter = 24 + 96 * stability;
      syncPoint.style.width = `${diameter}px`;
      syncPoint.style.height = `${diameter}px`;
    } else if (feedbackType === 'ring') {
      progressFill.style.strokeDashoffset = `${100 * (1 - stability)}`;
      progressHand.setAttribute('transform', `rotate(${360 * stability} 60 60)`);
    } else if (feedbackType === 'wave') {
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
  }

  function randomDestination() {
    return { x: 0.12 + Math.random() * 0.76, y: 0.12 + Math.random() * 0.76 };
  }

  // The target moves slowly, requiring Player B to constantly observe and adjust, rather than simply staying in one position once it has been found.
  // Even if the mouse is temporarily stationary, the distance must be recalculated frame by frame, as the target may have moved from its original position.
  // The speed at which the waveform moves also varies with stability.
  function animateTarget(time) {
    const elapsed = Math.min(0.05, Math.max(0, (time - lastFrameTime) / 1000));
    lastFrameTime = time;
    if (feedbackType === 'wave' && !reducedMotion.matches) {
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

  // Clear the ‘pressed’ and ‘dragged’ states when the window loses focus, to prevent buttons or red dots from still being treated as held down after switching windows.
  window.addEventListener('blur', function () {
    Object.keys(keySettings).forEach(releaseKey);
    isDragging = false;
    pointer.inside = false;
    updateSharedState();
  });

  // On-screen buttons and keyboard inputs use the same sound logic, ensuring consistent feedback across both methods of interaction.
  // A sound is played immediately when the mouse button is pressed; the `click` event only handles non-mouse inputs (such as keyboard presses) to prevent a sound from being played twice for the same mouse click.
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

  // For information on using mouse events, see the MDN documentation on `mousemove`
  // Continuously reads the X and Y coordinates as the mouse moves; no button needs to be held down.
  spatialField.addEventListener('mousemove', function (event) {
    if (inputMode === 'hover') updateSpatialInput(event);
  });
  // The drag event handler is attached to the window so that the position can still be updated after the mouse leaves the grid, whilst the coordinate constraints ensure the red dot remains within the boundaries.
  // If the mouse button has already been released, the drag event is terminated promptly to prevent the red dot from continuing to follow the mouse after the button has been released.
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
  // This branch is intended for click mode only; the current mode on this page will not update the spatial position via a click.
  spatialField.addEventListener('click', function (event) {
    if (inputMode === 'click' && event.button === 0) updateSpatialInput(event);
  });
  // This branch is reserved for drag mode; the current hover mode will not be entered.
  spatialField.addEventListener('mousedown', function (event) {
    if (inputMode !== 'drag' || event.button !== 0 || isDragging) return;
    event.preventDefault();
    isDragging = true;
    updateSpatialInput(event);
  });

  // In drag mode, continuous input stops when the mouse button is released, whilst in hover mode, the input state is controlled by entering and leaving the area.
  function stopDragging() {
    if (!isDragging) return;
    isDragging = false;
    pointer.inside = false;
    updateSharedState();
  }

  // Handle the left-click release on the window; this will end the current operation even if the mouse is outside the grid or button.
  // At the same time, clear the visual state of the button to prevent it from appearing as if it is still pressed after the click has been released.
  window.addEventListener('mouseup', function (event) {
    if (event.button !== 0) return;
    stopDragging();
    Object.keys(keySettings).forEach(releaseKey);
  });
  window.requestAnimationFrame(animateTarget);
})();


