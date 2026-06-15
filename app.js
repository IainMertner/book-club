// ──────────────────────────────────────────────────────────
// Book Club Wheel
// ──────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────
const ATTENDANCE_DECAY   = 0.80;  // weight multiplier per session of distance
const SELECTION_HALFLIFE = 4;     // sessions before selection penalty halves
const FIRST_TIMER_BASE   = 0.30;  // base score for members with no prior meetings

const COLORS = [
  '#e05c5c','#3b82d6','#44aa72','#f59e0b','#8b5cf6',
  '#06b6d4','#ef6c00','#d946ef','#14b8a6','#f97316',
  '#6366f1','#10b981','#f43f5e','#64748b','#7c3aed',
];

// ── State ───────────────────────────────────────────────
let state = {
  members:  [],  // { id, name, currentBook, bookUpdatedAt }
  meetings: [],  // { id, date, attendees:[id], chosenBook:{memberId,title} }
};

// Spin result waiting to be confirmed — not persisted, re-spin if page reloads
let pendingSpin = null; // { memberId, title }

// Wheel animation state (not persisted)
let wheel = {
  segments:     [],
  currentAngle: 0,
  spinning:     false,
};

// ── Persistence ──────────────────────────────────────────
function save() {
  localStorage.setItem('bookclub-v1', JSON.stringify({
    members:  state.members,
    meetings: state.meetings,
  }));
}

function load() {
  try {
    const raw = localStorage.getItem('bookclub-v1');
    if (!raw) return;
    const d = JSON.parse(raw);
    state.members  = d.members  || [];
    state.meetings = d.meetings || [];
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

// ── Utilities ────────────────────────────────────────────
let _uid = 0;
function uid() {
  return `${Date.now().toString(36)}-${(++_uid).toString(36)}`;
}

function currentDate() {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}


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

// ── Weight Calculation ───────────────────────────────────
/**
 * Returns an array of segment descriptors for everyone attending spinDate's meeting.
 *
 * Attendance score: Σ ATTENDANCE_DECAY^(months_ago) for each past meeting attended.
 *   First-timers with no prior history get FIRST_TIMER_BASE so they still participate.
 *
 * Selection multiplier: 1 − exp(−months_since_last_chosen / SELECTION_HALFLIFE)
 *   Approaches 0 if chosen last month; approaches 1 as time passes.
 *   1.0 if never chosen (no penalty).
 *
 * Final weight = attendance_score × selection_multiplier (min 0.001).
 */
function computeWeights() {
  if (state.members.length === 0) return [];

  // All recorded meetings are past history, newest first
  const past = [...state.meetings].sort((a, b) => b.date.localeCompare(a.date));

  const segments = state.members.map((member, idx) => {
    const memberId = member.id;

    // Attendance score: Σ ATTENDANCE_DECAY^sessions_ago for each past meeting attended,
    // where sessions_ago = 1 for the most recent past meeting, 2 for the one before, etc.
    // All past meetings count toward the rank, so missing a session pushes older
    // attendances further back regardless of how much time passed.
    let attendanceScore = past.reduce((sum, m, idx) => {
      if (!m.attendees.includes(memberId)) return sum;
      const sessionsAgo = idx + 1;
      return sum + Math.pow(ATTENDANCE_DECAY, sessionsAgo);
    }, 0);

    if (attendanceScore === 0) attendanceScore = FIRST_TIMER_BASE;

    // Selection penalty: 1 − exp(−sessions_since_chosen / SELECTION_HALFLIFE)
    // Approaches 0 if chosen last session; approaches 1 as sessions pass.
    const lastPicked = past.find(m => m.chosenBook?.memberId === memberId);
    let selectionMult = 1.0;
    if (lastPicked) {
      const sessionsAgo = past.indexOf(lastPicked) + 1;
      selectionMult = 1 - Math.exp(-sessionsAgo / SELECTION_HALFLIFE);
    }

    const weight = Math.max(attendanceScore * selectionMult, 0.001);

    return {
      memberId,
      name:           member.name,
      book:           member.currentBook || '(no suggestion)',
      bookUpdatedAt:  member.bookUpdatedAt,
      color:          COLORS[idx % COLORS.length],
      attendanceScore: Math.round(attendanceScore * 100) / 100,
      selectionMult:   Math.round(selectionMult * 100) / 100,
      lastPicked:      lastPicked?.date ?? null,
      weight,
      normalizedWeight: 0, // filled below
    };
  }).filter(Boolean);

  const total = segments.reduce((s, r) => s + r.weight, 0);
  segments.forEach(r => { r.normalizedWeight = r.weight / total; });

  return segments;
}

// ── Wheel Drawing ────────────────────────────────────────
function drawWheel(ctx, segments, rotation) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
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
    ctx.fillText('No eligible members', cx, cy - 8);
    ctx.fillText('(record attendance first)', cx, cy + 12);
    return;
  }

  let startAngle = rotation - Math.PI / 2;

  segments.forEach(seg => {
    const sweep   = seg.normalizedWeight * Math.PI * 2;
    const endAngle = startAngle + sweep;
    const midAngle = startAngle + sweep / 2;

    // Segment
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text (skip tiny segments)
    if (sweep > 0.12) {
      const tr = R * 0.64;
      const tx = cx + Math.cos(midAngle) * tr;
      const ty = cy + Math.sin(midAngle) * tr;

      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(midAngle + Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';

      const name = seg.name.length > 13 ? seg.name.slice(0, 12) + '…' : seg.name;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur  = 2;
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

  // Centre hub
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1207';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ── Spin Animation ───────────────────────────────────────
/**
 * Picks winner by weight, then animates the wheel decelerating to land with
 * the winner's midpoint aligned with the top pointer (12 o'clock).
 */
function doSpin(segments, canvasEl, onDone) {
  if (wheel.spinning || segments.length === 0) return;

  // Weighted random pick
  const roll = Math.random();
  let cum = 0, winner = segments[segments.length - 1];
  for (const seg of segments) {
    cum += seg.normalizedWeight;
    if (roll < cum) { winner = seg; break; }
  }

  // Cumulative angle to centre of winner's segment
  let cumAngle = 0;
  for (const seg of segments) {
    if (seg === winner) break;
    cumAngle += seg.normalizedWeight * Math.PI * 2;
  }
  const winnerMid = cumAngle + (winner.normalizedWeight * Math.PI * 2) / 2;

  // We draw segments starting from (rotation − π/2).
  // Pointer is at absolute canvas angle −π/2 (top).
  // We need: rotation − π/2 + winnerMid = −π/2  ⟹  rotation = −winnerMid
  // Add full rotations for drama.
  const extraSpins   = (7 + Math.floor(Math.random() * 5)) * Math.PI * 2;
  const targetAngle  = extraSpins - winnerMid;

  const startAngle  = wheel.currentAngle;
  const duration    = 4500 + Math.random() * 1500;  // 4.5 – 6 s
  const startTime   = performance.now();
  const ctx         = canvasEl.getContext('2d');

  wheel.spinning = true;

  function frame(now) {
    // Guard: user may have navigated away
    if (!document.getElementById('wheel-canvas')) { wheel.spinning = false; return; }

    const t      = Math.min((now - startTime) / duration, 1);
    const eased  = 1 - Math.pow(1 - t, 4);  // ease-out quart
    wheel.currentAngle = startAngle + (targetAngle - startAngle) * eased;

    drawWheel(ctx, segments, wheel.currentAngle);

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      // Normalise to [0, 2π] so next spin starts cleanly
      wheel.currentAngle = ((targetAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      wheel.spinning     = false;
      onDone(winner);
    }
  }

  requestAnimationFrame(frame);
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
  ({ spin: renderSpin, books: renderBooks,
     history: renderHistory, members: renderMembers })[name]?.();
}

// ── Spin Tab ─────────────────────────────────────────────
function renderSpin() {
  const segs = computeWeights();
  wheel.segments = segs;

  const weightRows = segs.map(s => {
    const pct     = Math.round(s.normalizedWeight * 100);
    const penalty = s.lastPicked
      ? `${Math.round(s.selectionMult * 100)}% (chosen ${formatDate(s.lastPicked)})`
      : '100% (never chosen)';
    return `
      <tr>
        <td class="wt-name"><span class="wt-swatch" style="background:${s.color}"></span>${escHtml(s.name)}</td>
        <td class="wt-book" title="${escHtml(s.book)}">${escHtml(s.book)}</td>
        <td>${s.attendanceScore}</td>
        <td>${penalty}</td>
        <td class="wt-pct">${pct}%</td>
      </tr>`;
  }).join('');

  // Confirm panel: shown after spin, collects date + who actually attended
  const confirmPanel = pendingSpin ? `
    <div class="spin-result-panel">
      <p class="winner-label">This session's book…</p>
      <div class="winner-name">${escHtml(getMember(pendingSpin.memberId)?.name ?? '?')}</div>
      <div class="winner-book">"${escHtml(pendingSpin.title)}"</div>
      <div class="confirm-row">
        <label for="confirm-date">Date of meeting:</label>
        <input type="date" id="confirm-date" value="${currentDate()}" class="text-input">
      </div>
      <div class="edit-section-label" style="margin-top:16px">Who attended?</div>
      <div class="member-grid">
        ${state.members.map(m => `
          <label class="member-card checked">
            <input type="checkbox" name="confirm-attendee" value="${m.id}" checked>
            <span class="mc-name">${escHtml(m.name)}</span>
            <span class="mc-book">${escHtml(m.currentBook || '')}</span>
          </label>`).join('')}
      </div>
      <div class="winner-btns" style="margin-top:16px">
        <button class="btn btn-success" id="confirm-btn">✓ Save to History</button>
        <button class="btn" id="spin-again-btn">Spin Again</button>
      </div>
    </div>` : '';

  document.getElementById('tab-spin').innerHTML = `
    <h2>Spin</h2>
    <div class="spin-layout">
      <div class="wheel-side">
        <div class="wheel-container">
          <div class="wheel-pointer">▼</div>
          <canvas id="wheel-canvas" width="360" height="360"></canvas>
        </div>
        <button class="btn-spin" id="spin-btn" ${segs.length === 0 ? 'disabled' : ''}>SPIN!</button>
      </div>
      <div class="weights-side">
        <h3>Weights</h3>
        ${segs.length === 0
          ? '<p class="empty">Add members to start spinning.</p>'
          : `<table class="weight-table">
              <thead><tr>
                <th>Member</th><th>Book</th><th>Attend. score</th><th>Recency penalty</th><th>Chance</th>
              </tr></thead>
              <tbody>${weightRows}</tbody>
            </table>
            <p class="hint" style="margin-top:10px">
              <strong>Attend. score</strong> = Σ 0.8<sup>sessions ago</sup> per past meeting attended.<br>
              <strong>Recency penalty</strong> = 1 − e<sup>−sessions/4</sup> if their book was recently chosen.
            </p>`
        }
      </div>
    </div>
    ${confirmPanel}
  `;

  const canvas = document.getElementById('wheel-canvas');
  if (canvas) drawWheel(canvas.getContext('2d'), segs, wheel.currentAngle);

  document.getElementById('spin-btn')?.addEventListener('click', startSpin);

  // Confirm panel events
  document.querySelectorAll('[name="confirm-attendee"]').forEach(cb => {
    cb.addEventListener('change', e => {
      cb.closest('.member-card').classList.toggle('checked', e.target.checked);
    });
  });
  document.getElementById('confirm-btn')?.addEventListener('click', confirmResult);
  document.getElementById('spin-again-btn')?.addEventListener('click', () => {
    pendingSpin = null;
    startSpin();
  });
}

function startSpin() {
  const canvas = document.getElementById('wheel-canvas');
  if (!canvas || wheel.spinning || wheel.segments.length === 0) return;
  pendingSpin = null;
  document.getElementById('spin-btn').disabled = true;
  doSpin(wheel.segments, canvas, winner => {
    pendingSpin = { memberId: winner.memberId, title: winner.book };
    renderSpin();
  });
}

function confirmResult() {
  const date = document.getElementById('confirm-date').value;
  if (!date) { toast('Please pick a date.', 'error'); return; }
  if (getMeeting(date)) { toast('A meeting already exists on this date.', 'error'); return; }

  const attendees = Array.from(
    document.querySelectorAll('[name="confirm-attendee"]:checked')
  ).map(cb => cb.value);

  state.meetings.push({ id: uid(), date, attendees, chosenBook: { ...pendingSpin } });
  pendingSpin = null;
  save();
  toast('Saved to history!', 'success');
  renderSpin();
}

// ── Books Tab ─────────────────────────────────────────────
function renderBooks() {
  const cards = state.members.length === 0
    ? '<p class="empty">No members yet.</p>'
    : `<div class="books-grid">
        ${state.members.map(m => {
          const hasBook = !!m.currentBook;
          return `
            <div class="book-card" data-member-id="${m.id}">
              <div class="bc-member">${escHtml(m.name)}</div>
              <div class="bc-title ${hasBook ? '' : 'empty-book'}" data-field="title">
                ${hasBook ? escHtml(m.currentBook) : '(no suggestion yet)'}
              </div>
              ${m.bookUpdatedAt
                ? `<div class="bc-meta">Last updated: ${formatDate(m.bookUpdatedAt)}</div>`
                : '<div class="bc-meta">Not yet set</div>'
              }
              <button class="btn btn-sm" data-action="edit-book" data-member-id="${m.id}">Edit</button>
            </div>`;
        }).join('')}
      </div>`;

  document.getElementById('tab-books').innerHTML = `
    <h2>Book Suggestions</h2>
    <p class="hint">
      Suggestions carry over each session - members only need to update when they change their pick.
    </p>
    ${cards}
  `;

  document.querySelectorAll('[data-action="edit-book"]').forEach(btn => {
    btn.addEventListener('click', () => editBook(btn.dataset.memberId));
  });
}

function editBook(memberId) {
  const member  = getMember(memberId);
  const titleEl = document.querySelector(`.book-card[data-member-id="${memberId}"] [data-field="title"]`);
  if (!member || !titleEl || titleEl.querySelector('input')) return;

  const prev = member.currentBook || '';
  titleEl.innerHTML = '';

  const input = document.createElement('input');
  input.type  = 'text';
  input.value = prev;
  input.placeholder = 'Book title…';
  input.className   = 'bc-input';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val !== prev) {
      member.currentBook    = val;
      member.bookUpdatedAt  = currentDate();
      save();
      if (val) toast(`Updated: "${val}"`, 'success');
    }
    renderBooks();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { renderBooks(); }
  });
}

// ── History Tab ───────────────────────────────────────────
let editingMeetingId = null;

function renderHistory() {
  const sorted = [...state.meetings].sort((a, b) => b.date.localeCompare(a.date));

  document.getElementById('tab-history').innerHTML = `
    <h2>History</h2>
    <div class="add-meeting-bar">
      <input type="date" id="new-meeting-date" value="${currentDate()}" class="text-input">
      <button class="btn btn-primary" id="add-meeting-btn">Add Meeting</button>
    </div>
    <div class="history-list" id="history-list">
      ${sorted.length === 0
        ? '<p class="empty">No meetings yet.</p>'
        : sorted.map(renderMeetingCard).join('')}
    </div>
  `;

  document.getElementById('add-meeting-btn').addEventListener('click', addMeeting);
  attachHistoryEvents();
}

function renderMeetingCard(m) {
  if (m.id === editingMeetingId) return renderEditCard(m);

  const attendeeNames = m.attendees.map(id => getMember(id)?.name ?? '(removed)').join(', ') || 'Nobody';
  const chosen = m.chosenBook
    ? `<strong>${escHtml(getMember(m.chosenBook.memberId)?.name ?? '?')}</strong> - "${escHtml(m.chosenBook.title)}"`
    : '<em>Not yet spun</em>';

  return `
    <div class="hc" data-id="${m.id}">
      <div class="hc-top">
        <div class="hc-date">${formatDate(m.date)}</div>
        <div class="hc-btns">
          <button class="btn btn-sm" data-action="edit" data-id="${m.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-id="${m.id}">Delete</button>
        </div>
      </div>
      <div class="hc-chosen">📖 ${chosen}</div>
      <div class="hc-attendees">Attended (${m.attendees.length}): ${escHtml(attendeeNames)}</div>
    </div>`;
}

function renderEditCard(m) {
  const attendeeSet    = new Set(m.attendees);
  const chosenMemberId = m.chosenBook?.memberId ?? '';
  const chosenTitle    = m.chosenBook?.title    ?? '';

  const checkboxes = state.members.length === 0
    ? '<p class="empty">No members added yet.</p>'
    : state.members.map(mem => `
        <label class="member-card ${attendeeSet.has(mem.id) ? 'checked' : ''}">
          <input type="checkbox" name="edit-attendee" value="${mem.id}" ${attendeeSet.has(mem.id) ? 'checked' : ''}>
          <span class="mc-name">${escHtml(mem.name)}</span>
          <span class="mc-book">${escHtml(mem.currentBook || '')}</span>
        </label>`).join('');

  const memberOptions = `<option value="">- none -</option>` +
    state.members.map(mem =>
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
        <label>Book chosen</label>
        <select id="edit-winner" class="text-input">${memberOptions}</select>
        <input type="text" id="edit-book-title" class="text-input" value="${escHtml(chosenTitle)}" placeholder="Book title…" style="flex:1">
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
    if (action === 'edit')   { editingMeetingId = id; renderHistory(); }
    if (action === 'cancel') { editingMeetingId = null; renderHistory(); }
    if (action === 'save')   saveMeetingEdit(id);
    if (action === 'delete') deleteMeeting(id);
  });

  list.addEventListener('change', e => {
    if (e.target.name === 'edit-attendee')
      e.target.closest('.member-card')?.classList.toggle('checked', e.target.checked);

    if (e.target.id === 'edit-winner') {
      const member = getMember(e.target.value);
      const titleInput = document.getElementById('edit-book-title');
      if (titleInput && member?.currentBook) titleInput.value = member.currentBook;
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

  const newDate   = document.getElementById('edit-date').value;
  const attendees = Array.from(document.querySelectorAll('[name="edit-attendee"]:checked')).map(cb => cb.value);
  const winnerId  = document.getElementById('edit-winner').value;
  const bookTitle = document.getElementById('edit-book-title').value.trim();

  if (newDate && newDate !== meeting.date && getMeeting(newDate)) {
    toast('Another meeting already exists on that date.', 'error'); return;
  }

  if (newDate) meeting.date = newDate;
  meeting.attendees  = attendees;
  meeting.chosenBook = winnerId && bookTitle ? { memberId: winnerId, title: bookTitle } : null;

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

// ── Members Tab ───────────────────────────────────────────
function renderMembers() {
  const rows = state.members.length === 0
    ? '<p class="empty">No members yet.</p>'
    : state.members.map(m => {
        const meetingsAttended = state.meetings.filter(mt => mt.attendees.includes(m.id)).length;
        return `
          <div class="member-row">
            <span class="mr-name">${escHtml(m.name)}</span>
            <span class="mr-meta">${meetingsAttended} meeting${meetingsAttended !== 1 ? 's' : ''} attended</span>
            <button class="btn btn-sm btn-danger" data-action="remove" data-member-id="${m.id}">Remove</button>
          </div>`;
      }).join('');

  document.getElementById('tab-members').innerHTML = `
    <h2>Members</h2>
    <div class="add-row">
      <input type="text" id="new-member-name" class="text-input" placeholder="Member name…" autocomplete="off">
      <button class="btn btn-primary" id="add-member-btn">Add Member</button>
    </div>
    <div class="members-list">${rows}</div>
    <hr>
    <h3>Data Management</h3>
    <p class="hint">Export regularly to back up your data. Importing replaces all current data.</p>
    <div class="data-row">
      <button class="btn" id="export-btn">Export JSON</button>
      <button class="btn" id="import-btn">Import JSON</button>
    </div>
    <input type="file" id="import-file" accept=".json" style="display:none">
  `;

  document.getElementById('add-member-btn').addEventListener('click', addMember);
  document.getElementById('new-member-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMember();
  });

  document.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => removeMember(btn.dataset.memberId));
  });

  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-btn').addEventListener('click', () =>
    document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e =>
    importData(e.target));
}

function addMember() {
  const input = document.getElementById('new-member-name');
  const name  = input.value.trim();
  if (!name) return;
  if (state.members.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    toast('Member already exists.', 'error'); return;
  }
  state.members.push({ id: uid(), name, currentBook: '', bookUpdatedAt: null });
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
  save();
  toast('Member removed.', 'success');
  renderMembers();
}

// ── Data Import / Export ──────────────────────────────────
function exportData() {
  const blob = new Blob(
    [JSON.stringify({ members: state.members, meetings: state.meetings }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), {
    href: url, download: `bookclub-${currentDate()}.json`
  });
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
      state.members  = d.members;
      state.meetings = d.meetings;
      save();
      toast('Data imported!', 'success');
      renderTab('members');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// ── Init ─────────────────────────────────────────────────
function init() {
  load();

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  renderHistory();
}

document.addEventListener('DOMContentLoaded', init);
