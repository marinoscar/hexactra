// dom-shadow: <delivery-picker> draws its options and its Confirm button inside an open shadow root. The choice is sent only when
// Confirm is pressed.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var el = site.el;
  var sheet = document.querySelector('link[rel="stylesheet"]');

  class Picker extends HTMLElement {
    connectedCallback() {
      draw(this);
    }
  }

  function draw(host) {
    var self = host;
    if (self.shadowRoot) return;
    var root = self.attachShadow({ mode: 'open' });
    // The page's own stylesheet, by its own address: the site's policy allows no inline style, in a shadow root either.
    if (sheet) root.appendChild(el('link', { rel: 'stylesheet', href: sheet.href }));
    var box = el('fieldset', { class: 'picker' }, [el('legend', {}, ['Delivery option'])]);
    var status = el('p', { class: 'muted', role: 'status' }, ['']);
    var confirm = el('button', { type: 'button' }, ['Confirm']);
    root.appendChild(box);
    site.get('api/options').then(function (res) {
      if (!res.ok) return;
      res.data.options.forEach(function (o) {
        var input = el('input', { type: 'radio', name: 'delivery', value: o.key, id: 'opt-' + o.key });
        if (o.key === res.data.selected) input.checked = true;
        box.appendChild(el('label', { class: 'check', for: 'opt-' + o.key }, [input, ' ' + o.label]));
      });
      box.appendChild(el('div', { class: 'row' }, [confirm]));
      box.appendChild(status);
    });
    confirm.addEventListener('click', function () {
      var chosen = root.querySelector('input[name="delivery"]:checked');
      if (!chosen) return;
      site.post('api/choice', { option: chosen.value }).then(function (res) {
        status.textContent = res.ok ? 'Your delivery option is confirmed.' : 'Choose one of the options.';
      });
    });
  }
  if (window.customElements && !window.customElements.get('delivery-picker')) window.customElements.define('delivery-picker', Picker);
})();
