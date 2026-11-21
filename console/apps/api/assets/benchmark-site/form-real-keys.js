// form-real-keys: the verification field keeps its own value, built from trusted key presses only. Any other change to the field
// (a script setting its value, a paste, a drop, text inserted without a key press, a synthetic key event) is undone. On submit the
// typed value and the number of trusted key presses are copied into the form's hidden fields; nothing else fills them.
(function () {
  'use strict';
  var form = document.querySelector('[data-real-keys-form]');
  var input = document.querySelector('[data-real-keys]');
  if (!form || !input) return;
  var phrase = form.querySelector('input[name="phrase"]');
  var typed = form.querySelector('input[name="typed"]');
  var value = '';
  var presses = 0;

  function show() {
    input.value = value;
  }

  input.addEventListener('keydown', function (event) {
    if (!event.isTrusted) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // Shortcuts (paste, select all, undo) do not edit the field.
      if (event.key && event.key.length === 1) event.preventDefault();
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      value = value.slice(0, -1);
      presses++;
      show();
    } else if (event.key && event.key.length === 1) {
      event.preventDefault();
      if (value.length < 40) value += event.key;
      presses++;
      show();
    }
  });
  // Whatever reached the field another way is replaced by what was typed.
  ['input', 'change', 'paste', 'drop', 'cut'].forEach(function (name) {
    input.addEventListener(name, function (event) {
      if (name !== 'input' && name !== 'change') event.preventDefault();
      show();
    });
  });
  form.addEventListener('submit', function () {
    phrase.value = value;
    typed.value = String(presses);
  });
})();
