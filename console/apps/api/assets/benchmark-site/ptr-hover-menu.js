// ptr-hover-menu: a menu opens while the mouse rests on it and closes shortly after it leaves. Clicking the menu's title, focusing
// it or pressing a key does not open it. Choosing an item is an ordinary form post.
(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('[data-hover-menu]'), function (menu) {
    var title = menu.querySelector('.menubar-title');
    var panel = menu.querySelector('.menubar-panel');
    var openTimer = null;
    var closeTimer = null;

    function set(open) {
      panel.hidden = !open;
      title.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    menu.addEventListener('mouseenter', function () {
      window.clearTimeout(closeTimer);
      openTimer = window.setTimeout(function () { set(true); }, 150);
    });
    menu.addEventListener('mouseleave', function () {
      window.clearTimeout(openTimer);
      closeTimer = window.setTimeout(function () { set(false); }, 300);
    });
  });
})();
