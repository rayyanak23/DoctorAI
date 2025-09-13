require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const fs = require('fs');

// ==== Gemini LLM API setup ====
const { GoogleGenerativeAI } = require("@google/generative-ai");
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==== Twilio WhatsApp setup ====
const twilio = require('twilio')(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
app.use(express.json());

// --- SQLite DB Setup ---
const db = new sqlite3.Database('./patients.sqlite', (err) => {
    if (err) {
        console.error(err.message);
    }
});

db.run(`CREATE TABLE IF NOT EXISTS patient_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    demographics TEXT,
    symptoms TEXT,
    responses_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`);

// --- Load symptom rules from JSON ---
const symptomRules = JSON.parse(fs.readFileSync('./Datasetab94d2b.json', 'utf8'));

// ---- Routes/APIs ----

// Get full list of symptoms (for frontend dropdown)
app.get('/symptoms', (req, res) => {
    res.json(symptomRules.map(s => s.symptom));
});

app.post('/start-session', async (req, res) => {
    // Use Gemini to phrase greeting and first questions
    const userMsg = req.body.message || "The patient has started the chat. Ask for demographic details.";
    const systemPrompt = "You are a medical chatbot assistant for a heart clinic. Greet the patient warmly (do NOT provide any medical advice), then politely ask their name, email, gender, and age. Do not say anything about symptoms yet.";
    const geminiRes = await gemini
        .getGenerativeModel({ model: "gemini-1.5-flash"})
        .generateContent([systemPrompt, userMsg])
        .catch(() => ({ response: { text: "Welcome! What is your name? What is your email, gender, and age?" } }));

    res.json({
        questions: [
            { key: "llmGreeting", prompt: geminiRes?.response?.text?.trim() || "Welcome! What is your name? Email, gender, age?" }
        ]
    });
});

// Generate followup form by rules & LLM instructions
app.post('/get-followup-form', async (req, res) => {
    const { demographics, symptoms } = req.body;

    let fullQuestions = [];
    let questionsText = "";

    symptoms.forEach(symptomText => {
        const rule = symptomRules.find(s => s.symptom === symptomText);
        if (rule) {
            for (const [section, questions] of Object.entries(rule.follow_up_questions)) {
                fullQuestions.push({ section, questions });
                questionsText += `\n\n${section}:\n` + questions.map(q => "- "+q).join("\n");
            }
        }
    });

    // LLM intro/explanation for the generated form
    const systemPrompt = `You are an assistant talking to a cardiology patient. Gently explain that you'll ask a few questions about their symptoms, assure them this is routine, and guide them through. Do not invent new questions, only provide this reassurance and explain the sections.`;

    const geminiRes = await gemini
        .getGenerativeModel({ model: "gemini-1.5-flash"})
        .generateContent([systemPrompt, questionsText])
        .catch(() => ({ response: { text: "" } }));

    res.json({
        llmIntro: geminiRes?.response?.text?.trim() || "",
        demographics,
        symptoms,
        follow_up: fullQuestions
    });
});

// Final submission: store, notify via Telegram & WhatsApp
app.post('/submit-form', async (req, res) => {
    const { name, email, demographics, symptoms, responses } = req.body;

    db.run(
        `INSERT INTO patient_intake (name, email, demographics, symptoms, responses_json)
         VALUES (?, ?, ?, ?, ?)`,
        [name, email, JSON.stringify(demographics), symptoms.join(','), JSON.stringify(responses)],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            // Prepare notification text
            const messageBody = `New Cardiology Intake:\nName: ${name}\nEmail: ${email}\nDemographics: ${JSON.stringify(demographics)}\nSymptoms: ${symptoms.join(', ')}\nResponses: ${JSON.stringify(responses, null, 2)}`;
            // --- Telegram Bot API ---
            axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: messageBody
            }).catch(() => {});

            // --- WhatsApp via Twilio ---
            twilio.messages.create({
                body: messageBody.substring(0, 1500), // WhatsApp message length
                from: process.env.TWILIO_WHATSAPP_FROM,
                to: process.env.DOCTOR_PHONE_NUMBER
            }).catch(() => {});
            
            // --- [Google Calendar: Pseudo code, see README for real implementation] ---
            // createGoogleCalendarEvent(name, email, process.env.DOCTOR_EMAIL, ...otherDetails);

            res.json({ success: true, msg: "Form submitted and doctor notified via Telegram and WhatsApp." });
        }
    );
});

// ---- Optional: Real-time Conversational WebSocket (for chat demonstration) ----
io.on('connection', (socket) => {
    socket.on('message', async (msg) => {
        // Forward all patient chat to Gemini, except for medical question rounds
        const systemPrompt = "You are a friendly medical chat assistant for a cardiology clinic. Never make up medical questions; only use casual conversation or clarifications between intake steps.";
        const geminiRes = await gemini
            .getGenerativeModel({ model: "gemini-1.5-flash"})
            .generateContent([systemPrompt, msg])
            .catch(() => ({ response: { text: "Thank you! Let's proceed." } }));

        socket.emit('bot_message', geminiRes?.response?.text || "Thank you! Let's proceed.");
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
