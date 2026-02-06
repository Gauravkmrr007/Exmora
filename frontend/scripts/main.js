const fileInput = document.getElementById('file-input');
const uploadTrigger = document.getElementById('upload-trigger');
// const uploadText = document.getElementById('upload-text');
const loader = document.querySelector('.loader-mini');
const queryInput = document.getElementById('query-input');
const askBtn = document.getElementById('ask-btn');
const stopBtn = document.getElementById('stop-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const modalOverlay = document.getElementById('modal-overlay');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const chatHistory = document.querySelector('.chat-history');
const docInfoBadge = document.getElementById('doc-info');
const docNameEl = document.getElementById('doc-name');
const quizBtn = document.getElementById('quiz-btn');
const summarizeBtn = document.getElementById('summarize-btn');
const exportBtn = document.getElementById('export-btn');
const micBtn = document.getElementById('mic-btn');
const removeDocBtn = document.getElementById('remove-doc-btn');
const getStartedBtn = document.getElementById('get-started-btn');
const landingPage = document.getElementById('landing-page');
const mainApp = document.getElementById('main-app');
const legalCheckbox = document.getElementById('legal-checkbox');
const controlsRow = document.getElementById('controls-row');

// Helper to disable/enable input section
function updateInputState(isEnabled) {
    queryInput.disabled = !isEnabled;
    // We handle buttons separately now due to stop logic
    if (isEnabled) {
        askBtn.classList.remove('hidden');
        askBtn.disabled = false;
        if (stopBtn) stopBtn.classList.add('hidden');
    } else {
        // Disabled state generally means "loading" or "locked"
        // But for "loading", we want STOP button.
        // For "locked" (rate limit), we want DISABLED send button.
        // This helper is a bit too generic now, so we'll be careful.
        askBtn.disabled = true;
    }
    if (micBtn) micBtn.disabled = !isEnabled;
}

// Stop Button Logic
if (stopBtn) {
    stopBtn.addEventListener('click', () => {
        let stopped = false;

        // 1. Stop Fetching
        if (currentController) {
            currentController.abort();
            currentController = null;
            stopped = true;
        }

        // 2. Stop Typing
        if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
            stopped = true;
        }

        if (stopped) {
            // UI Feedback
            removeMessage(document.querySelector('.skeleton-loader')?.id);
            // We do NOT remove the partial message if it exists, matching standard AI behavior

            updateInputState(true);
            stopBtn.classList.add('hidden');
            askBtn.classList.remove('hidden');
        }
    });
}

// Rate Limit & Captcha Elements
const rateLimitModal = document.getElementById('rate-limit-modal');
const rateLimitTimer = document.getElementById('rate-limit-timer');
const captchaSection = document.getElementById('captcha-section');
const captchaQuestion = document.getElementById('captcha-question');
const captchaInput = document.getElementById('captcha-input');
const captchaSubmit = document.getElementById('captcha-submit');
const captchaError = document.getElementById('captcha-error');

let countdownInterval;
let currentCaptchaAnswer = 0;

// Check Rate Limit on Load
// Rate Limit check moved to Get Started or specific triggers
// const savedEndTime = localStorage.getItem('rateLimitEndTime');
// if (savedEndTime) { ... }

// State
let session_id = localStorage.getItem('ai_session_id') || 'session_' + Math.random().toString(36).substr(2, 9);
localStorage.setItem('ai_session_id', session_id);

let currentController = null; // To manage cancellation
let typingTimeout = null; // To manage typewriter cancellation

// Define welcomeInstruction but re-query it later to be safe
let welcomeInstruction = document.getElementById('welcome-instruction');

// const API_BASE = 'http://127.0.0.1:8000';
const API_BASE = 'https://exmora.onrender.com';

// Persistence logic
function saveChat() {
    const history = chatHistory.innerHTML;
    localStorage.setItem(`history_${session_id}`, history);
}

function loadChat() {
    const saved = localStorage.getItem(`history_${session_id}`);
    if (saved) {
        chatHistory.innerHTML = saved;
        // Re-render math and re-attach quiz listeners if any
        chatHistory.querySelectorAll('.message').forEach(m => renderMath(m));
        welcomeInstruction = document.getElementById('welcome-instruction');
    }
}

loadChat();

// Check if there's already a document active (if persistence includes that logic, 
// otherwise default to disabled on fresh load)
// For now, if chatHistory has content, maybe it's fine, but let's be strict.
// If there is a doc info visible, keep enabled.
if (!docInfoBadge || docInfoBadge.classList.contains('hidden')) {
    updateInputState(false);
} else {
    updateInputState(true);
}

// Landing Page Logic
if (getStartedBtn) {
    // Enable/disable the button based on the checkbox state
    if (legalCheckbox) {
        legalCheckbox.addEventListener('change', () => {
            getStartedBtn.disabled = !legalCheckbox.checked;
        });
    }

    // Fade the user from the landing page into the main app.
    getStartedBtn.addEventListener('click', () => {
        // Safety check to ensure the checkbox is actually checked
        if (legalCheckbox && !legalCheckbox.checked) return;

        landingPage.classList.add('hidden');
        mainApp.classList.remove('hidden');

        // Hide background orbs and footer for cleaner chat interface
        document.querySelectorAll('.bg-orb').forEach(orb => orb.style.display = 'none');
        const footer = document.querySelector('.app-footer');
        if (footer) footer.style.display = 'none';

        // Check for existing Rate Limit
        const savedEndTime = localStorage.getItem('rateLimitEndTime');
        if (savedEndTime) {
            const remainingTime = parseInt(savedEndTime) - Date.now();
            // If time remains OR time has passed (meaning captcha still needed)
            // we show the modal. We only clear it if captcha is solved.
            showRateLimitModal(parseInt(savedEndTime));
        }
    });
}

// Auto-resize textarea
queryInput.addEventListener('input', () => {
    queryInput.style.height = '36px';
    queryInput.style.height = (queryInput.scrollHeight) + 'px';
});

// Trigger file input on click
uploadTrigger.addEventListener('click', (e) => {
    if (e.target !== fileInput) {
        fileInput.click();
    }
});

// Welcome Upload Button - triggers file input
const welcomeUploadBtn = document.getElementById('welcome-upload-btn');
if (welcomeUploadBtn) {
    welcomeUploadBtn.addEventListener('click', () => {
        fileInput.click();
    });
}

// File Upload Logic
fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    // 2MB Limit
    if (file.size > 2 * 1024 * 1024) {
        alert("File too large! Max 2MB.");
        fileInput.value = '';
        return;
    }

    // UI State: Uploading
    // Toggle icon/loader inside button
    const btnIcon = uploadTrigger.querySelector('svg');
    if (btnIcon) btnIcon.classList.add('hidden');
    loader.classList.remove('hidden');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('session_id', session_id);

    try {
        const res = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.error) {
            if (btnIcon) btnIcon.classList.remove('hidden');
            loader.classList.add('hidden');
            alert(data.error);
        } else {
            // Success State
            loader.classList.add('hidden');
            if (btnIcon) btnIcon.classList.remove('hidden');

            // Show Controls Row
            const controlsRow = document.getElementById('controls-row');
            if (controlsRow) controlsRow.classList.remove('hidden');

            // Update welcome instruction
            welcomeInstruction = document.getElementById('welcome-instruction'); // Re-query

            if (welcomeInstruction) {
                welcomeInstruction.textContent = 'Document processed! Ask me anything about it.';
                welcomeInstruction.classList.add('text-success');
            }

            // Hide welcome upload button after successful upload
            if (welcomeUploadBtn) {
                welcomeUploadBtn.style.display = 'none';
            }

            // Show Doc Info & Quiz Button
            docNameEl.textContent = file.name;
            docInfoBadge.classList.remove('hidden');
            quizBtn.classList.remove('hidden');
            summarizeBtn.classList.remove('hidden');

            // Enable inputs
            updateInputState(true);
        }
    } catch (err) {
        console.error(err);
        loader.classList.add('hidden');
        uploadText.textContent = 'Upload error ❌';
        uploadText.classList.remove('hidden');
    }
});

// Ask Question Logic
// Ask Question Logic
askBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleAsk();
});
queryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAsk();
    }
});

// Quiz Mode Logic
quizBtn.addEventListener('click', () => {
    queryInput.value = "Generate a 5-question interactive quiz based on the key concepts of this document.";
    handleAsk();
});

summarizeBtn.addEventListener('click', () => {
    queryInput.value = "Please provide a comprehensive summary of this document, highlighting the main themes and key takeaways.";
    handleAsk();
});

// Voice Logic
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';

    micBtn.addEventListener('click', () => {
        if (micBtn.classList.contains('recording')) {
            recognition.stop();
        } else {
            recognition.start();
            micBtn.classList.add('recording');
        }
    });

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        queryInput.value = transcript;
        micBtn.classList.remove('recording');
        queryInput.style.height = '36px';
        queryInput.style.height = (queryInput.scrollHeight) + 'px';
    };

    recognition.onend = () => micBtn.classList.remove('recording');
    recognition.onerror = () => micBtn.classList.remove('recording');
} else {
    micBtn.style.display = 'none';
}

// Export Logic
exportBtn.addEventListener('click', () => {
    const texts = Array.from(chatHistory.querySelectorAll('.message'))
        .map(m => `[${m.classList.contains('user-message') ? 'USER' : 'AI'}]: ${m.innerText.trim()}`)
        .join('\n\n');
    const blob = new Blob([texts], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'study_chat.txt'; a.click();
});

// Remove Document Logic
removeDocBtn.addEventListener('click', async () => {
    // 1. Reset Backend Document Text (Optional but recommended)
    const formData = new FormData();
    formData.append('session_id', session_id);
    try {
        await fetch(`${API_BASE}/restart`, {
            method: 'POST',
            body: formData
        });
        // Note: Full restart clears history, but for "wrong pdf" case, 
        // user might want to keep chat? 
        // Actually the prompt says "delete that and when the user click on that x button the uploaded button should now change to upload"
        // I will just reset the document related UI

        fileInput.value = '';
        // Reset Button State
        const btnIcon = uploadTrigger.querySelector('svg');
        if (btnIcon) btnIcon.classList.remove('hidden');
        loader.classList.add('hidden');

        // Hide Controls Row
        const controlsRow = document.getElementById('controls-row');
        if (controlsRow) controlsRow.classList.add('hidden');

        docInfoBadge.classList.add('hidden');
        quizBtn.classList.add('hidden');
        summarizeBtn.classList.add('hidden');

        // Disable inputs
        updateInputState(false);

        // Update welcome message if still there
        const welcome = document.getElementById('welcome-instruction');
        if (welcome) {
            welcome.textContent = 'Document removed. Please upload another PDF.';
            welcome.classList.remove('text-success');
        }
    } catch (err) {
        console.error("Error removing document:", err);
    }
});

// New Chat Reset
newChatBtn.addEventListener('click', () => {
    modalOverlay.classList.remove('hidden');
});

modalCancel.addEventListener('click', () => {
    modalOverlay.classList.add('hidden');
});

modalConfirm.addEventListener('click', () => {
    modalOverlay.classList.add('hidden');
    resetChat();
});

// Close modal on overlay click (optional but nice)
modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
        modalOverlay.classList.add('hidden');
    }
});

async function resetChat() {
    const formData = new FormData();
    formData.append('session_id', session_id);

    try {
        // 1. Reset Backend
        await fetch(`${API_BASE}/restart`, {
            method: 'POST',
            body: formData
        });

        // 2. Clear UI Chat History
        chatHistory.innerHTML = `
            <div class="welcome-message">
                <h2>Hello! 👋</h2>
                <p id="welcome-instruction">Upload a PDF to get started or ask me anything.</p>
            </div>
        `;

        // 3. Reset Upload Button
        fileInput.value = '';
        const btnIcon = uploadTrigger.querySelector('svg');
        if (btnIcon) btnIcon.classList.remove('hidden');
        loader.classList.add('hidden');

        // Hide Controls Row
        const controlsRow = document.getElementById('controls-row');
        if (controlsRow) controlsRow.classList.add('hidden');

        // 4. Hide Doc Info & Quiz Btn
        docInfoBadge.classList.add('hidden');
        quizBtn.classList.add('hidden');
        summarizeBtn.classList.add('hidden');

        // Disable inputs
        updateInputState(false);

        // 5. Update welcome instruction ref
        welcomeInstruction = document.getElementById('welcome-instruction');

        // 6. Clear persistence
        localStorage.removeItem(`history_${session_id}`);

        // 7. Cycle Session ID for true fresh start
        session_id = 'session_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('ai_session_id', session_id);

    } catch (err) {
        console.error("Reset error:", err);
        alert("Failed to reset chat properly.");
    }
}

async function handleAsk() {
    const question = queryInput.value.trim();
    if (!question) return;

    // Add User Message
    addMessage('user', question);
    queryInput.value = '';
    queryInput.style.height = '36px'; // Reset height

    // Add Typing Indicator
    const typingId = addTypingIndicator();

    // 1. Restrict Input during AI generation
    // Manual toggle for button swap
    queryInput.disabled = true;
    askBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    if (micBtn) micBtn.disabled = true;

    // Create new abort controller
    currentController = new AbortController();
    const signal = currentController.signal;

    const formData = new FormData();
    formData.append('question', question);
    formData.append('session_id', session_id);

    try {
        const res = await fetch(`${API_BASE}/ask`, {
            method: 'POST',
            body: formData,
            signal: signal
        });

        if (res.status === 429) {
            // Rate Limit Hit!
            removeMessage(typingId);
            const endTime = Date.now() + 1 * 60 * 1000; // 1 Minute from now
            localStorage.setItem('rateLimitEndTime', endTime);

            addMessage('ai', '⚠️ You have reached your limit of asking questions. Please wait for 1 minute to continue.');

            showRateLimitModal(endTime);
            queryInput.placeholder = "Limit reached. Please wait 1 min.";

            // Revert buttons
            stopBtn.classList.add('hidden');
            askBtn.classList.remove('hidden');
            return;
        }

        const data = await res.json();

        // Remove typing indicator
        removeMessage(typingId);

        if (data.error) {
            addMessage('ai', `Error: ${data.error}`);
            updateInputState(true);
            // Revert buttons on error
            stopBtn.classList.add('hidden');
            askBtn.classList.remove('hidden');
        } else {
            // Success: Start typing
            // Do NOT hide stop button yet. It remains visible during typing.

            typeWriterEffect(data.answer, () => {
                // Completed normally
                updateInputState(true);
                stopBtn.classList.add('hidden');
                askBtn.classList.remove('hidden');
            });
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            console.log("Generation stopped by user.");
            // UI was already handled in stop click listener, but extra safety:
            removeMessage(typingId);
            updateInputState(true);
        } else {
            console.error(err);
            removeMessage(typingId);
            addMessage('ai', 'Sorry, I encountered a server error.');
            updateInputState(true);
        }
    } finally {
        currentController = null;
    }
}

// UI Helpers
function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}-message`;
    if (role === 'ai') {
        div.innerHTML = marked.parse(text);
    } else {
        div.textContent = text;
    }
    chatHistory.appendChild(div);
    renderMath(div);
    scrollToBottom();
    saveChat();
    return div;
}

function renderMath(element) {
    if (window.renderMathInElement) {
        window.renderMathInElement(element, {
            delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "$", right: "$", display: false }
            ],
            throwOnError: false
        });
    }
}

// Interactive Quiz Parser
function handleInteractiveQuiz(text, container) {
    const quizMatch = text.match(/\[QUIZ_JSON\]([\s\S]*?)\[\/QUIZ_JSON\]/);
    if (!quizMatch) return;

    try {
        const quizData = JSON.parse(quizMatch[1].trim());
        const totalQuestions = quizData.questions.length;
        let answeredQuestions = 0;
        let score = 0;

        const quizDiv = document.createElement('div');
        quizDiv.className = 'quiz-container';

        quizData.questions.forEach((q, idx) => {
            const card = document.createElement('div');
            card.className = 'quiz-card';
            card.innerHTML = `
                <div class="quiz-question">${idx + 1}. ${q.q}</div>
                <div class="quiz-options">
                    ${q.o.map((opt, oIdx) => `
                        <button class="option-btn" data-correct="${oIdx === q.a}">${opt}</button>
                    `).join('')}
                </div>
                <div class="quiz-feedback"></div>
            `;

            const options = card.querySelectorAll('.option-btn');
            options.forEach((btn) => {
                btn.onclick = () => {
                    if (card.classList.contains('answered')) return;
                    card.classList.add('answered');
                    answeredQuestions++;

                    const isCorrect = btn.getAttribute('data-correct') === 'true';
                    const feedback = card.querySelector('.quiz-feedback');

                    options.forEach(b => b.disabled = true);

                    if (isCorrect) {
                        score++;
                        btn.classList.add('correct');
                        feedback.textContent = "Correct! ✨";
                        feedback.style.color = "#00ff88";
                    } else {
                        btn.classList.add('wrong');
                        // Find the correct option button to highlight it
                        options.forEach(b => {
                            if (b.getAttribute('data-correct') === 'true') b.classList.add('correct');
                        });
                        feedback.textContent = `Oops! The correct answer was: ${q.o[q.a]}`;
                        feedback.style.color = "#ff4b2b";
                    }
                    feedback.classList.add('show');

                    // Check if all answered
                    if (answeredQuestions === totalQuestions) {
                        setTimeout(() => {
                            const resultDiv = document.createElement('div');
                            resultDiv.className = 'quiz-results';
                            resultDiv.innerHTML = `
                                <h3>Quiz Complete! 🏆</h3>
                                <p>You scored <strong>${score}</strong> out of <strong>${totalQuestions}</strong></p>
                                <p>${score === totalQuestions ? "Perfect score! You're a master! 🌟" : "Good effort! Keep studying! 📚"}</p>
                            `;
                            quizDiv.appendChild(resultDiv);
                            scrollToBottom();
                            saveChat(); // Save final state
                        }, 800);
                    } else {
                        saveChat();
                    }
                };
            });

            quizDiv.appendChild(card);
        });

        container.appendChild(quizDiv);
    } catch (e) {
        console.error("Quiz parsing failed:", e);
    }
}

function addTypingIndicator() {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.id = id;
    div.className = 'skeleton-loader';
    div.innerHTML = `
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
    `;
    chatHistory.appendChild(div);
    scrollToBottom();
    return id;
}

function removeMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function scrollToBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function typeWriterEffect(text, onComplete) {
    const div = document.createElement('div');
    div.className = 'message ai-message';
    chatHistory.appendChild(div);

    let i = 0;
    const speed = 10; // Faster speed for markdown
    let currentText = "";

    function type() {
        if (i < text.length) {
            currentText += text.charAt(i);

            // Cleanup: Don't show the raw JSON block in the UI
            let cleanDisplay = currentText.replace(/\[QUIZ_JSON\][\s\S]*$/, "");
            div.innerHTML = marked.parse(cleanDisplay);

            i++;
            scrollToBottom();
            typingTimeout = setTimeout(type, speed);
        } else {
            typingTimeout = null;
            renderMath(div);
            handleInteractiveQuiz(text, div);
            saveChat();
            if (onComplete) onComplete();
        }
    }
    type();
}

// ---------------------------------------------------------
// Rate Limiting & CAPTCHA Logic
// ---------------------------------------------------------

function showRateLimitModal(endTime) {
    if (rateLimitModal.classList.contains('hidden')) {
        rateLimitModal.classList.remove('hidden');
    }
    captchaSection.classList.add('hidden'); // Ensure hidden initially

    // Disable inputs behind modal purely for safety
    updateInputState(false);

    // Clear any existing interval
    if (countdownInterval) clearInterval(countdownInterval);

    // Initial check
    const now = Date.now();
    const diff = endTime - now;

    if (diff <= 0) {
        rateLimitTimer.textContent = "00:00";
        showCaptcha();
    } else {
        updateTimerDisplay(endTime);
        countdownInterval = setInterval(() => {
            const now = Date.now();
            const diff = endTime - now;

            if (diff <= 0) {
                clearInterval(countdownInterval);
                rateLimitTimer.textContent = "00:00";
                // Show Captcha
                showCaptcha();
            } else {
                updateTimerDisplay(endTime);
            }
        }, 1000);
    }
}

function updateTimerDisplay(endTime) {
    const diff = endTime - Date.now();
    if (diff < 0) return;

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    rateLimitTimer.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function showCaptcha() {
    // Generate simple math problem
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    currentCaptchaAnswer = a + b;

    captchaQuestion.textContent = `${a} + ${b} = ?`;
    captchaInput.value = '';
    captchaError.classList.add('hidden');
    captchaSection.classList.remove('hidden');
}

if (captchaSubmit) {
    captchaSubmit.addEventListener('click', () => {
        const userAnswer = parseInt(captchaInput.value);

        if (userAnswer === currentCaptchaAnswer) {
            // Correct!
            rateLimitModal.classList.add('hidden');
            localStorage.removeItem('rateLimitEndTime');
            updateInputState(true);
            queryInput.placeholder = "Ask a question...";
            // Optionally notify user
            // addMessage('ai', 'Access restored. You can continue studying! 🎓'); 
        } else {
            // Incorrect
            captchaError.textContent = "Incorrect, please try again.";
            captchaError.classList.remove('hidden');

            // Regenerate
            const a = Math.floor(Math.random() * 10) + 1;
            const b = Math.floor(Math.random() * 10) + 1;
            currentCaptchaAnswer = a + b;
            captchaQuestion.textContent = `${a} + ${b} = ?`;
            captchaInput.value = '';
        }
    });
}
