// Control window logic. Talks to the main process only through the `uc` bridge from preload.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let current = null;
let selectedMeeting = null;

const PERMISSIONS = ['accessibility', 'screen-capture', 'microphone'];

// Recall hears this computer's microphone as one speaker; this names it. Remembered between launches.
const YOU_KEY = 'uc.localName';
function initName(suggested) {
  let saved = null;
  try {
    saved = localStorage.getItem(YOU_KEY);
  } catch {
    // storage unavailable: fall back to the suggestion
  }
  if (!$('you').value) $('you').value = saved || suggested || '';
}
const SCREEN_KEY = 'uc.screenContext';
try {
  if (localStorage.getItem(SCREEN_KEY) === 'off') $('screenContext').checked = false;
} catch {
  // storage unavailable: keep the default (on)
}
$('screenContext').onchange = () => {
  try {
    localStorage.setItem(SCREEN_KEY, $('screenContext').checked ? 'on' : 'off');
  } catch {
    // not remembered
  }
};

$('you').onchange = () => {
  try {
    localStorage.setItem(YOU_KEY, $('you').value.trim());
  } catch {
    // not remembered; still used for this capture
  }
};

function render(s) {
  current = s;
  initName(s.localName);
  const rec = s.recording;
  const recording = rec && (rec.status === 'recording' || rec.status === 'starting');
  $('recBadge').innerHTML = recording ? '<span class="rec">REC</span>' : '';

  const sdk = { starting: 'Starting Recall.ai SDK…', ready: `Recall.ai SDK ready · ${esc(s.recallRegion)}`, unavailable: 'Recall.ai SDK unavailable', error: 'Not connected' }[s.sdk];
  $('status').innerHTML =
    `<div class="row"><span>${sdk}</span>${s.sdk !== 'ready' ? '<button id="retry">Retry</button>' : ''}</div>` +
    (s.sdkMessage ? `<div class="err">${esc(s.sdkMessage)}</div>` : '') +
    (s.network === 'disconnected' ? '<div class="err">Network disconnected. Recall stops recording after 2 minutes offline.</div>' : '');
  if ($('retry')) $('retry').onclick = () => window.uc.retry();

  $('permissions').innerHTML =
    s.sdk === 'ready'
      ? PERMISSIONS.map((p) => {
          const st = s.permissions[p] ?? 'unknown';
          return `<div class="row"><span>${p}</span>${st === 'granted' ? '<span class="muted">granted</span>' : `<button data-perm="${p}">Grant (${esc(st)})</button>`}</div>`;
        }).join('')
      : '';
  document.querySelectorAll('[data-perm]').forEach((b) => (b.onclick = () => window.uc.requestPermission(b.dataset.perm)));

  if (s.meetings.length === 0) {
    $('meetings').innerHTML = '<span class="muted">Waiting for Zoom, Google Meet or Microsoft Teams…</span>';
    selectedMeeting = null;
  } else {
    if (!s.meetings.some((m) => m.id === selectedMeeting)) selectedMeeting = s.meetings[0].id;
    $('meetings').innerHTML = s.meetings
      .map((m) => `<label class="meeting"><input type="radio" name="meeting" value="${esc(m.id)}" ${m.id === selectedMeeting ? 'checked' : ''}/> ${esc(m.title || 'Untitled meeting')} <span class="muted">${esc(m.platform || '')}</span></label>`)
      .join('');
    document.querySelectorAll('input[name=meeting]').forEach((r) => (r.onchange = () => (selectedMeeting = r.value)));
  }

  $('start').style.display = recording ? 'none' : '';
  $('stop').style.display = recording ? '' : 'none';
  $('panel').style.display = rec ? '' : 'none';
  $('start').disabled = s.sdk !== 'ready' || !selectedMeeting || !$('consent').checked;
  $('recInfo').textContent = rec
    ? `${rec.status === 'recording' ? 'Recording' : rec.status} · ${rec.meeting?.title || 'meeting'} · since ${new Date(rec.startedAt).toLocaleTimeString()}${rec.error ? ` · ${rec.error}` : ''}`
    : '';

  const sc = s.screen;
  $('screenContext').disabled = !sc.available;
  $('screenInfo').textContent = !rec
    ? sc.available
      ? ''
      : 'Screen reading is unavailable on this Mac.'
    : sc.state === 'reading'
      ? `Screen: reading${sc.lastMatch ? ` · on screen: ${sc.lastMatch}` : ' · no code from the repository on screen'}`
      : sc.state === 'error'
        ? `Screen: ${sc.message}`
        : sc.state === 'unavailable'
          ? `Screen: ${sc.message}`
          : '';

  const f = s.forwarding;
  $('forwarding').textContent = `Transcript events delivered: ${f.sent}${f.pending ? ` · waiting: ${f.pending}` : ''}${f.failures ? ` · retries: ${f.failures} (${f.lastError})` : ''}`;
  $('log').textContent = s.log.join('\n');
}

async function loadSessions() {
  const [sessions, repos] = await Promise.all([window.uc.sessions().catch(() => []), window.uc.repos().catch(() => [])]);
  const active = sessions.filter((x) => x.status === 'active');
  $('session').innerHTML =
    '<option value="__new">+ New session for this meeting</option>' + active.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('');
  $('repo').innerHTML =
    '<option value="">No repository</option>' +
    repos.filter((r) => r.indexingStatus === 'ready').map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  $('newSession').style.display = $('session').value === '__new' ? '' : 'none';
}

$('session').onchange = () => ($('newSession').style.display = $('session').value === '__new' ? '' : 'none');
$('consent').onchange = () => current && render(current);

$('start').onclick = async () => {
  $('startError').textContent = '';
  $('start').disabled = true;
  try {
    let sessionId = $('session').value;
    if (sessionId === '__new') {
      const m = current.meetings.find((x) => x.id === selectedMeeting);
      const created = await window.uc.createSession({ title: $('title').value.trim() || m?.title || 'Meeting', repositoryId: $('repo').value || null });
      sessionId = created.id;
    }
    await window.uc.start({ windowId: selectedMeeting, sessionId, consentConfirmed: $('consent').checked, localName: $('you').value.trim() || null, screenContext: $('screenContext').checked && !$('screenContext').disabled });
    await loadSessions();
    $('session').value = sessionId;
  } catch (err) {
    $('startError').textContent = String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    render(current);
  }
};
$('stop').onclick = () => window.uc.stop();
$('panel').onclick = () => current?.recording && window.uc.openPanel(current.recording.sessionId);

window.uc.onState(render);
window.uc.state().then(render);
loadSessions();
