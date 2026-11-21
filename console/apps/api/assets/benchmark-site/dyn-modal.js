// dyn-modal: show the dialog shortly after the page opens, unless it was already answered, and record its dismissal.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var overlay = document.querySelector('[data-modal]');
  if (!overlay || overlay.getAttribute('data-dismissed') === '1') return;

  window.setTimeout(function () {
    overlay.hidden = false;
    var button = overlay.querySelector('[data-dismiss]');
    if (button) button.focus();
  }, 700);

  overlay.addEventListener('click', function (event) {
    if (!event.target.closest('[data-dismiss]')) return;
    site.post('api/modal', { action: 'dismiss' }).then(function (res) {
      if (res.ok) overlay.hidden = true;
    });
  });
})();
