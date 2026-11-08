const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const SIZE = 20, N = canvas.width / SIZE;

// Tuning
const DIFFICULTY = {
  easy:   { label: "Easy",   base: 140, min: 85 }, // ms per move at level 1 / fastest allowed
  medium: { label: "Medium", base: 110, min: 60 },
  hard:   { label: "Hard",   base: 85,  min: 45 },
};
const SPEED_STEP = 8;        // ms faster per level
const MAX_SCORES = 5;        // size of the high-score table
// Game rules (levels, gold food, collisions, win) live in Rust: rust/src/lib.rs

// Page elements
const diffSel = document.getElementById("difficulty");
const wallsSel = document.getElementById("walls");
const pauseBtn = document.getElementById("pause");
const muteBtn = document.getElementById("mute");
const scoresEl = document.getElementById("scores");

let loop, running;
let paused = false;
let wasm = null; // the Rust game engine, loaded at the bottom of this file

// Results of wasm.game_tick (same numbers as in rust/src/lib.rs)
const MOVED = 0, ATE_FOOD = 1, ATE_GOLD = 2, DIED = 3, WON = 4;

// ---------- Settings (difficulty + walls) ----------
let difficulty = "medium", wrap = false;
try {
  const d = localStorage.getItem("snake-difficulty");
  if (DIFFICULTY[d]) difficulty = d;
  wrap = localStorage.getItem("snake-wrap") === "1";
} catch (e) {}
diffSel.value = difficulty;
wallsSel.value = wrap ? "wrap" : "solid";

function applyWallLook() {
  // dashed border = you can pass through the walls
  canvas.style.borderStyle = wrap ? "dashed" : "solid";
}
applyWallLook();

diffSel.addEventListener("change", () => {
  difficulty = DIFFICULTY[diffSel.value] ? diffSel.value : "medium";
  try { localStorage.setItem("snake-difficulty", difficulty); } catch (e) {}
  diffSel.blur(); // so Space / arrows don't act on the dropdown later
});

wallsSel.addEventListener("change", () => {
  wrap = wallsSel.value === "wrap";
  try { localStorage.setItem("snake-wrap", wrap ? "1" : "0"); } catch (e) {}
  applyWallLook();
  wallsSel.blur();
});

function lockSettings(locked) {
  diffSel.disabled = locked;
  wallsSel.disabled = locked;
}

// ---------- High scores (top 5, kept in this browser) ----------
let scores = [];
try {
  const raw = JSON.parse(localStorage.getItem("snake-scores") || "[]");
  if (Array.isArray(raw)) {
    scores = raw.filter(e => e && typeof e.s === "number").slice(0, MAX_SCORES);
  }
} catch (e) {}

let best = scores.length ? scores[0].s : 0;
try { best = Math.max(best, +localStorage.getItem("snake-best") || 0); } catch (e) {}
document.getElementById("best").textContent = best;

function renderScores(highlight) {
  scoresEl.textContent = "";
  if (!scores.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No scores yet. Go play!";
    scoresEl.appendChild(li);
    return;
  }
  scores.forEach((e, i) => {
    const li = document.createElement("li");
    const diffName = DIFFICULTY[e.d] ? DIFFICULTY[e.d].label : "Medium";
    li.textContent = e.s + " pts · Lv " + e.l + " · " + diffName + " · " + (e.w ? "Wrap" : "Solid");
    if (i === highlight) li.className = "new";
    scoresEl.appendChild(li);
  });
}

// Returns the rank (0 = best) if the score made the table, otherwise -1
function addScore(score, level) {
  if (score <= 0) return -1;
  const entry = { s: score, l: level, d: difficulty, w: wrap };
  scores.push(entry);
  scores.sort((a, b) => b.s - a.s);
  const rank = scores.indexOf(entry);
  scores = scores.slice(0, MAX_SCORES);
  try { localStorage.setItem("snake-scores", JSON.stringify(scores)); } catch (e) {}
  const made = rank >= 0 && rank < MAX_SCORES ? rank : -1;
  renderScores(made);
  return made;
}
renderScores(-1);

// ---------- Sound (retro square-wave beeps) ----------
let audioCtx = null;
let muted = false;
try { muted = localStorage.getItem("snake-muted") === "1"; } catch (e) {}

function updateMuteBtn() {
  muteBtn.textContent = muted ? "🔇 Sound: off" : "🔊 Sound: on";
}
updateMuteBtn();

function initAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function beep(freq, startAfter, dur, vol = 0.08) {
  if (muted || !audioCtx) return;
  const t = audioCtx.currentTime + startAfter;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

const sfx = {
  eat:   () => beep(520, 0, 0.07),
  gold:  () => { beep(660, 0, 0.08); beep(880, 0.08, 0.08); beep(1320, 0.16, 0.12); },
  level: () => { beep(440, 0, 0.08); beep(554, 0.08, 0.08); beep(659, 0.16, 0.08); beep(880, 0.24, 0.14); },
  over:  () => { beep(330, 0, 0.15); beep(262, 0.15, 0.15); beep(196, 0.3, 0.3); },
};

function toggleMute() {
  muted = !muted;
  try { localStorage.setItem("snake-muted", muted ? "1" : "0"); } catch (e) {}
  updateMuteBtn();
  initAudio();
  sfx.eat();
}

muteBtn.addEventListener("click", () => {
  toggleMute();
  muteBtn.blur(); // so Space doesn't "press" the button later
});

// ---------- Game ----------
// The rules live in Rust (rust/src/lib.rs, built to snake_core.wasm).
// This file keeps the timer, drawing, sound, input and the high-score table.
function delay() {
  const d = DIFFICULTY[difficulty];
  return Math.max(d.min, d.base - (wasm.game_level() - 1) * SPEED_STEP);
}

function setSpeed() {
  clearInterval(loop);
  loop = setInterval(tick, delay());
}

function updateHud() {
  document.getElementById("score").textContent = wasm.game_score();
  document.getElementById("level").textContent = wasm.game_level();
}

function start() {
  if (!wasm) return; // engine is still loading
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  wasm.game_init(N, wrap ? 1 : 0, (Math.random() * 4294967296) >>> 0);
  paused = false;
  pauseBtn.textContent = "⏸ Pause";
  pauseBtn.disabled = false;
  lockSettings(true);
  updateHud();
  initAudio();
  running = true;
  setSpeed();
  draw();
}

function tick() {
  const levelBefore = wasm.game_level();
  const result = wasm.game_tick(Date.now());
  if (result === DIED) return gameOver(false);
  if (result !== MOVED) { // ate food or gold (or filled the board)
    const leveledUp = wasm.game_level() > levelBefore;
    if (leveledUp) setSpeed();
    updateHud();
    if (result === WON) return gameOver(true);
    if (leveledUp) sfx.level();
    else if (result === ATE_GOLD) sfx.gold();
    else sfx.eat();
  }
  draw();
}

function gameOver(won = false) {
  running = false;
  paused = false;
  clearInterval(loop);
  pauseBtn.disabled = true;
  pauseBtn.textContent = "⏸ Pause";
  lockSettings(false);
  if (won) sfx.level(); else sfx.over();
  const score = wasm.game_score(), level = wasm.game_level();
  if (score > best) {
    best = score;
    document.getElementById("best").textContent = best;
    try { localStorage.setItem("snake-best", best); } catch (e) {}
  }
  const rank = addScore(score, level);
  draw();
  const lines = [
    "Score: " + score + "  |  Level: " + level,
    "Press Space or tap to play again",
  ];
  if (rank === 0) lines.unshift("★ New best score! ★");
  else if (rank > 0) lines.unshift("You made the Top " + MAX_SCORES + "!");
  if (won) lines.unshift("You filled the whole board!");
  overlay(won ? "You Win!" : "Game Over", lines, 0.65);
}

// ---------- Pause ----------
function pause() {
  if (!running || paused) return;
  paused = true;
  clearInterval(loop);
  wasm.game_pause(Date.now()); // freezes the gold timer too
  pauseBtn.textContent = "▶ Resume";
  draw();
  overlay("Paused", ["Press P or tap to resume"], 0.6);
}

function resume() {
  if (!running || !paused) return;
  paused = false;
  wasm.game_resume(Date.now());
  pauseBtn.textContent = "⏸ Pause";
  setSpeed();
  draw();
}

function togglePause() {
  if (paused) resume();
  else pause();
}

pauseBtn.addEventListener("click", () => {
  togglePause();
  pauseBtn.blur();
});

// Pause automatically when the tab / app goes to the background
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

// ---------- Drawing ----------
function overlay(title, lines, alpha) {
  ctx.fillStyle = "rgba(0,0,0," + alpha + ")";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "bold 28px system-ui";
  ctx.fillText(title, canvas.width / 2, 175);
  ctx.font = "16px system-ui";
  lines.forEach((t, i) => ctx.fillText(t, canvas.width / 2, 208 + i * 26));
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // normal food (-1 when the board is full)
  const fx = wasm.game_food_x();
  if (fx >= 0) {
    ctx.fillStyle = "#ff5a5f";
    ctx.beginPath();
    ctx.arc(fx * SIZE + SIZE / 2, wasm.game_food_y() * SIZE + SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // gold food (blinks when it is about to disappear)
  const gx = wasm.game_gold_x();
  if (gx >= 0) {
    const gy = wasm.game_gold_y();
    const left = wasm.game_gold_ms_left(Date.now());
    const hidden = left < 1500 && !paused && Math.floor(Date.now() / 150) % 2 === 0;
    if (!hidden) {
      ctx.fillStyle = "#ffd700";
      ctx.fillRect(gx * SIZE + 2, gy * SIZE + 2, SIZE - 4, SIZE - 4);
      ctx.fillStyle = "#fff3a0";
      ctx.fillRect(gx * SIZE + 6, gy * SIZE + 6, SIZE - 12, SIZE - 12);
    }
  }

  // snake (segment 0 is the head)
  for (let i = 0, len = wasm.game_snake_len(); i < len; i++) {
    ctx.fillStyle = i === 0 ? "#7CFC9A" : "#3fbf6b";
    ctx.fillRect(wasm.game_snake_x(i) * SIZE + 1, wasm.game_snake_y(i) * SIZE + 1, SIZE - 2, SIZE - 2);
  }
}

// ---------- Controls ----------
const keys = {
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
  ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
};

function turn(dx, dy) {
  if (!running || paused) return;
  wasm.game_turn(dx, dy); // the engine buffers quick turns and blocks U-turns
}

document.addEventListener("keydown", e => {
  if (e.code === "Space") {
    e.preventDefault();
    if (paused) resume();
    else if (!running) start();
    return;
  }
  if (e.key === "p" || e.key === "P" || e.key === "Escape") { togglePause(); return; }
  if (e.key === "m" || e.key === "M") { toggleMute(); return; }
  const k = keys[e.key];
  if (!k || !running) return;
  e.preventDefault();
  turn(k[0], k[1]);
});

// Touch: swipe on the canvas to steer, tap it to start / resume / retry
let touchStart = null, swiped = false;
canvas.addEventListener("touchstart", e => {
  e.preventDefault();
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
  swiped = false;
}, { passive: false });

canvas.addEventListener("touchmove", e => {
  e.preventDefault();
  if (!touchStart) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 25) return;
  if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0);
  else turn(0, dy > 0 ? 1 : -1);
  touchStart = { x: t.clientX, y: t.clientY };
  swiped = true;
}, { passive: false });

canvas.addEventListener("touchend", e => {
  e.preventDefault();
  if (!swiped) { // a tap
    if (paused) resume();
    else if (!running) start();
  }
  touchStart = null;
}, { passive: false });

// On-screen arrow buttons (shown on touch devices)
document.querySelectorAll("#pad button").forEach(b => {
  b.addEventListener("pointerdown", e => {
    e.preventDefault();
    turn(+b.dataset.dx, +b.dataset.dy);
  });
});

// ---------- Start screen + loading the Rust engine ----------
running = false;
pauseBtn.disabled = true;

(async function boot() {
  try {
    const res = await fetch("snake_core.wasm");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    wasm = instance.exports;
    wasm.game_init(N, wrap ? 1 : 0, (Math.random() * 4294967296) >>> 0);
    draw();
    overlay("Snake", ["Press Space or tap to start"], 0.55);
  } catch (err) {
    console.error("Could not load snake_core.wasm:", err);
    overlay("Snake", [
      "Could not load the game engine.",
      "Open the game from a web server,",
      "not directly from a file.",
    ], 0.9);
  }
})();
