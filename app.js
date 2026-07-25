/* ==========================================================================
   CÔNG TẮC TÍNH NĂNG

   Đổi true/false ở đây là bật/tắt được cả một mảng chức năng.
   Toàn bộ code của chức năng vẫn nằm nguyên trong repo, không xoá gì.

   chat: false  -> ẩn khung "Thảo luận", ngừng gọi /api/chat.
                   Bật lại chỉ cần đổi thành true (cần REDIS_URL trên server).
   ========================================================================== */
const FEATURES = {
  chat: false,

  /* simulatedStats: true  -> ba con số cộng đồng được SINH RA THEO THỜI GIAN,
                              không gọi /api/stats, không cần Redis.
     simulatedStats: false -> lấy số thật từ server (cần REDIS_URL).
     Lưu ý: khi bật, đây là số mô phỏng chứ không phải người thật. */
  simulatedStats: true,
};

/* ==========================================================================
   BỘ SINH SỐ NGƯỜI HỌC MÔ PHỎNG

   Nguyên tắc để trông thật:

   1. Thuần theo đồng hồ — không dùng Math.random(). Mọi máy tính ra CÙNG một
      con số tại cùng một thời điểm. Hai đứa để điện thoại cạnh nhau vẫn khớp.
   2. Có nhịp sinh hoạt — 4 giờ sáng vắng, 9 giờ tối đông nhất.
   3. Càng sát ngày thi càng đông, theo hàm mũ chứ không tuyến tính.
   4. Sát ngày thi thì đêm cũng đông (ai cũng cày đêm), nên đường cong đêm
      được làm phẳng dần.
   5. Nhiễu mượt — số trôi dần chứ không nhảy giật cục.
   ========================================================================== */
const SIM = {
  examISO: '2026-08-01T07:30:00+07:00', // giờ thi

  /* Mức đông = baseline + hai làn sóng chồng lên nhau:
     - broad: làn sóng ôn thi kéo dài vài tuần, lên từ từ
     - spike: cơn nước rút dồn vào mấy ngày cuối
     Cộng hai cái lại thì đường cong giống thực tế hơn một hàm mũ đơn. */
  baseline: 4,
  broad: 35,
  broadDays: 8,
  spike: 110,
  spikeDays: 1.8,

  turnover: 9,             // 1 người "đang học" ứng với bao nhiêu lượt trong ngày
  sessionsPerPerson: 1.4,
  launchISO: '2026-06-15T00:00:00+07:00', // mốc bắt đầu cộng dồn lượt truy cập
};

// Mức độ đông theo từng giờ trong ngày (giờ Việt Nam), 0 = vắng tanh, 1 = đông nhất
const SIM_HOURLY = [
  0.22, 0.16, 0.12, 0.09, 0.08, 0.10, // 0h–5h  (vẫn có vài đứa cày đêm)
  0.18, 0.32, 0.46, 0.60, 0.66, 0.56, // 6h–11h
  0.40, 0.46, 0.60, 0.64, 0.56, 0.46, // 12h–17h
  0.42, 0.62, 0.86, 1.00, 0.96, 0.58, // 18h–23h
];

// Băm số nguyên thành [0,1) — thay cho Math.random() nhưng luôn cho cùng kết quả
function simHash01(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// Nhiễu mượt: nội suy giữa hai mốc băm liền nhau -> số trôi dần, không nhảy
function simNoise(timeMs, periodMs) {
  const x = timeMs / periodMs;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f); // smoothstep
  return simHash01(i) * (1 - s) + simHash01(i + 1) * s;
}

// Giờ trong ngày theo múi giờ Việt Nam, dạng thập phân (13.5 = 13h30)
function simVnHour(now) {
  const vn = new Date(now + 7 * 3600 * 1000);
  return vn.getUTCHours() + vn.getUTCMinutes() / 60 + vn.getUTCSeconds() / 3600;
}

function simVnDayIndex(now) {
  return Math.floor((now + 7 * 3600 * 1000) / 86400000);
}

// Mức độ đông tại một thời điểm bất kỳ trong ngày (nội suy giữa các giờ)
function simCircadian(hour) {
  const i = Math.floor(hour) % 24;
  const f = hour - Math.floor(hour);
  const a = SIM_HOURLY[i];
  const b = SIM_HOURLY[(i + 1) % 24];
  return a + (b - a) * f;
}

/* Mức cao nhất đã từng đạt tính từ 0h tới giờ h.
   Dùng làm sàn cho "Học hôm nay": vì là dãy không giảm nên con số trong ngày
   chỉ có thể đứng yên hoặc tăng, không bao giờ tụt. */
const SIM_HOURLY_RUNMAX = SIM_HOURLY.reduce((acc, v, i) => {
  acc.push(i === 0 ? v : Math.max(acc[i - 1], v));
  return acc;
}, []);

function simRunMaxAt(hour) {
  const i = Math.floor(hour) % 24;
  const f = hour - Math.floor(hour);
  const a = SIM_HOURLY_RUNMAX[i];
  const b = SIM_HOURLY_RUNMAX[Math.min(i + 1, 23)];
  return a + (b - a) * f;
}

// Tỉ lệ lượng người đã đi qua tính từ 0h đến giờ hiện tại (0 -> 1)
function simCircadianCumulative(hour) {
  let total = 0;
  for (let h = 0; h < 24; h += 1) total += SIM_HOURLY[h];
  let acc = 0;
  const full = Math.floor(hour);
  for (let h = 0; h < full; h += 1) acc += SIM_HOURLY[h];
  acc += SIM_HOURLY[full % 24] * (hour - full);
  return acc / total;
}

// Số ngày còn lại tới giờ thi (âm nếu đã thi xong)
function simDaysToExam(now) {
  return (new Date(SIM.examISO).getTime() - now) / 86400000;
}

/* Mức nền: càng gần ngày thi càng cao theo hàm mũ.
   Thi xong thì tụt nhanh về mức baseline. */
function simBaseLevel(daysLeft) {
  if (daysLeft < 0) {
    // Sau kỳ thi: tụt nhanh, hết hẳn sau khoảng 3 ngày
    const after = Math.min(-daysLeft, 3);
    const atExam = SIM.baseline + SIM.broad + SIM.spike;
    return SIM.baseline + (atExam - SIM.baseline) * 0.3 * Math.exp(-after * 1.6);
  }
  return SIM.baseline
    + SIM.broad * Math.exp(-daysLeft / SIM.broadDays)
    + SIM.spike * Math.exp(-daysLeft / SIM.spikeDays);
}

/* Hệ số "nước rút": sát ngày thi thì ban đêm cũng đông, đường cong sinh hoạt
   được kéo phẳng dần về 1. Tăng dần theo thời gian, không bao giờ giảm. */
function simPanic(now) {
  return Math.max(0, Math.min(1, 1 - simDaysToExam(now) / 2)) * 0.65;
}

/* Số người ĐANG HỌC tại thời điểm now */
function simActiveLearners(now) {
  const level = simBaseLevel(simDaysToExam(now));

  const panic = simPanic(now);
  const curveRaw = simCircadian(simVnHour(now));
  const curve = curveRaw + (1 - curveRaw) * panic;

  // Nhiễu mượt chu kỳ ~7 phút, biên độ ±15%
  const drift = 0.85 + 0.3 * simNoise(now, 7 * 60 * 1000);

  // Giật nhẹ ±1 mỗi ~25 giây cho có cảm giác sống
  const jitter = Math.round((simHash01(Math.floor(now / 25000)) - 0.5) * 3);

  const value = Math.round(level * curve * drift) + jitter;
  return Math.max(1, value); // ít nhất luôn có chính bạn
}

/* Tổng số người khác nhau đã học TRONG NGÀY HÔM NAY.
   Tăng đơn điệu suốt cả ngày, reset lúc 0h giờ VN. */
function simTodayLearners(now) {
  const hour = simVnHour(now);

  // Mọi đại lượng dưới đây cố định trong suốt một ngày -> kết quả chỉ phụ
  // thuộc vào `hour`, mà hai hàm theo `hour` đều không giảm.
  const startOfDay = now - hour * 3600 * 1000;
  const endOfDay = startOfDay + 24 * 3600 * 1000;
  const noonToday = startOfDay + 12 * 3600 * 1000;
  const dayLevel = simBaseLevel(simDaysToExam(noonToday));

  /* Mức cao nhất trong ngày. Trước kỳ thi thì mức tăng dần nên đỉnh nằm ở cuối
     ngày, nhưng sau kỳ thi mức lại giảm dần nên đỉnh nằm ở đầu ngày — phải xét
     cả hai đầu, và cả đúng thời điểm thi nếu nó rơi vào ngày này. */
  const examTime = new Date(SIM.examISO).getTime();
  let peakLevel = Math.max(
    simBaseLevel(simDaysToExam(startOfDay)),
    simBaseLevel(simDaysToExam(endOfDay))
  );
  if (examTime > startOfDay && examTime < endOfDay) {
    peakLevel = Math.max(peakLevel, simBaseLevel(0));
  }

  const dayVariation = 0.9 + 0.2 * simHash01(simVnDayIndex(now));
  const accumulated = Math.round(dayLevel * SIM.turnover * dayVariation * simCircadianCumulative(hour));

  /* Sàn: rạng sáng thì phần cộng dồn còn rất nhỏ, trong khi vẫn có người đang
     online. Lấy mức cao nhất đã đạt trong ngày (có tính cả hệ số nước rút)
     rồi nhân 1.3 để chừa chỗ cho nhiễu — đảm bảo "Học hôm nay" luôn lớn hơn
     "Đang học" ở mọi thời điểm. */
  const runMax = simRunMaxAt(hour);
  const floorCurve = runMax + (1 - runMax) * simPanic(now);
  // hệ số 1.3 phủ phần nhiễu (tối đa 1.15), cộng 2 phủ phần giật (tối đa +2)
  const floorValue = Math.ceil(peakLevel * floorCurve * 1.3) + 2;

  return Math.max(accumulated, floorValue, 1);
}

/* Tổng lượt truy cập cộng dồn từ ngày mở web. Chỉ tăng, không bao giờ giảm. */
let simVisitsCache = { dayIndex: -1, base: 0 };

function simTotalVisits(now) {
  const today = simVnDayIndex(now);
  const launchDay = simVnDayIndex(new Date(SIM.launchISO).getTime());

  // Trước ngày mở web thì chưa có gì để cộng dồn
  if (today < launchDay) return SIM.baseline;

  if (simVisitsCache.dayIndex !== today) {
    let sum = 0;
    for (let d = launchDay; d < today; d += 1) {
      /* Lấy đúng con số "Học hôm nay" tại thời điểm cuối ngày đó. Dùng chung
         một hàm nên lúc sang ngày mới, phần cộng thêm luôn >= phần vừa bị bỏ
         đi — tổng lượt vì thế không bao giờ tụt lúc nửa đêm. */
      const endOfThatDay = (d * 86400000) - 7 * 3600 * 1000 + 86400000 - 1000;
      sum += Math.round(simTodayLearners(endOfThatDay) * SIM.sessionsPerPerson);
    }
    simVisitsCache = { dayIndex: today, base: sum };
  }

  const todayPart = Math.round(simTodayLearners(now) * SIM.sessionsPerPerson);
  return simVisitsCache.base + todayPart;
}

const els = {
  totalQuestions: document.getElementById('totalQuestions'),
  correctCount: document.getElementById('correctCount'),
  wrongCount: document.getElementById('wrongCount'),
  starredCount: document.getElementById('starredCount'),
  starredFilterBtn: document.getElementById('starredFilterBtn'),
  reviewCount: document.getElementById('reviewCount'),
  parseInfo: document.getElementById('parseInfo'),
  fileInput: document.getElementById('fileInput'),
  reloadButton: document.getElementById('reloadButton'),
  refreshDropdown: document.getElementById('refreshDropdown'),
  refreshAllBtn: document.getElementById('refreshAllBtn'),
  refreshKeepStarredBtn: document.getElementById('refreshKeepStarredBtn'),
  refreshShuffleBtn: document.getElementById('refreshShuffleBtn'),
  autoNextButton: document.getElementById('autoNextButton'),
  rawInput: document.getElementById('rawInput'),
  loadTextButton: document.getElementById('loadTextButton'),
  heroCard: document.getElementById('heroCard'),
  questionCard: document.getElementById('questionCard'),
  starQuestionButton: document.getElementById('starQuestionButton'),
  emptyState: document.getElementById('emptyState'),
  questionBadge: document.getElementById('questionBadge'),
  sourceBadge: document.getElementById('sourceBadge'),
  progressText: document.getElementById('progressText'),
  progressDropdown: document.getElementById('progressDropdown'),
  promptText: document.getElementById('promptText'),
  optionList: document.getElementById('optionList'),
  submitRow: document.getElementById('submitRow'),
  submitButton: document.getElementById('submitButton'),
  clearSelectionButton: document.getElementById('clearSelectionButton'),
  prevButton: document.getElementById('prevButton'),
  nextButton: document.getElementById('nextButton'),
  feedback: document.getElementById('feedback'),
  activeCount: document.getElementById('activeCount'),
  chatMessages: document.getElementById('chatMessages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  chatToggleBtn: document.getElementById('chatToggleBtn'),
  chatBadge: document.getElementById('chatBadge'),
  imageModal: document.getElementById('imageModal'),
  modalImg: document.getElementById('modalImg'),
  emojiPicker: document.getElementById('emojiPicker'),
  emojiList: document.getElementById('emojiList'),
  emojiToggleBtn: document.getElementById('emojiToggleBtn'),
  imagePreview: document.getElementById('imagePreview'),
  previewImg: document.getElementById('previewImg'),
  removePreviewBtn: document.getElementById('removePreviewBtn'),
  resetQuestionButton: document.getElementById('resetQuestionButton'),
  noteToggleBtn: document.getElementById('noteToggleBtn'),
  nekoToggleBtn: document.getElementById('nekoToggleBtn'),
  noteCard: document.getElementById('noteCard'),
  closeNoteButton: document.getElementById('closeNoteButton'),
  noteSearchInput: document.getElementById('noteSearchInput'),
  noteContentContainer: document.getElementById('noteContentContainer'),
  searchQuestionButton: document.getElementById('searchQuestionButton'),
  questionSearchRow: document.getElementById('questionSearchRow'),
  questionSearchInput: document.getElementById('questionSearchInput'),
  searchResultsContainer: document.getElementById('searchResultsContainer'),
  questionInteractiveArea: document.getElementById('questionInteractiveArea'),
  todayLearners: document.getElementById('todayLearners'),
  totalVisits: document.getElementById('totalVisits'),
  nicknameValue: document.getElementById('nicknameValue'),
  nicknameBtn: document.getElementById('nicknameBtn'),
  // Thanh trên đầu (mobile)
  mtbActive: document.getElementById('mtbActive'),
  mtbToday: document.getElementById('mtbToday'),
  mtbVisits: document.getElementById('mtbVisits'),
  mtbWrong: document.getElementById('mtbWrong'),
};

// Cập nhật một ô số: chỉ đổi khi giá trị khác, kèm hiệu ứng nhấp nháy
function setCounter(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent === next) return;
  el.textContent = next;
  el.classList.remove('pulse');
  void el.offsetWidth; // ép trình duyệt vẽ lại để animation chạy lại
  el.classList.add('pulse');
}

const state = {
  questions: [],
  pendingNew: [],
  reviewQueue: [],
  pendingWrong: new Set(),
  reviewProgress: {},
  current: null,
  currentIndex: -1,
  currentSource: 'new',
  turn: 0,
  correct: 0,
  wrong: 0,
  reviewSolved: 0,
  waitingForMulti: false,
  selectedLetters: new Set(),
  isLocked: false,
  history: [],
  historyPos: -1,
  lastShownIndex: -1,
  answeredCurrent: false,
  lastAnswerSelected: [],
  lastAnswerCorrect: false,
  questionStates: {},
  autoNextEnabled: false,
  autoNextTimer: null,
  lastChatId: null,
  unreadCount: 0,
  emojis: [],
  pendingImage: null,
  isSearchActive: false,
  correctStreak: 0,
  filterStarred: false,
};

const SESSION_STORAGE_KEY = 'vnr202.study.session.v1';

// Điện thoại / máy tính bảng cảm ứng
const IS_TOUCH_DEVICE = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function htmlToText(fragment) {
  const normalized = normalizeNewlines(fragment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  const temp = document.createElement('textarea');
  temp.innerHTML = normalized;
  return temp.value;
}

function extractAnswerKey(answerChunk) {
  const plain = htmlToText(answerChunk)
    .replace(/\u00a0/g, ' ')
    .trim();

  // Find the first line which contains @@@ (if passed directly) or just look at the whole text
  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstLine = lines[0];

  // If the line is just a single letter, return it
  if (/^[a-h]$/i.test(firstLine)) {
    return [firstLine.toUpperCase()];
  }

  // Split the line by semicolons first (e.g. "A. Thời kỳ ...; B. Thời kì ...")
  const parts = firstLine.split(';');
  const matches = [];
  const startPrefixRegex = /^([a-h](?:\s*(?:,|\b(?:và|hoặc|and|or)\b|&)\s*[a-h])*)\s*[\.\):]/i;

  for (const part of parts) {
    const trimmedPart = part.trim();
    const prefixMatch = trimmedPart.match(startPrefixRegex);
    if (prefixMatch) {
      // Extract all A-H letters from the matched prefix group
      const letters = prefixMatch[1].match(/[a-h]/gi);
      if (letters) {
        for (const letter of letters) {
          matches.push(letter.toUpperCase());
        }
      }
    }
  }

  if (matches.length > 0) {
    // Return unique keys preserving order
    return [...new Set(matches)];
  }

  // Fallback 1: Check if the whole line is just a list of key letters without any extra description
  // (e.g., "A và B", "A, B", "A & B")
  if (/^[a-h](?:\s*(?:,|\b(?:và|hoặc|and|or)\b|&)\s*[a-h])*$/i.test(firstLine)) {
    const letters = firstLine.match(/[a-h]/gi);
    if (letters) {
      return [...new Set(letters.map(l => l.toUpperCase()))];
    }
  }

  // Fallback 2: search for any isolated sequence of A-H letters on the first line
  const fallback = firstLine.match(/\b[A-Ha-h]+\b/i);
  return fallback ? fallback[0].toUpperCase().split('') : [];
}

function parseQuestionBlock(block) {
  const text = /<[^>]+>/.test(block) ? htmlToText(block) : block;
  const normalizedText = text.replace(/(\S)\s+(?![Cc][\.)](?:\s*)M[aá]c\b)([A-Ha-h])(?:[\.)]|:)\s+/g, '$1\n$2. ');
  const lines = normalizeNewlines(normalizedText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const options = [];
  const questionLines = [];
  let activeOption = null;
  const optionPattern = /^([A-Ha-h])(?:[\.)]|:)\s*(.+)$/;

  function detectOptionLine(line) {
    if (/^[Cc][\.)]?\s*M[aá]c\b/i.test(line)) {
      return null;
    }
    const punctuatedMatch = line.match(optionPattern);
    if (punctuatedMatch) {
      return punctuatedMatch;
    }

    const looseMatch = line.match(/^([A-Ha-h])\s+(.+)$/);
    if (looseMatch) {
      const body = looseMatch[2].trim();
      if (/^[A-ZÀ-Ỵ"“'(\d]/u.test(body)) {
        return [looseMatch[0], looseMatch[1], body];
      }
    }

    return null;
  }

  for (const line of lines) {
    const optionMatch = detectOptionLine(line);
    if (optionMatch) {
      const label = optionMatch[1].toUpperCase();
      const body = optionMatch[2].trim();
      activeOption = { label, text: body };
      options.push(activeOption);
      continue;
    }

    if (options.length > 0 && activeOption) {
      activeOption.text = `${activeOption.text} ${line}`.trim();
    } else {
      questionLines.push(line);
    }
  }

  const prompt = questionLines.join(' ').replace(/\s+/g, ' ').trim();
  return { prompt, options };
}

function parseQuestions(rawText) {
  const source = normalizeNewlines(rawText);
  const entries = [];
  let cursor = 0;

  while (true) {
    const markerIndex = source.indexOf('@@@', cursor);
    if (markerIndex === -1) {
      break;
    }

    const answerEnd = source.indexOf('###', markerIndex + 3);
    const questionChunk = source.slice(cursor, markerIndex).trim();
    const fullAnswerChunk = answerEnd === -1 ? source.slice(markerIndex + 3).trim() : source.slice(markerIndex + 3, answerEnd).trim();
    cursor = answerEnd === -1 ? source.length : answerEnd + 3;

    if (!questionChunk) {
      continue;
    }

    const parsed = parseQuestionBlock(questionChunk);

    // Split the fullAnswerChunk into answer line and explanation lines
    const answerLines = fullAnswerChunk.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = answerLines[0] || '';
    const explanation = answerLines.slice(1).join('\n').trim();

    const answer = extractAnswerKey(firstLine);

    if (parsed.prompt && parsed.options.length > 0 && answer.length > 0) {
      const uniqueCorrect = [...new Set(answer)];
      entries.push({
        prompt: parsed.prompt,
        options: parsed.options,
        answer: uniqueCorrect,
        answerText: uniqueCorrect.join(''),
        source: questionChunk.includes('<') ? 'html' : 'text',
        explanation: explanation || null,
      });
    }
  }

  return entries;
}

function shuffle(array) {
  const clone = [...array];
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }
  return clone;
}

function pickReviewDelay() {
  return 3 + Math.floor(Math.random() * 2);
}

function getStarredIndices() {
  const starred = [];
  for (let i = 0; i < state.questions.length; i++) {
    const s = state.questionStates[String(i)];
    if (s && s.isStarred) {
      starred.push(i);
    }
  }
  return starred;
}

function updateStats() {
  if (els.totalQuestions) els.totalQuestions.textContent = String(state.questions.length);
  if (els.correctCount) els.correctCount.textContent = String(state.correct);
  if (els.wrongCount) els.wrongCount.textContent = String(state.wrong);
  setCounter(els.mtbWrong, state.wrong);
  if (els.starredCount) els.starredCount.textContent = String(getStarredIndices().length);
  if (els.reviewCount) els.reviewCount.textContent = String(state.reviewQueue.length);
  // hide parse info UI (kept minimal per user request)
  if (els.parseInfo) els.parseInfo.textContent = '';
}

function serializeSession() {
  return {
    version: 2,
    questionCount: state.questions.length,
    pendingNew: [...state.pendingNew],
    reviewQueue: state.reviewQueue.map((item) => ({ ...item })),
    pendingWrong: [...state.pendingWrong],
    reviewProgress: { ...state.reviewProgress },
    currentIndex: state.currentIndex,
    currentSource: state.currentSource,
    turn: state.turn,
    correct: state.correct,
    wrong: state.wrong,
    reviewSolved: state.reviewSolved,
    history: [...state.history],
    historyPos: state.historyPos,
    answeredCurrent: state.answeredCurrent,
    selectedLetters: [...state.selectedLetters],
    lastAnswerSelected: state.lastAnswerSelected || [],
    lastAnswerCorrect: Boolean(state.lastAnswerCorrect),
    questionStates: state.questionStates,
    autoNextEnabled: Boolean(state.autoNextEnabled),
  };
}

function saveSession() {
  if (state.questions.length === 0) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(serializeSession()));
}

function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function restoreSession() {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return false;
  }

  try {
    const saved = JSON.parse(raw);
    if (!saved || (saved.version !== 1 && saved.version !== 2) || saved.questionCount !== state.questions.length) {
      return false;
    }

    state.pendingNew = Array.isArray(saved.pendingNew) ? saved.pendingNew.filter((value) => Number.isInteger(value)) : [];
    state.reviewQueue = Array.isArray(saved.reviewQueue)
      ? saved.reviewQueue
        .filter((item) => item && Number.isInteger(item.questionIndex) && Number.isInteger(item.dueTurn))
        .map((item) => ({ questionIndex: item.questionIndex, dueTurn: item.dueTurn }))
      : [];
    state.pendingWrong = new Set(Array.isArray(saved.pendingWrong) ? saved.pendingWrong.filter((value) => Number.isInteger(value)) : []);
    state.reviewProgress = saved.reviewProgress && typeof saved.reviewProgress === 'object' ? saved.reviewProgress : {};
    state.currentIndex = Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1;
    state.currentSource = saved.currentSource === 'review' ? 'review' : 'new';
    state.turn = Number.isInteger(saved.turn) ? saved.turn : 0;
    state.correct = Number.isInteger(saved.correct) ? saved.correct : 0;
    state.wrong = Number.isInteger(saved.wrong) ? saved.wrong : 0;
    state.reviewSolved = Number.isInteger(saved.reviewSolved) ? saved.reviewSolved : 0;
    state.history = Array.isArray(saved.history) ? saved.history.filter((value) => Number.isInteger(value)) : [];
    state.historyPos = Number.isInteger(saved.historyPos) ? saved.historyPos : -1;
    state.answeredCurrent = Boolean(saved.answeredCurrent);
    state.selectedLetters = new Set(Array.isArray(saved.selectedLetters) ? saved.selectedLetters.filter((value) => typeof value === 'string') : []);
    state.lastAnswerSelected = Array.isArray(saved.lastAnswerSelected) ? saved.lastAnswerSelected.filter((value) => typeof value === 'string') : [];
    state.lastAnswerCorrect = Boolean(saved.lastAnswerCorrect);
    state.questionStates = saved.questionStates && typeof saved.questionStates === 'object' ? saved.questionStates : {};
    state.autoNextEnabled = Boolean(saved.autoNextEnabled);

    if (!Number.isInteger(state.currentIndex) || state.currentIndex < 0 || state.currentIndex >= state.questions.length) {
      return false;
    }

    state.current = state.questions[state.currentIndex];
    return true;
  } catch (error) {
    return false;
  }
}

function setVisibility(hasQuestion) {
  els.heroCard.classList.toggle('hidden', hasQuestion);
  els.questionCard.classList.toggle('hidden', !hasQuestion);
  els.emptyState.classList.toggle('hidden', hasQuestion || state.questions.length > 0);
}

function clearAutoNextTimer() {
  if (state.autoNextTimer) {
    clearTimeout(state.autoNextTimer);
    state.autoNextTimer = null;
  }
}

function updateAutoNextButton() {
  if (!els.autoNextButton) return;
  els.autoNextButton.classList.toggle('active', state.autoNextEnabled);
}

function applyAnsweredState(current, selected, isCorrect) {
  const normalizedSelected = normalizeAnswerSet(selected);
  const optionEls = Array.from(els.optionList.querySelectorAll('.option-button, .option-check'));

  optionEls.forEach((el) => {
    const letter = el.dataset ? el.dataset.letter : (el.querySelector('.option-key') && el.querySelector('.option-key').textContent.trim());
    if (!letter) return;
    const upper = String(letter).trim().toUpperCase();
    if (current.answer.includes(upper)) {
      el.classList.add('correct');
    }
    if (normalizedSelected.includes(upper) && !current.answer.includes(upper)) {
      el.classList.add('wrong');
    }
    el.disabled = true;
    el.querySelectorAll('input').forEach((input) => (input.disabled = true));
  });

  const chosenText = escapeHtml(normalizedSelected.join(', ') || 'không chọn');
  if (isCorrect) {
    showFeedback(true, `<strong>Đúng.</strong> Bạn có thể bấm Tiếp theo để sang câu khác.`, 'good', current.explanation);
  } else {
    showFeedback(false, `${revealCorrectAnswer(current)}`, 'bad', current.explanation);
  }

  if (els.nextButton) els.nextButton.disabled = false;
  state.isLocked = true;
  state.answeredCurrent = true;
}

function saveQuestionState(questionIndex, selected, isCorrect) {
  const existing = state.questionStates[String(questionIndex)] || {};
  state.questionStates[String(questionIndex)] = {
    ...existing,
    selectedLetters: [...normalizeAnswerSet(selected)],
    isCorrect: Boolean(isCorrect),
    answered: true,
  };
}

function applyStoredQuestionState(questionIndex) {
  const stored = state.questionStates[String(questionIndex)];
  if (!stored || !stored.answered) {
    return false;
  }

  applyAnsweredState(state.questions[questionIndex], stored.selectedLetters || [], stored.isCorrect);
  state.lastAnswerSelected = [...(stored.selectedLetters || [])];
  state.lastAnswerCorrect = Boolean(stored.isCorrect);
  return true;
}

function formatQuestionIndex() {
  if (state.filterStarred) {
    const starred = getStarredIndices();
    const idx = starred.indexOf(state.currentIndex);
    return `${idx >= 0 ? idx + 1 : '?'} / ${starred.length}`;
  }
  return `${Math.min(state.currentIndex + 1, state.questions.length)} / ${state.questions.length}`;
}

function renderQuestion(pushHistory = true) {
  if (!state.current) {
    setVisibility(false);
    return;
  }

  setVisibility(true);
  clearAutoNextTimer();
  state.isLocked = false;
  state.selectedLetters.clear();
  if (window.neko && window.neko.onQuestionStart) {
    window.neko.onQuestionStart();
  }
  state.answeredCurrent = false;
  state.lastAnswerSelected = [];
  state.lastAnswerCorrect = false;

  const current = state.current;
  const questionNumber = state.currentIndex + 1;

  els.questionBadge.textContent = `Câu ${questionNumber}`;
  els.sourceBadge.textContent = state.currentSource === 'review' ? 'Ôn lại' : 'Câu mới';
  // add/remove 'review' class so CSS can highlight the Ôn lại pill
  els.sourceBadge.classList.toggle('review', state.currentSource === 'review');
  els.progressText.textContent = formatQuestionIndex();
  
  if (els.starQuestionButton) {
    const s = state.questionStates[String(state.currentIndex)];
    const isStarred = s && s.isStarred;
    if (isStarred) {
      els.starQuestionButton.classList.add('active');
      els.starQuestionButton.style.color = '#ffd700'; // gold
    } else {
      els.starQuestionButton.classList.remove('active');
      els.starQuestionButton.style.color = '';
    }
  }

  els.promptText.innerHTML = renderPrompt(current.prompt, current.answerText);
  els.optionList.innerHTML = '';
  els.feedback.className = 'feedback hidden';
  els.feedback.textContent = '';

  const isMulti = current.answer.length > 1;
  els.submitRow.classList.toggle('hidden', !isMulti);
  state.waitingForMulti = isMulti;

  current.options.forEach((option, index) => {
    if (isMulti) {
      const label = document.createElement('label');
      label.className = 'option-check';
      label.dataset.letter = option.label;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.label;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selectedLetters.add(option.label);
        } else {
          state.selectedLetters.delete(option.label);
        }
      });

      const key = document.createElement('span');
      key.className = 'option-key';
      key.textContent = option.label;

      const body = document.createElement('span');
      body.className = 'option-body';
      body.textContent = option.text;

      label.append(checkbox, key, body);
      els.optionList.appendChild(label);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option-button';
    button.dataset.letter = option.label;

    const key = document.createElement('span');
    key.className = 'option-key';
    key.textContent = option.label;

    const body = document.createElement('span');
    body.className = 'option-body';
    body.textContent = option.text;

    button.append(key, body);
    button.addEventListener('click', () => handleAnswer([option.label]));
    els.optionList.appendChild(button);
  });

  if (isMulti) {
    els.submitButton.onclick = () => handleAnswer([...state.selectedLetters]);
    els.clearSelectionButton.onclick = clearSelections;
  }

  // push to history when showing a new question
  if (pushHistory) {
    // avoid duplicate consecutive entries
    if (state.historyPos === -1 || state.history[state.historyPos] !== state.currentIndex) {
      state.history.splice(state.historyPos + 1);
      state.history.push(state.currentIndex);
      state.historyPos = state.history.length - 1;
    }
  }

  // update nav buttons
  if (els.prevButton) els.prevButton.disabled = state.historyPos <= 0;
  if (els.nextButton) els.nextButton.disabled = true; // enabled after answering
  updateAutoNextButton();
  scrollQuestionIntoView();
  saveSession();
}

// Trên điện thoại, sau khi bấm "Tiếp theo" trang vẫn đang cuộn ở giữa/cuối câu cũ.
// Đưa đề bài của câu mới về đầu màn hình cho khỏi phải vuốt lên thủ công.
function scrollQuestionIntoView() {
  if (!IS_TOUCH_DEVICE || !els.questionCard || els.questionCard.classList.contains('hidden')) {
    return;
  }
  requestAnimationFrame(() => {
    const top = els.questionCard.getBoundingClientRect().top + window.scrollY - 8;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  });
}

function renderPrompt(prompt, answerText) {
  const escaped = escapeHtml(prompt);
  const answerHint = answerText.length > 1 ? `<span class="tag">Chọn ${answerText.length} đáp án</span>` : '';
  return `${answerHint}${escaped}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAnswerSet(answer) {
  return [...new Set(answer.map((item) => String(item).trim().toUpperCase()).filter(Boolean))].sort();
}

function clearSelections() {
  state.selectedLetters.clear();
  els.optionList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
}

function scheduleReview(questionIndex) {
  const delay = pickReviewDelay();
  const dueTurn = state.turn + delay;
  const existing = state.reviewQueue.find((item) => item.questionIndex === questionIndex);
  if (existing) {
    existing.dueTurn = Math.max(existing.dueTurn, dueTurn);
    return;
  }

  state.reviewQueue.push({
    questionIndex,
    dueTurn,
  });
}

function getReviewProgress(questionIndex) {
  const progress = state.reviewProgress[String(questionIndex)];
  return Number.isInteger(progress) ? progress : 0;
}

function setReviewProgress(questionIndex, count) {
  const key = String(questionIndex);
  if (count > 0) {
    state.reviewProgress[key] = count;
  } else {
    delete state.reviewProgress[key];
  }
}

function removeReviewEntries(questionIndex) {
  state.reviewQueue = state.reviewQueue.filter((item) => item.questionIndex !== questionIndex);
  setReviewProgress(questionIndex, 0);
}

function pullDueReview() {
  const dueIndices = [];
  const pending = [];

  for (const item of state.reviewQueue) {
    if (item.dueTurn <= state.turn) {
      dueIndices.push(item.questionIndex);
    } else {
      pending.push(item);
    }
  }

  state.reviewQueue = pending;
  if (dueIndices.length === 0) {
    return null;
  }

  const chosenIndex = dueIndices[Math.floor(Math.random() * dueIndices.length)];
  const stillPending = dueIndices.filter((index) => index !== chosenIndex).map((index) => ({ questionIndex: index, dueTurn: state.turn }));
  state.reviewQueue.push(...stillPending);
  return chosenIndex;
}

function pickNextQuestion() {
  const reviewIndex = pullDueReview();
  if (reviewIndex !== null) {
    state.currentIndex = reviewIndex;
    state.current = state.questions[reviewIndex];
    state.currentSource = 'review';
    // Clear stored wrong state so the user can answer again, but preserve isStarred
    const stored = state.questionStates[String(reviewIndex)];
    if (stored && !stored.isCorrect) {
      const wasStarred = stored.isStarred;
      delete state.questionStates[String(reviewIndex)];
      if (wasStarred) {
        state.questionStates[String(reviewIndex)] = { isStarred: true };
      }
    }
    return true;
  }

  if (state.pendingNew.length === 0) {
    if (state.reviewQueue.length > 0) {
      let earliestIndex = 0;
      for (let index = 1; index < state.reviewQueue.length; index += 1) {
        if (state.reviewQueue[index].dueTurn < state.reviewQueue[earliestIndex].dueTurn) {
          earliestIndex = index;
        }
      }

      const [nextReview] = state.reviewQueue.splice(earliestIndex, 1);
      state.currentIndex = nextReview.questionIndex;
      state.current = state.questions[nextReview.questionIndex];
      state.currentSource = 'review';
      // Clear stored wrong state so the user can answer again, but preserve isStarred
      const stored = state.questionStates[String(nextReview.questionIndex)];
      if (stored && !stored.isCorrect) {
        const wasStarred = stored.isStarred;
        delete state.questionStates[String(nextReview.questionIndex)];
        if (wasStarred) {
          state.questionStates[String(nextReview.questionIndex)] = { isStarred: true };
        }
      }
      return true;
    }

    state.current = null;
    state.currentIndex = -1;
    return false;
  }

  const nextIndex = state.pendingNew.shift();
  state.currentIndex = nextIndex;
  state.current = state.questions[nextIndex];
  state.currentSource = 'new';
  return true;
}

function showFeedback(isCorrect, message, kind, explanation = null) {
  els.feedback.classList.remove('hidden', 'good', 'bad');
  els.feedback.classList.add(kind);

  let content = message;
  if (explanation) {
    content += `<div class="explanation-box"><strong>Ghi chú / Giải thích:</strong><br />${escapeHtml(explanation).replace(/\n/g, '<br />')}</div>`;
  }
  els.feedback.innerHTML = content;
}

function revealCorrectAnswer(current) {
  const correctLabels = current.answer.join(', ');
  const correctOptions = current.options
    .filter((option) => current.answer.includes(option.label))
    .map((option) => `<strong>${escapeHtml(option.label)}.</strong> ${escapeHtml(option.text)}`)
    .join('<br />');
  return `<strong>Đáp án đúng:</strong> ${escapeHtml(correctLabels)}<br />${correctOptions}`;
}

function handleAnswer(selected) {
  if (!state.current || state.isLocked) {
    return;
  }

  const current = state.current;
  const normalizedSelected = normalizeAnswerSet(selected);
  const normalizedCorrect = normalizeAnswerSet(current.answer);
  const isCorrect = normalizedSelected.length === normalizedCorrect.length && normalizedSelected.every((value, index) => value === normalizedCorrect[index]);

  state.isLocked = true;
  state.turn += 1;
  if (window.neko && window.neko.onQuestionAnswered) {
    window.neko.onQuestionAnswered();
  }

  if (isCorrect) {
    state.correctStreak = (state.correctStreak || 0) + 1;
  } else {
    state.correctStreak = 0;
  }

  if (window.neko) {
    if (isCorrect) {
      if (state.correctStreak >= 3) {
        window.neko.triggerStreak(state.correctStreak);
      } else {
        window.neko.triggerCorrect();
      }
    } else {
      window.neko.triggerWrong();
    }
  }

  // mark stats and schedule review if wrong
  if (isCorrect) {
    state.correct += 1;
    if (state.currentSource === 'review') {
      const nextProgress = getReviewProgress(state.currentIndex) + 1;
      setReviewProgress(state.currentIndex, nextProgress);
      if (nextProgress >= 1) {
        state.reviewSolved += 1;
        if (state.pendingWrong.has(state.currentIndex)) {
          state.pendingWrong.delete(state.currentIndex);
          state.wrong = Math.max(0, state.wrong - 1);
        }
        removeReviewEntries(state.currentIndex);
      } else {
        scheduleReview(state.currentIndex);
      }
    }
  } else {
    if (!state.pendingWrong.has(state.currentIndex)) {
      state.wrong += 1;
      state.pendingWrong.add(state.currentIndex);
    }
    scheduleReview(state.currentIndex);
  }

  // show feedback and highlight options
  applyAnsweredState(current, normalizedSelected, isCorrect);
  saveQuestionState(state.currentIndex, normalizedSelected, isCorrect);
  updateStats();

  // highlight option elements
  const optionEls = Array.from(els.optionList.querySelectorAll('.option-button, .option-check'));
  optionEls.forEach((el) => {
    const letter = el.dataset ? el.dataset.letter : (el.querySelector('.option-key') && el.querySelector('.option-key').textContent.trim());
    if (!letter) return;
    const upper = String(letter).trim().toUpperCase();
    if (current.answer.includes(upper)) {
      el.classList.add('correct');
    }
    if (normalizedSelected.includes(upper) && !current.answer.includes(upper)) {
      el.classList.add('wrong');
    }
    // disable further clicks
    el.disabled = true;
    const inputs = el.querySelectorAll('input');
    inputs.forEach((i) => (i.disabled = true));
  });

  state.answeredCurrent = true;
  if (els.nextButton) els.nextButton.disabled = false;
  state.lastAnswerSelected = normalizedSelected;
  state.lastAnswerCorrect = isCorrect;
  saveSession();

  if (isCorrect && state.autoNextEnabled) {
    clearAutoNextTimer();
    const answeredIndex = state.currentIndex;
    state.autoNextTimer = setTimeout(() => {
      state.autoNextTimer = null;
      if (!state.current) return;
      if (state.currentIndex !== answeredIndex) return;
      if (!state.isLocked) return;
      goNext();
    }, 500);
  }

  // Real-time update immediately on activity
  updateActiveLearners();
}

function finishSession() {
  clearAutoNextTimer();
  state.current = null;
  state.currentIndex = -1;
  setVisibility(false);
  els.heroCard.classList.remove('hidden');
  els.emptyState.classList.remove('hidden');
  if (els.parseInfo) els.parseInfo.textContent = '';
  clearSession();
}

function startSession(options = {}) {
  if (state.questions.length === 0) {
    setVisibility(false);
    return;
  }

  // present questions in original order (source order)
  state.pendingNew = [...state.questions.keys()];
  if (options.shuffle) {
    for (let i = state.pendingNew.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.pendingNew[i], state.pendingNew[j]] = [state.pendingNew[j], state.pendingNew[i]];
    }
  }

  state.reviewQueue = [];
  state.pendingWrong = new Set();
  state.reviewProgress = {};
  state.turn = 0;
  state.correct = 0;
  state.wrong = 0;
  state.reviewSolved = 0;
  state.current = null;
  state.currentIndex = -1;
  state.currentSource = 'new';
  state.isLocked = false;
  state.lastAnswerCorrect = false;

  if (options.keepStarred) {
    const newStates = {};
    for (const [idx, s] of Object.entries(state.questionStates)) {
      if (s && s.isStarred) {
        newStates[idx] = { isStarred: true };
      }
    }
    state.questionStates = newStates;
  } else {
    state.questionStates = {};
  }
  
  clearAutoNextTimer();

  if (pickNextQuestion()) {
    renderQuestion(true);
    updateStats();
  }

  saveSession();
}

function goNext() {
  // if there's forward history, move forward
  if (state.historyPos < state.history.length - 1) {
    state.historyPos += 1;
    const idx = state.history[state.historyPos];
    state.currentIndex = idx;
    state.current = state.questions[idx];
    renderQuestion(false);
    applyStoredQuestionState(idx);
    updateStats();
    saveSession();
    return;
  }

  // otherwise pick a fresh next question
  if (pickNextQuestion()) {
    renderQuestion(true);
    updateStats();
  } else {
    finishSession();
  }
}

function jumpToQuestion(idx) {
  if (idx < 0 || idx >= state.questions.length) return;

  state.currentIndex = idx;
  state.current = state.questions[idx];

  const isReview = state.pendingWrong.has(idx) || state.reviewQueue.some(item => item.questionIndex === idx);
  state.currentSource = isReview ? 'review' : 'new';

  const pendingIndex = state.pendingNew.indexOf(idx);
  if (pendingIndex !== -1) {
    state.pendingNew.splice(pendingIndex, 1);
  }

  // Clear stored wrong state if it's a review question so they can answer again, but preserve isStarred
  const stored = state.questionStates[String(idx)];
  if (isReview && stored && !stored.isCorrect) {
    const wasStarred = stored.isStarred;
    delete state.questionStates[String(idx)];
    if (wasStarred) {
      state.questionStates[String(idx)] = { isStarred: true };
    }
  }

  renderQuestion(true);
  applyStoredQuestionState(idx);
  updateStats();
  saveSession();
}

function renderProgressDropdown() {
  if (!els.progressDropdown || state.questions.length === 0) return;

  els.progressDropdown.innerHTML = '';
  const displayQuestions = state.filterStarred ? getStarredIndices() : state.questions.map((_, i) => i);

  for (let idx of displayQuestions) {
    const item = document.createElement('div');
    item.className = 'progress-dropdown-item';
    if (idx === state.currentIndex) {
      item.classList.add('active');
    }
    item.textContent = String(idx + 1);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToQuestion(idx);
      els.progressDropdown.classList.add('hidden');
    });
    els.progressDropdown.appendChild(item);
  }
}

function toggleProgressDropdown(e) {
  if (e) e.stopPropagation();
  if (!els.progressDropdown) return;

  const isHidden = els.progressDropdown.classList.contains('hidden');
  if (isHidden) {
    renderProgressDropdown();
    els.progressDropdown.classList.remove('hidden');

    setTimeout(() => {
      const activeItem = els.progressDropdown.querySelector('.progress-dropdown-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 50);
  } else {
    els.progressDropdown.classList.add('hidden');
  }
}

function loadDataset(text, sourceName = 'ques.md') {
  const parsed = parseQuestions(text);
  state.questions = parsed;
  updateStats();

  if (parsed.length === 0) {
    if (els.parseInfo) {
      els.parseInfo.textContent = `Không đọc được câu hỏi nào từ ${sourceName}. Hãy kiểm tra định dạng hoặc dán lại nội dung.`;
    }
    showLoadError(`Không đọc được câu hỏi nào từ ${sourceName}. Kiểm tra lại định dạng file (đề bài → A. B. C. D. → @@@đáp án###).`);
    setVisibility(false);
    return;
  }

  if (els.parseInfo) els.parseInfo.textContent = '';
  if (!restoreSession()) {
    startSession();
  } else {
    const restoredAnsweredCurrent = state.answeredCurrent;
    const restoredSelectedLetters = [...state.selectedLetters];
    const restoredLastAnswerCorrect = state.lastAnswerCorrect;
    setVisibility(true);
    renderQuestion(false);
    if (restoredAnsweredCurrent && state.currentSource !== 'review') {
      applyAnsweredState(state.current, restoredSelectedLetters, restoredLastAnswerCorrect);
    }
    saveSession();
    updateStats();
  }
}

// Hiện lỗi ra màn hình thay vì im lặng — để còn biết đường mà sửa,
// nhất là trên điện thoại nơi không mở được console.
function showLoadError(message) {
  if (!els.emptyState) return;
  const box = els.emptyState.querySelector('p');
  if (box) box.textContent = message;
}

async function loadDefaultFile() {
  try {
    const response = await fetch('./ques.md', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    loadDataset(text, 'ques.md');
  } catch (error) {
    if (els.parseInfo) els.parseInfo.textContent = '';
    showLoadError(`Không tải được ques.md (${error && error.message ? error.message : 'lỗi không rõ'}). Thử tải lại trang.`);
    setVisibility(false);
  }
}

// Gọi ngay tại đây thay vì cuối file: fetch là bất đồng bộ nên phần còn lại của
// script vẫn chạy xong trước. Nhờ vậy nếu một widget phía dưới (Neko, chat...)
// lỗi thì bộ câu hỏi VẪN tải được.
loadDefaultFile();

if (els.fileInput) {
  els.fileInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    loadDataset(text, file.name);
  });
}

// localStorage có thể ném lỗi (Safari riêng tư, chặn cookie) -> bọc lại
const safeStore = {
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* bỏ qua */ }
  },
};

/* ==========================================================================
   Danh tính người học

   Không có đăng nhập nên không thể biết chính xác "người". Cách tốt nhất còn
   lại là nhận dạng TRÌNH DUYỆT, gồm hai lớp:

   1. Dấu vân tay thiết bị — ghép các đặc điểm ít đổi (độ phân giải màn hình,
      múi giờ, ngôn ngữ, số nhân CPU, nền tảng...) rồi băm lại. Xoá cache hay
      mở chế độ ẩn danh vẫn ra cùng một mã.
   2. Mã ngẫu nhiên trong localStorage — để phân biệt hai người dùng chung
      một máy nhưng khác profile trình duyệt.

   Ghép cả hai: "<vân tay>-<mã ngẫu nhiên rút gọn>". Xoá cache thì phần ngẫu
   nhiên đổi nhưng vân tay giữ nguyên, nên server vẫn gom được về một người
   (xem cách gom ở api/stats.js).
   ========================================================================== */
const USER_ID_KEY = 'vnr202.user_id';

// Băm chuỗi thành mã 8 ký tự (FNV-1a) — đủ dùng, không cần thư viện
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

function getDeviceFingerprint() {
  const n = window.navigator || {};
  const s = window.screen || {};
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) { /* trình duyệt cũ */ }

  const parts = [
    n.userAgent || '',
    n.platform || '',
    n.language || '',
    (n.languages || []).join(','),
    n.hardwareConcurrency || '',
    n.maxTouchPoints || '',
    s.width || '',
    s.height || '',
    s.colorDepth || '',
    window.devicePixelRatio || '',
    timezone,
    new Date().getTimezoneOffset(),
  ];
  return hashString(parts.join('|'));
}

let cachedUserId = null;

function getUserId() {
  if (cachedUserId) return cachedUserId;

  const fingerprint = getDeviceFingerprint();
  let random = safeStore.get(USER_ID_KEY);
  if (!random) {
    random = Math.random().toString(36).slice(2, 8);
    safeStore.set(USER_ID_KEY, random);
  }

  cachedUserId = `${fingerprint}-${random}`;
  return cachedUserId;
}

/* --- Biệt danh: tự sinh ngẫu nhiên, bấm vào đổi được --- */
const NICKNAME_KEY = 'vnr202.nickname';
const NICK_ADJ = ['Mèo Lười', 'Cú Đêm', 'Sen Chăm', 'Học Sĩ', 'Cao Thủ', 'Tân Binh',
  'Thợ Cày', 'Sĩ Tử', 'Bí Ẩn', 'Chiến Thần', 'Gà Con', 'Đại Bàng'];

function generateNickname() {
  const adj = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
  return `${adj} ${Math.floor(Math.random() * 90) + 10}`;
}

function getNickname() {
  let name = safeStore.get(NICKNAME_KEY);
  if (!name) {
    name = generateNickname();
    safeStore.set(NICKNAME_KEY, name);
  }
  return name;
}

function setNickname(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return getNickname();
  safeStore.set(NICKNAME_KEY, clean);
  renderNickname();
  return clean;
}

function renderNickname() {
  if (els.nicknameValue) els.nicknameValue.textContent = getNickname();
}

// Định dạng số cho dễ đọc: 12345 -> 12.345
function formatNumber(n) {
  return Number(n || 0).toLocaleString('vi-VN');
}

/* Khi máy chủ thống kê không phản hồi, đừng để các ô đứng im như thể vẫn đúng.
   Hiện dấu "!" kèm lời giải thích khi rê chuột, để biết là đang hỏng chứ không
   phải "chỉ có mỗi mình đang học". */
const STATS_OFFLINE_HINT =
  'Chưa kết nối được máy chủ thống kê. Kiểm tra biến môi trường REDIS_URL trên Vercel.';

function markStatsOffline(isOffline) {
  const targets = [
    els.activeCount, els.todayLearners, els.totalVisits,
    els.mtbActive, els.mtbToday, els.mtbVisits,
  ];
  targets.forEach((el) => {
    if (!el) return;
    if (isOffline) {
      el.textContent = '!';
      el.title = STATS_OFFLINE_HINT;
      el.classList.add('stat-offline');
    } else {
      el.removeAttribute('title');
      el.classList.remove('stat-offline');
    }
  });
}

// Đổ ba con số mô phỏng lên giao diện. Không gọi mạng, chạy được cả khi offline.
function renderSimulatedStats() {
  const now = Date.now();
  const active = simActiveLearners(now);
  const today = simTodayLearners(now);
  const visits = simTotalVisits(now);

  setCounter(els.activeCount, active);
  setCounter(els.mtbActive, active);
  setCounter(els.todayLearners, formatNumber(today));
  setCounter(els.mtbToday, formatNumber(today));
  setCounter(els.totalVisits, formatNumber(visits));
  setCounter(els.mtbVisits, formatNumber(visits));
}

async function updateActiveLearners() {
  // Chế độ mô phỏng: tính tại chỗ, không đụng tới server
  if (FEATURES.simulatedStats) {
    renderSimulatedStats();
    return;
  }

  try {
    // Việc quyết định "có tính thêm một lượt vào hay không" nằm ở server:
    // chỉ cộng khi người này đã nghỉ hơn 30 phút. Client không tự tính để
    // tránh F5 hay mở nhiều tab làm thổi phồng con số.
    const response = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: getUserId() }),
    });
    if (!response.ok) {
      throw new Error(`/api/stats trả về HTTP ${response.status}`);
    }
    const data = await response.json();
    markStatsOffline(false);
    if (data && typeof data.activeCount === 'number') {
      setCounter(els.activeCount, data.activeCount);
      setCounter(els.mtbActive, data.activeCount);
    }

    if (data && typeof data.todayLearners === 'number') {
      setCounter(els.todayLearners, formatNumber(data.todayLearners));
      setCounter(els.mtbToday, formatNumber(data.todayLearners));
    }

    if (data && typeof data.totalVisits === 'number') {
      setCounter(els.totalVisits, formatNumber(data.totalVisits));
      setCounter(els.mtbVisits, formatNumber(data.totalVisits));
    }

    // Sync neko state from server.
    // Bỏ qua trên thiết bị cảm ứng: máy khác bật Neko không nên tự bật trên điện thoại.
    if (!IS_TOUCH_DEVICE && data && typeof data.nekoEnabled === 'boolean' && window.neko) {
      const serverEnabled = data.nekoEnabled;
      const localEnabled = window.neko.isEnabled();
      if (serverEnabled !== localEnabled) {
        window.neko.setEnabled(serverEnabled);
        if (els.nekoToggleBtn) {
          els.nekoToggleBtn.classList.toggle('active', serverEnabled);
        }
      }
    }
  } catch (error) {
    markStatsOffline(true);
    console.error(
      '[thống kê] Không gọi được /api/stats. Thường là do biến môi trường ' +
      'REDIS_URL (hoặc KV_URL) chưa được khai báo trên Vercel, hoặc Redis không kết nối được. ' +
      'Kiểm tra Vercel → Settings → Environment Variables, rồi Redeploy.',
      error
    );
  }
}

// Chat Implementation
async function loadChatMessages() {
  try {
    const response = await fetch('/api/chat');
    const data = await response.json();
    if (data && Array.isArray(data.messages)) {
      renderChatMessages(data.messages);
    }
  } catch (error) {
    console.error('Failed to load chat messages:', error);
  }
}

function openImage(src) {
  if (!els.imageModal || !els.modalImg) return;
  els.modalImg.src = src;
  els.imageModal.classList.remove('hidden');
}

if (els.imageModal) {
  els.imageModal.addEventListener('click', () => {
    els.imageModal.classList.add('hidden');
    els.modalImg.src = '';
  });
}

function renderChatMessages(messages) {
  if (!els.chatMessages) return;

  if (messages.length === 0) {
    els.chatMessages.innerHTML = '<div class="chat-empty">Chưa có tin nhắn nào. Hãy là người đầu tiên!</div>';
    return;
  }

  // Check if we actually need to re-render
  const latestMsg = messages[messages.length - 1];
  if (state.lastChatId === latestMsg.id) return;

  // Track unread messages if container is collapsed
  const isMe = latestMsg.userId === getUserId();
  const container = document.querySelector('.chat-container');
  const isCollapsed = container && container.classList.contains('collapsed');
  if (state.lastChatId && isCollapsed) {
    const lastIndex = messages.findIndex(m => m.id === state.lastChatId);
    let newCount = 0;
    if (lastIndex !== -1) {
      const currentUserId = getUserId();
      for (let i = lastIndex + 1; i < messages.length; i++) {
        if (messages[i].userId !== currentUserId) {
          newCount++;
        }
      }
    } else {
      if (!isMe) newCount = 1;
    }
    if (newCount > 0) {
      state.unreadCount += newCount;
      updateChatBadge();
    }
  }

  state.lastChatId = latestMsg.id;

  const currentUserId = getUserId();
  const html = messages.map(msg => {
    const isMe = msg.userId === currentUserId;
    return `
      <div class="chat-msg ${isMe ? 'me' : 'others'}" data-id="${msg.id}">
        ${!isMe ? `<span class="name">${escapeHtml(msg.userName)}</span>` : ''}
        <div class="msg-content">
          ${msg.image ? `<div class="image"><img src="${msg.image}" alt="Pasted Image" class="chat-img" /></div>` : ''}
          ${msg.text ? `<div class="text">${escapeHtml(msg.text)}</div>` : ''}
        </div>
        ${isMe ? `<button class="recall-btn" title="Thu hồi">&times;</button>` : ''}
      </div>
    `;
  }).join('');

  els.chatMessages.innerHTML = html;

  // Add recall listeners
  els.chatMessages.querySelectorAll('.recall-btn').forEach(btn => {
    btn.onclick = (e) => {
      const msgId = e.target.closest('.chat-msg').dataset.id;
      recallMessage(msgId);
    };
  });

  // Add image click listeners (delegated is better, but let's do it here for simplicity or use delegation outside)
  els.chatMessages.querySelectorAll('.chat-img').forEach(img => {
    img.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openImage(img.src);
    };
  });

  // Scroll to bottom
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function recallMessage(messageId) {
  if (!confirm('Bạn muốn thu hồi tin nhắn này?')) return;

  try {
    const response = await fetch('/api/chat', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        userId: getUserId()
      })
    });

    if (response.ok) {
      state.lastChatId = null; // Force re-render
      loadChatMessages();
    }
  } catch (error) {
    console.error('Failed to recall message:', error);
  }
}

async function sendChatMessage(text, image = null) {
  if (!text.trim() && !image) return;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: getUserId(),
        userName: getNickname(),
        text: text,
        image: image
      })
    });

    if (response.ok) {
      if (text) els.chatInput.value = '';
      if (els.emojiPicker) els.emojiPicker.classList.add('hidden');
      clearImagePreview();
      loadChatMessages(); // Refresh immediately
      if (window.neko) {
        window.neko.triggerChat();
      }
    }
  } catch (error) {
    console.error('Failed to send message:', error);
  }
}

function clearImagePreview() {
  state.pendingImage = null;
  if (els.previewImg) els.previewImg.src = '';
  if (els.imagePreview) els.imagePreview.classList.add('hidden');
}

if (els.chatForm) {
  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value;
    sendChatMessage(text, state.pendingImage);

    if (window.neko && window.neko.triggerComfort && text) {
      const lower = text.toLowerCase();
      if (
        lower.includes('mệt') ||
        lower.includes('nản') ||
        lower.includes('khó') ||
        lower.includes('sai') ||
        lower.includes('buồn')
      ) {
        window.neko.triggerComfort();
      }
    }
  });

  els.chatInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          state.pendingImage = event.target.result;
          if (els.previewImg) els.previewImg.src = state.pendingImage;
          if (els.imagePreview) els.imagePreview.classList.remove('hidden');
        };
        reader.readAsDataURL(blob);
      }
    }
  });

  if (els.removePreviewBtn) {
    els.removePreviewBtn.addEventListener('click', () => {
      clearImagePreview();
    });
  }

  if (els.previewImg) {
    els.previewImg.addEventListener('click', () => {
      if (state.pendingImage) {
        openImage(state.pendingImage);
      }
    });
  }
}

if (els.chatToggleBtn) {
  els.chatToggleBtn.addEventListener('click', () => {
    const container = document.querySelector('.chat-container');
    const isExpanding = container.classList.contains('collapsed');
    container.classList.toggle('collapsed');

    if (isExpanding && els.chatMessages) {
      setTimeout(() => {
        els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
      }, 300); // Wait for transition if any
    }
  });
}

function updateChatBadge() {
  if (!els.chatBadge) return;
  if (state.unreadCount > 0) {
    els.chatBadge.textContent = state.unreadCount;
    els.chatBadge.classList.remove('hidden');
  } else {
    els.chatBadge.textContent = '0';
    els.chatBadge.classList.add('hidden');
  }
}

function clearChatBadge() {
  state.unreadCount = 0;
  updateChatBadge();
}

// Add event listeners to clear badge when user interacts with chat
const chatHeader = document.querySelector('.chat-header');
if (chatHeader) {
  chatHeader.addEventListener('click', clearChatBadge);
}
if (els.chatMessages) {
  els.chatMessages.addEventListener('click', clearChatBadge);
}
if (els.chatForm) {
  els.chatForm.addEventListener('click', clearChatBadge);
}
if (els.chatInput) {
  els.chatInput.addEventListener('focus', clearChatBadge);
}

// Start tracking
let activeTrackingInterval = null;
let chatPollingInterval = null;

function startTracking() {
  updateActiveLearners();

  if (activeTrackingInterval) clearInterval(activeTrackingInterval);
  activeTrackingInterval = setInterval(updateActiveLearners, 5000);

  if (!FEATURES.chat) return; // chat đang tắt, không gọi /api/chat

  loadChatMessages();
  if (chatPollingInterval) clearInterval(chatPollingInterval);
  chatPollingInterval = setInterval(loadChatMessages, 3000); // Poll chat more frequently
}

function stopTracking() {
  if (activeTrackingInterval) {
    clearInterval(activeTrackingInterval);
    activeTrackingInterval = null;
  }
  if (chatPollingInterval) {
    clearInterval(chatPollingInterval);
    chatPollingInterval = null;
  }
}

// Emoji Implementation
async function loadEmojis() {
  try {
    const response = await fetch('./resource/emoji.json');
    const data = await response.json();
    state.emojis = data;
    renderEmojis();
  } catch (error) {
    console.error('Failed to load emojis:', error);
  }
}

function renderEmojis(filter = '') {
  if (!els.emojiList) return;

  const filtered = filter
    ? state.emojis.filter(e => e.name.toLowerCase().includes(filter.toLowerCase()) || e.group.toLowerCase().includes(filter.toLowerCase()))
    : state.emojis.slice(0, 200); // Limit initial view for performance

  const html = filtered.map(e => `<span title="${e.name}">${e.char}</span>`).join('');
  els.emojiList.innerHTML = html;

  els.emojiList.querySelectorAll('span').forEach(span => {
    span.onclick = () => {
      const emoji = span.textContent;
      const start = els.chatInput.selectionStart;
      const end = els.chatInput.selectionEnd;
      const text = els.chatInput.value;
      els.chatInput.value = text.slice(0, start) + emoji + text.slice(end);
      els.chatInput.focus();
      const newPos = start + emoji.length;
      els.chatInput.setSelectionRange(newPos, newPos);

      // Close picker on mobile or if user prefers, but usually keeping it open for multi-emoji is better.
      // For now let's keep it open but maybe close on send.
    };
  });
}

if (els.emojiToggleBtn) {
  els.emojiToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.emojiPicker.classList.toggle('hidden');
    if (!els.emojiPicker.classList.contains('hidden')) {
      if (state.emojis.length === 0) loadEmojis();
    }
  });
}



// Close emoji picker and progress dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (els.emojiPicker && !els.emojiPicker.contains(e.target) && e.target !== els.emojiToggleBtn) {
    els.emojiPicker.classList.add('hidden');
  }
  if (els.progressDropdown && !els.progressDropdown.contains(e.target) && e.target !== els.progressText) {
    els.progressDropdown.classList.add('hidden');
  }
});

if (els.progressText) {
  els.progressText.addEventListener('click', toggleProgressDropdown);
}

// Handle visibility change to save resources and update immediately on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startTracking();
  } else {
    stopTracking();
  }
});

startTracking();

// require confirmation before resetting/refreshing
if (els.reloadButton && els.refreshDropdown) {
  els.reloadButton.addEventListener('click', (e) => {
    e.stopPropagation();
    els.refreshDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!els.reloadButton.contains(e.target) && !els.refreshDropdown.contains(e.target)) {
      els.refreshDropdown.classList.add('hidden');
    }
  });

  const handleRefresh = (options) => {
    els.refreshDropdown.classList.add('hidden');
    const confirmed = window.confirm('Xác nhận làm mới? Mọi tiến độ hiện tại sẽ bị mất.');
    if (!confirmed) return;
    if (state.questions.length > 0) {
      startSession(options);
    } else {
      loadDefaultFile();
    }
  };

  if (els.refreshAllBtn) els.refreshAllBtn.addEventListener('click', () => handleRefresh({}));
  if (els.refreshKeepStarredBtn) els.refreshKeepStarredBtn.addEventListener('click', () => handleRefresh({ keepStarred: true }));
  if (els.refreshShuffleBtn) els.refreshShuffleBtn.addEventListener('click', () => handleRefresh({ shuffle: true, keepStarred: true }));
}

if (els.autoNextButton) {
  els.autoNextButton.addEventListener('click', () => {
    state.autoNextEnabled = !state.autoNextEnabled;
    updateAutoNextButton();
    saveSession();
  });
}

// Prev / Next navigation
if (els.prevButton) {
  els.prevButton.addEventListener('click', () => {
    if (state.historyPos > 0) {
      state.historyPos -= 1;
      const idx = state.history[state.historyPos];
      state.currentIndex = idx;
      state.current = state.questions[idx];
      renderQuestion(false);
      applyStoredQuestionState(idx);
      updateStats();
      saveSession();
    }
  });
}

if (els.nextButton) {
  els.nextButton.addEventListener('click', () => {
    goNext();
  });
}

if (els.starQuestionButton) {
  els.starQuestionButton.addEventListener('click', () => {
    if (state.currentIndex === -1 || !state.current) return;
    const existing = state.questionStates[String(state.currentIndex)] || {};
    existing.isStarred = !existing.isStarred;
    state.questionStates[String(state.currentIndex)] = existing;
    
    // re-render current question's star icon
    renderQuestion(false);
    updateStats();
    saveSession();
  });
}

if (els.starredFilterBtn) {
  els.starredFilterBtn.addEventListener('click', () => {
    state.filterStarred = !state.filterStarred;
    els.starredFilterBtn.classList.toggle('active', state.filterStarred);
    
    // update dropdown
    renderProgressDropdown();
    renderQuestion(false);
    
    // if filter is ON, we should jump to a starred question if the current one isn't
    if (state.filterStarred) {
      const starred = getStarredIndices();
      if (starred.length > 0 && !starred.includes(state.currentIndex)) {
        jumpToQuestion(starred[0]);
      }
    }
  });
}

if (els.resetQuestionButton) {
  els.resetQuestionButton.addEventListener('click', () => {
    if (state.currentIndex === -1 || !state.current) return;

    // Clear the stored state for this question, but preserve isStarred
    const existing = state.questionStates[String(state.currentIndex)];
    const wasStarred = existing && existing.isStarred;
    delete state.questionStates[String(state.currentIndex)];
    if (wasStarred) {
      state.questionStates[String(state.currentIndex)] = { isStarred: true };
    }

    // Re-render without pushing new history entry
    renderQuestion(false);
  });
}

if (els.loadTextButton) {
  els.loadTextButton.addEventListener('click', () => {
    const text = els.rawInput.value.trim();
    if (!text) return;
    loadDataset(text, 'nội dung dán vào');
  });
}

// Question Search implementation
function toggleQuestionSearch() {
  if (state.isSearchActive) {
    hideQuestionSearch();
  } else {
    showQuestionSearch();
  }
}

function hideQuestionSearch() {
  state.isSearchActive = false;
  if (els.searchQuestionButton) els.searchQuestionButton.classList.remove('active');
  if (els.questionSearchRow) els.questionSearchRow.classList.add('hidden');
  if (els.searchResultsContainer) {
    els.searchResultsContainer.classList.add('hidden');
    els.searchResultsContainer.innerHTML = '';
  }
  if (els.questionSearchInput) els.questionSearchInput.value = '';
  if (els.questionInteractiveArea) els.questionInteractiveArea.classList.remove('hidden');
}

function showQuestionSearch() {
  if (isNoteViewActive) {
    hideNote();
  }
  state.isSearchActive = true;
  if (els.searchQuestionButton) els.searchQuestionButton.classList.add('active');
  if (els.questionSearchRow) els.questionSearchRow.classList.remove('hidden');
  if (els.questionSearchInput) {
    els.questionSearchInput.value = '';
    els.questionSearchInput.focus();
  }
  renderSearchResults('');
}

function highlightSearchText(text, query) {
  if (!query) return escapeHtml(text);
  const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  const escapedText = escapeHtml(text);
  return escapedText.replace(regex, '<span class="search-highlight">$1</span>');
}

function renderSearchResults(query) {
  if (!els.searchResultsContainer) return;

  const trimmedQuery = query.trim().toLowerCase();

  if (!trimmedQuery) {
    if (els.searchResultsContainer) els.searchResultsContainer.classList.add('hidden');
    if (els.questionInteractiveArea) els.questionInteractiveArea.classList.remove('hidden');
    return;
  }

  if (els.questionInteractiveArea) els.questionInteractiveArea.classList.add('hidden');
  if (els.searchResultsContainer) els.searchResultsContainer.classList.remove('hidden');

  const matches = [];
  state.questions.forEach((q, index) => {
    const promptMatch = q.prompt.toLowerCase().includes(trimmedQuery);
    const optionMatch = q.options.some(opt => opt.text.toLowerCase().includes(trimmedQuery));
    const explanationMatch = q.explanation && q.explanation.toLowerCase().includes(trimmedQuery);

    if (promptMatch || optionMatch || explanationMatch) {
      matches.push({ question: q, index });
    }
  });

  if (matches.length === 0) {
    els.searchResultsContainer.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted);">Không tìm thấy câu hỏi nào chứa từ khóa "${escapeHtml(query)}"</div>`;
    return;
  }

  let html = '';
  matches.forEach(({ question: q, index }) => {
    const optionsHtml = q.options.map(opt => {
      const isCorrect = q.answer.includes(opt.label);
      return `
        <div class="search-result-option ${isCorrect ? 'correct' : ''}">
          <span class="option-key">${opt.label}</span>
          <span class="option-body">${highlightSearchText(opt.text, query)}</span>
        </div>
      `;
    }).join('');

    const explanationHtml = q.explanation
      ? `<div class="explanation-box" style="margin-top:8px;"><strong>Giải thích:</strong><br />${highlightSearchText(q.explanation, query).replace(/\n/g, '<br />')}</div>`
      : '';

    html += `
      <div class="search-result-item" data-index="${index}">
        <div class="search-result-header">
          <span class="search-result-badge">Câu ${index + 1}</span>
          <span class="search-result-source">${q.source === 'html' ? 'HTML' : 'Text'}</span>
        </div>
        <div class="search-result-prompt">${highlightSearchText(q.prompt, query)}</div>
        <div class="search-result-options">
          ${optionsHtml}
        </div>
        ${explanationHtml}
      </div>
    `;
  });

  els.searchResultsContainer.innerHTML = html;

  els.searchResultsContainer.querySelectorAll('.search-result-item').forEach(item => {
    item.onclick = (e) => {
      const idx = parseInt(item.dataset.index, 10);
      hideQuestionSearch();
      jumpToQuestion(idx);
    };
  });
}

// Note Section Logic
let isNoteViewActive = false;

function showNote() {
  isNoteViewActive = true;
  hideQuestionSearch();
  if (els.questionCard) els.questionCard.classList.add('hidden');
  if (els.heroCard) els.heroCard.classList.add('hidden');
  if (els.emptyState) els.emptyState.classList.add('hidden');
  if (els.noteCard) els.noteCard.classList.remove('hidden');
  if (els.noteToggleBtn) els.noteToggleBtn.classList.add('active');
  renderNoteContent();
  if (els.noteSearchInput) {
    els.noteSearchInput.value = '';
  }
}

function hideNote() {
  isNoteViewActive = false;
  if (els.noteCard) els.noteCard.classList.add('hidden');
  if (els.noteToggleBtn) els.noteToggleBtn.classList.remove('active');

  // Restore correct section based on state
  if (state.current) {
    if (els.questionCard) els.questionCard.classList.remove('hidden');
  } else {
    if (els.heroCard) els.heroCard.classList.remove('hidden');
    if (els.emptyState) els.emptyState.classList.remove('hidden');
  }
}

function renderNoteContent(searchQuery = '') {
  if (!els.noteContentContainer || typeof window.notesData === 'undefined') return;

  const query = searchQuery.toLowerCase().trim();
  let html = '';

  window.notesData.forEach((section) => {
    let sectionHtml = '';
    let hasMatchingContent = false;

    // Filter items
    section.items.forEach((item) => {
      let itemHtml = '';
      let itemMatches = false;

      if (item.type === 'subsection') {
        const titleMatches = item.title.toLowerCase().includes(query);
        let matchingNotes = [];

        item.notes.forEach((note) => {
          if (!query || note.toLowerCase().includes(query) || titleMatches) {
            matchingNotes.push(note);
          }
        });

        const warningMatches = item.warning && item.warning.toLowerCase().includes(query);

        if (titleMatches || matchingNotes.length > 0 || warningMatches) {
          itemMatches = true;
          itemHtml += `<div class="note-subsection">`;
          itemHtml += `<div class="note-subsection-title">${escapeHtml(item.title)}</div>`;
          if (matchingNotes.length > 0) {
            itemHtml += `<ul class="note-list">`;
            matchingNotes.forEach((note) => {
              itemHtml += `<li>${note}</li>`;
            });
            itemHtml += `</ul>`;
          }
          if (item.warning && (!query || warningMatches || titleMatches || matchingNotes.length > 0)) {
            itemHtml += `<div class="note-warning-box"><strong>DỄ NHẦM:</strong> ${item.warning}</div>`;
          }
          itemHtml += `</div>`;
        }
      } else if (item.type === 'list') {
        let matchingNotes = [];
        item.notes.forEach((note) => {
          if (!query || note.toLowerCase().includes(query)) {
            matchingNotes.push(note);
          }
        });

        if (matchingNotes.length > 0) {
          itemMatches = true;
          itemHtml += `<div class="note-subsection">`;
          if (item.ordered) {
            itemHtml += `<ol class="note-list">`;
            matchingNotes.forEach((note) => {
              itemHtml += `<li>${note}</li>`;
            });
            itemHtml += `</ol>`;
          } else {
            itemHtml += `<ul class="note-list">`;
            matchingNotes.forEach((note) => {
              itemHtml += `<li>${note}</li>`;
            });
            itemHtml += `</ul>`;
          }
          if (item.warning && (!query || item.warning.toLowerCase().includes(query))) {
            itemHtml += `<div class="note-warning-box"><strong>DỄ NHẦM:</strong> ${item.warning}</div>`;
          }
          itemHtml += `</div>`;
        }
      } else if (item.type === 'table') {
        const headerMatches = item.headers.some(h => h.toLowerCase().includes(query));
        let matchingRows = [];

        item.rows.forEach((row) => {
          if (!query || headerMatches || row.some(cell => cell.toLowerCase().includes(query))) {
            matchingRows.push(row);
          }
        });

        if (headerMatches || matchingRows.length > 0) {
          itemMatches = true;
          itemHtml += `<div class="note-subsection" style="overflow-x:auto;">`;
          itemHtml += `<table class="note-table">`;
          itemHtml += `<thead><tr>`;
          item.headers.forEach((h) => {
            itemHtml += `<th>${escapeHtml(h)}</th>`;
          });
          itemHtml += `</tr></thead>`;
          itemHtml += `<tbody>`;
          matchingRows.forEach((row) => {
            itemHtml += `<tr>`;
            row.forEach((cell) => {
              itemHtml += `<td>${cell}</td>`;
            });
            itemHtml += `</tr>`;
          });
          itemHtml += `</tbody></table>`;
          itemHtml += `</div>`;
        }
      }

      if (itemMatches) {
        sectionHtml += itemHtml;
        hasMatchingContent = true;
      }
    });

    // If section title itself matches and query isn't empty, show everything in this section
    const sectionTitleMatches = section.title.toLowerCase().includes(query);
    if (sectionTitleMatches && query && !hasMatchingContent) {
      // Re-run matching but ignoring query filter for items to show full section
      section.items.forEach((item) => {
        let itemHtml = '';
        if (item.type === 'subsection') {
          itemHtml += `<div class="note-subsection">`;
          itemHtml += `<div class="note-subsection-title">${escapeHtml(item.title)}</div>`;
          itemHtml += `<ul class="note-list">`;
          item.notes.forEach((note) => {
            itemHtml += `<li>${note}</li>`;
          });
          itemHtml += `</ul>`;
          if (item.warning) {
            itemHtml += `<div class="note-warning-box"><strong>DỄ NHẦM:</strong> ${item.warning}</div>`;
          }
          itemHtml += `</div>`;
        } else if (item.type === 'list') {
          itemHtml += `<div class="note-subsection">`;
          if (item.ordered) {
            itemHtml += `<ol class="note-list">`;
            item.notes.forEach((note) => {
              itemHtml += `<li>${note}</li>`;
            });
            itemHtml += `</ol>`;
          } else {
            itemHtml += `<ul class="note-list">`;
            item.notes.forEach((note) => {
              itemHtml += `<li>${note}</li>`;
            });
            itemHtml += `</ul>`;
          }
          itemHtml += `</div>`;
        } else if (item.type === 'table') {
          itemHtml += `<div class="note-subsection" style="overflow-x:auto;">`;
          itemHtml += `<table class="note-table"><thead><tr>`;
          item.headers.forEach((h) => {
            itemHtml += `<th>${escapeHtml(h)}</th>`;
          });
          itemHtml += `</tr></thead><tbody>`;
          item.rows.forEach((row) => {
            itemHtml += `<tr>`;
            row.forEach((cell) => {
              itemHtml += `<td>${cell}</td>`;
            });
            itemHtml += `</tr>`;
          });
          itemHtml += `</tbody></table></div>`;
        }
        sectionHtml += itemHtml;
      });
      hasMatchingContent = true;
    }

    if (hasMatchingContent || sectionTitleMatches || !query) {
      html += `<div class="note-section">`;
      html += `<div class="note-section-title">${escapeHtml(section.title)}</div>`;
      html += sectionHtml;
      html += `</div>`;
    }
  });

  if (!html) {
    html = `<div style="text-align:center;padding:24px;color:var(--muted);">Không tìm thấy keyword nào khớp với "${escapeHtml(searchQuery)}"</div>`;
  }

  els.noteContentContainer.innerHTML = html;
}

if (els.noteToggleBtn) {
  els.noteToggleBtn.addEventListener('click', () => {
    if (isNoteViewActive) {
      hideNote();
    } else {
      showNote();
    }
  });
}

if (els.closeNoteButton) {
  els.closeNoteButton.addEventListener('click', () => {
    hideNote();
  });
}

if (els.noteSearchInput) {
  els.noteSearchInput.addEventListener('input', (e) => {
    renderNoteContent(e.target.value);
  });
}

if (els.searchQuestionButton) {
  els.searchQuestionButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleQuestionSearch();
  });
}

if (els.questionSearchInput) {
  els.questionSearchInput.addEventListener('input', (e) => {
    renderSearchResults(e.target.value);
  });
}

// Modify setVisibility to also respect Note view state
const originalSetVisibility = setVisibility;
setVisibility = function (hasQuestion) {
  if (isNoteViewActive) {
    if (els.heroCard) els.heroCard.classList.add('hidden');
    if (els.questionCard) els.questionCard.classList.add('hidden');
    if (els.emptyState) els.emptyState.classList.add('hidden');
    if (els.noteCard) els.noteCard.classList.remove('hidden');
  } else {
    if (els.noteCard) els.noteCard.classList.add('hidden');
    originalSetVisibility(hasQuestion);
  }
};

// Initial load check if window.notesData is loaded
if (typeof window.notesData !== 'undefined') {
  renderNoteContent();
}

if (els.nekoToggleBtn) {
  if (window.neko && typeof window.neko.isEnabled === 'function') {
    els.nekoToggleBtn.classList.toggle('active', window.neko.isEnabled());
  } else {
    els.nekoToggleBtn.classList.remove('active');
  }
  els.nekoToggleBtn.addEventListener('click', () => {
    if (window.neko) {
      const isNowEnabled = typeof window.neko.toggle === 'function'
        ? window.neko.toggle()
        : false;
      els.nekoToggleBtn.classList.toggle('active', Boolean(isNowEnabled));

      // Sync neko state to server for all clients
      fetch('/api/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), nekoEnabled: isNowEnabled }),
      }).catch(err => console.error('Failed to sync neko state:', err));
    }
  });
}

// Keyboard navigation shortcuts
document.addEventListener('keydown', (e) => {
  const activeEl = document.activeElement;
  if (
    activeEl &&
    ((activeEl.tagName === 'INPUT' && activeEl.type !== 'checkbox' && activeEl.type !== 'radio') ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.isContentEditable)
  ) {
    return;
  }

  if (e.key === 'ArrowLeft') {
    if (els.prevButton && !els.prevButton.disabled) {
      e.preventDefault();
      els.prevButton.click();
    }
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault();
    goNext();
  } else if (e.key === ' ' || e.code === 'Space') {
    if (activeEl && (activeEl.type === 'checkbox' || activeEl.type === 'radio')) {
      return;
    }
    if (state.current && !state.isLocked) {
      e.preventDefault();
      handleAnswer(state.current.answer);
    }
  }
});


/* ==========================================================================
   MOBILE: bảng điều khiển dạng bottom-sheet
   Trên điện thoại, sidebar được ẩn và chỉ mở khi bấm nút ☰,
   để lúc học chỉ còn: đề bài -> chọn đáp án -> Tiếp theo.
   ========================================================================== */
(function initMobileSheet() {
  const menuBtn = document.getElementById('mobileMenuBtn');
  const overlay = document.getElementById('mobileMenuOverlay');
  const sidebar = document.querySelector('.sidebar');
  if (!menuBtn || !overlay || !sidebar) return;

  function isSheetMode() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function openSheet() {
    document.body.classList.add('sidebar-open');
    menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSheet() {
    document.body.classList.remove('sidebar-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  menuBtn.addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeSheet();
    else openSheet();
  });

  overlay.addEventListener('click', closeSheet);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  // Bấm một chức năng trong tấm trượt (Note, Tự next, Neko, lọc sao, làm mới...)
  // thì đóng luôn để quay lại màn hình học. Trừ nút Refresh vì nó mở menu con,
  // và trừ khu vực chat vì còn phải gõ tin nhắn.
  sidebar.addEventListener('click', (e) => {
    if (!isSheetMode()) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'reloadButton') return;      // mở menu con
    if (btn.id === 'nicknameBtn') return;       // đổi tên xong còn xem lại
    if (btn.closest('.chat-container')) return; // còn gõ tin nhắn
    setTimeout(closeSheet, 120);
  });

  // Quay về desktop / xoay ngang thì trả trạng thái về bình thường
  window.addEventListener('resize', () => {
    if (!isSheetMode()) closeSheet();
  });
})();

/* ==========================================================================
   Biệt danh: hiện tên và cho đổi bằng một cú bấm
   ========================================================================== */
(function initNickname() {
  renderNickname();
  if (!els.nicknameBtn) return;

  els.nicknameBtn.addEventListener('click', () => {
    const current = getNickname();
    const input = window.prompt('Đổi biệt danh của bạn:', current);
    if (input === null) return; // bấm Huỷ
    const trimmed = String(input).trim();
    if (!trimmed) {
      // Bỏ trống thì bốc lại một cái ngẫu nhiên
      setNickname(generateNickname());
      return;
    }
    setNickname(trimmed);
  });
})();

/* ==========================================================================
   Áp dụng công tắc tính năng lên giao diện
   ========================================================================== */
(function applyFeatureFlags() {
  if (!FEATURES.chat) {
    const chatBox = document.querySelector('.chat-container');
    if (chatBox) chatBox.classList.add('hidden');
    if (els.chatBadge) els.chatBadge.classList.add('hidden');
    if (chatPollingInterval) {
      clearInterval(chatPollingInterval);
      chatPollingInterval = null;
    }
  }
})();
