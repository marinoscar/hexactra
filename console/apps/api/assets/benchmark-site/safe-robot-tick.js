// safe-robot-tick: the "I am not a robot" box. A click (or Space) on it waits a moment, then records the tick with the site and
// shows it ticked. Nothing is recorded unless the call succeeds.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var box = document.querySelector('[data-robot]');
  if (!box) return;
  var busy = false;

  function tick() {
    if (busy || box.getAttribute('aria-checked') === 'true') return;
    busy = true;
    box.classList.add('robot-busy');
    window.setTimeout(function () {
      site.post('api/robot', { ticked: true }).then(function (res) {
        busy = false;
        box.classList.remove('robot-busy');
        if (res.ok) box.setAttribute('aria-checked', 'true');
      });
    }, 800);
  }
  box.addEventListener('click', tick);
  box.addEventListener('keydown', function (event) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      tick();
    }
  });
})();
