// Inspelaren: ett MediaRecorder-spår per källa, så att allt går att ändra i efterhand.
//   screen.webm  skärmen UTAN markör (getDisplayMedia med cursor: 'never')
//   system.webm  datorljud (loopback)      mic.webm  mikrofon      camera.webm  kamera
// Bitarna skickas till huvudprocessen varje sekund och skrivs löpande, så en krasch förlorar
// högst sekunden som pågick. Alla spår stämplas med verklig starttid (Date.now) för synken.

const pick = list => list.find(m => MediaRecorder.isTypeSupported(m));
const VIDEO_MIME = pick(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
const AUDIO_MIME = pick(['audio/webm;codecs=opus', 'audio/webm']);

export class Recorder {
  constructor(hud, opts) {
    this.hud = hud; this.opts = opts;
    this.tracks = [];          // {kind, file, rec, startedAt, chain, deviceName}
    this.streams = [];
    this.notes = [];
    this.started = false;
    this.paused = false;
    this.pausedTotal = 0; this.pausedAt = 0;
    this.thumbnail = null;
  }

  async start() {
    const { opts } = this;
    // 1. Skärmen. cursor: 'never' = markören ritas inte in; den läggs på i redigeraren.
    let display, cursorBaked = null, usedFallback = false;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never', frameRate: { ideal: 60, max: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: opts.system,
      });
    } catch (e) {
      throw new Error('Skärmfångsten nekades eller misslyckades: ' + (e?.message || e));
    }
    this.streams.push(display);
    const vt = display.getVideoTracks()[0];
    const settings = vt.getSettings();
    if (settings.cursor === 'never') cursorBaked = false;
    else if (settings.cursor) cursorBaked = true;                // 'always' / 'motion'
    else this.notes.push('Osäkert om markören är dold i bilden');
    if (cursorBaked) this.notes.push('Markören ligger i bilden');
    vt.addEventListener('ended', () => this.hud.requestStop());

    // 2. Mikrofon och kamera. Misslyckas de fortsätter inspelningen utan dem.
    let mic = null, cam = null;
    if (opts.mic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: opts.clean, noiseSuppression: opts.clean, autoGainControl: false, channelCount: 1 },
        });
        this.streams.push(mic);
      } catch (e) { this.notes.push('Mikrofonen kunde inte öppnas'); }
    }
    if (opts.camera) {
      try {
        cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
        this.streams.push(cam);
      } catch (e) { this.notes.push('Kameran kunde inte öppnas'); }
    }

    // 3. Ett MediaRecorder per spår.
    const add = (kind, file, stream, mime, extra = {}) => {
      const rec = new MediaRecorder(stream, { mimeType: mime, ...extra });
      const t = { kind, file, rec, chain: Promise.resolve(), startedAt: 0, deviceName: stream.getTracks()[0]?.label || '' };
      rec.ondataavailable = ev => {
        if (!ev.data.size) return;
        t.chain = t.chain.then(async () => this.hud.chunk(file, new Uint8Array(await ev.data.arrayBuffer())));
      };
      t.started = new Promise(res => { rec.onstart = () => { t.startedAt = Date.now(); res(); }; });
      t.stopped = new Promise(res => { rec.onstop = res; });
      rec.onerror = e => this.notes.push(`${kind}: ${e.error?.message || 'fel'}`);
      this.tracks.push(t);
      return t;
    };
    const screenTrack = add('screen', 'screen.webm', new MediaStream([vt]), VIDEO_MIME, { videoBitsPerSecond: 16_000_000 });
    const sysTrack = display.getAudioTracks()[0];
    if (sysTrack) add('system', 'system.webm', new MediaStream([sysTrack]), AUDIO_MIME, { audioBitsPerSecond: 192_000 });
    else if (opts.system) this.notes.push('Inget datorljud fångades');
    if (mic) add('microphone', 'mic.webm', mic, AUDIO_MIME, { audioBitsPerSecond: 160_000 });
    if (cam) add('camera', 'camera.webm', cam, VIDEO_MIME, { videoBitsPerSecond: 4_000_000 });

    // 4. Start i samma tick. Skärmen sätter tidslinjens nollpunkt.
    for (const t of this.tracks) t.rec.start(1000);
    await Promise.all(this.tracks.map(t => t.started));
    this.t0 = screenTrack.startedAt;
    this.info = {
      pixelWidth: settings.width || 0, pixelHeight: settings.height || 0, frameRate: settings.frameRate || null, cursorBaked,
    };
    this.started = true;
    this.thumbnailPromise = this.grabThumbnail(display);
    await this.hud.begin({ t0: this.t0 });
  }

  elapsed() {
    if (!this.started) return 0;
    const now = this.paused ? this.pausedAt : Date.now();
    return (now - this.t0 - this.pausedTotal) / 1000;
  }

  togglePause() {
    if (!this.paused) { for (const t of this.tracks) if (t.rec.state === 'recording') t.rec.pause(); this.pausedAt = Date.now(); }
    else { for (const t of this.tracks) if (t.rec.state === 'paused') t.rec.resume(); this.pausedTotal += Date.now() - this.pausedAt; }
    this.paused = !this.paused;
    return this.paused;
  }

  async grabThumbnail(display) {
    try {
      const v = document.createElement('video');
      v.muted = true; v.srcObject = new MediaStream(display.getVideoTracks());
      await v.play();
      await new Promise(r => setTimeout(r, 900));
      const c = document.createElement('canvas');
      c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth) || 270;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const size = { w: v.videoWidth, h: v.videoHeight };
      v.pause(); v.srcObject = null;
      return { dataUrl: c.toDataURL('image/jpeg', 0.72), ...size };
    } catch { return null; }
  }

  async stop() {
    if (this.paused) this.togglePause();
    const endedAt = Date.now();
    for (const t of this.tracks) if (t.rec.state !== 'inactive') t.rec.stop();
    await Promise.all(this.tracks.map(t => t.stopped));
    await Promise.all(this.tracks.map(t => t.chain));
    for (const s of this.streams) for (const tr of s.getTracks()) tr.stop();
    const grab = await this.thumbnailPromise;
    // getSettings() ger önskad storlek; videons egen storlek är den verkliga.
    if (grab?.w) { this.info.pixelWidth = grab.w; this.info.pixelHeight = grab.h; }
    return this.hud.finish({
      ...this.info, endedAt, thumbnail: grab?.dataUrl ?? null,
      tracks: this.tracks.map(t => ({ kind: t.kind, file: t.file, startedAt: t.startedAt, deviceName: t.deviceName })),
    });
  }
}
