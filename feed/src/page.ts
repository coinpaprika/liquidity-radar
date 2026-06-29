// The public landing page. Self-contained HTML + CSS + JS (no external libs),
// served at / by the worker. It polls /api/live every second and renders a
// LIVING dashboard: every streamed pool overlaid as one line (normalized to %
// change from the window start, so a $20k pool and a $2M pool share one axis),
// the whole field scrolling left in real time so it glides tick-by-tick. A
// pool climbing is a green line rising; a pool draining stabs down in red.
// Around it: a radar sweep, a scanline, pulsing leading dots, a live ticker,
// numbers that count up, and rows that flash and reorder. Brand: #00ff88 neon (DexPaprika app palette).

export const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiquidityRadar: watch DEX liquidity build and rug, live</title>
<meta name="description" content="Real-time DEX liquidity, live. Dozens of pools streamed at once: watch liquidity climb and get drained the block it happens, on the free DexPaprika reserve stream.">
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAADPklEQVRYhb2XbUhTURjHT0lGorlejEnMyrfUbR8kV0nQO1YYWU4lX0pQWISIafohIcRIEZ26SdtEJ6Ny+6ASWIxZyFCaCRH2oW8rKZkiu4MQoiV6tyeeCw2beq9zuzvwfLnnnvP/nee8/glZUwwGQ9XU1NSc0+mkwa/09fVBSnLKlsNut/va0jQN2KfNZvvR39uvIP5FrVbvHh8f/+L1emFhYQEGBwdB2aGEjvYOX5SVlgUE0Pio0ddWqVSCyWSCxcVFQI0xy9jnpqamSB8Ains8Huju6ob0tPSAhAKJjPQM0Gg0DITZbJ5hxAcGBqowTSjOl7B/6LQ6wAFrn2kryPSH6TlMO58j9w+JWAIURcHExMQsoSiKxjkPVeeH72RDtKUE9nyqhESZeNP/hoeHYd4xv0pwheJCCRVA3NOrkJglhgNduRD35Mqm/6lVanC73UBw/tva2kKe5lhTAcS1XNu0vrOzE1ZWVkILkHAjCw49zgHBczkQbwMIa86HB0D44AJEuKqBQMN/Iay/xA2wtLQEzc3N2xZPkqbBzl+168Qx8PvRy5kbtmttaQWXywUk2LQLH17cUPxf4HSwtSfBAkTZylkBot+V8Qdw7IwUCF3PChDzupg/gIPtuaziGPt68/gDiLTf4wRg24pBASTclHGK7/hTB0knxDwApKZCtLmEE0DwsoCzLxKo+JGcTOai4RKPoKqZOyEoAMELOUT8rGFuN4EhH6Lel3OueuYA+l0LosJTWxoQYavcr83jFNto5CL5yS1nlLBVJkvSINZYAMTDPWrm0HlbConZ0oCmlOBbQJ7PflwmXM+Cva9uw0533fp0u+sg5k0xiIpOByRcVFjEXIIkkNsw+XgqiG7JIP7+WYivOgeifBlzGW1nJ/HyHkjZDgBN04wHCDeA70nmdDppo9EYdoCRkRFwOByrxGazfUfHIs7gPjRCFVKJlHmMWK3Wr0Sv11egU0HHEi4Afb+eMSYqlaqccUfo1RACHQuaBj5HjuJYRkdHP/q8IRpFi8Uyg1ToWIaGhkDVrQqZOcW+cM4x7aiB4gqFYtc6l6zT6ConJydn0bHg7giVPV9eXmZckNVq/dbT03N3reZfR9UdchH9px8AAAAASUVORK5CYII=">
<meta name="theme-color" content="#00FF75">
<meta property="og:type" content="website">
<meta property="og:title" content="LiquidityRadar: DEX liquidity, live">
<meta property="og:description" content="Dozens of pools streamed at once. Watch liquidity climb and get drained the block it happens, on DexPaprika's free reserve stream.">
<meta property="og:image" content="https://docs.dexpaprika.com/images/brand/dexpaprika-banner-1200x675.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="LiquidityRadar: DEX liquidity, live">
<meta name="twitter:description" content="Watch DEX liquidity build and rug, live. Powered by DexPaprika.">
<meta name="twitter:image" content="https://docs.dexpaprika.com/images/brand/dexpaprika-banner-1200x675.png">
<style>
  :root{--green:#00ff88;--green-h:#33ffaa;--bg:#050507;--bg2:#0a0b0f;--surface:#0f1018;--s3:#141620;--border:#2a2d42;--border-act:#3a3d58;--ink:#e2e8f0;--mut:#8494a7;--red:#ff4d6d;--warn:#fbbf24;--r:10px;--rs:6px;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
  @font-face{font-family:'DM Sans';src:url('https://static.dexpaprika.com/dexpaprika-static/assets/fonts/DMSans.woff2') format('woff2');font-weight:100 900;font-display:swap}
  @font-face{font-family:'JetBrains Mono';src:url('https://static.dexpaprika.com/dexpaprika-static/assets/fonts/JetBrainsMono.woff2') format('woff2');font-weight:100 900;font-display:swap}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:'DM Sans',ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  a{color:var(--green);text-decoration:none}a:hover{color:var(--green-h)}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 18px 64px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .logo{font-weight:800;font-size:1.5em;letter-spacing:.5px}
  .logo b{color:var(--green)}
  .tag{color:var(--mut);font-size:.95em}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mut);font-size:.85em}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(0,255,136,.6);animation:p 1.6s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(0,255,136,.5)}70%{box-shadow:0 0 0 9px rgba(0,255,136,0)}100%{box-shadow:0 0 0 0 rgba(0,255,136,0)}}
  /* the radar disc: an always-sweeping liveness motif (it is a radar, after all) */
  .radar{position:relative;width:50px;height:50px;border-radius:50%;flex-shrink:0;overflow:hidden;
    background:radial-gradient(circle,rgba(0,255,136,.10),transparent 72%);border:1px solid rgba(0,255,136,.28)}
  .radar::before{content:"";position:absolute;inset:0;border-radius:50%;
    background:repeating-radial-gradient(circle,transparent 0 7px,rgba(0,255,136,.10) 7px 8px)}
  .radar::after{content:"";position:absolute;inset:-25%;
    background:conic-gradient(from 0deg,rgba(0,255,136,.55),rgba(0,255,136,0) 26%);animation:sweep 3.2s linear infinite}
  @keyframes sweep{to{transform:rotate(360deg)}}
  .tape{margin-top:14px;overflow:hidden;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:7px 0;font-size:.8em;color:var(--mut);white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}
  .tape .run{display:inline-block;will-change:transform;animation:marq 42s linear infinite}
  .tape:hover .run{animation-play-state:paused}
  @keyframes marq{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  .tape .chip{margin:0 16px}.tape .chip b{color:var(--green);font-family:var(--mono);font-variant-numeric:tabular-nums}.tape .chip.dn b{color:var(--red)}
  .hero{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin:18px 0;position:relative}
  .hero .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .hero h2{margin:0;font-size:1.05em}
  .hero .sub{color:var(--mut);font-size:.85em}
  .chg{font-weight:700;font-family:var(--mono)}.up{color:var(--green)}.down{color:var(--red)}
  .chartwrap{position:relative;border-radius:var(--r);overflow:hidden;background:var(--bg2);border:1px solid var(--border)}
  .chartwrap svg{width:100%;height:340px;display:block}
  .gridbg{position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(132,148,167,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(132,148,167,.06) 1px,transparent 1px);
    background-size:100% 38px,76px 100%}
  .scanx{position:absolute;top:0;bottom:0;width:140px;pointer-events:none;
    background:linear-gradient(90deg,transparent,rgba(0,255,136,.07),transparent);animation:scanx 4.5s linear infinite}
  @keyframes scanx{0%{left:-140px}100%{left:100%}}
  .yl{position:absolute;left:6px;transform:translateY(-50%);font-size:.72em;color:var(--mut);font-family:var(--mono);font-variant-numeric:tabular-nums;pointer-events:none;background:rgba(5,5,7,.72);padding:0 4px;border-radius:3px;z-index:2}
  .chartwrap svg{cursor:crosshair}
  .tip{position:absolute;pointer-events:none;display:none;z-index:3;background:rgba(10,11,15,.97);border:1px solid var(--green);border-radius:var(--rs);padding:5px 9px;font-size:.8em;white-space:nowrap;transform:translate(-50%,calc(-100% - 12px));box-shadow:0 4px 16px rgba(0,0,0,.5)}
  .tip b{color:var(--green)}.tip .dn{color:var(--red)}.tip .sub{color:var(--mut);font-size:.85em}
  .xaxis{display:flex;justify-content:space-between;font-size:.72em;color:var(--mut);margin-top:5px;padding:0 2px}
  .cap{color:var(--mut);font-size:.83em;margin-top:8px;line-height:1.55}
  .cap b{color:var(--ink)}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:.82em;color:var(--mut)}
  .legend .lg{display:flex;align-items:center;gap:6px}
  a.lg{color:inherit;text-decoration:none}
  a.lg:hover{color:var(--green)}
  .more{cursor:pointer;color:var(--green);white-space:nowrap;font-weight:600;user-select:none}
  .more:hover{text-decoration:underline}
  .legend .sw{width:14px;height:3px;border-radius:2px;display:inline-block}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:18px}
  .disc{color:var(--mut);font-size:.78em;margin-top:8px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px}
  .card h3{margin:0 0 10px;font-size:.95em;display:flex;align-items:center;gap:8px}
  .ic{width:1.15em;height:1.15em;flex-shrink:0;display:inline-block;vertical-align:-.2em}
  .row{display:flex;align-items:baseline;gap:8px;padding:7px 6px;margin:0 -6px;border-bottom:1px solid var(--border);font-size:.92em;border-radius:var(--rs)}
  a.row{color:inherit;text-decoration:none;cursor:pointer}
  a.row:hover{background:rgba(0,255,136,.07)}
  a.row::after{content:"↗";margin-left:6px;color:var(--mut);opacity:.35;font-size:.85em;align-self:center}
  a.row:hover::after{opacity:.9;color:var(--green)}
  .row:last-child{border-bottom:none}
  .row .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .chain{color:var(--mut);font-size:.82em}
  .row .val{margin-left:auto;font-weight:700;font-family:var(--mono);font-variant-numeric:tabular-nums}
  .stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--mut);font-size:.85em;margin:16px 2px}
  .stats b{color:var(--ink);font-family:var(--mono);font-variant-numeric:tabular-nums}
  .hyp{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--green);border-radius:var(--r);padding:14px 16px;margin:18px 0}
  .hyp h3{margin:0 0 4px;font-size:.95em;display:flex;align-items:center;gap:8px}
  .hyp .q{color:var(--mut);font-size:.82em;font-style:italic}
  .hyp .nums{display:flex;gap:22px;flex-wrap:wrap;margin-top:10px;font-size:.9em}
  .hyp .nums b{color:var(--green);font-size:1.25em;font-family:var(--mono);font-variant-numeric:tabular-nums}
  .hyp .nums span{display:flex;flex-direction:column;gap:2px;color:var(--mut)}
  .cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  .btn{background:var(--green);color:#06301a;font-weight:700;padding:10px 16px;border-radius:var(--r)}
  .btn.alt{background:transparent;color:var(--green);border:1px solid var(--green)}
  footer{color:var(--mut);font-size:.85em;margin-top:26px}
  .empty{color:var(--mut);font-size:.9em;padding:8px 0}
  .brandby{display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:.82em}
  .dpcredit{display:inline-flex;align-items:center;gap:9px;color:var(--mut)}
  @media (prefers-reduced-motion:reduce){.radar::after,.scanx,.tape .run{animation:none}}
</style></head>
<body><div class="wrap">
  <header>
    <span class="radar" aria-hidden="true"></span>
    <span class="logo">Liquidity<b>Radar</b></span>
    <span class="tag">DEX liquidity, live</span>
    <a class="brandby" href="https://dexpaprika.com" target="_blank" rel="noopener" title="Powered by DexPaprika">by <svg viewBox="0 0 903 151" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DexPaprika" style="height:15px;width:auto;display:inline-block;vertical-align:middle">
<path d="M36.4777 90.0588C37.0957 89.7969 37.7687 89.6895 38.4382 89.7455C39.6296 89.7547 40.8073 89.9864 41.9094 90.4284C44.2407 91.4003 46.7334 91.9116 49.257 91.935C55.99 91.935 61.4149 88.0055 66.6612 84.2031L67.19 83.5167C67.6157 82.9608 68.0346 82.4082 68.4569 81.8488C69.638 78.6573 70.881 75.3284 71.9831 72.3805C74.802 64.8373 77.717 57.0334 80.4397 49.3083C80.9341 47.4572 82.0088 45.8124 83.5024 44.6122C84.9959 43.4125 86.8362 42.7206 88.7487 42.6369H89.2328H89.2637C92.1066 41.2319 95.2173 40.458 98.3864 40.3685C99.1624 40.3678 99.9383 40.4261 100.704 40.5435L100.755 40.5092C102.469 39.7418 103.955 38.5458 105.071 37.0372C106.187 35.5282 106.898 33.7574 107.128 31.8953C107.025 30.7872 106.507 29.7593 105.676 29.016C104.81 27.9865 103.581 27.3251 102.242 27.1663C101.15 27.1663 100.368 27.911 99.983 29.3146C99.5091 31.0545 98.8637 31.9365 98.0705 31.9365C97.4147 31.8431 96.8242 31.4955 96.419 30.9687C95.9589 30.4299 95.7186 29.735 95.7529 29.026C95.7838 28.3173 96.086 27.647 96.5941 27.1525C97.5727 26.1655 98.7332 25.3807 100.01 24.8436C101.291 24.3065 102.664 24.0275 104.052 24.0227H104.615C105.47 24.0927 106.304 24.3336 107.063 24.7317C107.822 25.1298 108.495 25.6765 109.037 26.3392C109.919 27.5132 110.544 28.8605 110.867 30.2926C111.19 31.7244 111.207 33.209 110.915 34.6476C110.829 35.4712 110.699 36.2915 110.572 37.0876C110.201 39.0637 110.016 41.0692 110.009 43.0796C110.026 43.941 110.057 44.72 110.101 45.4819C111.052 46.3364 111.949 47.239 112.848 48.2273C114.373 49.7843 115.502 51.6804 116.148 53.7594C116.9 57.3604 116.989 61.0675 116.412 64.7C115.959 73.8857 112.625 82.6958 106.884 89.8827C101.034 96.8099 93.686 102.324 85.3976 106.012C79.5264 108.859 73.0887 110.353 66.5617 110.384C57.1403 110.225 47.966 107.325 40.1652 102.038L39.7463 101.784C38.6202 101.21 37.6107 100.432 36.7695 99.4884C35.9627 98.8659 35.4133 97.9643 35.2279 96.9591C34.7095 96.1077 34.4073 95.1423 34.3455 94.1468C34.287 93.1512 34.4725 92.1563 34.8846 91.2486C35.3137 90.729 35.8597 90.3206 36.4777 90.0588Z" fill="#00FF75"/>
<path d="M225.214 116.682H196.002V34.3182H225.455C233.743 34.3182 240.878 35.9672 246.86 39.2648C252.842 42.5357 257.442 47.241 260.661 53.3809C263.907 59.5208 265.53 66.8669 265.53 75.4197C265.53 83.9992 263.907 91.3722 260.661 97.5388C257.442 103.705 252.815 108.438 246.78 111.735C240.771 115.033 233.583 116.682 225.214 116.682ZM213.424 101.761H224.489C229.639 101.761 233.971 100.85 237.485 99.0268C241.026 97.1767 243.682 94.3215 245.452 90.4607C247.249 86.5731 248.148 81.5592 248.148 75.4197C248.148 69.3334 247.249 64.36 245.452 60.4992C243.682 56.6384 241.039 53.7965 237.526 51.9732C234.012 50.1502 229.679 49.2387 224.529 49.2387H213.424V101.761Z" fill="white"/>
<path d="M277.303 116.682V34.3182H332.828V48.6755H294.725V68.3011H329.972V82.6584H294.725V102.324H332.989V116.682H277.303Z" fill="white"/>
<path d="M361.883 34.3182L378.498 62.3894H379.143L395.84 34.3182H415.518L390.367 75.5L416.081 116.682H396.043L379.143 88.5704H378.498L361.602 116.682H341.644L367.435 75.5L342.126 34.3182H361.883Z" fill="white"/>
<path d="M425.409 116.682V34.3182H457.917C464.17 34.3182 469.491 35.5114 473.893 37.8976C478.291 40.2569 481.646 43.5412 483.95 47.7507C486.284 51.933 487.452 56.7592 487.452 62.2285C487.452 67.6981 486.271 72.5239 483.912 76.7066C481.55 80.889 478.13 84.1465 473.649 86.4791C469.2 88.8117 463.806 89.9781 457.474 89.9781H436.753V76.0227H454.659C458.013 76.0227 460.774 75.4465 462.947 74.2934C465.148 73.1138 466.782 71.4916 467.857 69.4274C468.956 67.336 469.505 64.9365 469.505 62.2285C469.505 59.4936 468.956 57.1075 467.857 55.07C466.782 53.0055 465.148 51.4103 462.947 50.284C460.75 49.1313 457.958 48.5547 454.58 48.5547H442.831V116.682H425.409Z" fill="#00FF75"/>
<path d="M502.322 116.682H483.654L512.1 34.3182H534.552L562.957 116.682H544.289L523.647 53.1396H523.005L502.322 116.682ZM501.155 84.3074H545.254V97.9005H501.155V84.3074Z" fill="#00FF75"/>
<path d="M571.743 116.682V34.3182H604.255C610.504 34.3182 615.829 35.5114 620.227 37.8976C624.625 40.2569 627.98 43.5412 630.287 47.7507C632.618 51.933 633.786 56.7592 633.786 62.2285C633.786 67.6981 632.605 72.5239 630.246 76.7066C627.884 80.889 624.464 84.1465 619.987 86.4791C615.534 88.8117 610.14 89.9781 603.812 89.9781H583.091V76.0227H600.993C604.347 76.0227 607.111 75.4465 609.281 74.2934C611.482 73.1138 613.12 71.4916 614.191 69.4274C615.29 67.336 615.843 64.9365 615.843 62.2285C615.843 59.4936 615.29 57.1075 614.191 55.07C613.12 53.0055 611.482 51.4103 609.281 50.284C607.084 49.1313 604.292 48.5547 600.914 48.5547H589.165V116.682H571.743Z" fill="#00FF75"/>
<path d="M643.97 116.682V34.3182H676.481C682.703 34.3182 688.014 35.4308 692.412 37.6563C696.842 39.8547 700.206 42.978 702.514 47.0265C704.848 51.0483 706.012 55.7804 706.012 61.2229C706.012 66.6926 704.835 71.3979 702.472 75.339C700.114 79.2537 696.694 82.2562 692.213 84.3476C687.76 86.4389 682.37 87.4846 676.038 87.4846H654.27V73.4893H673.223C676.546 73.4893 679.31 73.0335 681.511 72.1217C683.709 71.2102 685.346 69.843 686.418 68.0197C687.52 66.1967 688.069 63.931 688.069 61.2229C688.069 58.4885 687.52 56.1826 686.418 54.3058C685.346 52.4289 683.695 51.0081 681.47 50.0428C679.269 49.051 676.495 48.5547 673.14 48.5547H661.391V116.682H643.97ZM688.471 79.1998L708.951 116.682H689.717L669.679 79.1998H688.471Z" fill="#00FF75"/>
<path d="M734.616 34.3182V116.682H717.191V34.3182H734.616Z" fill="#00FF75"/>
<path d="M747.814 116.682V34.3182H765.239V70.6337H766.324L795.979 34.3182H816.861L786.283 71.1968L817.222 116.682H796.381L773.809 82.8194L765.239 93.2758V116.682H747.814Z" fill="#00FF75"/>
<path d="M839.004 116.682H820.336L848.782 34.3182H871.234L899.639 116.682H880.971L860.329 53.1396H859.683L839.004 116.682ZM837.836 84.3074H881.936V97.9005H837.836V84.3074Z" fill="#00FF75"/>
<path d="M6.86692 120.114C6.86692 133.381 17.6274 144.136 30.9011 144.136H49.7852V151H30.9011L29.3118 150.96C12.9842 150.133 0 136.639 0 120.114V106.386H6.86692V120.114ZM151.072 120.114C151.072 137.172 137.237 151 120.171 151H104.721V144.136H120.171C133.445 144.136 144.205 133.381 144.205 120.114V106.386H151.072V120.114ZM49.7852 6.86364H30.9011C17.6274 6.86364 6.86692 17.619 6.86692 30.8864V51.4773H0V30.8864C0 14.3611 12.9842 0.867025 29.3118 0.0402168L30.9011 0H49.7852V6.86364ZM120.171 0C137.237 0 151.072 13.8283 151.072 30.8864V51.4773H144.205V30.8864C144.205 17.619 133.445 6.86364 120.171 6.86364H104.721V0H120.171Z" fill="white"/>
</svg></a>
    <span class="live"><span class="dot"></span><span id="watching">connecting…</span></span>
  </header>

  <div class="tape"><span class="run" id="tape"></span></div>

  <section class="hero">
    <div class="top">
      <h2 id="hero-name">Streaming live liquidity…</h2>
      <span class="sub" id="hero-sub"></span>
    </div>
    <div class="chartwrap">
      <div class="gridbg"></div>
      <svg id="chart" viewBox="0 0 1000 340" preserveAspectRatio="none"></svg>
      <div class="scanx"></div>
      <span class="yl" id="y-top"></span>
      <span class="yl" id="y-zero">0%</span>
      <span class="yl" id="y-bot"></span>
    </div>
    <div class="tip" id="tip"></div>
    <div class="xaxis"><span>◂ 90 seconds ago</span><span>now ▸</span></div>
    <div class="cap">Each line is one <b>live pool's liquidity</b>, as % change over the last 90 seconds (<b>0%</b> = where it stood 90s ago). <span class="up">Green climbs</span> as liquidity builds; <span class="down">red dives</span> as it drains. A line falling toward <b>−100%</b> means a pool is being emptied: a rug, as it happens.</div>
    <div class="legend" id="legend"></div>
  </section>

  <div class="grid">
    <div class="card"><h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#00ff88"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg> Fastest-rising liquidity</h3><div id="rising"><div class="empty">…</div></div>
      <div class="disc">Pools whose real reserves are climbing fastest right now, measured live on the reserve stream.</div></div>
    <div class="card"><h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#fbbf24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> Rug watch</h3><div id="rugwatch"><div class="empty">…</div></div>
      <div class="disc">Small, recently-created pools building liquidity unusually fast: the classic pre-rug profile. High-risk, not a guarantee, not financial advice.</div></div>
    <div class="card"><h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#ff4d6d"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg> Just drained</h3><div id="draining"><div class="empty">…</div></div></div>
  </div>

  <div class="hyp">
    <h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#00ff88"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/></svg> The experiment, live</h3>
    <div class="q">Hypothesis: pools whose liquidity rises fastest are the ones that drain. We log every pool that enters the rug-watch profile, then count how many actually drain.</div>
    <div class="nums" id="hyp"><span class="empty">gathering data…</span></div>
  </div>

  <div class="stats" id="stats"></div>

  <section class="hyp" aria-label="How LiquidityRadar gets its data">
    <h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#00ff88"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg> Built on free, public DexPaprika data</h3>
    <div class="q">No private endpoints, no special access, no API key. Everything you see here runs on the same public data any developer can call today, from two free, keyless DexPaprika endpoints.</div>
    <div class="nums" style="font-style:normal">
      <span>
        <code style="font-family:var(--mono);color:var(--green);font-size:.95em">POST streaming.dexpaprika.com/sse/reserves</code>
        <span style="color:var(--mut);font-size:.86em">Live reserves over one SSE connection, multiplexing every pool on the chart, so a drain shows up the block it happens. This is what turns into the red and green lines above.</span>
      </span>
      <span>
        <code style="font-family:var(--mono);color:var(--green);font-size:.95em">GET /networks/{chain}/pools/filter</code>
        <span style="color:var(--mut);font-size:.86em">REST pool discovery, so you pick which pools are worth watching before subscribing to their reserves.</span>
      </span>
    </div>
    <div class="q" style="margin-top:12px">That's the whole stack: those two calls plus one Cloudflare Worker and a Durable Object you deploy with a single command. Don't take our word for it. Call the endpoints, diff the numbers, then <a href="https://github.com/coinpaprika/liquidity-radar" target="_blank" rel="noopener">fork the repo</a> or read <a href="https://docs.dexpaprika.com" target="_blank" rel="noopener">the docs</a>. If this is what the free data does, picture what you'd build on top of it.</div>
  </section>

  <div class="cta">
    <a class="btn" href="https://x.com/LiquidityRadar">Follow on X</a>
    <a class="btn alt" href="https://github.com/coinpaprika/liquidity-radar">Fork on GitHub</a>
  </div>
  <footer><a class="dpcredit" href="https://dexpaprika.com" target="_blank" rel="noopener">Powered by <svg viewBox="0 0 903 151" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DexPaprika" style="height:24px;width:auto;display:inline-block;vertical-align:middle">
<path d="M36.4777 90.0588C37.0957 89.7969 37.7687 89.6895 38.4382 89.7455C39.6296 89.7547 40.8073 89.9864 41.9094 90.4284C44.2407 91.4003 46.7334 91.9116 49.257 91.935C55.99 91.935 61.4149 88.0055 66.6612 84.2031L67.19 83.5167C67.6157 82.9608 68.0346 82.4082 68.4569 81.8488C69.638 78.6573 70.881 75.3284 71.9831 72.3805C74.802 64.8373 77.717 57.0334 80.4397 49.3083C80.9341 47.4572 82.0088 45.8124 83.5024 44.6122C84.9959 43.4125 86.8362 42.7206 88.7487 42.6369H89.2328H89.2637C92.1066 41.2319 95.2173 40.458 98.3864 40.3685C99.1624 40.3678 99.9383 40.4261 100.704 40.5435L100.755 40.5092C102.469 39.7418 103.955 38.5458 105.071 37.0372C106.187 35.5282 106.898 33.7574 107.128 31.8953C107.025 30.7872 106.507 29.7593 105.676 29.016C104.81 27.9865 103.581 27.3251 102.242 27.1663C101.15 27.1663 100.368 27.911 99.983 29.3146C99.5091 31.0545 98.8637 31.9365 98.0705 31.9365C97.4147 31.8431 96.8242 31.4955 96.419 30.9687C95.9589 30.4299 95.7186 29.735 95.7529 29.026C95.7838 28.3173 96.086 27.647 96.5941 27.1525C97.5727 26.1655 98.7332 25.3807 100.01 24.8436C101.291 24.3065 102.664 24.0275 104.052 24.0227H104.615C105.47 24.0927 106.304 24.3336 107.063 24.7317C107.822 25.1298 108.495 25.6765 109.037 26.3392C109.919 27.5132 110.544 28.8605 110.867 30.2926C111.19 31.7244 111.207 33.209 110.915 34.6476C110.829 35.4712 110.699 36.2915 110.572 37.0876C110.201 39.0637 110.016 41.0692 110.009 43.0796C110.026 43.941 110.057 44.72 110.101 45.4819C111.052 46.3364 111.949 47.239 112.848 48.2273C114.373 49.7843 115.502 51.6804 116.148 53.7594C116.9 57.3604 116.989 61.0675 116.412 64.7C115.959 73.8857 112.625 82.6958 106.884 89.8827C101.034 96.8099 93.686 102.324 85.3976 106.012C79.5264 108.859 73.0887 110.353 66.5617 110.384C57.1403 110.225 47.966 107.325 40.1652 102.038L39.7463 101.784C38.6202 101.21 37.6107 100.432 36.7695 99.4884C35.9627 98.8659 35.4133 97.9643 35.2279 96.9591C34.7095 96.1077 34.4073 95.1423 34.3455 94.1468C34.287 93.1512 34.4725 92.1563 34.8846 91.2486C35.3137 90.729 35.8597 90.3206 36.4777 90.0588Z" fill="#00FF75"/>
<path d="M225.214 116.682H196.002V34.3182H225.455C233.743 34.3182 240.878 35.9672 246.86 39.2648C252.842 42.5357 257.442 47.241 260.661 53.3809C263.907 59.5208 265.53 66.8669 265.53 75.4197C265.53 83.9992 263.907 91.3722 260.661 97.5388C257.442 103.705 252.815 108.438 246.78 111.735C240.771 115.033 233.583 116.682 225.214 116.682ZM213.424 101.761H224.489C229.639 101.761 233.971 100.85 237.485 99.0268C241.026 97.1767 243.682 94.3215 245.452 90.4607C247.249 86.5731 248.148 81.5592 248.148 75.4197C248.148 69.3334 247.249 64.36 245.452 60.4992C243.682 56.6384 241.039 53.7965 237.526 51.9732C234.012 50.1502 229.679 49.2387 224.529 49.2387H213.424V101.761Z" fill="white"/>
<path d="M277.303 116.682V34.3182H332.828V48.6755H294.725V68.3011H329.972V82.6584H294.725V102.324H332.989V116.682H277.303Z" fill="white"/>
<path d="M361.883 34.3182L378.498 62.3894H379.143L395.84 34.3182H415.518L390.367 75.5L416.081 116.682H396.043L379.143 88.5704H378.498L361.602 116.682H341.644L367.435 75.5L342.126 34.3182H361.883Z" fill="white"/>
<path d="M425.409 116.682V34.3182H457.917C464.17 34.3182 469.491 35.5114 473.893 37.8976C478.291 40.2569 481.646 43.5412 483.95 47.7507C486.284 51.933 487.452 56.7592 487.452 62.2285C487.452 67.6981 486.271 72.5239 483.912 76.7066C481.55 80.889 478.13 84.1465 473.649 86.4791C469.2 88.8117 463.806 89.9781 457.474 89.9781H436.753V76.0227H454.659C458.013 76.0227 460.774 75.4465 462.947 74.2934C465.148 73.1138 466.782 71.4916 467.857 69.4274C468.956 67.336 469.505 64.9365 469.505 62.2285C469.505 59.4936 468.956 57.1075 467.857 55.07C466.782 53.0055 465.148 51.4103 462.947 50.284C460.75 49.1313 457.958 48.5547 454.58 48.5547H442.831V116.682H425.409Z" fill="#00FF75"/>
<path d="M502.322 116.682H483.654L512.1 34.3182H534.552L562.957 116.682H544.289L523.647 53.1396H523.005L502.322 116.682ZM501.155 84.3074H545.254V97.9005H501.155V84.3074Z" fill="#00FF75"/>
<path d="M571.743 116.682V34.3182H604.255C610.504 34.3182 615.829 35.5114 620.227 37.8976C624.625 40.2569 627.98 43.5412 630.287 47.7507C632.618 51.933 633.786 56.7592 633.786 62.2285C633.786 67.6981 632.605 72.5239 630.246 76.7066C627.884 80.889 624.464 84.1465 619.987 86.4791C615.534 88.8117 610.14 89.9781 603.812 89.9781H583.091V76.0227H600.993C604.347 76.0227 607.111 75.4465 609.281 74.2934C611.482 73.1138 613.12 71.4916 614.191 69.4274C615.29 67.336 615.843 64.9365 615.843 62.2285C615.843 59.4936 615.29 57.1075 614.191 55.07C613.12 53.0055 611.482 51.4103 609.281 50.284C607.084 49.1313 604.292 48.5547 600.914 48.5547H589.165V116.682H571.743Z" fill="#00FF75"/>
<path d="M643.97 116.682V34.3182H676.481C682.703 34.3182 688.014 35.4308 692.412 37.6563C696.842 39.8547 700.206 42.978 702.514 47.0265C704.848 51.0483 706.012 55.7804 706.012 61.2229C706.012 66.6926 704.835 71.3979 702.472 75.339C700.114 79.2537 696.694 82.2562 692.213 84.3476C687.76 86.4389 682.37 87.4846 676.038 87.4846H654.27V73.4893H673.223C676.546 73.4893 679.31 73.0335 681.511 72.1217C683.709 71.2102 685.346 69.843 686.418 68.0197C687.52 66.1967 688.069 63.931 688.069 61.2229C688.069 58.4885 687.52 56.1826 686.418 54.3058C685.346 52.4289 683.695 51.0081 681.47 50.0428C679.269 49.051 676.495 48.5547 673.14 48.5547H661.391V116.682H643.97ZM688.471 79.1998L708.951 116.682H689.717L669.679 79.1998H688.471Z" fill="#00FF75"/>
<path d="M734.616 34.3182V116.682H717.191V34.3182H734.616Z" fill="#00FF75"/>
<path d="M747.814 116.682V34.3182H765.239V70.6337H766.324L795.979 34.3182H816.861L786.283 71.1968L817.222 116.682H796.381L773.809 82.8194L765.239 93.2758V116.682H747.814Z" fill="#00FF75"/>
<path d="M839.004 116.682H820.336L848.782 34.3182H871.234L899.639 116.682H880.971L860.329 53.1396H859.683L839.004 116.682ZM837.836 84.3074H881.936V97.9005H837.836V84.3074Z" fill="#00FF75"/>
<path d="M6.86692 120.114C6.86692 133.381 17.6274 144.136 30.9011 144.136H49.7852V151H30.9011L29.3118 150.96C12.9842 150.133 0 136.639 0 120.114V106.386H6.86692V120.114ZM151.072 120.114C151.072 137.172 137.237 151 120.171 151H104.721V144.136H120.171C133.445 144.136 144.205 133.381 144.205 120.114V106.386H151.072V120.114ZM49.7852 6.86364H30.9011C17.6274 6.86364 6.86692 17.619 6.86692 30.8864V51.4773H0V30.8864C0 14.3611 12.9842 0.867025 29.3118 0.0402168L30.9011 0H49.7852V6.86364ZM120.171 0C137.237 0 151.072 13.8283 151.072 30.8864V51.4773H144.205V30.8864C144.205 17.619 133.445 6.86364 120.171 6.86364H104.721V0H120.171Z" fill="white"/>
</svg></a><div style="margin-top:9px">Free real-time DEX data, no API key. Drains are confirmed before they post, so the feed never cries wolf.</div></footer>
</div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>{const a=Math.abs(n);const s=n<0?'-':'';return a>=1e9?s+'$'+(a/1e9).toFixed(2)+'B':a>=1e6?s+'$'+(a/1e6).toFixed(2)+'M':a>=1e3?s+'$'+(a/1e3).toFixed(1)+'K':s+'$'+a.toFixed(0)};
const pct=p=>(p>=0?'+':'')+(p*100).toFixed(1)+'%';
const lerp=(a,b,t)=>a+(b-a)*t;

// ---- counting-number tweens -------------------------------------------------
const tweens={};
function num(id,target,fmt){const e=$(id);if(!e)return;const t=tweens[id]||(tweens[id]={cur:target,target,fmt});t.target=target;t.fmt=fmt;t.el=e;}
function tweenStep(){for(const k in tweens){const t=tweens[k];t.cur=lerp(t.cur,t.target,.18);if(Math.abs(t.cur-t.target)<.01)t.cur=t.target;t.el.textContent=t.fmt(t.cur);}}

// ---- the multi-line live chart ----------------------------------------------
const W=1000,H=340,PAD=14,WINDOW=90; // seconds shown
const chartState={lines:[],maxT:0,perfAt:0,dom:{mn:-.05,mx:.1},featured:null,drains:new Set(),hoverId:null,viewLeft:0};
function setSeries(d){
  const drains=new Set((d.draining||[]).map(x=>x.id));
  let maxT=0;
  const lines=(d.series||[]).map(s=>{
    const base=s.pts[0]?s.pts[0].r:0;
    const pts=s.pts.map(p=>{if(p.t>maxT)maxT=p.t;return{t:p.t,v:base>0?(p.r-base)/base:0}});
    return{id:s.id,label:s.label,chain:s.chain,changePct:s.changePct,pts,draining:drains.has(s.id)||s.changePct<-.4};
  });
  chartState.lines=lines;chartState.drains=drains;
  chartState.maxT=maxT||(Date.now()/1000);chartState.perfAt=performance.now();
  // featured = the biggest riser that is not draining
  let f=null;for(const l of lines){if(!l.draining&&(!f||l.changePct>f.changePct))f=l;}
  chartState.featured=f?f.id:null;
}
function colorFor(l){
  if(l.id===chartState.hoverId)return{stroke:l.draining?'#ff6b8a':'#7dffb0',w:3.4,op:1,glow:true};
  if(l.draining)return{stroke:'#ff4d6d',w:2.6,op:.95,glow:true};
  if(l.id===chartState.featured)return{stroke:'#00ff88',w:2.8,op:1,glow:true};
  const m=Math.min(.55,.22+Math.abs(l.changePct)*1.6);
  return{stroke:'rgba(0,255,136,'+m.toFixed(2)+')',w:1.3,op:1,glow:false};
}
function setYLabels(yt,yz,yb,show){for(const e of [$('y-top'),$('y-zero'),$('y-bot')])if(e)e.style.display=show?'':'none';
  if(show){$('y-top').textContent=yt.t;$('y-top').style.top=yt.y+'px';$('y-bot').textContent=yb.t;$('y-bot').style.top=yb.y+'px';
    if(yz){$('y-zero').style.display='';$('y-zero').style.top=yz+'px';}else $('y-zero').style.display='none';}}
function drawChart(){
  const svg=$('chart');if(!svg)return;
  const lines=chartState.lines;
  if(!lines.length){svg.innerHTML='<text x="500" y="170" fill="#8494a7" text-anchor="middle" font-size="15">waiting for the stream…</text>';setYLabels(0,0,0,false);return}
  const rightT=chartState.maxT+(performance.now()-chartState.perfAt)/1000;
  const left=rightT-WINDOW;
  chartState.viewLeft=left; // so the hover handler can map cursor x -> time
  const x=t=>PAD+(t-left)/WINDOW*(W-2*PAD);
  // vertical domain from the currently visible points, eased toward target
  let mn=Infinity,mx=-Infinity;
  for(const l of lines)for(const p of l.pts){if(p.t<left-2||p.t>rightT+2)continue;if(p.v<mn)mn=p.v;if(p.v>mx)mx=p.v;}
  if(!isFinite(mn)){mn=-.05;mx=.1}
  mn=Math.max(mn,-1.05);if(mx-mn<.04){mx=mn+.04}
  const padv=(mx-mn)*.10;const tmn=mn-padv,tmx=mx+padv;
  chartState.dom.mn=lerp(chartState.dom.mn,tmn,.12);chartState.dom.mx=lerp(chartState.dom.mx,tmx,.12);
  const dmn=chartState.dom.mn,dmx=chartState.dom.mx;
  const y=v=>H-PAD-(v-dmn)/(dmx-dmn)*(H-2*PAD);
  // y-axis scale labels (HTML overlay; SVG text would stretch)
  setYLabels({t:pct(dmx),y:y(dmx)},(dmn<-0.001&&dmx>0.001)?y(0):null,{t:pct(dmn),y:y(dmn)},true);
  const pulse=3.2+1.6*Math.sin(performance.now()/260);
  let g='<defs><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  // zero baseline (where every line starts)
  if(dmn<0&&dmx>0){const y0=y(0).toFixed(1);g+='<line x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+y0+'" y2="'+y0+'" stroke="rgba(132,148,167,.25)" stroke-width="1" stroke-dasharray="4 5"/>';}
  // draw crowd first, highlights last (on top)
  const rank=l=>l.id===chartState.hoverId?2:(l.draining||l.id===chartState.featured)?1:0;
  const order=lines.slice().sort((a,b)=>rank(a)-rank(b));
  for(const l of order){
    const vis=l.pts.filter(p=>p.t>=left-2&&p.t<=rightT+2);
    if(!vis.length)continue;
    const c=colorFor(l);
    let d='';vis.forEach((p,i)=>d+=(i?'L':'M')+x(p.t).toFixed(1)+' '+y(p.v).toFixed(1)+' ');
    g+='<path d="'+d+'" fill="none" stroke="'+c.stroke+'" stroke-width="'+c.w+'" stroke-linejoin="round" stroke-linecap="round" opacity="'+c.op+'"'+(c.glow?' filter="url(#glow)"':'')+'/>';
    if(c.glow){const last=vis[vis.length-1];g+='<circle cx="'+x(last.t).toFixed(1)+'" cy="'+y(last.v).toFixed(1)+'" r="'+pulse.toFixed(1)+'" fill="'+c.stroke+'"/>';}
  }
  svg.innerHTML=g;
}

// ---- lists with FLIP reorder + value-change flash ---------------------------
const prevVals={};
function renderList(elId,items,rowFn){
  const el=$(elId);if(!el)return;
  const old=new Map();
  [...el.children].forEach(c=>{if(c.dataset.k)old.set(c.dataset.k,c.getBoundingClientRect())});
  const pv=prevVals[elId]||{};
  el.innerHTML=items.length?items.map(rowFn).join(''):'<div class="empty">nothing yet</div>';
  const nv={};
  [...el.children].forEach(c=>{
    const k=c.dataset.k;if(!k)return;nv[k]=c.dataset.v||'';
    const prev=old.get(k);
    if(prev){
      const now=c.getBoundingClientRect();const dy=prev.top-now.top;
      if(Math.abs(dy)>1)c.animate([{transform:'translateY('+dy+'px)'},{transform:'none'}],{duration:420,easing:'cubic-bezier(.2,.8,.2,1)'});
      if(pv[k]!==undefined&&pv[k]!==nv[k]){const up=c.dataset.dir!=='dn';c.animate([{background:up?'rgba(0,255,136,.22)':'rgba(255,92,92,.22)'},{background:'transparent'}],{duration:850,easing:'ease-out'});}
    }else{c.animate([{opacity:0,transform:'translateX(10px)'},{opacity:1,transform:'none'}],{duration:380,easing:'ease-out'});}
  });
  prevVals[elId]=nv;
}
// full pool chart + detail on DexPaprika
const dp=(chain,id)=>'https://dexpaprika.com/'+encodeURIComponent(chain)+'/pool/'+encodeURIComponent(id);
// a row is an <a> linking to DexPaprika when we have the pool id, else a plain <div>
function row(r,key,val,dir,body){
  const link=r.id?' href="'+dp(r.chain,r.id)+'" target="_blank" rel="noopener" title="Open '+esc(r.label)+' on DexPaprika"':'';
  const tag=r.id?'a':'div';
  return '<'+tag+' class="row" data-k="'+key+'" data-v="'+val+'" data-dir="'+dir+'"'+link+'>'+body+'</'+tag+'>';
}
const cell=r=>'<span class="name">'+esc(r.label)+'</span><span class="chain">'+esc(r.chain)+'</span>';
const rowRise=r=>row(r,esc(r.label),pct(r.changePct),'up',cell(r)+'<span class="val up">'+pct(r.changePct)+'</span>');
const rowRug=r=>row(r,esc(r.label),pct(r.changePct)+usd(r.reserveUsd),'up',cell(r)+'<span class="val up">'+pct(r.changePct)+' · '+usd(r.reserveUsd)+'</span>');
const itag=r=>{var i=r.intent;if(!i||i==='unknown')return '';var c=i==='migration'?'#fbbf24':i==='exit'?'#ff8a9c':'#ff4d6d';var t=i==='rug'?'likely rug':i==='migration'?'migrated':'partial';return ' <span style="font-size:.82em;font-weight:700;color:'+c+'">'+t+'</span>';};
const rowDrain=r=>row(r,esc(r.label)+esc(r.block),usd(r.deltaUsd),'dn',cell(r)+'<span class="val down">'+usd(r.deltaUsd)+' ('+pct(r.pct)+')</span>'+itag(r));

const chip=(l,color)=>{const inner='<span class="sw" style="background:'+color+'"></span>'+esc(l.label)+' '+pct(l.changePct);return l.id?'<a class="lg" href="'+dp(l.chain,l.id)+'" target="_blank" rel="noopener" title="Open '+esc(l.label)+' on DexPaprika">'+inner+'</a>':'<span class="lg">'+inner+'</span>';};
let legendExpanded=false;
function toggleLegend(){legendExpanded=!legendExpanded;renderLegend();}
function renderLegend(){
  const lines=chartState.lines;
  const f=lines.find(l=>l.id===chartState.featured);
  const draining=lines.filter(l=>l.draining);
  const shown=new Set();
  let lg='';
  if(f){lg+=chip(f,'#00ff88');shown.add(f.id);}
  draining.slice(0,3).forEach(l=>{if(!shown.has(l.id)){lg+=chip(l,'#ff4d6d');shown.add(l.id);}});
  const rest=lines.filter(l=>!shown.has(l.id));
  if(legendExpanded){
    rest.forEach(l=>lg+=chip(l,l.draining?'#ff4d6d':'rgba(0,255,136,.55)'));
    if(rest.length)lg+='<span class="more" onclick="toggleLegend()">show less ▴</span>';
  }else if(rest.length){
    lg+='<span class="more" onclick="toggleLegend()">+'+rest.length+' more ▾</span>';
  }
  $('legend').innerHTML=lg;
}
function legendAndSub(d){
  const lines=chartState.lines;
  const draining=lines.filter(l=>l.draining);
  const f=lines.find(l=>l.id===chartState.featured);
  $('hero-name').textContent=lines.length?lines.length+' pools streaming live':'Streaming live liquidity…';
  $('hero-sub').innerHTML=lines.length
    ?'normalized to % change over the last '+WINDOW+'s · '+(f?'top <span class="chg up">'+pct(f.changePct)+'</span> '+esc(f.label):'')+(draining.length?' · <span class="chg down">'+draining.length+' draining</span>':'')
    :'';
  renderLegend();
}
function buildTape(d){
  const parts=[];
  (d.rising||[]).slice(0,8).forEach(r=>parts.push('<span class="chip">'+esc(r.label)+' <b>'+pct(r.changePct)+'</b></span>'));
  const icDr='<svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke="#ff4d6d"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg> ';
  (d.draining||[]).slice(0,6).forEach(r=>parts.push('<span class="chip dn">'+icDr+esc(r.label)+' <b>'+usd(r.deltaUsd)+'</b></span>'));
  const one=parts.length?parts.join(''):'<span class="chip">scanning the chains…</span>';
  $('tape').innerHTML=one+one; // duplicated for a seamless loop
}

async function tick(){
  try{
    const d=await (await fetch('/api/live',{cache:'no-store'})).json();
    num('watching',d.scanning||0,v=>Math.round(v).toLocaleString()+' pools discovered · '+(d.watching||0)+' streamed live');
    setSeries(d);legendAndSub(d);buildTape(d);
    renderList('rising',d.rising||[],rowRise);
    renderList('rugwatch',d.rugWatch||[],rowRug);
    renderList('draining',d.draining||[],rowDrain);
    if(d.hypothesis){const h=d.hypothesis;
      if(!$('hf'))$('hyp').innerHTML='<span><b id="hf">0</b> flagged as fast risers</span><span><b id="hd">0</b> of those later drained</span><span><b id="hr">0%</b> hit rate so far</span><span><b id="ht">0</b> drains seen overall</span>';
      num('hf',h.flagged,v=>Math.round(v));num('hd',h.flaggedDrained,v=>Math.round(v));
      num('hr',h.flagged?h.rate*100:0,v=>Math.round(v)+'%');num('ht',h.totalDrains,v=>Math.round(v));
    }
    if(!$('sd'))$('stats').innerHTML='<span><b id="sd">0</b> confirmed drains</span><span><b id="ss">0</b> suppressed as transient</span><span><b id="sc">0</b> pools discovered as candidates</span>';
    num('sd',d.stats.drains,v=>Math.round(v));num('ss',d.stats.suppressed,v=>Math.round(v));num('sc',d.scanning||0,v=>Math.round(v).toLocaleString());
  }catch(e){$('watching').textContent='reconnecting…'}
}
// one rAF loop drives the gliding chart + the counting numbers
// hover a line -> name it (and highlight + click to open on DexPaprika)
function lineValAt(l,t){let best=null,bd=1e9;for(const p of l.pts){const d=Math.abs(p.t-t);if(d<bd){bd=d;best=p;}}return best?best.v:null;}
(function hover(){
  const svg=$('chart');const hero=svg&&svg.closest('.hero');const tip=$('tip');
  if(!svg||!hero||!tip)return;
  svg.addEventListener('mousemove',e=>{
    const r=svg.getBoundingClientRect();
    const sx=(e.clientX-r.left)/r.width*W,sy=(e.clientY-r.top)/r.height*H;
    const t=chartState.viewLeft+(sx-PAD)/(W-2*PAD)*WINDOW;
    const dmn=chartState.dom.mn,dmx=chartState.dom.mx;
    const yOf=v=>H-PAD-(v-dmn)/(dmx-dmn)*(H-2*PAD);
    let best=null,bd=1e9;
    for(const l of chartState.lines){const v=lineValAt(l,t);if(v==null)continue;const dy=Math.abs(yOf(v)-sy);if(dy<bd){bd=dy;best=l;}}
    if(best&&bd<20){
      chartState.hoverId=best.id;
      const dn=best.draining||best.changePct<0;
      tip.innerHTML='<b>'+esc(best.label)+'</b><br><span class="'+(dn?'dn':'')+'">'+pct(best.changePct)+'</span> <span class="sub">over 90s · click to open ↗</span>';
      const h=hero.getBoundingClientRect();
      tip.style.left=(e.clientX-h.left)+'px';tip.style.top=(e.clientY-h.top)+'px';
      tip.style.display='block';svg.style.cursor='pointer';
    }else{chartState.hoverId=null;tip.style.display='none';svg.style.cursor='crosshair';}
  });
  svg.addEventListener('mouseleave',()=>{chartState.hoverId=null;tip.style.display='none';});
  svg.addEventListener('click',()=>{const id=chartState.hoverId;if(!id)return;const l=chartState.lines.find(x=>x.id===id);if(l&&l.id)window.open(dp(l.chain,l.id),'_blank','noopener');});
})();
function frame(){drawChart();tweenStep();requestAnimationFrame(frame)}
requestAnimationFrame(frame);
tick();setInterval(tick,1000);
</script></body></html>`;
