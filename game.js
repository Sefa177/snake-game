const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const SIZE = 20, N = canvas.width / SIZE;
let snake, dir, nextDir, food, score, loop, running;
let best = 0;
try { best = +localStorage.getItem("snake-best") || 0; } catch (e) {}
document.getElementById("best").textContent = best;

function placeFood() {
  do {
    food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
  } while (snake.some(s => s.x === food.x && s.y === food.y));
}

function start() {
  snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  dir = nextDir = { x: 1, y: 0 };
  score = 0;
  document.getElementById("score").textContent = 0;
  placeFood();
  running = true;
  clearInterval(loop);
  loop = setInterval(tick, 110);
  draw();
}

function tick() {
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= N || head.y >= N;
  const hitSelf = snake.some(s => s.x === head.x && s.y === head.y);
  if (hitWall || hitSelf) return gameOver();
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score++;
    document.getElementById("score").textContent = score;
    placeFood();
  } else {
    snake.pop();
  }
  draw();
}

function gameOver() {
  running = false;
  clearInterval(loop);
  if (score > best) {
    best = score;
    document.getElementById("best").textContent = best;
    try { localStorage.setItem("snake-best", best); } catch (e) {}
  }
  draw();
  ctx.fillStyle = "rgba(0,0,0,.65)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "bold 28px system-ui";
  ctx.fillText("Game Over", canvas.width / 2, 190);
  ctx.font = "16px system-ui";
  ctx.fillText("Press Space or tap to play again", canvas.width / 2, 220);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ff5a5f";
  ctx.beginPath();
  ctx.arc(food.x * SIZE + SIZE / 2, food.y * SIZE + SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  snake.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? "#7CFC9A" : "#3fbf6b";
    ctx.fillRect(s.x * SIZE + 1, s.y * SIZE + 1, SIZE - 2, SIZE - 2);
  });
}

const keys = {
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
  ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
};

function turn(dx, dy) {
  if (!running) return;
  // prevent reversing into yourself
  if (dx === -dir.x && dy === -dir.y) return;
  nextDir = { x: dx, y: dy };
}

document.addEventListener("keydown", e => {
  if (e.code === "Space") { e.preventDefault(); if (!running) start(); return; }
  const k = keys[e.key];
  if (!k || !running) return;
  e.preventDefault();
  turn(k[0], k[1]);
});

// Touch: swipe on the canvas to steer, tap it to start / retry
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
  if (!swiped && !running) start(); // a tap
  touchStart = null;
}, { passive: false });

// On-screen arrow buttons (shown on touch devices)
document.querySelectorAll("#pad button").forEach(b => {
  b.addEventListener("pointerdown", e => {
    e.preventDefault();
    turn(+b.dataset.dx, +b.dataset.dy);
  });
});

// Start screen
snake = [{ x: 10, y: 10 }]; food = { x: 15, y: 10 }; running = false;
draw();
ctx.fillStyle = "rgba(0,0,0,.55)";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#fff";
ctx.textAlign = "center";
ctx.font = "bold 22px system-ui";
ctx.fillText("Press Space or tap to start", canvas.width / 2, 205);
