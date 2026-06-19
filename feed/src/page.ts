// The public landing page. Self-contained HTML + CSS + JS (no external libs),
// served at / by the worker. It polls /api/live every second and renders a
// LIVING dashboard: every streamed pool overlaid as one line (normalized to %
// change from the window start, so a $20k pool and a $2M pool share one axis),
// the whole field scrolling left in real time so it glides tick-by-tick. A
// pool climbing is a green line rising; a pool draining stabs down in red.
// Around it: a radar sweep, a scanline, pulsing leading dots, a live ticker,
// numbers that count up, and rows that flash and reorder. Brand: #00FF75 neon.

export const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiquidityRadar — watch DEX liquidity build and rug, live</title>
<meta name="description" content="Real-time DEX liquidity, live. Dozens of pools streamed at once: watch liquidity climb and get drained the block it happens, on the free DexPaprika reserve stream.">
<style>
  :root{--green:#00FF75;--bg:#161616;--surface:#252425;--ink:#e8e8e8;--mut:#9a9a9a;--red:#ff5c5c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  a{color:var(--green);text-decoration:none}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 18px 64px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .logo{font-weight:800;font-size:1.5em;letter-spacing:.5px}
  .logo b{color:var(--green)}
  .tag{color:var(--mut);font-size:.95em}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mut);font-size:.85em}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(0,255,117,.6);animation:p 1.6s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(0,255,117,.5)}70%{box-shadow:0 0 0 9px rgba(0,255,117,0)}100%{box-shadow:0 0 0 0 rgba(0,255,117,0)}}
  /* the radar disc: an always-sweeping liveness motif (it is a radar, after all) */
  .radar{position:relative;width:50px;height:50px;border-radius:50%;flex-shrink:0;overflow:hidden;
    background:radial-gradient(circle,rgba(0,255,117,.10),transparent 72%);border:1px solid rgba(0,255,117,.28)}
  .radar::before{content:"";position:absolute;inset:0;border-radius:50%;
    background:repeating-radial-gradient(circle,transparent 0 7px,rgba(0,255,117,.10) 7px 8px)}
  .radar::after{content:"";position:absolute;inset:-25%;
    background:conic-gradient(from 0deg,rgba(0,255,117,.55),rgba(0,255,117,0) 26%);animation:sweep 3.2s linear infinite}
  @keyframes sweep{to{transform:rotate(360deg)}}
  .tape{margin-top:14px;overflow:hidden;border-top:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;padding:7px 0;font-size:.8em;color:var(--mut);white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}
  .tape .run{display:inline-block;will-change:transform;animation:marq 42s linear infinite}
  .tape:hover .run{animation-play-state:paused}
  @keyframes marq{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  .tape .chip{margin:0 16px}.tape .chip b{color:var(--green);font-variant-numeric:tabular-nums}.tape .chip.dn b{color:var(--red)}
  .hero{background:var(--surface);border:1px solid #333;border-radius:14px;padding:18px;margin:18px 0}
  .hero .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .hero h2{margin:0;font-size:1.05em}
  .hero .sub{color:var(--mut);font-size:.85em}
  .chg{font-weight:700}.up{color:var(--green)}.down{color:var(--red)}
  .chartwrap{position:relative;border-radius:10px;overflow:hidden;background:#101010;border:1px solid #262626}
  .chartwrap svg{width:100%;height:340px;display:block}
  .gridbg{position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
    background-size:100% 38px,76px 100%}
  .scanx{position:absolute;top:0;bottom:0;width:140px;pointer-events:none;
    background:linear-gradient(90deg,transparent,rgba(0,255,117,.07),transparent);animation:scanx 4.5s linear infinite}
  @keyframes scanx{0%{left:-140px}100%{left:100%}}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:.82em;color:var(--mut)}
  .legend .lg{display:flex;align-items:center;gap:6px}
  .legend .sw{width:14px;height:3px;border-radius:2px;display:inline-block}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:18px}
  .disc{color:var(--mut);font-size:.78em;margin-top:8px}
  .card{background:var(--surface);border:1px solid #333;border-radius:14px;padding:14px}
  .card h3{margin:0 0 10px;font-size:.95em;display:flex;align-items:center;gap:8px}
  .row{display:flex;align-items:baseline;gap:8px;padding:7px 6px;margin:0 -6px;border-bottom:1px solid #2f2f2f;font-size:.92em;border-radius:6px}
  .row:last-child{border-bottom:none}
  .row .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .chain{color:var(--mut);font-size:.82em}
  .row .val{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
  .stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--mut);font-size:.85em;margin:16px 2px}
  .stats b{color:var(--ink);font-variant-numeric:tabular-nums}
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
  @media (prefers-reduced-motion:reduce){.radar::after,.scanx,.tape .run{animation:none}}
</style></head>
<body><div class="wrap">
  <header>
    <span class="radar" aria-hidden="true"></span>
    <span class="logo">Liquidity<b>Radar</b></span>
    <span class="tag">DEX liquidity, live</span>
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
    </div>
    <div class="legend" id="legend"></div>
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
const chartState={lines:[],maxT:0,perfAt:0,dom:{mn:-.05,mx:.1},featured:null,drains:new Set()};
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
  if(l.draining)return{stroke:'#ff5c5c',w:2.6,op:.95,glow:true};
  if(l.id===chartState.featured)return{stroke:'#00FF75',w:2.8,op:1,glow:true};
  const m=Math.min(.55,.22+Math.abs(l.changePct)*1.6);
  return{stroke:'rgba(0,255,117,'+m.toFixed(2)+')',w:1.3,op:1,glow:false};
}
function drawChart(){
  const svg=$('chart');if(!svg)return;
  const lines=chartState.lines;
  if(!lines.length){svg.innerHTML='<text x="500" y="170" fill="#6a6a6a" text-anchor="middle" font-size="15">waiting for the stream…</text>';return}
  const rightT=chartState.maxT+(performance.now()-chartState.perfAt)/1000;
  const left=rightT-WINDOW;
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
  const pulse=3.2+1.6*Math.sin(performance.now()/260);
  let g='<defs><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  // zero baseline (where every line starts)
  if(dmn<0&&dmx>0){const y0=y(0).toFixed(1);g+='<line x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+y0+'" y2="'+y0+'" stroke="rgba(255,255,255,.14)" stroke-width="1" stroke-dasharray="4 5"/>';}
  // draw crowd first, highlights last (on top)
  const order=lines.slice().sort((a,b)=>{const ra=(a.draining||a.id===chartState.featured)?1:0,rb=(b.draining||b.id===chartState.featured)?1:0;return ra-rb;});
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
      if(pv[k]!==undefined&&pv[k]!==nv[k]){const up=c.dataset.dir!=='dn';c.animate([{background:up?'rgba(0,255,117,.22)':'rgba(255,92,92,.22)'},{background:'transparent'}],{duration:850,easing:'ease-out'});}
    }else{c.animate([{opacity:0,transform:'translateX(10px)'},{opacity:1,transform:'none'}],{duration:380,easing:'ease-out'});}
  });
  prevVals[elId]=nv;
}
const rowRise=r=>'<div class="row" data-k="'+esc(r.label)+'" data-v="'+pct(r.changePct)+'" data-dir="up"><span class="name">'+esc(r.label)+'</span><span class="chain">'+esc(r.chain)+'</span><span class="val up">'+pct(r.changePct)+'</span></div>';
const rowRug=r=>'<div class="row" data-k="'+esc(r.label)+'" data-v="'+pct(r.changePct)+usd(r.reserveUsd)+'" data-dir="up"><span class="name">'+esc(r.label)+'</span><span class="chain">'+esc(r.chain)+'</span><span class="val up">'+pct(r.changePct)+' · '+usd(r.reserveUsd)+'</span></div>';
const rowDrain=r=>'<div class="row" data-k="'+esc(r.label)+esc(r.block)+'" data-v="'+usd(r.deltaUsd)+'" data-dir="dn"><span class="name">'+esc(r.label)+'</span><span class="chain">'+esc(r.chain)+'</span><span class="val down">'+usd(r.deltaUsd)+' ('+pct(r.pct)+')</span></div>';

function legendAndSub(d){
  const lines=chartState.lines;
  const draining=lines.filter(l=>l.draining);
  const f=lines.find(l=>l.id===chartState.featured);
  $('hero-name').textContent=lines.length?lines.length+' pools streaming live':'Streaming live liquidity…';
  $('hero-sub').innerHTML=lines.length
    ?'normalized to % change over the last '+WINDOW+'s · '+(f?'top <span class="chg up">'+pct(f.changePct)+'</span> '+esc(f.label):'')+(draining.length?' · <span class="chg down">'+draining.length+' draining</span>':'')
    :'';
  let lg='';
  if(f)lg+='<span class="lg"><span class="sw" style="background:#00FF75"></span>'+esc(f.label)+' '+pct(f.changePct)+'</span>';
  draining.slice(0,3).forEach(l=>lg+='<span class="lg"><span class="sw" style="background:#ff5c5c"></span>'+esc(l.label)+' '+pct(l.changePct)+'</span>');
  if(lines.length>(f?1:0)+Math.min(draining.length,3))lg+='<span class="lg"><span class="sw" style="background:rgba(0,255,117,.4)"></span>+'+(lines.length-(f?1:0)-Math.min(draining.length,3))+' more</span>';
  $('legend').innerHTML=lg;
}
function buildTape(d){
  const parts=[];
  (d.rising||[]).slice(0,8).forEach(r=>parts.push('<span class="chip">'+esc(r.label)+' <b>'+pct(r.changePct)+'</b></span>'));
  (d.draining||[]).slice(0,6).forEach(r=>parts.push('<span class="chip dn">🚨 '+esc(r.label)+' <b>'+usd(r.deltaUsd)+'</b></span>'));
  const one=parts.length?parts.join(''):'<span class="chip">scanning the chains…</span>';
  $('tape').innerHTML=one+one; // duplicated for a seamless loop
}

async function tick(){
  try{
    const d=await (await fetch('/api/live',{cache:'no-store'})).json();
    num('watching',d.scanning||0,v=>Math.round(v).toLocaleString()+' pools scanned · '+(d.watching||0)+' streamed live');
    setSeries(d);legendAndSub(d);buildTape(d);
    renderList('rising',d.rising||[],rowRise);
    renderList('rugwatch',d.rugWatch||[],rowRug);
    renderList('draining',d.draining||[],rowDrain);
    if(d.hypothesis){const h=d.hypothesis;
      if(!$('hf'))$('hyp').innerHTML='<span><b id="hf">0</b> flagged as fast risers</span><span><b id="hd">0</b> of those later drained</span><span><b id="hr">0%</b> hit rate so far</span><span><b id="ht">0</b> drains seen overall</span>';
      num('hf',h.flagged,v=>Math.round(v));num('hd',h.flaggedDrained,v=>Math.round(v));
      num('hr',h.flagged?h.rate*100:0,v=>Math.round(v)+'%');num('ht',h.totalDrains,v=>Math.round(v));
    }
    if(!$('sd'))$('stats').innerHTML='<span><b id="sd">0</b> confirmed drains</span><span><b id="ss">0</b> suppressed as transient</span><span><b id="sc">0</b> pools scanned for liquidity growth</span>';
    num('sd',d.stats.drains,v=>Math.round(v));num('ss',d.stats.suppressed,v=>Math.round(v));num('sc',d.scanning||0,v=>Math.round(v).toLocaleString());
  }catch(e){$('watching').textContent='reconnecting…'}
}
// one rAF loop drives the gliding chart + the counting numbers
function frame(){drawChart();tweenStep();requestAnimationFrame(frame)}
requestAnimationFrame(frame);
tick();setInterval(tick,1000);
</script></body></html>`;
