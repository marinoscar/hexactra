// ptr-drag-reorder: rows move with the mouse (pointer events: press on a row, move, release). Nothing is sent until "Save order" is
// pressed, and then only the order the list shows: a script error leaves the stored order as it was.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var listEl = document.querySelector('[data-sortable]');
  var save = document.querySelector('[data-save]');
  var status = document.getElementById('saved');
  if (!listEl || !save) return;
  var dragging = null;

  listEl.addEventListener('pointerdown', function (event) {
    var row = event.target.closest('.sortable-item');
    if (!row || event.button !== 0) return;
    event.preventDefault();
    dragging = row;
    row.classList.add('dragging');
    if (row.setPointerCapture) row.setPointerCapture(event.pointerId);
    status.hidden = true;
  });

  listEl.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    var rows = Array.prototype.filter.call(listEl.children, function (r) { return r !== dragging; });
    var before = null;
    for (var i = 0; i < rows.length; i++) {
      var box = rows[i].getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) { before = rows[i]; break; }
    }
    if (before) listEl.insertBefore(dragging, before);
    else listEl.appendChild(dragging);
  });

  function drop() {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
  }
  listEl.addEventListener('pointerup', drop);
  listEl.addEventListener('pointercancel', drop);

  save.addEventListener('click', function () {
    var order = Array.prototype.map.call(listEl.children, function (r) { return r.getAttribute('data-id'); });
    site.post('api/order', { order: order }).then(function (res) {
      if (res.ok) status.hidden = false;
    });
  });
})();
