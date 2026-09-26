const field = document.querySelector('.spatial-field');
const cursor = document.querySelector('.cursor-dot');
const target = document.querySelector('.target');
const inputStatus = document.querySelector('.input-status');
const syncStatus = document.querySelector('.sync-status');
const audioStatus = document.querySelector('.audio-status');
const idleText = 'Press and drag the red dot';
let x = 0.5;
let y = 0.5;
let targetX = 0.5;
let targetY = 0.5;
let active = true;
let stability = 0;
let audio;
let filter;
let pan;
let dragging = false;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

async function playNote(key) {
  try {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      filter = audio.createBiquadFilter();
      filter.type = 'lowpass';
      pan = audio.createStereoPanner();
      filter.connect(pan);
      pan.connect(audio.destination);
    }
    await audio.resume();
    const now = audio.currentTime;
    const frequencies = { a: 110, s: 174.61, d: 261.63, f: 392 };
    const tone = audio.createOscillator();
    const envelope = audio.createGain();
    tone.frequency.value = frequencies[key];
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(0.12 + (1 - stability) * 0.10, now + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    tone.connect(envelope);
    envelope.connect(filter);
    tone.start(now);
    tone.stop(now + 0.3);
    tone.onended = function () { tone.disconnect(); envelope.disconnect(); };
    const rough = audio.createOscillator();
    const roughVolume = audio.createGain();
    rough.type = 'sawtooth';
    rough.frequency.value = frequencies[key] * 1.025;
    roughVolume.gain.setValueAtTime(0, now);
    roughVolume.gain.linearRampToValueAtTime((1 - stability) * 0.10, now + 0.015);
    roughVolume.gain.linearRampToValueAtTime(0, now + 0.28);
    rough.connect(roughVolume);
    roughVolume.connect(filter);
    rough.start(now);
    rough.stop(now + 0.3);
    rough.onended = function () { rough.disconnect(); roughVolume.disconnect(); };
    updateFeedback(0);
    audioStatus.textContent = '';
  } catch (error) {
    audioStatus.textContent = 'Audio could not start. Try clicking a sound key.';
  }
}

function recordPosition(event) {
  const rect = field.getBoundingClientRect();
  x = clamp((event.clientX - rect.left) / rect.width, 6 / rect.width, 1 - 6 / rect.width);
  y = clamp((event.clientY - rect.top) / rect.height, 6 / rect.height, 1 - 6 / rect.height);
  active = true;
  cursor.hidden = false;
  cursor.style.left = x * 100 + '%';
  cursor.style.top = y * 100 + '%';
  inputStatus.textContent = 'Input active';
  updateFeedback(0);
}

field.addEventListener('pointerdown', function (event) {
  if (event.button !== 0 || event.target !== cursor) return;
  event.preventDefault();
  dragging = true;
  field.setPointerCapture(event.pointerId);
  recordPosition(event);
});
field.addEventListener('pointermove', function (event) {
  if (dragging) recordPosition(event);
});
function stopDragging() {
  dragging = false;
  inputStatus.textContent = idleText;
}
field.addEventListener('pointerup', stopDragging);
field.addEventListener('pointercancel', stopDragging);
field.addEventListener('lostpointercapture', stopDragging);

function updateFeedback(time) {
  const rect = field.getBoundingClientRect();
  const distance = Math.hypot((x - targetX) * rect.width, (y - targetY) * rect.height);
  stability = active ? clamp(1 - distance / (Math.min(rect.width, rect.height) * 0.7)) : 0;
  syncStatus.textContent = stability > 0.7 ? 'Stable' : stability > 0.3 ? 'Connecting' : 'Unstable';
  if (audio) {
    pan.pan.setTargetAtTime(x * 2 - 1, audio.currentTime, 0.03);
    filter.frequency.setTargetAtTime(12000 * Math.pow(500 / 12000, y), audio.currentTime, 0.03);
  }
  const level = stability;
  const circle = document.querySelector('.sync-point');
  circle.style.backgroundColor = 'rgb(' + Math.round(255 - 39 * level) + ', ' + Math.round(255 - 209 * level) + ', ' + Math.round(255 - 208 * level) + ')';
}

let startX = 0.5;
let startY = 0.5;
let goalX = 0.2 + Math.random() * 0.6;
let goalY = 0.2 + Math.random() * 0.6;
let startTime = null;

function animate(time) {
  if (startTime === null) startTime = time;
  const progress = clamp((time - startTime) / 2800);
  targetX = startX + (goalX - startX) * progress;
  targetY = startY + (goalY - startY) * progress;
  target.style.left = targetX * 100 + '%';
  target.style.top = targetY * 100 + '%';
  if (progress === 1) {
    startX = targetX;
    startY = targetY;
    goalX = 0.12 + Math.random() * 0.76;
    goalY = 0.12 + Math.random() * 0.76;
    startTime = time;
  }
  updateFeedback(time);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
updateFeedback(0);

const buttons = Array.from(document.querySelectorAll('.sound-key'));

function pressKey(key) {
  const button = buttons.find(button => button.dataset.key === key);
  if (!button) return;
  button.classList.add('is-active');
  playNote(key);
}

function releaseKey(key) {
  const button = buttons.find(button => button.dataset.key === key);
  if (button) button.classList.remove('is-active');
}

document.addEventListener('keydown', function (event) {
  const key = event.key.toLowerCase();
  if (!['a', 's', 'd', 'f'].includes(key) || event.repeat) return;
  event.preventDefault();
  pressKey(key);
});

document.addEventListener('keyup', function (event) {
  releaseKey(event.key.toLowerCase());
});

buttons.forEach(function (button) {
  const key = button.dataset.key;
  button.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    pressKey(key);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) {
    button.addEventListener(type, function () { releaseKey(key); });
  });
  button.addEventListener('click', function (event) {
    if (event.detail !== 0) return;
    pressKey(key);
    setTimeout(function () { releaseKey(key); }, 120);
  });
});

window.addEventListener('blur', function () {
  buttons.forEach(button => releaseKey(button.dataset.key));
  dragging = false;
  inputStatus.textContent = idleText;
});

