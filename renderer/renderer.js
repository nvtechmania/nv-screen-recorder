(() => {
  'use strict';

  const nv = window.nv;
  const $ = (id) => document.getElementById(id);

  const QUALITY = { low: 1500000, balanced: 4000000, high: 8000000, ultra: 16000000 };
  const RES = { original: { w: 3840, h: 2160 }, '1080': { w: 1920, h: 1080 }, '720': { w: 1280, h: 720 } };

  const STATUS = {
    idle: 'Ready',
    preparing: 'Getting ready...',
    countdown: 'Starting...',
    recording: 'Recording',
    paused: 'Paused',
    stopping: 'Saving...'
  };

  let settings = {};
  let sources = [];
  let selectedId = null;

  let state = 'idle'; // idle | preparing | countdown | recording | paused | stopping
  let rec = null;
  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
  let outStream = null;
  let writeChain = Promise.resolve();
  let startTs = 0;
  let pausedTotal = 0;
  let pauseStart = 0;
  let tickId = null;
  let cancelRequested = false;
  let stopNote = '';
  let lastResult = null;
  let toastTimer = null;

  /* ------------------------------------------------------- helpers -- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function fmtSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function elapsedSec() {
    if (!startTs) return 0;
    const now = state === 'paused' ? pauseStart : performance.now();
    return Math.max(0, Math.floor((now - startTs - pausedTotal) / 1000));
  }

  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 4000);
  }

  function save(patch) {
    settings = { ...settings, ...patch };
    nv.setSettings(patch);
  }

  /* ----------------------------------------------------------- UI -- */

  function render() {
    document.body.dataset.state = state;
    const active = state !== 'idle';
    const rb = $('recBtn');
    const pb = $('pauseBtn');

    if (state === 'idle') rb.textContent = '● Start Recording';
    else if (state === 'countdown' || state === 'preparing') rb.textContent = 'Cancel';
    else rb.textContent = '■ Stop Recording';

    rb.classList.toggle('stop', active);
    rb.disabled = state === 'stopping' || state === 'preparing';
    pb.disabled = !(state === 'recording' || state === 'paused');
    pb.textContent = state === 'paused' ? 'Resume' : 'Pause';

    $('status').textContent = STATUS[state] || '';
    $('timer').textContent = fmt(elapsedSec());
  }

  function renderSources() {
    const box = $('sources');
    box.textContent = '';
    if (!sources.length) {
      const d = document.createElement('div');
      d.className = 'loading';
      d.textContent = 'No screens found. Press Refresh.';
      box.appendChild(d);
      return;
    }
    for (const s of sources) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'src' + (s.id === selectedId ? ' sel' : '');
      b.dataset.id = s.id;

      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (s.thumb) img.src = s.thumb;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.name;
      name.title = s.name;
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = s.isScreen ? 'Full screen' : 'Window';
      meta.append(name, kind);

      b.append(img, meta);
      b.addEventListener('click', () => {
        selectedId = s.id;
        box.querySelectorAll('.src').forEach((el) => el.classList.toggle('sel', el.dataset.id === selectedId));
      });
      box.appendChild(b);
    }
  }

  async function refreshSources() {
    const box = $('sources');
    box.textContent = '';
    const d = document.createElement('div');
    d.className = 'loading';
    d.textContent = 'Looking for screens and windows...';
    box.appendChild(d);
    try {
      sources = await nv.listSources();
    } catch (e) {
      sources = [];
    }
    if (!sources.some((s) => s.id === selectedId)) {
      const firstScreen = sources.find((s) => s.isScreen) || sources[0];
      selectedId = firstScreen ? firstScreen.id : null;
    }
    renderSources();
  }

  async function refreshMics() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
      let mics = devices.filter((d) => d.kind === 'audioinput');
      if (mics.length && !mics[0].label) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
    } catch (_) { /* no mic permission or no mic */ }

    const sel = $('micDevice');
    sel.textContent = '';
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = 'Default microphone';
    sel.appendChild(def);
    devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || 'Microphone ' + (i + 1);
        sel.appendChild(o);
      });
    sel.value = [...sel.options].some((o) => o.value === settings.micDeviceId) ? settings.micDeviceId : 'default';
  }

  function showResult(info, secs) {
    lastResult = info;
    const name = info.path.split(/[\\/]/).pop();
    $('resName').textContent = name;
    $('resMeta').textContent = `${fmtSize(info.size)}  ·  ${fmt(secs)}  ·  saved in your recordings folder`;
    $('result').classList.remove('hidden');
    $('main').scrollTo({ top: $('main').scrollHeight, behavior: 'smooth' });
  }

  function hideResult() {
    $('result').classList.add('hidden');
  }

  /* --------------------------------------------------- recording -- */

  function pickMime() {
    const mp4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'];
    const webm = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const order = settings.format === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
    return order.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  function cleanupStreams() {
    [displayStream, micStream, outStream].forEach((s) => {
      if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    });
    displayStream = micStream = outStream = null;
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
  }

  function sendUi() {
    nv.uiState({ state: state === 'paused' ? 'paused' : 'recording', sec: elapsedSec() });
  }

  function startTick() {
    clearInterval(tickId);
    tickId = setInterval(() => {
      $('timer').textContent = fmt(elapsedSec());
      sendUi();
    }, 1000);
  }

  async function abortStart(message) {
    clearInterval(tickId);
    cleanupStreams();
    try { await nv.recAbort(); } catch (_) {}
    rec = null;
    state = 'idle';
    startTs = 0;
    render();
    nv.uiState({ state: 'idle' });
    if (message) toast(message, 'error');
  }

  async function startRecording() {
    if (state !== 'idle') return;
    if (!selectedId) {
      toast('Pick a screen or window first.', 'warn');
      return;
    }

    hideResult();
    cancelRequested = false;
    state = 'preparing';
    startTs = 0;
    pausedTotal = 0;
    render();
    nv.uiState({ state: 'prepare' });

    try {
      await nv.selectSource(selectedId, !!settings.systemAudio);

      const fps = Number(settings.fps) || 30;
      const res = RES[settings.resolution] || RES.original;

      // Screen + cursor (+ system audio when enabled). Requested first, while the
      // click / hotkey is still fresh.
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: fps, max: fps },
          width: { max: res.w },
          height: { max: res.h },
          cursor: 'always'
        },
        audio: !!settings.systemAudio
      });

      // Microphone.
      let micFailed = false;
      if (settings.micAudio) {
        try {
          const dev = settings.micDeviceId && settings.micDeviceId !== 'default'
            ? { exact: settings.micDeviceId } : undefined;
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: dev, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (_) {
          micStream = null;
          micFailed = true;
        }
      }

      // One clean audio track. Mix only when both sources exist.
      const sysTracks = displayStream.getAudioTracks();
      const micTracks = micStream ? micStream.getAudioTracks() : [];
      let audioTracks;
      if (sysTracks.length && micTracks.length) {
        audioCtx = new AudioContext({ sampleRate: 48000 });
        await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();
        const sysGain = audioCtx.createGain();
        const micGain = audioCtx.createGain();
        sysGain.gain.value = 0.9;
        micGain.gain.value = 1.0;
        audioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(sysGain).connect(dest);
        audioCtx.createMediaStreamSource(new MediaStream(micTracks)).connect(micGain).connect(dest);
        audioTracks = dest.stream.getAudioTracks();
      } else {
        audioTracks = sysTracks.length ? sysTracks : micTracks;
      }

      const videoTrack = displayStream.getVideoTracks()[0];
      outStream = new MediaStream([videoTrack, ...audioTracks]);

      videoTrack.addEventListener('ended', () => {
        if (state === 'recording' || state === 'paused') stopRecording('The recorded window was closed, so recording was stopped.');
      });

      const mime = pickMime();
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

      rec = new MediaRecorder(outStream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: QUALITY[settings.quality] || QUALITY.balanced,
        audioBitsPerSecond: 128000
      });

      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        writeChain = writeChain
          .then(async () => { nv.recChunk(await e.data.arrayBuffer()); })
          .catch(() => {});
      };
      rec.onerror = (e) => {
        toast('Recorder error: ' + ((e.error && e.error.message) || 'unknown'), 'error');
        stopRecording();
      };
      rec.onstop = finalizeRecording;

      writeChain = Promise.resolve();
      await nv.recStart(ext);

      // Optional countdown (shown in the small bar, not recorded).
      const cd = Number(settings.countdown) || 0;
      if (cd > 0) {
        state = 'countdown';
        render();
        for (let i = cd; i > 0 && !cancelRequested; i--) {
          nv.uiState({ state: 'countdown', sec: i });
          $('status').textContent = `Starting in ${i}...`;
          await sleep(1000);
        }
        if (cancelRequested) {
          await abortStart();
          return;
        }
      }

      rec.start(1000); // a chunk every second -> written straight to disk
      startTs = performance.now();
      pausedTotal = 0;
      state = 'recording';
      render();
      sendUi();
      startTick();

      if (micFailed) toast('Microphone not available - recording without your voice.', 'warn');
      else if (settings.systemAudio && !sysTracks.length) toast('System audio could not be captured - recording without it.', 'warn');
    } catch (err) {
      const msg = err && err.name === 'NotAllowedError'
        ? 'Screen capture was blocked by Windows.'
        : 'Could not start recording: ' + ((err && err.message) || err);
      await abortStart(msg);
    }
  }

  function togglePause() {
    if (!rec) return;
    if (state === 'recording') {
      rec.pause();
      pauseStart = performance.now();
      state = 'paused';
    } else if (state === 'paused') {
      rec.resume();
      pausedTotal += performance.now() - pauseStart;
      state = 'recording';
    } else {
      return;
    }
    render();
    sendUi();
  }

  function stopRecording(note) {
    if (state === 'countdown' || state === 'preparing') {
      cancelRequested = true;
      return;
    }
    if (!rec || (state !== 'recording' && state !== 'paused')) return;
    stopNote = note || '';
    if (state === 'paused') pausedTotal += performance.now() - pauseStart;
    const secs = elapsedSec();
    clearInterval(tickId);
    state = 'stopping';
    render();
    $('timer').textContent = fmt(secs);
    try {
      rec.stop();
    } catch (_) {
      finalizeRecording();
    }
  }

  async function finalizeRecording() {
    const secs = elapsedSec();
    clearInterval(tickId);
    await writeChain; // make sure every chunk reached the disk
    cleanupStreams();

    let info = null;
    try { info = await nv.recStop(); } catch (_) {}

    rec = null;
    state = 'idle';
    startTs = 0;
    render();
    $('timer').textContent = fmt(secs);
    nv.uiState({ state: 'idle' });

    if (info && info.size > 0) {
      showResult(info, secs);
      if (stopNote) toast(stopNote, 'warn');
    } else {
      toast('Nothing was recorded.', 'warn');
    }
    stopNote = '';
  }

  /* ----------------------------------------------------- commands -- */

  // Called by the main process (hotkeys, tray, and the small control bar).
  window.nvCmd = (cmd) => {
    if (cmd === 'toggle') {
      if (state === 'idle') startRecording();
      else stopRecording();
    } else if (cmd === 'pause') {
      togglePause();
    } else if (cmd === 'stop') {
      stopRecording();
    }
  };

  /* --------------------------------------------------------- init -- */

  function bindUi() {
    $('refresh').addEventListener('click', refreshSources);

    $('sysAudio').addEventListener('change', (e) => save({ systemAudio: e.target.checked }));
    $('micAudio').addEventListener('change', async (e) => {
      save({ micAudio: e.target.checked });
      $('micDevice').disabled = !e.target.checked;
      if (e.target.checked) await refreshMics();
    });
    $('micDevice').addEventListener('change', (e) => save({ micDeviceId: e.target.value }));

    ['fps', 'quality', 'resolution', 'format'].forEach((id) => {
      $(id).addEventListener('change', (e) => save({ [id]: e.target.value }));
    });
    $('countdown').addEventListener('change', (e) => save({ countdown: Number(e.target.value) }));

    $('changeDir').addEventListener('click', async () => {
      const dir = await nv.chooseDir();
      if (dir) {
        settings.outputDir = dir;
        $('dir').textContent = dir;
        $('dir').title = dir;
      }
    });
    $('openDir').addEventListener('click', () => nv.openDir());

    $('recBtn').addEventListener('click', () => {
      if (state === 'idle') startRecording();
      else stopRecording();
    });
    $('pauseBtn').addEventListener('click', togglePause);

    $('resPlay').addEventListener('click', () => lastResult && nv.openFile(lastResult.path));
    $('resShow').addEventListener('click', () => lastResult && nv.revealFile(lastResult.path));
    $('resClose').addEventListener('click', hideResult);

    nv.onRecError((m) => {
      toast('Could not write the file: ' + m, 'error');
      stopRecording();
    });
  }

  function applySettings() {
    $('sysAudio').checked = !!settings.systemAudio;
    $('micAudio').checked = !!settings.micAudio;
    $('micDevice').disabled = !settings.micAudio;
    $('fps').value = String(settings.fps);
    $('quality').value = settings.quality;
    $('resolution').value = settings.resolution;
    $('countdown').value = String(settings.countdown);
    $('format').value = settings.format;
    $('dir').textContent = settings.outputDir;
    $('dir').title = settings.outputDir;
  }

  async function init() {
    try {
      const info = await nv.appInfo();
      $('ver').textContent = 'v' + info.version;
    } catch (_) {}
    settings = await nv.getSettings();
    applySettings();
    bindUi();
    render();
    await refreshSources();
    if (settings.micAudio) await refreshMics();
    else {
      const def = document.createElement('option');
      def.value = 'default';
      def.textContent = 'Default microphone';
      $('micDevice').appendChild(def);
    }
  }

  init();
})();
