// dyn-delayed: ask the server for the current report and show its total when it is ready. The server keeps the delay.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var total = document.getElementById('report-total');
  var status = document.getElementById('report-status');

  function failed() {
    status.textContent = 'The report could not be loaded. Reload the page to try again.';
  }

  function poll() {
    site.get('api/report').then(function (res) {
      if (res.ok && res.data.status === 'ready') {
        total.textContent = res.data.total;
        total.setAttribute('data-ready', '1');
        status.textContent = 'The report is up to date.';
        return;
      }
      if (!res.ok) return failed();
      window.setTimeout(poll, 500);
    }, failed);
  }

  site.post('api/report').then(function (res) {
    if (res.ok) poll();
    else failed();
  }, failed);
})();
