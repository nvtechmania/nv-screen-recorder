(() => {
  'use strict';

  const nv = window.nv;
  const $ = (id) => document.getElementById(id);

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  nv.onMini((s) => {
    const dot = $('dot');
    const label = $('label');
    const time = $('time');
    const pause = $('pause');
    const stop = $('stop');

    dot.className = 'dot';

    switch (s.state) {
      case 'prepare':
        dot.classList.add('wait');
        label.textContent = 'Getting ready';
        time.textContent = '';
        pause.disabled = true;
        stop.disabled = true;
        break;
      case 'countdown':
        dot.classList.add('wait');
        label.textContent = 'Starting in ' + s.sec;
        time.textContent = '';
        pause.disabled = true;
        stop.disabled = false;
        break;
      case 'paused':
        dot.classList.add('paused');
        label.textContent = 'Paused';
        time.textContent = fmt(s.sec);
        pause.disabled = false;
        stop.disabled = false;
        break;
      default:
        label.textContent = 'Recording';
        time.textContent = fmt(s.sec);
        pause.disabled = false;
        stop.disabled = false;
    }
  });

  $('pause').addEventListener('click', () => nv.miniCmd('pause'));
  $('stop').addEventListener('click', () => nv.miniCmd('stop'));
})();
