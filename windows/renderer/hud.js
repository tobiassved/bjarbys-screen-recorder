// Flytande reglage under inspelning. Fönstret är uteslutet ur fångsten (setContentProtection) och
// är också den som kör själva inspelningen (MediaRecorder per spår).
import { Recorder } from './recorder.js';

const pill = document.getElementById('pill');
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
let recorder = null, timerId = null;

api.hud.onTick(n => {
  if (n > 0) pill.innerHTML = `<span class="big">${n}</span>`;
});

function showRecording() {
  pill.innerHTML = `<span class="dot" id="dot"></span><span class="timer" id="timer">00:00</span><span class="hint" id="hint"></span>
    <button id="pause" title="Paus (Ctrl+Skift+P)">⏸</button><button id="stop" class="stop" title="Stoppa (Ctrl+Skift+R)">■</button>`;
  document.getElementById('stop').onclick = () => api.hud.requestStop();
  document.getElementById('pause').onclick = () => api.hud.requestPause();
  const hint = document.getElementById('hint');
  hint.textContent = recorder.notes.join(' · ');
  hint.title = recorder.notes.join('\n');
  timerId = setInterval(() => { document.getElementById('timer').textContent = fmt(recorder.elapsed()); }, 250);
}

window.__start = async () => {
  const opts = await api.hud.init();
  recorder = new Recorder(api.hud, opts);
  await recorder.start();
  showRecording();
};

api.hud.onStop(async () => {
  if (!recorder) return;
  clearInterval(timerId);
  pill.innerHTML = '<span class="hint">Sparar…</span>';
  try { await recorder.stop(); } catch (e) { await api.hud.fail(e.message); }
});

api.hud.onPauseToggle(async () => {
  if (!recorder?.started) return;
  const paused = recorder.togglePause();
  document.getElementById('dot')?.classList.toggle('paused', paused);
  document.getElementById('pause').textContent = paused ? '▶' : '⏸';
  await api.hud.pause(paused);
});
