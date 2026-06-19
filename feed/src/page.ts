// The public landing page. Self-contained HTML + CSS + JS (no external libs),
// served at / by the worker. It polls /api/live every 1.5s and animates a live
// liquidity chart: a pool's reserves climbing, then the cliff when it drains.
// Branded with the DexPaprika palette (#00FF75 green, #252425 surface).

export const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiquidityRadar — watch DEX liquidity build and rug, live</title>
<meta name="description" content="Real-time DEX liquidity, live. Watch pools build liquidity and get drained the block it happens, on the free DexPaprika reserve stream.">
<style>
  :root{--green:#00FF75;--bg:#161616;--surface:#252425;--ink:#e8e8e8;--mut:#9a9a9a;--red:#ff5c5c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  a{color:var(--green);text-decoration:none}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 18px 64px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .logo{font-weight:800;font-size:1.5em;letter-spacing:.5px}
  .logo b{color:var(--green)}
  .tag{color:var(--mut);font-size:.95em}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mut);font-size:.85em}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(0,255,117,.6);animation:p 1.6s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(0,255,117,.5)}70%{box-shadow:0 0 0 8px rgba(0,255,117,0)}100%{box-shadow:0 0 0 0 rgba(0,255,117,0)}}
  .hero{background:var(--surface);border:1px solid #333;border-radius:14px;padding:18px;margin:20px 0}
  .hero h2{margin:0 0 2px;font-size:1.05em}
  .hero .sub{color:var(--mut);font-size:.85em;margin-bottom:8px}
  .chg{font-weight:700}.up{color:var(--green)}.down{color:var(--red)}
  svg{width:100%;height:240px;display:block}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
  .disc{color:var(--mut);font-size:.78em;margin-top:8px}
  .card{background:var(--surface);border:1px solid #333;border-radius:14px;padding:14px}
  .card h3{margin:0 0 10px;font-size:.95em;display:flex;align-items:center;gap:8px}
  .row{display:flex;align-items:baseline;gap:8px;padding:7px 0;border-bottom:1px solid #2f2f2f;font-size:.92em}
  .row:last-child{border-bottom:none}
  .row .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .chain{color:var(--mut);font-size:.82em}
  .row .val{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
  .stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--mut);font-size:.85em;margin:14px 2px}
  .stats b{color:var(--ink)}
  .hyp{background:var(--surface);border:1px solid #333;border-left:4px solid var(--green);border-radius:14px;padding:14px 16px;margin:18px 0}
  .hyp h3{margin:0 0 4px;font-size:.95em}
  .hyp .q{color:var(--mut);font-size:.82em;font-style:italic}
  .hyp .nums{display:flex;gap:22px;flex-wrap:wrap;margin-top:10px;font-size:.9em}
  .hyp .nums b{color:var(--green);font-size:1.25em;font-variant-numeric:tabular-nums}
  .hyp .nums span{display:flex;flex-direction:column;gap:2px;color:var(--mut)}
  .cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  .btn{background:var(--green);color:#06301a;font-weight:700;padding:10px 16px;border-radius:10px}
  .btn.alt{background:transparent;color:var(--green);border:1px solid var(--green)}
  footer{color:var(--mut);font-size:.85em;margin-top:26px}
  .empty{color:var(--mut);font-size:.9em;padding:8px 0}
</style></head>
<body><div class="wrap">
  <header>
    <span class="logo">🌶️ Liquidity<b>Radar</b></span>
    <span class="tag">DEX liquidity, live</span>
    <span class="live"><span class="dot"></span><span id="watching">connecting…</span></span>
  </header>

  <section class="hero">
    <h2 id="hero-name">Watching for the fastest-rising pool…</h2>
    <div class="sub" id="hero-sub"></div>
    <svg id="chart" viewBox="0 0 800 240" preserveAspectRatio="none"></svg>
  </section>

  <div class="grid">
    <div class="card"><h3>🟢 Fastest-rising liquidity</h3><div id="rising"><div class="empty">…</div></div>
      <div class="disc">Pools whose liquidity is climbing fastest right now, scanned across thousands of pairs.</div></div>
    <div class="card"><h3>🚩 Rug watch</h3><div id="rugwatch"><div class="empty">…</div></div>
      <div class="disc">Small, recently-created pools building liquidity unusually fast: the classic pre-rug profile. High-risk, not a guarantee, not financial advice.</div></div>
    <div class="card"><h3>🚨 Just drained</h3><div id="draining"><div class="empty">…</div></div></div>
  </div>

  <div class="hyp">
    <h3>📡 The experiment, live</h3>
    <div class="q">Hypothesis: pools whose liquidity rises fastest are the ones that drain. We log every pool that enters the rug-watch profile, then count how many actually drain.</div>
    <div class="nums" id="hyp"><span class="empty">gathering data…</span></div>
  </div>

  <div class="stats" id="stats"></div>

  <div class="cta">
    <a class="btn" href="https://x.com/LiquidityRadar">Follow on X</a>
    <a class="btn alt" href="https://github.com/coinpaprika/liquidity-radar">Fork on GitHub</a>
  </div>
  <footer>Powered by <a href="https://dexpaprika.com">DexPaprika</a> — free real-time DEX data, no API key. Drains are confirmed before they post, so the feed never cries wolf.</footer>
</div>
<script>
const $=id=>document.getElementById(id);
const usd=n=>{const a=Math.abs(n);const s=n<0?'-':'';return a>=1e9?s+'$'+(a/1e9).toFixed(2)+'B':a>=1e6?s+'$'+(a/1e6).toFixed(2)+'M':a>=1e3?s+'$'+(a/1e3).toFixed(1)+'K':s+'$'+a.toFixed(0)};
const pct=p=>(p>=0?'+':'')+(p*100).toFixed(1)+'%';
function chart(series){
  const svg=$('chart');const W=800,H=240,pad=8;
  if(!series||series.length<2){svg.innerHTML='<text x="400" y="120" fill="#9a9a9a" text-anchor="middle" font-size="14">building…</text>';return}
  const rs=series.map(p=>p.r);let mn=Math.min(...rs),mx=Math.max(...rs);if(mx===mn){mx=mn*1.0001+1}
  const x=i=>pad+i/(series.length-1)*(W-2*pad);
  const y=r=>H-pad-(r-mn)/(mx-mn)*(H-2*pad);
  const down=rs[rs.length-1]<rs[0];const col=down?'#ff5c5c':'#00FF75';
  let d='';series.forEach((p,i)=>d+=(i?'L':'M')+x(i).toFixed(1)+' '+y(p.r).toFixed(1)+' ');
  const area=d+'L'+x(series.length-1).toFixed(1)+' '+H+' L'+pad+' '+H+' Z';
  svg.innerHTML=
    '<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="'+col+'" stop-opacity=".25"/><stop offset="1" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs>'+
    '<path d="'+area+'" fill="url(#g)"/>'+
    '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2.5" stroke-linejoin="round"/>'+
    '<circle cx="'+x(series.length-1).toFixed(1)+'" cy="'+y(rs[rs.length-1]).toFixed(1)+'" r="4" fill="'+col+'"/>';
}
function list(el,items,render){el.innerHTML=items.length?items.map(render).join(''):'<div class="empty">nothing yet</div>'}
async function tick(){
  try{
    const d=await (await fetch('/api/live',{cache:'no-store'})).json();
    $('watching').textContent=(d.scanning||0).toLocaleString()+' pools scanned · '+d.watching+' streamed live';
    if(d.hero){
      $('hero-name').textContent=d.hero.label+' ';
      $('hero-sub').innerHTML=d.hero.chain+' · liquidity '+usd(d.hero.series.at(-1).r)+' · <span class="chg '+(d.hero.changePct<0?'down':'up')+'">'+pct(d.hero.changePct)+'</span> over window';
      chart(d.hero.series);
    }
    list($('rising'),d.rising,r=>'<div class="row"><span class="name">'+r.label+'</span><span class="chain">'+r.chain+'</span><span class="val up">'+pct(r.changePct)+'</span></div>');
    list($('rugwatch'),d.rugWatch||[],r=>'<div class="row"><span class="name">'+r.label+'</span><span class="chain">'+r.chain+'</span><span class="val down">'+pct(r.changePct)+' · '+usd(r.reserveUsd)+'</span></div>');
    list($('draining'),d.draining,r=>'<div class="row"><span class="name">'+r.label+'</span><span class="chain">'+r.chain+'</span><span class="val down">'+usd(r.deltaUsd)+' ('+pct(r.pct)+')</span></div>');
    if(d.hypothesis){
      const h=d.hypothesis;
      $('hyp').innerHTML=
        '<span><b>'+h.flagged+'</b> flagged as fast risers</span>'+
        '<span><b>'+h.flaggedDrained+'</b> of those later drained</span>'+
        '<span><b>'+(h.flagged?(h.rate*100).toFixed(0):'0')+'%</b> hit rate so far</span>'+
        '<span><b>'+h.totalDrains+'</b> drains seen overall</span>';
    }
    $('stats').innerHTML='<span><b>'+d.stats.drains+'</b> confirmed drains</span><span><b>'+d.stats.suppressed+'</b> suppressed as transient</span><span><b>'+(d.scanning||0).toLocaleString()+'</b> pools scanned for liquidity growth</span>';
  }catch(e){$('watching').textContent='reconnecting…'}
}
tick();setInterval(tick,1500);
</script></body></html>`;
