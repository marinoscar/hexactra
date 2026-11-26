// auth-otp-segmented: six one-digit boxes, as many sign-in and payment pages draw a texted code. A full box moves the focus to the
// next one; Backspace in an empty box moves it back; a pasted code fills the boxes from the one pasted into. A whole code set into one
// box by a script keeps only its first digit. On submit the boxes are joined into the form's hidden `code` field, which is all the
// server reads.
(function () {
  'use strict';
  var form = document.querySelector('[data-otp-form]');
  if (!form) return;
  var boxes = Array.prototype.slice.call(form.querySelectorAll('.otp-box'));
  var code = form.querySelector('input[name="code"]');

  function fill(from, text) {
    var digits = String(text).replace(/\D/g, '').split('');
    for (var i = from; i < boxes.length && digits.length; i++) boxes[i].value = digits.shift();
    var next = boxes.find(function (b) { return b.value === ''; });
    (next || boxes[boxes.length - 1]).focus();
  }

  boxes.forEach(function (box, i) {
    box.addEventListener('input', function () {
      // One digit per box, as a strict widget keeps it: a box that was given several characters at once (a script setting the whole
      // code) keeps only the first, so the code never reaches the server whole that way. This is the failure the challenge guards.
      if (box.value.length > 1) box.value = box.value.charAt(0);
      if (!/^\d$/.test(box.value)) box.value = '';
      if (box.value && boxes[i + 1]) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', function (event) {
      if (event.key === 'Backspace' && box.value === '' && boxes[i - 1]) boxes[i - 1].focus();
    });
    box.addEventListener('paste', function (event) {
      event.preventDefault();
      fill(i, (event.clipboardData || window.clipboardData).getData('text'));
    });
  });
  form.addEventListener('submit', function () {
    code.value = boxes.map(function (b) { return b.value; }).join('');
  });
})();
