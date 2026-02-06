from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os
import pdfplumber
import requests

# ---------------------------------------------------------
# 1. Environment & Configuration
# ---------------------------------------------------------
# We load the .env file to keep our API keys secure and out of the source code.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Safety first! If the API key is missing, the app shouldn't even start.
if not OPENROUTER_API_KEY:
    raise RuntimeError("OPENROUTER_API_KEY not found in .env file. Please check your configuration.")

# Initialize our FastAPI app
app = FastAPI()

# Configure CORS to allow our frontend to communicate with this backend.
# We're allowing local development origins (port 5500 is typical for Live Server).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import time
from fastapi import Request, HTTPException, Depends

# ---------------------------------------------------------
# 2. Storage & Helpers
# ---------------------------------------------------------
BASE_DIR = os.path.dirname(__file__)
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# In-memory storage for our sessions. Structure: {session_id: extracted_text_from_pdf}
# Note: For production, we'd probably use a proper database or Redis.
SESSIONS = {}

# Rate Limiting Storage
# Structure: {ip_address: {"count": int, "start_time": float}}
RATE_LIMITS = {}
RATE_LIMIT_DURATION = 300  # 5 minutes in seconds
MAX_REQUESTS = 5

def check_rate_limit(request: Request):
    """
    Checks if the client IP has exceeded the rate limit.
    """
    client_ip = request.client.host
    current_time = time.time()
    
    if client_ip not in RATE_LIMITS:
        RATE_LIMITS[client_ip] = {"count": 1, "start_time": current_time}
    else:
        # Check if the time window has passed
        if current_time - RATE_LIMITS[client_ip]["start_time"] > RATE_LIMIT_DURATION:
            # Reset
            RATE_LIMITS[client_ip] = {"count": 1, "start_time": current_time}
        else:
            # Increment
            RATE_LIMITS[client_ip]["count"] += 1
            if RATE_LIMITS[client_ip]["count"] > MAX_REQUESTS:
                raise HTTPException(status_code=429, detail="Rate limit exceeded")

def extract_text_from_pdf(pdf_file) -> str:
    """
    Takes a PDF file and rips out all the text content.
    We iterate through every page and combine them into one big string.
    """
    text = ""
    with pdfplumber.open(pdf_file) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    return text


# ---------------------------------------------------------
# 3. API Endpoints
# ---------------------------------------------------------

@app.get("/")
def root():
    """Simple health check to make sure the server is alive."""
    return {"status": "API is running"}

@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...), session_id: str = Form("default")):
    """
    Handles PDF uploads. We check the file type, extract the text, 
    and then store it in our 'SESSIONS' dictionary linked to a session ID.
    """
    if not file.filename.lower().endswith(".pdf"):
        return {"error": "Only PDF files are supported. Please upload a valid PDF."}

    # Extract text and store it in memory for the current session.
    text = extract_text_from_pdf(file.file)
    SESSIONS[session_id] = text 

    return {
        "message": "PDF uploaded and text stored successfully",
        "session_id": session_id,
        "text_length": len(text)
    }

@app.post("/restart")
async def restart_session(session_id: str = Form("default")):
    """
    Wipes the session data clean. Useful when the user wants to start a fresh chat
    without any context from the previous document.
    """
    if session_id in SESSIONS:
        del SESSIONS[session_id]
    return {"message": "Session restarted, document cleared"}

@app.post("/ask", dependencies=[Depends(check_rate_limit)])
async def ask_question(request: Request, question: str = Form(...), session_id: str = Form("default")):
    """
    This is the core logic. It takes a user's question, fetches the context
    from our stored PDF text, and sends it to OpenRouter (GPT-3.5) for a response.
    """
    if session_id not in SESSIONS or not SESSIONS[session_id]:
        return {"error": "I don't have any document context yet. Please upload a PDF first."}

    text = SESSIONS[session_id]

    # This prompt tells the AI exactly how to behave.
    # We want it to be an academic assistant that handles math and interactive quizzes.
    prompt = f"""
You are an expert academic assistant.
Answer strictly based on the provided document.

### CRITICAL INSTRUCTIONS:
1. **Math/Science**: Always use LaTeX for formulas (e.g., $$E=mc^2$$ or $x=2$).
2. **Interactive Quiz**: If the user asks for a quiz or MCQs, provide ONLY a brief introductory sentence, followed by a raw JSON block wrapped in [QUIZ_JSON] markers. 
   **DO NOT** list the questions or answers in plain text. The user will interact with them via buttons.
   JSON Format:
   [QUIZ_JSON] {{ "questions": [ {{ "q": "Question text?", "o": ["Option A", "Option B", "Option C", "Option D"], "a": index_of_correct_answer }} ] }} [/QUIZ_JSON]
3. **Summary**: If asked for a summary, provide a comprehensive breakdown using bullet points. At the very end, ask the user: "Would you like to test your knowledge with a quick practice quiz on this summary?". **Do not** generate the quiz until they say yes.

DOCUMENT CONTENT:
{text}

USER QUESTION:
{question}

Please provide a clear, exam-oriented response based on the document above.
"""

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Exmora"
    }

    # We're using GPT-3.5 Turbo via OpenRouter for cost-effective and fast responses.
    payload = {
        "model": "openai/gpt-3.5-turbo",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.3 # Lower temperature keeps the AI focused and less 'creative' with facts.
    }

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers=headers,
        json=payload,
        timeout=60
    )

    if response.status_code != 200:
        return {
            "error": "OpenRouter API error",
            "details": response.text
        }

    data = response.json()
    answer = data["choices"][0]["message"]["content"]

    return {
        "question": question,
        "answer": answer
    }
