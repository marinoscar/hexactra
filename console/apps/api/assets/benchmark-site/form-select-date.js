// form-select-date: the custom dropdown and the calendar of the booking form. Each fills a hidden field of the form; the form itself
// is posted by the browser.
(function () {
  'use strict';
  var el = window.BenchmarkSite.el;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-dropdown]'), function (box) {
    var toggle = box.querySelector('.dropdown-toggle');
    var list = box.querySelector('.dropdown-list');
    var input = box.querySelector('input[type="hidden"]');
    var label = toggle.querySelector('span');

    function open(state) {
      list.hidden = !state;
      toggle.setAttribute('aria-expanded', state ? 'true' : 'false');
    }
    function choose(option) {
      input.value = option.getAttribute('data-value');
      label.textContent = option.textContent;
      Array.prototype.forEach.call(list.children, function (li) {
        li.setAttribute('aria-selected', li === option ? 'true' : 'false');
      });
      open(false);
      toggle.focus();
    }
    toggle.addEventListener('click', function () {
      open(list.hidden);
    });
    list.addEventListener('click', function (event) {
      var option = event.target.closest('[role="option"]');
      if (option) choose(option);
    });
    list.addEventListener('keydown', function (event) {
      var option = event.target.closest('[role="option"]');
      if (!option) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose(option);
      } else if (event.key === 'ArrowDown' && option.nextElementSibling) option.nextElementSibling.focus();
      else if (event.key === 'ArrowUp' && option.previousElementSibling) option.previousElementSibling.focus();
      else if (event.key === 'Escape') open(false);
    });
    toggle.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        open(true);
        if (list.firstElementChild) list.firstElementChild.focus();
      }
    });
    document.addEventListener('click', function (event) {
      if (!box.contains(event.target)) open(false);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-datepicker]'), function (box) {
    var toggle = box.querySelector('.datepicker-toggle');
    var calendar = box.querySelector('.calendar');
    var grid = box.querySelector('.calendar-grid');
    var title = box.querySelector('.calendar-month');
    var input = box.querySelector('input[type="hidden"]');
    var label = toggle.querySelector('span');
    var first = box.getAttribute('data-first').split('-').map(Number);
    var last = box.getAttribute('data-last').split('-').map(Number);
    var year = first[0];
    var month = first[1];

    function draw() {
      title.textContent = MONTHS[month - 1] + ' ' + year;
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      DAYS.forEach(function (d) {
        grid.appendChild(el('span', {}, [d]));
      });
      // Monday first: 0 for Monday ... 6 for Sunday.
      var offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
      for (var i = 0; i < offset; i++) grid.appendChild(el('span', {}, ['']));
      var days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (var day = 1; day <= days; day++) {
        var iso = year + '-' + pad(month) + '-' + pad(day);
        grid.appendChild(el('button', { type: 'button', 'data-date': iso, 'aria-label': day + ' ' + MONTHS[month - 1] + ' ' + year, 'aria-pressed': iso === input.value ? 'true' : 'false' }, [String(day)]));
      }
      box.querySelector('[data-step="-1"]').disabled = year === first[0] && month === first[1];
      box.querySelector('[data-step="1"]').disabled = year === last[0] && month === last[1];
    }
    function open(state) {
      calendar.hidden = !state;
      toggle.setAttribute('aria-expanded', state ? 'true' : 'false');
      if (state) draw();
    }
    toggle.addEventListener('click', function () {
      open(calendar.hidden);
    });
    calendar.addEventListener('click', function (event) {
      var step = event.target.closest('[data-step]');
      if (step) {
        month += Number(step.getAttribute('data-step'));
        if (month < 1) { month = 12; year -= 1; }
        if (month > 12) { month = 1; year += 1; }
        draw();
        return;
      }
      var day = event.target.closest('[data-date]');
      if (!day) return;
      var iso = day.getAttribute('data-date');
      input.value = iso;
      label.textContent = day.getAttribute('aria-label');
      open(false);
      toggle.focus();
    });
    document.addEventListener('click', function (event) {
      if (!box.contains(event.target)) open(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') open(false);
    });
  });
})();
