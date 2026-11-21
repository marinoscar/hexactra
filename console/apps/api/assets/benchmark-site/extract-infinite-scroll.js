// extract-infinite-scroll: load the next shipments from `api/feed` when the end of the list comes into view.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var el = site.el;
  var feed = document.getElementById('feed');
  var status = document.getElementById('feed-status');
  var end = document.getElementById('feed-end');
  var next = Number(feed.getAttribute('data-next'));
  var loading = false;

  function nearEnd() {
    return end.getBoundingClientRect().top < window.innerHeight + 200;
  }

  function more() {
    if (loading || next === null) return;
    loading = true;
    status.textContent = 'Loading more…';
    site.get('api/feed?offset=' + next).then(function (res) {
      loading = false;
      if (!res.ok) {
        status.textContent = 'Could not load more shipments.';
        return;
      }
      res.data.items.forEach(function (item) {
        feed.appendChild(el('li', { class: 'feed-entry' }, [
          el('strong', {}, [item.ref]),
          el('span', {}, [item.product + ', to ' + item.town]),
          el('span', { class: 'muted' }, ['Pickup code: ', el('code', {}, [item.code])]),
        ]));
      });
      next = res.data.next;
      status.textContent = next === null ? 'All ' + res.data.total + ' shipments are shown.' : 'Showing ' + res.data.shown + ' of ' + res.data.total;
      // A tall window can still show the end of the list: keep going until it is out of view.
      if (next !== null && nearEnd()) more();
    }, function () {
      loading = false;
      status.textContent = 'Could not load more shipments.';
    });
  }

  function check() {
    if (nearEnd()) more();
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) more();
    }, { rootMargin: '200px' }).observe(end);
  }
  check();
})();
