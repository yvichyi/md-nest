(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const native = typeof window.Vinyl !== 'undefined';
  const hasCloud = typeof window.Netease !== 'undefined';
  const audio = native ? null : new Audio();
  const pending = new Map();
  let requestSeq = 0;
  let authTimer = null;
  let toastTimer = null;
  let audioRequest = 0;
  let lyricRequest = 0;
  let lastPaintedTrack = null;
  let stageTransitionTimer = null;
  // Independent visual clock: record rotation decelerates smoothly after pause.
  // No visual movement is used as evidence of audio playback; media state remains authoritative.
  const motion = {angle:0, velocity:0, raf:0, last:0, clockAt:0, clockPosition:0, uiPaintAt:0};
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let isSeeking = false;
  let toolsTimer = 0;
  function animateStage(time) {
    const dt = motion.last ? Math.min(64, Math.max(0, time - motion.last)) : 16;
    motion.last = time;
    if (reducedMotion.matches) {
      motion.velocity = 0;
    } else {
      const target = state.playing && !state.openingAudio ? 200 : 0; // 33⅓ RPM, measured in degrees per second
      const responseMs = target ? 1250 : 1580; // physical acceleration and graceful stop
      motion.velocity += (target - motion.velocity) * (1 - Math.exp(-dt/responseMs));
      motion.angle = (motion.angle + motion.velocity * dt / 1000) % 360;
      $('vinyl').style.transform = `rotate(${motion.angle.toFixed(3)}deg)`;
    }
    if (state.playing && !state.openingAudio) {
      const elapsed = Math.max(0, time - motion.clockAt);
      const visualPosition = motion.clockPosition + elapsed;
      // Keep the disc compositor at native frame rate; lyric/text layout needs only ~20 Hz.
      if (!motion.uiPaintAt || time - motion.uiPaintAt >= 50) {
        motion.uiPaintAt = time;
        updateProgressAt(visualPosition);
      }
    }
    if (state.playing || motion.velocity > 0.035) {
      motion.raf = requestAnimationFrame(animateStage);
    } else {
      motion.raf = 0;
      motion.last = 0;
      motion.uiPaintAt = 0;
      updateProgressAt(state.position);
    }
  }
  function requestStageFrame() {
    if (!motion.raf) {motion.last=0; motion.raf=requestAnimationFrame(animateStage);}
  }
  function resetPlaybackClock() {
    motion.clockAt = performance.now();motion.clockPosition=state.position;
  }
  function openTools(open) {
    clearTimeout(toolsTimer);
    document.querySelector('.application').classList.toggle('tools-visible', open);
    $('toolsToggle').setAttribute('aria-expanded', String(open));
  }

  const state = {
    queue: [], index: -1, position: 0, duration: 0, playing: false,
    repeat: 'all', shuffle: false, lyrics: [], activeLyric: -1,
    source: 'netease', account: false, nativeHasItem: false, lastSearch: [], activeOverlay: '',
    currentTab: 'search', openingAudio: false
  };

  const safeText = value => String(value ?? '').trim();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function notify(message) {
    const el = $('toast'); el.textContent = message;
    el.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3300);
  }
  function fmt(millis) {
    if (!Number.isFinite(millis) || millis < 0) return '00:00';
    const s = Math.floor(millis / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function current() { return state.queue[state.index] || null; }
  function spotifyLikeArtist(track) {
    const list = track.ar || track.artists || [];
    return Array.isArray(list) ? list.map(a => a.name).filter(Boolean).join(' / ') : '未知音乐人';
  }
  function normalize(track, source = 'netease') {
    const album = track.al || track.album || {};
    let artwork = album.picUrl || album.blurPicUrl || track.picUrl || '';
    // NetEase sometimes serves HTTP artwork; WebView uses HTTPS-only mixed-content policy.
    if (/^http:\/\/p\d+\.music\.126\.net\//i.test(artwork)) artwork = 'https://' + artwork.slice(7);
    return {
      id: String(track.id ?? ''), title: safeText(track.name) || '未命名曲目',
      artist: spotifyLikeArtist(track), artwork,
      source, uri: track.uri || '', duration: Number(track.dt || track.duration || 0)
    };
  }
  // A cover's chroma, not a fixed app skin, drives the stage, vinyl and controls.
  // Android samples NetEase CDN covers natively because canvas pixel access is usually CORS-blocked.
  let paletteSeq = 0;
  let lastArtwork = null;
  let nativeArtwork = {url:'', data:''};
  const artworkLookups = new Map();
  const neutralCoverColour = '#9a8780';
  function rgbToHsl(r,g,b) {
    r /= 255;g /= 255;b /= 255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),diff=max-min;
    let hue=0,sat=0;const light=(max+min)/2;
    if (diff) {
      sat=diff/(1-Math.abs(2*light-1));
      switch(max) {
        case r:hue=((g-b)/diff)%6;break;
        case g:hue=(b-r)/diff+2;break;
        default:hue=(r-g)/diff+4;
      }
      hue=(hue*60+360)%360;
    }
    return {hue,sat:Math.min(1,Math.max(0,sat)),light};
  }
  function paintPalette(hex) {
    const match=/^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!match) return false;
    const n=parseInt(match[1],16);
    let {hue,sat}=rgbToHsl(n>>16,(n>>8)&255,n&255);
    hue=Math.round(hue);
    const pct=(v)=>`${Math.round(v*100)}%`;
    const hsl=(s,l)=>`hsl(${hue} ${pct(s)} ${pct(l)})`;
    // Keep sufficiently bright paper and legible text even for very dark covers.
    const luminous= (Math.max(.0,Math.min(1,sat)));
    const root=document.documentElement.style;
    const props={
      '--cv-paper':hsl(.23+luminous*.12,.915),
      '--cv-paper-light':hsl(.31+luminous*.12,.975),
      '--cv-paper-deep':hsl(.23+luminous*.13,.845),
      '--cv-ink':hsl(.09+luminous*.09,.17),
      '--cv-muted':hsl(.1+luminous*.1,.43),
      '--cv-accent':hsl(Math.min(.82,Math.max(.40,.36+luminous*.52)),.55),
      '--cv-accent-dark':hsl(Math.min(.76,Math.max(.38,.30+luminous*.47)),.39),
      '--cv-disc':hsl(Math.min(.80,Math.max(.41,.40+luminous*.38)),.64),
      '--cv-disc-light':hsl(Math.min(.76,Math.max(.34,.37+luminous*.32)),.81),
      '--cv-disc-deep':hsl(Math.min(.86,Math.max(.42,.43+luminous*.39)),.47),
      '--cv-line':`hsla(${hue} 28% 32% / .17)`
    };
    Object.entries(props).forEach(([name,value])=>root.setProperty(name,value));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',hsl(.23+luminous*.12,.915));
    // HSL -> sRGB hex, only to colour Android status/navigation bars.
    if (native && typeof window.Vinyl.setChromeColour === 'function') {
      const s=.23+luminous*.12,l=.915;
      const a=s*Math.min(l,1-l);
      const channel=k=>{
        const c=(k+hue/30)%12;
        return Math.round(255*(l-a*Math.max(-1,Math.min(c-3,9-c,1))));
      };
      const hex='#'+[channel(0),channel(8),channel(4)].map(c=>c.toString(16).padStart(2,'0')).join('');
      window.Vinyl.setChromeColour(hex);
    }
    document.body.dataset.coverHue=String(hue);
    return true;
  }
  function browserDominantColour(url, seq) {
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      if (seq!==paletteSeq) return;
      try {
        const canvas=document.createElement('canvas');canvas.width=72;canvas.height=72;
        const context=canvas.getContext('2d',{willReadFrequently:true});
        context.drawImage(img,0,0,72,72);
        const pixels=context.getImageData(0,0,72,72).data;
        const bins=Array.from({length:24},()=>({weight:0,r:0,g:0,b:0}));
        let all={weight:0,r:0,g:0,b:0};
        for(let k=0;k<pixels.length;k+=16) {
          const r=pixels[k],g=pixels[k+1],b=pixels[k+2],a=pixels[k+3];
          if(a<192)continue;
          const {hue,sat,light}=rgbToHsl(r,g,b);
          if(light<.12||light>.98)continue;
          all.weight++;all.r+=r;all.g+=g;all.b+=b;
          if(sat<.17)continue;
          const bin=bins[Math.min(23,Math.floor(hue/15))];
          const weight=.65+sat*.9;
          bin.weight+=weight;bin.r+=r*weight;bin.g+=g*weight;bin.b+=b*weight;
        }
        const best=bins.reduce((x,y)=>y.weight>x.weight?y:x,bins[0]);
        const chosen=best.weight>0?best:all;
        if(chosen.weight) {
          const toByte=v=>Math.max(0,Math.min(255,Math.round(v/chosen.weight)));
          const hex='#'+[toByte(chosen.r),toByte(chosen.g),toByte(chosen.b)].map(v=>v.toString(16).padStart(2,'0')).join('');
          if(seq===paletteSeq)paintPalette(hex);
        }
      } catch(_) { /* Remote images without CORS need the native sampler. */ }
    };
    img.onerror=()=>{};
    img.src=url;
  }
  function updateArtworkPalette(artwork) {
    const url=artwork || '';
    if(url===lastArtwork)return;
    lastArtwork=url;
    nativeArtwork = {url:'', data:''};
    const seq=++paletteSeq;
    // Keep the outgoing colour until the next cover is sampled; avoid a neutral flash.
    if(!url) {paintPalette(neutralCoverColour);return;}
    if(hasCloud && typeof window.Netease.sampleArtwork==='function' &&
       /^https:\/\/p\d+\.music\.126\.net\//i.test(url)) {
      window.Netease.sampleArtwork(String(seq),url);
    } else browserDominantColour(url,seq);
  }
  function onArtworkAsset(id,hex,dataUri) {
    if(Number(id)!==paletteSeq || !current()?.artwork) return;
    if (hex) paintPalette(hex);
    if (dataUri && dataUri.startsWith('data:image/jpeg;base64,')) {
      nativeArtwork={url: current().artwork, data: dataUri};
      const cover=$('recordCover');cover.src=dataUri;cover.hidden=false;
      $('recordMonogram').hidden=true;
      $('miniCover').style.backgroundImage=`url(${JSON.stringify(dataUri)})`;
      $('ambientCover').style.backgroundImage=`url(${JSON.stringify(dataUri)})`;
    }
  }
  // Backwards compatibility for old native bridge during preview testing.
  function onArtworkPalette(id,hex) {if(Number(id)===paletteSeq && hex)paintPalette(hex);}

  function save() {
    try {
      localStorage.setItem('vf.queue.v1', JSON.stringify({
        queue: state.queue.filter(t => t.source !== 'browser'),
        index: state.index >= 0 ? state.queue.slice(0, state.index + 1).filter(t => t.source !== 'browser').length - 1 : -1,
        repeat: state.repeat, shuffle: state.shuffle
      }));
    } catch (_) {}
  }
  function restore() {
    try {
      const data = JSON.parse(localStorage.getItem('vf.queue.v1') || '{}');
      if (Array.isArray(data.queue)) state.queue = data.queue.slice(0, 400).filter(t => t && t.id && t.title);
      state.index = clamp(Number(data.index ?? -1), -1, state.queue.length - 1);
      state.repeat = ['all', 'one', 'off'].includes(data.repeat) ? data.repeat : 'all';
      state.shuffle = !!data.shuffle;
    } catch (_) {}
  }

  function request(path, params = {}) {
    if (!hasCloud) return Promise.reject(new Error('网页版预览不提供网易云 API；请使用 Android 应用。'));
    const id = `r${++requestSeq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('网易云接口请求超时')); }, 18000);
      pending.set(id, {resolve, reject, timeout});
      try { window.Netease.post(id, path, JSON.stringify(params)); }
      catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
  }
  function api(path, params) {
    return request(path, params).then(data => {
      if (data?.code === 301) throw new Error('账号登录已过期，请重新登录');
      return data;
    });
  }
  function onNetwork(id, success, raw) {
    const slot = pending.get(id); if (!slot) return;
    pending.delete(id); clearTimeout(slot.timeout);
    try {
      const data = JSON.parse(raw);
      if (!success) slot.reject(new Error(data.message || '网络请求失败'));
      else slot.resolve(data);
    } catch (error) { slot.reject(error); }
  }

  function lyricsPlaceholder(lines) {
    state.lyrics = []; state.activeLyric = -1;
    const parent = $('lyricLines'); parent.replaceChildren();
    lines.forEach((text, i) => {
      const p = document.createElement('p'); p.className = `lyric-line placeholder ${i === 1 ? 'active' : ''}`;
      p.textContent = text; parent.appendChild(p);
    });
  }
  function parseLrc(lrc) {
    const lines = [];
    if (!lrc) return lines;
    String(lrc).split(/\r?\n/).forEach(row => {
      const times = [...row.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      const text = row.replace(/\[[^\]]+\]/g, '').trim();
      if (!times.length || !text) return;
      for (const match of times) {
        const frac = match[3] || '0';
        const ms = Number(match[1]) * 60000 + Number(match[2]) * 1000
          + Number(frac.padEnd(3, '0').slice(0, 3));
        lines.push({time: ms, text});
      }
    });
    return lines.sort((a, b) => a.time - b.time);
  }
  function paintLyrics() {
    const parent = $('lyricLines'); parent.replaceChildren();
    for (let i = 0; i < state.lyrics.length; i++) {
      const p = document.createElement('p'); p.className = 'lyric-line';
      p.textContent = state.lyrics[i].text;
      p.dataset.line = String(i);
      parent.appendChild(p);
    }
    if (!state.lyrics.length) lyricsPlaceholder(['纯音乐，也值得认真聆听。', '让旋律填满房间。', '']);
  }
  async function loadLyrics(track) {
    const key = ++lyricRequest;
    lyricsPlaceholder(['歌词正在接近你。', '让声音慢慢浮现。', '']);
    if (track.source !== 'netease') {
      lyricsPlaceholder(['这首音乐来自你的设备。', '没有同步歌词。', '享受此刻的声音。']); return;
    }
    try {
      const data = await api('/api/lyric', { id: track.id });
      if (key !== lyricRequest) return;
      state.lyrics = parseLrc(data?.lrc?.lyric || data?.klyric?.lyric || '');
      state.activeLyric = -1;
      if (!state.lyrics.length) {
        lyricsPlaceholder(data?.nolyric ? ['纯音乐', '没有人声歌词。'] :
          ['网易云未返回同步歌词。', '这首歌可能没有已收录的 LRC。']);
      } else paintLyrics();
    } catch (error) {
      if (key === lyricRequest) lyricsPlaceholder(['歌词请求失败', error?.message || '检查网络后重试']);
    }
  }
  function syncLyrics(position = state.position) {
    if (!state.lyrics.length) return;
    let idx = -1;
    for (let i = 0; i < state.lyrics.length; i++) {
      if (state.lyrics[i].time <= position + 80) idx = i;
      else break;
    }
    // Karaoke-style progressive emphasis (line-level timing, not fake word timestamps).
    if (idx >= 0 && $('lyricLines').children[idx]) {
      const nextTime = state.lyrics[idx+1]?.time ?? Math.max(state.duration, state.lyrics[idx].time + 4000);
      const fraction = clamp((position - state.lyrics[idx].time) / Math.max(1000, nextTime - state.lyrics[idx].time), 0, 1);
      $('lyricLines').children[idx].style.setProperty('--line-fill', `${(fraction * 100).toFixed(1)}%`);
    }
    if (idx === state.activeLyric) return;
    state.activeLyric = idx;
    const wrapper = $('lyricLines');
    const children = wrapper.children;
    for (let i = 0; i < children.length; i++) children[i].classList.toggle('active', i === idx);
    if (idx >= 0 && children[idx]) {
      const line = children[idx];
      const lyricAlignment = matchMedia('(orientation:landscape)').matches ? .67 : .5;
      const target = line.offsetTop - wrapper.offsetTop - (wrapper.clientHeight - line.clientHeight) * lyricAlignment;
      wrapper.scrollTo({top: Math.max(0, target), behavior: reducedMotion.matches ? 'instant' : 'smooth'});
    }
  }

  function updateProgressAt(displayPosition) {
    const duration = state.duration > 0 ? state.duration : current()?.duration || 0;
    const position = duration > 0 ? Math.min(Math.max(0, displayPosition),duration) : Math.max(0, displayPosition);
    if (!isSeeking) {
      $('currentTime').textContent = fmt(position);
      const val = duration > 0 ? clamp(position / duration,0,1) : 0;
      $('seekSlider').value = Math.round(val * 1000);
      $('seekSlider').style.setProperty('--progress', `${(val * 100).toFixed(2)}%`);
    }
    $('totalTime').textContent = fmt(duration);
    syncLyrics(position);
  }
  function updateProgress() {
    resetPlaybackClock();
    updateProgressAt(state.position);
    if (state.playing) requestStageFrame();
  }
  function paint() {
    const t = current();
    const trackKey = t ? `${t.source}:${t.id}:${t.uri || ''}` : '';
    if (trackKey !== lastPaintedTrack) {
      lastPaintedTrack = trackKey;
      clearTimeout(stageTransitionTimer);
      const stage = $('stage');
      stage.classList.remove('track-changing');
      void stage.offsetWidth; // retrigger only when track identity changes
      stage.classList.add('track-changing');
      stageTransitionTimer = setTimeout(()=>stage.classList.remove('track-changing'), 800);
    }
    $('songTitle').textContent = t?.title || '声音，是时间的另一种形状。';
    $('songArtist').textContent = t?.artist || '选一首歌，让唱片开始转动。';
    $('miniTitle').textContent = t?.title || '未选择音乐';
    $('miniArtist').textContent = t?.artist || 'VINYL FIELD';
    $('topStatus').textContent = t ? `NOW PLAYING  /  ${String(state.index + 1).padStart(2,'0')}` : 'A SPACE FOR SOUND';
    $('editionTag').textContent = t ? 'NOW SPINNING  /  SIDE A' : 'THE SOUND OF STILLNESS';
    $('deckCaption').textContent = t ? `正在播放 · ${t.title}` : '等待下一段旋律';
    $('trackSource').textContent = t ? (t.source === 'netease' ? 'NETEASE CLOUD MUSIC' : 'LOCAL LIBRARY') : 'YOUR LISTENING ROOM';
    $('trackFormat').textContent = t?.source === 'netease' ? 'CLOUD AUDIO' : 'STEREO';
    $('trackMode').textContent = state.shuffle ? 'SHUFFLE' : state.repeat === 'one' ? 'REPEAT ONE' : state.repeat === 'off' ? 'ONCE' : 'REPEAT ALL';
    $('shuffleBtn').classList.toggle('active', state.shuffle);
    $('repeatBtn').classList.toggle('active', state.repeat !== 'off');
    $('repeatBtn').textContent = state.repeat === 'one' ? '↻¹' : '↻';
    $('recordMonogram').hidden = !!t?.artwork;
    const cover = $('recordCover');
    cover.hidden = !t?.artwork;
    if (t?.artwork) {
      const src = nativeArtwork.url === t.artwork && nativeArtwork.data ? nativeArtwork.data : t.artwork;
      if (cover.getAttribute('src') !== src) cover.src = src;
      $('miniCover').textContent = '';
      $('miniCover').style.backgroundImage = `url(${JSON.stringify(src)})`;
      $('ambientCover').style.backgroundImage = `url(${JSON.stringify(src)})`;
    } else {
      cover.removeAttribute('src'); $('miniCover').textContent = 'VF';
      $('miniCover').style.backgroundImage = 'none'; $('ambientCover').style.backgroundImage = 'none';
    }
    updateArtworkPalette(t?.artwork);
    paintPlaying(); updateProgress();
  }
  function paintPlaying() {
    $('vinyl').classList.toggle('spinning', state.playing);
    document.body.classList.toggle('is-playing',state.playing);
    requestStageFrame();
    $('toneArm').classList.toggle('engaged', state.playing);
    $('equalizer').classList.toggle('playing', state.playing);
    $('playIcon').querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    $('playbackState').textContent = state.openingAudio ? 'CONNECTING...' : state.playing ? 'NOW PLAYING' : 'READY TO PLAY';
  }

  async function hydrateArtwork(track) {
    if (!track || track.source !== 'netease' || track.artwork) return;
    const id=String(track.id || '');
    if (!/^\d+$/.test(id)) return;
    if (!artworkLookups.has(id)) {
      artworkLookups.set(id,api('/api/song/detail',{ids:id}).then(d=>{
        const song=d?.songs?.[0];
        if (!song || String(song.id)!==id) return '';
        return normalize(song).artwork;
      }).catch(()=>''));
    }
    const cover=await artworkLookups.get(id);
    if (!cover) {
      if (current()===track) notify('未获得这首歌曲的专辑封面，已保留中性主题');
      return;
    }
    track.artwork=cover;
    save();
    if (current()===track) paint();
  }

  async function playAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    const ticket = ++audioRequest;
    state.index = index; state.position = 0; state.duration = state.queue[index].duration || 0;
    state.playing = false; state.openingAudio = true; resetPlaybackClock(); save(); paint();
    const track = current(); loadLyrics(track);
    // Search responses often omit album.picUrl; hydrate actual details independently.
    // Artwork failure must never block audio playback or lyric fetching.
    void hydrateArtwork(track);
    try {
      let uri = track.uri;
      if (track.source === 'netease') {
        const data = await api('/api/song/enhance/player/url', {ids: JSON.stringify([track.id]), br: 320000});
        if (ticket !== audioRequest) return;
        uri = data?.data?.[0]?.url || '';
        if (!uri) throw new Error('平台未提供这首歌的可播放地址，可能需要会员或受版权限制');
      }
      if (!uri) throw new Error('缺少音频文件地址');
      // Some NetEase CDN links are returned as HTTP; try encrypted transport.
      if (track.source === 'netease' && uri.startsWith('http://')) uri = 'https://' + uri.slice(7);
      if (native) {
        window.Vinyl.play(uri, track.title, track.artist, track.artwork, track.id);
        state.nativeHasItem = true;
      } else {
        audio.pause(); audio.src = uri;
        await audio.play();
      }
      if (ticket !== audioRequest) return;
      state.openingAudio = false; state.playing = true; paintPlaying(); closeOverlay();
    } catch (error) {
      if (ticket !== audioRequest) return;
      state.openingAudio = false; state.playing = false; paintPlaying();
      notify(error.message || '无法播放，请切换其它歌曲');
    }
  }
  function enqueue(tracks, startAt = 0) {
    if (!Array.isArray(tracks) || !tracks.length) { notify('这里还没有音乐'); return; }
    state.queue = tracks.slice(0, 400);
    playAt(clamp(startAt, 0, state.queue.length - 1));
  }
  function next(auto = false) {
    if (!state.queue.length) return;
    if (auto && state.repeat === 'one') { playAt(state.index); return; }
    if (state.shuffle && state.queue.length > 1) {
      const other = Math.floor(Math.random() * (state.queue.length - 1));
      playAt(other >= state.index ? other + 1 : other); return;
    }
    if (state.index === state.queue.length - 1 && auto && state.repeat === 'off') {
      state.playing = false; state.openingAudio = false; paintPlaying(); return;
    }
    playAt((state.index + 1) % state.queue.length);
  }
  function previous() {
    if (!state.queue.length) return;
    if (state.position > 3000) { seek(0); return; }
    playAt((state.index - 1 + state.queue.length) % state.queue.length);
  }
  function seek(millis) {
    if (native) window.Vinyl.seek(Math.round(millis));
    else if (audio.src && Number.isFinite(audio.duration)) audio.currentTime = millis / 1000;
    state.position = millis; resetPlaybackClock(); updateProgress();
  }
  function togglePlay() {
    if (state.openingAudio) return;
    if (!current()) { openOverlay('libraryOverlay'); notify('先搜索或导入一首音乐'); return; }
    if (state.playing) {
      if (native) window.Vinyl.pause(); else audio.pause();
      state.playing = false;
    } else if (native) {
      if (!state.nativeHasItem) { playAt(state.index); return; }
      window.Vinyl.resume(); state.playing = true;
    } else if (audio.src) {
      audio.play().catch(e => notify(e.message)); state.playing = true;
    } else { playAt(state.index); return; }
    paintPlaying();
  }

  function makeResult(t, action, right = 'PLAY') {
    const div = document.createElement('div'); div.className = 'result'; div.tabIndex = 0;
    div.setAttribute('role', 'button'); div.setAttribute('aria-label', `播放 ${t.title}`);
    const cover = document.createElement('div'); cover.className = 'result-art';
    if (t.artwork) {
      const img = document.createElement('img'); img.src = t.artwork; img.alt = '';
      img.referrerPolicy = 'no-referrer'; cover.appendChild(img);
    } else cover.textContent = 'VF';
    const text = document.createElement('div'); text.className = 'result-copy';
    const title = document.createElement('strong'); title.textContent = t.title;
    const artist = document.createElement('span'); artist.textContent = t.artist || '未知音乐人';
    text.append(title, artist);
    const end = document.createElement('span'); end.className = 'result-end'; end.textContent = right;
    div.append(cover, text, end);
    div.addEventListener('click', action);
    div.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
    });
    return div;
  }
  function renderResults(tracks) {
    const root = $('results'); root.replaceChildren();
    tracks.forEach((t, i) => root.appendChild(makeResult(t, () => enqueue(tracks, i))));
  }
  function renderQueue() {
    const root = $('queueResults'); root.replaceChildren();
    if (!state.queue.length) { const p=document.createElement('p');p.className='panel-hint';p.textContent='队列空空的，去探索一首歌。';root.appendChild(p);return; }
    state.queue.forEach((t,i) => root.appendChild(makeResult(t, () => playAt(i), i === state.index ? 'NOW' : String(i+1).padStart(2,'0'))));
  }
  function renderLocal() {
    const root = $('localResults'); root.replaceChildren();
    const tracks = state.queue.filter(t=>t.source !== 'netease');
    if (!tracks.length) {const p=document.createElement('p');p.className='panel-hint';p.textContent='尚未导入本地歌曲';root.appendChild(p);return;}
    tracks.forEach(t=>root.appendChild(makeResult(t,()=>playAt(state.queue.indexOf(t)),'LOCAL')));
  }
  async function search(keywords) {
    if (!keywords) return;
    $('searchHint').textContent = `正在搜索「${keywords}」...`;
    $('results').replaceChildren();
    try {
      const response = await api('/api/search/get', {s: keywords, type: 1, limit: 35, offset: 0, total:'true'});
      const tracks = (response?.result?.songs || []).map(t=>normalize(t));
      state.lastSearch = tracks;
      $('searchHint').textContent = tracks.length ? `找到 ${tracks.length} 首相关歌曲 · 点击立即播放` : '没有找到相关曲目';
      renderResults(tracks);
    } catch (e) { $('searchHint').textContent = `搜索失败：${e.message}`; }
  }
  async function loadPlaylists() {
    $('playlistHint').textContent = '正在同步账号歌单...';
    const root = $('playlistResults');root.replaceChildren();
    try {
      const account = await api('/api/user/account', {});
      const uid = account?.account?.id || account?.profile?.userId;
      if (!uid) throw new Error('未能获取网易云用户 ID，请先登录');
      const data = await api('/api/user/playlist', {uid, limit: 50, offset: 0});
      const list = data?.playlist || [];
      $('playlistHint').textContent = `已找到 ${list.length} 个歌单`;
      list.forEach(p=>{
        const t = {title:p.name,artist:`${p.trackCount ?? '—'} 首歌曲`,artwork:p.coverImgUrl};
        root.appendChild(makeResult(t,()=>openPlaylist(p.id),'OPEN'));
      });
    } catch(e) { $('playlistHint').textContent = `歌单同步失败：${e.message}`; }
  }
  async function openPlaylist(id) {
    $('playlistHint').textContent = '正在载入歌单歌曲...';
    try {
      const data = await api('/api/playlist/detail', {id});
      const tracks = (data?.playlist?.tracks || []).map(t=>normalize(t));
      if (!tracks.length) throw new Error('该歌单未返回可播放曲目');
      enqueue(tracks,0);
    } catch (e) { notify(`歌单读取失败：${e.message}`); }
  }

  function openOverlay(id) {
    closeOverlay();state.activeOverlay = id;
    const el = $(id);el.classList.add('open');el.setAttribute('aria-hidden','false');
    if (id === 'queueOverlay') renderQueue();
    if (id === 'libraryOverlay') renderLocal();
    if (id === 'accountOverlay') {
      state.account = hasCloud && window.Netease.hasAccount();
      $('qrStatus').textContent = state.account ? '设备已保存网易云登录凭据' : '点击下方按钮获取登录二维码';
    }
  }
  function closeOverlay() {
    document.querySelectorAll('.overlay.open').forEach(el=>{el.classList.remove('open');el.setAttribute('aria-hidden','true');});
    state.activeOverlay = '';
    if (authTimer) { clearInterval(authTimer);authTimer = null; }
  }
  function selectTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab === tab));
    for (const [name, id] of [['search','tabSearch'],['playlists','tabPlaylists'],['local','tabLocal']])
      $(id).hidden = name !== tab;
    if (tab === 'local') renderLocal();
    if (tab === 'playlists' && state.account) loadPlaylists();
  }
  async function startQR() {
    if (!hasCloud) {notify('此功能仅在 Android 版本中可用');return;}
    if (authTimer) clearInterval(authTimer);
    $('qrStatus').textContent = '正在获取网易云登录二维码...';
    try {
      const keyData = await api('/api/login/qr/key',{timestamp:Date.now()});
      const key = keyData?.data?.unikey || keyData?.unikey;
      if (!key) throw new Error('获取登录凭证失败');
      // QR rendering is local: after obtaining unikey there is no second remote endpoint.
      const src = window.Netease.qrImage(`https://music.163.com/login?codekey=${encodeURIComponent(key)}`);
      if (!src) throw new Error('本地生成二维码失败');
      const img = document.createElement('img'); img.src = src;img.alt = '网易云音乐扫码登录二维码';
      $('qrContainer').replaceChildren(img);
      $('qrStatus').textContent = '请使用网易云音乐 App 扫码并确认授权';
      authTimer = setInterval(async()=>{
        try {
          const d = await api('/api/login/qr/check',{key,timestamp:Date.now()});
          if (d?.code === 802) $('qrStatus').textContent = '已扫描，请在手机上确认登录';
          if (d?.code === 803) {
            clearInterval(authTimer);authTimer=null;
            if (d?.sessionSaved) {
              state.account=true;
              $('qrStatus').textContent = '已连接网易云音乐';notify('网易云账号已接入');
            } else $('qrStatus').textContent = d?.message || '授权成功，但未获得会话凭据，请重新获取二维码';
          }
          if (d?.code === 800) {clearInterval(authTimer);authTimer=null;$('qrStatus').textContent='二维码已过期，请重新获取';}
        } catch(e) { $('qrStatus').textContent = e.message; }
      },2800);
    } catch(e) { $('qrStatus').textContent = `登录初始化失败：${e.message}`; }
  }
  function addLocalTrack(uri, title) {
    const track = {id:`local-${Date.now()}`,title:title.replace(/\.[^.]+$/,''),artist:'本地音频',artwork:'',source:uri.startsWith('blob:')?'browser':'local',uri,duration:0};
    state.queue.push(track);state.index = state.queue.length-1;save();renderLocal();playAt(state.index);
  }
  function attachEvents() {
    $('toolsToggle').addEventListener('click',()=>openTools(!$('toolsToggle').getAttribute('aria-expanded').includes('true')));
    $('stage').addEventListener('pointerdown',ev=>{
      if (!ev.target.closest('button') && document.querySelector('.application').classList.contains('tools-visible')) openTools(false);
    });
    $('homeBtn').addEventListener('click',closeOverlay);
    $('searchBtn').addEventListener('click',()=>{openTools(false);openOverlay('libraryOverlay');selectTab('search');setTimeout(()=>$('searchInput').focus(),260);});
    $('queueBtn').addEventListener('click',()=>{openTools(false);openOverlay('queueOverlay');});
    $('accountBtn').addEventListener('click',()=>{openTools(false);openOverlay('accountOverlay');});
    $('closeLibrary').addEventListener('click',closeOverlay);$('libraryBackdrop').addEventListener('click',closeOverlay);
    $('closeQueue').addEventListener('click',closeOverlay);$('queueBackdrop').addEventListener('click',closeOverlay);
    $('closeAccount').addEventListener('click',closeOverlay);$('accountBackdrop').addEventListener('click',closeOverlay);
    $('playBtn').addEventListener('click',togglePlay);$('prevBtn').addEventListener('click',previous);$('nextBtn').addEventListener('click',()=>next(false));
    $('shuffleBtn').addEventListener('click',()=>{state.shuffle=!state.shuffle;save();paint();notify(state.shuffle?'已开启随机播放':'已关闭随机播放');});
    $('repeatBtn').addEventListener('click',()=>{state.repeat=state.repeat==='all'?'one':state.repeat==='one'?'off':'all';save();paint();});
    $('seekSlider').addEventListener('pointerdown',()=>{isSeeking=true;});
    $('seekSlider').addEventListener('pointerup',()=>{isSeeking=false;});
    $('seekSlider').addEventListener('input',ev=>{
      const d=state.duration||current()?.duration||0;
      $('currentTime').textContent=fmt(Number(ev.target.value)/1000*d);
      ev.target.style.setProperty('--progress',`${Number(ev.target.value)/10}%`);
    });
    $('seekSlider').addEventListener('change',ev=>{isSeeking=false;const d=state.duration||current()?.duration||0;if(d)seek(Number(ev.target.value)/1000*d);});
    $('orientationBtn').addEventListener('click',()=>{
      if (!native){notify('请在手机上旋转屏幕，或在 Android App 中切换横屏');return;}
      if (matchMedia('(orientation:landscape)').matches)window.Vinyl.portrait();else window.Vinyl.landscape();
    });
    document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));
    $('searchForm').addEventListener('submit',ev=>{ev.preventDefault();search($('searchInput').value.trim());});
    $('loadPlaylists').addEventListener('click',loadPlaylists);
    $('pickFile').addEventListener('click',()=>native?window.Vinyl.pickAudio():$('browserFile').click());
    $('browserFile').addEventListener('change',ev=>{const f=ev.target.files?.[0];if(f)addLocalTrack(URL.createObjectURL(f),f.name);});
    $('startQr').addEventListener('click',startQR);
    $('cookieSubmit').addEventListener('click',()=>{
      if(!hasCloud){notify('请在 Android App 中连接账号');return;}
      if(window.Netease.importCookie($('cookieInput').value.trim())){
        state.account=true;$('cookieInput').value='';$('qrStatus').textContent='Cookie 已保存，请尝试加载歌单';notify('已保存账号凭据');
      }else notify('请输入包含 MUSIC_U 的有效 Cookie');
    });
    $('logoutBtn').addEventListener('click',()=>{if(hasCloud)window.Netease.logout();state.account=false;notify('本地账号已清除');closeOverlay();});
    document.addEventListener('keydown',ev=>{
      if(ev.key==='Escape'){openTools(false);closeOverlay();}
      if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
      if(ev.code==='Space'){ev.preventDefault();togglePlay();}
      if(ev.code==='ArrowRight')next(false);
      if(ev.code==='ArrowLeft')previous();
    });
    if(!native){
      audio.addEventListener('timeupdate',()=>{state.position=audio.currentTime*1000;state.duration=(audio.duration||0)*1000;updateProgress();});
      audio.addEventListener('ended',()=>next(true));
      audio.addEventListener('pause',()=>{state.playing=false;paintPlaying();});
      audio.addEventListener('play',()=>{state.playing=true;paintPlaying();});
      audio.addEventListener('error',()=>notify('无法解码音频文件'));
    }
  }
  function onNativeState(data) {
    if (!native || state.openingAudio) return;
    // Existing Android playback session can outlive the WebView / activity.
    state.nativeHasItem = !!data.hasItem;
    if (!data.hasItem) { state.playing = false; paintPlaying(); return; }
    state.playing = !!data.playing;
    state.position = Math.max(0, Number(data.position)||0);
    state.duration = Math.max(0, Number(data.duration)||0);
    paintPlaying();updateProgress();
  }
  function onNativeEnded(){next(true);}
  function onNativeError(message){state.openingAudio=false;state.playing=false;paintPlaying();notify(message||'播放器发生错误');}
  function onOrientationChange(){} // CSS responds to configuration changes.

  $('recordCover').addEventListener('error', () => {
    if (nativeArtwork.url === current()?.artwork && nativeArtwork.data) return;
    $('recordCover').hidden=true;
    $('recordMonogram').hidden=false;
  });
  window.VF={onNetwork,onNativeState,onNativeEnded,onNativeError,onArtworkPalette,onArtworkAsset,onOrientationChange,addLocalTrack,closeOverlay,parseLrc};
  restore();attachEvents();paint();
  state.account = hasCloud && window.Netease.hasAccount();
  if (!native) notify('浏览器预览：导入本地音频即可试听，云音乐接入需 Android App');
})();
