import React, { useState } from 'react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';

const events = [
  { id: 1, title: 'Grand Concert Tour 2024', date: 'Dec 14', city: 'Madison, WI', price: '$45', description: 'Experience the ultimate concert experience with world-class performers!' },
  { id: 2, title: 'Comedy Night Live', date: 'Dec 17', city: 'Green Bay, WI', price: '$25', description: 'Laugh the night away with top comedians performing live!' },
  { id: 3, title: 'Winter Sports Tournament', date: 'Dec 19', city: 'Milwaukee, WI', price: '$35', description: 'Watch the most exciting winter sports competition!' }
];

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [message, setMessage] = useState('');

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
        setShowLogin(false);
        setMessage('✅ Login successful!');
        setTimeout(() => setMessage(''), 3000);
      } else {
        setMessage('❌ Login failed: ' + (data.message || 'Invalid credentials'));
      }
    } catch (error) {
      setMessage('❌ Error: ' + error.message);
    }
  };

  const handleRegister = async () => {
    if (!firstName || !lastName || !email || !password) {
      setMessage('❌ All fields required!');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          passwordConfirm: password,
          firstName,
          lastName
        })
      });
      const data = await response.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
        setShowRegister(false);
        setMessage('✅ Registration successful!');
        setTimeout(() => setMessage(''), 3000);
      } else {
        setMessage('❌ Registration failed: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      setMessage('❌ Error: ' + error.message);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setLoggedIn(false);
    setEmail('');
    setPassword('');
    setFirstName('');
    setLastName('');
    setMessage('✅ Logged out!');
    setTimeout(() => setMessage(''), 3000);
  };

  // EVENT DETAIL PAGE
  if (selectedEvent) {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
          <button onClick={() => setSelectedEvent(null)} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            ← Back to Events
          </button>
          {loggedIn && (
            <button onClick={handleLogout} style={{ padding: '8px 16px', cursor: 'pointer', marginLeft: 'auto' }}>
              Logout
            </button>
          )}
        </nav>

        <div style={{ maxWidth: '600px', margin: '0 auto', border: '1px solid #ddd', padding: '30px', borderRadius: '8px' }}>
          <h1>{selectedEvent.title}</h1>
          <p style={{ fontSize: '18px', color: '#666' }}>{selectedEvent.description}</p>

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
            <p><strong>📅 Date:</strong> {selectedEvent.date}</p>
            <p><strong>📍 Location:</strong> {selectedEvent.city}</p>
            <p><strong>💰 Price:</strong> {selectedEvent.price}</p>
          </div>

          {loggedIn ? (
            <button style={{
              marginTop: '30px',
              padding: '15px 30px',
              fontSize: '16px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              width: '100%'
            }}>
              🛒 Buy Ticket
            </button>
          ) : (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#fff3cd', borderRadius: '8px' }}>
              <p>👤 Please login to buy tickets</p>
              <button onClick={() => setSelectedEvent(null)} style={{ padding: '10px 20px', cursor: 'pointer' }}>
                Go Back & Login
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // HOME PAGE
  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
        {loggedIn ? (
          <button onClick={handleLogout} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Logout
          </button>
        ) : (
          <>
            <button onClick={() => { setShowLogin(!showLogin); setShowRegister(false); }} style={{ padding: '8px 16px', cursor: 'pointer' }}>
              {showLogin ? 'Close' : 'Login'}
            </button>
            <button onClick={() => { setShowRegister(!showRegister); setShowLogin(false); }} style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#4CAF50', color: 'white' }}>
              {showRegister ? 'Close' : 'Sign Up'}
            </button>
          </>
        )}
      </nav>

      {message && (
        <div style={{ padding: '10px', marginBottom: '20px', backgroundColor: '#f0f0f0', borderRadius: '4px', fontSize: '14px' }}>
          {message}
        </div>
      )}

      {showLogin && (
        <div style={{ border: '1px solid #ccc', padding: '20px', maxWidth: '300px', marginBottom: '20px', borderRadius: '8px' }}>
          <h3>Login</h3>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <button onClick={handleLogin} style={{ padding: '8px 16px', cursor: 'pointer', width: '100%' }}>
            Login
          </button>
        </div>
      )}

      {showRegister && (
        <div style={{ border: '1px solid #4CAF50', padding: '20px', maxWidth: '300px', marginBottom: '20px', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <h3>Create Account</h3>
          <input
            type="text"
            placeholder="First Name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="text"
            placeholder="Last Name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <button onClick={handleRegister} style={{ padding: '8px 16px', cursor: 'pointer', width: '100%', backgroundColor: '#4CAF50', color: 'white' }}>
            Sign Up
          </button>
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <h2>Status: {loggedIn ? '✅ Logged In' : '❌ Not Logged In'}</h2>

        <h3>Featured Events</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
          {events.map((event) => (
            <div key={event.id} style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '8px' }}>
              <h4>{event.title}</h4>
              <p>📅 {event.date}</p>
              <p>📍 {event.city}</p>
              <p>💰 {event.price}</p>
              <button
                onClick={() => setSelectedEvent(event)}
                style={{ padding: '8px 16px', cursor: 'pointer', width: '100%' }}>
                View Event
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
