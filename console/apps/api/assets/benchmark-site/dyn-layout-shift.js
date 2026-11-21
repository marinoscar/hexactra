// dyn-layout-shift: while the page settles, banners arrive above the product list and push every row down. The last one arrives
// about three seconds after the page opens. Only the banners are added; the products and their forms are the server's markup.
(function () {
  'use strict';
  var el = window.BenchmarkSite.el;
  var banners = document.getElementById('banners');
  if (!banners || document.getElementById('added')) return;
  var steps = [
    { at: 500, size: 'shift-banner-tall', text: 'Free delivery on orders over $40 this week.' },
    { at: 1400, size: 'shift-banner', text: 'New: order before noon for same-day pickup.' },
    { at: 2600, size: 'shift-banner-tall', text: 'Members save 5% on every basket. Sign up at the till.' },
  ];
  steps.forEach(function (step) {
    window.setTimeout(function () {
      banners.insertBefore(el('div', { class: 'shift-banner-box ' + step.size }, [step.text]), banners.firstChild);
    }, step.at);
  });
})();
