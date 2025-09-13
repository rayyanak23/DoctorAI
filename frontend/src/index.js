// src/index.js

import React from 'react';
import ReactDOM from 'react-dom/client';
import './ChatComponent.css';
import ChatComponent from './ChatComponent';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ChatComponent />
  </React.StrictMode>
);