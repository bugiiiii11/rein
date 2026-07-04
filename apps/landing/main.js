/* Rein landing — zero-dependency behavior layer.
   Classic script (no modules) so it runs from file:// and any static host. */
(function () {
  'use strict';

  // ?static renders everything immediately (crawlers, print, screenshots)
  var staticMode = /[?&]static\b/.test(window.location.search);
  var reducedMotion =
    staticMode || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Reveal on scroll ──────────────────────────────────────────────────── */
  var revealed = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealed.forEach(function (el) {
      el.classList.add('in');
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealed.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ── Copy install command ──────────────────────────────────────────────── */
  var INSTALL = 'npm install @reinconsole/sdk';
  function wireCopy(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', function () {
      function done() {
        btn.classList.add('copied');
        btn.textContent = 'copied';
        setTimeout(function () {
          btn.classList.remove('copied');
          btn.textContent = 'copy';
        }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(INSTALL).then(done, function () {
          fallbackCopy(done);
        });
      } else {
        fallbackCopy(done);
      }
    });
  }
  function fallbackCopy(done) {
    var ta = document.createElement('textarea');
    ta.value = INSTALL;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      /* clipboard unavailable — the command is visible to select by hand */
    }
    document.body.removeChild(ta);
  }
  wireCopy('copyBtn');
  wireCopy('copyBtn2');

  /* ── Live feed loop ────────────────────────────────────────────────────── */
  var feed = document.getElementById('feed');
  var panel = document.getElementById('feedPanel');
  if (!feed || !panel || reducedMotion) return;

  // Restamp the seeded rows so history reads as "moments ago", not hardcoded.
  (function restamp() {
    var seeded = feed.querySelectorAll('.feed-time');
    for (var i = 0; i < seeded.length; i++) {
      var d = new Date(Date.now() - (i + 1) * 7000);
      seeded[i].textContent =
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
  })();

  // A looping storyline in the console's own event language. All plausible,
  // none claiming to be the live console (that's what "See it live" is for).
  var SCRIPT = [
    { kind: 'allow',   verb: 'ALLOW',   amt: '$0.25',   host: 'api.translate.example',  right: 'within budget',        wait: 1900 },
    { kind: 'settled', verb: 'SETTLED', amt: '$0.25',   host: 'api.translate.example',  right: 'base-sepolia',         wait: 2600 },
    { kind: 'shadow',  verb: 'SHADOW',  amt: '$42.00',  host: 'wallet 0x9f31…c2ae',     right: 'unguarded transfer',   wait: 1400, flash: true },
    { kind: 'frozen',  verb: 'FROZEN',  amt: '',        host: 'agent research-scout',   right: 'kill switch engaged',  wait: 3200 },
    { kind: 'refused', verb: 'REFUSED', amt: '$0.10',   host: 'payer 0x3c11…88d0',      right: 'reputation 31 < 40',   wait: 2400 },
    { kind: 'allow',   verb: 'ALLOW',   amt: '$0.05',   host: 'api.research.example',   right: 'within budget',        wait: 1200 },
    { kind: 'settled', verb: 'SETTLED', amt: '$0.05',   host: 'api.research.example',   right: 'tx 0x73c2…0689',       wait: 2800 },
    { kind: 'deny',    verb: 'DENY',    amt: '$180.00', host: 'premium-intel.example',  right: 'over per-tx cap',      wait: 2300 },
    { kind: 'allow',   verb: 'ALLOW',   amt: '$0.02',   host: 'api.quotes.example',     right: 'vendor score 87',      wait: 1500 },
    { kind: 'settled', verb: 'SETTLED', amt: '$0.02',   host: 'api.quotes.example',     right: 'base-sepolia',         wait: 3000 },
  ];
  var MAX_ROWS = 7;
  var idx = 0;
  var running = false;
  var timer = null;

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  function clock() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function pushRow(item) {
    var li = document.createElement('li');
    li.className = 'feed-row enter';
    li.setAttribute('data-kind', item.kind);

    var time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = clock();

    var main = document.createElement('span');
    main.className = 'feed-main';
    var verb = document.createElement('span');
    verb.className = 'feed-verb ' + item.kind;
    verb.textContent = item.verb;
    main.appendChild(verb);
    if (item.amt) {
      var amt = document.createElement('b');
      amt.className = 'feed-amt';
      amt.textContent = item.amt;
      main.appendChild(document.createTextNode(' '));
      main.appendChild(amt);
    }
    var arrow = document.createElement('span');
    arrow.className = 'feed-arrow';
    arrow.textContent = ' → ';
    main.appendChild(arrow);
    var host = document.createElement('span');
    host.className = 'feed-host';
    host.textContent = item.host;
    main.appendChild(host);

    var right = document.createElement('span');
    right.className = 'feed-right';
    right.textContent = item.right;

    li.appendChild(time);
    li.appendChild(main);
    li.appendChild(right);
    feed.insertBefore(li, feed.firstChild);

    while (feed.children.length > MAX_ROWS) {
      feed.removeChild(feed.lastChild);
    }

    if (item.flash) {
      panel.classList.remove('flash');
      // restart the animation
      void panel.offsetWidth;
      panel.classList.add('flash');
    }
  }

  function tick() {
    var item = SCRIPT[idx % SCRIPT.length];
    idx += 1;
    pushRow(item);
    timer = setTimeout(tick, item.wait);
  }

  // Only animate while the panel is on screen.
  var feedIo = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !running) {
          running = true;
          timer = setTimeout(tick, 1200);
        } else if (!entry.isIntersecting && running) {
          running = false;
          clearTimeout(timer);
        }
      });
    },
    { threshold: 0.25 }
  );
  feedIo.observe(panel);
})();
