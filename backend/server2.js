require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');

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

// --- Middleware ---
app.use(express.json());
app.use(cors());

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
    symptoms TEXT,
    responses_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`);

// --- Load symptom rules from JSON ---
const symptomRules = JSON.parse(fs.readFileSync('./Datasetab94d2b.json', 'utf8'));

// ---- Routes/APIs ----

// Get full list of symptoms
app.get('/symptoms', (req, res) => {
    res.json(symptomRules.map(s => s.symptom));
});

// Start-session endpoint
app.post('/start-session', async (req, res) => {
    const userMsg = req.body?.message || "The patient has started the chat.";
    const systemPrompt = "You are a medical chatbot assistant for a heart clinic. Greet the patient warmly, then politely ask for their full name and email address. Do not ask about symptoms yet.";
    
    try {
        const geminiRes = await gemini
            .getGenerativeModel({ model: "gemini-1.5-flash"})
            .generateContent([systemPrompt, userMsg]);

        res.json({
            greeting: geminiRes?.response?.text()?.trim() || "Welcome! To get started, please provide your full name and email address."
        });
    } catch (error) {
        console.error("Gemini API call failed:", error);
        res.status(500).json({ 
            greeting: "Welcome to the Cardiology Clinic assistant. To get started, please provide your full name and email address." 
        });
    }
});

// --- NEW (IMPROVED): Generate de-duplicated followup form ---
app.post('/get-followup-form', async (req, res) => {
    const { symptoms } = req.body;

    if (!symptoms || !Array.isArray(symptoms) || symptoms.length === 0) {
        return res.status(400).json({ error: "Symptoms must be a non-empty array." });
    }

    const categorizedQuestions = {};
    let allQuestionsTextForPrompt = "";

    symptoms.forEach(symptomText => {
        const rule = symptomRules.find(s => s.symptom === symptomText);
        if (rule) {
            for (const [section, questions] of Object.entries(rule.follow_up_questions)) {
                if (!categorizedQuestions[section]) {
                    categorizedQuestions[section] = new Set();
                }
                questions.forEach(q => categorizedQuestions[section].add(q));
            }
        }
    });

    const fullQuestions = Object.entries(categorizedQuestions).map(([section, questionSet]) => {
        const questions = Array.from(questionSet);
        allQuestionsTextForPrompt += `\n\n${section}:\n` + questions.map(q => "- " + q).join("\n");
        return { section, questions };
    });

    const systemPrompt = `You are an assistant talking to a cardiology patient. Gently explain that you'll ask a few questions about their symptoms, assure them this is routine, and guide them through. Do not invent new questions, only provide this reassurance and explain the sections.`;

    try {
        const geminiRes = await gemini
            .getGenerativeModel({ model: "gemini-1.5-flash" })
            .generateContent([systemPrompt, allQuestionsTextForPrompt]);

        res.json({
            llmIntro: geminiRes?.response?.text()?.trim() || "Thank you. Now, please answer the following questions regarding your symptoms.",
            symptoms,
            follow_up: fullQuestions
        });
    } catch (error) {
        console.error("Gemini API call for followup failed:", error);
        res.status(500).json({ error: "Failed to generate follow-up introduction." });
    }
});

// Final submission: store data and send notifications
app.post('/submit-form', async (req, res) => {
    const { name, email, symptoms, responses } = req.body;

    // --- NEW: Handle empty answers ---
    for (const question in responses) {
        if (responses[question] === '' || responses[question] === null) {
            responses[question] = 'Not Answered';
        }
    }

    db.run(
        `INSERT INTO patient_intake (name, email, symptoms, responses_json) VALUES (?, ?, ?, ?)`,
        [name, email, symptoms.join(','), JSON.stringify(responses)],
        function (err) {
            if (err) {
                console.error("Database insertion error:", err.message);
                return res.status(500).json({ error: err.message });
            }
            
            // --- Formatted Telegram Notification ---
            let responsesText = '';
            for (const [question, answer] of Object.entries(responses)) {
                const safeAnswer = (answer).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
                responsesText += `<b>${question}</b>\n${safeAnswer}\n\n`;
            }

            const telegramMessage = `
<b>New Cardiology Intake</b>
--------------------------------------
<b>Patient Details</b>
<b>Name:</b> ${name}
<b>Email:</b> ${email}

<b>Symptoms</b>
- ${symptoms.join(', ')}
--------------------------------------
<b>Follow-up Responses</b>

${responsesText}
`;
            
            axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: telegramMessage,
                parse_mode: 'HTML'
            }).catch(err => console.error("Telegram notification failed:", err.message));

            // --- WhatsApp via Twilio ---
            const plainTextMessage = `New Cardiology Intake:\n\nName: ${name}\nEmail: ${email}\n\nSymptoms: ${symptoms.join(', ')}\n\nResponses: ${JSON.stringify(responses, null, 2)}`;
            twilio.messages.create({
                body: plainTextMessage.substring(0, 1600),
                from: process.env.TWILIO_WHATSAPP_FROM,
                to: process.env.DOCTOR_PHONE_NUMBER
            }).catch(err => console.error("Twilio notification failed:", err.message));
            
            res.json({ success: true, msg: "Form submitted and doctor notified." });
        }
    );
});

// ---- Real-time Conversational WebSocket ----
io.on('connection', (socket) => {
    socket.on('message', async (msg) => {
        const systemPrompt = "You are a friendly medical chat assistant for a cardiology clinic. Never make up medical questions; only use casual conversation or clarifications between intake steps.";
        try {
            const geminiRes = await gemini
                .getGenerativeModel({ model: "gemini-1.5-flash"})
                .generateContent([systemPrompt, msg]);
            socket.emit('bot_message', geminiRes?.response?.text() || "Thank you! Let's proceed.");
        } catch (error) {
            console.error("Gemini WebSocket response failed:", error);
            socket.emit('bot_message', "Thank you! Let's proceed.");
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));