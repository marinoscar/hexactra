// messaging-send: a web messaging composer that, like many real ones, sends only on a real click or a real Enter. A click or a key
// dispatched by a script (`event.isTrusted === false`) does nothing, so a "click" that only fires script events reports success and
// sends nothing. On a real send the composer's text goes into the form's hidden `text` field and the form is posted.
(function () {
  'use strict';
  var form = document.querySelector('[data-send-form]');
  if (!form) return;
  var box = form.querySelector('[data-composer]');
  var hidden = form.querySelector('input[name="text"]');
  var button = form.querySelector('[data-send]');
  function send() {
    var text = (box.innerText || box.textContent || '').replace(/\s+$/, '');
    if (!text) return;
    hidden.value = text;
    form.submit();
  }
  button.addEventListener('click', function (event) {
    if (!event.isTrusted) return;
    send();
  });
  box.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!event.isTrusted) return;
    send();
  });
})();
