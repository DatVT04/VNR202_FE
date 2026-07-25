// neko.js - Quiznet Companion Mascot
// Inspired by Oneko / Felix desktop cat

(function () {
  // Respect user preference for reduced motion
  const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isReducedMotion) {
    window.neko = {
      toggle: () => { },
      triggerCorrect: () => { },
      triggerWrong: () => { },
      triggerChat: () => { },
      triggerStreak: () => { },
      showBubble: () => { },
    };
    return;
  }

  // Create the Neko element
  const nekoEl = document.createElement("div");
  nekoEl.id = "oneko";
  nekoEl.style.display = "none";
  document.body.appendChild(nekoEl);

  let isEnabled = true;
  localStorage.setItem("quiznet.neko.enabled", "true");

  let nekoPosX = window.innerWidth / 2;
  let nekoPosY = window.innerHeight / 2;
  let mousePosX = nekoPosX;
  let mousePosY = nekoPosY;

  // Set initial position to center to avoid flashing in the top-left corner
  nekoEl.style.left = `${nekoPosX - 16}px`;
  nekoEl.style.top = `${nekoPosY - 16}px`;

  let frameCount = 0;
  let idleTime = 0;
  let loopInterval = null;

  // New variables for Study Companion & Keyword minigame
  let activeStudyTimeSeconds = 0;
  let questionStartTime = null;
  let stuckTriggered = false;
  let hasPaper = false;
  let lastPaperCheckTime = Date.now();

  let clickQuoteIndex = 0;

  nekoEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!isEnabled) return;

    if (hasPaper) {
      hasPaper = false;
      const note = getRandomNote();
      if (note) {
        showBubble("Tuyệt vời meow! 🎉", 3000);
        showNoteModal(note);
      } else {
        showBubble("Ủa, giấy bay mất tiêu rồi meow... 🍃", 2500);
      }
    } else {
      // Normal click triggers a cute speech bubble / spin (sequential)
      const cuteQuotes = [
        "Meow~ Vuốt ve tớ à sen? 🥰",
        "Ngoan ngoan~ Học tiếp đi nha! 💕",
        "Meow! Đừng cù tớ mà! 😸",
        "Tớ vẫn đang theo dõi sen học đó nhé! 👀"
      ];
      const quote = cuteQuotes[clickQuoteIndex];
      clickQuoteIndex = (clickQuoteIndex + 1) % cuteQuotes.length;
      showBubble(quote, 2500);

      // Play short happy animation
      clearActionOverride();
      actionOverrideActive = true;
      let animFrame = 0;
      actionOverrideInterval = setInterval(() => {
        setSprite("scratchSelf", animFrame++);
      }, 70);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 1000);
    }
  });

  nekoEl.addEventListener("mouseenter", () => {
    if (!isEnabled) return;
    if (window.neko && typeof window.neko.triggerChat === "function") {
      window.neko.triggerChat();
    }
  });

  nekoEl.addEventListener("mouseleave", () => {
    if (!isEnabled) return;
    if (bubbleEl && bubbleEl.textContent === "Hóng chuyện meow~ 💬") {
      bubbleEl.remove();
      bubbleEl = null;
      clearTimeout(bubbleTimer);
    }
  });

  function getRandomNote() {
    if (!window.notesData || window.notesData.length === 0) return null;
    const allNotes = [];
    window.notesData.forEach(section => {
      const secTitle = section.title || "";
      if (section.items) {
        section.items.forEach(item => {
          const subTitle = item.title || "";
          if (item.notes) {
            item.notes.forEach(note => {
              allNotes.push({
                section: secTitle,
                subsection: subTitle,
                text: note
              });
            });
          }
          if (item.warning) {
            allNotes.push({
              section: secTitle,
              subsection: subTitle,
              text: `💡 Cảnh báo: ${item.warning}`
            });
          }
        });
      }
    });
    if (allNotes.length === 0) return null;
    return allNotes[Math.floor(Math.random() * allNotes.length)];
  }

  function showNoteModal(note) {
    const modal = document.createElement("div");
    modal.style.position = "fixed";
    modal.style.top = "0";
    modal.style.left = "0";
    modal.style.width = "100%";
    modal.style.height = "100%";
    modal.style.backgroundColor = "rgba(0,0,0,0.6)";
    modal.style.backdropFilter = "blur(6px)";
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "100000";
    modal.style.opacity = "0";
    modal.style.transition = "opacity 0.25s ease";

    const content = document.createElement("div");
    content.style.background = "linear-gradient(135deg, #f4ecd8 0%, #e2d2b3 100%)";
    content.style.color = "#3e2715";
    content.style.border = "2px solid #a38b68";
    content.style.outline = "1px dashed #6b573a";
    content.style.outlineOffset = "-6px";
    content.style.fontFamily = "'Georgia', serif";
    content.style.borderRadius = "12px";
    content.style.padding = "28px 24px 24px 24px";
    content.style.maxWidth = "450px";
    content.style.width = "90%";
    content.style.boxShadow = "0 15px 30px rgba(0,0,0,0.5), inset 0 0 40px rgba(139,115,85,0.3)";
    content.style.transform = "scale(0.9)";
    content.style.transition = "transform 0.25s ease";
    content.style.position = "relative";

    const title = document.createElement("h3");
    title.innerHTML = "📜 Mảnh giấy của Neko";
    title.style.marginTop = "0";
    title.style.marginBottom = "16px";
    title.style.color = "#80220a";
    title.style.display = "flex";
    title.style.alignItems = "center";
    title.style.justifyContent = "center";
    title.style.gap = "8px";
    title.style.borderBottom = "1px solid rgba(107, 87, 58, 0.2)";
    title.style.paddingBottom = "8px";

    const textBody = document.createElement("p");

    // Construct HTML content containing titles and text
    let formattedHtml = "";
    if (note.section) {
      formattedHtml += `<div style="font-size: 0.8rem; font-weight: bold; color: #80220a; text-transform: uppercase; margin-bottom: 4px; line-height: 1.3;">${note.section}</div>`;
    }
    if (note.subsection) {
      formattedHtml += `<div style="font-size: 0.85rem; font-weight: bold; color: #5c3a21; margin-bottom: 12px; border-bottom: 1px dashed rgba(107, 87, 58, 0.15); padding-bottom: 6px; line-height: 1.3;">${note.subsection}</div>`;
    }
    formattedHtml += `<div style="font-size: 0.95rem; color: #3e2715; line-height: 1.6; margin-top: 8px;">${note.text}</div>`;

    textBody.innerHTML = formattedHtml;
    textBody.style.margin = "0 0 20px 0";

    const btnOk = document.createElement("button");
    btnOk.textContent = "Đã nhớ meow!";
    btnOk.style.background = "#8a2512";
    btnOk.style.color = "#fff";
    btnOk.style.border = "1px solid #5c180b";
    btnOk.style.padding = "10px 16px";
    btnOk.style.borderRadius = "6px";
    btnOk.style.fontWeight = "bold";
    btnOk.style.cursor = "pointer";
    btnOk.style.width = "100%";
    btnOk.style.boxShadow = "0 3px 6px rgba(0,0,0,0.3)";
    btnOk.onclick = () => {
      modal.style.opacity = "0";
      content.style.transform = "scale(0.9)";
      setTimeout(() => modal.remove(), 250);
    };

    content.append(title, textBody, btnOk);
    modal.appendChild(content);
    document.body.appendChild(modal);

    setTimeout(() => {
      modal.style.opacity = "1";
      content.style.transform = "scale(1)";
    }, 10);
  }

  // Food variables
  let nekoTargetFood = null;

  // Bubble variables
  let bubbleEl = null;
  let bubbleTimer = null;

  // Animation override state for events (correct/incorrect answer reactions)
  let actionOverrideActive = false;
  let actionOverrideTimer = null;
  let actionOverrideInterval = null;

  const nekoSpeed = 12;

  // Idle speech options
  const idleQuotes = [
    "Meow~ Học bài thôi bạn ơi!",
    "Meow... Hôm nay học chăm thế!",
    "Đừng quên uống nước nhé! 💧",
    "Ngủ tí không sen ơi? 💤",
    "Cố lên! Bạn làm được mà!",
    "Meow...",
    "Có câu nào khó quá không? 🤔",
  ];

  // Sprite mapping grid coords for oneko.gif (multiplied by 32px)
  const spriteSets = {
    idle: [[-3, -3]],
    alert: [[-7, -3]],
    scratchSelf: [
      [-5, 0],
      [-6, 0],
      [-7, 0],
    ],
    scratchWallN: [
      [0, 0],
      [0, -1],
    ],
    scratchWallS: [
      [-7, -1],
      [-6, -2],
    ],
    scratchWallE: [
      [-2, -2],
      [-2, -3],
    ],
    scratchWallW: [
      [-4, 0],
      [-4, -1],
    ],
    tired: [[-3, -2]],
    sleeping: [
      [-2, 0],
      [-2, -1],
    ],
    N: [
      [-1, -2],
      [-1, -3],
    ],
    NE: [
      [0, -2],
      [0, -3],
    ],
    E: [
      [-3, 0],
      [-3, -1],
    ],
    SE: [
      [-5, -1],
      [-5, -2],
    ],
    S: [
      [-6, -3],
      [-7, -2],
    ],
    SW: [
      [-5, -3],
      [-6, -1],
    ],
    W: [
      [-4, -2],
      [-4, -3],
    ],
    NW: [
      [-1, 0],
      [-1, -1],
    ],
  };

  function setSprite(name, frame) {
    const set = spriteSets[name];
    if (!set) return;
    const sprite = set[frame % set.length];
    nekoEl.style.backgroundPosition = `${sprite[0] * 32}px ${sprite[1] * 32}px`;
  }

  function resetIdle() {
    idleTime = 0;
  }

  function clearActionOverride() {
    actionOverrideActive = false;
    if (actionOverrideTimer) {
      clearTimeout(actionOverrideTimer);
      actionOverrideTimer = null;
    }
    if (actionOverrideInterval) {
      clearInterval(actionOverrideInterval);
      actionOverrideInterval = null;
    }
  }

  function showBubble(text, duration = 3000) {
    if (!isEnabled) return;

    // Remove existing bubble
    if (bubbleEl) {
      bubbleEl.remove();
      bubbleEl = null;
    }
    clearTimeout(bubbleTimer);

    // Create new bubble
    bubbleEl = document.createElement("div");
    bubbleEl.className = "neko-bubble";
    bubbleEl.textContent = text;
    nekoEl.appendChild(bubbleEl);

    if (duration !== Infinity) {
      bubbleTimer = setTimeout(() => {
        if (bubbleEl) {
          bubbleEl.remove();
          bubbleEl = null;
        }
      }, duration);
    }
  }

  function updateNeko() {
    frameCount += 1;

    // Track active study duration
    if (!document.hidden && isEnabled) {
      activeStudyTimeSeconds += 0.08;

      // Pomodoro 25 min break reminder (1500 seconds)
      if (activeStudyTimeSeconds >= 1500) {
        activeStudyTimeSeconds = 0;
        showBubble("Sen ơi, học 25 phút rồi! Nghỉ ngơi 5 phút nhé 🐾", 6000);
        clearActionOverride();
        actionOverrideActive = true;
        setSprite("sleeping", 0);
        actionOverrideTimer = setTimeout(() => {
          clearActionOverride();
        }, 15000);
        return;
      }

      // Check paper spawning every 3 minutes (180 seconds)
      const now = Date.now();
      if (now - lastPaperCheckTime > 180000) {
        lastPaperCheckTime = now;
        if (!hasPaper) {
          hasPaper = true;
          showBubble("Sen ơi! Tớ tìm thấy một ghi chú nè! Click để mở nhé! 📜", 5000);
        }
      }

      // Stuck Helper check (> 45s on same question)
      if (questionStartTime && !stuckTriggered && Date.now() - questionStartTime > 45000) {
        stuckTriggered = true;
        showBubble("Câu này có vẻ khó meow...", 4000);
      }
    }

    // Handle temporary action overrides (e.g. happy/sad animations on answer)
    if (actionOverrideActive) {
      nekoEl.style.left = `${nekoPosX - 16}px`;
      nekoEl.style.top = `${nekoPosY - 16}px`;
      return;
    }

    // Determine target (food has higher priority than mouse)
    let targetX = mousePosX;
    let targetY = mousePosY;
    let isChasingFood = false;

    if (nekoTargetFood && document.body.contains(nekoTargetFood.element)) {
      targetX = nekoTargetFood.x;
      targetY = nekoTargetFood.y;
      isChasingFood = true;
    }

    const diffX = nekoPosX - targetX;
    const diffY = nekoPosY - targetY;
    const distance = Math.sqrt(diffX * diffX + diffY * diffY);

    // Handle food collision
    if (isChasingFood && distance < 24) {
      const foodEmoji = nekoTargetFood.element.textContent;
      nekoTargetFood.element.remove();
      nekoTargetFood = null;
      resetIdle();
      showBubble(`Măm măm~ ${foodEmoji}`, 2500);

      // Play correct answer celebration animation briefly
      clearActionOverride();
      actionOverrideActive = true;
      let animFrame = 0;
      actionOverrideInterval = setInterval(() => {
        setSprite("scratchSelf", animFrame++);
      }, 60);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 1500);
      return;
    }

    // If target is close enough, start idling/sleeping
    if (!isChasingFood && (distance < nekoSpeed || distance < 48)) {
      idleTime += 1;

      // Occasional random meowing when idle
      if (idleTime > 0 && idleTime % 250 === 0 && Math.random() < 0.4) {
        const hour = new Date().getHours();
        const isNight = hour >= 22 || hour < 6;
        let quote;
        if (hasPaper) {
          quote = "Sen ơi! Tớ tìm thấy một ghi chú nè! Click để mở nhé! 📜";
        } else if (isNight) {
          const nightQuotes = [
            "Muộn rồi sen ơi, học nốt câu này rồi đi ngủ nhé~ 🌙",
            "Buồn ngủ chưa sen? Oáp... 💤",
            "Học khuya thế sen! Nhớ giữ gìn sức khỏe nha. ❤️",
            "Meow... Ngủ sớm đi sen ơi, mai học tiếp.",
          ];
          quote = nightQuotes[Math.floor(Math.random() * nightQuotes.length)];
        } else {
          quote = idleQuotes[Math.floor(Math.random() * idleQuotes.length)];
        }
        showBubble(quote, 3000);
      }

      // Transition stages of idling:
      if (idleTime > 120) {
        setSprite("sleeping", Math.floor(frameCount / 8));
      } else if (idleTime > 90) {
        setSprite("tired", 0);
      } else if (idleTime > 50) {
        setSprite("scratchSelf", Math.floor(frameCount / 4));
      } else if (idleTime > 20) {
        setSprite("alert", 0);
      } else {
        setSprite("idle", 0);
      }
      return;
    }

    resetIdle();

    // Calculate directions
    let direction = "";
    if (diffY / distance < -0.5) {
      direction += "N";
    } else if (diffY / distance > 0.5) {
      direction += "S";
    }

    if (diffX / distance < -0.5) {
      direction += "E";
    } else if (diffX / distance > 0.5) {
      direction += "W";
    }

    // Move Neko towards target
    nekoPosX -= (diffX / distance) * nekoSpeed;
    nekoPosY -= (diffY / distance) * nekoSpeed;

    // Boundary constraints
    nekoPosX = Math.max(16, Math.min(window.innerWidth - 16, nekoPosX));
    nekoPosY = Math.max(16, Math.min(window.innerHeight - 16, nekoPosY));

    // Update sprite based on move direction
    setSprite(direction, Math.floor(frameCount / 4));

    nekoEl.style.left = `${nekoPosX - 16}px`;
    nekoEl.style.top = `${nekoPosY - 16}px`;
  }

  // Update target position on click instead of mousemove
  window.addEventListener("click", (event) => {
    const tag = event.target.tagName.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "button" ||
      tag === "a" ||
      tag === "select" ||
      event.target.closest("button") ||
      event.target.closest("a") ||
      event.target.closest(".chat-container")
    ) {
      return;
    }
    mousePosX = event.clientX;
    mousePosY = event.clientY;
  });

  function spawnFood(clickX, clickY) {
    if (nekoTargetFood) {
      nekoTargetFood.element.remove();
    }

    const foods = ["🐟", "🐠", "🐙", "🍤", "🥛", "🐭"];
    const randomFood = foods[Math.floor(Math.random() * foods.length)];

    const foodEl = document.createElement("span");
    foodEl.className = "neko-food";
    foodEl.textContent = randomFood;
    foodEl.style.left = `${clickX - 12}px`;
    foodEl.style.top = `${clickY - 12}px`;
    document.body.appendChild(foodEl);

    nekoTargetFood = {
      x: clickX,
      y: clickY,
      element: foodEl
    };

    resetIdle();
    showBubble(`A! Có ${randomFood} kìa! 💨`, 3000);
  }

  // Food Spawner on Double Click (Desktop)
  window.addEventListener("dblclick", (event) => {
    if (!isEnabled) return;

    // Prevent spawning food when double clicking on inputs/buttons/interactive zones
    const tag = event.target.tagName.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "button" ||
      tag === "a" ||
      tag === "select" ||
      event.target.closest("button") ||
      event.target.closest("a") ||
      event.target.closest(".chat-container")
    ) {
      return;
    }

    spawnFood(event.clientX, event.clientY);
  });

  // Food Spawner on Double Tap (Mobile)
  let lastTapTime = 0;
  window.addEventListener("touchend", (event) => {
    if (!isEnabled) return;

    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTapTime;

    if (tapLength < 300 && tapLength > 0) {
      const touch = event.changedTouches[0];
      const clickX = touch.clientX;
      const clickY = touch.clientY;

      const target = document.elementFromPoint(clickX, clickY);
      if (!target) return;
      const tag = target.tagName.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "button" ||
        tag === "a" ||
        tag === "select" ||
        target.closest("button") ||
        target.closest("a") ||
        target.closest(".chat-container")
      ) {
        return;
      }

      event.preventDefault(); // Prevent default zoom on double tap
      spawnFood(clickX, clickY);
    }
    lastTapTime = currentTime;
  });

  // Export functions to trigger specific responses
  window.neko = {
    toggle: function (force) {
      isEnabled = force !== undefined ? force : !isEnabled;
      localStorage.setItem("quiznet.neko.enabled", isEnabled);
      if (isEnabled) {
        nekoEl.style.display = "block";
        resetIdle();
        if (!loopInterval) {
          loopInterval = setInterval(updateNeko, 80);
        }
        showBubble("Xin chào sen! 🐾", 3000);
      } else {
        nekoEl.style.display = "none";
        if (nekoTargetFood) {
          nekoTargetFood.element.remove();
          nekoTargetFood = null;
        }
        if (bubbleEl) {
          bubbleEl.remove();
          bubbleEl = null;
        }
        if (loopInterval) {
          clearInterval(loopInterval);
          loopInterval = null;
        }
        clearActionOverride();
      }
      return isEnabled;
    },

    triggerCorrect: function () {
      if (!isEnabled || isReducedMotion) return;
      clearActionOverride();
      actionOverrideActive = true;
      resetIdle();

      const quotes = ["Đúng rồi! 🎉", "Giỏi quá ta!", "Meow! Quá xuất sắc! 🥳"];
      showBubble(quotes[Math.floor(Math.random() * quotes.length)], 3000);

      // Play a fast scratch / celebrate animation
      let animFrame = 0;
      actionOverrideInterval = setInterval(() => {
        setSprite("scratchSelf", animFrame++);
      }, 60);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 1500);
    },

    triggerWrong: function () {
      if (!isEnabled || isReducedMotion) return;
      clearActionOverride();
      actionOverrideActive = true;
      resetIdle();

      const quotes = ["Sai mất rồi... 😿", "Cố lên câu sau nhé!", "Không sao đâu sen! 💕"];
      showBubble(quotes[Math.floor(Math.random() * quotes.length)], 3000);

      // Instantly collapse/tired animation
      setSprite("tired", 0);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 1500);
    },

    triggerChat: function () {
      if (!isEnabled || isReducedMotion) return;
      clearActionOverride();
      actionOverrideActive = true;
      resetIdle();

      showBubble("Hóng chuyện meow~ 💬", Infinity);
      setSprite("alert", 0);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 800);
    },

    triggerStreak: function (count) {
      if (!isEnabled || isReducedMotion) return;
      clearActionOverride();
      actionOverrideActive = true;
      resetIdle();

      showBubble(`🔥 Chuỗi ${count} câu đúng liên tiếp!`, 3000);

      let animFrame = 0;
      actionOverrideInterval = setInterval(() => {
        setSprite("scratchSelf", animFrame++);
      }, 50);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 2000);
    },

    onQuestionStart: function () {
      questionStartTime = Date.now();
      stuckTriggered = false;
    },

    onQuestionAnswered: function () {
      questionStartTime = null;
    },

    triggerComfort: function () {
      if (!isEnabled || isReducedMotion) return;
      clearActionOverride();
      actionOverrideActive = true;
      resetIdle();

      const comfortQuotes = [
        "Thương thương sen 💕",
        "Đừng nản nha sen, có tớ bên cạnh rồi! 🐾",
        "Meow~ Khó quá thì bỏ qua đi uống nước nghỉ tí sen ơi!",
        "Dù đúng hay sai, sen vẫn đỉnh nhất meow!"
      ];
      showBubble(comfortQuotes[Math.floor(Math.random() * comfortQuotes.length)], 3000);

      let animFrame = 0;
      actionOverrideInterval = setInterval(() => {
        setSprite("scratchSelf", animFrame++);
      }, 70);

      actionOverrideTimer = setTimeout(() => {
        clearActionOverride();
      }, 2000);
    },

    showBubble: showBubble,

    isEnabled: function () {
      return isEnabled;
    },

    // Set enabled state from external sync (no server call, no toggle)
    setEnabled: function (enabled) {
      if (isEnabled === enabled) return; // No change
      isEnabled = enabled;
      localStorage.setItem("quiznet.neko.enabled", isEnabled);
      if (isEnabled) {
        nekoEl.style.display = "block";
        resetIdle();
        if (!loopInterval) {
          loopInterval = setInterval(updateNeko, 80);
        }
      } else {
        nekoEl.style.display = "none";
        if (nekoTargetFood) {
          nekoTargetFood.element.remove();
          nekoTargetFood = null;
        }
        if (bubbleEl) {
          bubbleEl.remove();
          bubbleEl = null;
        }
        if (loopInterval) {
          clearInterval(loopInterval);
          loopInterval = null;
        }
        clearActionOverride();
      }
    }
  };

  // Auto-init on load if enabled
  if (isEnabled) {
    nekoEl.style.display = "block";
    loopInterval = setInterval(updateNeko, 80);
    showBubble("Xin chào sen! 🐾", 3000);
  }
})();
