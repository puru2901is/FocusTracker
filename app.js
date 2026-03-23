/* ============================================================
   Focus Hour Tracker — Application Logic
   ============================================================ */

'use strict';

// ── API Config ───────────────────────────────────────────────
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
    : 'https://focus-tracker-backend-seven.vercel.app';

// ── Constants ───────────────────────────────────────────────
const DEFAULT_REMINDER = 40;  // minutes
const TOAST_DURATION = 8000; // ms
const TOKEN_KEY = 'ft_token';

// ── State ────────────────────────────────────────────────────
let timerInterval = null;
let reminderTimeout = null;
let activeSession = null;   // { taskName, startTime }
let audioCtx = null;
let settingsCache = {};     // In-memory settings cache
let currentUser = null;     // { id, email, name, picture }

// ── DOM refs ─────────────────────────────────────────────────
const taskInput = document.getElementById('task-input');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const clockEl = document.getElementById('clock');
const clockLabel = document.getElementById('clock-label');
const sessionBanner = document.getElementById('session-banner');
const bannerTask = document.getElementById('banner-task');
const toastContainer = document.getElementById('toast-container');

// Dashboard
const totalTimeEl = document.getElementById('total-time');
const totalSessionEl = document.getElementById('total-sessions');
const sessionList = document.getElementById('session-list');
const dateLabelEl = document.getElementById('date-label');

// Auth
const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const btnGoogleLogin = document.getElementById('btn-google-login');
const userChip = document.getElementById('user-chip');
const userAvatar = document.getElementById('user-avatar');
const userNameEl = document.getElementById('user-name');
const btnLogout = document.getElementById('btn-logout');

// ── Utility: Formatting ───────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDuration(ms) {
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return '<1m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatTime(dateOrMs) {
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTotalTime(ms) {
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateLabel(d) {
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── Auth helpers ──────────────────────────────────────────────
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function showLoginScreen() {
    loginScreen.hidden = false;
    appEl.hidden = true;
}

function showApp(user) {
    currentUser = user;
    loginScreen.hidden = true;
    appEl.hidden = false;

    // Populate user chip
    if (user.picture) {
        userAvatar.src = user.picture;
        userAvatar.hidden = false;
    } else {
        userAvatar.hidden = true;
    }
    userNameEl.textContent = user.name.split(' ')[0]; // first name only
    userChip.hidden = false;
}

function logout() {
    clearToken();
    currentUser = null;
    userChip.hidden = true;
    showLoginScreen();
}

// ── API Helpers ───────────────────────────────────────────────
async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
        const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (res.status === 401) {
            // Token invalid/expired — send back to login
            logout();
            return null;
        }
        if (!res.ok) {
            console.error(`API error ${res.status} on ${path}:`, await res.text());
            return null;
        }
        if (res.status === 204) return null;
        return await res.json();
    } catch (err) {
        console.error(`Network error on ${path}:`, err);
        return null;
    }
}

// ── Settings helpers ──────────────────────────────────────────
async function fetchSettings() {
    const data = await apiFetch('/settings');
    if (data) settingsCache = data;
    return settingsCache;
}

function saveSettings(patch) {
    settingsCache = { ...settingsCache, ...patch };
    const stringified = Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [k, String(v)])
    );
    apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: stringified }),
    });
    return settingsCache;
}

function getReminderMins() {
    return Math.max(1, parseInt(settingsCache.reminderMins ?? DEFAULT_REMINDER, 10));
}

function getTheme() {
    return settingsCache.theme ?? 'light';
}

// ── Sessions ───────────────────────────────────────────────────
async function todaySessions() {
    const data = await apiFetch(`/sessions?date=${todayKey()}`);
    return data ?? [];
}

async function postSession(session) {
    return apiFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify(session),
    });
}

// ── Audio: tone presets ───────────────────────────────────────
function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

const TONE_PRESETS = {
    chime: {
        label: 'Chime',
        icon: '🔔',
        desc: 'Gentle 3-note bell',
        play(ctx, now) {
            [[880, 0, 0.5], [1100, 0.55, 0.5], [660, 1.1, 0.8]].forEach(([freq, t, dur]) => {
                const osc = ctx.createOscillator(), g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'sine'; osc.frequency.setValueAtTime(freq, now + t);
                g.gain.setValueAtTime(0, now + t);
                g.gain.linearRampToValueAtTime(0.18, now + t + 0.05);
                g.gain.exponentialRampToValueAtTime(0.001, now + t + dur);
                osc.start(now + t); osc.stop(now + t + dur);
            });
        }
    },
    bell: {
        label: 'Bell',
        icon: '🪗',
        desc: 'Single deep resonant bell',
        play(ctx, now) {
            [[330, 1.0], [660, 0.4], [990, 0.15]].forEach(([freq, vol]) => {
                const osc = ctx.createOscillator(), g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'sine'; osc.frequency.setValueAtTime(freq, now);
                g.gain.setValueAtTime(vol * 0.9, now);
                g.gain.exponentialRampToValueAtTime(0.001, now + 3.0);
                osc.start(now); osc.stop(now + 3.0);
            });
        }
    },
    pulse: {
        label: 'Pulse',
        icon: '📳',
        desc: 'Quick triple beep',
        play(ctx, now) {
            [0, 0.22, 0.44].forEach(t => {
                const osc = ctx.createOscillator(), g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'square'; osc.frequency.setValueAtTime(880, now + t);
                g.gain.setValueAtTime(0, now + t);
                g.gain.linearRampToValueAtTime(0.12, now + t + 0.02);
                g.gain.setValueAtTime(0.12, now + t + 0.13);
                g.gain.linearRampToValueAtTime(0, now + t + 0.18);
                osc.start(now + t); osc.stop(now + t + 0.2);
            });
        }
    },
    soft: {
        label: 'Soft Rise',
        icon: '🎵',
        desc: 'Gentle ascending sweep',
        play(ctx, now) {
            const osc = ctx.createOscillator(), g = ctx.createGain();
            osc.connect(g); g.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(300, now);
            osc.frequency.exponentialRampToValueAtTime(900, now + 1.2);
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(0.16, now + 0.3);
            g.gain.setValueAtTime(0.16, now + 0.9);
            g.gain.linearRampToValueAtTime(0, now + 1.4);
            osc.start(now); osc.stop(now + 1.5);
        }
    },
    alert: {
        label: 'Alert',
        icon: '📢',
        desc: 'Two-tone attention ping',
        play(ctx, now) {
            [[1200, 0, 0.15], [800, 0.25, 0.25], [1200, 0.6, 0.15], [800, 0.85, 0.35]].forEach(([freq, t, dur]) => {
                const osc = ctx.createOscillator(), g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, now + t);
                g.gain.setValueAtTime(0, now + t);
                g.gain.linearRampToValueAtTime(0.15, now + t + 0.03);
                g.gain.exponentialRampToValueAtTime(0.001, now + t + dur);
                osc.start(now + t); osc.stop(now + t + dur);
            });
        }
    }
};

const DEFAULT_TONE = 'chime';

function getToneId() {
    return settingsCache.toneId ?? DEFAULT_TONE;
}

function playReminderTone() {
    try {
        const ctx = ensureAudioCtx();
        const id = getToneId();
        const preset = TONE_PRESETS[id] ?? TONE_PRESETS[DEFAULT_TONE];
        preset.play(ctx, ctx.currentTime);
    } catch (e) {
        console.warn('Audio playback failed:', e);
    }
}

function previewTone(id) {
    try {
        ensureAudioCtx();
        const ctx = ensureAudioCtx();
        const preset = TONE_PRESETS[id] ?? TONE_PRESETS[DEFAULT_TONE];
        preset.play(ctx, ctx.currentTime);
    } catch (e) {
        console.warn('Tone preview failed:', e);
    }
}


// ── Toast ─────────────────────────────────────────────────────
function showToast(title, message, icon = '⏰') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${message}</div>
    </div>
    <button class="toast-close" aria-label="Dismiss">✕</button>
  `;

    const dismiss = () => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };

    toast.querySelector('.toast-close').addEventListener('click', dismiss);
    toastContainer.appendChild(toast);

    const timer = setTimeout(dismiss, TOAST_DURATION);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
}

// ── Timer tick ────────────────────────────────────────────────
function tick() {
    if (!activeSession) return;
    const elapsed = Date.now() - activeSession.startTime;
    clockEl.textContent = formatMs(elapsed);
}

// ── Start session ─────────────────────────────────────────────
function startSession() {
    const taskName = taskInput.value.trim();
    if (!taskName) {
        taskInput.focus();
        taskInput.style.borderColor = 'rgba(252,129,129,0.6)';
        setTimeout(() => (taskInput.style.borderColor = ''), 1200);
        return;
    }

    ensureAudioCtx();

    activeSession = { taskName, startTime: Date.now() };

    taskInput.disabled = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    clockEl.classList.add('running');
    clockLabel.textContent = 'elapsed';
    sessionBanner.classList.add('visible');
    bannerTask.textContent = taskName;

    timerInterval = setInterval(tick, 1000);
    tick();

    const mins = getReminderMins();
    reminderTimeout = setTimeout(() => {
        playReminderTone();
        showToast(
            `${mins}-Minute Mark 🎯`,
            `You've been focused on "${taskName}" for ${mins} minutes. Keep going or wrap up!`,
            '⏰'
        );
    }, mins * 60 * 1000);
}

// ── Stop session ──────────────────────────────────────────────
async function stopSession() {
    if (!activeSession) return;

    clearInterval(timerInterval);
    clearTimeout(reminderTimeout);
    timerInterval = null;
    reminderTimeout = null;

    const endTime = Date.now();
    const duration = endTime - activeSession.startTime;

    await postSession({
        id: crypto.randomUUID(),
        date: todayKey(),
        task_name: activeSession.taskName,
        start_time: activeSession.startTime,
        end_time: endTime,
        duration,
    });

    activeSession = null;

    taskInput.disabled = false;
    taskInput.value = '';
    btnStart.disabled = false;
    btnStop.disabled = true;
    clockEl.textContent = '00:00:00';
    clockEl.classList.remove('running');
    clockLabel.textContent = 'ready';
    sessionBanner.classList.remove('visible');

    renderDashboard();
    showToast('Session Complete!', `Great work! Session saved. 🎉`, '✅');
}

// ── Dashboard ─────────────────────────────────────────────────
async function renderDashboard() {
    const sessions = await todaySessions();
    const totalMs = sessions.reduce((acc, s) => acc + s.duration, 0);

    totalTimeEl.textContent = sessions.length === 0 ? '0m' : formatTotalTime(totalMs);
    totalSessionEl.textContent = sessions.length;

    const badge = document.getElementById('session-count-badge');
    if (badge) badge.textContent = sessions.length > 0 ? `${sessions.length} session${sessions.length !== 1 ? 's' : ''}` : '';

    if (sessions.length === 0) {
        sessionList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌱</div>
        <div class="empty-text">No sessions yet today.<br>Start your first focus block!</div>
      </div>`;
        return;
    }

    sessionList.innerHTML = '';
    [...sessions].reverse().forEach(s => {
        const item = document.createElement('div');
        item.className = 'session-item';
        item.innerHTML = `
      <div>
        <div class="session-task">${escHtml(s.task_name)}</div>
        <div class="session-time-range">${formatTime(s.start_time)} → ${formatTime(s.end_time)}</div>
      </div>
      <div class="session-duration">${formatDuration(s.duration)}</div>
    `;
        sessionList.appendChild(item);
    });
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Theme ─────────────────────────────────────────────────────
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    document.querySelectorAll('.theme-pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.themeVal === theme);
    });
}

// ── Settings panel ────────────────────────────────────────────
function initSettings() {
    const reminderInput = document.getElementById('reminder-input');
    const btnSave = document.getElementById('btn-save-reminder');
    const savedMsg = document.getElementById('reminder-saved-msg');
    const previewText = document.getElementById('reminder-preview-text');
    const hintMins = document.getElementById('hint-reminder-mins');
    const toneGrid = document.getElementById('tone-grid');

    const current = getReminderMins();
    if (reminderInput) reminderInput.value = current;
    updatePreview(current);
    if (hintMins) hintMins.textContent = current;

    function updatePreview(mins) {
        if (previewText) previewText.textContent = `Reminder fires at ${mins} min into each session`;
        if (hintMins) hintMins.textContent = mins;
    }

    if (reminderInput) {
        reminderInput.addEventListener('input', () => {
            const v = parseInt(reminderInput.value, 10);
            if (v > 0) updatePreview(v);
        });
    }

    if (btnSave) {
        btnSave.addEventListener('click', () => {
            const v = parseInt(reminderInput?.value, 10);
            if (!v || v < 1) return;
            saveSettings({ reminderMins: v });
            updatePreview(v);
            if (savedMsg) {
                savedMsg.classList.add('visible');
                setTimeout(() => savedMsg.classList.remove('visible'), 2200);
            }
        });
    }

    if (toneGrid) {
        const savedTone = getToneId();
        Object.entries(TONE_PRESETS).forEach(([id, preset]) => {
            const card = document.createElement('div');
            card.className = 'tone-card' + (id === savedTone ? ' active' : '');
            card.dataset.toneId = id;
            card.innerHTML = `
                <div class="tone-card-icon">${preset.icon}</div>
                <div class="tone-card-label">${preset.label}</div>
                <div class="tone-card-desc">${preset.desc}</div>
                <button class="tone-preview-btn" data-tone-id="${id}" aria-label="Preview ${preset.label}">▶ Play</button>
            `;
            toneGrid.appendChild(card);
        });

        toneGrid.addEventListener('click', e => {
            const btn = e.target.closest('.tone-preview-btn');
            const card = e.target.closest('.tone-card');
            if (btn) {
                e.stopPropagation();
                previewTone(btn.dataset.toneId);
                return;
            }
            if (card) {
                const id = card.dataset.toneId;
                toneGrid.querySelectorAll('.tone-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                saveSettings({ toneId: id });
                previewTone(id);
            }
        });
    }

    document.querySelectorAll('.theme-pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.themeVal;
            saveSettings({ theme });
            applyTheme(theme);
        });
    });
}

// ── Tabs ───────────────────────────────────────────────────────
function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const views = document.querySelectorAll('.tab-view');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            views.forEach(v => v.hidden = true);

            tab.classList.add('active');
            const target = document.getElementById(tab.dataset.tab);
            if (target) target.hidden = false;

            if (tab.dataset.tab === 'view-dashboard') renderDashboard();
        });
    });
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
    // 1. Check for token in URL (coming back from OAuth callback)
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (tokenFromUrl) {
        setToken(tokenFromUrl);
        // Clean the URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    // 2. Try to load user from stored token
    const token = getToken();
    if (token) {
        const user = await apiFetch('/auth/me');
        if (user) {
            // Authenticated — boot the app
            showApp(user);
            await fetchSettings();
            applyTheme(getTheme());
            dateLabelEl.textContent = formatDateLabel(new Date());

            btnStart.addEventListener('click', startSession);
            btnStop.addEventListener('click', stopSession);
            btnStop.disabled = true;

            const themeToggleBtn = document.getElementById('theme-toggle');
            if (themeToggleBtn) {
                themeToggleBtn.addEventListener('click', () => {
                    const next = getTheme() === 'dark' ? 'light' : 'dark';
                    saveSettings({ theme: next });
                    applyTheme(next);
                });
            }

            taskInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !btnStart.disabled) startSession();
            });

            initSettings();
            initTabs();
            renderDashboard();
            return;
        }
    }

    // 3. Not authenticated — show login
    showLoginScreen();
    btnGoogleLogin.addEventListener('click', () => {
        window.location.href = `${API_BASE}/auth/google/login`;
    });
    btnLogout.addEventListener('click', logout);
}

// Bind logout (always, regardless of auth state)
btnLogout.addEventListener('click', logout);

document.addEventListener('DOMContentLoaded', init);
