// 此脚本统一组织映射、声音和反馈

'use strict';
// Constrain the value to a given range. Even when the mouse moves outside the grid, the coordinates remain within the valid interval.
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
// "Pan" refers to the stereo sound image. Its horizontal coordinate ranges from 0 to 1, which maps to a range of -1 to 1, representing the left and right channels.
function mapPan(x) {
  return clamp(x, 0, 1) * 2 - 1;
}
//The upper and lower positions control the cutoff frequency of the filter. The upper ones retain more high frequencies, and the lower ones have a darker tone.
// What is changed here is the filter brightness, and the playback pitch of the chord sample remains at the original value.
function mapFilterFrequency(y) {
  const topFrequency = 12000;
  const bottomFrequency = 500;
  return topFrequency * Math.pow(bottomFrequency / topFrequency, clamp(y, 0, 1));
}

// Here, ‘stability’ refers to the distance between the mouse and the target.
// The horizontal and vertical distances are first converted to pixels, then scaled according to the shorter side of the grid.
function mapStability(x, y, targetX = 0.5, targetY = 0.5, width = 1, height = 1) {
  const distanceX = (clamp(x, 0, 1) - targetX) * width;
  const distanceY = (clamp(y, 0, 1) - targetY) * height;
  const distance = Math.hypot(distanceX, distanceY);

  const noisyDistance = Math.min(width, height) * 0.7;
  return clamp(1 - distance / noisyDistance, 0, 1);
}
// clientX and clientY are window coordinates, and fieldBounds is the bounding shape of the grid.<\n\
// Subtracting the position of the grid’s top-left corner yields the relative coordinates within the grid.
function getSpatialValues(clientX, clientY, fieldBounds, targetX = 0.5, targetY = 0.5) {
  const x = clamp((clientX - fieldBounds.left) / fieldBounds.width, 0, 1);
  const y = clamp((clientY - fieldBounds.top) / fieldBounds.height, 0, 1);


  return {
    x,
    y,
    pan: mapPan(x),
    filterFrequency: mapFilterFrequency(y),
    stability: mapStability(x, y, targetX, targetY, fieldBounds.width, fieldBounds.height),
  };
}


// Consolidate the spatial mapping functions into a single object for use by pages and checks.
const spatialMapping = { clamp, mapPan, mapFilterFrequency, mapStability, getSpatialValues };

if (typeof window !== 'undefined') window.spatialMapping = spatialMapping;
if (typeof module !== 'undefined') module.exports = spatialMapping;

// Use a separate scope to store the interface state, thereby preventing variables from entering the global scope directly.
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  // The button names correspond to the file paths for the chords. The same paths are also used for the audio data in chordAudioData.js.
  const keySettings = {
    a: { file: 'assets/audio/c-major.wav' },
    s: { file: 'assets/audio/d-major.wav' },
    d: { file: 'assets/audio/f-major.wav' },
    f: { file: 'assets/audio/g-major.wav' },
  };


  // First, retrieve the page elements required for interaction, then save the current state.
  // The Guide pop-up, sound buttons and spatial grid each have their own corresponding event handlers.
  const soundButtons = Array.from(document.querySelectorAll('.soundKey'));
  const guideDialog = document.querySelector('.guideDialog');
  const guideButton = document.querySelector('.guideButton');
  const guideCloseButton = document.querySelector('.guideClose');
  const spatialField = document.querySelector('.spatialField');

  // inputMode reads the input mode specified in the HTML; the current page uses the ‘hover’ mode.
  // The subsequent ‘click’ and ‘drag’ branches follow the structure of the earlier prototype.
  const inputMode = spatialField.dataset.inputMode || 'hover';
  let isDragging = false;
  const cursorDot = document.querySelector('.cursorDot');

  // Retain the element queries from the early ‘dot’ and ‘pointer feedback’ branches; the current page uses only the ‘wave’ branch.
  const syncPoint = document.querySelector('.syncPoint');
  const feedbackType = document.querySelector('.syncDisplay').dataset.feedback;
  const progressFill = document.querySelector('.progressFill');
  const progressHand = document.querySelector('.progressHand');
  const waveform = document.querySelector('.waveform');

  // The system reads the preference for reduced motion effects, and the waveform phase will be adjusted accordingly to determine whether it should be shifted.
  const reducedMotionQuery = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };
  let wavePhase = 0;
  let lastFrameTime = performance.now();
  const audioMessage = document.querySelector('.audioMessage');
  const targetDot = document.querySelector('.target');

  // `target` stores the destination point, and `pointer` stores the mouse input.
  // A journey begins at `journeyStart` and ends at `destination`.
  const target = { x: 0.5, y: 0.5 };
  const pointer = { clientX: 0, clientY: 0, inside: false };
  let journeyStart = { ...target };
  let destination = chooseRandomDestination();
  let journeyStartedAt = performance.now();
  let journeyDuration = 2800;

  // In this set, link the rhythm recordings, the rings and the result prompts.
  const rhythmLines = Array.from(document.querySelectorAll('.rhythmLine'));
  const cooperationRing = document.querySelector('.cooperationRing');
  const holdMessage = document.querySelector('.holdMessage');
  const resultOverlay = document.querySelector('.resultOverlay');
  const resultText = document.querySelector('.resultText');

  // `pressedKeys` records keys that have not yet been released, whilst `buttonTimers` stores the visual feedback timers for each key.
  const pressedKeys = new Set();
  const buttonTimers = {};


  // The rhythm history only retains the last six valid entries.
  // Record the start times for ring-filling, hold and result display respectively.
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

  // Audio nodes are reused after their initialisation. Each key press creates a new, independent playback voice.
  // chordBuffers stores the decoded chords, whilst activeVoices records the voices currently being played.
  let audioContext;
  let filterNode;
  let pannerNode;
  let distortionGain;
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
  // Create a shared audio processing path. The clean signal and the distorted signal are routed into the filter node, whilst the noise is routed in from the panning node.
  // The combined signal then passes through the master volume and compressor before being output.
  function createAudioGraph() {
    if (audioContext) return true;

    const audioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!audioContextConstructor) {
      audioMessage.textContent = 'Audio is not supported in this browser.';
      return false;
    }


    audioContext = new audioContextConstructor();
    filterNode = audioContext.createBiquadFilter();
    filterNode.type = 'lowpass';
    // Q is a resonance parameter of the filter, which affects the response near the cut-off frequency.
    filterNode.Q.value = 0.7;

    pannerNode = audioContext.createStereoPanner();
    const masterGain = audioContext.createGain();
    distortionGain = audioContext.createGain();
    noiseGain = audioContext.createGain();
    // A compressor reduces the gain of stronger signals and controls output peaks when multiple notes overlap.
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;


    // The hyperbolic tangent curve constrains the amplitude to a finite range, creating a distortion layer.
    // The further Player B is from the target, the greater the amount of this layer is mixed in.
    distortionNode = audioContext.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = Math.tanh(x * 5);
    }
    distortionNode.curve = curve;
    distortionNode.connect(distortionGain);
    distortionGain.connect(filterNode);
    noiseGain.connect(pannerNode);
    filterNode.connect(pannerNode);
    pannerNode.connect(masterGain);
    masterGain.gain.value = 0.65;
    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);


    // Generate a segment of noise data using random numbers, to be used as the short noise layer for each chord.
    noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.random() * 2 - 1;
    }
    applyAudioState();

    return true;
  }

  // Simultaneously control panning, filtering and roughness for the same set of spatial data.
  // Apply short transition times to the parameters to minimise sudden changes in sound when moving the mouse.
  function applyAudioState() {
    if (!audioContext) return;

    const now = audioContext.currentTime;
    pannerNode.pan.setTargetAtTime(currentSpatialValues.pan, now, 0.025);
    filterNode.frequency.setTargetAtTime(currentSpatialValues.filterFrequency, now, 0.025);
    const roughness = Math.pow(1 - currentSpatialValues.stability, 1.4);
    distortionGain.gain.setTargetAtTime(roughness * 0.35, now, 0.035);
    noiseGain.gain.setTargetAtTime(roughness * 0.16, now, 0.035);
  }

  // Convert the Base64 text data back to bytes, then decode it into an audio buffer.
  // Supports opening pages directly from a folder, preventing the issue of no sound after downloading to the desktop.
  async function loadChords() {
    if (!createAudioGraph()) return;
    audioMessage.textContent = 'Loading chords…';
    try {
      await Promise.all(Object.keys(keySettings).map(async function (key) {
        const encodedChordData = window.chordAudioData[keySettings[key].file];
        if (!encodedChordData) throw new Error('Missing chord');
        const audioBytes = Uint8Array.from(
            atob(encodedChordData),
            character => character.charCodeAt(0),
        );
        chordBuffers[key] = await audioContext.decodeAudioData(audioBytes.buffer);
      }));
      audioMessage.textContent = '';
    } catch (error) {
      audioMessage.textContent = 'Could not load chords. Check assets/audio/chordAudioData.js.';
    }
  }



  // The browser restores the audio environment following user interaction. A new sound source is used each time it is triggered, and chords may be played simultaneously.
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
    // Each part plays for a maximum of 2.6 seconds. Separate volume envelopes control the attack and decay.
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


    // The noise occurs only for a brief period after the onset of the sound, and the extent to which it is mixed in is controlled by the stability of the shared signal.
    noise.buffer = noiseBuffer;
    noise.loop = true;
    noiseEnvelope.gain.setValueAtTime(0, now);
    noiseEnvelope.gain.linearRampToValueAtTime(0.08, now + 0.018);
    noiseEnvelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    noise.connect(noiseEnvelope);
    noiseEnvelope.connect(noiseGain);

    // A maximum of twelve active tracks can be recorded. When the limit is reached, the oldest track is removed from the recording and faded out over 50 milliseconds.
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
    // Once the sound source has finished, disconnect the corresponding node and remove the record for the finished part.
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

  // Use the same activity state class to link keyboard input to the button’s appearance.
  function setButtonState(key, isActive) {
    const button = soundButtons.find((item) => item.dataset.key === key);
    if (button) button.classList.toggle('isActive', isActive);
  }

  // A single valid input updates the sound, light beams and rhythm track simultaneously.
  // Each light beam uses a separate element, and each completes its animation when the button is pressed repeatedly.
  function triggerKey(key) {
    if (!keySettings[key] || guideDialog.open) return;
    setButtonState(key, true);
    window.clearTimeout(buttonTimers[key]);
    buttonTimers[key] = window.setTimeout(function () {
      setButtonState(key, false);
    }, 140);
    playSound(key);

    const lane = document.querySelector(`.rhythmLane[data-key="${key}"] .laneBeams`);
    const beam = document.createElement('span');
    beam.className = 'laneBeam';
    lane.appendChild(beam);
    window.setTimeout(function () {
      beam.remove();
    }, 420);

    const time = performance.now();
    rhythmHistory.push({ key, time });
    rhythmHistory = rhythmHistory.slice(-6);
    drawRhythmHistory();
    updateCooperation(time);
  }


  // Remove the ‘held down’ state when the key is released; the same key can be pressed again.
  function releaseKey(key) {
    if (!keySettings[key]) return;
    pressedKeys.delete(key);
    setButtonState(key, false);
  }

  // The earliest and latest timestamps form a local timeline.
  // The red dots are distributed in proportion to real time; the timeline is rescaled whenever a new record is added.
  function drawRhythmHistory() {
    rhythmLines.forEach(function (line) {
      line.replaceChildren();
    });
    const firstPressTime = rhythmHistory[0].time;
    const historyDuration = rhythmHistory[rhythmHistory.length - 1].time - firstPressTime;
    rhythmHistory.forEach(function (press) {
      const dot = document.createElement('span');
      dot.className = 'rhythmDot';
      dot.style.left =
          `${historyDuration > 0 ? (press.time - firstPressTime) / historyDuration * 100 : 50}%`;
      dot.setAttribute('aria-hidden', 'true');
      rhythmLines.find(line => line.dataset.key === press.key).appendChild(dot);
    });
  }


  // Six inputs produce five time intervals. First, calculate the average interval, then compute the mean absolute deviation.
  // The rhythm may be considered stable if the deviation does not exceed 28 per cent of the average value. Excessively rapid inputs and long pauses are excluded separately.
  function checkRhythm(time) {
    if (rhythmHistory.length < 6) return false;
    const intervals = [];
    for (let i = 1; i < rhythmHistory.length; i++) {
      intervals.push(rhythmHistory[i].time - rhythmHistory[i - 1].time);
    }
    const averageInterval = intervals.reduce((total, gap) => total + gap, 0)
        / intervals.length;
    if (averageInterval < 180 || averageInterval > 1600 || intervals.some(gap => gap > 2200))
      return false;
    const meanIntervalDeviation = intervals.reduce(
        (total, gap) => total + Math.abs(gap - averageInterval),
        0,
    ) / intervals.length;
    // The permitted time after input ceases varies with the average interval and is restricted to between 650 and 2,200 milliseconds.
    const pauseLimit = clamp(averageInterval * 1.8, 650, 2200);
    return meanIntervalDeviation / averageInterval <= 0.28
        && time - rhythmHistory[5].time <= pauseLimit;
  }


  // Reset the challenge timer, prompts and overlay; existing audio and rhythm records will be retained.
  function resetCooperation() {
    ringProgress = 0;
    stableStartTime = null;
    isFinalHold = false;
    finalHoldStartedAt = null;
    finalHoldFailed = false;
    resultActive = false;
    resultStartedAt = null;
    resultOverlay.hidden = true;
    resultOverlay.classList.remove('isPerfect');
    holdMessage.textContent = '';
    cooperationRing.classList.remove('isFlashing');
    cooperationRing.style.setProperty('--progress', '0turn');
  }

  // Progress will only be accumulated if Player A maintains a steady rhythm and Player B achieves 70% distance consistency.
  // During the results display, only the display duration is checked; the challenge is reset once it ends.
  function updateCooperation(time) {
    playerARhythmStable = checkRhythm(time);
    playerBStable = pointer.inside && currentSpatialValues.stability >= 0.7;
    const bothStable = playerARhythmStable && playerBStable && !document.hidden;

    if (resultActive) {
      if (time - resultStartedAt >= 2000) resetCooperation();
      return;
    }


    // Any loss of stability during the final two seconds will be recorded. Even if stability is regained, this round will still be deemed a failure.
    if (isFinalHold) {
      if (!bothStable) finalHoldFailed = true;
      if (time - finalHoldStartedAt >= 2000) {
        resultActive = true;
        resultStartedAt = time;
        resultText.textContent = finalHoldFailed ? 'Try Again' : 'Perfect';
        resultOverlay.classList.toggle('isPerfect', !finalHoldFailed);
        resultOverlay.hidden = false;
      }
      return;
    }

    // Enter the actual elapsed time for the loop; 100% is reached after eight consecutive seconds.
    // If either side becomes unstable prematurely, both the start time and current progress will be reset to zero.
    if (bothStable) {
      if (stableStartTime === null) stableStartTime = time;
      ringProgress = Math.min((time - stableStartTime) / 8000, 1);
      if (ringProgress >= 1) {
        isFinalHold = true;
        finalHoldStartedAt = time;
        finalHoldFailed = false;
        holdMessage.textContent = 'Maintain Stability!!';
        cooperationRing.classList.add('isFlashing');
      }
    } else {
      stableStartTime = null;
      ringProgress = 0;
    }
    cooperationRing.style.setProperty('--progress', `${ringProgress}turn`);
  }


  // Each time a mouse input is received, the window coordinates are saved first, and then the sharing status is updated.
  function updateSpatialInput(event) {
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.inside = true;
    updateSharedState();
  }
  // The position mapping is calculated only once and is shared by the mouse click, waveform and audio parameters.
  // When moving out of the grid, the most recent pan and filter positions are retained, and distance stability is reduced to zero.
  function updateSharedState() {
    const fieldBounds = spatialField.getBoundingClientRect();
    const values = window.spatialMapping.getSpatialValues(
        pointer.clientX, pointer.clientY, fieldBounds, target.x, target.y,
    );
    if (!pointer.inside) {
      values.pan = currentSpatialValues.pan;
      values.filterFrequency = currentSpatialValues.filterFrequency;
      values.stability = 0;
    }
    currentSpatialValues = values;

    spatialField.classList.toggle('isActive', pointer.inside);
    cursorDot.style.left = `${values.x * 100}%`;
    cursorDot.style.top = `${values.y * 100}%`;


    updateFeedback(values.stability);

    applyAudioState();
    updateCooperation(performance.now());
  }

  // The current page uses the ‘wave’ branch. The waveform is generated by Stability and is intended to illustrate the state.
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
      const phase = reducedMotionQuery.matches ? 0 : wavePhase;
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

  // The target point takes values only within the grid, leaving a certain distance at the edges.
  function chooseRandomDestination() {
    return { x: 0.12 + Math.random() * 0.76, y: 0.12 + Math.random() * 0.76 };
  }
  // Update the target position every frame based on the elapsed time. Easing curves ensure a smoother start and finish to the movement.
  // The distance is also recalculated when the mouse is stationary.
  function animateTarget(time) {
    const elapsed = Math.min(0.05, Math.max(0, (time - lastFrameTime) / 1000));
    lastFrameTime = time;
    if (feedbackType === 'wave' && !reducedMotionQuery.matches) {
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
      destination = chooseRandomDestination();
      journeyStartedAt = time;
      journeyDuration = 2000 + Math.random() * 1800;
    }
    updateSharedState();
    window.requestAnimationFrame(animateTarget);
  }

  // Keyboard input is handled centrally here. Repeated events caused by long presses are not counted towards the rhythm, nor is input recorded whilst reading pop-up windows.
  document.addEventListener('keydown', function (event) {
    if (guideDialog.open) return;
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
  // Clear the active input and stop the timer when switching pages or windows.
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

  // On-screen buttons and the keyboard call the same trigger function.
  // Play when the mouse button is pressed; a click with ‘detail’ set to zero is used to handle situations where a button is activated via the keyboard.
  soundButtons.forEach(function (button) {
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


  // Hover mode continuously detects mouse movement; it does not require the mouse button to be held down.
  spatialField.addEventListener('mousemove', function (event) {
    if (inputMode === 'hover') updateSpatialInput(event);
  });
  // This window-level listener only handles drag mode; the position can still be read when the element is dragged outside the grid.
  window.addEventListener('mousemove', function (event) {
    if (inputMode !== 'drag' || !isDragging) return;
    if (event.buttons === 0) {
      stopDragging();
      return;
    }
    updateSpatialInput(event);
  });
  // Entering the grid immediately updates the input position; leaving it clears the active state of the spatial input.
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

  // When dragging ends, clear the mouse active state and recalculate the shared feedback.
  function stopDragging() {
    if (!isDragging) return;
    isDragging = false;
    pointer.inside = false;
    updateSharedState();
  }
  // Listen for release events within the window; dragging is also terminated when the mouse is released outside the grid.
  window.addEventListener('mouseup', function (event) {
    if (event.button !== 0) return;
    stopDragging();
    Object.keys(keySettings).forEach(releaseKey);
  });
  // Clear the active input before opening the native dialogue box.  // Whilst the dialogue box is displayed, the play button will be temporarily disabled.
  function openGuide() {
    pointer.inside = false;
    isDragging = false;
    Object.keys(keySettings).forEach(releaseKey);
    guideDialog.showModal();
    updateSharedState();
  }


  // ‘Guide’ reopens the instructions; ‘OK’ closes the pop-up window. When the page loads, the instructions are displayed first, followed by the audio.
  guideButton.addEventListener('click', openGuide);
  guideCloseButton.addEventListener('click', function () {
    guideDialog.close();
  });
  openGuide();
  loadChords();
  window.requestAnimationFrame(animateTarget);
})();


