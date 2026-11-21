// extract-table: sort the invoices by a column (a click on its heading; a second click reverses) and filter them by region.
(function () {
  'use strict';
  var table = document.getElementById('invoices');
  var body = table.tBodies[0];
  var filter = document.getElementById('region-filter');
  var count = document.getElementById('row-count');

  function rows() {
    return Array.prototype.slice.call(body.rows);
  }

  filter.addEventListener('change', function () {
    var shown = 0;
    rows().forEach(function (row) {
      var show = !filter.value || row.getAttribute('data-region') === filter.value;
      row.hidden = !show;
      if (show) shown++;
    });
    count.textContent = shown + ' invoices';
  });

  table.tHead.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-sort]');
    if (!button) return;
    var th = button.parentNode;
    var key = button.getAttribute('data-sort');
    var numeric = button.hasAttribute('data-numeric');
    var descending = th.getAttribute('aria-sort') === 'ascending';
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (cell) {
      cell.setAttribute('aria-sort', 'none');
    });
    th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
    rows()
      .sort(function (a, b) {
        var x = a.getAttribute('data-' + key);
        var y = b.getAttribute('data-' + key);
        var order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        return descending ? -order : order;
      })
      .forEach(function (row) {
        body.appendChild(row);
      });
  });
})();
