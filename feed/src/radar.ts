// Experimental alternate dashboard at /radar: a literal radar scope.
//
// The classic page (/) plots liquidity as lines over 90s, which is flat and dull
// because liquidity only moves when a pool rugs. This reframes the product as what
// it is: a radar. A sweep arm rotates forever (alive even when nothing drains),
// every live pool is a blip placed by liquidity, and a draining pool flares red
// and pings. Drains are the hero, not a tangle of flat lines.
//
// Self-contained: inline CSS + vanilla JS + SVG, polling /api/live. No build step,
// no libs. DexPaprika dark + neon palette. No emojis (inline SVG only).
export const RADAR_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiquidityRadar scope: DEX rugs, live</title>
<meta name="description" content="A live radar scope of DEX liquidity. Every blip is a pool; a blip flares red and pings the block its liquidity drains. Free DexPaprika reserve stream.">
<style>
  @font-face{font-family:'DM Sans';src:url('https://static.dexpaprika.com/dexpaprika-static/assets/fonts/DMSans.woff2') format('woff2');font-weight:100 900;font-display:swap}
  @font-face{font-family:'JetBrains Mono';src:url('https://static.dexpaprika.com/dexpaprika-static/assets/fonts/JetBrainsMono.woff2') format('woff2');font-weight:100 900;font-display:swap}
  :root{--green:#00ff88;--bg:#050507;--bg2:#0a0b0f;--surface:#0f1018;--s3:#141620;--border:#2a2d42;--ink:#e2e8f0;--mut:#8494a7;--red:#ff4d6d;--warn:#fbbf24;--r:12px;--rs:8px;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 800px at 50% -10%,#0b0d12,#050507 60%);color:var(--ink);font-family:'DM Sans',ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 40px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .logo{font-size:1.45em;font-weight:800;letter-spacing:-.02em}
  .logo b{color:var(--green)}
  .tag{color:var(--mut);font-size:.9em}
  .brandby{margin-left:2px;color:var(--mut);font-size:.85em;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
  .live{margin-left:auto;display:inline-flex;align-items:center;gap:8px;color:var(--mut);font-size:.9em}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(0,255,136,.6);animation:dot 1.8s ease-out infinite}
  @keyframes dot{0%{box-shadow:0 0 0 0 rgba(0,255,136,.5)}100%{box-shadow:0 0 0 10px rgba(0,255,136,0)}}
  .grid{display:grid;grid-template-columns:1.25fr .9fr;gap:18px}
  @media(max-width:840px){.grid{grid-template-columns:1fr}}
  .panel{background:linear-gradient(180deg,var(--surface),var(--bg2));border:1px solid var(--border);border-radius:var(--r);padding:16px}
  .scopewrap{position:relative;width:100%;aspect-ratio:1;max-width:560px;margin:2px auto 0}
  .sweep{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(0,255,136,.22),rgba(0,255,136,.04) 22deg,transparent 60deg,transparent 360deg);pointer-events:none;will-change:transform;z-index:1;-webkit-mask:radial-gradient(circle at 50% 50%,#000 98%,transparent 99%);mask:radial-gradient(circle at 50% 50%,#000 98%,transparent 99%)}
  svg.scope{position:relative;z-index:2;width:100%;height:100%;display:block;overflow:visible}
  .ringline{fill:none;stroke:var(--border);stroke-width:.4}
  .cross{stroke:var(--border);stroke-width:.3}
  .blip{cursor:pointer;transition:opacity .12s linear}
  .blip:hover{stroke:#fff;stroke-width:.6}
  .cap{color:var(--mut);font-size:.82em;margin-top:10px;text-align:center}
  .cap b{color:var(--ink)}.cap .up{color:var(--green)}.cap .dn{color:var(--red)}
  .score{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .stat{background:var(--s3);border:1px solid var(--border);border-radius:var(--rs);padding:10px 12px}
  .stat .n{font-family:var(--mono);font-size:1.5em;font-weight:700;font-variant-numeric:tabular-nums}
  .stat.caught .n{color:var(--red)}.stat.caught{border-color:rgba(255,77,109,.4)}
  .stat .l{color:var(--mut);font-size:.74em;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
  h3{margin:0 0 8px;font-size:.95em;display:flex;align-items:center;gap:8px}
  .ic{width:16px;height:16px;flex-shrink:0}
  .feed{display:flex;flex-direction:column;gap:7px;min-height:60px}
  .row{display:block;background:var(--s3);border:1px solid var(--border);border-left:3px solid var(--red);border-radius:var(--rs);padding:8px 10px;text-decoration:none;color:var(--ink);animation:slam .35s cubic-bezier(.2,.8,.2,1)}
  @keyframes slam{0%{transform:translateX(14px);opacity:0}100%{transform:none;opacity:1}}
  .row .top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .row .nm{font-weight:600;font-size:.9em}
  .tag{font-size:.66em;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:99px;vertical-align:middle}
  .tag.rug{color:#ff4d6d;background:rgba(255,77,109,.14)}
  .tag.mig{color:#fbbf24;background:rgba(251,191,36,.14)}
  .tag.ex{color:#ff8a9c;background:rgba(255,138,156,.12)}
  .row .amt{font-family:var(--mono);color:var(--red);font-weight:700;font-size:.9em}
  .row .sub{color:var(--mut);font-size:.76em;margin-top:1px}
  .empty{color:var(--mut);font-size:.85em;padding:10px 2px}
  .cw{display:flex;flex-direction:column;gap:6px;margin-top:14px}
  .cw .x{display:flex;justify-content:space-between;gap:8px;font-size:.82em;color:var(--mut);text-decoration:none;padding:4px 0;border-bottom:1px solid rgba(42,45,66,.5)}
  .cw .x b{color:var(--warn);font-family:var(--mono)}
  .cw .x .nm{color:var(--ink)}
  .tip{position:fixed;pointer-events:none;background:#000;border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:.8em;opacity:0;transition:opacity .1s;z-index:9;max-width:240px}
  .tip b{color:var(--green)}.tip .dn{color:var(--red)}.tip .s{color:var(--mut);font-size:.92em}
  footer{color:var(--mut);font-size:.83em;margin-top:22px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  footer a{color:var(--mut)}
  @media(prefers-reduced-motion:reduce){.sweep,.dot{animation:none}}
</style></head>
<body><div class="wrap">
  <header>
    <span class="logo">Liquidity<b>Radar</b></span>
    <span class="tag">live rug scope</span>
    <span class="live"><span class="dot"></span><span id="hdr">connecting...</span></span>
  </header>

  <div class="grid">
    <section class="panel">
      <div class="scopewrap">
        <div class="sweep" id="sweep"></div>
        <svg class="scope" id="scope" viewBox="0 0 200 200" aria-label="Liquidity radar scope">
          <circle class="ringline" cx="100" cy="100" r="95"/>
          <circle class="ringline" cx="100" cy="100" r="66"/>
          <circle class="ringline" cx="100" cy="100" r="37"/>
          <circle class="ringline" cx="100" cy="100" r="9"/>
          <line class="cross" x1="100" y1="6" x2="100" y2="194"/>
          <line class="cross" x1="6" y1="100" x2="194" y2="100"/>
          <g id="blips"></g>
        </svg>
      </div>
      <div class="cap">Each blip is a <b>live pool</b>. The thin, rug-prone pools ring the <b>outer edge</b>; deep pools sit calm in the core. Blips light as the sweep passes; one flares <span class="dn">red and pings</span> the moment its liquidity drains.</div>
    </section>

    <aside>
      <div class="panel">
        <div class="score">
          <div class="stat caught"><div class="n" id="s_caught" data-t="0">0</div><div class="l">likely rugs</div></div>
          <div class="stat"><div class="n" id="s_drained" data-t="0">$0</div><div class="l">drained (recent)</div></div>
          <div class="stat"><div class="n" id="s_watch" data-t="0">0</div><div class="l">on the radar</div></div>
          <div class="stat"><div class="n" id="s_scan" data-t="0">0</div><div class="l">discovered</div></div>
        </div>
        <h3><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#ff4d6d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg> Caught draining</h3>
        <div class="feed" id="feed"><div class="empty">scanning...</div></div>
        <div class="cw" id="cw"></div>
      </div>
    </aside>
  </div>

  <div class="tip" id="tip"></div>

  <footer>
    <a class="brandby" href="https://dexpaprika.com" target="_blank" rel="noopener">Powered by DexPaprika</a>
    <span>free reserve stream, no API key</span>
    <a href="/">classic dashboard</a>
    <a href="/status">status</a>
    <a href="https://github.com/coinpaprika/liquidity-radar" target="_blank" rel="noopener">source</a>
  </footer>
</div>
<script>
var $=function(i){return document.getElementById(i)};
var NS='http://www.w3.org/2000/svg';
function dp(c,i){return 'https://dexpaprika.com/'+encodeURIComponent(c)+'/pool/'+encodeURIComponent(i)}
function hash(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0}return h}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function usd(n){n=Math.abs(+n||0);if(n>=1e6)return '$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return '$'+(n/1e3).toFixed(1)+'k';return '$'+Math.round(n)}
function ago(t){var s=Math.max(0,Math.floor(Date.now()/1000-t));if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
function intentTag(it){if(it==='rug')return ' <span class="tag rug">likely rug</span>';if(it==='migration')return ' <span class="tag mig">migrated</span>';if(it==='exit')return ' <span class="tag ex">partial</span>';return ''}

var blips=[]; // {ang, x, y, color, draining, label, chain, id, changePct}
var data={};
var tip=$('tip');

function buildBlips(d){
  var by={};
  (d.series||[]).forEach(function(s){
    var r=(s.pts&&s.pts.length)?s.pts[s.pts.length-1].r:0;
    by[s.id]={id:s.id,label:s.label,chain:s.chain,changePct:s.changePct,reserve:r,draining:false};
  });
  (d.rugWatch||[]).forEach(function(w){ if(!by[w.id]) by[w.id]={id:w.id,label:w.label,chain:w.chain,changePct:w.changePct,reserve:w.reserveUsd,watch:true,draining:false}; });
  (d.draining||[]).forEach(function(x){
    var e=by[x.id]||{id:x.id,label:x.label,chain:x.chain,changePct:x.pct,reserve:0};
    e.draining=true; e.intent=x.intent||'unknown'; e.deltaUsd=x.deltaUsd; by[x.id]=e;
  });
  var arr=Object.keys(by).map(function(k){return by[k]});
  // log radius scale: thin liquidity -> near center
  var rs=arr.map(function(a){return a.reserve>0?Math.log(a.reserve):0}).filter(function(v){return v>0});
  var lo=Math.min.apply(null,rs.concat([Math.log(2000)])), hi=Math.max.apply(null,rs.concat([Math.log(500000)]));
  arr.forEach(function(a){
    var ang=(hash(a.id)%3600)/10; // stable 0..360
    var lr=a.reserve>0?Math.log(a.reserve):lo;
    var norm=hi>lo?Math.max(0,Math.min(1,(lr-lo)/(hi-lo))):0.5;
    var rad=22+(1-norm)*70; // deep pools (norm~1) sit calm in the core; thin/young pools ring the outer rug zone
    var rr=(ang-90)*Math.PI/180;
    a.ang=ang; a.x=100+rad*Math.cos(rr); a.y=100+rad*Math.sin(rr);
    a.size=2+norm*2.4;
    a.color=a.draining?(a.intent==='migration'?'#fbbf24':(a.intent==='exit'?'#ff8a9c':'#ff4d6d')):(a.changePct>=0.05?'#00ff88':(a.changePct<=-0.05?'#ff4d6d':(a.watch?'#fbbf24':'#5b6b80')));
  });
  return arr;
}

function renderScope(d){
  var g=$('blips'); g.innerHTML='';
  blips=buildBlips(d);
  blips.forEach(function(a){
    if(a.draining && a.intent!=='migration' && a.intent!=='exit'){
      var ring=document.createElementNS(NS,'circle');
      ring.setAttribute('cx',a.x);ring.setAttribute('cy',a.y);ring.setAttribute('r','3');
      ring.setAttribute('fill','none');ring.setAttribute('stroke','#ff4d6d');ring.setAttribute('stroke-width','0.7');
      ring.innerHTML='<animate attributeName="r" from="3" to="16" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" from="0.85" to="0" dur="1.4s" repeatCount="indefinite"/>';
      g.appendChild(ring);
    }
    var c=document.createElementNS(NS,'circle');
    c.setAttribute('class','blip');c.setAttribute('cx',a.x);c.setAttribute('cy',a.y);
    c.setAttribute('r',a.draining?Math.max(a.size,3):a.size);c.setAttribute('fill',a.color);
    c.style.filter='drop-shadow(0 0 '+(a.draining?4:2)+'px '+a.color+')';
    c.addEventListener('mousemove',function(ev){showTip(ev,a)});
    c.addEventListener('mouseleave',function(){tip.style.opacity=0});
    c.addEventListener('click',function(){if(a.id)window.open(dp(a.chain,a.id),'_blank','noopener')});
    c._a=a; g.appendChild(c);
  });
}
function showTip(ev,a){
  var p=(a.changePct>=0?'+':'')+(a.changePct*100||0).toFixed(1)+'%';
  tip.innerHTML='<b>'+esc(a.label||a.id)+'</b><br><span class="'+(a.changePct<0?'dn':'')+'">'+p+'</span> <span class="s">'+(a.reserve?usd(a.reserve)+' liq':'')+(a.draining?' · draining '+usd(a.deltaUsd):'')+' · click to open</span>';
  tip.style.left=Math.min(ev.clientX+12,innerWidth-250)+'px';
  tip.style.top=(ev.clientY+12)+'px';tip.style.opacity=1;
}

function renderFeed(d){
  var f=$('feed'); var dr=d.draining||[];
  if(!dr.length){ f.innerHTML='<div class="empty">No drains caught right now. Watching '+(d.watching||0)+' pools on the live stream.</div>'; }
  else{
    f.innerHTML=dr.slice(0,8).map(function(x){
      var p=(x.pct!=null?(x.pct*100).toFixed(1)+'%':'new');
      var it=x.intent||'unknown';
      var bc=it==='migration'?'#fbbf24':(it==='exit'?'#ff8a9c':'#ff4d6d');
      return '<a class="row" style="border-left-color:'+bc+'" href="'+dp(x.chain,x.id)+'" target="_blank" rel="noopener"><div class="top"><span class="nm">'+esc(x.label||x.id)+intentTag(it)+'</span><span class="amt">-'+usd(x.deltaUsd)+'</span></div><div class="sub">'+esc(x.chain)+' · -'+p+' · '+ago(x.t)+'</div></a>';
    }).join('');
  }
  var cw=d.rugWatch||[];
  $('cw').innerHTML=cw.length?('<h3 style="margin:6px 0 4px"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> In the crosshairs</h3>'+cw.slice(0,6).map(function(w){return '<a class="x" href="'+dp(w.chain,w.id)+'" target="_blank" rel="noopener"><span class="nm">'+esc(w.label||w.id)+'</span><b>'+usd(w.reserveUsd)+'</b></a>'}).join('')):'';
}

// eased counters
var cur={};
function setT(id,t){$(id).dataset.t=t}
function stepCounters(){
  ['s_caught','s_drained','s_watch','s_scan'].forEach(function(id){
    var el=$(id);var t=+el.dataset.t||0;var c=cur[id]||0;c+=(t-c)*0.18;if(Math.abs(t-c)<0.5)c=t;cur[id]=c;
    el.textContent=(id==='s_drained')?usd(c):Math.round(c).toLocaleString();
  });
}

function render(d){
  data=d;
  $('hdr').textContent=(d.watching||0)+' on the radar · '+(d.scanning||0).toLocaleString()+' discovered';
  setT('s_caught',d.stats?(d.stats.rugs||0):0);
  setT('s_drained',(d.draining||[]).reduce(function(a,x){return a+Math.abs(x.deltaUsd||0)},0));
  setT('s_watch',d.watching||0);
  setT('s_scan',d.scanning||0);
  renderScope(d); renderFeed(d);
}

// sweep + blip glow loop
var sweep=$('sweep'), PERIOD=4200;
function frame(now){
  var ang=((now%PERIOD)/PERIOD)*360;
  sweep.style.transform='rotate('+ang+'deg)';
  // a blip just behind the trailing edge of the arm glows brightest, then fades
  var nodes=$('blips').getElementsByClassName('blip');
  for(var j=0;j<nodes.length;j++){
    var bl=nodes[j]._a; if(!bl)continue;
    if(bl.draining){nodes[j].style.opacity=1;continue;}
    var dd=(ang-bl.ang)%360; if(dd<0)dd+=360;
    var lit=dd<55?(1-dd/55):0;
    nodes[j].style.opacity=(0.38+0.62*lit).toFixed(2);
  }
  stepCounters();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function poll(){try{var r=await fetch('/api/live',{cache:'no-store'});render(await r.json());}catch(e){$('hdr').textContent='reconnecting...';}}
poll(); setInterval(poll,2000);
</script>
</body></html>`;
