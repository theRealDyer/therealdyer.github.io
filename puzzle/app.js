const STORAGE_KEY = "therealdyer-akari-sequence-v1";

const MERGE_MOVE_MS = 5000;
const MERGE_HOLD_MS = 1000;
const MERGE_FADE_MS = 3000;

const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1]
];

if (!Array.isArray(PUZZLES) || PUZZLES.length !== 5 || !PUZZLES.every(p => Array.isArray(p.cells) && p.cells.length > 0)) {
  document.body.innerHTML = `
    <main style="padding: 2rem; color: white; font-family: Arial, Helvetica, sans-serif; background: #201713; min-height: 100vh;">
      <h1>Akari setup incomplete</h1>
      <p>Add your five puzzles to <code>puzzles.js</code> first.</p>
      <p>Each puzzle needs a non-empty <code>cells</code> array.</p>
    </main>
  `;
  throw new Error("PUZZLES is missing or incomplete.");
}

const app = {
  progress: loadProgress(),
  showMergeScene: false,
  assemblingFinal: false,
  transitioningToFinal: false
};

const els = {
  title: document.getElementById("puzzle-title"),
  progress: document.getElementById("progress"),
  boardShell: document.getElementById("board-shell"),
  board: document.getElementById("board"),
  boardOverlay: document.getElementById("board-overlay"),
  nextButton: document.getElementById("next-button"),
  undoMove: document.getElementById("undo-move"),
  resetBoard: document.getElementById("reset-board"),
  clearProgress: document.getElementById("clear-progress"),
  mergeScene: document.getElementById("merge-scene"),
  mergeGrid: document.getElementById("merge-grid"),
  startFinal: document.getElementById("start-final"),
  bulbSound: document.getElementById("bulb-sound"),
  markSound: document.getElementById("mark-sound"),
  mergeSound: document.getElementById("merge-sound"),
  finalRevealSound: document.getElementById("final-reveal-sound"),
  puzzleCompleteSound: document.getElementById("puzzle-complete-sound")
};

els.undoMove.addEventListener("click", undoLastMove);
els.resetBoard.addEventListener("click", resetCurrentPuzzle);
els.clearProgress.addEventListener("click", clearAllProgress);
els.nextButton.addEventListener("click", goToNextStage);
els.startFinal.addEventListener("click", startFinalStage);
els.board.addEventListener("click", onBoardLeftClick);
els.board.addEventListener("contextmenu", onBoardRightClick);

renderApp();

function playSound(audioEl) {
  if (!audioEl) return;
  try {
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
  } catch (error) {
  }
}

function makeEmptyStageState() {
  return {
    bulbs: [],
    marks: [],
    history: [],
    solved: false
  };
}

function freshProgress() {
  return {
    currentStage: 0,
    mergeSeen: false,
    finalRevealPlayed: false,
    stages: PUZZLES.map(() => makeEmptyStageState())
  };
}

function maxUnlockedIndexFrom(progress) {
  let max = 0;

  if (progress.stages[0]?.solved) max = 1;
  if (progress.stages[1]?.solved) max = 2;
  if (progress.stages[2]?.solved) max = 3;
  if (progress.stages[3]?.solved && progress.mergeSeen) max = 4;
  if (progress.stages[4]?.solved) max = 4;

  return max;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshProgress();

    const parsed = JSON.parse(raw);
    const progress = freshProgress();

    progress.mergeSeen = Boolean(parsed.mergeSeen);
    progress.finalRevealPlayed = Boolean(parsed.finalRevealPlayed);

    if (Array.isArray(parsed.stages)) {
      progress.stages = PUZZLES.map((_, index) => {
        const stage = parsed.stages[index] || {};
        return {
          bulbs: Array.isArray(stage.bulbs) ? stage.bulbs.filter(v => typeof v === "string") : [],
          marks: Array.isArray(stage.marks) ? stage.marks.filter(v => typeof v === "string") : [],
          history: Array.isArray(stage.history)
            ? stage.history
                .filter(entry => entry && Array.isArray(entry.bulbs) && Array.isArray(entry.marks))
                .map(entry => ({
                  bulbs: entry.bulbs.filter(v => typeof v === "string"),
                  marks: entry.marks.filter(v => typeof v === "string")
                }))
            : [],
          solved: Boolean(stage.solved)
        };
      });
    }

    const maxUnlocked = maxUnlockedIndexFrom(progress);

    if (typeof parsed.currentStage === "number") {
      progress.currentStage = clamp(parsed.currentStage, 0, maxUnlocked);
    }

    return progress;
  } catch (error) {
    return freshProgress();
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(app.progress));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function currentStageIndex() {
  return app.progress.currentStage;
}

function currentPuzzle() {
  return PUZZLES[currentStageIndex()];
}

function currentStageState() {
  return app.progress.stages[currentStageIndex()];
}

function coordKey(row, col) {
  return `${row},${col}`;
}

function parseKey(key) {
  const [row, col] = key.split(",").map(Number);
  return { row, col };
}

function inBounds(puzzle, row, col) {
  return row >= 0 && row < puzzle.cells.length && col >= 0 && col < puzzle.cells[0].length;
}

function getCellValue(puzzle, row, col) {
  return puzzle.cells[row][col];
}

function isBlackCell(value) {
  return value === "#" || /^[0-4]$/.test(String(value));
}

function isNumberedBlackCell(value) {
  return /^[0-4]$/.test(String(value));
}

function maxUnlockedIndex() {
  return maxUnlockedIndexFrom(app.progress);
}

function isStageUnlocked(index) {
  return index <= maxUnlockedIndex();
}

function pushHistory(stageState) {
  stageState.history.push({
    bulbs: [...stageState.bulbs],
    marks: [...stageState.marks]
  });

  if (stageState.history.length > 200) {
    stageState.history.shift();
  }
}

function evaluatePuzzle(puzzle, stageState) {
  const bulbs = new Set(stageState.bulbs);
  const marks = new Set(stageState.marks);
  const lit = new Set();
  const conflicts = new Set();
  const clueStates = new Map();

  const whiteCells = [];
  const numberedCells = [];

  for (let row = 0; row < puzzle.cells.length; row++) {
    for (let col = 0; col < puzzle.cells[0].length; col++) {
      const value = getCellValue(puzzle, row, col);
      const key = coordKey(row, col);

      if (!isBlackCell(value)) {
        whiteCells.push(key);
      }

      if (isNumberedBlackCell(value)) {
        numberedCells.push({ row, col, value: Number(value), key });
      }
    }
  }

  for (const bulbKey of bulbs) {
    const { row, col } = parseKey(bulbKey);
    lit.add(bulbKey);

    for (const [dr, dc] of DIRECTIONS) {
      let nextRow = row + dr;
      let nextCol = col + dc;

      while (inBounds(puzzle, nextRow, nextCol) && !isBlackCell(getCellValue(puzzle, nextRow, nextCol))) {
        const nextKey = coordKey(nextRow, nextCol);
        lit.add(nextKey);

        if (bulbs.has(nextKey)) {
          conflicts.add(bulbKey);
          conflicts.add(nextKey);
        }

        nextRow += dr;
        nextCol += dc;
      }
    }
  }

  let clueErrorCount = 0;

  for (const clue of numberedCells) {
    let count = 0;

    for (const [dr, dc] of DIRECTIONS) {
      const nextRow = clue.row + dr;
      const nextCol = clue.col + dc;

      if (!inBounds(puzzle, nextRow, nextCol)) continue;
      if (bulbs.has(coordKey(nextRow, nextCol))) count += 1;
    }

    if (count === clue.value) {
      clueStates.set(clue.key, "good");
    } else if (count > clue.value) {
      clueStates.set(clue.key, "bad");
      clueErrorCount += 1;
    } else {
      clueStates.set(clue.key, "pending");
      clueErrorCount += 1;
    }
  }

  const unlitCells = whiteCells.filter(key => !lit.has(key));
  const solved = unlitCells.length === 0 && conflicts.size === 0 && clueErrorCount === 0;

  return {
    bulbs,
    marks,
    lit,
    conflicts,
    clueStates,
    solved
  };
}

function renderApp() {
  renderMeta();
  renderProgress();
  renderBoard();
  renderPanels();
  updateUndoButton();
}

function renderMeta() {
  const stageNumber = currentStageIndex() + 1;
  els.title.textContent = `Puzzle ${stageNumber}`;
  document.title = `Puzzle ${stageNumber} | theRealDyer`;
}

function renderProgress() {
  els.progress.innerHTML = "";

  PUZZLES.forEach((_, index) => {
    const step = document.createElement("button");
    step.type = "button";
    step.className = "progress-step";

    if (index === currentStageIndex()) step.classList.add("current");
    if (app.progress.stages[index].solved) step.classList.add("solved");

    step.textContent = index + 1;
    step.disabled = !isStageUnlocked(index);

    if (!step.disabled) {
      step.addEventListener("click", () => {
        app.progress.currentStage = index;
        app.showMergeScene = false;
        app.assemblingFinal = false;
        app.transitioningToFinal = false;
        saveProgress();
        renderApp();
      });
    }

    els.progress.appendChild(step);
  });
}

function renderBoard() {
  const puzzle = currentPuzzle();
  const stageState = currentStageState();
  const evaluation = evaluatePuzzle(puzzle, stageState);

  els.board.innerHTML = "";
  els.board.style.setProperty("--cols", puzzle.cells[0].length);

  for (let row = 0; row < puzzle.cells.length; row++) {
    for (let col = 0; col < puzzle.cells[0].length; col++) {
      const value = getCellValue(puzzle, row, col);
      const key = coordKey(row, col);
      const button = document.createElement("button");

      button.type = "button";
      button.className = "cell";
      button.dataset.row = row;
      button.dataset.col = col;

      if (isBlackCell(value)) {
        button.classList.add("black");
        button.disabled = true;

        if (isNumberedBlackCell(value)) {
          button.textContent = value;

          const clueState = evaluation.clueStates.get(key);
          if (clueState === "good") button.classList.add("good");
          if (clueState === "bad") button.classList.add("bad");
        }
      } else {
        button.classList.add("white");

        if (evaluation.lit.has(key)) {
          button.classList.add("lit");
        }

        if (evaluation.bulbs.has(key)) {
          button.classList.add("bulb");
          button.textContent = "●";
        } else if (evaluation.marks.has(key)) {
          button.classList.add("mark");
          button.textContent = "×";
        }

        if (evaluation.conflicts.has(key)) {
          button.classList.add("conflict");
        }

        if (stageState.solved) {
          button.disabled = true;
        }
      }

      els.board.appendChild(button);
    }
  }

  if (evaluation.solved && !stageState.solved) {
    stageState.solved = true;
    saveProgress();
    handleSolvedStage();
  } else {
    updateNextButton();
  }
}

function renderPanels() {
  const stageIndex = currentStageIndex();
  const stageState = currentStageState();

  els.boardShell.classList.toggle("final-stage", stageIndex === 4 || app.transitioningToFinal);

  const mergeAvailable = app.progress.stages[3].solved && !app.progress.mergeSeen;
  const showMerge =
    (app.showMergeScene && mergeAvailable) ||
    app.assemblingFinal ||
    app.transitioningToFinal;

  const showBoard =
    !showMerge ||
    app.transitioningToFinal ||
    stageIndex === 4;

  els.boardShell.classList.toggle("hidden", !showBoard);
  els.mergeScene.classList.toggle("hidden", !showMerge);

  if (app.showMergeScene && !app.assemblingFinal && !app.transitioningToFinal && mergeAvailable) {
    buildMergeScene();
  }

  if (stageIndex === 4 && stageState.solved) {
    showBoardOverlay();
  } else {
    hideBoardOverlay();
  }
}

function updateUndoButton() {
  const stageState = currentStageState();
  els.undoMove.disabled =
    stageState.solved ||
    stageState.history.length === 0 ||
    app.assemblingFinal ||
    app.transitioningToFinal;
}

function updateNextButton() {
  const stageState = currentStageState();

  if (!stageState.solved) {
    els.nextButton.classList.add("hidden");
    return;
  }

  if (currentStageIndex() < 3) {
    els.nextButton.textContent = `Continue to puzzle ${currentStageIndex() + 2}`;
    els.nextButton.classList.remove("hidden");
    return;
  }

  if (currentStageIndex() === 3) {
    els.nextButton.textContent = "Continue to final puzzle";
    els.nextButton.classList.remove("hidden");
    return;
  }

  els.nextButton.classList.add("hidden");
}

function handleSolvedStage() {
    if (currentStageIndex() < 4) {
      playSound(els.puzzleCompleteSound);
    }
  
    renderProgress();
    updateNextButton();
  
    if (currentStageIndex() === 4) {
      showBoardOverlay();
    }
  }

function onBoardLeftClick(event) {
  const cell = event.target.closest(".cell.white");
  if (!cell) return;

  const stageState = currentStageState();
  if (stageState.solved) return;
  if (app.assemblingFinal || app.transitioningToFinal) return;

  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const key = coordKey(row, col);

  const bulbs = new Set(stageState.bulbs);
  const marks = new Set(stageState.marks);

  pushHistory(stageState);

  if (bulbs.has(key)) {
    bulbs.delete(key);
  } else {
    bulbs.add(key);
    marks.delete(key);
  }

  stageState.bulbs = [...bulbs];
  stageState.marks = [...marks];
  saveProgress();
  renderBoard();
  updateUndoButton();
  playSound(els.bulbSound);
}

function onBoardRightClick(event) {
  const cell = event.target.closest(".cell.white");
  event.preventDefault();

  if (!cell) return;

  const stageState = currentStageState();
  if (stageState.solved) return;
  if (app.assemblingFinal || app.transitioningToFinal) return;

  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const key = coordKey(row, col);

  const bulbs = new Set(stageState.bulbs);
  const marks = new Set(stageState.marks);

  pushHistory(stageState);

  if (marks.has(key)) {
    marks.delete(key);
  } else {
    marks.add(key);
    bulbs.delete(key);
  }

  stageState.bulbs = [...bulbs];
  stageState.marks = [...marks];
  saveProgress();
  renderBoard();
  updateUndoButton();
  playSound(els.markSound);
}

function undoLastMove() {
  const stageState = currentStageState();
  if (stageState.solved) return;
  if (stageState.history.length === 0) return;
  if (app.assemblingFinal || app.transitioningToFinal) return;

  const previous = stageState.history.pop();
  stageState.bulbs = [...previous.bulbs];
  stageState.marks = [...previous.marks];

  saveProgress();
  renderBoard();
  updateUndoButton();
}

function resetCurrentPuzzle() {
  const stageState = currentStageState();
  stageState.bulbs = [];
  stageState.marks = [];
  stageState.history = [];
  stageState.solved = false;

  if (currentStageIndex() === 3) {
    app.showMergeScene = false;
    app.assemblingFinal = false;
    app.transitioningToFinal = false;
    app.progress.mergeSeen = false;
  }

  if (currentStageIndex() === 4) {
    app.progress.finalRevealPlayed = false;
    hideBoardOverlay();
  }

  saveProgress();
  renderApp();
}

function clearAllProgress() {
  const confirmed = window.confirm("Clear all Akari progress and start again?");
  if (!confirmed) return;

  app.progress = freshProgress();
  app.showMergeScene = false;
  app.assemblingFinal = false;
  app.transitioningToFinal = false;
  saveProgress();
  hideBoardOverlay();
  renderApp();
}

function goToNextStage() {
  const stageState = currentStageState();
  if (!stageState.solved) return;

  if (currentStageIndex() < 3) {
    app.progress.currentStage += 1;
    app.showMergeScene = false;
    app.assemblingFinal = false;
    app.transitioningToFinal = false;
    saveProgress();
    renderApp();
    return;
  }

  if (currentStageIndex() === 3) {
    app.showMergeScene = true;
    renderApp();
  }
}

function buildMergeScene() {
    els.mergeScene.classList.remove("fading-to-final");
    els.mergeScene.classList.remove("assembling");
    els.mergeGrid.classList.remove("assembling");
    els.mergeGrid.innerHTML = "";
  
    for (let i = 0; i < 4; i++) {
      const wrap = document.createElement("div");
      wrap.className = "merge-mini";
  
      wrap.appendChild(
        createMiniBoard(PUZZLES[i], app.progress.stages[i], "mini-board", "mini-cell")
      );
  
      els.mergeGrid.appendChild(wrap);
    }
  
    els.startFinal.disabled = false;
    els.startFinal.textContent = "Start final puzzle";
  }

function startFinalStage() {
    if (app.assemblingFinal || app.transitioningToFinal) return;
  
    app.assemblingFinal = true;
    els.startFinal.disabled = true;
    els.startFinal.textContent = "Combining...";
    els.mergeScene.classList.add("assembling");
    els.mergeGrid.classList.add("assembling");
    playSound(els.mergeSound);
  
    window.setTimeout(() => {
      app.progress.mergeSeen = true;
      app.progress.currentStage = 4;
      app.assemblingFinal = false;
      app.transitioningToFinal = true;
      saveProgress();
      renderApp();
  
      requestAnimationFrame(() => {
        els.mergeScene.classList.add("fading-to-final");
      });
  
      window.setTimeout(() => {
        app.showMergeScene = false;
        app.transitioningToFinal = false;
        saveProgress();
        renderApp();
      }, MERGE_FADE_MS);
    }, MERGE_MOVE_MS + MERGE_HOLD_MS);
  }

function showBoardOverlay() {
  els.boardOverlay.classList.remove("hidden");

  requestAnimationFrame(() => {
    els.boardOverlay.classList.add("show");
  });

  if (!app.progress.finalRevealPlayed) {
    playSound(els.finalRevealSound);
    app.progress.finalRevealPlayed = true;
    saveProgress();
  }
}

function hideBoardOverlay() {
  els.boardOverlay.classList.remove("show");
  els.boardOverlay.classList.add("hidden");
}

function createMiniBoard(puzzle, stageState, boardClass, cellClass) {
    const evaluation = evaluatePuzzle(puzzle, stageState);
    const board = document.createElement("div");
    board.className = boardClass;
    board.style.setProperty("--cols", puzzle.cells[0].length);
  
    for (let row = 0; row < puzzle.cells.length; row++) {
      for (let col = 0; col < puzzle.cells[0].length; col++) {
        const value = getCellValue(puzzle, row, col);
        const key = coordKey(row, col);
        const cell = document.createElement("div");
        cell.className = cellClass;
  
        if (isBlackCell(value)) {
          cell.classList.add("black");
  
          if (isNumberedBlackCell(value)) {
            cell.classList.add("clue");
            cell.textContent = value;
          }
        } else {
          cell.classList.add("white");
  
          if (evaluation.lit.has(key)) {
            cell.classList.add("lit");
          }
  
          if (evaluation.bulbs.has(key)) {
            cell.classList.add("bulb");
            cell.textContent = "●";
          } else if (evaluation.marks.has(key)) {
            cell.classList.add("mark");
            cell.textContent = "×";
          }
        }
  
        board.appendChild(cell);
      }
    }
  
    return board;
  }