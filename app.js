import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            'AIzaSyAUSbC8zJUgZF6IFdCtgIF8V57Js6sj1f8',
  authDomain:        'book-club-b411a.firebaseapp.com',
  projectId:         'book-club-b411a',
  storageBucket:     'book-club-b411a.firebasestorage.app',
  messagingSenderId: '93293269272',
  appId:             '1:93293269272:web:f32f8fedf6d4ff17e48e6d',
};
const db = getFirestore(initializeApp(firebaseConfig));

// ──────────────────────────────────────────────────────────
// Book Club Wheel
// ──────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────
const ATTENDANCE_DECAY   = 0.80;
const SELECTION_HALFLIFE = 8;   // sessions for penalty to reach ~63% recovery

const COLORS = [
  '#593F62', '#574B6C', '#555776', '#506F8A',
  '#979FDD', '#9CA8BD', '#A1B09D', '#AAC05C',
  '#D5D880',
  '#DAA8AD', '#C88193', '#B55A78', '#874D6D'
];

// Shuffled once on page load; reused every render so colors don't change mid-session
const SHUFFLED_COLORS = [...COLORS];
for (let i = SHUFFLED_COLORS.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [SHUFFLED_COLORS[i], SHUFFLED_COLORS[j]] = [SHUFFLED_COLORS[j], SHUFFLED_COLORS[i]];
}


// ── Club meta ─────────────────────────────────────────────
let currentClubId = localStorage.getItem('bookclub-active') || '';
let currentClub   = '';   // display name, derived from clubList
let clubList      = [];   // [{ id, name }]
let _unsubClub    = null;

async function loadMeta() {
  const snap = await getDoc(doc(db, 'meta', 'clublist'));
  clubList = snap.exists() ? (snap.data().clubs || []) : [];
  if (clubList.length === 0) {
    const id = uid();
    clubList = [{ id, name: 'Book Club 1' }];
    await setDoc(doc(db, 'meta', 'clublist'), { clubs: clubList });
    await setDoc(doc(db, 'clubs', id), { name: 'Book Club 1', members: [], meetings: [], nextMeeting: { chosenBook: null } });
  }
  if (!clubList.find(c => c.id === currentClubId)) currentClubId = clubList[0].id;
  currentClub = clubList.find(c => c.id === currentClubId)?.name || '';
  localStorage.setItem('bookclub-active', currentClubId);
}

function saveMeta() {
  setDoc(doc(db, 'meta', 'clublist'), { clubs: clubList })
    .catch(e => console.error('saveMeta failed:', e));
}

// ── Admin mode ────────────────────────────────────────────
let adminMode        = false;
let clubPasswordHash = null;  // SHA-256 hash from Firestore

function loadAdminMode() {
  adminMode = localStorage.getItem(`bookclub-admin-${currentClubId}`) === 'true';
}
function setAdminMode(val) {
  adminMode = val;
  if (val) localStorage.setItem(`bookclub-admin-${currentClubId}`, 'true');
  else localStorage.removeItem(`bookclub-admin-${currentClubId}`);
}
async function hashPassword(pwd) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── State ───────────────────────────────────────────────
let state = {
  members:     [],  // { id, name, currentBook, currentAuthor, bookUpdatedAt }
  meetings:    [],  // { id, date, attendees:[id], chosenBook:{memberId,title,author} }
  nextMeeting: { chosenBook: null },
};

// UI state (not persisted)
let wheel = { segments: [], currentAngle: 0, spinning: false };
let editingMeetingId    = null;
let editingMemberId     = null;
let nextMeetingExpanded = false;
let wheelShowWeights    = false;

// ── Persistence ──────────────────────────────────────────
function save() {
  setDoc(doc(db, 'clubs', currentClubId), {
    name: currentClub, members: state.members,
    meetings: state.meetings, nextMeeting: state.nextMeeting,
  }, { merge: true }).catch(e => console.error('Save failed:', e));
}

function subscribeToClub() {
  if (_unsubClub) { _unsubClub(); _unsubClub = null; }
  return new Promise(resolve => {
    let resolved = false;
    _unsubClub = onSnapshot(doc(db, 'clubs', currentClubId), snap => {
      const d = snap.exists() ? snap.data() : {};
      state.members     = d.members     || [];
      state.meetings    = d.meetings    || [];
      state.nextMeeting = d.nextMeeting || { chosenBook: null };
      clubPasswordHash  = d.adminPassword || null;
      if (!resolved) { resolved = true; resolve(); return; }
      if (!snap.metadata.hasPendingWrites)
        renderTab(document.querySelector('.tab.active')?.dataset.tab || 'history');
    });
  });
}

// ── Utilities ────────────────────────────────────────────
let _uid = 0;
function uid() { return `${Date.now().toString(36)}-${(++_uid).toString(36)}`; }
function currentDate() { return new Date().toISOString().split('T')[0]; }

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function getMember(id) { return state.members.find(m => m.id === id); }
function getMeeting(date) { return state.meetings.find(m => m.date === date); }

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let _toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${type !== 'info' ? ' ' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function chosenBookHtml(cb) {
  if (!cb) return '<em>No book recorded</em>';
  const name   = escHtml(getMember(cb.memberId)?.name ?? '?');
  const title  = escHtml(cb.title);
  const author = cb.author ? ` <span class="chosen-author">by ${escHtml(cb.author)}</span>` : '';
  const link   = cb.url   ? ` <a href="${escHtml(cb.url)}" target="_blank" rel="noopener" class="goodreads-link">Goodreads ↗</a>` : '';
  return `<strong>${name}</strong> - "${title}"${author}${link}`;
}

// ── Weight Calculation ───────────────────────────────────
function computeWeights() {
  const past = [...state.meetings].sort((a, b) => b.date.localeCompare(a.date));

  // Eligible: must have a book suggestion
  const eligible = state.members.filter(m =>
    m.currentBook && m.currentBook.trim()
  );
  if (eligible.length === 0) return [];

  const segments = eligible.map((member, idx) => {
    const memberId = member.id;

    // Attendance score: Σ 0.8^sessions_ago for each attended meeting (always > 0 here)
    let attendanceScore = past.reduce((sum, m, i) => {
      if (!m.attendees.includes(memberId)) return sum;
      return sum + Math.pow(ATTENDANCE_DECAY, i + 1);
    }, 0);
    if (attendanceScore < 0.2) attendanceScore = 0.2;  // base score for non-attendees

    // Selection multiplier: hard 0 if chosen last session; shifted exponential recovery after that.
    // Formula: 1 − exp(−(lastPickedIdx) / HALFLIFE), where lastPickedIdx is 0-based index in past[].
    // lastPickedIdx=0 (chosen most recently) → hard 0 regardless of formula.
    // lastPickedIdx=1 (2 sessions ago)       → 1 − exp(−1/8) ≈ 12%
    // lastPickedIdx=7 (8 sessions ago)       → 1 − exp(−7/8) ≈ 58%
    const lastPickedIdx = past.findIndex(m => m.chosenBook?.memberId === memberId);
    let selectionMult;
    if (lastPickedIdx < 0) {
      selectionMult = 1.0;   // never chosen
    } else if (lastPickedIdx === 0) {
      selectionMult = 0;     // chosen last session: ineligible this round
    } else {
      selectionMult = 1 - Math.exp(-lastPickedIdx / SELECTION_HALFLIFE);
    }

    const weight = Math.pow(attendanceScore, 0.5) * selectionMult;  // sqrt compresses attendance range

    return {
      memberId,
      name:            member.name,
      book:            member.currentBook,
      author:          member.currentAuthor || '',
      url:             member.currentBookUrl || '',
      color:           SHUFFLED_COLORS[idx % SHUFFLED_COLORS.length],
      attendanceScore: Math.round(attendanceScore * 100) / 100,
      selectionMult:   Math.round(selectionMult * 100) / 100,
      lastPicked:      lastPickedIdx >= 0 ? past[lastPickedIdx].date : null,
      weight,
      normalizedWeight: 0,
    };
  });

  // Normalise only among spinnable members (weight > 0); 0-weight members stay in list for display
  const spinnable = segments.filter(s => s.weight > 0);
  const total = spinnable.reduce((s, r) => s + r.weight, 0);
  if (total > 0) spinnable.forEach(r => { r.normalizedWeight = r.weight / total; });

  return segments;  // includes 0-weight members so the table can show why they're excluded
}

// ── Audio ─────────────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) _audioCtx = new Ctx();
  }
  return _audioCtx;
}

function playTick(speed) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const length = Math.floor(ctx.sampleRate * 0.03);
  const buf  = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++)
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4);
  const src    = ctx.createBufferSource();
  src.buffer   = buf;
  const filter = ctx.createBiquadFilter();
  filter.type  = 'bandpass';
  filter.frequency.value = 700 + speed * 800;
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.value = 0.12 + speed * 0.22;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start();
}

function playWin() {
  const audio = new Audio('jesuschristisgod-children-saying-yay-praise-and-worship-jesus-299607.mp3');
  audio.volume = 0.5;
  audio.play();
}

// ── Wheel Drawing ────────────────────────────────────────
function drawWheel(ctx, segments, rotation) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(cx, cy) - 12;

  ctx.clearRect(0, 0, W, H);

  if (segments.length === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#e8e0d6';
    ctx.fill();
    ctx.fillStyle = '#7a6e5e';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No book suggestions', cx, cy - 8);
    ctx.fillText('(add in Members tab)', cx, cy + 12);
    return;
  }

  let startAngle = rotation - Math.PI / 2;
  segments.forEach(seg => {
    const sweep    = seg.normalizedWeight * Math.PI * 2;
    const endAngle = startAngle + sweep;
    const midAngle = startAngle + sweep / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (sweep > 0.12) {
      const tr = R * 0.64;
      const tx = cx + Math.cos(midAngle) * tr;
      const ty = cy + Math.sin(midAngle) * tr;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(midAngle + Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur  = 2;
      const name = seg.name.length > 13 ? seg.name.slice(0, 12) + '…' : seg.name;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(name, 0, 0);
      if (sweep > 0.32) {
        const book = seg.book.length > 16 ? seg.book.slice(0, 15) + '…' : seg.book;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(book, 0, 14);
      }
      ctx.restore();
    }
    startAngle = endAngle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1207';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ── Spin Animation ───────────────────────────────────────
// segments = real weighted segments (used for the pick)
// displaySegments = what gets drawn (may have equal sizes if weights are hidden)
function doSpin(segments, displaySegments, canvasEl, onDone) {
  if (wheel.spinning || segments.length === 0) return;

  // Weighted random pick using real weights
  const roll = Math.random();
  let cum = 0, winner = segments[segments.length - 1];
  for (const seg of segments) { cum += seg.normalizedWeight; if (roll < cum) { winner = seg; break; } }

  // Animate to land the winner's segment at the pointer.
  // Use displaySegments for angle calculation so the visual lines up with what's drawn.
  const displayWinner = displaySegments.find(s => s.memberId === winner.memberId);
  let cumAngle = 0;
  for (const seg of displaySegments) { if (seg === displayWinner) break; cumAngle += seg.normalizedWeight * Math.PI * 2; }
  const winnerMid   = cumAngle + (displayWinner.normalizedWeight * Math.PI * 2) / 2;
  const extraSpins  = (7 + Math.floor(Math.random() * 5)) * Math.PI * 2;
  const targetAngle = extraSpins - winnerMid;
  const startAngle  = wheel.currentAngle;
  const duration    = 4500 + Math.random() * 1500;
  const startTime   = performance.now();
  const ctx         = canvasEl.getContext('2d');

  const tickInterval = (Math.PI * 2) / Math.max(displaySegments.length, 8);
  let tickAccum = 0, prevEased = 0;

  wheel.spinning = true;
  function frame(now) {
    if (!document.getElementById('wheel-canvas')) { wheel.spinning = false; return; }
    const t     = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 4);
    wheel.currentAngle = startAngle + (targetAngle - startAngle) * eased;
    drawWheel(ctx, displaySegments, wheel.currentAngle);

    const angleDelta = Math.abs((eased - prevEased) * (targetAngle - startAngle));
    const speed      = Math.min(1, (eased - prevEased) * 80);
    tickAccum += angleDelta;
    while (tickAccum >= tickInterval) {
      playTick(speed);
      tickAccum -= tickInterval;
    }
    prevEased = eased;

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      wheel.currentAngle = ((targetAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      wheel.spinning     = false;
      playWin();
      onDone(winner);
    }
  }
  requestAnimationFrame(frame);
}

// ── Club Selector ────────────────────────────────────────
function renderClubSelector() {
  const el = document.getElementById('club-selector');
  if (!el) return;
  el.innerHTML = `
    <select id="club-select" class="club-select">
      ${clubList.map(c => `<option value="${escHtml(c.id)}"${c.id === currentClubId ? ' selected' : ''}>${escHtml(c.name)}</option>`).join('')}
      <option value="__new__">+ New club…</option>
    </select>`;
  document.getElementById('club-select').addEventListener('change', e => {
    const val = e.target.value;
    if (val === '__new__') createClub();
    else switchClub(val);
  });
}

async function switchClub(id) {
  if (id === currentClubId) return;
  currentClubId = id;
  currentClub   = clubList.find(c => c.id === id)?.name || '';
  localStorage.setItem('bookclub-active', currentClubId);
  editingMeetingId = null; editingMemberId = null; nextMeetingExpanded = false;
  await subscribeToClub();
  loadAdminMode();
  renderClubSelector();
  renderTab(document.querySelector('.tab.active')?.dataset.tab || 'history');
}

async function createClub() {
  const name = prompt('New club name:')?.trim();
  if (!name) { renderClubSelector(); return; }
  if (clubList.find(c => c.name === name)) { toast('A club with that name already exists.', 'error'); renderClubSelector(); return; }
  const id = uid();
  clubList.push({ id, name });
  currentClubId = id;
  currentClub   = name;
  saveMeta();
  await setDoc(doc(db, 'clubs', id), { name, members: [], meetings: [], nextMeeting: { chosenBook: null } });
  localStorage.setItem('bookclub-active', currentClubId);
  await subscribeToClub();
  renderClubSelector();
  renderTab(document.querySelector('.tab.active')?.dataset.tab || 'history');
}

function renameClub() {
  const name = prompt('Rename club to:', currentClub)?.trim();
  if (!name || name === currentClub) { renderClubSelector(); return; }
  if (clubList.find(c => c.name === name)) { toast('A club with that name already exists.', 'error'); return; }
  const entry = clubList.find(c => c.id === currentClubId);
  if (entry) entry.name = name;
  currentClub = name;
  saveMeta();
  updateDoc(doc(db, 'clubs', currentClubId), { name }).catch(e => console.error('Rename failed:', e));
  renderClubSelector();
  toast('Club renamed.', 'success');
}

async function deleteClub() {
  if (clubList.length === 1) return;
  if (!confirm(`Delete "${currentClub}" and all its data? This cannot be undone.`)) return;
  await deleteDoc(doc(db, 'clubs', currentClubId));
  clubList = clubList.filter(c => c.id !== currentClubId);
  currentClubId = clubList[0].id;
  currentClub   = clubList[0].name;
  saveMeta();
  localStorage.setItem('bookclub-active', currentClubId);
  editingMeetingId = null; editingMemberId = null; nextMeetingExpanded = false;
  await subscribeToClub();
  renderClubSelector();
  renderTab(document.querySelector('.tab.active')?.dataset.tab || 'history');
  toast('Club deleted.', 'success');
}

// ── Config Tab ───────────────────────────────────────────
function renderConfig() {
  const panel = document.getElementById('tab-config');
  if (!panel) return;

  if (adminMode) {
    panel.innerHTML = `
      <h2>Club Config <span class="admin-badge">Admin</span></h2>
      <div class="config-section">
        <h3>This club</h3>
        <div class="config-row">
          <strong>${escHtml(currentClub)}</strong>
          <button class="btn btn-sm" id="cfg-rename-btn">Rename</button>
          <button class="btn btn-sm btn-danger" id="cfg-delete-btn" ${clubList.length === 1 ? 'disabled' : ''}>Delete club</button>
        </div>
      </div>
      <div class="config-section">
        <h3>Password</h3>
        <button class="btn btn-sm" id="cfg-change-pwd-btn">Change password</button>
      </div>
      <div class="config-section">
        <h3>Data</h3>
        <div class="data-row">
          <button class="btn" id="export-btn">Export data</button>
          <button class="btn" id="import-btn">Import data</button>
        </div>
        <input type="file" id="import-file" accept=".json" style="display:none">
      </div>
      <hr style="margin:24px 0">
      <button class="btn" id="cfg-exit-btn">Exit admin mode</button>`;

    document.getElementById('cfg-rename-btn').addEventListener('click', renameClub);
    document.getElementById('cfg-delete-btn').addEventListener('click', deleteClub);
    document.getElementById('cfg-change-pwd-btn').addEventListener('click', changeAdminPassword);
    document.getElementById('export-btn').addEventListener('click', exportData);
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', e => importData(e.target));
    document.getElementById('cfg-exit-btn').addEventListener('click', () => {
      setAdminMode(false);
      renderConfig();
      const active = document.querySelector('.tab.active')?.dataset.tab;
      if (active && active !== 'config') renderTab(active);
    });

  } else if (!clubPasswordHash) {
    panel.innerHTML = `
      <h2>Club Config</h2>
      <p class="hint">No admin password has been set for this club yet. Set one to enable admin mode.</p>
      <div class="config-lock-form">
        <input type="password" id="cfg-pwd1" class="text-input" placeholder="New password…">
        <input type="password" id="cfg-pwd2" class="text-input" placeholder="Confirm password…">
        <button class="btn btn-primary" id="cfg-set-btn">Set password &amp; unlock</button>
        <p class="config-error" id="cfg-error"></p>
      </div>`;
    document.getElementById('cfg-set-btn').addEventListener('click', setAdminPassword);

  } else {
    panel.innerHTML = `
      <h2>Club Config</h2>
      <p class="hint">Enter the admin password to access settings.</p>
      <div class="config-lock-form">
        <input type="password" id="cfg-pwd" class="text-input" placeholder="Password…">
        <button class="btn btn-primary" id="cfg-unlock-btn">Unlock</button>
        <p class="config-error" id="cfg-error"></p>
      </div>`;
    const unlock = () => unlockAdmin();
    document.getElementById('cfg-unlock-btn').addEventListener('click', unlock);
    document.getElementById('cfg-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
  }
}

async function unlockAdmin() {
  const pwd = document.getElementById('cfg-pwd')?.value;
  if (!pwd) return;
  const hash = await hashPassword(pwd);
  if (hash === clubPasswordHash) {
    setAdminMode(true);
    renderConfig();
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active && active !== 'config') renderTab(active);
  } else {
    const err = document.getElementById('cfg-error');
    if (err) err.textContent = 'Incorrect password.';
  }
}

async function setAdminPassword() {
  const pwd1 = document.getElementById('cfg-pwd1')?.value;
  const pwd2 = document.getElementById('cfg-pwd2')?.value;
  const err  = document.getElementById('cfg-error');
  if (!pwd1) { if (err) err.textContent = 'Please enter a password.'; return; }
  if (pwd1 !== pwd2) { if (err) err.textContent = 'Passwords do not match.'; return; }
  const hash = await hashPassword(pwd1);
  clubPasswordHash = hash;
  await updateDoc(doc(db, 'clubs', currentClubId), { adminPassword: hash });
  setAdminMode(true);
  renderConfig();
}

async function changeAdminPassword() {
  const pwd1 = prompt('New password:')?.trim();
  if (!pwd1) return;
  const pwd2 = prompt('Confirm new password:')?.trim();
  if (pwd1 !== pwd2) { toast('Passwords do not match.', 'error'); return; }
  const hash = await hashPassword(pwd1);
  clubPasswordHash = hash;
  await updateDoc(doc(db, 'clubs', currentClubId), { adminPassword: hash });
  toast('Password changed.', 'success');
}

// ── Tab System ───────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));
  renderTab(name);
}

function renderTab(name) {
  ({ spin: renderSpin, history: renderHistory, members: renderMembers, config: renderConfig })[name]?.();
}

// ── Spin Tab ─────────────────────────────────────────────
function getDisplaySegs(spinSegs) {
  if (wheelShowWeights) return spinSegs;
  const n = spinSegs.length;
  return spinSegs.map(s => ({ ...s, normalizedWeight: n > 0 ? 1 / n : 0 }));
}

function renderSpin() {
  const segs     = computeWeights();
  const spinSegs = segs.filter(s => s.weight > 0);
  wheel.segments = spinSegs;

  const chosen = state.nextMeeting.chosenBook;
  const winnerPanel = chosen ? `
    <div class="spin-result-panel">
      <p class="winner-label">Next book…</p>
      <div class="winner-name">${escHtml(getMember(chosen.memberId)?.name ?? '?')}</div>
      <div class="winner-book">"${escHtml(chosen.title)}"${chosen.author ? `<div class="winner-author">by ${escHtml(chosen.author)}</div>` : ''}</div>
      <p class="hint" style="margin-top:8px">Go to <strong>History</strong> to record this meeting once it happens.</p>
      <div class="winner-btns">
        <button class="btn" id="spin-again-btn">Spin Again</button>
      </div>
    </div>` : '';

  // Non-admins always see equal segments (no weights revealed)
  const displayForRender = adminMode ? getDisplaySegs(spinSegs) : spinSegs.map(s => ({
    ...s, normalizedWeight: spinSegs.length > 0 ? 1 / spinSegs.length : 0,
  }));

  document.getElementById('tab-spin').innerHTML = `
    <div class="spin-center">
      <div class="wheel-container">
        <div class="wheel-pointer">▼</div>
        <canvas id="wheel-canvas" width="360" height="360"></canvas>
      </div>
      ${adminMode ? `
        <button class="btn-spin" id="spin-btn" ${spinSegs.length === 0 ? 'disabled' : ''}>SPIN!</button>
        <button class="btn btn-sm" id="weights-toggle-btn">${wheelShowWeights ? 'Hide weights' : 'Show weights'}</button>
        ${spinSegs.length === 0 ? '<p class="empty" style="margin-top:12px">Members need a book suggestion to enter the draw.</p>' : ''}
      ` : '<p class="hint" style="margin-top:12px">Only an admin can spin the wheel.</p>'}
    </div>
    ${winnerPanel}
  `;

  const canvas = document.getElementById('wheel-canvas');
  if (canvas) drawWheel(canvas.getContext('2d'), displayForRender, wheel.currentAngle);

  document.getElementById('spin-btn')?.addEventListener('click', startSpin);
  document.getElementById('weights-toggle-btn')?.addEventListener('click', () => {
    wheelShowWeights = !wheelShowWeights;
    renderSpin();
  });
  document.getElementById('spin-again-btn')?.addEventListener('click', () => {
    if (!adminMode) return;
    state.nextMeeting.chosenBook = null;
    save();
    startSpin();
  });
}

function startSpin() {
  const canvas = document.getElementById('wheel-canvas');
  if (!canvas || wheel.spinning || wheel.segments.length === 0) return;
  document.getElementById('spin-btn').disabled = true;
  const displaySegs = getDisplaySegs(wheel.segments);
  doSpin(wheel.segments, displaySegs, canvas, winner => {
    state.nextMeeting.chosenBook = { memberId: winner.memberId, title: winner.book, author: winner.author, url: winner.url };
    save();
    renderSpin();
  });
}

// ── History Tab ───────────────────────────────────────────
function renderHistory() {
  const sorted = [...state.meetings].sort((a, b) => b.date.localeCompare(a.date));

  document.getElementById('tab-history').innerHTML = `
    <h2>Meeting History</h2>
    ${adminMode ? `
    <div class="add-meeting-bar">
      <input type="date" id="new-meeting-date" value="${currentDate()}" class="text-input">
      <button class="btn btn-primary" id="add-meeting-btn">Add Past Meeting</button>
    </div>` : ''}
    <div class="history-list" id="history-list">
      ${renderNextMeetingCard()}
      ${sorted.length === 0
        ? '<p class="empty" style="margin-top:16px">No past meetings.</p>'
        : sorted.map(renderMeetingCard).join('')}
    </div>
  `;

  document.getElementById('add-meeting-btn')?.addEventListener('click', addMeeting);
  attachHistoryEvents();
}

function renderNextMeetingCard() {
  const chosen    = state.nextMeeting.chosenBook;
  const chosenHtml = chosen
    ? `<strong>${escHtml(getMember(chosen.memberId)?.name ?? '?')}</strong> - "${escHtml(chosen.title)}"${chosen.author ? ` <span class="chosen-author">by ${escHtml(chosen.author)}</span>` : ''}`
    : '<em>Not yet spun</em>';

  if (!nextMeetingExpanded) {
    return `
      <div class="hc hc-next">
        <div class="hc-top">
          <div class="hc-date">Next Meeting</div>
          ${adminMode ? `<button class="btn btn-sm btn-primary" data-action="next-happened">Meeting happened ✓</button>` : ''}
        </div>
        <div class="hc-chosen">📖 ${chosenHtml}</div>
      </div>`;
  }

  const sortedMembers = [...state.members].sort((a, b) => a.name.localeCompare(b.name));

  const memberOptions = `<option value="">- none -</option>` +
    sortedMembers.map(m => {
      const sel = chosen?.memberId === m.id ? 'selected' : '';
      return `<option value="${m.id}" ${sel}>${escHtml(m.name)}</option>`;
    }).join('');

  const checkboxes = sortedMembers.length === 0
    ? '<p class="empty">No members added yet.</p>'
    : sortedMembers.map(m => `
        <label class="member-card checked">
          <input type="checkbox" name="next-attendee" value="${m.id}" checked>
          <span class="mc-name">${escHtml(m.name)}</span>
          <span class="mc-book">${escHtml(m.currentBook || '')}</span>
        </label>`).join('');

  return `
    <div class="hc hc-next hc-editing">
      <div class="hc-next-label">Next Meeting → Record</div>
      <div class="edit-field-row">
        <label>Date</label>
        <input type="date" id="next-meeting-date" value="${currentDate()}" class="text-input">
      </div>
      <div class="edit-section-label">Who attended</div>
      <div class="member-grid">${checkboxes}</div>
      <div class="edit-field-row">
        <label>Chosen by</label>
        <select id="next-winner" class="text-input">${memberOptions}</select>
      </div>
      <div class="edit-field-row">
        <label>Title</label>
        <input type="text" id="next-book-title" class="text-input"
               value="${escHtml(chosen?.title ?? '')}" placeholder="Book title…" style="flex:1">
      </div>
      <div class="edit-field-row">
        <label>Author</label>
        <input type="text" id="next-book-author" class="text-input"
               value="${escHtml(chosen?.author ?? '')}" placeholder="Author…" style="flex:1">
      </div>
      <div class="edit-field-row">
        <label>Goodreads</label>
        <input type="url" id="next-book-url" class="text-input"
               value="${escHtml(chosen?.url ?? '')}" placeholder="https://goodreads.com/book/…" style="flex:1">
      </div>
      <div class="action-row">
        <button class="btn btn-success" data-action="next-save">Save</button>
        <button class="btn" data-action="next-cancel">Cancel</button>
      </div>
    </div>`;
}

function confirmNextMeeting() {
  const date = document.getElementById('next-meeting-date').value;
  if (!date) { toast('Please pick a date.', 'error'); return; }
  if (getMeeting(date)) { toast('A meeting already exists on this date.', 'error'); return; }

  const attendees = Array.from(document.querySelectorAll('[name="next-attendee"]:checked')).map(cb => cb.value);
  const winnerId  = document.getElementById('next-winner').value;
  const title     = document.getElementById('next-book-title').value.trim();
  const author    = document.getElementById('next-book-author').value.trim();
  const url       = document.getElementById('next-book-url').value.trim();

  state.meetings.push({
    id: uid(), date, attendees,
    chosenBook: winnerId && title ? { memberId: winnerId, title, author, url } : null,
  });
  state.nextMeeting.chosenBook = null;
  nextMeetingExpanded = false;
  save();
  toast('Meeting saved to history!', 'success');
  renderHistory();
}

function renderMeetingCard(m) {
  if (m.id === editingMeetingId) return renderEditCard(m);

  const attendeeNames = m.attendees.map(id => getMember(id)?.name ?? '(removed)').join(', ') || 'Nobody';

  return `
    <div class="hc" data-id="${m.id}">
      <div class="hc-top">
        <div class="hc-date">${formatDate(m.date)}</div>
        ${adminMode ? `<div class="hc-btns">
          <button class="btn btn-sm" data-action="edit" data-id="${m.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-id="${m.id}">Delete</button>
        </div>` : ''}
      </div>
      <div class="hc-chosen">📖 ${chosenBookHtml(m.chosenBook)}</div>
      <div class="hc-attendees">Attended (${m.attendees.length}): ${escHtml(attendeeNames)}</div>
    </div>`;
}

function renderEditCard(m) {
  const attendeeSet    = new Set(m.attendees);
  const chosenMemberId = m.chosenBook?.memberId ?? '';
  const chosenTitle    = m.chosenBook?.title    ?? '';
  const chosenAuthor   = m.chosenBook?.author   ?? '';
  const chosenUrl      = m.chosenBook?.url      ?? '';

  const sortedMembers = [...state.members].sort((a, b) => a.name.localeCompare(b.name));

  const checkboxes = sortedMembers.length === 0
    ? '<p class="empty">No members added yet.</p>'
    : sortedMembers.map(mem => `
        <label class="member-card ${attendeeSet.has(mem.id) ? 'checked' : ''}">
          <input type="checkbox" name="edit-attendee" value="${mem.id}" ${attendeeSet.has(mem.id) ? 'checked' : ''}>
          <span class="mc-name">${escHtml(mem.name)}</span>
          <span class="mc-book">${escHtml(mem.currentBook || '')}</span>
        </label>`).join('');

  const memberOptions = `<option value="">- none -</option>` +
    sortedMembers.map(mem =>
      `<option value="${mem.id}" ${mem.id === chosenMemberId ? 'selected' : ''}>${escHtml(mem.name)}</option>`
    ).join('');

  return `
    <div class="hc hc-editing" data-id="${m.id}">
      <div class="edit-field-row">
        <label>Date</label>
        <input type="date" id="edit-date" value="${m.date}" class="text-input">
      </div>
      <div class="edit-section-label">Who attended</div>
      <div class="member-grid">${checkboxes}</div>
      <div class="edit-field-row">
        <label>Chosen by</label>
        <select id="edit-winner" class="text-input">${memberOptions}</select>
      </div>
      <div class="edit-field-row">
        <label>Title</label>
        <input type="text" id="edit-book-title" class="text-input" value="${escHtml(chosenTitle)}" placeholder="Book title…" style="flex:1">
      </div>
      <div class="edit-field-row">
        <label>Author</label>
        <input type="text" id="edit-book-author" class="text-input" value="${escHtml(chosenAuthor)}" placeholder="Author…" style="flex:1">
      </div>
      <div class="edit-field-row">
        <label>Goodreads</label>
        <input type="url" id="edit-book-url" class="text-input" value="${escHtml(chosenUrl)}" placeholder="https://goodreads.com/book/…" style="flex:1">
      </div>
      <div class="action-row">
        <button class="btn btn-primary" data-action="save" data-id="${m.id}">Save</button>
        <button class="btn" data-action="cancel" data-id="${m.id}">Cancel</button>
        <button class="btn btn-danger" data-action="delete" data-id="${m.id}" style="margin-left:auto">Delete Meeting</button>
      </div>
    </div>`;
}

function attachHistoryEvents() {
  const list = document.getElementById('history-list');
  if (!list) return;

  list.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'next-happened') { nextMeetingExpanded = true;  renderHistory(); }
    if (action === 'next-cancel')   { nextMeetingExpanded = false; renderHistory(); }
    if (action === 'next-save')     confirmNextMeeting();
    if (action === 'edit')          { editingMeetingId = id; renderHistory(); }
    if (action === 'cancel')        { editingMeetingId = null; renderHistory(); }
    if (action === 'save')          saveMeetingEdit(id);
    if (action === 'delete')        deleteMeeting(id);
  });

  list.addEventListener('change', e => {
    if (e.target.name === 'next-attendee' || e.target.name === 'edit-attendee')
      e.target.closest('.member-card')?.classList.toggle('checked', e.target.checked);

    if (e.target.id === 'next-winner' || e.target.id === 'edit-winner') {
      const member    = getMember(e.target.value);
      const isNext    = e.target.id === 'next-winner';
      const titleEl   = document.getElementById(isNext ? 'next-book-title'  : 'edit-book-title');
      const authorEl  = document.getElementById(isNext ? 'next-book-author' : 'edit-book-author');
      const urlEl     = document.getElementById(isNext ? 'next-book-url'    : 'edit-book-url');
      if (titleEl  && member?.currentBook)    titleEl.value  = member.currentBook;
      if (authorEl && member?.currentAuthor)  authorEl.value = member.currentAuthor;
      if (urlEl    && member?.currentBookUrl) urlEl.value    = member.currentBookUrl;
    }
  });
}

function addMeeting() {
  const date = document.getElementById('new-meeting-date').value;
  if (!date) return;
  if (getMeeting(date)) { toast('A meeting on this date already exists.', 'error'); return; }
  const m = { id: uid(), date, attendees: [], chosenBook: null };
  state.meetings.push(m);
  editingMeetingId = m.id;
  save();
  renderHistory();
}

function saveMeetingEdit(id) {
  const meeting = state.meetings.find(m => m.id === id);
  if (!meeting) return;

  const newDate  = document.getElementById('edit-date').value;
  const attendees = Array.from(document.querySelectorAll('[name="edit-attendee"]:checked')).map(cb => cb.value);
  const winnerId  = document.getElementById('edit-winner').value;
  const title     = document.getElementById('edit-book-title').value.trim();
  const author    = document.getElementById('edit-book-author').value.trim();
  const url       = document.getElementById('edit-book-url').value.trim();

  if (newDate && newDate !== meeting.date && getMeeting(newDate)) {
    toast('Another meeting already exists on that date.', 'error'); return;
  }

  if (newDate) meeting.date = newDate;
  meeting.attendees  = attendees;
  meeting.chosenBook = winnerId && title ? { memberId: winnerId, title, author, url } : null;

  editingMeetingId = null;
  save();
  toast('Saved!', 'success');
  renderHistory();
}

function deleteMeeting(id) {
  if (!confirm('Delete this meeting? This cannot be undone.')) return;
  state.meetings = state.meetings.filter(m => m.id !== id);
  if (editingMeetingId === id) editingMeetingId = null;
  save();
  toast('Meeting deleted.', 'success');
  renderHistory();
}

// ── Members Tab (includes book suggestions) ───────────────
function renderMembers() {
  const sorted = [...state.members].sort((a, b) => a.name.localeCompare(b.name));

  const rows = sorted.length === 0
    ? '<p class="empty">No members yet.</p>'
    : sorted.map(m => m.id === editingMemberId ? renderMemberEditRow(m) : renderMemberRow(m)).join('');

  document.getElementById('tab-members').innerHTML = `
    <h2>Members</h2>
    <p class="hint">Add or update your book suggestion below. ${adminMode ? 'As admin you can also add and remove members.' : ''}</p>
    ${adminMode ? `
    <div class="add-row">
      <input type="text" id="new-member-name" class="text-input" placeholder="Member name…" autocomplete="off">
      <button class="btn btn-primary" id="add-member-btn">Add Member</button>
    </div>` : ''}
    <div class="members-list" id="members-list">${rows}</div>
  `;

  if (adminMode) {
    document.getElementById('add-member-btn').addEventListener('click', addMember);
    document.getElementById('new-member-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') addMember();
    });
  }

  document.getElementById('members-list').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, memberId } = el.dataset;
    if (action === 'edit-member')   { editingMemberId = memberId; renderMembers(); }
    if (action === 'cancel-member') { editingMemberId = null;     renderMembers(); }
    if (action === 'save-member')   saveMemberBook(memberId);
    if (action === 'remove' && adminMode) removeMember(memberId);
  });
}

function renderMemberRow(m) {
  const meetingsAttended = state.meetings.filter(mt => mt.attendees.includes(m.id)).length;
  const hasBook = m.currentBook && m.currentBook.trim();

  const bookSection = hasBook
    ? `<div class="mr-book-display">
         <div class="mr-book-title">"${escHtml(m.currentBook)}"</div>
         ${m.currentAuthor ? `<div class="mr-book-author">by ${escHtml(m.currentAuthor)}</div>` : ''}
         ${m.currentBookUrl ? `<a href="${escHtml(m.currentBookUrl)}" target="_blank" rel="noopener" class="goodreads-link">Goodreads ↗</a>` : ''}
         ${m.bookUpdatedAt ? `<div class="mr-book-meta">Updated ${formatDate(m.bookUpdatedAt)}</div>` : ''}
       </div>
       <button class="btn btn-sm" data-action="edit-member" data-member-id="${m.id}">Edit suggestion</button>`
    : `<div class="mr-no-book">No book suggestion</div>
       <button class="btn btn-sm btn-primary" data-action="edit-member" data-member-id="${m.id}">+ Add suggestion</button>`;

  return `
    <div class="member-row">
      <div class="mr-header">
        <span class="mr-name">${escHtml(m.name)}</span>
        <span class="mr-meetings">${meetingsAttended} meeting${meetingsAttended !== 1 ? 's' : ''}</span>
        ${adminMode ? `<button class="btn btn-sm btn-danger" data-action="remove" data-member-id="${m.id}">Remove</button>` : ''}
      </div>
      <div class="mr-book-section">
        ${bookSection}
      </div>
    </div>`;
}

function renderMemberEditRow(m) {
  return `
    <div class="member-row mr-editing">
      <div class="mr-header">
        <span class="mr-name">${escHtml(m.name)}</span>
        <span class="mr-meetings">${state.meetings.filter(mt => mt.attendees.includes(m.id)).length} meetings</span>
        <button class="btn btn-sm btn-danger" data-action="remove" data-member-id="${m.id}">Remove</button>
      </div>
      <div class="mr-book-section mr-book-editing">
        <div class="mr-edit-fields">
          <div class="mr-edit-field">
            <label>Book</label>
            <input type="text" id="mr-book-input" class="text-input" value="${escHtml(m.currentBook || '')}" placeholder="Book title…">
          </div>
          <div class="mr-edit-field">
            <label>Author</label>
            <input type="text" id="mr-author-input" class="text-input" value="${escHtml(m.currentAuthor || '')}" placeholder="Author name…">
          </div>
          <div class="mr-edit-field">
            <label>Goodreads</label>
            <input type="url" id="mr-url-input" class="text-input" value="${escHtml(m.currentBookUrl || '')}" placeholder="https://goodreads.com/book/…">
          </div>
        </div>
        <div class="mr-edit-actions">
          <button class="btn btn-sm btn-primary" data-action="save-member" data-member-id="${m.id}">Save</button>
          <button class="btn btn-sm" data-action="cancel-member" data-member-id="${m.id}">Cancel</button>
        </div>
      </div>
    </div>`;
}

function saveMemberBook(id) {
  const member = getMember(id);
  if (!member) return;
  const title  = document.getElementById('mr-book-input').value.trim();
  const author = document.getElementById('mr-author-input').value.trim();
  const url    = document.getElementById('mr-url-input').value.trim();
  const changed = title !== (member.currentBook || '') || author !== (member.currentAuthor || '') || url !== (member.currentBookUrl || '');
  if (changed) {
    member.currentBook    = title;
    member.currentAuthor  = author;
    member.currentBookUrl = url;
    member.bookUpdatedAt  = currentDate();
    save();
    toast('Updated.', 'success');
  }
  editingMemberId = null;
  renderMembers();
}

function addMember() {
  const input = document.getElementById('new-member-name');
  const name  = input.value.trim();
  if (!name) return;
  if (state.members.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    toast('Member already exists.', 'error'); return;
  }
  state.members.push({ id: uid(), name, currentBook: '', currentAuthor: '', currentBookUrl: '', bookUpdatedAt: null });
  save();
  input.value = '';
  toast(`Added ${name}`, 'success');
  renderMembers();
}

function removeMember(id) {
  const member = getMember(id);
  if (!member) return;
  if (!confirm(`Remove "${member.name}"? Their history in past meetings is kept.`)) return;
  state.members = state.members.filter(m => m.id !== id);
  if (editingMemberId === id) editingMemberId = null;
  save();
  toast('Member removed.', 'success');
  renderMembers();
}

// ── Data Import / Export ──────────────────────────────────
function exportData() {
  const blob = new Blob(
    [JSON.stringify({ members: state.members, meetings: state.meetings, nextMeeting: state.nextMeeting }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: `bookclub-${currentDate()}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!Array.isArray(d.members) || !Array.isArray(d.meetings))
        throw new Error('Unexpected format');
      state.members     = d.members;
      state.meetings    = d.meetings;
      state.nextMeeting = d.nextMeeting || { chosenBook: null };
      save();
      toast('Data imported!', 'success');
      renderTab('members');
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
  input.value = '';
}

// ── Init ─────────────────────────────────────────────────
async function init() {
  document.getElementById('tab-history').innerHTML = '<p class="empty" style="padding:24px">Connecting…</p>';
  await loadMeta();
  await subscribeToClub();
  loadAdminMode();
  renderClubSelector();
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  renderHistory();
}

document.addEventListener('DOMContentLoaded', () => init().catch(e => {
  console.error('Init failed:', e);
  document.getElementById('tab-history').innerHTML =
    '<p class="empty" style="padding:24px;color:var(--error)">Failed to connect to database. Check your internet connection and refresh.</p>';
}));
