from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os
import pdfplumber
import requests

# ---------------------------------------------------------
# setup things
# loading env vars for api security
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# check if api key is there or bail out
if not OPENROUTER_API_KEY:
    raise RuntimeError("OPENROUTER_API_KEY not found in .env file. Please check your configuration.")

# fast api init
app = FastAPI()

# cors setup to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import time
from fastapi import Request, HTTPException, Depends

# helpers & data storage
BASE_DIR = os.path.dirname(__file__)
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# simple session storage. {session_id: pdf_text}
# maybe use redis or db for prod later
SESSIONS = {}

# tracking rate limits per user/ip
RATE_LIMITS = {}
RATE_LIMIT_DURATION = 300  # 5 min window
MAX_REQUESTS = 5

def check_rate_limit(request: Request):
    """check if ip hit the limit"""
    client_ip = request.client.host
    # render/proxies use x-forwarded-for for real ip
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        # first one is the original client ip
        client_ip = forwarded_for.split(",")[0].strip()
    elif request.headers.get("X-Real-IP"):
         client_ip = request.headers.get("X-Real-IP")

    current_time = time.time()
    
    if client_ip not in RATE_LIMITS:
        RATE_LIMITS[client_ip] = {"count": 1, "start_time": current_time}
        return

    # check if time window reset is needed
    if current_time - RATE_LIMITS[client_ip]["start_time"] > RATE_LIMIT_DURATION:
        # reset the counter
        RATE_LIMITS[client_ip] = {"count": 1, "start_time": current_time}
    else:
        # bump the count
        RATE_LIMITS[client_ip]["count"] += 1
        if RATE_LIMITS[client_ip]["count"] > MAX_REQUESTS:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

def extract_text_from_pdf(pdf_file) -> str:
    """grab all text from the pdf pages"""
    text = ""
    with pdfplumber.open(pdf_file) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    return text


# api endpoints

@app.get("/")
def root():
    """health check route"""
    return {"status": "API is running"}

@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...), session_id: str = Form("default")):
    """handle file uploads, extract text, and save to session"""
    if not file.filename.lower().endswith(".pdf"):
        return {"error": "Only PDF files are supported. Please upload a valid PDF."}

    # extract and save text in memory
    text = extract_text_from_pdf(file.file)
    SESSIONS[session_id] = text 

    return {
        "message": "PDF uploaded and text stored successfully",
        "session_id": session_id,
        "text_length": len(text)
    }

@app.post("/restart")
async def restart_session(session_id: str = Form("default")):
    """clear the session data for a fresh start"""
    if session_id in SESSIONS:
        del SESSIONS[session_id]
    return {"message": "Session restarted, document cleared"}

@app.post("/ask", dependencies=[Depends(check_rate_limit)])
async def ask_question(request: Request, question: str = Form(...), session_id: str = Form("default")):
    """ask questions about the pdf using openrouter (gpt-3.5)"""
    if session_id not in SESSIONS or not SESSIONS[session_id]:
        return {"error": "I don't have any document context yet. Please upload a PDF first."}

    text = SESSIONS[session_id]

    # prompt for ai behavior (math, quizzes, etc)
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

    # using gpt-3.5 turbo because it's fast and cheap
    payload = {
        "model": "openai/gpt-3.5-turbo",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.3 # keep it focused and low creativity
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
