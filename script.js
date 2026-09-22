const buttons = Array.from(document.querySelectorAll('.sound-key'));

function pressKey(key) {
  const button = buttons.find(button => button.dataset.key === key);
  if (!button) return;
  button.classList.add('is-active');
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
});


