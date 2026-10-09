/* Connext landing page: the video player and the form. No libraries, no tracking. */
(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     Where the form goes (see README.md, "Where the sign-ups go").
     endpoint : '/api/notify' is the sign-up endpoint of server.js, which saves each sign-up in your
                Railway database. If the page is hosted somewhere without that server, put the URL of a
                form service here instead (Formspree, for example: https://formspree.io/f/xxxxxxx).
                The form is sent as JSON and a 2xx answer means success.
     email    : used only if endpoint is empty; the visitor's mail app opens with the message ready.
     ------------------------------------------------------------------------ */
  const CONFIG = {
    endpoint: '/api/notify',
    email: '',
  };

  const VIDEO = {
    large: 'assets/video/connext-pitch-1080.mp4',
    small: 'assets/video/connext-pitch-720.mp4',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ the video */
  function initPlayer() {
    const player = $('[data-player]');
    const video = $('.player__video', player);
    if (!player || !video) return;

    const big = $('.player__big', player);
    const soundPill = $('.player__sound', player);
    const seek = $('.pseek', player);
    const now = $('[data-time="now"]', player);
    const total = $('[data-time="total"]', player);
    const errorBox = $('.player__error', player);
    const btnToggle = $('[data-act="toggle"]', player);
    const btnMute = $('[data-act="mute"]', player);
    const btnFull = $('[data-act="fullscreen"]', player);

    // phones, slow connections and data-saver get the lighter file
    const connection = navigator.connection || {};
    const light = window.innerWidth < 820 || connection.saveData || /(^|-)2g|3g/.test(connection.effectiveType || '');
    video.src = light ? VIDEO.small : VIDEO.large;
    video.muted = true;

    const fmt = (s) => {
      if (!Number.isFinite(s)) return '0:00';
      const m = Math.floor(s / 60);
      return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    };

    let userPaused = false;
    let idleTimer = 0;
    let dragging = false;

    const sync = () => {
      const paused = video.paused;
      player.classList.toggle('is-paused', paused);
      player.classList.toggle('is-muted', video.muted);
      btnToggle.setAttribute('aria-label', paused ? 'Play' : 'Pause');
      btnMute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
      big.hidden = !paused;
      // "Play with sound" is offered while the video plays silently, until the visitor has chosen
      soundPill.hidden = paused || !video.muted || player.dataset.soundChosen === '1';
    };

    const wake = () => {
      player.classList.remove('is-idle');
      clearTimeout(idleTimer);
      if (!video.paused && !dragging) idleTimer = setTimeout(() => player.classList.add('is-idle'), 2600);
    };

    const play = () => {
      const attempt = video.play();
      if (attempt && attempt.catch) attempt.catch(() => { sync(); });
    };

    const toggle = () => {
      if (video.paused) { userPaused = false; play(); } else { userPaused = true; video.pause(); }
    };

    const setMuted = (muted) => {
      video.muted = muted;
      player.dataset.soundChosen = '1';
      sync();
    };

    // progress
    const paint = () => {
      const d = video.duration || 0;
      const p = d ? video.currentTime / d : 0;
      if (!dragging) seek.value = String(Math.round(p * 1000));
      seek.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
      now.textContent = fmt(video.currentTime);
      total.textContent = fmt(d);
      seek.setAttribute('aria-valuetext', `${fmt(video.currentTime)} of ${fmt(d)}`);
    };
    let raf = 0;
    const loop = () => { paint(); if (!video.paused) raf = requestAnimationFrame(loop); };
    video.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); sync(); wake(); });
    video.addEventListener('pause', () => { cancelAnimationFrame(raf); paint(); sync(); wake(); });
    video.addEventListener('timeupdate', () => { if (video.paused) paint(); });
    video.addEventListener('loadedmetadata', paint);
    video.addEventListener('durationchange', paint);
    video.addEventListener('volumechange', sync);
    video.addEventListener('error', () => { errorBox.hidden = false; big.hidden = true; soundPill.hidden = true; });

    seek.addEventListener('input', () => {
      dragging = true;
      const d = video.duration || 0;
      if (d) video.currentTime = (Number(seek.value) / 1000) * d;
      seek.style.setProperty('--p', `${(Number(seek.value) / 10).toFixed(2)}%`);
      now.textContent = fmt(video.currentTime);
    });
    seek.addEventListener('change', () => { dragging = false; wake(); });

    // controls
    btnToggle.addEventListener('click', toggle);
    big.addEventListener('click', toggle);
    video.addEventListener('click', toggle);
    btnMute.addEventListener('click', () => setMuted(!video.muted));
    soundPill.addEventListener('click', () => {
      // start again from the beginning, this time with sound
      video.currentTime = 0;
      setMuted(false);
      userPaused = false;
      play();
    });
    btnFull.addEventListener('click', () => {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      if (player.requestFullscreen) player.requestFullscreen();
      else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();   // iPhone
    });

    // keyboard, when the player has focus
    player.addEventListener('keydown', (e) => {
      if (e.target === seek && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'k') && e.target.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
      else if (k === 'm') setMuted(!video.muted);
      else if (k === 'f') btnFull.click();
      else if (e.key === 'ArrowRight') video.currentTime = Math.min((video.duration || 0), video.currentTime + 5);
      else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
    });
    ['mousemove', 'pointerdown', 'touchstart', 'focusin'].forEach((ev) => player.addEventListener(ev, wake, { passive: true }));
    player.addEventListener('mouseleave', () => { if (!video.paused) idleTimer = setTimeout(() => player.classList.add('is-idle'), 600); });
    player.tabIndex = 0;
    player.setAttribute('role', 'group');
    player.setAttribute('aria-label', 'Connext video player');

    // pause while it is off screen or the tab is hidden; carry on afterwards unless the visitor paused it
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) { if (!video.paused) video.pause(); }
        else if (!userPaused && video.paused && !reduceMotion && !video.error) play();
      }, { threshold: 0.2 }).observe(player);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (!video.paused) video.pause(); }
      else if (!userPaused && !reduceMotion && video.paused && !video.error) play();
    });

    // start: quiet autoplay (browsers allow it when muted); if blocked, or if the visitor prefers less motion, wait for a tap
    sync();
    if (reduceMotion) { userPaused = true; sync(); }
    else play();
  }

  /* ------------------------------------------------------------ the form */
  function initForm() {
    const card = $('#notify');
    const form = $('.form', card);
    const thanks = $('.thanks', card);
    if (!form) return;

    const submit = $('.btn', form);
    const status = $('.status', form);
    const fields = {
      name: { el: $('#f-name'), err: $('#e-name') },
      email: { el: $('#f-email'), err: $('#e-email') },
      phone: { el: $('#f-phone'), err: $('#e-phone') },
    };

    const rules = {
      name: (v) => (v.trim().length < 2 ? 'Please enter your name.' : ''),
      email: (v) => (!v.trim() ? 'Please enter your email.' : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? 'That email doesn’t look right.' : ''),
      phone: (v) => (!v.trim() ? '' : !/^[+()\d][\d\s().-]{6,18}$/.test(v.trim()) ? 'Please enter a valid phone number, or leave it empty.' : ''),
    };

    const show = (key, message) => {
      const { el, err } = fields[key];
      err.hidden = !message;
      err.textContent = message;
      if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    };
    Object.keys(fields).forEach((key) => {
      const { el } = fields[key];
      el.addEventListener('blur', () => { if (el.value || el.getAttribute('aria-invalid')) show(key, rules[key](el.value)); });
      el.addEventListener('input', () => { if (el.getAttribute('aria-invalid')) show(key, rules[key](el.value)); });
    });

    const setStatus = (message) => { status.hidden = !message; status.textContent = message || ''; };
    const setBusy = (busy) => { submit.classList.toggle('is-busy', busy); submit.disabled = busy; };

    const done = () => {
      card.style.minHeight = `${card.offsetHeight}px`;   // the card keeps its size, so nothing around it jumps
      form.hidden = true;
      thanks.hidden = false;
      $('h2', thanks).focus();
    };

    const send = async (data) => {
      if (CONFIG.endpoint) {
        const res = await fetch(CONFIG.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(Object.fromEntries(data)),
        });
        if (!res.ok) {
          const problem = new Error(`The form service answered ${res.status}`);
          problem.status = res.status;
          try { problem.detail = (await res.json()).error; } catch { /* no message in the answer */ }
          throw problem;
        }
        return;
      }
      if (CONFIG.email) {
        const text = [...data.entries()].filter(([k]) => !['website'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
        window.location.href = `mailto:${CONFIG.email}?subject=${encodeURIComponent('Connext website — new contact')}&body=${encodeURIComponent(text)}`;
        return;
      }
      // no form service connected yet: fine while previewing on your own computer, never on the live site
      if (['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname)) {
        await new Promise((r) => setTimeout(r, 700));
        console.info('[form] preview mode: not connected to a service. Set CONFIG.endpoint in assets/js/main.js.', Object.fromEntries(data));
        return;
      }
      throw new Error('The form is not connected to a service yet.');
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus('');

      let firstBad = null;
      Object.keys(fields).forEach((key) => {
        const message = rules[key](fields[key].el.value);
        show(key, message);
        if (message && !firstBad) firstBad = fields[key].el;
      });
      if (firstBad) { firstBad.focus(); return; }

      const data = new FormData(form);
      // a filled spam-trap means a bot: look successful, send nothing
      if (data.get('website')) { done(); return; }
      data.delete('website');
      data.set('page', location.href);
      data.set('sent_at', new Date().toISOString());

      setBusy(true);
      try {
        await send(data);
        form.reset();
        done();
      } catch (error) {
        console.error('[form]', error);
        setStatus(
          error.status === 429 ? 'You’ve tried a few times. Please wait a few minutes and try again.'
          : error.status === 422 && error.detail ? error.detail
          : 'Sorry, we couldn’t send that just now. Please try again in a moment.',
        );
      } finally {
        setBusy(false);
      }
    });

    $('[data-again]', thanks).addEventListener('click', () => {
      thanks.hidden = true;
      form.hidden = false;
      card.style.minHeight = '';
      fields.name.el.focus();
    });
  }

  /* ------------------------------------------------------------ small things */
  function initMisc() {
    const year = $('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());

    // the message block and the footer fade up as they arrive
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    const items = [...document.querySelectorAll('.message__copy > *, .card, .footer__grid > *')];
    items.forEach((el, i) => { el.classList.add('reveal'); el.style.setProperty('--d', `${Math.min(i % 4, 3) * 0.08}s`); });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach((el) => io.observe(el));
  }

  initPlayer();
  initForm();
  initMisc();
})();
