// ptr-canvas: draws the board from `api/shapes` and sends each click's position on the board. Which shape was hit is decided by the
// server; this script only reports where the click landed.
(function () {
  'use strict';
  var site = window.BenchmarkSite;
  var canvas = document.getElementById('board');
  var status = document.getElementById('selection');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  function draw(shape) {
    ctx.fillStyle = shape.fill;
    ctx.beginPath();
    if (shape.kind === 'circle') ctx.arc(shape.x, shape.y, shape.size, 0, Math.PI * 2);
    else if (shape.kind === 'square') ctx.rect(shape.x - shape.size, shape.y - shape.size, shape.size * 2, shape.size * 2);
    else {
      ctx.moveTo(shape.x, shape.y - shape.size);
      ctx.lineTo(shape.x + shape.size, shape.y + shape.size);
      ctx.lineTo(shape.x - shape.size, shape.y + shape.size);
      ctx.closePath();
    }
    ctx.fill();
  }

  site.get('api/shapes').then(function (res) {
    if (!res.ok) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    res.data.shapes.forEach(draw);
  });

  canvas.addEventListener('click', function (event) {
    var box = canvas.getBoundingClientRect();
    // The board may be drawn smaller than its own size on a narrow screen: scale back to the board's coordinates.
    var x = Math.round(((event.clientX - box.left) / box.width) * canvas.width);
    var y = Math.round(((event.clientY - box.top) / box.height) * canvas.height);
    site.post('api/click', { x: Math.max(0, Math.min(canvas.width, x)), y: Math.max(0, Math.min(canvas.height, y)) }).then(function (res) {
      if (res.ok) status.textContent = res.data.selected ? 'A shape is selected.' : 'Nothing is selected.';
    });
  });
})();
