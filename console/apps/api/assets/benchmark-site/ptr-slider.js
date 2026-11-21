// ptr-slider: a slider drawn from a track and a thumb. Press on it and move to change the value (the arrow keys move it by one);
// "Apply" sends the value it shows. Nothing is sent while dragging.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var slider = document.querySelector('[data-slider]');
  var apply = document.querySelector('[data-apply]');
  var output = document.getElementById('slider-value');
  var status = document.getElementById('applied');
  if (!slider || !apply) return;
  var fill = slider.querySelector('.slider-fill');
  var thumb = slider.querySelector('.slider-thumb');
  var value = Number(slider.getAttribute('aria-valuenow')) || 0;
  var dragging = false;

  function show(v) {
    value = Math.max(0, Math.min(100, Math.round(v)));
    slider.setAttribute('aria-valuenow', String(value));
    output.textContent = value + '%';
    // Set through the style object, which the site's policy allows; there is no inline style attribute.
    fill.style.width = value + '%';
    thumb.style.left = value + '%';
    status.hidden = true;
  }
  function fromPointer(event) {
    var box = slider.getBoundingClientRect();
    show(((event.clientX - box.left) / box.width) * 100);
  }
  show(value);

  slider.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    if (slider.setPointerCapture) slider.setPointerCapture(event.pointerId);
    slider.focus();
    fromPointer(event);
  });
  slider.addEventListener('pointermove', function (event) {
    if (dragging) fromPointer(event);
  });
  slider.addEventListener('pointerup', function () { dragging = false; });
  slider.addEventListener('pointercancel', function () { dragging = false; });
  slider.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); show(value + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); show(value - 1); }
  });

  apply.addEventListener('click', function () {
    site.post('api/value', { value: value }).then(function (res) {
      if (res.ok) status.hidden = false;
    });
  });
})();
