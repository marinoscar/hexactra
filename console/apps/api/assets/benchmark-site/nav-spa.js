// nav-spa: a small single-page app. Routes are in the fragment (#/dashboard, #/projects, #/settings, #/settings/<section>); every
// view is drawn here from `api/settings`, and a section's Save posts its values there.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var el = site.el;
  var view = document.getElementById('view');
  var data = null;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function markTabs(top) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs a'), function (a) {
      if (a.getAttribute('href') === '#/' + top) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function load() {
    return site.get('api/settings').then(function (res) {
      data = res.data;
      return data;
    });
  }

  function dashboard() {
    clear(view);
    view.appendChild(el('h1', {}, ['Dashboard']));
    view.appendChild(el('p', {}, ['Everything is up to date. Nothing needs your attention.']));
  }

  function projects() {
    clear(view);
    view.appendChild(el('h1', {}, ['Projects']));
    view.appendChild(el('p', { class: 'muted' }, ['You have no projects yet.']));
  }

  function settings(sectionId) {
    load().then(function () {
      clear(view);
      view.appendChild(el('h1', {}, ['Settings']));
      var tabs = el('nav', { class: 'subtabs', 'aria-label': 'Settings sections' }, data.sections.map(function (s) {
        return el('a', { href: '#/settings/' + s.id, 'aria-current': s.id === sectionId ? 'page' : null }, [s.label]);
      }));
      view.appendChild(tabs);
      var section = data.sections.filter(function (s) { return s.id === sectionId; })[0];
      if (!section) {
        view.appendChild(el('p', { class: 'muted' }, ['Choose a section.']));
        return;
      }
      var status = el('p', { id: 'save-status', class: 'muted', role: 'status' }, ['']);
      var form = el('form', { class: 'stack', id: 'settings-form' }, []);
      section.settings.forEach(function (s) {
        form.appendChild(el('label', { for: 'set-' + s.key }, [s.label]));
        var select = el('select', { id: 'set-' + s.key, name: s.key }, s.options.map(function (o) {
          return el('option', { value: o }, [o]);
        }));
        select.value = s.value;
        form.appendChild(select);
      });
      form.appendChild(el('div', { class: 'row' }, [el('button', { type: 'submit' }, ['Save changes'])]));
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var values = {};
        section.settings.forEach(function (s) {
          values[s.key] = form.elements[s.key].value;
        });
        status.textContent = 'Saving…';
        site.post('api/settings', { section: section.id, values: values }).then(function (res) {
          status.textContent = res.ok ? 'Saved.' : 'Not saved: ' + (res.data && res.data.error ? res.data.error : 'try again.');
        }, function () {
          status.textContent = 'Not saved: the server could not be reached.';
        });
      });
      view.appendChild(form);
      view.appendChild(status);
    });
  }

  function route() {
    var parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var top = parts[0] || 'dashboard';
    markTabs(top);
    if (top === 'settings') settings(parts[1] || '');
    else if (top === 'projects') projects();
    else dashboard();
  }

  window.addEventListener('hashchange', route);
  route();
})();
