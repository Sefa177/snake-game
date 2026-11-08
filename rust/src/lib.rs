//! Snake game core, compiled to WebAssembly.
//!
//! JavaScript keeps the timer, drawing, sound, input and high scores.
//! This crate owns the game rules: moving, turning (with a small input
//! queue), eating, gold food, levels, collisions and the win condition.

use std::cell::RefCell;
use std::collections::VecDeque;

const FOODS_PER_LEVEL: i32 = 5; // foods needed to level up
const GOLD_CHANCE: f64 = 0.2; // chance a gold square appears after eating
const GOLD_TIME_MS: f64 = 5000.0; // how long a gold square stays
const GOLD_POINTS: i32 = 5;

// Results of `game_tick`. game.js uses the same numbers.
const MOVED: i32 = 0;
const ATE_FOOD: i32 = 1;
const ATE_GOLD: i32 = 2;
const DIED: i32 = 3;
const WON: i32 = 4;

type Cell = (i32, i32);

struct Gold {
    pos: Cell,
    expires: f64, // timestamp in ms (Date.now())
}

struct Game {
    n: i32, // the board is n x n cells
    wrap: bool,
    snake: VecDeque<Cell>, // front = head
    dir: Cell,
    queue: Vec<Cell>, // turns waiting for the next ticks (max 2)
    food: Option<Cell>,
    gold: Option<Gold>,
    gold_left: f64, // ms of gold time left while paused
    paused: bool,
    score: i32,
    eaten: i32,
    level: i32,
    rng: u32,
}

impl Game {
    fn new(n: i32, wrap: bool, seed: u32) -> Game {
        let mid = n / 2;
        let mut snake = VecDeque::new();
        snake.push_back((mid, mid));
        snake.push_back((mid - 1, mid));
        snake.push_back((mid - 2, mid));
        let mut game = Game {
            n,
            wrap,
            snake,
            dir: (1, 0),
            queue: Vec::new(),
            food: None,
            gold: None,
            gold_left: 0.0,
            paused: false,
            score: 0,
            eaten: 0,
            level: 1,
            rng: if seed == 0 { 0x9E37_79B9 } else { seed },
        };
        game.food = game.random_free();
        game
    }

    // xorshift32: small and good enough for a game
    fn next_rand(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    fn rand_unit(&mut self) -> f64 {
        self.next_rand() as f64 / 4_294_967_296.0
    }

    fn index(&self, c: Cell) -> usize {
        (c.1 * self.n + c.0) as usize
    }

    // A random empty cell, or None when the board is completely full
    fn random_free(&mut self) -> Option<Cell> {
        let n = self.n;
        let mut taken = vec![false; (n * n) as usize];
        for &c in &self.snake {
            taken[self.index(c)] = true;
        }
        if let Some(c) = self.food {
            taken[self.index(c)] = true;
        }
        if let Some(g) = &self.gold {
            taken[self.index(g.pos)] = true;
        }
        let free: Vec<usize> = (0..taken.len()).filter(|&i| !taken[i]).collect();
        if free.is_empty() {
            return None;
        }
        let pick = free[(self.next_rand() as usize) % free.len()] as i32;
        Some((pick % n, pick / n))
    }

    fn turn(&mut self, dx: i32, dy: i32) {
        // compare with the last turn that is already waiting (or the current direction)
        let last = self.queue.last().copied().unwrap_or(self.dir);
        if (dx, dy) == last {
            return; // same direction, nothing to do
        }
        if (dx, dy) == (-last.0, -last.1) {
            return; // no U-turns
        }
        if self.queue.len() >= 2 {
            return; // keep the buffer small
        }
        self.queue.push((dx, dy));
    }

    fn on_eat(&mut self, points: i32) {
        self.score += points;
        self.eaten += 1;
        if self.eaten % FOODS_PER_LEVEL == 0 {
            self.level += 1;
        }
    }

    fn tick(&mut self, now: f64) -> i32 {
        if !self.queue.is_empty() {
            self.dir = self.queue.remove(0);
        }
        let head = *self.snake.front().expect("snake is never empty");
        let mut hx = head.0 + self.dir.0;
        let mut hy = head.1 + self.dir.1;
        if self.wrap {
            // walls are open: come out on the other side
            hx = (hx + self.n) % self.n;
            hy = (hy + self.n) % self.n;
        }
        let new_head = (hx, hy);

        if self.gold.as_ref().map_or(false, |g| now > g.expires) {
            self.gold = None;
        }

        let eats_food = self.food == Some(new_head);
        let eats_gold = self.gold.as_ref().map_or(false, |g| g.pos == new_head);
        let will_eat = eats_food || eats_gold;

        let hit_wall = !self.wrap && (hx < 0 || hy < 0 || hx >= self.n || hy >= self.n);
        // The tail cell is free to enter: it moves away this tick, unless the snake grows
        let last = self.snake.len() - 1;
        let hit_self = self
            .snake
            .iter()
            .enumerate()
            .any(|(i, &c)| c == new_head && !(i == last && !will_eat));
        if hit_wall || hit_self {
            return DIED;
        }

        self.snake.push_front(new_head);

        if eats_food {
            self.food = None;
            self.food = self.random_free();
            if self.food.is_some() && self.gold.is_none() && self.rand_unit() < GOLD_CHANCE {
                if let Some(pos) = self.random_free() {
                    self.gold = Some(Gold {
                        pos,
                        expires: now + GOLD_TIME_MS,
                    });
                }
            }
            self.on_eat(1);
            if self.food.is_none() {
                WON // no empty cell left: the snake fills the board
            } else {
                ATE_FOOD
            }
        } else if eats_gold {
            self.gold = None;
            self.on_eat(GOLD_POINTS);
            ATE_GOLD
        } else {
            self.snake.pop_back();
            MOVED
        }
    }

    fn pause(&mut self, now: f64) {
        if self.paused {
            return;
        }
        self.paused = true;
        if let Some(g) = &self.gold {
            self.gold_left = g.expires - now; // freeze the gold timer
        }
    }

    fn resume(&mut self, now: f64) {
        if !self.paused {
            return;
        }
        self.paused = false;
        if let Some(g) = &mut self.gold {
            g.expires = now + self.gold_left;
        }
    }
}

// ---------- Exports for JavaScript ----------
// The game lives in one thread-local value; JS calls these plain functions.

thread_local! {
    static GAME: RefCell<Game> = RefCell::new(Game::new(20, false, 1));
}

fn with_game<R>(f: impl FnOnce(&mut Game) -> R) -> R {
    GAME.with(|cell| {
        let mut game = cell.borrow_mut();
        f(&mut *game)
    })
}

/// Starts a new game on an n x n board.
#[no_mangle]
pub extern "C" fn game_init(n: i32, wrap: i32, seed: u32) {
    with_game(|g| {
        *g = Game::new(n, wrap != 0, seed);
    });
}

/// Queues a turn (dx, dy). U-turns and repeats are ignored.
#[no_mangle]
pub extern "C" fn game_turn(dx: i32, dy: i32) {
    with_game(|g| g.turn(dx, dy));
}

/// Advances the game one step. Returns 0 moved, 1 ate food, 2 ate gold, 3 died, 4 won.
#[no_mangle]
pub extern "C" fn game_tick(now_ms: f64) -> i32 {
    with_game(|g| g.tick(now_ms))
}

#[no_mangle]
pub extern "C" fn game_pause(now_ms: f64) {
    with_game(|g| g.pause(now_ms));
}

#[no_mangle]
pub extern "C" fn game_resume(now_ms: f64) {
    with_game(|g| g.resume(now_ms));
}

#[no_mangle]
pub extern "C" fn game_score() -> i32 {
    with_game(|g| g.score)
}

#[no_mangle]
pub extern "C" fn game_level() -> i32 {
    with_game(|g| g.level)
}

#[no_mangle]
pub extern "C" fn game_snake_len() -> i32 {
    with_game(|g| g.snake.len() as i32)
}

/// x of snake segment i (0 = head), or -1 if there is no such segment.
#[no_mangle]
pub extern "C" fn game_snake_x(i: i32) -> i32 {
    with_game(|g| g.snake.get(i as usize).map_or(-1, |c| c.0))
}

#[no_mangle]
pub extern "C" fn game_snake_y(i: i32) -> i32 {
    with_game(|g| g.snake.get(i as usize).map_or(-1, |c| c.1))
}

/// Food position, or -1 when there is none (board full).
#[no_mangle]
pub extern "C" fn game_food_x() -> i32 {
    with_game(|g| g.food.map_or(-1, |c| c.0))
}

#[no_mangle]
pub extern "C" fn game_food_y() -> i32 {
    with_game(|g| g.food.map_or(-1, |c| c.1))
}

/// Gold position, or -1 when there is none.
#[no_mangle]
pub extern "C" fn game_gold_x() -> i32 {
    with_game(|g| g.gold.as_ref().map_or(-1, |gold| gold.pos.0))
}

#[no_mangle]
pub extern "C" fn game_gold_y() -> i32 {
    with_game(|g| g.gold.as_ref().map_or(-1, |gold| gold.pos.1))
}

/// Milliseconds the gold square has left (frozen while paused), or -1 when there is none.
#[no_mangle]
pub extern "C" fn game_gold_ms_left(now_ms: f64) -> f64 {
    with_game(|g| match &g.gold {
        Some(gold) => {
            if g.paused {
                g.gold_left
            } else {
                gold.expires - now_ms
            }
        }
        None => -1.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game_with(snake: &[Cell], dir: Cell, food: Option<Cell>) -> Game {
        let mut g = Game::new(20, false, 7);
        g.snake = snake.iter().copied().collect();
        g.dir = dir;
        g.queue.clear();
        g.food = food;
        g.gold = None;
        g
    }

    #[test]
    fn quick_turns_are_buffered() {
        let mut g = Game::new(20, false, 7);
        g.turn(0, -1);
        g.turn(-1, 0);
        assert_eq!(g.queue.len(), 2);
        assert_eq!(g.tick(0.0), MOVED);
        assert_eq!(g.snake[0], (10, 9));
        assert_eq!(g.tick(0.0), MOVED);
        assert_eq!(g.snake[0], (9, 9));
    }

    #[test]
    fn u_turns_repeats_and_overflow_are_ignored() {
        let mut g = Game::new(20, false, 7);
        g.turn(-1, 0); // reverse of the current direction
        assert!(g.queue.is_empty());
        g.turn(0, -1);
        g.turn(0, 1); // reverse of the queued turn
        g.turn(0, -1); // same as the queued turn
        assert_eq!(g.queue.len(), 1);
        g.turn(-1, 0);
        g.turn(0, 1); // third turn: buffer is full
        assert_eq!(g.queue.len(), 2);
    }

    #[test]
    fn moving_into_the_tail_cell_is_allowed() {
        let ring = [(6, 5), (6, 6), (5, 6), (5, 5)]; // tail at (5, 5)
        let mut g = game_with(&ring, (0, -1), Some((15, 15)));
        g.turn(-1, 0);
        assert_eq!(g.tick(0.0), MOVED);
        assert_eq!(g.snake.len(), 4);
        assert_eq!(g.snake[0], (5, 5));
    }

    #[test]
    fn hitting_the_body_still_kills() {
        let body = [(6, 5), (6, 6), (5, 6), (5, 5), (4, 5)]; // tail at (4, 5)
        let mut g = game_with(&body, (0, -1), Some((15, 15)));
        g.turn(-1, 0);
        assert_eq!(g.tick(0.0), DIED);
    }

    #[test]
    fn growing_into_the_tail_cell_kills() {
        let ring = [(6, 5), (6, 6), (5, 6), (5, 5)];
        let mut g = game_with(&ring, (0, -1), Some((5, 5))); // artificial: food on the tail
        g.turn(-1, 0);
        assert_eq!(g.tick(0.0), DIED);
    }

    #[test]
    fn walls_kill_unless_wrapping() {
        let mut g = game_with(&[(19, 5), (18, 5), (17, 5)], (1, 0), Some((15, 15)));
        assert_eq!(g.tick(0.0), DIED);

        let mut g = game_with(&[(19, 5), (18, 5), (17, 5)], (1, 0), Some((15, 15)));
        g.wrap = true;
        assert_eq!(g.tick(0.0), MOVED);
        assert_eq!(g.snake[0], (0, 5));
    }

    #[test]
    fn eating_scores_and_levels_up_every_five_foods() {
        let mut g = game_with(&[(10, 10), (9, 10), (8, 10)], (1, 0), Some((11, 10)));
        g.eaten = 4;
        assert_eq!(g.tick(0.0), ATE_FOOD);
        assert_eq!(g.score, 1);
        assert_eq!(g.level, 2);
        assert_eq!(g.snake.len(), 4);
    }

    #[test]
    fn gold_gives_points_and_expires() {
        let mut g = game_with(&[(10, 10), (9, 10), (8, 10)], (1, 0), Some((15, 15)));
        g.gold = Some(Gold { pos: (11, 10), expires: 5000.0 });
        assert_eq!(g.tick(1000.0), ATE_GOLD);
        assert_eq!(g.score, GOLD_POINTS);

        let mut g = game_with(&[(10, 10), (9, 10), (8, 10)], (1, 0), Some((15, 15)));
        g.gold = Some(Gold { pos: (11, 10), expires: 5000.0 });
        assert_eq!(g.tick(6000.0), MOVED); // expired before the snake got there
        assert!(g.gold.is_none());
    }

    #[test]
    fn pausing_freezes_the_gold_timer() {
        let mut g = game_with(&[(10, 10), (9, 10), (8, 10)], (1, 0), Some((15, 15)));
        g.gold = Some(Gold { pos: (1, 1), expires: 5000.0 });
        g.pause(1000.0);
        assert_eq!(g.gold_left, 4000.0);
        g.resume(9000.0);
        assert_eq!(g.gold.as_ref().unwrap().expires, 13000.0);
    }

    #[test]
    fn filling_the_board_wins_instead_of_hanging() {
        let mut cells: Vec<Cell> = vec![(18, 19)]; // head, next to the food
        for y in 0..20 {
            for x in 0..20 {
                if (x, y) != (18, 19) && (x, y) != (19, 19) {
                    cells.push((x, y));
                }
            }
        }
        let mut g = game_with(&cells, (1, 0), Some((19, 19)));
        assert_eq!(g.tick(0.0), WON);
        assert!(g.food.is_none());
        assert_eq!(g.snake.len(), 400);
        assert_eq!(g.score, 1);
    }

    #[test]
    fn random_free_never_returns_an_occupied_cell() {
        let mut g = Game::new(20, false, 12345);
        for _ in 0..200 {
            let c = g.random_free().unwrap();
            assert!(!g.snake.contains(&c));
            assert_ne!(Some(c), g.food);
        }
    }
}
