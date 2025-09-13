// ChatComponent.js

import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import io from 'socket.io-client';
import './ChatComponent.css';

const BACKEND_URL = 'http://localhost:3001';
const socket = io(BACKEND_URL);

const ChatComponent = () => {
    // MODIFIED: Added state for name and email, and a new step 'collect_details'
    const [step, setStep] = useState('loading'); // loading, collect_details, symptom_selection, follow_up, submitted
    const [messages, setMessages] = useState([]);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [symptomList, setSymptomList] = useState([]);
    const [selectedSymptoms, setSelectedSymptoms] = useState([]);
    const [followUpForm, setFollowUpForm] = useState(null);
    const [responses, setResponses] = useState({});
    const chatEndRef = useRef(null);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        const startChat = async () => {
            try {
                const sessionRes = await axios.post(`${BACKEND_URL}/start-session`, {});
                addBotMessage(sessionRes.data.greeting);

                const symptomsRes = await axios.get(`${BACKEND_URL}/symptoms`);
                setSymptomList(symptomsRes.data);
                
                // MODIFIED: Change to the new details collection step
                setStep('collect_details');

            } catch (error) {
                addBotMessage("Sorry, I'm having trouble connecting. Please try again later.");
                console.error("Initialization failed:", error);
            }
        };

        startChat();
    }, []);

    const addBotMessage = (text) => {
        setMessages(prev => [...prev, { from: 'bot', text }]);
    };
    
    // NEW: Function to handle submission of name and email
    const handleDetailsSubmit = (e) => {
        e.preventDefault();
        if (!name || !email) {
            addBotMessage("Please provide both your name and email to continue.");
            return;
        }
        setMessages(prev => [...prev, { from: 'user', text: `Name: ${name}, Email: ${email}` }]);
        addBotMessage("Thank you. Please select your primary symptoms from the list below.");
        setStep('symptom_selection');
    };

    const handleSymptomSelect = (symptom) => {
        setSelectedSymptoms(prev => 
            prev.includes(symptom) ? prev.filter(s => s !== symptom) : [...prev, symptom]
        );
    };

    const handleSymptomSubmit = async () => {
        if (selectedSymptoms.length === 0) {
            addBotMessage("Please select at least one symptom.");
            return;
        }

        setMessages(prev => [...prev, { from: 'user', text: `Selected: ${selectedSymptoms.join(', ')}` }]);
        setStep('loading');

        try {
            const res = await axios.post(`${BACKEND_URL}/get-followup-form`, { symptoms: selectedSymptoms });
            if (res.data.llmIntro) {
                addBotMessage(res.data.llmIntro);
            }
            setFollowUpForm(res.data);
            const initialResponses = {};
            res.data.follow_up.forEach(section => {
                section.questions.forEach(q => {
                    initialResponses[q] = "";
                });
            });
            setResponses(initialResponses);
            setStep('follow_up');
        } catch (error) {
            addBotMessage("There was an error generating the follow-up questions.");
            setStep('symptom_selection');
        }
    };
    
    const handleResponseChange = (question, answer) => {
        setResponses(prev => ({ ...prev, [question]: answer }));
    };

    const handleFinalSubmit = async () => {
        setStep('loading');
        addBotMessage("Thank you. Submitting your responses now...");
        try {
            // MODIFIED: Send name and email along with other data
            await axios.post(`${BACKEND_URL}/submit-form`, {
                name,
                email,
                symptoms: selectedSymptoms,
                responses: responses
            });
            addBotMessage("Your information has been securely sent to the clinic. They will reach out to you shortly. Thank you for using our assistant.");
            setStep('submitted');
        } catch (error) {
            addBotMessage("We encountered an error while submitting your form. Please try again.");
            setStep('follow_up');
        }
    };

    return (
        <div className="chat-container">
            <div className="chat-header">Cardiology AI Assistant</div>
            <div className="chat-messages">
                {messages.map((msg, index) => (
                    <div key={index} className={`message ${msg.from}`}>
                        {msg.text}
                    </div>
                ))}
                <div ref={chatEndRef} />
            </div>
            <div className="chat-input-area">
                {step === 'loading' && <div className="loading-spinner"></div>}

                {/* NEW: Form for collecting name and email */}
                {step === 'collect_details' && (
                    <form className="form-container" onSubmit={handleDetailsSubmit}>
                         <div className="input-group">
                            <label>Full Name</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g., John Doe"
                                required
                            />
                        </div>
                        <div className="input-group">
                            <label>Email Address</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="e.g., john.doe@example.com"
                                required
                            />
                        </div>
                        <button className="submit-button" type="submit">Continue</button>
                    </form>
                )}

                {step === 'symptom_selection' && (
                    <div className="form-container">
                        <div className="symptom-selector">
                            {symptomList.map(symptom => (
                                <button
                                    key={symptom}
                                    className={`symptom-chip ${selectedSymptoms.includes(symptom) ? 'selected' : ''}`}
                                    onClick={() => handleSymptomSelect(symptom)}
                                >
                                    {symptom}
                                </button>
                            ))}
                        </div>
                        <button className="submit-button" onClick={handleSymptomSubmit} disabled={selectedSymptoms.length === 0}>
                            Confirm Symptoms
                        </button>
                    </div>
                )}

                {step === 'follow_up' && followUpForm && (
                     <div className="form-container">
                        {followUpForm.follow_up.map(section => (
                            <div key={section.section} className="form-section">
                                <h3>{section.section.replace(/_/g, ' ')}</h3>
                                {section.questions.map(q => (
                                    <div key={q} className="input-group">
                                        <label>{q}</label>
                                        <input
                                            type="text"
                                            value={responses[q] || ''}
                                            onChange={(e) => handleResponseChange(q, e.target.value)}
                                        />
                                    </div>
                                ))}
                            </div>
                        ))}
                        <button className="submit-button" onClick={handleFinalSubmit}>
                            Submit All Responses
                        </button>
                    </div>
                )}

                 {step === 'submitted' && (
                    <p className="final-message">This session has ended.</p>
                )}
            </div>
        </div>
    );
};

export default ChatComponent;