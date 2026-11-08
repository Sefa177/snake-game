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
const FOODS_PER_LEVEL = 5;   // foods needed to level up
const GOLD_CHANCE = 0.2;     // chance a gold square appears after eating
const GOLD_TIME = 5000;      // ms a gold square stays
const GOLD_POINTS = 5;
const MAX_SCORES = 5;        // size of the high-score table

// Page elements
const diffSel = document.getElementById("difficulty");
const wallsSel = document.getElementById("walls");
const pauseBtn = document.getElementById("pause");
const muteBtn = document.getElementById("mute");
const scoresEl = document.getElementById("scores");

let snake, dir, nextDir, food, gold, score, eaten, level, loop, running;
let paused = false, goldLeft = 0;

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
function addScore() {
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
function delay() {
  const d = DIFFICULTY[difficulty];
  return Math.max(d.min, d.base - (level - 1) * SPEED_STEP);
}

function setSpeed() {
  clearInterval(loop);
  loop = setInterval(tick, delay());
}

function updateHud() {
  document.getElementById("score").textContent = score;
  document.getElementById("level").textContent = level;
}

function isFree(x, y) {
  return !snake.some(s => s.x === x && s.y === y)
    && !(food && food.x === x && food.y === y)
    && !(gold && gold.x === x && gold.y === y);
}

function randomFree() {
  let p;
  do {
    p = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
  } while (!isFree(p.x, p.y));
  return p;
}

function start() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  dir = nextDir = { x: 1, y: 0 };
  score = 0;
  eaten = 0;
  level = 1;
  gold = null;
  food = null;
  food = randomFree();
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

function onEat(points, isGold) {
  score += points;
  eaten++;
  const leveledUp = eaten % FOODS_PER_LEVEL === 0;
  if (leveledUp) {
    level++;
    setSpeed();
  }
  updateHud();
  if (leveledUp) sfx.level();
  else if (isGold) sfx.gold();
  else sfx.eat();
}

function tick() {
  dir = nextDir;
  let hx = snake[0].x + dir.x, hy = snake[0].y + dir.y;
  if (wrap) { // walls are open: come out on the other side
    hx = (hx + N) % N;
    hy = (hy + N) % N;
  }
  const head = { x: hx, y: hy };
  const hitWall = !wrap && (hx < 0 || hy < 0 || hx >= N || hy >= N);
  const hitSelf = snake.some(s => s.x === head.x && s.y === head.y);
  if (hitWall || hitSelf) return gameOver();

  snake.unshift(head);

  if (gold && Date.now() > gold.expires) gold = null;

  if (head.x === food.x && head.y === food.y) {
    food = null;
    food = randomFree();
    if (!gold && Math.random() < GOLD_CHANCE) {
      gold = randomFree();
      gold.expires = Date.now() + GOLD_TIME;
    }
    onEat(1, false);
  } else if (gold && head.x === gold.x && head.y === gold.y) {
    gold = null;
    onEat(GOLD_POINTS, true);
  } else {
    snake.pop();
  }
  draw();
}

function gameOver() {
  running = false;
  paused = false;
  clearInterval(loop);
  pauseBtn.disabled = true;
  pauseBtn.textContent = "⏸ Pause";
  lockSettings(false);
  sfx.over();
  if (score > best) {
    best = score;
    document.getElementById("best").textContent = best;
    try { localStorage.setItem("snake-best", best); } catch (e) {}
  }
  const rank = addScore();
  draw();
  const lines = [
    "Score: " + score + "  |  Level: " + level,
    "Press Space or tap to play again",
  ];
  if (rank === 0) lines.unshift("★ New best score! ★");
  else if (rank > 0) lines.unshift("You made the Top " + MAX_SCORES + "!");
  overlay("Game Over", lines, 0.65);
}

// ---------- Pause ----------
function pause() {
  if (!running || paused) return;
  paused = true;
  clearInterval(loop);
  if (gold) goldLeft = gold.expires - Date.now(); // freeze the gold timer too
  pauseBtn.textContent = "▶ Resume";
  draw();
  overlay("Paused", ["Press P or tap to resume"], 0.6);
}

function resume() {
  if (!running || !paused) return;
  paused = false;
  if (gold) gold.expires = Date.now() + goldLeft;
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

  // normal food
  ctx.fillStyle = "#ff5a5f";
  ctx.beginPath();
  ctx.arc(food.x * SIZE + SIZE / 2, food.y * SIZE + SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fill();

  // gold food (blinks when it is about to disappear)
  if (gold) {
    const left = paused ? goldLeft : gold.expires - Date.now();
    const hidden = left < 1500 && !paused && Math.floor(Date.now() / 150) % 2 === 0;
    if (!hidden) {
      ctx.fillStyle = "#ffd700";
      ctx.fillRect(gold.x * SIZE + 2, gold.y * SIZE + 2, SIZE - 4, SIZE - 4);
      ctx.fillStyle = "#fff3a0";
      ctx.fillRect(gold.x * SIZE + 6, gold.y * SIZE + 6, SIZE - 12, SIZE - 12);
    }
  }

  // snake
  snake.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? "#7CFC9A" : "#3fbf6b";
    ctx.fillRect(s.x * SIZE + 1, s.y * SIZE + 1, SIZE - 2, SIZE - 2);
  });
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
  // prevent reversing into yourself
  if (dx === -dir.x && dy === -dir.y) return;
  nextDir = { x: dx, y: dy };
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

// ---------- Start screen ----------
snake = [{ x: 10, y: 10 }];
food = { x: 15, y: 10 };
gold = null;
score = 0; eaten = 0; level = 1;
running = false;
pauseBtn.disabled = true;
draw();
overlay("Snake", ["Press Space or tap to start"], 0.55);
