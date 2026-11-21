// The benchmark challenge site (E44.2, #740): what every page script shares. Loaded before the page's own script. Every address is
// built from the page's relative root (`<body data-root>`), so the same script works behind nginx at /benchmark/ and in development
// at /api/benchmark-site/.
(function () {
  'use strict';
  var root = document.body ? document.body.getAttribute('data-root') || './' : './';

  function url(path) {
    return new URL(root + path, window.location.href.split('#')[0]).toString();
  }

  function request(method, path, body) {
    var options = { method: method, headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store' };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url(path), options).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      if (attrs[name] !== null && attrs[name] !== undefined) node.setAttribute(name, attrs[name]);
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  window.BenchmarkSite = {
    url: url,
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body === undefined ? {} : body); },
    el: el,
  };
})();
